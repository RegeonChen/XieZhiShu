import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { zhCN } from '../i18n/zh-CN'
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

/** 快照抓取时间显示（YYYY-MM-DD HH:mm，本地时区；解析失败则原样返回） */
function formatSnapshotTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 快照正文渲染（第三批 C）：把该段的引文在正文里高亮。
 * 段落的 excerpt 与库里快照可能只差空白/换行（提取时做了归一化），所以用**去空白比对**定位，
 * 再映射回原文下标——这是"这段确实出自原文"的可视化证据，必须尽量命中而不是靠精确匹配。
 */
function renderSnapshotText(text: string, highlight: string): ReactNode[] {
  const body = text ?? ''
  const needle = (highlight ?? '').trim()
  if (!needle) return [body]
  // 去空白后的正文 + 到原下标的映射
  const map: number[] = []
  let stripped = ''
  for (let i = 0; i < body.length; i++) {
    if (/\s/.test(body[i])) continue
    stripped += body[i]
    map.push(i)
  }
  const needleStripped = needle.replace(/\s+/g, '')
  if (!needleStripped) return [body]
  const at = stripped.indexOf(needleStripped)
  if (at < 0) return [body]
  const start = map[at]
  const end = map[Math.min(map.length - 1, at + needleStripped.length - 1)] + 1
  return [
    body.slice(0, start),
    <mark key="hl" className="compilation-snapshot__hit">{body.slice(start, end)}</mark>,
    body.slice(end)
  ]
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
  onOpenSource: (sourceId: string) => void
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
  /** 第三批 A1：最近一次生成的网页材料统计（已锁定 / 新发现未纳入） */
  webScan?: { sites: number; siteErrors: number; hits: number; fetched: number; skippedByCap: number; chars: number; reused?: number; newCandidates?: number } | null
  /** 正在纳入新网页材料 */
  adoptingWeb?: boolean
  /** 纳入新网页材料（抓取站点上新命中但未纳入的文章并锁定到本任务） */
  onAdoptWebMaterials?: () => void
  /** 正在重新检索网页材料（清空并重算本任务的材料集合） */
  refreshingWeb?: boolean
  /** 重新检索网页材料 */
  onRefreshWebMaterials?: () => void
  /** 本任务已锁定的网页材料篇数（持久化查询结果；重启后仍可显示入口） */
  pinnedWebCount?: number
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
  adoptingWeb,
  onAdoptWebMaterials,
  refreshingWeb,
  onRefreshWebMaterials,
  pinnedWebCount,
  generatingText,
  generateProgress,
  generateInterrupt,
  onRetryCompilation,
  onGenerate,
  sourceRefs
}: Props) {
  const t = zhCN.compilation
  const webNew = webScan?.newCandidates ?? 0
  /** 生成中/抓取中禁用「纳入新材料」「重新检索网页材料」（边生成边抓取会互相干扰） */
  const webActionDisabled = generating === true || adoptingWeb === true || refreshingWeb === true
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
  /** 当前打开「来源小卡」的来源编号（点击段尾圆标） */
  const [sourceCardFor, setSourceCardFor] = useState<number | null>(null)
  /** 本地快照弹窗（第三批 C）：离线核对抓取当时正文；highlight = 该段引文（在正文里高亮） */
  const [snapshot, setSnapshot] = useState<{
    id: string
    kind: 'file' | 'url'
    title: string
    snapshotAt?: string
    publishedAt?: string
    text: string
    totalChars: number
    truncated: boolean
    shortText: boolean
  } | null>(null)
  const [snapshotHighlight, setSnapshotHighlight] = useState('')
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  /** 来源小卡头部的元信息（抓取时间 + 正文是否过短）：打开卡片时按需读取 */
  const [cardMeta, setCardMeta] = useState<{ snapshotAt?: string; shortText: boolean } | null>(null)
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

  /** 来源小卡打开时读取元信息（抓取时间 / 正文过短提示），供卡片头部展示（第三批 C） */
  useEffect(() => {
    if (sourceCardFor == null) {
      setCardMeta(null)
      return
    }
    const item = (compilation?.items ?? []).find((x) => x.sourceOrdinal === sourceCardFor)
    if (!item) return
    let alive = true
    void window.api
      .getSourceSnapshot(item.sourceId)
      .then((res) => {
        if (alive && res.ok && res.data) setCardMeta({ snapshotAt: res.data.snapshotAt, shortText: res.data.shortText })
      })
      .catch(() => {
        /* 元信息读不到不影响卡片本身 */
      })
    return () => {
      alive = false
    }
  }, [sourceCardFor, compilation])

  /** 打开本地快照（读库里已存正文，不联网）；失败时给出明确提示而不是静默无反应 */
  const openSnapshot = async (sourceId: string, highlight: string): Promise<void> => {
    setSnapshotError(null)
    setSnapshotLoading(true)
    try {
      const res = await window.api.getSourceSnapshot(sourceId)
      if (res.ok && res.data) {
        setSnapshotHighlight(highlight)
        setSnapshot(res.data)
        setSourceCardFor(null)
      } else {
        setSnapshotError(res.error?.message ?? '读取快照失败')
      }
    } catch (e) {
      setSnapshotError(String(e))
    } finally {
      setSnapshotLoading(false)
    }
  }

  /* ---- Phase 7.5：悬浮对话框（人机协同编辑） ---- */
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  /** 对话面板位置（null = 默认贴右下角；拖动后为相对 `.compilation-step` 的坐标） */
  const [panelPos, setPanelPos] = useState<{ x: number; y: number } | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const chatListRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const messages = docMessages ?? []
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

  // 新消息/编辑中 → 对话列表滚到底部
  useEffect(() => {
    const el = chatListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, docEditing, chatOpen])

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
   * 第三批 A1：网页材料提示条。**两种模式都渲染**（此前只长在生成模式里，
   * 而重新生成会先按旧集合复用，"换一批材料"的入口事实上够不到）。
   * 数据来源：本次生成的统计（`webScan`）优先，其次取主进程查到的持久化锁定篇数（重启后仍可见）。
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
          <>
            <span className="compilation-webinfo__new">{t.webMaterialsNew.replace('{count}', String(webNew))}</span>
            <button type="button" className="source-list__btn" disabled={webActionDisabled} onClick={() => onAdoptWebMaterials?.()}>
              {adoptingWeb ? t.webMaterialsAdopting : t.webMaterialsAdopt}
            </button>
          </>
        ) : null}
        {pinnedCount > 0 ? (
          <button
            type="button"
            className="source-list__btn compilation-webinfo__refresh"
            title={t.webMaterialsRefreshHint}
            disabled={webActionDisabled}
            onClick={() => onRefreshWebMaterials?.()}
          >
            {refreshingWeb ? t.webMaterialsRefreshing : t.webMaterialsRefresh}
          </button>
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
        {messages.length === 0 ? (
          <p className="compilation-docchat__empty">{t.docChatEmpty}</p>
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
            {cardMeta?.snapshotAt ? (
              <p className="settings__hint">
                {t.snapshotAt.replace('{time}', formatSnapshotTime(cardMeta.snapshotAt))}
                {cardMeta.shortText ? '　' + t.snapshotShortBadge : ''}
              </p>
            ) : null}
            <div className="compilation-source-card__list">              {keptItems
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
            {snapshotError ? <p className="settings__hint settings__hint--err">{snapshotError}</p> : null}
            <div className="skills-manager__modal-actions">
              <button type="button" className="source-list__btn" onClick={() => setSourceCardFor(null)}>{t.cancel}</button>
              {/* 第三批 C：网站会改版/撤稿 → 提供"查看本地快照"（读库里抓取当时的正文，不联网） */}
              <button
                type="button"
                className="source-list__btn"
                disabled={snapshotLoading}
                onClick={() => {
                  const item = keptItems.find((x) => x.sourceOrdinal === sourceCardFor)
                  if (item) void openSnapshot(item.sourceId, item.excerpt)
                }}
              >
                {snapshotLoading ? t.snapshotLoading : t.snapshotOpen}
              </button>
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

      {/* 本地快照弹窗（第三批 C）：离线可核对的抓取当时正文，命中的段落引文高亮显示 */}
      {snapshot ? (
        <div className="skills-manager__modal-backdrop" onMouseDown={() => setSnapshot(null)}>
          <div className="skills-manager__modal compilation-snapshot" onMouseDown={(e) => e.stopPropagation()}>
            <h4 className="skills-manager__modal-title">{t.snapshotTitle}</h4>
            <p className="settings__hint">
              {snapshot.kind === 'url' ? t.snapshotUrlHint : t.snapshotFileHint}
              {snapshot.snapshotAt ? '　' + t.snapshotAt.replace('{time}', formatSnapshotTime(snapshot.snapshotAt)) : ''}
              {snapshot.truncated ? '　' + t.snapshotTruncated.replace('{chars}', String(snapshot.totalChars)) : ''}
            </p>
            {snapshot.shortText ? <p className="settings__hint settings__hint--err">{t.snapshotShort}</p> : null}
            <div className="compilation-snapshot__body">
              {renderSnapshotText(snapshot.text, snapshotHighlight)}
            </div>
            <div className="skills-manager__modal-actions">
              <button type="button" className="source-list__btn" onClick={() => setSnapshot(null)}>{t.close}</button>
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

      {/* 右下悬浮圆按钮（机器人简笔）：无汇编时是「生成」入口，有汇编时是「与汇编对话」入口——
          用户裁定 D7=A：全局只保留这一个入口（左栏任务对话框已下线）。 */}
      {fab}

      {chatOpen ? panelShell(generatingMode ? generateBody : chatBody) : null}
    </div>
  )
}

export default CompilationStep
