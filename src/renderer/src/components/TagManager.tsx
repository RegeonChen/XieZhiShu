import { useState, useEffect, useCallback } from 'react'
import { parseSourceTitleTags } from '../../../utils/source-title-tags'
import { zhCN } from '../i18n/zh-CN'

interface TagItem { id: string; name: string }
interface SourceItem { id: string; title: string; kind: string; status: string; createdAt: string }

/** 解析资料标题并渲染干净标题 + 元信息 */
function SourceRow({ source, checkbox, checked, onToggle }: {
  source: SourceItem
  checkbox?: boolean
  checked?: boolean
  onToggle?: () => void
}) {
  const parsed = parseSourceTitleTags(source.title)
  return (
    <li
      className={`tag-manager__source-item${checked ? ' is-checked' : ''}`}
      onClick={checkbox ? onToggle : undefined}
    >
      {checkbox ? (
        <span className={`tag-manager__checkbox${checked ? ' is-checked' : ''}`} aria-hidden="true" />
      ) : null}
      <span className="tag-manager__source-title">{parsed.cleanTitle}</span>
      <span className="tag-manager__source-kind">{source.kind === 'file' ? '文件' : '网址'}</span>
      <span className="tag-manager__source-date">
        {new Date(source.createdAt).toLocaleDateString('zh-CN')}
      </span>
    </li>
  )
}

function TagChip({ tag, selected, onClick }: { tag: TagItem; selected?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`tag-manager__tag-chip${selected ? ' is-selected' : ''}`}
      onClick={onClick}
    >
      {tag.name}
    </button>
  )
}

