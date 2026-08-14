import { useState, useEffect, useCallback } from 'react'
import { zhCN } from '../i18n/zh-CN'
import ConfirmDialog from './ConfirmDialog'

interface SkillItem {
  id: string
  name: string
  category: 'general' | 'section'
  tags: string[]
  content: string
  isPreset: boolean
}

interface SkillFormState {
  id?: string
  name: string
  category: 'general' | 'section'
  tags: string
  content: string
}

/**
 * 模糊匹配：搜索词对 skill 名称/标签/内容做匹配。
 * 1) 完整子串（不区分大小写）；2) 名称逐字子序列（允许中间缺字，如"学前"→"学前教育"、"教"→多个教育 skill）；3) 内容兜底。
 */
function fuzzyMatch(skill: SkillItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const name = skill.name.toLowerCase()
  const tags = skill.tags.join(' ').toLowerCase()
  if (name.includes(q) || tags.includes(q)) return true

  const isSubsequence = (haystack: string): boolean => {
    let i = 0
    for (const ch of haystack) {
      if (ch === q[i]) i++
      if (i === q.length) return true
    }
    return false
  }
  if (isSubsequence(name) || isSubsequence(tags)) return true
  return skill.content.toLowerCase().includes(q)
}

/**
 * 写作规范（skills）管理页（2026-08-13 由「范本」重构）：
 * 列表展示预设/自建规范，支持新建、编辑、删除；内容为蒸馏后的志书写作规范要点。
 */
function SkillsManager() {
  const t = zhCN.skills
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [form, setForm] = useState<SkillFormState | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<SkillItem | null>(null)
  const [search, setSearch] = useState('')

  const filtered = skills.filter((s) => fuzzyMatch(s, search))

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await window.api.listSkills()
      if (res.ok && res.data) setSkills(res.data.items as SkillItem[])
      else setErr(res.error?.message ?? t.loadFailed)
    } finally {
      setLoading(false)
    }
  }, [t.loadFailed])

  useEffect(() => { void load() }, [load])

  const handleSave = async () => {
    if (!form || busy) return
    const name = form.name.trim()
    const content = form.content.trim()
    if (!name || !content) { setErr(t.emptyFields); return }
    const tags = form.tags.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)
    setBusy(true)
    setErr(null)
    try {
      const res = form.id
        ? await window.api.updateSkill(form.id, { name, category: form.category, tags, content })
        : await window.api.createSkill({ name, category: form.category, tags, content })
      if (res.ok) {
        setForm(null)
        await load()
      } else {
        setErr(res.error?.message ?? t.saveFailed)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!pendingDelete || busy) return
    setBusy(true)
    setErr(null)
    try {
      const res = await window.api.deleteSkill(pendingDelete.id)
      if (res.ok) {
        setPendingDelete(null)
        await load()
      } else {
        setErr(res.error?.message ?? t.deleteFailed)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="skills-manager">
      <div className="skills-manager__head">
        <h3 className="skills-manager__title">{t.title}</h3>
        <p className="skills-manager__hint">{t.hint}</p>
        <button
          type="button"
          className="source-list__btn source-list__btn--primary"
          onClick={() => setForm({ name: '', category: 'section', tags: '', content: '' })}
        >
          {t.newBtn}
        </button>
      </div>

      {err ? <p className="source-list__error">{err}</p> : null}

      <div className="skills-manager__search">
        <input
          type="text"
          className="source-list__url-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.searchPlaceholder}
        />
      </div>

      {loading ? (
        <p className="source-list__status">{t.loading}</p>
      ) : skills.length === 0 ? (
        <p className="source-list__status">{t.empty}</p>
      ) : filtered.length === 0 ? (
        <p className="source-list__status">{t.noMatch}</p>
      ) : (
        <ul className="skills-manager__list">
          {filtered.map((s) => (
            <li key={s.id} className="skills-manager__item">
              <div className="skills-manager__item-head">
                <span className="skills-manager__item-name">{s.name}</span>
                <span className={`skills-manager__badge skills-manager__badge--${s.category}`}>
                  {s.category === 'general' ? t.general : t.section}
                </span>
                {s.isPreset ? <span className="skills-manager__badge skills-manager__badge--preset">{t.preset}</span> : null}
              </div>
              {s.tags.length > 0 ? (
                <div className="skills-manager__item-tags">
                  {s.tags.map((tag) => (
                    <span key={tag} className="skills-manager__tag">{tag}</span>
                  ))}
                </div>
              ) : null}
              <p className="skills-manager__item-content">{s.content.slice(0, 120)}{s.content.length > 120 ? '…' : ''}</p>
              <div className="skills-manager__item-actions">
                <button
                  type="button"
                  className="source-list__btn"
                  onClick={() => setForm({ id: s.id, name: s.name, category: s.category, tags: s.tags.join(', '), content: s.content })}
                >
                  {t.edit}
                </button>
                <button
                  type="button"
                  className="source-list__btn source-list__btn--danger"
                  onClick={() => setPendingDelete(s)}
                >
                  {t.remove}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {form ? (
        <div className="skills-manager__modal-backdrop" onMouseDown={() => setForm(null)}>
          <div className="skills-manager__modal" onMouseDown={(e) => e.stopPropagation()}>
            <h4 className="skills-manager__modal-title">{form.id ? t.editTitle : t.newTitle}</h4>
            <label className="skills-manager__field">
              <span>{t.nameLabel}</span>
              <input
                type="text"
                className="source-list__url-input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t.namePlaceholder}
              />
            </label>
            <label className="skills-manager__field">
              <span>{t.categoryLabel}</span>
              <select
                className="source-list__url-input"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as 'general' | 'section' })}
              >
                <option value="general">{t.general}</option>
                <option value="section">{t.section}</option>
              </select>
            </label>
            <label className="skills-manager__field">
              <span>{t.tagsLabel}</span>
              <input
                type="text"
                className="source-list__url-input"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder={t.tagsPlaceholder}
              />
            </label>
            <label className="skills-manager__field">
              <span>{t.contentLabel}</span>
              <textarea
                className="skills-manager__textarea"
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder={t.contentPlaceholder}
                rows={12}
              />
            </label>
            <div className="skills-manager__modal-actions">
              <button type="button" className="source-list__btn" onClick={() => setForm(null)} disabled={busy}>{t.cancel}</button>
              <button type="button" className="source-list__btn source-list__btn--primary" onClick={() => void handleSave()} disabled={busy}>
                {busy ? t.saving : t.save}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title={zhCN.common.confirm}
          message={t.removeConfirm.replace('{name}', pendingDelete.name)}
          confirmText={t.remove}
          danger
          busy={busy}
          onConfirm={() => void handleDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  )
}

export default SkillsManager
