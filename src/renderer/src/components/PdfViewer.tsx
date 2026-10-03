import { useCallback, useEffect, useRef, useState } from 'react'
import { getDocument } from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { keepRange, parsePageInput, shouldRelease } from '../lib/pdf-pages'
import { flashRectsForRange, type PdfTextItemLike } from '../lib/pdf-flash'
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
/** 高亮框显示时长（用户裁定：显示一秒后自动消失，不影响阅览）——给一点余量便于看清 */
const FLASH_MS = 1600

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
  /**
   * 定位到的页码（Phase 9 / S4）：由**生成期锚点 × 页表**算出，不做任何文字检索，
   * 因此扫描件（没有文字层）同样能定位到页。值变化时滚到该页。
   */
  targetPage?: number | null
  /**
   * 高亮框（2026-10-03 用户裁定新增）：页内字符区间 → 几条高亮横带，**显示约 1 秒后自动消失**。
   * 区间来自生成期锚点（`source-locate.flashRangeFor`），因此一定包含目标；没有文字层时自然画不出来。
   */
  flash?: { page: number; start: number; end: number; nonce: number } | null
}

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
export default function PdfViewer({ url, targetPage, flash }: PdfViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('')
  const [renderingPages, setRenderingPages] = useState(0)

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

  /** 释放一页占用的资源（取消任务 + pdf.js 页缓存 + 移除 canvas），占位块保留（高度不变，滚动不跳） */
  const releasePage = useCallback((pageNumber: number) => {
    const task = tasksRef.current.get(pageNumber)
    if (task) {
      task.cancel()
      tasksRef.current.delete(pageNumber)
    }
    inFlightRef.current.delete(pageNumber)
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
  }, [doc])

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
   * 定位到页（Phase 9 / S4）：页码是**生成期算好的**（卡片 → 块号 → 页码），
   * 这里只负责滚过去——不取文字、不搜索、不画高亮，因此扫描件一样能定位，也不会"跳错页"。
   * 页码越界（页表与当前文件不一致）时夹取到合法范围，而不是滚到空白处。
   */
  useEffect(() => {
    if (!doc || targetPage == null) return
    const page = Math.min(doc.numPages, Math.max(1, targetPage))
    jumpToPage(page)
    requestPage(page)
  }, [doc, targetPage, jumpToPage, requestPage])

  /**
   * 高亮框（2026-10-03 用户裁定新增）：范围来自生成期锚点（页内字符区间），
   * 这里取该页的文字项做**几何换算**（`lib/pdf-flash.ts`）→ 几条高亮横带，**1.6 秒后自动移除**。
   *
   * 为什么要画：S4 之后只跳页、页面上没有任何指示，"第 216 页"里找一句话并不好找；
   * 高亮不必精确到句（可以覆盖好几行），但**一定包含目标**——因为区间就是锚点那一块（再用证据引文收窄）。
   * 画不出来（扫描件没有文字层 / 文字项对不上）时静默放弃：只跳页，不假装高亮。
   */
  const flashSeqRef = useRef(0)
  /** 只在"打开序号"变化时重跑（否则父组件每次重渲染都会重放动画、并留下旧图层） */
  const flashRef = useRef(flash)
  flashRef.current = flash
  useEffect(() => {
    const d = doc
    const flush = flashRef.current
    if (!d || !flush) return
    const page = Math.min(d.numPages, Math.max(1, flush.page))
    const el = pageElsRef.current[page - 1]
    if (!el) return
    const seq = ++flashSeqRef.current
    let layer: HTMLDivElement | null = null
    let timer: number | null = null
    const removeLayer = (): void => {
      if (layer && layer.parentElement) layer.parentElement.removeChild(layer)
      layer = null
    }
    void (async () => {
      try {
        const pageProxy = await d.getPage(page)
        const viewport = pageProxy.getViewport({ scale: RENDER_SCALE })
        const content = await pageProxy.getTextContent()
        if (seq !== flashSeqRef.current) return
        const rects = flashRectsForRange(viewport, content.items as PdfTextItemLike[], flush.start, flush.end)
        if (rects.length === 0) return
        // 同一页上的旧图层先清掉（重复打开/重渲染都不能累积）
        el.querySelectorAll('.pdf-viewer__flash-layer').forEach((n) => n.remove())
        const box = document.createElement('div')
        box.className = 'pdf-viewer__flash-layer'
        for (const r of rects) {
          const band = document.createElement('div')
          band.className = 'pdf-viewer__flash'
          band.style.left = r.left + '%'
          band.style.top = r.top + '%'
          band.style.width = r.width + '%'
          band.style.height = r.height + '%'
          if (r.angle) band.style.transform = 'rotate(' + r.angle + 'rad)'
          box.appendChild(band)
        }
        el.appendChild(box)
        layer = box
        timer = window.setTimeout(removeLayer, FLASH_MS)
      } catch {
        // 取文字失败（扫描件/坏页）→ 不画高亮，页面照常显示
      }
    })()
    return () => {
      if (timer != null) window.clearTimeout(timer)
      // 卸载/重跑时也要把图层带走，否则会一层层堆在页面上
      removeLayer()
    }
  }, [doc, flash?.nonce])

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