/* ---------- 模块 1：新建标签 ---------- */
function CreateTagModule({ tags, onCreated }: { tags: TagItem[] | null; onCreated: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [suggestions, setSuggestions] = useState<TagItem[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgOk, setMsgOk] = useState(true)

  // 输入时实时搜索相似标签（防抖 200ms）
  useEffect(() => {
    const q = name.trim()
    if (!q) { setSuggestions([]); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      const res = await window.api.searchTags(q, 5)
      if (!cancelled && res.ok && res.data) setSuggestions(res.data.items as TagItem[])
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [name])

  const handleCreate = async () => {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    try {
      const res = await window.api.createTag(n)
      if (res.ok && res.data) {
        const existed = tags?.some((t) => t.name === n)
        setMsg(
          existed
            ? zhCN.tagManager.create.existed.replace('{name}', n)
            : zhCN.tagManager.create.created.replace('{name}', n)
        )
        setMsgOk(true)
        setName('')
        setSuggestions([])
        await onCreated()
      } else {
        setMsg(zhCN.tagManager.create.failed.replace('{message}', res.error?.message ?? ''))
        setMsgOk(false)
      }
    } finally { setBusy(false) }
  }

  return (
    <div className="tag-manager__module">
      <div className="tag-manager__create">
        <input
          className="tag-manager__input"
          placeholder={zhCN.tagManager.create.namePlaceholder}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
        />
        <button type="button" className="source-list__btn source-list__btn--primary" onClick={handleCreate} disabled={!name.trim() || busy}>
          {zhCN.tagManager.create.createBtn}
        </button>
      </div>

      {suggestions.length > 0 ? (
        <div className="tag-manager__suggestions">
          <p className="tag-manager__suggestions-title">{zhCN.tagManager.create.similarTitle}</p>
          <ul className="tag-manager__suggestions-list">
            {suggestions.map((t) => (
              <li key={t.id} className="tag-manager__suggestions-item">
                <span className="tag-manager__name">{t.name}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : name.trim() && !suggestions.length ? (
        <p className="tag-manager__hint">{zhCN.tagManager.create.empty}</p>
      ) : null}

      {msg ? <p className={`tag-manager__msg ${msgOk ? 'is-ok' : 'is-err'}`}>{msg}</p> : null}
    </div>
  )
}

/* ---------- 模块 2：添加标签（批量打标） ---------- */
function AddTagModule({ tags, onChanged }: { tags: TagItem[] | null; onChanged: () => void }) {
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null)
  const [sources, setSources] = useState<SourceItem[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgOk, setMsgOk] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    window.api.listSources().then((res) => {
      if (!cancelled && res.ok && res.data) setSources(res.data.items as SourceItem[])
    })
    return () => { cancelled = true }
  }, [])

  // 选中标签时预勾选已带该标签的资料
  useEffect(() => {
    if (!selectedTagId) { setChecked(new Set()); return }
    let cancelled = false
    window.api.getTagSourceIds(selectedTagId).then((res) => {
      if (!cancelled && res.ok && res.data) setChecked(new Set(res.data.sourceIds))
    })
    return () => { cancelled = true }
  }, [selectedTagId, reloadKey])

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allChecked = (sources?.length ?? 0) > 0 && (sources ?? []).every((s) => checked.has(s.id))
  const handleToggleAll = () => {
    if (!sources) return
    setChecked(allChecked ? new Set() : new Set(sources.map((s) => s.id)))
  }

  const handleConfirm = async () => {
    if (!selectedTagId || checked.size === 0 || busy) return
    setBusy(true)
    try {
      const res = await window.api.batchAddTags([selectedTagId], Array.from(checked))
      if (res.ok) {
        setMsg(zhCN.tagManager.add.added.replace('{count}', String(checked.size)))
        setMsgOk(true)
        setReloadKey((k) => k + 1)
        onChanged()
      } else {
        setMsg(`添加失败：${res.error?.message ?? ''}`)
        setMsgOk(false)
      }
    } finally { setBusy(false) }
  }

  return (
    <div className="tag-manager__module">
      <p className="tag-manager__label">{zhCN.tagManager.add.selectTagTitle}</p>
      {(tags ?? []).length === 0 ? (
        <p className="tag-manager__hint">{zhCN.tagManager.add.empty}</p>
      ) : (
        <div className="tag-manager__chip-list">
          {(tags ?? []).map((t) => (
            <TagChip key={t.id} tag={t} selected={selectedTagId === t.id} onClick={() => setSelectedTagId(selectedTagId === t.id ? null : t.id)} />
          ))}
        </div>
      )}

      {selectedTagId ? (
        <>
          <div className="tag-manager__toolbar">
            <button type="button" className="source-list__btn" onClick={handleToggleAll} disabled={!sources || sources.length === 0}>
              {allChecked ? zhCN.tagManager.add.deselectAll : zhCN.tagManager.add.selectAll}
            </button>
            <span className="tag-manager__count">{zhCN.tagManager.add.count.replace('{count}', String(checked.size))}</span>
            <button type="button" className="source-list__btn source-list__btn--primary" onClick={handleConfirm} disabled={checked.size === 0 || busy}>
              {busy ? zhCN.tagManager.add.adding : zhCN.tagManager.add.confirmAdd}
            </button>
          </div>
          <p className="tag-manager__label">{zhCN.tagManager.add.selectSourcesTitle}</p>
          {sources === null ? (
            <p className="tag-manager__hint">加载中...</p>
          ) : sources.length === 0 ? (
            <p className="tag-manager__hint">{zhCN.tagManager.add.noSources}</p>
          ) : (
            <ul className="tag-manager__source-list">
              {sources.map((s) => (
                <SourceRow key={s.id} source={s} checkbox checked={checked.has(s.id)} onToggle={() => toggle(s.id)} />
              ))}
            </ul>
          )}
        </>
      ) : null}

      {msg ? <p className={`tag-manager__msg ${msgOk ? 'is-ok' : 'is-err'}`}>{msg}</p> : null}
    </div>
  )
}

/* ---------- 模块 3：删除标签 ---------- */
function RemoveTagModule({ tags, onDeleted }: { tags: TagItem[] | null; onDeleted: () => Promise<void> }) {
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const selected = (tags ?? []).find((t) => t.id === selectedTagId) ?? null

  const handleDelete = async () => {
    if (!selected || busy) return
    if (!confirm(zhCN.tagManager.remove.confirmDelete.replace('{name}', selected.name))) return
    setBusy(true)
    try {
      const res = await window.api.deleteTag(selected.id)
      if (res.ok) {
        setSelectedTagId(null)
        await onDeleted()
      }
    } finally { setBusy(false) }
  }

  return (
    <div className="tag-manager__module">
      <p className="tag-manager__label">{zhCN.tagManager.remove.selectTagTitle}</p>
      {(tags ?? []).length === 0 ? (
        <p className="tag-manager__hint">{zhCN.tagManager.remove.noTags}</p>
      ) : (
        <div className="tag-manager__chip-list">
          {(tags ?? []).map((t) => (
            <TagChip key={t.id} tag={t} selected={selectedTagId === t.id} onClick={() => setSelectedTagId(selectedTagId === t.id ? null : t.id)} />
          ))}
        </div>
      )}
      {selected ? (
        <div className="tag-manager__toolbar">
          <button type="button" className="source-list__btn source-list__btn--danger" onClick={handleDelete} disabled={busy}>
            {zhCN.tagManager.remove.deleteBtn}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* ---------- 模块 4：按标签检索 ---------- */
function SearchModule({ tags }: { tags: TagItem[] | null }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<SourceItem[] | null>(null)
  const [loading, setLoading] = useState(false)

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useEffect(() => {
    if (selected.size === 0) { setResults(null); return }
    let cancelled = false
    setLoading(true)
    window.api.listSources({ tagIds: Array.from(selected) })
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.data) setResults(res.data.items as SourceItem[])
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selected])

  return (
    <div className="tag-manager__module">
      <p className="tag-manager__label">{zhCN.tagManager.search.title}</p>
      {(tags ?? []).length === 0 ? (
        <p className="tag-manager__hint">{zhCN.tagManager.search.noTags}</p>
      ) : (
        <div className="tag-manager__chip-list">
          {(tags ?? []).map((t) => (
            <TagChip key={t.id} tag={t} selected={selected.has(t.id)} onClick={() => toggle(t.id)} />
          ))}
        </div>
      )}

      {selected.size > 0 ? (
        <>
          <p className="tag-manager__label">
            {zhCN.tagManager.search.resultTitle}
            {results ? ` ${zhCN.tagManager.search.count.replace('{count}', String(results.length))}` : ''}
          </p>
          {loading && results === null ? (
            <p className="tag-manager__hint">检索中...</p>
          ) : results === null ? null : results.length === 0 ? (
            <p className="tag-manager__hint">{zhCN.tagManager.search.empty}</p>
          ) : (
            <ul className="tag-manager__source-list">
              {results.map((s) => (
                <SourceRow key={s.id} source={s} />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  )
}

/* ---------- 标签管理主界面 ---------- */
function TagManager({ onTagsChanged }: { onTagsChanged?: () => void }) {
  const [activeTab, setActiveTab] = useState(0)
  const [tags, setTags] = useState<TagItem[] | null>(null)

  const loadTags = useCallback(async () => {
    const res = await window.api.listTags()
    if (res.ok && res.data) setTags(res.data.items as TagItem[])
  }, [])

  useEffect(() => { loadTags() }, [loadTags])

  const handleChanged = async () => {
    await loadTags()
    onTagsChanged?.()
  }

  return (
    <div className="tag-manager">
      <h3 className="tag-manager__title">{zhCN.tagManager.title}</h3>
      <div className="tag-manager__tabs">
        {zhCN.tagManager.tabs.map((label, i) => (
          <button
            key={i}
            type="button"
            className={`tag-manager__tab${activeTab === i ? ' is-active' : ''}`}
            onClick={() => setActiveTab(i)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="tag-manager__body">
        {activeTab === 0 ? <CreateTagModule tags={tags} onCreated={handleChanged} /> : null}
        {activeTab === 1 ? <AddTagModule tags={tags} onChanged={handleChanged} /> : null}
        {activeTab === 2 ? <RemoveTagModule tags={tags} onDeleted={handleChanged} /> : null}
        {activeTab === 3 ? <SearchModule tags={tags} /> : null}
      </div>
    </div>
  )
}

export default TagManager
