import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { zhCN } from '../i18n/zh-CN'

/**
 * 极简行内 Markdown 渲染（Phase 7.3）：只处理段落正文里常见的 `**加粗**`，
 * 其余按纯文本渲染。资料汇编的段落是志书散文，含复杂 Markdown 的概率很低；
 * 若将来确实需要完整 Markdown（表格/引用/列表），再按调研结论接入 react-markdown + remark-gfm。
 */
function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = (text ?? '').split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>
    }
    return part
  })
}

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
  /* ---- Phase 7.4：版本管控 ---- */
  /** 版本列表（含变更统计）；长度 ≤1 时不显示版本控件 */
  versions?: CompilationVersionView[]
  /** 对比基线版本号（null = 不对比，显示当前文档） */
  compareFrom?: number | null
  /** 基线 → 当前 的差异段（compareFrom != null 时由主进程算好） */
  versionDiff?: CompilationVersionDiffView | null
  /** 仅显示改动段落 */
  onlyChanged?: boolean
  onSelectVersion?: (versionNo: number | null) => void
  onRestoreVersion?: (versionNo: number) => void
  onToggleOnlyChanged?: (value: boolean) => void
}

export interface CompilationVersionView {
  versionNo: number
  origin: 'generate' | 'llm-edit' | 'user-edit' | 'restore' | 'contradiction' | 'import'
  instruction?: string
  reply?: string
  changeSummary: { added: number; removed: number; modified: number; moved: number }
  createdAt: string
}

