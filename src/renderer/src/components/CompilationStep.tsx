import { useState } from 'react'
import { zhCN } from '../i18n/zh-CN'

export interface CompilationItemView {
  id: string
  compilationId: string
  position: number
  sourceId: string
  excerpt: string
  ts?: string
  note?: string
  extraTags: string[]
  kept: boolean
  sourceTitle?: string
  createdAt: string
}

export interface CompilationRepairView {
  id: string
  compilationId: string
  itemId: string
  originalText: string
  revisedText: string
  reason: string
  status: 'pending' | 'accepted' | 'rejected'
  createdAt: string
  updatedAt: string
}

export interface CompilationVariantView {
  id: string
  contradictionId: string
  itemId: string
  variantText: string
  sourceId: string
  sourceTitle?: string
  createdAt: string
}

export interface CompilationContradictionView {
  id: string
  compilationId: string
  topic: string
  kind: 'data' | 'time' | 'place' | 'fact' | 'other'
  status: 'pending' | 'resolved' | 'ignored'
  chosenItemId?: string
  createdAt: string
  variants: CompilationVariantView[]
}

export interface CompilationView {
  id: string
  taskId: string
  title: string
  status: 'drafting' | 'reviewing' | 'finalized'
  createdAt: string
  updatedAt: string
  items: CompilationItemView[]
  contradictions: CompilationContradictionView[]
  repairs?: CompilationRepairView[]
}

interface Props {
  compilation: CompilationView | null
  busy: boolean
  candidateChunks?: number
  onRegenerate: () => void
  onConfirm: () => void
  onOpenSource: (sourceId: string) => void
  onUpdateItem: (itemId: string, patch: { excerpt?: string; ts?: string | null; note?: string | null }) => void
  onDeleteItem: (itemId: string) => void
  onResolve: (contradictionId: string, action: 'resolve' | 'ignore', chosenItemId?: string) => void
  onDecideRepair: (repairId: string, action: 'accept' | 'reject') => void
}

const cls = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ')

