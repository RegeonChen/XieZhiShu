import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import PdfViewer, { type PdfLocateState } from './PdfViewer'
import WebBrowserPane from './WebBrowserPane'
import { IncrementalHtml, IncrementalText } from './IncrementalContent'
import { buildNeedles, findNeedle, normalizeWithMap, toOriginalRange } from '../lib/locate'
import { zhCN } from '../i18n/zh-CN'

interface SourceDetail {
  source: {
    id: string
    title: string
    kind: 'file' | 'url'
    status: string
    cleanedText: string
    url?: string
    filePath?: string
    createdAt: string
  }
  tags: { id: string; name: string }[]
}

interface SummaryShape {
  summary: string
  keywords: string[]
  entities: string[]
}

/** 一次命中在页面上的矩形（相对查看器内容坐标系）；一处命中可能跨多行 → 多个矩形 */
interface LocateRect {
  hitIndex: number
  top: number
  left: number
  width: number
  height: number
}

/** 最多标记多少处命中（防止短引文在长文里命中成百上千处，把界面拖慢） */
const MAX_LOCATE_HITS = 30

/** 定位锚：把某段引文在来源正文里找到并高亮（Phase 8 / S1） */
export interface SourceLocateAnchor {
  snippet?: string
  /** 界面提示用的来源说明（如「第 3 段」），可空 */
  label?: string
}

interface SourceViewerProps {
  sourceId: string
  /** 资料库模式：返回按钮 */
  onBack?: () => void
  /** 定位锚（生成汇编 / 矛盾弹窗里点击来源时传入） */
  locate?: SourceLocateAnchor | null
  /** 分栏模式：更紧凑的表头 + 关闭按钮（生成汇编右栏用） */
  dense?: boolean
  onClose?: () => void
}

/** 收集容器内所有文本节点及其在"全文"中的起始偏移 */
function collectTextNodes(root: HTMLElement): { node: Text; start: number; length: number }[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const out: { node: Text; start: number; length: number }[] = []
  let pos = 0
  let n = walker.nextNode()
  while (n) {
    const t = n as Text
    out.push({ node: t, start: pos, length: t.data.length })
    pos += t.data.length
    n = walker.nextNode()
  }
  return out
}

