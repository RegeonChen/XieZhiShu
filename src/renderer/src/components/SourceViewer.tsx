import { useState, useEffect, useCallback, useRef } from 'react'
import PdfViewer from './PdfViewer'
import WebBrowserPane from './WebBrowserPane'
import SourceSnapshotModal from './SourceSnapshotModal'
import { IncrementalHtml, IncrementalText } from './IncrementalContent'
import { locateBarState, type SourceLocateAnchor } from '../lib/source-locate'
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

interface SourceViewerProps {
  sourceId: string
  /** 资料库模式：返回按钮 */
  onBack?: () => void
  /**
   * 定位锚（Phase 9 / S4）：只报"页/段"，不再做句子级检索。
   * `kind: 'unknown'` = 老汇编没有锚点 → 如实提示"未记录来源位置"（用户裁定 Q4）。
   */
  locate?: SourceLocateAnchor | null
  /** 「查看本地快照」弹窗里高亮的引文（该段的证据/正文）；与"定位到页"是两件事 */
  snapshotHighlight?: string
  /** 分栏模式：更紧凑的表头 + 关闭按钮（生成汇编右栏用） */
  dense?: boolean
  onClose?: () => void
}

function SourceViewer({
  sourceId,
  onBack,
  locate,
  snapshotHighlight,
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
  /** 外部打开失败的就地提示（不静默失败） */
  const [externalError, setExternalError] = useState<string | null>(null)

  const headerRef = useRef<HTMLDivElement | null>(null)
  /** 表头（操作行 + 定位行）吸顶后的实际高度：PDF 工具栏要挂在它下面，否则两者会在 top:0 重叠 */
  const [stickyTop, setStickyTop] = useState(0)
  /** Phase 9 / S1：「查看本地快照」弹窗（原在"来源小卡"里，随中间层删除迁到本查看器） */
  const [snapshotOpen, setSnapshotOpen] = useState(false)

  /**
   * 用系统默认程序打开（用户裁定 Q2：**所有格式**都要同时具备"内部分栏查看"与"外部打开"）。
   * 放在查看器内部实现：资料库与生成汇编两处都自动具备，失败时就地提示而不是静默。
   */
  const handleOpenExternal = useCallback(async () => {
    setExternalError(null)
    const res = await window.api.openSourcePath(sourceId)
    if (!res.ok) setExternalError(res.error?.message ?? '打开失败')
  }, [sourceId])

  const load = useCallback(async () => {
    setLoading(true)
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

  useEffect(() => {
    void load()
  }, [load])

  // 加载 LLM 摘要（整理资料库后生成）
  useEffect(() => {
    let cancelled = false
    window.api
      .getSourceSummary(sourceId)
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.data && res.data.summary) {
          const s = res.data.summary as SummaryShape
          if (s.summary) setSummary(s)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
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
      window.api
        .renderSourceHtml(sourceId)
        .then((res) => {
          if (cancelled) return
          if (res.ok && res.data) setHtmlContent(res.data.html)
          setHtmlLoading(false)
        })
        .catch(() => {
          if (!cancelled) setHtmlLoading(false)
        })
    } else if (
      ext.endsWith('.pdf') ||
      ext.endsWith('.png') ||
      ext.endsWith('.jpg') ||
      ext.endsWith('.jpeg') ||
      ext.endsWith('.bmp')
    ) {
      // PDF / 图片: 通过本地文件服务原生渲染
      setHtmlContent(null)
      window.api
        .getSourceFileUrl(sourceId)
        .then((res) => {
          if (cancelled) return
          if (res.ok && res.data) setFileUrl(res.data.url)
        })
        .catch(() => {})
    } else {
      // TXT / MD: 纯文本
      setHtmlContent(null)
      setFileUrl(null)
    }

    return () => {
      cancelled = true
    }
  }, [data, sourceId])

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
  }, [data, htmlContent, locate, externalError, dense])

  if (loading)
    return (
      <div className="source-viewer__status source-viewer__status--loading">
        <span className="spinner" aria-hidden="true" />
        {zhCN.common.loading}
      </div>
    )
  if (error)
    return (
      <div className="source-viewer__status" style={{ color: '#dc2626' }}>
        {error}
      </div>
    )
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

  /**
   * 定位条文案（Phase 9 / S4）：只可能说三件事——第 P 页 / 第 N 段 / 未记录来源位置。
   * 判定放在纯逻辑 `locateBarState` 里（含"数不出段号就如实说没有位置"），这里只套文案。
   */
  const t = zhCN.sourceViewer
  const barState = locateBarState(locate, source.cleanedText, isPdf)
  const locateText =
    barState?.kind === 'page'
      ? t.locatePage.replace('{page}', String(barState.page))
      : barState?.kind === 'paragraph'
        ? t.locateParagraph.replace('{n}', String(barState.paragraph))
        : barState?.kind === 'page-unknown'
          ? t.locatePdfNoPage
          : t.locateNone
  // 网页来源不显示定位条：原网页是实时加载的，库里的段落位置对它没有意义
  const locateBar =
    barState && !isWebSource ? (
      <div className="source-viewer__locate">
        <span className={`source-viewer__locate-text${barState.kind === 'none' || barState.kind === 'page-unknown' ? ' source-viewer__locate-text--miss' : ''}`}>
          {locateText}
        </span>
        {barState.label ? <span className="source-viewer__locate-anchor">{barState.label}</span> : null}
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
            <button type="button" className="source-viewer__back" onClick={onBack} title={t.back}>
              &larr; {t.back}
            </button>
          ) : null}
          {/* 内部查看之外，恒提供"用系统默认程序打开"（Q2：所有格式两种方式都要有） */}
          <button
            type="button"
            className="source-viewer__back"
            onClick={() => void handleOpenExternal()}
            title={t.openExternal}
          >
            {t.openExternal}
          </button>
          {/* Phase 9 / S1：网页来源另给"查看本地快照"（读库里抓取当时的正文，不联网核对"当时"的内容） */}
          {isWebSource ? (
            <button
              type="button"
              className="source-viewer__back"
              onClick={() => setSnapshotOpen(true)}
              title={zhCN.compilation.snapshotOpen}
            >
              {zhCN.compilation.snapshotOpen}
            </button>
          ) : null}
          {onClose ? (
            <button type="button" className="source-viewer__back" onClick={onClose} title={t.close}>
              {t.close}
            </button>
          ) : null}
        </div>
        <h3 className="source-viewer__title" title={source.title}>
          {source.title}
        </h3>
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
            {source.kind === 'file'
              ? isPdf
                ? 'PDF'
                : isImage
                  ? '图片'
                  : isDocx || isDoc
                    ? 'Word'
                    : isWps
                      ? 'WPS'
                      : isExcel
                        ? 'Excel'
                        : '文本'
              : '网址'}
          </span>
          {source.url && (
            <span className="source-viewer__url" title={source.url}>
              {source.url}
            </span>
          )}
          <span className="source-viewer__date">{new Date(source.createdAt).toLocaleString('zh-CN')}</span>
        </div>
        {locateBar}
        {externalError ? (
          <div className="source-viewer__locate-text source-viewer__locate-text--miss" style={{ marginTop: 6 }}>
            {t.openExternalFailed.replace('{message}', externalError)}
          </div>
        ) : null}
      </div>
      {!dense && summary ? (
        <div className="source-viewer__summary">
          <h4 className="source-viewer__summary-title">{t.summaryTitle}</h4>
          <p className="source-viewer__summary-text">{summary.summary}</p>
          {summary.keywords.length > 0 ? (
            <div className="source-viewer__summary-row">
              <span className="source-viewer__summary-label">{t.keywords}</span>
              <span className="source-viewer__summary-chips">
                {summary.keywords.map((k, i) => (
                  <span key={i} className="source-viewer__summary-chip">
                    {k}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
          {summary.entities.length > 0 ? (
            <div className="source-viewer__summary-row">
              <span className="source-viewer__summary-label">{t.entities}</span>
              <span className="source-viewer__summary-chips">
                {summary.entities.map((e, i) => (
                  <span key={i} className="source-viewer__summary-chip">
                    {e}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {snapshotOpen ? (
        <SourceSnapshotModal sourceId={sourceId} highlight={snapshotHighlight} onClose={() => setSnapshotOpen(false)} />
      ) : null}
      <div className="source-viewer__body">
        {isWebSource ? (
          // Phase 8 / S4：网页来源直接用内嵌浏览器加载**原网页**（不再是库里存的抓取快照）
          <WebBrowserPane sourceId={sourceId} url={source.url as string} />
        ) : isDocx && htmlLoading ? (
          <div className="source-viewer__status">正在渲染文档排版...</div>
        ) : isDocx && htmlContent ? (
          // Phase 8 / S2：docx 的整篇 HTML 按顶层块分批进 DOM（大 Word 不再一次性建巨量节点）
          <IncrementalHtml html={htmlContent} className="source-viewer__docx" />
        ) : isPdf && fileUrl ? (
          // Phase 9 / S4：定位改为**按页跳转**（页码来自生成期锚点 × 页表，不做任何文字检索）
          <PdfViewer url={fileUrl} targetPage={locate?.kind === 'page' ? locate.page : null} />
        ) : isImage && fileUrl ? (
          <img className="source-viewer__image" src={fileUrl} alt={source.title} />
        ) : isNativeView ? (
          <div className="source-viewer__status">正在加载文件...</div>
        ) : (
          // Phase 8 / S2：纯文本正文按行分批进 DOM
          <IncrementalText text={source.cleanedText} className="source-viewer__content" />
        )}
      </div>
    </div>
  )
}

export default SourceViewer
