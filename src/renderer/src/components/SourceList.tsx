import { useState, useEffect, useCallback } from 'react'

interface SourceItem {
  id: string
  title: string
  kind: string
  status: string
  createdAt: string
}

interface TagItem {
  id: string
  name: string
  color?: string
}

function SourceList({ onSelect }: { onSelect: (id: string | null) => void }) {
  const [sources, setSources] = useState<SourceItem[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [urlAdding, setUrlAdding] = useState(false)
  const [tags, setTags] = useState<TagItem[]>([])
  const [activeTagId, setActiveTagId] = useState<string | null>(null)

  const loadSources = useCallback(async (tagId?: string | null) => {
    setLoading(true)
    try {
      const params = tagId ? { tagIds: [tagId] } : undefined
      const res = await window.api.listSources(params)
      if (res.ok && res.data) {
        setSources(res.data.items as SourceItem[])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const loadTags = async () => {
    const res = await window.api.listTags()
    if (res.ok && res.data) {
      setTags(res.data.items as TagItem[])
    }
  }

  useEffect(() => {
    loadSources(activeTagId)
    loadTags()
  }, [activeTagId, loadSources])

  const handleImport = async () => {
    const result = await window.api.openFileDialog()
    if (!result.ok || !result.data?.paths.length) return
    setImporting(true)
    setImportErr(null)
    try {
      const res = await window.api.importFiles(result.data.paths)
      if (res.ok && res.data) {
        const imported: SourceItem[] = []
        for (const r of res.data.results) {
          if (r.source) imported.push(r.source as SourceItem)
          else if (r.error) setImportErr((p) => (p ? `${p}; ${r.path}: ${r.error}` : `${r.path}: ${r.error}`))
        }
        if (imported.length > 0) {
          setSources((prev) => [...imported, ...prev])
        }
      }
    } finally {
      setImporting(false)
    }
  }

  const handleAddUrl = async () => {
    const trimmed = urlInput.trim()
    if (!trimmed) return
    setUrlAdding(true)
    setImportErr(null)
    try {
      const res = await window.api.addUrl(trimmed)
      if (res.ok && res.data) {
        const src = res.data.source as SourceItem
        setSources((prev) => [{ id: src.id, title: src.title, kind: 'url', status: 'ready', createdAt: new Date().toISOString() }, ...prev])
        setUrlInput('')
      } else {
        setImportErr(res.error?.message ?? '添加失败')
      }
    } catch {
      setImportErr('网络请求异常')
    } finally {
      setUrlAdding(false)
    }
  }

  return (
    <div className="source-list">
      <div className="source-list__toolbar">
        <button type="button" className="source-list__btn source-list__btn--primary" onClick={handleImport} disabled={importing}>
          {importing ? '导入中...' : '导入文件'}
        </button>
        <button type="button" className="source-list__btn" onClick={() => loadSources(activeTagId)} disabled={loading}>
          刷新
        </button>
      </div>

      <div className="source-list__url-bar">
        <input
          type="url"
          className="source-list__url-input"
          placeholder="输入网页网址按回车添加..."
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAddUrl() }}
        />
        <button type="button" className="source-list__btn source-list__btn--primary" onClick={handleAddUrl} disabled={urlAdding || !urlInput.trim()}>
          {urlAdding ? '抓取中...' : '添加'}
        </button>
      </div>

      {importErr ? <p className="source-list__error">{importErr}</p> : null}

      {tags.length > 0 ? (
        <div className="source-list__tag-bar">
          <button
            type="button"
            className={`source-list__tag-chip ${!activeTagId ? 'source-list__tag-chip--active' : ''}`}
            onClick={() => setActiveTagId(null)}
          >
            全部
          </button>
          {tags.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`source-list__tag-chip ${activeTagId === t.id ? 'source-list__tag-chip--active' : ''}`}
              style={activeTagId === t.id ? { background: t.color ?? '#888', color: '#fff', borderColor: t.color ?? '#888' } : { borderColor: t.color ?? '#888', color: t.color ?? '#888' }}
              onClick={() => setActiveTagId(activeTagId === t.id ? null : t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      ) : null}

      {loading ? (
        <p className="source-list__status">加载中...</p>
      ) : sources.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state__hint">暂无资料。导入文件或输入网址添加信源。</p>
        </div>
      ) : (
        <ul className="source-list__items">
          {sources.map((s) => (
            <li key={s.id} className="source-list__item" onClick={() => onSelect(s.id)}>
              <span className="source-list__item-title">{s.title}</span>
              <span className={`source-list__item-badge source-list__item-badge--${s.status}`}>
                {s.status === 'ready' ? '已就绪' : s.status === 'pending' ? '排队中' : s.status === 'failed' ? '失败' : '处理中'}
              </span>
              <span className="source-list__item-kind">{s.kind === 'file' ? '文件' : '网址'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default SourceList
