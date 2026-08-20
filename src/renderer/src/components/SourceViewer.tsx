import { useState, useEffect, useCallback } from 'react'
import PdfViewer from './PdfViewer'
import { zhCN } from '../i18n/zh-CN'
import { copyPlainText } from '../utils/clipboard'

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

function SourceViewer({ sourceId, onBack }: { sourceId: string; onBack: () => void }) {
  const [data, setData] = useState<SourceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [htmlContent, setHtmlContent] = useState<string | null>(null)
  const [htmlLoading, setHtmlLoading] = useState(false)
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [summary, setSummary] = useState<SummaryShape | null>(null)
  const [copied, setCopied] = useState(false)

  /** 复制资料全文（纯文本，来自清洗后的正文） */
  const handleCopy = async () => {
    if (!data) return
    const ok = await copyPlainText(data.source.cleanedText)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

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
      // PDF / 图片: 通过 xie-file:// 协议原生渲染
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

  if (loading) return <div className="source-viewer__status source-viewer__status--loading"><span className="spinner" aria-hidden="true" />{zhCN.common.loading}</div>
  if (error) return <div className="source-viewer__status" style={{ color: '#dc2626' }}>{error}</div>
  if (!data) return <div className="source-viewer__status">未找到资料</div>

  const { source, tags } = data
  const ext = (source.filePath ?? '').toLowerCase()

  // 判断文件类型
  const isDocx = ext.endsWith('.docx')
  const isDoc = ext.endsWith('.doc')
  const isWps = ext.endsWith('.wps')
  const isExcel = ext.endsWith('.xls') || ext.endsWith('.xlsx')
  const isPdf = ext.endsWith('.pdf')
  const isImage = ext.endsWith('.png') || ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.bmp')
  const isNativeView = isPdf || isImage

  return (
    <div className="source-viewer">
      <div className="source-viewer__header">
        <div className="source-viewer__header-actions">
          <button type="button" className="source-viewer__back" onClick={onBack} title={zhCN.sourceViewer.back}>
            &larr; {zhCN.sourceViewer.back}
          </button>
          <button type="button" className="source-list__btn" onClick={() => void handleCopy()} title={zhCN.sourceViewer.copyText}>
            {copied ? zhCN.sourceViewer.copied : zhCN.sourceViewer.copyText}
          </button>
        </div>
        <h3 className="source-viewer__title">{source.title}</h3>
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
      </div>
      {summary ? (
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
        {isDocx && htmlLoading ? (
          <div className="source-viewer__status">正在渲染文档排版...</div>
        ) : isDocx && htmlContent ? (
          <div className="source-viewer__docx" dangerouslySetInnerHTML={{ __html: htmlContent }} />
        ) : isPdf && fileUrl ? (
          <PdfViewer url={fileUrl} />
        ) : isImage && fileUrl ? (
          <img className="source-viewer__image" src={fileUrl} alt={source.title} />
        ) : isNativeView ? (
          <div className="source-viewer__status">正在加载文件...</div>
        ) : (
          <pre className="source-viewer__content">{source.cleanedText}</pre>
        )}
      </div>
    </div>
  )
}

export default SourceViewer
