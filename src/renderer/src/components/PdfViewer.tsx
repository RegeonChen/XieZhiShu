import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getDocument } from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { findNeedle, normalizeWithMap, toOriginalRange } from '../lib/locate'
import { hitRectsForPage, type PdfHitRect, type PdfHitSpan, type PdfTextItemLike } from '../lib/pdf-hit'
import { keepRange, parsePageInput, shouldRelease } from '../lib/pdf-pages'
// 在主线程加载 worker 模块：其末尾会执行 globalThis.pdfjsWorker = { WorkerMessageHandler }。
// pdf.js 检测到该全局对象后，使用 LoopbackPort 在主线程运行 worker —— 无需真实 Worker 构造，
// 也无需动态 import，dev(http) 与生产(file://) 环境下均稳定。
import 'pdfjs-dist/build/pdf.worker.min.mjs'

// 渲染像素密度：canvas 以 2x 渲染，通过 CSS 撑满页容器，实时随面板缩放
const RENDER_SCALE = 2

// 缩放范围：1 = 适应容器宽度；可放大/缩小查看
const ZOOM_MIN = 0.25
const ZOOM_MAX = 4
const ZOOM_STEP = 0.8

/** 视口外各保留这么多页的已渲染画布；滚得更远就释放（PDF 虚拟化的核心参数） */
const KEEP_PAGES = 2
/** 预渲染提前量：视口上下各 600px 内的页提前渲染，滚动时不出现空白 */
const PRELOAD_MARGIN = '600px 0px'
/** 同时渲染的页数上限（主线程 LoopbackPort 模式下，避免一口气排队几百页把界面堵住） */
const MAX_CONCURRENT_RENDERS = 2

// pdf.js cMaps 基址（中文/CID 字体 PDF 需要 cMapUrl+cMapPacked 才能正确渲染/显示文字）
let pdfCmapsUrlPromise: Promise<string> | null = null
function getPdfCmapsUrl(): Promise<string> {
  if (!pdfCmapsUrlPromise) {
    pdfCmapsUrlPromise = window.api
      .getPdfCmapsUrl()
      .then((res) => (res.ok && res.data ? res.data.url : ''))
      .catch(() => '')
  }
  return pdfCmapsUrlPromise
}

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
}

interface PdfViewerProps {
  url: string
  /** 定位锚（已归一化的候选检索词，Phase 8 / S3）：在 PDF 文字里查找并滚到命中页、高亮该句 */
  locateNeedles?: string[]
  /** 把定位进展回报给外层查看器（由它显示在定位条上） */
  onLocate?: (state: PdfLocateState) => void
}

/** PDF 文内定位的进展（S3） */
export interface PdfLocateState {
  status: 'idle' | 'searching' | 'found' | 'not-found' | 'no-text'
  /** 命中的页码（1 起） */
  page?: number
  /** 已扫描页数 / 总页数（用于"正在定位…已扫描 N/M 页"） */
  scanned?: number
  total?: number
}

/** 一页的文字块（pdf.js TextContent 里我们用到的那部分） */
type PageTextItems = PdfTextItemLike[]

/** 命中矩形（以页面的百分比表示 → 不依赖任何像素缩放，窗口/分栏尺寸变化都不用重算） */
type PdfHitRects = PdfHitRect[]

/**
 * PDF 查看器（Phase 8 / S2 起改为**虚拟化渲染**）。
 *
 * 为什么改：原实现把**每一页**都渲染成 canvas 并全部留在 DOM 里——年鉴这类几百页的文件
 * 会"越看越慢、内存持续增长"，打开时还要一次性渲染完全部页才算完（用户实测反馈"打开和渲染极慢"）。
 * 现在的做法：
 *   - 先为每页放一个**占位块**（按 A4 比例预留高度，滚动条长度立即正确，不跳）；
 *   - 只渲染"进入视口 ±600px"的页，且**同时最多渲染 2 页**；
 *   - 滚出视口超过 `KEEP_PAGES` 页的已渲染页 → 取消渲染任务、`page.cleanup()` 释放、移除 canvas（占位块保留高度）；
 *   - 工具栏给「页码跳转 / 上一页 / 下一页」，便于在几百页里直接到位（也是后续"定位到页"的落点）。
 *
 * 说明：pdf.js 仍以**主线程 LoopbackPort** 运行 worker（本项目在 dev/http 与生产 file:// 下都验证过的方式，
 * 见下方 import 注释）；切到真实 Worker 会改变构建与协议行为，留待单独评估。
 */
