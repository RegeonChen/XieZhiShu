import { useState, useEffect } from 'react'

interface TagItem {
  id: string
  name: string
  color?: string
}

interface TagManagerProps {
  sourceId?: string
  sourceTags?: TagItem[]
  onTagsChange?: () => void
}

const TAG_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6']

function TagManager({ sourceId, sourceTags, onTagsChange }: TagManagerProps) {
  const [allTags, setAllTags] = useState<TagItem[]>([])
  const [newName, setNewName] = useState('')

  const loadTags = async () => {
    const res = await window.api.listTags()
    if (res.ok && res.data) {
      setAllTags(res.data.items as TagItem[])
    }
  }

  useEffect(() => {
    loadTags()
  }, [])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    const color = TAG_COLORS[allTags.length % TAG_COLORS.length]
    const res = await window.api.createTag(name, color)
    if (res.ok && res.data) {
      const tag = res.data.tag as TagItem
      setAllTags((prev) => [...prev, tag])
      setNewName('')
    }
  }

  const handleDelete = async (id: string) => {
    await window.api.deleteTag(id)
    setAllTags((prev) => prev.filter((t) => t.id !== id))
  }

  const handleToggleSource = async (tagId: string) => {
    if (!sourceId) return
    const sourceTagIds = new Set((sourceTags ?? []).map((t) => t.id))
    if (sourceTagIds.has(tagId)) {
      await window.api.removeTagFromSource(sourceId, tagId)
    } else {
      await window.api.addTagToSource(sourceId, tagId)
    }
    onTagsChange?.()
  }

  const sourceTagIds = new Set((sourceTags ?? []).map((t) => t.id))

  return (
    <div className="tag-manager">
      <h4 className="tag-manager__title">
        {sourceId ? '为资料打标签' : '全部标签'}
      </h4>

      <div className="tag-manager__create">
        <input
          className="tag-manager__input"
          placeholder="新标签名称..."
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
        />
        <button
          type="button"
          className="source-list__btn source-list__btn--primary"
          onClick={handleCreate}
          disabled={!newName.trim()}
        >
          创建
        </button>
      </div>

      <ul className="tag-manager__list">
        {allTags.map((tag) => {
          const isSourceTag = sourceTagIds.has(tag.id)
          return (
            <li key={tag.id} className="tag-manager__item">
              <span
                className="tag-manager__swatch"
                style={{ background: tag.color ?? '#888' }}
              />
              <span className="tag-manager__name">{tag.name}</span>
              {sourceId ? (
                <button
                  type="button"
                  className={`source-list__btn ${isSourceTag ? 'source-list__btn--primary' : ''}`}
                  onClick={() => handleToggleSource(tag.id)}
                >
                  {isSourceTag ? '已标记' : '标记'}
                </button>
              ) : (
                <button
                  type="button"
                  className="source-list__btn"
                  onClick={() => handleDelete(tag.id)}
                  style={{ color: '#dc2626', borderColor: '#fecaca' }}
                >
                  删除
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default TagManager
