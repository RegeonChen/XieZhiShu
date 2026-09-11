import { useEffect, useRef, useState } from 'react'
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
  /* ---- Phase 7.1：段落元数据（迁移回填 / 后续生成管线填充） ---- */
  /** 结构化年份（由时间标签解析而来，用于稳定排序） */
  year?: number
  month?: number
  /** exact=含年份；inferred=推断；unknown=未能确定（缺年份，界面提示「待补年份」） */
  timeConfidence?: 'exact' | 'inferred' | 'unknown'
  /** 段尾来源圆标数字（指向本汇编的来源编号 1..N） */
  sourceOrdinal?: number
}

export interface CompilationRepairView {
  id: string
  compilationId: string
  itemId: string
  originalText: string
  revisedText: string
  reason: string
  /** applied：修正已应用到卡片（绿色标记）；reverted：用户已回退（灰色标记，可再次应用） */
  status: 'applied' | 'reverted'
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
  onConfirm: () => void
  onOpenSource: (sourceId: string) => void
  onUpdateItem: (itemId: string, patch: { excerpt?: string; ts?: string | null; note?: string | null }) => void
  onDeleteItem: (itemId: string) => void
  onResolve: (contradictionId: string, action: 'resolve' | 'ignore', chosenItemId?: string) => void
  /** 回退（applied=true 时）或再次应用（applied=false 时）一条大模型修正 */
  onDecideRepair: (repairId: string, applied: boolean) => void
  onReorderItems: (direction: 'asc' | 'desc') => void
  onUndo: () => void
  onRedo: () => void
  undoAvailable: number
  redoAvailable: number
}

const cls = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ')

