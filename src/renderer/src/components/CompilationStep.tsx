import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { zhCN } from '../i18n/zh-CN'
import { locateAnchorForItem, type ItemAnchorView, type SourceLocateAnchor } from '../lib/source-locate'
import ChatPanel, { type ChatMessageItem, type SourceRefItem } from './ChatPanel'

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
  /**
   * 并列来源编号 / 标题（Phase 7.12）：同一件事被多个来源分别收录、合并为一段时的**其它出处**。
   * 与 `alsoSourceTitles` 一一对应；不含主来源 `sourceOrdinal`。
   */
  alsoSourceOrdinals?: number[]
  alsoSourceTitles?: string[]
  /** 与 `alsoSourceOrdinals` 一一对应的来源 id（Phase 9 / S1：并列圆标据此直接打开对应来源） */
  alsoSourceIds?: string[]
  /**
   * 该段的原文证据引文（Phase 9 / S4 起**只**用于「查看本地快照」里高亮该句），
   * 定位本身已改由上面的 `anchors` 决定，不再拿它去全文检索。
   */
  evidence?: string
  /**
   * 该段的来源定位锚点（Phase 9 / S4）：块号 + 页码，由主进程 JOIN `source_blocks` 填充。
   * 老汇编为空 → 界面如实显示"未记录来源位置"（用户裁定 Q4）。
   */
  anchors?: ItemAnchorView[]
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
}

interface Props {
  compilation: CompilationView | null
  busy: boolean
  candidateChunks?: number
  onConfirm: () => void
  /**
   * 打开来源（Phase 9 / S4）：第二个参数是**定位锚**——只报"第 P 页 / 第 N 段 / 未记录来源位置"
   * （由生成期锚点给出，不做句子级检索）；第三个参数是「查看本地快照」弹窗里要高亮的引文。
   */
  onOpenSource: (sourceId: string, locate?: SourceLocateAnchor, snapshotHighlight?: string) => void
  onResolve: (contradictionId: string, action: 'resolve' | 'ignore', chosenItemId?: string) => void
  onReorderItems: (direction: 'asc' | 'desc') => void
  onUndo: () => void
  onRedo: () => void
  undoAvailable: number
  redoAvailable: number
  /* ---- Phase 7.5：版本复核（对话修改后自动进入对比模式） ---- */
  /**
   * 「本次对话修改前后」的差异段。**非空即表示正处于复核态**：由 `WritingWorkspace` 在
   * 每次对话修改成功后自动置上（用户 2026-09-10 裁定：不再需要用户手点「与上一版对比」）。
   */
  versionDiff?: CompilationVersionDiffView | null
  /** 本次修改产生的版本号（仅用于复核条上的标注） */
  reviewVersionNo?: number | null
  /** 仅显示改动段落 */
  onlyChanged?: boolean
  onToggleOnlyChanged?: (value: boolean) => void
  /** 采纳本次修改（保留改动、退出复核） */
  onAcceptEdit?: () => void
  /** 回退本次修改（弹出撤销栈最近一次操作、退出复核；**不产生新版本**） */
  onRevertEdit?: () => void
  /* ---- Phase 7.5：悬浮对话框（人机协同编辑） ---- */
  /** 汇编级对话历史（含大模型修改记录） */
  docMessages?: CompilationMessageView[]
  /** 大模型正在修改汇编 */
  docEditing?: boolean
  /** 上一次修改的失败原因（未配置模型 / 调用失败 / 格式无法解析） */
  docError?: string | null
  /** 本次改动涉及的段 id（滚动到首个改动段） */
  docChangedIds?: string[]
  onDocSend?: (instruction: string) => void
  /** 打开对话框时按需拉取历史 */
  onDocOpen?: () => void
  /* ---- 7.6.1：左栏下线后的「生成模式」（悬浮面板兼作生成入口，用户裁定 D7=A） ---- */
  /** 生成汇编阶段的任务对话（`task_messages`，左栏下线后在这里继续显示） */
  taskMessages?: ChatMessageItem[]
  /** 正在生成汇编（含整合提取/矛盾扫描全程） */
  generating?: boolean
  /** 生成中的状态文案（「正在生成资料汇编…」等） */
  generatingText?: string | null
  /** 生成进度（百分比 + 预计剩余） */
  generateProgress?: { percent: number; etaSeconds?: number } | null
  /** 大模型异常中断信息（必须能在面板里点「尝试继续」，否则中断后无法续跑） */
  generateInterrupt?: { stage: string; message: string; percent: number } | null
  /** 从断点继续生成汇编 */
  onRetryCompilation?: () => void
  /** 首次生成汇编（提交标题与要求） */
  onGenerate?: (instruction: string) => void
  /** 第三批 A1：最近一次生成的网页材料统计（已锁定篇数 / 站点新命中未纳入篇数） */
  webScan?: { sites: number; siteErrors: number; hits: number; fetched: number; skippedByCap: number; chars: number; reused?: number; newCandidates?: number } | null
  /** 本任务已锁定的网页材料篇数（持久化查询结果；重启后仍可显示） */
  pinnedWebCount?: number
  /**
   * 来源位置（锚点）覆盖统计（Phase 9 / S4 补）：锚点是生成后**后台异步**写入的，
   * 这一行让"多少段有位置、多少段没有"可见（此前只能一条条点圆标才发现）。
   */
  anchorStats?: { total: number; anchored: number; withPage: number; ambiguous: number } | null
  /**
   * 「疑似超出范围」复核清单（Phase 9 补充，用户裁定「界面兜底」）：生成汇编后按撰写要求里的
   * 范围线索（本地地名 / 是否排除上级）挑出"命中全省/省级/国家标记、且通篇不提本地地名"的段落，
   * 由用户自己判断是否移出（移出 = kept=false，可撤销）。
   */
  scopeCheck?: {
    flagged: { id: string; position: number; text: string; sourceTitle?: string; markers: string[] }[]
    checked: number
    available: boolean
    localities: string[]
  } | null
  /** 移出指定段落（主进程侧 kept=false） */
  onExcludeItems?: (itemIds: string[]) => void
  /** 重新生成汇编（按当前撰写要求重跑一遍生成管线；A1 会复用已锁定材料） */
  onRegenerateCompilation?: () => void
  /** 来源引用清单（消息内 #N 渲染为可点击来源） */
  sourceRefs?: SourceRefItem[]
}

