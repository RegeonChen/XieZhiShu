import { useState, useEffect } from 'react'

interface TemplateItem {
  id: string
  name: string
  filePath: string
  outline: string   // JSON 字符串
  createdAt: string
}

interface OutlineItem {
  level: number
  title: string
  children?: OutlineItem[]
}

function TemplateManager() {
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const loadTemplates = async () => {
    setLoading(true)
    try {
      const res = await window.api.listTemplates()
      if (res.ok && res.data) {
        setTemplates(res.data.items as TemplateItem[])
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadTemplates() }, [])

  const handleImport = async () => {
    const result = await window.api.openFileDialog()
    if (!result.ok || !result.data?.paths.length) return
    const path = result.data.paths[0]
    const res = await window.api.importTemplate(path)
    if (res.ok && res.data) {
      setTemplates((prev) => [...prev, res.data!.template as TemplateItem])
    }
  }

  const handleDelete = async (id: string) => {
    await window.api.deleteTemplate(id)
    if (selectedId === id) setSelectedId(null)
    setTemplates((prev) => prev.filter((t) => t.id !== id))
  }

  const selected = selectedId ? templates.find((t) => t.id === selectedId) : null
  let outline: OutlineItem[] = []
  try {
    if (selected?.outline) outline = JSON.parse(selected.outline)
  } catch { /* ignore */ }

  return (
    <div className="template-manager">
      <div className="template-manager__toolbar">
        <button type="button" className="source-list__btn source-list__btn--primary" onClick={handleImport}>
          导入范本
        </button>
        <button type="button" className="source-list__btn" onClick={loadTemplates} disabled={loading}>
          刷新
        </button>
      </div>

      <div className="template-manager__body">
        <ul className="template-manager__list">
          {templates.map((t) => (
            <li
              key={t.id}
              className={`template-manager__item ${selectedId === t.id ? 'template-manager__item--active' : ''}`}
              onClick={() => setSelectedId(t.id === selectedId ? null : t.id)}
            >
              <span className="template-manager__name">{t.name}</span>
              <button
                type="button"
                className="source-list__btn"
                onClick={(e) => { e.stopPropagation(); handleDelete(t.id) }}
                style={{ color: '#dc2626', borderColor: '#fecaca', fontSize: 11 }}
              >
                删除
              </button>
            </li>
          ))}
        </ul>

        <div className="template-manager__outline">
          {selected ? (
            <>
              <h4 className="template-manager__outline-title">篇目结构：{selected.name}</h4>
              <OutlineTree items={outline} />
            </>
          ) : (
            <p className="source-list__status">选择左侧范本查看篇目结构</p>
          )}
        </div>
      </div>
    </div>
  )
}

function OutlineTree({ items, depth = 0 }: { items: OutlineItem[]; depth?: number }) {
  if (!items.length) return <p className="source-list__status">未识别到标题层级</p>
  return (
    <ul className="outline-tree" style={{ paddingLeft: depth * 16 }}>
      {items.map((item, i) => (
        <li key={i} className="outline-tree__item">
          <span className="outline-tree__title">
            {'#'.repeat(item.level)} {item.title}
          </span>
          {item.children?.length ? <OutlineTree items={item.children} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  )
}

export default TemplateManager