export interface CompilationVersionDiffView {
  fromVersionNo: number
  toVersionNo: number
  segments: {
    kind: 'added' | 'removed' | 'modified' | 'unchanged'
    id: string
    prevText?: string
    nextText?: string
    inline?: { type: 'same' | 'add' | 'del'; text: string }[]
  }[]
  summary: { added: number; removed: number; modified: number; unchanged: number }
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
  redoAvailable,
  versions,
  compareFrom,
  versionDiff,
  onlyChanged,
  onSelectVersion,
  onRestoreVersion,
  onToggleOnlyChanged
}: Props) {
  const t = zhCN.compilation
  /** 差异段按段 id 建索引（渲染时给段落上色 / 段内高亮） */
  const diffById = new Map((versionDiff?.segments ?? []).map((s) => [s.id, s]))
  const removedSegments = (versionDiff?.segments ?? []).filter((s) => s.kind === 'removed')
  const originLabel = (origin: CompilationVersionView['origin']): string =>
    ({
      generate: t.versionOriginGenerate,
      'llm-edit': t.versionOriginLlmEdit,
      'user-edit': t.versionOriginUserEdit,
      restore: t.versionOriginRestore,
      contradiction: t.versionOriginContradiction,
      import: t.versionOriginImport
    })[origin]
  const [editing, setEditing] = useState<CompilationItemView | null>(null)
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')
  const [excerpt, setExcerpt] = useState('')
  const [ts, setTs] = useState('')
  /** 当前悬停的段落 id（悬停才显示段级操作，保持"连续文档"观感） */
  const [hoverId, setHoverId] = useState<string | null>(null)
  /** 当前打开「来源小卡」的来源编号（点击段尾圆标） */
  const [sourceCardFor, setSourceCardFor] = useState<number | null>(null)
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
        <span className="compilation-stat">{t.docStats.replace('{paragraphs}', String(keptItems.length)).replace('{sources}', String(sourceCount))}</span>
        {versionDiff ? (
          <>
            <span className="compilation-stat is-diff">
              {t.versionDiffSummary
                .replace('{added}', String(versionDiff.summary.added))
                .replace('{modified}', String(versionDiff.summary.modified))
                .replace('{removed}', String(versionDiff.summary.removed))}
            </span>
            <label className="compilation-diff-toggle">
              <input
                type="checkbox"
                checked={onlyChanged === true}
                onChange={(e) => onToggleOnlyChanged?.(e.target.checked)}
              />
              <span>{t.versionOnlyChanged}</span>
            </label>
          </>
        ) : null}
        {candidateChunks ? <span className="compilation-stat">{t.candidate.replace('{chunks}', String(candidateChunks))}</span> : null}
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
          {/* Phase 7.4：版本管控 —— 选历史版本进入对比模式、上一版/下一版、恢复到该版本 */}
          {versions && versions.length > 1 ? (
            <>
              <button
                type="button"
                className="compilation-round-btn"
                disabled={busy || (compareFrom ?? versions[versions.length - 1].versionNo) <= versions[0].versionNo}
                title={t.versionPrev}
                aria-label={t.versionPrev}
                onClick={() => {
                  const cur = compareFrom ?? versions[versions.length - 1].versionNo
                  const idx = versions.findIndex((v) => v.versionNo === cur)
                  const prev = versions[Math.max(0, idx - 1)]
                  onSelectVersion?.(prev.versionNo === versions[versions.length - 1].versionNo ? null : prev.versionNo)
                }}
              >
                ←
              </button>
              <select
                className="compilation-version-select"
                value={String(compareFrom ?? versions[versions.length - 1].versionNo)}
                disabled={busy}
                onChange={(e) => {
                  const no = Number(e.target.value)
                  onSelectVersion?.(no === versions[versions.length - 1].versionNo ? null : no)
                }}
              >
                {versions.map((v) => (
                  <option key={v.versionNo} value={String(v.versionNo)}>
                    {t.versionOption
                      .replace('{no}', String(v.versionNo))
                      .replace('{origin}', originLabel(v.origin))
                      .replace('{added}', String(v.changeSummary.added))
                      .replace('{modified}', String(v.changeSummary.modified))
                      .replace('{removed}', String(v.changeSummary.removed))}
                  </option>
                ))}
              </select>
              {compareFrom != null ? (
                <button
                  type="button"
                  className="source-list__btn"
                  disabled={busy}
                  onClick={() => onRestoreVersion?.(compareFrom)}
                >
                  {t.versionRestore.replace('{no}', String(compareFrom))}
                </button>
              ) : null}
            </>
          ) : null}
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

      {/* Phase 7.3：右栏由「卡片列表」改为**连续文档查看器**——段首时间徽标 + 正文 + 段尾来源圆标，
          按年份分节（用户裁定 D4）；段落悬停才显示段级操作，避免把连续文本切成一格格卡片。 */}
      <div className="compilation-doc" ref={cardsRef}>
        {keptItems.length === 0 ? (
          <div className="compilation-empty">{t.emptyDoc}</div>
        ) : (
          keptItems.map((it, index) => {
            const fix = repairForItem(it.id)
            const year = it.year ?? null
            const prevYear = index > 0 ? (keptItems[index - 1].year ?? null) : null
            const pendingTime = (it.timeConfidence ?? (it.year != null ? 'exact' : 'unknown')) === 'unknown'
            const diff = diffById.get(it.id)
            if (onlyChanged === true && versionDiff && (!diff || diff.kind === 'unchanged')) {
              return null
            }
            return (
              <Fragment key={it.id}>
                {year != null && year !== prevYear ? (
                  <h3 className="compilation-doc__year">{t.yearHeading.replace('{year}', String(year))}</h3>
                ) : null}
                <div
                  data-card-id={it.id}
                  className={cls(
                    'compilation-para',
                    conflictForItem(it.id) ? 'has-conflict' : '',
                    fix ? 'is-repair' : '',
                    locatedId === it.id ? 'is-located' : '',
                    /* Phase 7.4：对比模式下的差异标记 */
                    diff ? 'diff-' + diff.kind : ''
                  )}
                  onMouseEnter={() => setHoverId(it.id)}
                  onMouseLeave={() => setHoverId((cur) => (cur === it.id ? null : cur))}
                >
                  <span className={cls('compilation-doc__time', pendingTime ? 'is-pending' : '')}>
                    {it.ts ?? t.noTime}
                    {pendingTime ? t.pendingYearSuffix : ''}
                  </span>
                  <span className="compilation-doc__text">
                    {diff?.kind === 'modified' && diff.inline
                      ? diff.inline.map((part, i) =>
                          part.type === 'same' ? (
                            <span key={i}>{part.text}</span>
                          ) : part.type === 'del' ? (
                            <del key={i} className="diff-del">{part.text}</del>
                          ) : (
                            <ins key={i} className="diff-add">{part.text}</ins>
                          )
                        )
                      : renderInlineMarkdown(it.excerpt)}
                  </span>
                  {it.sourceOrdinal != null ? (
                    <button
                      type="button"
                      className="compilation-src-badge"
                      aria-label={t.sourceBadgeTitle.replace('{n}', String(it.sourceOrdinal))}
                      onClick={() => setSourceCardFor(it.sourceOrdinal ?? null)}
                      onMouseEnter={(e) => showHint(e.currentTarget, t.sourceBadgeTitle.replace('{n}', String(it.sourceOrdinal)))}
                      onMouseLeave={() => setHint(null)}
                    >
                      {it.sourceOrdinal}
                    </button>
                  ) : null}
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
                  {hoverId === it.id ? (
                    <span className="compilation-para__actions">
                      <button type="button" onClick={() => startEdit(it)}>{t.edit}</button>
                      <button type="button" className="is-danger" onClick={() => onDeleteItem(it.id)}>{t.delete}</button>
                    </span>
                  ) : null}
                </div>
              </Fragment>
            )
          })
        )}
        {/* 对比模式下：被删除的段落以红色划线占位列出（保留在文档末尾，便于用户判断丢掉了什么） */}
        {versionDiff && removedSegments.length > 0
          ? removedSegments.map((s) => (
              <div key={s.id} className="compilation-para diff-removed">
                <span className="compilation-doc__time">{t.versionRemovedTag}</span>
                <span className="compilation-doc__text">
                  <del className="diff-del">{s.prevText}</del>
                </span>
              </div>
            ))
          : null}
      </div>

      {/* 来源小卡：点段尾圆标弹出（来源标题 / 该来源在本汇编中的全部段落 / 打开原文） */}
      {sourceCardFor != null ? (
        <div className="skills-manager__modal-backdrop" onMouseDown={() => setSourceCardFor(null)}>
          <div className="skills-manager__modal compilation-source-card" onMouseDown={(e) => e.stopPropagation()}>
            <h4 className="skills-manager__modal-title">
              {t.sourceCardTitle.replace('{n}', String(sourceCardFor))}
              {(() => {
                const title = keptItems.find((x) => x.sourceOrdinal === sourceCardFor)?.sourceTitle
                return title ? ' 《' + title + '》' : ''
              })()}
            </h4>
            <div className="compilation-source-card__list">
              {keptItems
                .filter((x) => x.sourceOrdinal === sourceCardFor)
                .map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    className="compilation-source-card__item"
                    onClick={() => {
                      setSourceCardFor(null)
                      locateItem(x.id)
                    }}
                  >
                    <span className="compilation-doc__time">{x.ts ?? t.noTime}</span>
                    <span>{x.excerpt.replace(/\s+/g, ' ').slice(0, 60)}</span>
                  </button>
                ))}
            </div>
            <div className="skills-manager__modal-actions">
              <button type="button" className="source-list__btn" onClick={() => setSourceCardFor(null)}>{t.cancel}</button>
              <button
                type="button"
                className="source-list__btn source-list__btn--primary"
                onClick={() => {
                  const item = keptItems.find((x) => x.sourceOrdinal === sourceCardFor)
                  setSourceCardFor(null)
                  if (item) onOpenSource(item.sourceId)
                }}
              >
                {t.openSource}
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