function SourceViewer({
  sourceId,
  onBack,
  locate,
  dense = false,
  onClose
}: SourceViewerProps): React.JSX.Element {
  const [data, setData] = useState<SourceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [htmlContent, setHtmlContent] = useState<string | null>(null)
  const [htmlLoading, setHtmlLoading] = useState(false)
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [summary, setSummary] = useState<SummaryShape | null>(null)
  const [locateRects, setLocateRects] = useState<LocateRect[]>([])
  const [activeHit, setActiveHit] = useState(0)
  /** 定位结果：idle=没有锚；found=命中；not-found=搜遍正文也没找到；unsupported=格式不支持文内定位 */
  const [locateState, setLocateState] = useState<'idle' | 'found' | 'not-found' | 'unsupported'>('idle')
  /** PDF 的定位进展由 PdfViewer 回报（文字在 PDF 内部，不在 DOM 里，须由它自己搜） */
  const [pdfLocate, setPdfLocate] = useState<PdfLocateState | null>(null)
  const [revealTick, setRevealTick] = useState(0)
  /** 外部打开失败的就地提示（不静默失败） */
  const [externalError, setExternalError] = useState<string | null>(null)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const headerRef = useRef<HTMLDivElement | null>(null)
  /** 表头（操作行 + 定位行）吸顶后的实际高度：PDF 工具栏要挂在它下面，否则两者会在 top:0 重叠 */
  const [stickyTop, setStickyTop] = useState(0)
  /** 上一次算出的命中矩形（等值短路：避免 ResizeObserver 与重渲染互相触发） */
  const locateRectsRef = useRef<LocateRect[]>([])
  const needles = useMemo(() => (locate?.snippet ? buildNeedles(locate.snippet) : []), [locate?.snippet])

  /**
   * 用系统默认程序打开（用户裁定 Q2：**所有格式**都要同时具备"内部分栏查看"与"外部打开"）。
   * 放在查看器内部实现：资料库与生成汇编两处都自动具备，失败时就地提示而不是静默。
   */
  const handleOpenExternal = useCallback(async () => {
    setExternalError(null)
    const res = await window.api.openSourcePath(sourceId)
    if (!res.ok) setExternalError(res.error?.message ?? '打开失败')
  }, [sourceId])

  const load = useCallback(async () => {    setLoading(true)
    setError(null)
    try {
      const res = await window.api.getSource(sourceId)
      if (res.ok && res.data) {
        setData(res.data as SourceDetail)
      } else {
        setError(res.error?.message ?? '加载失败')
      }
    } catch {
      setError('加载资料时发生错误')
    } finally {
      setLoading(false)
    }
  }, [sourceId])

  useEffect(() => { load() }, [load])

  // 加载 LLM 摘要（整理资料库后生成）
  useEffect(() => {
    let cancelled = false
    window.api.getSourceSummary(sourceId).then((res) => {
      if (cancelled) return
      if (res.ok && res.data && res.data.summary) {
        const s = res.data.summary as SummaryShape
        if (s.summary) setSummary(s)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [sourceId])

  // 根据文件类型加载对应渲染内容
  useEffect(() => {
    if (!data) return
    const { source } = data
    if (source.kind !== 'file' || !source.filePath) {
      setHtmlContent(null)
      setFileUrl(null)
      return
    }

    const ext = source.filePath.toLowerCase()
    let cancelled = false

    if (ext.endsWith('.docx')) {
      // DOCX: mammoth 转 HTML
      setFileUrl(null)
      setHtmlLoading(true)
      window.api.renderSourceHtml(sourceId).then((res) => {
        if (cancelled) return
        if (res.ok && res.data) setHtmlContent(res.data.html)
        setHtmlLoading(false)
      }).catch(() => {
        if (!cancelled) setHtmlLoading(false)
      })
    } else if (ext.endsWith('.pdf') || ext.endsWith('.png') || ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.bmp')) {
      // PDF / 图片: 通过本地文件服务原生渲染
      setHtmlContent(null)
      window.api.getSourceFileUrl(sourceId).then((res) => {
        if (cancelled) return
        if (res.ok && res.data) setFileUrl(res.data.url)
      }).catch(() => {})
    } else {
      // TXT / MD: 纯文本
      setHtmlContent(null)
      setFileUrl(null)
    }

    return () => { cancelled = true }
  }, [data, sourceId])

  /** 在已渲染的正文里重新计算命中矩形（覆盖层方案：不改动正文 DOM） */
  const refreshLocate = useCallback(() => {
    const host = hostRef.current
    if (!host || needles.length === 0) {
      setLocateRects([])
      setLocateState('idle')
      return
    }
    // 图片没有文字层（如实提示）；PDF 的文字在 PDF 内部，交给 PdfViewer 自己搜（见其 onLocate 回报）；
    // 网页来源由内嵌浏览器渲染（S4），页面内容在独立的 WebContentsView 里，不在本 DOM 中，故不在此定位
    const path = (data?.source.filePath ?? '').toLowerCase()
    if (data?.source.kind === 'url') {
      setLocateRects([])
      setLocateState('unsupported')
      return
    }
    if (/\.(png|jpe?g|bmp)$/.test(path)) {
      setLocateRects([])
      setLocateState('unsupported')
      return
    }
    if (/\.pdf$/.test(path)) {
      setLocateRects([])
      setLocateState('idle')
      return
    }
    const nodes = collectTextNodes(host)
    if (nodes.length === 0) {
      setLocateRects([])
      // 内容还没渲染出来（如 docx 正在转 HTML）→ 由后续内容变化重试；此时先按"没有文字"处理
      setLocateState('unsupported')
      return
    }
    const full = nodes.map((x) => x.node.data).join('')
    const { normalized, map } = normalizeWithMap(full)
    const hostBox = host.getBoundingClientRect()
    const rects: LocateRect[] = []
    let cursor = 0
    let hitIndex = 0
    while (hitIndex < MAX_LOCATE_HITS) {
      const found = findNeedle(normalized.slice(cursor), needles)
      if (!found) break
      const start = cursor + found.start
      const end = cursor + found.end
      cursor = end
      const range = toOriginalRange(map, start, end)
      if (!range) continue
      // 原文坐标 → 文本节点坐标 → DOM Range → 客户端矩形
      const fromNode = nodes.find((x) => range.start >= x.start && range.start < x.start + x.length)
      const toNode = nodes.find((x) => range.end > x.start && range.end <= x.start + x.length)
      if (!fromNode || !toNode) continue
      const domRange = document.createRange()
      domRange.setStart(fromNode.node, range.start - fromNode.start)
      domRange.setEnd(toNode.node, range.end - toNode.start)
      for (const r of Array.from(domRange.getClientRects())) {
        if (r.width <= 0 || r.height <= 0) continue
        rects.push({
          hitIndex,
          top: r.top - hostBox.top,
          left: r.left - hostBox.left,
          width: r.width,
          height: r.height
        })
      }
      hitIndex += 1
    }
    const prev = locateRectsRef.current
    const same =
      prev.length === rects.length &&
      prev.every((p, i) => p.hitIndex === rects[i].hitIndex && Math.abs(p.top - rects[i].top) < 0.5 && Math.abs(p.left - rects[i].left) < 0.5)
    if (!same) {
      locateRectsRef.current = rects
      setLocateRects(rects)
    }
    setLocateState(rects.length > 0 ? 'found' : 'not-found')
    if (rects.length > 0 && !same) setActiveHit(0)
  }, [needles, data?.source.filePath])

  // 内容变化 / 分批追加完成 / 窗口尺寸变化 → 重算命中位置
  useEffect(() => {
    const id = window.setTimeout(refreshLocate, 0)
    return () => window.clearTimeout(id)
  }, [refreshLocate, data, htmlContent, fileUrl, revealTick])

  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => refreshLocate())
    ro.observe(host)
    return () => ro.disconnect()
  }, [refreshLocate, data, htmlContent, fileUrl])

  /**
   * 量出吸顶表头的高度（标题可能两行、标签/元信息会换行、定位条时有时无），
   * 通过 CSS 变量交给 PDF 工具栏做 `top`，两行才能一上一下叠着吸顶而不是互相盖住。
   */
  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const measure = (): void => setStickyTop(el.offsetHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [data, htmlContent, locate?.snippet, locateState, externalError, dense])

  /** 当前命中的矩形滚动到视野中间：直接让覆盖层自己 scrollIntoView（比手工算滚动位置更准） */
  const focusActiveHit = useCallback(() => {
    const host = hostRef.current
    if (!host) return
    const el = host.querySelector<HTMLElement>('.source-viewer__hit.is-current')
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  useEffect(() => {
    if (locateState !== 'found') return
    focusActiveHit()
  }, [activeHit, locateState, focusActiveHit])

  if (loading) return <div className="source-viewer__status source-viewer__status--loading"><span className="spinner" aria-hidden="true" />{zhCN.common.loading}</div>
  if (error) return <div className="source-viewer__status" style={{ color: '#dc2626' }}>{error}</div>
  if (!data) return <div className="source-viewer__status">未找到资料</div>

  const { source, tags } = data
  const ext = (source.filePath ?? '').toLowerCase()

  const isDocx = ext.endsWith('.docx')
  const isDoc = ext.endsWith('.doc')
  const isWps = ext.endsWith('.wps')
  const isExcel = ext.endsWith('.xls') || ext.endsWith('.xlsx')
  const isPdf = ext.endsWith('.pdf')
  const isImage = ext.endsWith('.png') || ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.bmp')
  const isNativeView = isPdf || isImage
  /** 网页来源（Phase 8 / S4）：用内嵌浏览器加载原网页，而不是库里存的抓取快照 */
  const isWebSource = source.kind === 'url' && !!source.url

  const hitCount = locateRects.length > 0 ? Math.max(...locateRects.map((r) => r.hitIndex)) + 1 : 0

  const locateBar =
    needles.length > 0 ? (
      <div className="source-viewer__locate">
        {isPdf ? (
          /* PDF：文字在 PDF 内部，由 PdfViewer 搜索并回报进展（S3） */
          pdfLocate?.status === 'found' ? (
            <span className="source-viewer__locate-text">
              {zhCN.sourceViewer.locatePdfFound.replace('{page}', String(pdfLocate.page ?? 1))}
            </span>
          ) : pdfLocate?.status === 'no-text' ? (
            <span className="source-viewer__locate-text source-viewer__locate-text--miss">
              {zhCN.sourceViewer.locatePdfNoText}
            </span>
          ) : pdfLocate?.status === 'not-found' ? (
            <span className="source-viewer__locate-text source-viewer__locate-text--miss">
              {zhCN.sourceViewer.locatePdfNotFound}
            </span>
          ) : (
            <span className="source-viewer__locate-text">
              {zhCN.sourceViewer.locatePdfSearching
                .replace('{scanned}', String(pdfLocate?.scanned ?? 0))
                .replace('{total}', String(pdfLocate?.total ?? '?'))}
            </span>
          )
        ) : locateState === 'unsupported' ? (
          <span className="source-viewer__locate-text">
            {isWebSource
              ? zhCN.sourceViewer.locateWebPending
              : isPdf
                ? zhCN.sourceViewer.locatePdfNoText
                : zhCN.sourceViewer.locateNoText}
          </span>
        ) : locateState === 'not-found' ? (
          <span className="source-viewer__locate-text source-viewer__locate-text--miss">
            {zhCN.sourceViewer.locateNotFound}
          </span>
        ) : locateState === 'found' ? (
          <>
            <span className="source-viewer__locate-text">
              {zhCN.sourceViewer.locateFound
                .replace('{n}', String(hitCount))
                .replace('{i}', String(activeHit + 1))}
            </span>
            <button
              type="button"
              className="pdf-viewer__btn"
              onClick={() => setActiveHit((i) => (i - 1 + hitCount) % hitCount)}
              disabled={hitCount <= 1}
            >
              {zhCN.sourceViewer.locatePrev}
            </button>
            <button
              type="button"
              className="pdf-viewer__btn"
              onClick={() => setActiveHit((i) => (i + 1) % hitCount)}
              disabled={hitCount <= 1}
            >
              {zhCN.sourceViewer.locateNext}
            </button>
          </>
        ) : (
          <span className="source-viewer__locate-text">{zhCN.common.loading}</span>
        )}
        {locate?.label ? <span className="source-viewer__locate-anchor">{locate.label}</span> : null}
      </div>
    ) : null

  return (
    <div
      className={`source-viewer${dense ? ' source-viewer--dense' : ''}`}
      style={{ ['--source-sticky-top' as string]: `${stickyTop}px` } as React.CSSProperties}
    >
      <div className="source-viewer__header" ref={headerRef}>
        <div className="source-viewer__header-actions">
          {onBack ? (
            <button type="button" className="source-viewer__back" onClick={onBack} title={zhCN.sourceViewer.back}>
              &larr; {zhCN.sourceViewer.back}
            </button>
          ) : null}
          {/* 内部查看之外，恒提供"用系统默认程序打开"（Q2：所有格式两种方式都要有） */}
          <button
            type="button"
            className="source-viewer__back"
            onClick={() => void handleOpenExternal()}
            title={zhCN.sourceViewer.openExternal}
          >
            {zhCN.sourceViewer.openExternal}
          </button>
          {onClose ? (
            <button type="button" className="source-viewer__back" onClick={onClose} title={zhCN.sourceViewer.close}>
              {zhCN.sourceViewer.close}
            </button>
          ) : null}
        </div>
        <h3 className="source-viewer__title" title={source.title}>{source.title}</h3>
        {tags.length > 0 && (
          <div className="source-viewer__tags">
            {tags.map((tag) => (
              <span key={tag.id} className="source-viewer__tag">
                {tag.name}
              </span>
            ))}
          </div>
        )}
        <div className="source-viewer__meta">
          <span className={`source-viewer__badge source-viewer__badge--${source.status}`}>
            {zhCN.sourceStatus[source.status as 'ready' | 'failed' | 'pending' | 'processing']}
          </span>
          <span className="source-viewer__kind">
            {source.kind === 'file' ? (isPdf ? 'PDF' : isImage ? '图片' : isDocx || isDoc ? 'Word' : isWps ? 'WPS' : isExcel ? 'Excel' : '文本') : '网址'}
          </span>
          {source.url && <span className="source-viewer__url" title={source.url}>{source.url}</span>}
          <span className="source-viewer__date">{new Date(source.createdAt).toLocaleString('zh-CN')}</span>
        </div>
        {locateBar}
        {externalError ? (
          <div className="source-viewer__locate-text source-viewer__locate-text--miss" style={{ marginTop: 6 }}>
            {zhCN.sourceViewer.openExternalFailed.replace('{message}', externalError)}
          </div>
        ) : null}
      </div>
      {!dense && summary ? (
        <div className="source-viewer__summary">
          <h4 className="source-viewer__summary-title">{zhCN.sourceViewer.summaryTitle}</h4>
          <p className="source-viewer__summary-text">{summary.summary}</p>
          {summary.keywords.length > 0 ? (
            <div className="source-viewer__summary-row">
              <span className="source-viewer__summary-label">{zhCN.sourceViewer.keywords}</span>
              <span className="source-viewer__summary-chips">
                {summary.keywords.map((k, i) => (
                  <span key={i} className="source-viewer__summary-chip">{k}</span>
                ))}
              </span>
            </div>
          ) : null}
          {summary.entities.length > 0 ? (
            <div className="source-viewer__summary-row">
              <span className="source-viewer__summary-label">{zhCN.sourceViewer.entities}</span>
              <span className="source-viewer__summary-chips">
                {summary.entities.map((e, i) => (
                  <span key={i} className="source-viewer__summary-chip">{e}</span>
                ))}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="source-viewer__body">
        {/* 定位覆盖层挂在内容坐标系里（position: relative），随内容一起滚动 */}
        <div className="source-viewer__locate-host" ref={hostRef}>
          {isWebSource ? (
            // Phase 8 / S4：网页来源直接用内嵌浏览器加载**原网页**（不再是库里存的抓取快照）
            <WebBrowserPane sourceId={sourceId} url={source.url as string} />
          ) : isDocx && htmlLoading ? (
            <div className="source-viewer__status">正在渲染文档排版...</div>
          ) : isDocx && htmlContent ? (
            // Phase 8 / S2：docx 的整篇 HTML 按顶层块分批进 DOM（大 Word 不再一次性建巨量节点）
            <IncrementalHtml
              html={htmlContent}
              className="source-viewer__docx"
              needles={needles}
              onReveal={() => setRevealTick((t) => t + 1)}
            />
          ) : isPdf && fileUrl ? (
            // S3：把定位锚交给 PdfViewer（它逐页搜 PDF 文字 → 滚到命中页 → 几何高亮该句）
            <PdfViewer url={fileUrl} locateNeedles={needles} onLocate={setPdfLocate} />
          ) : isImage && fileUrl ? (
            <img className="source-viewer__image" src={fileUrl} alt={source.title} />
          ) : isNativeView ? (
            <div className="source-viewer__status">正在加载文件...</div>
          ) : (
            // Phase 8 / S2：纯文本正文按行分批进 DOM
            <IncrementalText
              text={source.cleanedText}
              className="source-viewer__content"
              needles={needles}
              onReveal={() => setRevealTick((t) => t + 1)}
            />
          )}
          {locateRects.map((r, i) => (
            <span
              key={`${r.hitIndex}-${i}`}
              className={`source-viewer__hit${r.hitIndex === activeHit ? ' is-current' : ''}`}
              style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export default SourceViewer