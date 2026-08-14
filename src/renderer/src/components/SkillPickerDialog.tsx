import { useState } from 'react'
import { zhCN } from '../i18n/zh-CN'

export interface PickerSkillOption {
  id: string
  name: string
  tags?: string[]
}

interface SkillPickerDialogProps {
  skills: PickerSkillOption[]
  /** 打开弹窗时已选中的规范 id（用于预勾选） */
  selectedIds: string[]
  onConfirm: (ids: string[]) => void
  onCancel: () => void
}

/** 名称/关键词模糊匹配：完整子串优先，其次名称逐字子序列（允许中间缺字） */
function fuzzyMatch(skill: PickerSkillOption, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const name = skill.name.toLowerCase()
  const tags = (skill.tags ?? []).join(' ').toLowerCase()
  if (name.includes(q) || tags.includes(q)) return true
  const isSubsequence = (haystack: string): boolean => {
    let i = 0
    for (const ch of haystack) {
      if (ch === q[i]) i++
      if (i === q.length) return true
    }
    return false
  }
  return isSubsequence(name) || isSubsequence(tags)
}

/**
 * 手动选择写作规范弹窗（2026-08-14）：悬浮窗内搜索 + 多选部类细则规范，确认后写回任务。
 */
function SkillPickerDialog({ skills, selectedIds, onConfirm, onCancel }: SkillPickerDialogProps) {
  const t = zhCN.skillPicker
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set(selectedIds))

  const filtered = skills.filter((s) => fuzzyMatch(s, search))

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="skill-picker__backdrop" onMouseDown={onCancel}>
      <div className="skill-picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="skill-picker__head">
          <h4 className="skill-picker__title">{t.title}</h4>
          <button type="button" className="skill-picker__close" aria-label={t.cancel} onClick={onCancel}>×</button>
        </div>
        <input
          type="text"
          className="source-list__url-input skill-picker__search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.searchPlaceholder}
          autoFocus
        />
        <div className="skill-picker__list">
          {filtered.length === 0 ? (
            <p className="source-list__status">{t.noMatch}</p>
          ) : (
            filtered.map((s) => {
              const checked = picked.has(s.id)
              return (
                <label key={s.id} className={`skill-picker__item${checked ? ' skill-picker__item--checked' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(s.id)} />
                  <span className="skill-picker__name">{s.name}</span>
                  {s.tags && s.tags.length > 0 ? (
                    <span className="skill-picker__tags">{s.tags.join('、')}</span>
                  ) : null}
                </label>
              )
            })
          )}
        </div>
        <div className="skill-picker__actions">
          <span className="skill-picker__count">{t.selected.replace('{count}', String(picked.size))}</span>
          <button type="button" className="source-list__btn" onClick={onCancel}>{t.cancel}</button>
          <button type="button" className="source-list__btn source-list__btn--primary" onClick={() => onConfirm(Array.from(picked))}>
            {t.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}

export default SkillPickerDialog