/** Step 1：资料汇编卡片审阅 */
function CompilationStep({
  compilation,
  busy,
  candidateChunks,
  onConfirm,
  onOpenSource,
  onUpdateItem,
  onDeleteItem,
  onResolve,
  onDecideRepair,
  onReorderItems,
  onUndo,
  onRedo,
  undoAvailable,
  redoAvailable
}: Props) {
  const t = zhCN.compilation
  const [editing, setEditing] = useState<CompilationItemView | null>(null)
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')
  const [excerpt, setExcerpt] = useState('')
  const [ts, setTs] = useState('')
  /** 当前展开“…”菜单的卡片 id（一次只展开一张） */
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /** 当前展开「修正详情」弹窗的卡片修正记录（一次只看一张） */
  const [fixDetail, setFixDetail] = useState<CompilationRepairView | null>(null)
  /** 矛盾窗口是否展开（默认展开，可收起） */
  const [contradictionsOpen, setContradictionsOpen] = useState(true)
  /** 刚被「定位到该段」命中的卡片（短暂高亮，便于用户在下方列表中找到） */
  const [locatedId, setLocatedId] = useState<string | null>(null)
  /** 定位失败提示（该说法对应的卡片已不在当前列表中） */
  const [locateMiss, setLocateMiss] = useState(false)
  /** 下方资料卡片列表容器（定位时在其内部滚动） */
  const cardsRef = useRef<HTMLDivElement | null>(null)
  const locateTimerRef = useRef<number | null>(null)
  const missTimerRef = useRef<number | null>(null)
  /**
   * 自绘提示气泡（Phase 7.1 验收展示）：原生 `title` 在本应用的滚动容器里不可靠
   * （卡片列表是滚动容器，浏览器原生 tooltip 出现慢且用户在长列表里很难命中 18px 的小圆标），
   * 故用一个 `position: fixed` 的气泡：瞬时出现、不会被滚动容器裁剪。
   */
  const [hint, setHint] = useState<{ x: number; y: number; text: string } | null>(null)
  const showHint = (el: HTMLElement, text: string): void => {
    const r = el.getBoundingClientRect()
    setHint({ x: r.left + r.width / 2, y: r.top, text })
  }

  useEffect(
    () => () => {
      if (locateTimerRef.current !== null) window.clearTimeout(locateTimerRef.current)
      if (missTimerRef.current !== null) window.clearTimeout(missTimerRef.current)
    },
    []
  )

  const pending = compilation?.contradictions.filter((c) => c.status === 'pending') ?? []
  // 只展示未被软删除（采纳后未恢复）的卡片
  const keptItems = (compilation?.items ?? []).filter((it) => it.kept !== false)
  /**
   * Phase 7.1 验收用（7.3 由正式查看器取代）：把迁移回填的段落元数据显示出来——
   * 本汇编的来源编号数量、缺年份（时间待核）的段落数，以及每张卡片所属的来源编号。
   */
  const sourceCount = new Set(keptItems.map((it) => it.sourceOrdinal).filter((n): n is number => n != null)).size
  const pendingTimeCount = keptItems.filter((it) => (it.timeConfidence ?? (it.year != null ? 'exact' : 'unknown')) === 'unknown').length

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

  /**
   * 「定位到该段」：滚动下方资料卡片列表到矛盾说法对应的卡片并短暂高亮，便于用户直接编辑。
   * 卡片不在当前列表（已被删除 / 已随矛盾取舍被排除）时给出明确提示，而不是静默无反应。
   */
  const locateItem = (itemId: string): void => {
    if (missTimerRef.current !== null) window.clearTimeout(missTimerRef.current)
    if (!keptItems.some((it) => it.id === itemId)) {
      setLocateMiss(true)
      missTimerRef.current = window.setTimeout(() => setLocateMiss(false), 3000)
      return
    }
    setLocateMiss(false)
    setLocatedId(itemId)
    // 等 React 把高亮类渲染到卡片上再滚动，避免目标元素尚未更新导致定位偏移
    window.requestAnimationFrame(() => {
      const el = cardsRef.current?.querySelector<HTMLElement>(`[data-card-id="${itemId}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    if (locateTimerRef.current !== null) window.clearTimeout(locateTimerRef.current)
    locateTimerRef.current = window.setTimeout(() => setLocatedId(null), 1800)
  }

  /** 大模型修正记录（应用于该卡片；回退后仍有记录，标记转为灰色） */
  const appliedFixes = (compilation?.repairs ?? []).filter((r) => r.status === 'applied')
  const repairForItem = (itemId: string): CompilationRepairView | undefined =>
    (compilation?.repairs ?? []).find((r) => r.itemId === itemId)

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
        {sourceCount > 0 ? <span className="compilation-stat">{t.sourcesStat.replace('{count}', String(sourceCount))}</span> : null}
        {pendingTimeCount > 0 ? (
          <span
            className="compilation-stat is-warn"
            onMouseEnter={(e) => showHint(e.currentTarget, t.pendingTimeHint)}
            onMouseLeave={() => setHint(null)}
          >
            {t.pendingTimeStat.replace('{count}', String(pendingTimeCount))}
          </span>
        ) : null}
        {appliedFixes.length > 0 ? <span className="compilation-stat">{t.repairAppliedCount.replace('{count}', String(appliedFixes.length))}</span> : null}
        <span className={cls('compilation-badge', pending.length ? 'danger' : 'ok')}>
          {pending.length ? t.pendingContradictions.replace('{count}', String(pending.length)) : t.noContradictions}
        </span>
        <div className="compilation-actions">
          <button
            type="button"
            className="compilation-round-btn"
            disabled={busy || undoAvailable <= 0}
            title={t.undo}
            aria-label={t.undo}
            onClick={onUndo}
          >
            &#8630;
          </button>
          <button
            type="button"
            className="compilation-round-btn"
            disabled={busy || redoAvailable <= 0}
            title={t.redo}
            aria-label={t.redo}
            onClick={onRedo}
          >
            &#8631;
          </button>
          <button
            type="button"
            className="compilation-round-btn"
            disabled={busy}
            title={sortOrder === 'asc' ? t.sortAsc : t.sortDesc}
            aria-label={sortOrder === 'asc' ? t.sortAsc : t.sortDesc}
            onClick={() => {
              onReorderItems(sortOrder)
              setSortOrder((cur) => (cur === 'asc' ? 'desc' : 'asc'))
            }}
          >
            {sortOrder === 'asc' ? '↑' : '↓'}
          </button>
          <button
            type="button"
            className="source-list__btn source-list__btn--primary"
            onClick={onConfirm}
            disabled={busy || pending.length > 0}
            title={pending.length > 0 ? t.pendingContradictions.replace('{count}', String(pending.length)) : undefined}
          >
            {t.exportBtn}
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
                    <div className="compilation-variant-actions">
                      <button
                        type="button"
                        className="source-list__btn compilation-variant-locate"
                        title={t.locateHint}
                        onClick={() => locateItem(v.itemId)}
                      >
                        {t.locate}
                      </button>
                      <button
                        type="button"
                        className="source-list__btn source-list__btn--primary"
                        disabled={busy}
                        onClick={() => onResolve(g.id, 'resolve', v.itemId)}
                      >
                        {t.resolve}
                      </button>
                    </div>
                  </div>
                ))}
                <button type="button" className="source-list__btn" disabled={busy} onClick={() => onResolve(g.id, 'ignore')}>
                  {t.ignore}
                </button>
              </div>
            </div>
          ))}
          </div>
          {locateMiss ? <div className="compilation-variant-hint">{t.locateMissing}</div> : null}
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

      <div className="compilation-cards" ref={cardsRef}>
        {keptItems.map((it) => {
          const fix = repairForItem(it.id)
          return (
            <div
              key={it.id}
              data-card-id={it.id}
              className={cls(
                'compilation-card',
                conflictForItem(it.id) ? 'has-conflict' : '',
                fix ? 'is-repair' : '',
                locatedId === it.id ? 'is-located' : ''
              )}
            >
              <div className="compilation-card-head">
                <div className="compilation-card-meta">
                  {it.sourceOrdinal != null ? (
                    /* Phase 7.3 第一步（用户明确要求）：段尾来源圆标**可点击** → 直接打开该来源原文。
                       正式版会在查看器里改为弹出「来源小卡（标题 / 该来源在本汇编中的全部段落 / 打开原文）」。 */
                    <button
                      type="button"
                      className="compilation-src-badge"
                      aria-label={t.sourceBadgeTitle.replace('{n}', String(it.sourceOrdinal))}
                      onClick={() => onOpenSource(it.sourceId)}
                      onMouseEnter={(e) => showHint(e.currentTarget, t.sourceBadgeTitle.replace('{n}', String(it.sourceOrdinal)))}
                      onMouseLeave={() => setHint(null)}
                    >
                      {it.sourceOrdinal}
                    </button>
                  ) : null}
                  <span className={cls('compilation-chip', (it.timeConfidence ?? (it.year != null ? 'exact' : 'unknown')) === 'unknown' ? 'is-pending' : '')}>
                    {it.ts ?? t.noTime}
                    {(it.timeConfidence ?? (it.year != null ? 'exact' : 'unknown')) === 'unknown' ? t.pendingYearSuffix : ''}
                  </span>
                  <span className="compilation-chip">《{it.sourceTitle ?? it.sourceId}》</span>
                  {conflictForItem(it.id) ? <span className="compilation-chip conflict">⚠ {t.contradict}</span> : null}
                  {fix ? (
                    <button
                      type="button"
                      className={cls('compilation-chip', 'compilation-chip--fix', fix.status === 'reverted' ? 'is-reverted' : '')}
                      title={t.repairBadgeHint}
                      aria-label={t.repairBadgeHint}
                      onClick={() => setFixDetail(fix)}
                    >
                      {fix.status === 'applied' ? t.repairBadge : t.repairBadgeReverted}
                    </button>
                  ) : null}
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
                      {fix ? <button type="button" onClick={() => { setFixDetail(fix); setMenuFor(null) }}>{t.repairDetail}</button> : null}
                      <button type="button" onClick={() => { startEdit(it); setMenuFor(null) }}>{t.edit}</button>
                      <button type="button" className="is-danger" onClick={() => { onDeleteItem(it.id); setMenuFor(null) }}>{t.delete}</button>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="compilation-card-text">{it.excerpt}</div>
            </div>
          )
        })}
      </div>

      {fixDetail ? (
        <div className="skills-manager__modal-backdrop" onMouseDown={() => setFixDetail(null)}>
          <div className="skills-manager__modal compilation-fix-modal" onMouseDown={(e) => e.stopPropagation()}>
            <h4 className="skills-manager__modal-title">{t.repairDialogTitle}</h4>
            <div className={cls('compilation-fix-status', fixDetail.status === 'reverted' ? 'is-reverted' : '')}>
              {fixDetail.status === 'applied' ? t.repairBadge : t.repairBadgeReverted}
            </div>
            <div className="compilation-fix-block">
              <div className="compilation-fix-label">{t.repairOriginalLabel}</div>
              <div className="compilation-fix-original">{fixDetail.originalText}</div>
            </div>
            {fixDetail.revisedText && fixDetail.revisedText !== fixDetail.originalText ? (
              <div className="compilation-fix-block">
                <div className="compilation-fix-label">{t.repairRevisedLabel}</div>
                <div className="compilation-fix-revised">{fixDetail.revisedText}</div>
              </div>
            ) : null}
            {fixDetail.reason ? (
              <div className="compilation-fix-block">
                <div className="compilation-fix-label">{t.repairReason}</div>
                <div className="compilation-fix-reason">{fixDetail.reason}</div>
              </div>
            ) : null}
            <p className="compilation-fix-note">{t.repairRevertHint}</p>
            <div className="skills-manager__modal-actions">
              <button type="button" className="source-list__btn" disabled={busy} onClick={() => setFixDetail(null)}>{t.cancel}</button>
              <button
                type="button"
                className={cls('source-list__btn', fixDetail.status === 'applied' ? '' : 'source-list__btn--primary')}
                disabled={busy}
                onClick={() => { onDecideRepair(fixDetail.id, fixDetail.status !== 'applied'); setFixDetail(null) }}
              >
                {fixDetail.status === 'applied' ? t.repairRevert : t.repairReapply}
              </button>
            </div>
          </div>
        </div>
      ) : null}

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

      {/* 自绘提示气泡：fixed 定位，不受卡片列表滚动容器裁剪（原生 title 在长滚动列表里不可靠） */}
      {hint ? (
        <div className="compilation-hint" style={{ left: hint.x, top: hint.y - 10 }} role="tooltip">
          {hint.text}
        </div>
      ) : null}
    </div>
  )
}

export default CompilationStep