/** Step 1：资料汇编卡片审阅 */
function CompilationStep({
  compilation,
  busy,
  candidateChunks,
  onRegenerate,
  onConfirm,
  onOpenSource,
  onUpdateItem,
  onDeleteItem,
  onResolve,
  onDecideRepair
}: Props) {
  const t = zhCN.compilation
  const [editing, setEditing] = useState<CompilationItemView | null>(null)
  const [excerpt, setExcerpt] = useState('')
  const [ts, setTs] = useState('')
  /** 当前展开“…”菜单的卡片 id（一次只展开一张） */
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /** 矛盾窗口是否展开（默认展开，可收起） */
  const [contradictionsOpen, setContradictionsOpen] = useState(true)

  const pending = compilation?.contradictions.filter((c) => c.status === 'pending') ?? []
  // 只展示未被软删除（采纳后未恢复）的卡片
  const keptItems = (compilation?.items ?? []).filter((it) => it.kept !== false)

  const startEdit = (it: CompilationItemView): void => {
    setEditing(it)
    setExcerpt(it.excerpt)
    setTs(it.ts ?? '')
  }

  const saveEdit = (): void => {
    if (!editing) return
    onUpdateItem(editing.id, { excerpt: excerpt.trim(), ts: ts.trim() ? ts.trim() : null })
    setEditing(null)
  }

  const conflictForItem = (itemId: string): boolean => pending.some((g) => g.variants.some((v) => v.itemId === itemId))

  /** 待语义补全/已采纳的修订（已拒绝的不再展示比较/按钮） */
  const pendingRepairs = (compilation?.repairs ?? []).filter((r) => r.status === 'pending')
  const repairForItem = (itemId: string): CompilationRepairView | undefined =>
    (compilation?.repairs ?? []).find((r) => r.itemId === itemId && r.status !== 'rejected')

  if (!compilation) {
    return (
      <div className="compilation-empty">
        <p>{t.empty}</p>
      </div>
    )
  }

  return (
    <div className="compilation-step">
      <div className="compilation-toolbar">
        <span className="compilation-stat">{t.cards.replace('{count}', String(keptItems.length))}</span>
        {candidateChunks ? <span className="compilation-stat">{t.candidate.replace('{chunks}', String(candidateChunks))}</span> : null}
        {pendingRepairs.length > 0 ? <span className="compilation-stat">{t.repairPending.replace('{count}', String(pendingRepairs.length))}</span> : null}
        <span className={cls('compilation-badge', pending.length ? 'danger' : 'ok')}>
          {pending.length ? t.pendingContradictions.replace('{count}', String(pending.length)) : t.noContradictions}
        </span>
        <div className="compilation-actions">
          <button type="button" className="source-list__btn" onClick={onRegenerate} disabled={busy}>
            {t.regenerateBtn}
          </button>
          <button
            type="button"
            className="source-list__btn source-list__btn--primary"
            onClick={onConfirm}
            disabled={busy || pending.length > 0}
            title={pending.length > 0 ? t.pendingContradictions.replace('{count}', String(pending.length)) : undefined}
          >
            {t.confirmBtn}
          </button>
        </div>
      </div>

      {pending.length > 0 && contradictionsOpen ? (
        <div className="compilation-contradictions">
          <div className="compilation-contradictions__list">
          {pending.map((g) => (
            <div key={g.id} className="compilation-contradiction">
              <div className="compilation-contradiction-head">
                <b>⚠ {g.topic}</b>
                <span>{t.pending}</span>
              </div>
              <div className="compilation-contradiction-variants">
                {g.variants.map((v) => (
                  <div key={v.id} className="compilation-variant">
                    <div className="compilation-variant-text">{v.variantText}</div>
                    <div className="compilation-variant-src">来源：《{v.sourceTitle ?? v.sourceId}》</div>
                    <button
                      type="button"
                      className="source-list__btn source-list__btn--primary"
                      disabled={busy}
                      onClick={() => onResolve(g.id, 'resolve', v.itemId)}
                    >
                      {t.resolve}
                    </button>
                  </div>
                ))}
                <button type="button" className="source-list__btn" disabled={busy} onClick={() => onResolve(g.id, 'ignore')}>
                  {t.ignore}
                </button>
              </div>
            </div>
          ))}
          </div>
          <div className="compilation-contradictions__footer">
            <button
              type="button"
              className="compilation-collapse-btn"
              title={t.collapse}
              onClick={() => setContradictionsOpen(false)}
            >
              <span aria-hidden="true">▲</span> {t.collapse}
            </button>
          </div>
        </div>
      ) : null}

      {pending.length > 0 && !contradictionsOpen ? (
        <button
          type="button"
          className="compilation-collapse-btn compilation-collapse-btn--bar"
          onClick={() => setContradictionsOpen(true)}
        >
          <span>⚠ {t.pendingContradictions.replace('{count}', String(pending.length))}</span>
          <span aria-hidden="true">▼</span>
        </button>
      ) : null}

      <div className="compilation-cards">
        {keptItems.map((it) => {
          const repair = repairForItem(it.id)
          return (
            <div key={it.id} className={cls('compilation-card', conflictForItem(it.id) ? 'has-conflict' : '', repair ? 'is-repair' : '')}>
              <div className="compilation-card-head">
                <div className="compilation-card-meta">
                  <span className="compilation-chip">{it.ts ?? '无时间'}</span>
                  <span className="compilation-chip">《{it.sourceTitle ?? it.sourceId}》</span>
                  {conflictForItem(it.id) ? <span className="compilation-chip conflict">⚠ {t.contradict}</span> : null}
                  {repair ? <span className="compilation-chip">{t.repairTitle}</span> : null}
                </div>
                <div className="compilation-card-menu">
                  <button
                    type="button"
                    className="compilation-card-menu-btn"
                    aria-label={t.more}

                    onClick={() => setMenuFor((cur) => (cur === it.id ? null : it.id))}
                  >
                    …
                  </button>
                  {menuFor === it.id ? (
                    <div className="compilation-card-menu-dropdown">
                      <button type="button" onClick={() => { onOpenSource(it.sourceId); setMenuFor(null) }}>{t.openSource}</button>
                      <button type="button" onClick={() => { startEdit(it); setMenuFor(null) }}>{t.edit}</button>
                      <button type="button" className="is-danger" onClick={() => { onDeleteItem(it.id); setMenuFor(null) }}>{t.delete}</button>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="compilation-card-text">{it.excerpt}</div>
              {repair ? (
                <div className="compilation-repair">
                  <div className="compilation-repair__label">{t.repairTitle}</div>
                  <div className="compilation-repair__original">{t.repairOriginal}：{repair.originalText}</div>
                  <div className="compilation-repair__revised">{t.repairRevised}：{repair.revisedText}</div>
                  {repair.reason ? <div className="compilation-repair__reason">{t.repairReason}{repair.reason}</div> : null}
                  {repair.status === 'pending' ? (
                    <div className="compilation-repair__actions">
                      <button type="button" className="source-list__btn source-list__btn--primary" disabled={busy} onClick={() => onDecideRepair(repair.id, 'accept')}>{t.repairAdopt}</button>
                      <button type="button" className="source-list__btn" disabled={busy} onClick={() => onDecideRepair(repair.id, 'reject')}>{t.repairReject}</button>
                    </div>
                  ) : repair.status === 'accepted' ? (
                    <div className="compilation-repair__label">{t.repairAccepted}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {editing ? (
        <div className="skills-manager__modal-backdrop" onMouseDown={() => setEditing(null)}>
          <div className="skills-manager__modal" onMouseDown={(e) => e.stopPropagation()}>
            <h4 className="skills-manager__modal-title">{t.editTitle}</h4>
            <label className="skills-manager__field">
              <span>{t.excerptLabel}</span>
              <textarea className="skills-manager__textarea" rows={6} value={excerpt} onChange={(e) => setExcerpt(e.target.value)} />
            </label>
            <label className="skills-manager__field">
              <span>{t.tsLabel}</span>
              <input className="source-list__url-input" value={ts} onChange={(e) => setTs(e.target.value)} />
            </label>
            <div className="skills-manager__modal-actions">
              <button type="button" className="source-list__btn" onClick={() => setEditing(null)}>{t.cancel}</button>
              <button type="button" className="source-list__btn source-list__btn--primary" onClick={saveEdit}>{t.save}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default CompilationStep