export interface CompilationMessageView {
  role: 'user' | 'assistant'
  content: string
  versionNo?: number
  createdAt: string
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
  segments: {
    kind: 'added' | 'removed' | 'modified' | 'unchanged'
    id: string
    prevText?: string
    nextText?: string
    inline?: { type: 'same' | 'add' | 'del'; text: string }[]
    /** 仅 removed：渲染时插回"该段被删除前紧邻的下一段"之前（缺省 = 原本在最后） */
    beforeId?: string
  }[]
  summary: { added: number; removed: number; modified: number; unchanged: number }
}

const cls = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ')

/** Step 1：资料汇编文档查看器 + 对话编辑 */
function CompilationStep({
  compilation,
  busy,
  candidateChunks,
  onConfirm,
  onOpenSource,
  onResolve,
  onReorderItems,
  onUndo,
  onRedo,
  undoAvailable,
  redoAvailable,
  versionDiff,
  reviewVersionNo,
  onlyChanged,
  onToggleOnlyChanged,
  onAcceptEdit,
  onRevertEdit,
  docMessages,
  docEditing,
  docError,
  docChangedIds,
  onDocSend,
  onDocOpen,
  taskMessages,
  generating,
  /** 第三批 A1：最近一次生成的网页材料情况（用于面板里的"已锁定 N 篇 / 新文章 M 篇"提示） */
  webScan,
  pinnedWebCount,
  anchorStats,
  scopeCheck,
  onExcludeItems,
  onRegenerateCompilation,
  generatingText,
  generateProgress,
  generateInterrupt,
  onRetryCompilation,
  onGenerate,
  sourceRefs
}: Props) {
  const t = zhCN.compilation
  const webNew = webScan?.newCandidates ?? 0
  /** 差异段按段 id 建索引（渲染时给段落上色 / 段内高亮） */
  const diffById = new Map((versionDiff?.segments ?? []).map((s) => [s.id, s]))
  /** 被删除的段落按 beforeId 归组：渲染时插回"它被删除前所在的位置"（用户 2026-09-10 要求） */
  const removedBefore = new Map<string, CompilationVersionDiffView['segments']>()
  const removedAtEnd: CompilationVersionDiffView['segments'] = []
  for (const s of versionDiff?.segments ?? []) {
    if (s.kind !== 'removed') continue
    if (s.beforeId) {
      const list = removedBefore.get(s.beforeId) ?? []
      list.push(s)
      removedBefore.set(s.beforeId, list)
    } else {
      removedAtEnd.push(s)
    }
  }
  const removedSegments = removedAtEnd
  /**
   * 「仅看改动」时的可见段落：有差异的段落 + **删除占位的锚点段落**（否则被删段落的占位无处可插）。
   * 年份小标题随后按"可见列表"重算，避免出现"有的段落带年份标题、有的不带"的不一致（用户 2026-09-10 要求）。
   */
  const visibleItems =
    onlyChanged === true && versionDiff
      ? (compilation?.items ?? [])
          .filter((it) => it.kept !== false)
          .filter((it) => {
            if (removedBefore.has(it.id)) return true
            const d = diffById.get(it.id)
            return !!d && d.kind !== 'unchanged'
          })
      : (compilation?.items ?? []).filter((it) => it.kept !== false)
  /** 被删除段落的占位渲染（插回原位用） */
  const renderRemoved = (segment: CompilationVersionDiffView['segments'][number]): ReactNode => (
    <div key={segment.id} className="compilation-para diff-removed">
      <span className="compilation-doc__time">{t.versionRemovedTag}</span>
      <span className="compilation-doc__text">
        <del className="diff-del">{segment.prevText}</del>
      </span>
    </div>
  )
  /** 复核态（versionDiff 非空）下的「仅看改动」筛选 */
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')
  /** 矛盾窗口是否展开（默认展开，可收起） */
  const [contradictionsOpen, setContradictionsOpen] = useState(true)
  /** 「疑似超出范围」复核条展开状态（Phase 9 补充） */
  const [scopeOpen, setScopeOpen] = useState(false)
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

  /* ---- Phase 7.5：悬浮对话框（人机协同编辑） ---- */
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  /** 对话面板位置（null = 默认贴右下角；拖动后为相对 `.compilation-step` 的坐标） */
  const [panelPos, setPanelPos] = useState<{ x: number; y: number } | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const chatListRef = useRef<HTMLDivElement | null>(null)
  /** 「生成阶段」分区标题：刚生成完时从这一段开头显示（用户最先要看自己那句要求） */
  const taskSectionRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const messages = docMessages ?? []
  /**
   * 任务级记录（`task_messages`：撰写要求 / 生成结果 / 生成阶段提示）。
   * 生成完成后面板切到"与汇编对话"，这里把它作为**只读前段**显示，避免最初那次问答消失。
   */
  const taskHistory = taskMessages ?? []
  /** 疑似超出范围的段落（Phase 9 补充：由 `WritingWorkspace` 按撰写要求算好传进来） */
  const scopeFlags = scopeCheck?.flagged ?? []
  const scopeLocalities = scopeCheck?.localities ?? []
  const canSend = chatInput.trim().length > 0 && docEditing !== true
  /** 复核态：对话修改完成后由父组件自动置上差异，用户「采纳 / 回退」后才退出 */
  const reviewing = versionDiff != null

  const onPanelPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const panel = panelRef.current
    const pane = paneRef.current
    if (!panel || !pane) return
    const pr = panel.getBoundingClientRect()
    dragRef.current = { dx: e.clientX - pr.left, dy: e.clientY - pr.top }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPanelPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const pane = paneRef.current
    const panel = panelRef.current
    if (!drag || !pane || !panel) return
    const ar = pane.getBoundingClientRect()
    const w = panel.offsetWidth
    const h = panel.offsetHeight
    setPanelPos({
      x: Math.min(Math.max(e.clientX - ar.left - drag.dx, 4), Math.max(4, ar.width - w - 4)),
      y: Math.min(Math.max(e.clientY - ar.top - drag.dy, 4), Math.max(4, ar.height - h - 4))
    })
  }
  const onPanelPointerUp = (): void => {
    dragRef.current = null
  }

  useEffect(
    () => () => {
      if (locateTimerRef.current !== null) window.clearTimeout(locateTimerRef.current)
      if (missTimerRef.current !== null) window.clearTimeout(missTimerRef.current)
    },
    []
  )

  const pending = compilation?.contradictions.filter((c) => c.status === 'pending') ?? []
  /**
   * 矛盾分组编号（用户 2026-09-10 要求）：**按汇编内矛盾数组顺序 1..N**，包含已处理/已忽略的组。
   * 数组来自 `ORDER BY rowid`（稳定），因此编号不会随取舍变化而漂移——用户引用的「矛盾3」始终是同一组，
   * 导出文档里的编号与此**同源**（导出侧同样按数组顺序编号）。
   */
  const groupNoById = new Map((compilation?.contradictions ?? []).map((g, i) => [g.id, i + 1]))
  /** 该段落所属的**全部**矛盾组（含已处理）：用于显示「矛盾N」并让编号与导出文档对得上 */
  const conflictGroupsForItem = (itemId: string): { id: string; no: number; pending: boolean; topic: string }[] =>
    (compilation?.contradictions ?? [])
      .filter((g) => g.variants.some((v) => v.itemId === itemId))
      .map((g) => ({ id: g.id, no: groupNoById.get(g.id) ?? 0, pending: g.status === 'pending', topic: g.topic }))
  // 只展示未被软删除（采纳后未恢复）的卡片
  const keptItems = (compilation?.items ?? []).filter((it) => it.kept !== false)
  /** 本汇编的来源编号数量 + 缺年份（时间待核）的段落数（工具栏统计） */
  const sourceCount = new Set(keptItems.map((it) => it.sourceOrdinal).filter((n): n is number => n != null)).size
  const pendingTimeCount = keptItems.filter((it) => (it.timeConfidence ?? (it.year != null ? 'exact' : 'unknown')) === 'unknown').length
  /** 段 id → 段首时间（矛盾面板里并排标注两个说法的时间，便于判断是否同一时点） */
  const itemTimeById = new Map(keptItems.map((it) => [it.id, it.ts ?? '']))

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

  /**
   * 悬浮面板有两种模式（用户裁定 D7=A）：
   * - **生成模式**：还没有汇编、正在生成、或生成中断（中断时主进程已落库部分段落，`compilation` 非空，
   *   但此刻用户真正需要的是进度与「尝试继续」，所以中断态仍留在生成模式）；
   * - **对话模式**：已有汇编且不在生成中，即原来的「与汇编对话」。
   */
  const generatingMode = !compilation || generating === true || generateInterrupt != null

  // 生成中/中断/首次进入（还没有汇编）→ 自动展开面板，否则用户看不到进度与「尝试继续」
  useEffect(() => {
    if (generatingMode) setChatOpen(true)
  }, [generatingMode])

  /**
   * 生成**成功**结束（非中断）→ 自动收起面板，把刚生成的汇编让出来给用户看。
   * 仅识别「生成中 → 非生成中」这一次真实跃迁，用户手动展开的面板不会被误收。
   */
  const prevGeneratingRef = useRef(false)
  useEffect(() => {
    const prev = prevGeneratingRef.current
    prevGeneratingRef.current = generating === true
    if (prev && generating !== true && generateInterrupt == null && compilation) setChatOpen(false)
  }, [generating, generateInterrupt, compilation])

  // 新消息/编辑中 → 对话列表滚到底部；**还没有汇编修改记录时**（刚生成完）改为停在这一段的开头，
  // 让「生成阶段 · 撰写要求与生成结果」整段从顶部开始显示（用户最先要看到的就是自己那句要求）。
  useEffect(() => {
    const el = chatListRef.current
    if (!el) return
    if (messages.length === 0 && taskSectionRef.current) {
      el.scrollTop = 0
      return
    }
    el.scrollTop = el.scrollHeight
  }, [messages.length, docEditing, chatOpen, taskHistory.length])

  // 本次改动 → 滚动到首个改动段
  useEffect(() => {
    if (!docChangedIds || docChangedIds.length === 0) return
    const id = docChangedIds[0]
    const timer = window.setTimeout(() => {
      const el = cardsRef.current?.querySelector<HTMLElement>(`[data-card-id="${id}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [docChangedIds])

  /** 右下悬浮圆按钮（两种模式共用） */
  const fab = (
    <button
      type="button"
      className={cls('compilation-docchat-fab', chatOpen ? 'is-open' : '')}
      title={generatingMode ? t.generatePanelTitle : t.docChatOpen}
      aria-label={generatingMode ? t.generatePanelTitle : t.docChatOpen}
      aria-expanded={chatOpen}
      onClick={() => {
        const next = !chatOpen
        setChatOpen(next)
        if (next && !generatingMode) onDocOpen?.()
      }}
    >
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
        <rect x="4" y="7.5" width="16" height="12" rx="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M12 7.5V4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="12" cy="3.6" r="1.3" fill="currentColor" />
        <circle cx="9.2" cy="13" r="1.4" fill="currentColor" />
        <circle cx="14.8" cy="13" r="1.4" fill="currentColor" />
        <path d="M9.4 16.6h5.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M2.6 12.4v4.4M21.4 12.4v4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  )

  /** 悬浮面板外壳（可拖动 + 可最小化；标题随模式变化） */
  const panelShell = (body: ReactNode): ReactNode => (
    <div
      ref={panelRef}
      className={cls('compilation-docchat', generatingMode ? 'is-generating' : '')}
      style={panelPos ? { left: panelPos.x, top: panelPos.y, right: 'auto', bottom: 'auto' } : undefined}
    >
      <div
        className="compilation-docchat__head"
        onPointerDown={onPanelPointerDown}
        onPointerMove={onPanelPointerMove}
        onPointerUp={onPanelPointerUp}
        onPointerCancel={onPanelPointerUp}
      >
        <span className="compilation-docchat__title">{generatingMode ? t.generatePanelTitle : t.docChatTitle}</span>
        <span className="compilation-docchat__drag">{t.docChatDragHint}</span>
        <button
          type="button"
          className="compilation-docchat__close"
          title={t.docChatMinimize}
          aria-label={t.docChatMinimize}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setChatOpen(false)}
        >
          &#8211;
        </button>
      </div>
      {body}
    </div>
  )

  /**
   * 第三批 A1：网页材料提示条。**两种模式都渲染**（重启后按持久化锁定篇数显示）。
   * 数据来源：本次生成的统计（`webScan`）优先，其次取主进程查到的持久化锁定篇数。
   */
  const pinnedCount = Math.max(webScan?.reused ?? 0, pinnedWebCount ?? 0)
  const webInfo =
    pinnedCount > 0 || webNew > 0 ? (
      <div className="compilation-webinfo">
        {webScan && (webScan.reused ?? 0) > 0 ? (
          <span>{t.webMaterialsPinned.replace('{count}', String(webScan.reused))}</span>
        ) : webScan ? (
          <span>{t.webMaterialsFetched.replace('{count}', String(webScan.fetched))}</span>
        ) : (
          <span>{t.webMaterialsPinned.replace('{count}', String(pinnedCount))}</span>
        )}
        {webNew > 0 ? (
          <span className="compilation-webinfo__new">{t.webMaterialsNew.replace('{count}', String(webNew))}</span>
        ) : null}
      </div>
    ) : null

  /**
   * 生成模式主体：复用左栏原来的 `ChatPanel`（预设提示词 / 进度条 / 中断「尝试继续」/ 消息气泡全部沿用，
   * 视觉与交互不退化），只是搬进了悬浮面板。
   */
  const generateBody = (
    <div className="compilation-docchat__chatpanel">
      {webInfo}
      <ChatPanel
        messages={taskMessages ?? []}
        draftExisted={false}
        busy={generating === true}
        busyText={generatingText ?? null}
        streamText={null}
        progress={generateProgress ?? null}
        interrupt={generateInterrupt ?? null}
        onRetryCompilation={onRetryCompilation}
        onGenerate={(text) => onGenerate?.(text)}
        onChat={(text) => onGenerate?.(text)}
        primaryLabel={zhCN.compilation.generateBtn}
        onPrimaryAction={(text) => onGenerate?.(text)}
        showPresetButton
        hasCompilation={false}
        refs={sourceRefs}
        onOpenSource={onOpenSource}
      />
    </div>
  )

  const chatBody = (
    <>
      {webInfo}
      <div className="compilation-docchat__list" ref={chatListRef}>
        {/*
          2026-10-03 修复（用户实测反馈）：**生成阶段的问答要在生成完成后仍然看得见**。
          最初那条「本次撰写要求」与「已生成资料汇编：…」属于**任务级**记录（`task_messages`），
          而汇编生成完后面板从"生成模式"切成"与汇编对话"，只渲染**汇编级**记录
          （`compilation_messages`）→ 用户再也翻不到自己最初那句要求与生成结果。
          这里把任务级记录作为**只读前段**接在汇编对话之前（写入入口仍是下方输入框，只改汇编）。
        */}
        {taskHistory.length > 0 ? (
          <>
            <div className="compilation-docchat__section" ref={taskSectionRef}>
              {t.docChatTaskSection}
            </div>
            {taskHistory.map((m, i) => (
              <div
                key={`task-${i}`}
                className={cls('compilation-docchat__msg', 'is-task', m.role === 'user' ? 'is-user' : 'is-assistant')}
              >
                {m.content}
              </div>
            ))}
            <div className="compilation-docchat__section">{t.docChatEditSection}</div>
          </>
        ) : null}
        {messages.length === 0 ? (
          // 有生成阶段记录时不再重复"还没有对话记录"（分区标题已经说明下方输入框只改汇编），
          // 也让「撰写要求 + 生成结果」更容易一次看全
          taskHistory.length === 0 ? <p className="compilation-docchat__empty">{t.docChatEmpty}</p> : null
        ) : (
          messages.map((m, i) => (
            <div key={i} className={cls('compilation-docchat__msg', m.role === 'user' ? 'is-user' : 'is-assistant')}>
              {m.content}
              {m.versionNo != null ? <span className="compilation-docchat__ver">v{m.versionNo}</span> : null}
            </div>
          ))
        )}
        {docEditing ? <div className="compilation-docchat__typing">{t.docChatEditing}</div> : null}
      </div>
      {docError ? <div className="compilation-docchat__error">{docError}</div> : null}
      <div className="compilation-docchat__foot">
        <textarea
          className="compilation-docchat__input"
          rows={2}
          value={chatInput}
          placeholder={t.docChatPlaceholder}
          disabled={docEditing === true}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canSend) {
              onDocSend?.(chatInput.trim())
              setChatInput('')
            }
          }}
        />
        <div className="compilation-docchat__actions">
          <span className="compilation-docchat__hint">{t.docChatHint}</span>
          {/*
            已有汇编的任务此前**没有任何重跑生成的入口**（「与汇编对话」模式只有对话修改），
            用户只能新建任务。这里补一个真正的「重新生成汇编」：走同一套生成管线，
            网页材料沿用 A1 已锁定的那一批（`listPinnedWebMaterials`）。
          */}
          {onRegenerateCompilation ? (
            <button
              type="button"
              className="source-list__btn"
              disabled={docEditing === true || generating === true}
              onClick={() => onRegenerateCompilation()}
            >
              {t.regenerateBtn}
            </button>
          ) : null}
          <button
            type="button"
            className="source-list__btn source-list__btn--primary"
            disabled={!canSend}
            onClick={() => {
              onDocSend?.(chatInput.trim())
              setChatInput('')
            }}
          >
            {docEditing ? t.docChatEditing : t.docChatSend}
          </button>
        </div>
      </div>
    </>
  )

  if (!compilation) {
    return (
      <div className="compilation-step" ref={paneRef}>
        <div className="compilation-empty">
          <p>{t.empty}</p>
        </div>
        {fab}
        {chatOpen ? panelShell(generateBody) : null}
        {hint ? (
          <div className="compilation-hint" style={{ left: hint.x, top: hint.y - 10 }} role="tooltip">
            {hint.text}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="compilation-step" ref={paneRef}>
      <div className="compilation-toolbar">
        <span className="compilation-stat">{t.docStats.replace('{paragraphs}', String(keptItems.length)).replace('{sources}', String(sourceCount))}</span>
        {candidateChunks ? <span className="compilation-stat">{t.candidate.replace('{chunks}', String(candidateChunks))}</span> : null}
        {/*
          Phase 9 / S4 补：来源位置覆盖情况。锚点是生成后台异步算的，此前完全看不见——
          这里如实报"多少段已记录位置 / 其中多少段有页码 / 多少段未记录 / 多少段引文在来源里出现多处"。
        */}
        {anchorStats && anchorStats.total > 0 ? (
          <span
            className={cls('compilation-stat', anchorStats.anchored < anchorStats.total ? 'is-warn' : '')}
            onMouseEnter={(e) => showHint(e.currentTarget, t.anchorStatsHint)}
            onMouseLeave={() => setHint(null)}
          >
            {t.anchorStats
              .replace('{anchored}', String(anchorStats.anchored))
              .replace('{total}', String(anchorStats.total))
              .replace('{paged}', String(anchorStats.withPage))}
            {anchorStats.anchored < anchorStats.total
              ? t.anchorStatsMissing.replace('{missing}', String(anchorStats.total - anchorStats.anchored))
              : ''}
            {anchorStats.ambiguous > 0 ? t.anchorStatsAmbiguous.replace('{count}', String(anchorStats.ambiguous)) : ''}
          </span>
        ) : null}
        {pendingTimeCount > 0 ? (
          <span
            className="compilation-stat is-warn"
            onMouseEnter={(e) => showHint(e.currentTarget, t.pendingTimeHint)}
            onMouseLeave={() => setHint(null)}
          >
            {t.pendingTimeStat.replace('{count}', String(pendingTimeCount))}
          </span>
        ) : null}
        <span className={cls('compilation-badge', pending.length ? 'danger' : 'ok')}>
          {pending.length ? t.pendingContradictions.replace('{count}', String(pending.length)) : t.noContradictions}
        </span>
        <div className="compilation-actions">
          {/* 复核态下禁用撤销/恢复/排序：此时唯一出口是下面复核条的「采纳 / 回退」，
              避免出现两条互相矛盾的路径（点撤销=回退，但复核条还在） */}
          <button
            type="button"
            className="compilation-round-btn"
            disabled={busy || reviewing || undoAvailable <= 0}
            title={t.undo}
            aria-label={t.undo}
            onClick={onUndo}
          >
            &#8630;
          </button>
          <button
            type="button"
            className="compilation-round-btn"
            disabled={busy || reviewing || redoAvailable <= 0}
            title={t.redo}
            aria-label={t.redo}
            onClick={onRedo}
          >
            &#8631;
          </button>
          <button
            type="button"
            className="compilation-round-btn"
            disabled={busy || reviewing}
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
            disabled={busy}
          >
            {t.exportBtn}
          </button>
        </div>
      </div>

      {/*
        Phase 9 补充（用户裁定「界面兜底」）：疑似超出范围的段落复核条。
        只做**确定性提示**（命中全省/省级/国家标记、且通篇不提撰写要求里点名的本地地名），
        由用户判断是否移出（移出 = kept=false：不删数据、可撤销、有版本记录）。
        撰写要求里没有范围线索（既没点名地名、也没写"排除上级"）→ 界面不出现这条，不添噪声。
      */}
      {scopeFlags.length > 0 ? (
        <div className="compilation-scope">
          <button
            type="button"
            className="compilation-collapse-btn compilation-collapse-btn--bar"
            onClick={() => setScopeOpen((o) => !o)}
          >
            <span>{t.scopeTitle.replace('{count}', String(scopeFlags.length))}</span>
            <span aria-hidden="true">{scopeOpen ? '▲' : '▼'}</span>
          </button>
          {scopeOpen ? (
            <div className="compilation-scope__list">
              <p className="compilation-scope__hint">
                {t.scopeHint.replace('{scope}', scopeLocalities.length > 0 ? scopeLocalities.join('、') : t.scopeHigherLevel)}
              </p>
              {scopeFlags.map((f) => (
                <div key={f.id} className="compilation-scope__item">
                  <div className="compilation-scope__text">{f.text.slice(0, 80)}</div>
                  <div className="compilation-scope__meta">
                    {t.scopeParagraph.replace('{n}', String(f.position + 1))}
                    {t.scopeMarkers.replace('{markers}', f.markers.join('、'))}
                    {f.sourceTitle ? t.scopeFrom.replace('{title}', f.sourceTitle) : ''}
                  </div>
                  <div className="compilation-scope__actions">
                    <button type="button" className="source-list__btn" onClick={() => locateItem(f.id)}>
                      {t.locate}
                    </button>
                    <button
                      type="button"
                      className="source-list__btn"
                      disabled={busy}
                      onClick={() => onExcludeItems?.([f.id])}
                    >
                      {t.scopeExclude}
                    </button>
                  </div>
                </div>
              ))}
              <div className="compilation-scope__footer">
                <button
                  type="button"
                  className="source-list__btn source-list__btn--primary"
                  disabled={busy}
                  onClick={() => onExcludeItems?.(scopeFlags.map((f) => f.id))}
                >
                  {t.scopeExcludeAll.replace('{count}', String(scopeFlags.length))}
                </button>
                <button type="button" className="source-list__btn" onClick={() => setScopeOpen(false)}>
                  {t.collapse}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 复核条（用户 2026-09-10 裁定）：每次对话修改后**自动**进入对比模式，
          用户只需点「采纳」或「回退」二选一，选完即退出对比模式。 */}
      {versionDiff ? (
        <div className="compilation-review">
          <span className="compilation-review__title">
            {t.versionReviewTitle}
            {reviewVersionNo != null ? '（v' + reviewVersionNo + '）' : ''}
          </span>
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
          <span className="compilation-review__hint">{t.versionReviewHint}</span>
          <div className="compilation-review__actions">
            <button type="button" className="source-list__btn" disabled={busy} title={t.versionRevertHint} onClick={onRevertEdit}>
              {t.versionRevert}
            </button>
            <button
              type="button"
              className="source-list__btn source-list__btn--primary"
              disabled={busy}
              onClick={onAcceptEdit}
            >
              {t.versionAccept}
            </button>
          </div>
        </div>
      ) : null}

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
                    {/*
                      第三批 D：把两个说法的**时间**并排显示，便于判断"是不是同一时点的事"——
                      实测多数"矛盾"其实是规划/在建/投用等不同阶段的正常差异。
                    */}
                    <div className="compilation-variant-src">
                      来源：《{v.sourceTitle ?? v.sourceId}》
                      {itemTimeById.get(v.itemId) ? `　时间：${itemTimeById.get(v.itemId)}` : ''}
                    </div>
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
        {visibleItems.length === 0 ? (
          <div className="compilation-empty">{keptItems.length === 0 ? t.emptyDoc : t.versionNoChanges}</div>
        ) : (
          visibleItems.map((it, index) => {
            const year = it.year ?? null
            // 年份小标题按**可见列表**计算（用户 2026-09-10：仅看改动时也要统一显示年份标题）
            const prevYear = index > 0 ? (visibleItems[index - 1].year ?? null) : null
            const pendingTime = (it.timeConfidence ?? (it.year != null ? 'exact' : 'unknown')) === 'unknown'
            const diff = diffById.get(it.id)
            return (
              <Fragment key={it.id}>
                {/* 被删除的段落插回原位：紧邻它"当年的下一段"之前 */}
                {(removedBefore.get(it.id) ?? []).map(renderRemoved)}
                {year != null && year !== prevYear ? (
                  <h3 className="compilation-doc__year">{t.yearHeading.replace('{year}', String(year))}</h3>
                ) : null}
                <div
                  data-card-id={it.id}
                  className={cls(
                    'compilation-para',
                    conflictForItem(it.id) ? 'has-conflict' : '',
                    locatedId === it.id ? 'is-located' : '',
                    /* Phase 7.5：复核态下按差异上色（红=删除 / 黄=修改 / 绿=新增） */
                    diff ? 'diff-' + diff.kind : ''
                  )}
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
                  {/* Phase 9 / S1：点圆标**直接开右栏的来源文件**（原先弹"来源小卡"这一中间层，已删除）。
                      S4：锚点改由生成期算好的"块号 × 页码"给出（只报页/段，不做句子级检索）。 */}
                  {it.sourceOrdinal != null ? (
                    <button
                      type="button"
                      className="compilation-src-badge"
                      aria-label={t.sourceBadgeTitle.replace('{n}', String(it.sourceOrdinal))}
                      onClick={() =>
                        onOpenSource(
                          it.sourceId,
                          locateAnchorForItem(
                            it,
                            it.sourceId,
                            // 段号对用户是**1 起**的（`position` 是 0 起的排序位次，直接显示会得到"第 0 段"）
                            t.sourceAnchorParagraph.replace('{n}', String(it.position + 1))
                          ),
                          it.evidence || it.excerpt
                        )
                      }
                      onMouseEnter={(e) => showHint(e.currentTarget, t.sourceBadgeTitle.replace('{n}', String(it.sourceOrdinal)))}
                      onMouseLeave={() => setHint(null)}
                    >
                      {it.sourceOrdinal}
                    </button>
                  ) : null}
                  {(it.alsoSourceOrdinals ?? []).map((ord, i) => (
                    <button
                      key={'also-' + it.id + '-' + ord}
                      type="button"
                      className="compilation-src-badge is-also"
                      aria-label={t.sourceBadgeAlsoTitle.replace('{n}', String(ord))}
                      onClick={() => {
                        // Q5：并列来源圆标**各开各的来源**，并带**该来源自己的锚点**（没有就如实说没有）
                        const sid = it.alsoSourceIds?.[i]
                        if (!sid) return
                        onOpenSource(
                          sid,
                          locateAnchorForItem(
                            it,
                            sid,
                            t.sourceAnchorParagraph.replace('{n}', String(it.position + 1))
                          ),
                          it.evidence || it.excerpt
                        )
                      }}
                      onMouseEnter={(e) => showHint(e.currentTarget, t.sourceBadgeAlsoTitle.replace('{n}', String(ord)))}
                      onMouseLeave={() => setHint(null)}
                    >
                      {ord}
                    </button>
                  ))}
                  {conflictGroupsForItem(it.id).map((g) =>
                    g.pending ? (
                      <span key={g.id} className="compilation-chip conflict" title={g.topic}>
                        ⚠ {t.contradictNo.replace('{n}', String(g.no))}
                      </span>
                    ) : (
                      /* 已采纳/已忽略的组也标出编号（灰色）：编号与导出文档一致，便于对照审阅 */
                      <span key={g.id} className="compilation-chip is-done" title={g.topic}>
                        {t.contradictNo.replace('{n}', String(g.no))}
                      </span>
                    )
                  )}
                </div>
              </Fragment>
            )
          })
        )}
        {/* 对比模式下：原本在整篇最后的被删除段落 */}
        {versionDiff && removedSegments.length > 0 ? removedSegments.map(renderRemoved) : null}
      </div>


      {/* 自绘提示气泡：fixed 定位，不受卡片列表滚动容器裁剪（原生 title 在长滚动列表里不可靠） */}
      {hint ? (
        <div className="compilation-hint" style={{ left: hint.x, top: hint.y - 10 }} role="tooltip">
          {hint.text}
        </div>
      ) : null}

      {/* 右下悬浮圆按钮（机器人简笔）：无汇编时是「生成」入口，有汇编时是「与汇编对话」入口——
          用户裁定 D7=A：全局只保留这一个入口（左栏任务对话框已下线）。 */}
      {fab}

      {chatOpen ? panelShell(generatingMode ? generateBody : chatBody) : null}
    </div>
  )
}

export default CompilationStep
