import { useState, useEffect, useCallback, type ReactNode } from 'react'
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

/** 拼接 className（替代模板字符串，避免嵌套转义） */
const cls = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ')

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

/** 规范页区块（与中栏导航一致；scroll-spy 观察对象，元素 id 为 skills-<id>） */
const SKILL_SECTIONS = ['overview', 'general', 'section'] as const

interface SkillsManagerProps {
  /** 滚动定位（scroll-spy）回调：当前视口内最靠上的区块 id（供中栏导航高亮） */
  onActiveChange?: (id: string) => void
}

const GENERAL_ICON: ReactNode = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
)

const SECTION_ICON: ReactNode = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 6h13" />
    <path d="M8 12h13" />
    <path d="M8 18h13" />
    <path d="M3 6h.01" />
    <path d="M3 12h.01" />
    <path d="M3 18h.01" />
  </svg>
)

const SEARCH_ICON: ReactNode = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
)

/**
 * 写作规范（skills）管理页（2026-08-13 由「范本」重构；2026-08-19 与设置页统一风格）：
 * 总览卡 + 搜索工具栏 + 通用规范/部类细则两张卡片式区块；支持新建、编辑、删除。
 */
function SkillsManager({ onActiveChange }: SkillsManagerProps) {
  const t = zhCN.skills
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [form, setForm] = useState<SkillFormState | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<SkillItem | null>(null)
  const [search, setSearch] = useState('')

  const searching = search.trim().length > 0
  const generalSkills = skills.filter((s) => s.category === 'general')
  const sectionSkills = skills.filter((s) => s.category === 'section')
  const presetCount = skills.filter((s) => s.isPreset).length
  const filteredGeneral = generalSkills.filter((s) => fuzzyMatch(s, search))
  const filteredSection = sectionSkills.filter((s) => fuzzyMatch(s, search))

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

  // scroll-spy：观察各区块，视口内最靠上的区块上报给中栏导航高亮（2026-08-19）
  useEffect(() => {
    if (!onActiveChange) return
    const els = SKILL_SECTIONS.map((id) => document.getElementById('skills-' + id)).filter(
      (el): el is HTMLElement => el !== null
    )
    if (els.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length === 0) return
        const top = visible.reduce((a, b) => (a.boundingClientRect.top <= b.boundingClientRect.top ? a : b))
        const id = (top.target as HTMLElement).id.replace(/^skills-/, '')
        onActiveChange(id)
      },
      { rootMargin: '-15% 0px -65% 0px', threshold: 0 }
    )
    els.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [onActiveChange])

  const startCreate = () => setForm({ name: '', category: 'section', tags: '', content: '' })
  const startEdit = (s: SkillItem) =>
    setForm({ id: s.id, name: s.name, category: s.category, tags: s.tags.join(', '), content: s.content })

  const handleSave = async () => {
    if (!form || busy) return
    const name = form.name.trim()
    const content = form.content.trim()
    if (!name || !content) { setErr(t.emptyFields); return }
    const tags = form.tags.split(/[,，、s]+/).map((s) => s.trim()).filter(Boolean)
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

  const renderSection = (
    id: 'general' | 'section',
    title: string,
    hint: string,
    icon: ReactNode,
    items: SkillItem[],
    emptyText: string
  ): ReactNode => (
    <section className="skills-manager__section" id={'skills-' + id}>
      <div className="skills-manager__section-header">
        <span className={cls('skills-manager__section-icon', 'skills-manager__section-icon--' + id)} aria-hidden="true">
          {icon}
        </span>
        <div className="skills-manager__section-titlewrap">
          <h4 className="skills-manager__section-title">{title}</h4>
          <p className="skills-manager__section-hint">{hint}</p>
        </div>
        <span className="skills-manager__count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="skills-manager__section-empty">{emptyText}</p>
      ) : (
        <ul className="skills-manager__list">
          {items.map((s) => (
            <li key={s.id} className="skills-manager__item">
              <div className="skills-manager__item-head">
                <span className="skills-manager__item-avatar" aria-hidden="true">{s.name.charAt(0)}</span>
                <span className="skills-manager__item-name">{s.name}</span>
                <span className={cls('skills-manager__badge', 'skills-manager__badge--' + s.category)}>
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
                <button type="button" className="source-list__btn" onClick={() => startEdit(s)}>
                  {t.edit}
                </button>
                <button type="button" className="source-list__btn source-list__btn--danger" onClick={() => setPendingDelete(s)}>
                  {t.remove}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )

  return (
    <div className="skills-manager" data-onboarding="skills">
      <div className="skills-manager__head">
        <h3 className="skills-manager__title">{t.title}</h3>
      </div>

      {err ? <p className="source-list__error">{err}</p> : null}

      {/* 总览卡（2026-08-19）：统计速览 + 新建入口 */}
      <section className="skills-overview" id="skills-overview">
        <div>
          <h4 className="skills-overview__title">{t.overview.title}</h4>
          <p className="skills-overview__hint">{t.overview.hint}</p>
        </div>
        <div className="skills-overview__chips">
          <span className="skills-overview__chip">{t.overview.generalCount.replace('{count}', String(generalSkills.length))}</span>
          <span className="skills-overview__chip">{t.overview.sectionCount.replace('{count}', String(sectionSkills.length))}</span>
          <span className="skills-overview__chip">{t.overview.presetCount.replace('{count}', String(presetCount))}</span>
        </div>
        <div className="skills-overview__actions">
          <button type="button" className="source-list__btn" onClick={startCreate}>
            {t.newBtn}
          </button>
        </div>
      </section>

      {/* 搜索工具栏 */}
      <div className="skills-manager__toolbar">
        <span className="skills-manager__search-icon" aria-hidden="true">{SEARCH_ICON}</span>
        <input
          type="text"
          className="source-list__url-input skills-manager__search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.searchPlaceholder}
        />
        {search ? (
          <button type="button" className="skills-manager__clear" title={t.searchClear} onClick={() => setSearch('')}>
            ×
          </button>
        ) : null}
      </div>

      {loading ? (
        <p className="source-list__status source-list__status--loading">
          <span className="spinner" aria-hidden="true" />
          {t.loading}
        </p>
      ) : skills.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state__hint">{t.empty}</p>
          <button type="button" className="source-list__btn source-list__btn--primary" onClick={startCreate}>
            {t.newBtn}
          </button>
        </div>
      ) : (
        <>
          {renderSection('general', t.nav.general, t.generalHint, GENERAL_ICON, filteredGeneral, searching ? t.noMatch : t.noGeneral)}
          {renderSection('section', t.nav.section, t.sectionHint, SECTION_ICON, filteredSection, searching ? t.noMatch : t.noSection)}
        </>
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