export default function PdfViewer({ url, locateNeedles, onLocate }: PdfViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('')
  const [renderingPages, setRenderingPages] = useState(0)
  /** 命中位置（等到命中页真正渲染出来时才算得出矩形） */
  const pdfHitRef = useRef<{ page: number; spans: PdfHitSpan[] } | null>(null)
  /** 文字块缓存：搜索时已经取过，算矩形时不必重新解析 */
  const textContentRef = useRef<Map<number, PageTextItems>>(new Map())
  const needlesKey = useMemo(() => (locateNeedles ?? []).join('\u0000'), [locateNeedles])

  /** 每页占位块（长度 = 页数；doc 变化时重建） */
  const pageElsRef = useRef<(HTMLDivElement | null)[]>([])
  /** 已渲染完成的页号（1 起） */
  const renderedRef = useRef<Set<number>>(new Set())
  /** 正在渲染/排队中的页号 */
  const inFlightRef = useRef<Set<number>>(new Set())
  /** 每页的渲染任务（用于滚出视口时取消） */
  const tasksRef = useRef<Map<number, RenderTask>>(new Map())
  /** 渲染队列与并发控制 */
  const queueRef = useRef<number[]>([])
  const runningRef = useRef(0)
  const generationRef = useRef(0)

  // 加载文档（Phase 8 / S2：disableAutoFetch —— 大文件不预先整包下载，
  // 配合文件服务的 HTTP Range 按需分段取；pdf.js 仍会自动按需继续拉后续分段）
  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setNumPages(0)
    setError(null)
    setCurrentPage(1)
    setPageInput('')

    ;(async () => {
      try {
        const cMapUrl = await getPdfCmapsUrl()
        if (cancelled) return
        // `disableAutoFetch`：大文件不预先整包下载，配合文件服务的 HTTP Range 按需分段取
        const opts = cMapUrl
          ? { url, cMapUrl, cMapPacked: true, disableAutoFetch: true }
          : { url, disableAutoFetch: true }
        const loadingTask = getDocument(opts)
        loadingTaskRef.current = loadingTask
        const d = await loadingTask.promise
        if (cancelled) return
        setDoc(d)
        setNumPages(d.numPages)
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      cancelled = true
      loadingTaskRef.current?.destroy().catch(() => {})
      loadingTaskRef.current = null
    }
  }, [url])

  /** 取某页的文字块（命中页已搜过 → 直接命中缓存；否则现取一次并缓存） */
  const getPageTextItems = useCallback(
    async (pageNumber: number): Promise<PageTextItems> => {
      const cached = textContentRef.current.get(pageNumber)
      if (cached) return cached
      const d = doc
      if (!d) return []
      try {
        const page = await d.getPage(pageNumber)
        const tc = (await page.getTextContent()) as { items: PageTextItems }
        textContentRef.current.set(pageNumber, tc.items)
        return tc.items
      } catch {
        return []
      }
    },
    [doc]
  )

  /**
   * 把命中矩形画到该页上（Phase 8 / S3）。
   * 用真实 DOM 元素而不是状态驱动：页面元素本身是命令式创建的，且元素能被 `scrollIntoView`
   * 直接滚到视野中间（比手工算滚动位置更准）。
   */
  const paintHitRects = useCallback((pageNumber: number, rects: PdfHitRect[]) => {
    containerRef.current?.querySelectorAll('.pdf-viewer__pdf-layer').forEach((n) => n.remove())
    const el = pageElsRef.current[pageNumber - 1]
    if (!el || rects.length === 0) return
    const layer = document.createElement('div')
    layer.className = 'pdf-viewer__pdf-layer'
    for (const r of rects) {
      const span = document.createElement('span')
      span.className = 'pdf-viewer__pdf-hit'
      span.style.left = `${r.left}%`
      span.style.top = `${r.top}%`
      span.style.width = `${r.width}%`
      span.style.height = `${r.height}%`
      if (r.angle) span.style.transform = `rotate(${r.angle}rad)`
      layer.appendChild(span)
    }
    el.appendChild(layer)
    ;(layer.firstElementChild as HTMLElement | null)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  /** 清掉某一页上的命中层（该页被释放/重渲染时调用，避免高亮浮在占位块上） */
  const clearHitLayer = useCallback((pageNumber: number) => {
    const el = pageElsRef.current[pageNumber - 1]
    el?.querySelectorAll('.pdf-viewer__pdf-layer').forEach((n) => n.remove())
  }, [])

  /** 释放一页占用的资源（取消任务 + pdf.js 页缓存 + 移除 canvas），占位块保留（高度不变，滚动不跳） */
  const releasePage = useCallback((pageNumber: number) => {
    const task = tasksRef.current.get(pageNumber)
    if (task) {
      task.cancel()
      tasksRef.current.delete(pageNumber)
    }
    inFlightRef.current.delete(pageNumber)
    clearHitLayer(pageNumber)
    const el = pageElsRef.current[pageNumber - 1]
    if (el) {
      const canvas = el.querySelector('canvas')
      if (canvas) canvas.remove()
      el.classList.remove('is-rendered')
      const note = el.querySelector<HTMLElement>('.pdf-viewer__page-note')
      if (note) note.textContent = `第 ${pageNumber} 页`
    }
    if (renderedRef.current.delete(pageNumber)) {
      void doc?.getPage(pageNumber).then((p) => p.cleanup()).catch(() => {})
    }
  }, [doc, clearHitLayer])

  /** 渲染一页（加入队列；真实渲染在 pumpQueue 中按并发上限执行） */
  const requestPage = useCallback((pageNumber: number) => {
    if (renderedRef.current.has(pageNumber) || inFlightRef.current.has(pageNumber)) return
    if (!doc || pageNumber < 1 || pageNumber > doc.numPages) return
    inFlightRef.current.add(pageNumber)
    queueRef.current.push(pageNumber)
    // 队列由 pumpQueue 消费（定义在下面，用 ref 转一层避免闭包顺序问题）
    pumpRef.current?.()
  }, [doc])

  /** 消费渲染队列（最多 MAX_CONCURRENT_RENDERS 页并行） */
  const pumpRef = useRef<(() => void) | null>(null)
  pumpRef.current = () => {
    const d = doc
    const container = containerRef.current
    if (!d || !container) return
    while (runningRef.current < MAX_CONCURRENT_RENDERS && queueRef.current.length > 0) {
      const pageNumber = queueRef.current.shift() as number
      const el = pageElsRef.current[pageNumber - 1]
      if (!el) {
        inFlightRef.current.delete(pageNumber)
        continue
      }
      runningRef.current += 1
      setRenderingPages((n) => n + 1)
      const gen = generationRef.current
      ;(async () => {
        try {
          const page = await d.getPage(pageNumber)
          if (gen !== generationRef.current) return
          const viewport = page.getViewport({ scale: RENDER_SCALE })
          // 用真实页面比例覆盖占位块的估计比例（A4 估计 → 实际），避免渲染后高度跳动
          el.style.aspectRatio = `${viewport.width} / ${viewport.height}`
          const canvas = document.createElement('canvas')
          canvas.className = 'pdf-viewer__canvas'
          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)
          el.appendChild(canvas)
          const task = page.render({ canvas, viewport })
          tasksRef.current.set(pageNumber, task)
          await task.promise
          tasksRef.current.delete(pageNumber)
          if (gen !== generationRef.current) return
          renderedRef.current.add(pageNumber)
          el.classList.add('is-rendered')
          // Phase 8 / S3：命中页渲染出来后，取该页文字块算高亮矩形并画上去
          const hit = pdfHitRef.current
          if (hit && hit.page === pageNumber) {
            const items = await getPageTextItems(pageNumber)
            const rects: PdfHitRects = hitRectsForPage(viewport, items, hit.spans)
            if (gen === generationRef.current && rects.length > 0) paintHitRects(pageNumber, rects)
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          // 单页渲染失败（含取消，`RenderingCancelledException`）不应毁掉整个查看器
          if (!/cancel/i.test(msg)) {
            const note = el.querySelector<HTMLElement>('.pdf-viewer__page-note')
            if (note) note.textContent = `第 ${pageNumber} 页渲染失败`
          }
        } finally {
          inFlightRef.current.delete(pageNumber)
          runningRef.current -= 1
          setRenderingPages((n) => Math.max(0, n - 1))
          pumpRef.current?.()
        }
      })()
    }
  }

  // 为每页建占位块（不解析 PDF，只按 A4 比例预留高度）——几百页也能瞬间建好
  useEffect(() => {
    const container = containerRef.current
    if (!doc || !container) return
    generationRef.current += 1
    renderedRef.current = new Set()
    inFlightRef.current = new Set()
    tasksRef.current = new Map()
    queueRef.current = []
    runningRef.current = 0
    container.innerHTML = ''
    pageElsRef.current = []
    for (let i = 1; i <= doc.numPages; i++) {
      const el = document.createElement('div')
      el.className = 'pdf-viewer__page'
      el.dataset.page = String(i)
      const note = document.createElement('div')
      note.className = 'pdf-viewer__page-note'
      note.textContent = `第 ${i} 页`
      el.appendChild(note)
      container.appendChild(el)
      pageElsRef.current.push(el)
    }
    return () => {
      generationRef.current += 1
      tasksRef.current.forEach((t) => t.cancel())
      tasksRef.current.clear()
      inFlightRef.current.clear()
      queueRef.current = []
      runningRef.current = 0
      container.innerHTML = ''
      pageElsRef.current = []
    }
  }, [doc])

  // 可见性驱动：渲染进入视口的页、释放滚远的页、跟踪"当前页"
  useEffect(() => {
    const container = containerRef.current
    if (!doc || !container) return
    const els = pageElsRef.current.filter((e): e is HTMLDivElement => !!e)
    if (els.length === 0) return

    const visible = new Set<number>()
    /** 决定保留区间：视口内页号 ± KEEP_PAGES */
    const rebalance = (): void => {
      const range = keepRange([...visible], KEEP_PAGES)
      for (const rendered of [...renderedRef.current]) {
        if (shouldRelease(rendered, range)) releasePage(rendered)
      }
    }

    const renderObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.page ?? 0)
          if (n <= 0) continue
          if (entry.isIntersecting) {
            visible.add(n)
            requestPage(n)
          } else {
            visible.delete(n)
          }
        }
        rebalance()
      },
      { root: null, rootMargin: PRELOAD_MARGIN, threshold: 0 }
    )
    els.forEach((el) => renderObserver.observe(el))

    // 当前页：只观察"视口中带"（上下各留 45% 空白），落在带内的那页就是当前页
    const currentObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const n = Number((entry.target as HTMLElement).dataset.page ?? 0)
          if (n > 0) setCurrentPage(n)
        }
      },
      { root: null, rootMargin: '-45% 0px -45% 0px', threshold: 0 }
    )
    els.forEach((el) => currentObserver.observe(el))

    return () => {
      renderObserver.disconnect()
      currentObserver.disconnect()
    }
  }, [doc, releasePage, requestPage, numPages])

  /** 跳到指定页（后续"定位到页"直接复用这个动作） */
  const jumpToPage = useCallback((pageNumber: number) => {
    const el = pageElsRef.current[pageNumber - 1]
    if (!el) return
    el.scrollIntoView({ block: 'start' })
    setCurrentPage(pageNumber)
  }, [])

  const submitJump = useCallback(() => {
    const n = parsePageInput(pageInput, numPages)
    if (n != null) jumpToPage(n)
    setPageInput('')
  }, [jumpToPage, numPages, pageInput])

  /**
   * 文内定位（Phase 8 / S3）：把定位锚（引文）在 PDF 文字里查一遍。
   *
   * 逐页 `getTextContent()` 顺序扫描、**命中即停**（年鉴几百页时通常前几页就命中，
   * 不必扫全文）；每页把文本块拼成字符串并用与查看器同一套「去空白归一化 + 最长前缀退让」
   * 口径匹配，命中后把字符区间落到具体文本块上，供几何高亮使用。
   *
   * 全程如实回报进展：正在定位（已扫描 N/M 页）/ 已定位到第 P 页 / 未找到 /
   * **该 PDF 没有文字层（扫描件）**——最后一种按用户裁定只提示，不假装能定位。
   */
  useEffect(() => {
    if (!doc) return
    if (!needlesKey) {
      pdfHitRef.current = null
      containerRef.current?.querySelectorAll('.pdf-viewer__pdf-layer').forEach((n) => n.remove())
      onLocate?.({ status: 'idle' })
      return
    }
    const needles = needlesKey.split('\u0000')
    let cancelled = false
    const gen = generationRef.current
    ;(async () => {
      onLocate?.({ status: 'searching', scanned: 0, total: doc.numPages })
      let textBlocks = 0
      try {
        for (let p = 1; p <= doc.numPages; p++) {
          if (cancelled || gen !== generationRef.current) return
          const page = await doc.getPage(p)
          const tc = (await page.getTextContent()) as { items: PageTextItems }
          textContentRef.current.set(p, tc.items)
          // 逐块拼接，并记录每块在拼接串里的起始位置
          let hay = ''
          const blocks: { itemIndex: number; start: number; length: number }[] = []
          for (let i = 0; i < tc.items.length; i++) {
            const s = tc.items[i]?.str ?? ''
            if (!s) continue
            blocks.push({ itemIndex: i, start: hay.length, length: s.length })
            hay += s
          }
          textBlocks += blocks.length
          if (blocks.length === 0) continue
          const { normalized, map } = normalizeWithMap(hay)
          const found = findNeedle(normalized, needles)
          if (!found) {
            if (p % 20 === 0) onLocate?.({ status: 'searching', scanned: p, total: doc.numPages })
            continue
          }
          const range = toOriginalRange(map, found.start, found.end)
          if (!range) continue
          const spans = blocks
            .filter((b) => range.start < b.start + b.length && range.end > b.start)
            .map((b) => ({
              itemIndex: b.itemIndex,
              from: Math.max(0, range.start - b.start),
              to: Math.min(b.length, range.end - b.start)
            }))
          if (spans.length === 0) continue
          pdfHitRef.current = { page: p, spans }
          onLocate?.({ status: 'found', page: p, scanned: p, total: doc.numPages })
          // 命中页可能已渲染过（高亮会缺失）→ 释放后重新渲染，渲染完成时按最新的命中信息画高亮
          releasePage(p)
          requestPage(p)
          jumpToPage(p)
          return
        }
      } catch {
        // 单页文字提取失败不应中断：继续扫后面的页
      }
      if (cancelled || gen !== generationRef.current) return
      pdfHitRef.current = null
      onLocate?.(
        textBlocks === 0
          ? { status: 'no-text', total: doc.numPages }
          : { status: 'not-found', scanned: doc.numPages, total: doc.numPages }
      )
    })()
    return () => {
      cancelled = true
    }
    // releasePage / requestPage / jumpToPage 都是稳定引用（依赖只在 doc 变化时重建）
  }, [doc, needlesKey, onLocate, releasePage, requestPage, jumpToPage])

  return (
    <div className="pdf-viewer">
      <div className="pdf-viewer__toolbar">
        {numPages > 0 && (
          <span className="pdf-viewer__info">
            第 {currentPage} / {numPages} 页
            {renderingPages > 0 ? '（渲染中…）' : ''}
          </span>
        )}
        <span className="pdf-viewer__jump">
          <input
            className="pdf-viewer__jump-input"
            value={pageInput}
            placeholder="页码"
            inputMode="numeric"
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitJump()
            }}
          />
          <button type="button" className="pdf-viewer__btn" onClick={submitJump} title="跳到指定页">
            跳转
          </button>
        </span>
        <button
          type="button"
          className="pdf-viewer__btn"
          onClick={() => jumpToPage(Math.max(1, currentPage - 1))}
          title="上一页"
        >
          上一页
        </button>
        <button
          type="button"
          className="pdf-viewer__btn"
          onClick={() => jumpToPage(Math.min(numPages, currentPage + 1))}
          title="下一页"
        >
          下一页
        </button>
        <button type="button" className="pdf-viewer__btn" onClick={() => setZoom((z) => clampZoom(z * ZOOM_STEP))} title="缩小">缩小</button>
        <span className="pdf-viewer__zoom-label">{Math.round(zoom * 100)}%</span>
        <button type="button" className="pdf-viewer__btn" onClick={() => setZoom((z) => clampZoom(z / ZOOM_STEP))} title="放大">放大</button>
        <button type="button" className="pdf-viewer__btn" onClick={() => setZoom(1)} title="适应窗口宽度">适应宽度</button>
      </div>
      {error ? (
        <div className="source-viewer__status" style={{ color: '#dc2626' }}>PDF 加载失败：{error}</div>
      ) : (
        <div className="pdf-viewer__pages" ref={containerRef} style={{ zoom }} />
      )}
    </div>
  )
}
