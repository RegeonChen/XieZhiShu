import { useState, useEffect, useCallback, useRef } from 'react'
import { zhCN } from '../i18n/zh-CN'
import DraftEditor, { type DraftEditorHandle } from './DraftEditor'
import ConfirmDialog from './ConfirmDialog'
import ContradictionDialog from './ContradictionDialog'
import ResizeHandle from './ResizeHandle'
import SourceViewer from './SourceViewer'
import type { SourceLocateAnchor } from '../lib/source-locate'
import StyleGuideEditor from './StyleGuideEditor'
import ChatPanel, { type ChatMessageItem, type SourceRefItem } from './ChatPanel'
import CompilationStep, {
  type CompilationView,
  type CompilationVersionView,
  type CompilationVersionDiffView,
  type CompilationMessageView
} from './CompilationStep'
import type { CompilationReadiness, Contradiction, CompilationRecycleBinItem } from '../../../shared/types'
import type { CompilationWebScan } from '../../../shared/ipc'

interface TaskItem {
  id: string
  title: string
  skillIds?: string[]
  llmProviderId?: string
  articleTitle?: string
  userInstruction?: string
  currentVersion: number
  /** Phase 10 P5：该任务的网页资料年份区间（新建任务继承全局默认；为空 = 回退全局默认） */
  webYearFrom?: number
  webYearTo?: number
}
interface SegmentItem {
  id: string
  heading?: string
  content: string
  aiGenerated: boolean
  sources: { sourceId: string; position: string; quote?: string; sourceTitle?: string }[]
}
interface DraftItem {
  id: string
  versionNumber: number
  segments: SegmentItem[]
}

type BusyState = 'generating' | 'chatting' | null
type DraftPhase = 'import' | 'style' | 'write'

/** 生成/续跑完成后的对话汇总：段落数 + 整合提取统计 + 大模型修正数 + 矛盾数 + 各阶段未完成提示 */
function buildGeneratedSummary(
  prefix: string,
  comp: CompilationView,
  scans: {
    contradictionScan?: { ok: boolean; message?: string }
    extractScan?: {
      ok: boolean
      message?: string
      inputCards?: number
      outputParagraphs?: number
      inputChars?: number
      outputChars?: number
      accepted?: number
      degraded?: number
      invalidNumbers?: number
      invalidEvidence?: number
      /** 2026-10-03：证据未逐字命中但事实逐句核验通过而接受 */
      evidenceLoose?: number
      degradedFromEvidence?: number
      droppedUnverifiable?: number
      droppedUnparseable?: number
      droppedCards?: number
      omitted?: number
      duplicatesDropped?: number
      conflictsKept?: number
      /** C（2026-09-12）：因"只复述标题"被丢弃 / 因"年份无据"被标待核的段落数 */
      titleOnlyDropped?: number
      timeUnsupported?: number
    }
    webScan?: {
      sites: number
      siteErrors: number
      hits: number
      fetched: number
      chars: number
      /** 正文未通过相关性判定而丢弃的篇数 */
      relevanceDropped?: number
      /** A1 标题探针不过（老文章失效 → 模板页）而丢弃的篇数 */
      invalidBody?: number
      /** 空标题候选（sitemap）：正文过短 / 与同站别的 URL 正文逐字相同 */
      shortBody?: number
      templateRepeat?: number
      fetchFailed?: number
      /** 不在 http(s) + 同域白名单内、未发起请求的篇数（安全过滤） */
      blocked?: number
      /** 2026-10-05：正文缓存复用（未联网）与自适应降档次数 */
      cacheHits?: number
      downgrades?: number
    }
    /**
     * 第二组 ⑤：本轮的「文章内取高信号段 ± 上下文」统计（用户勾选「本轮不做收敛」时为 undefined）。
     * 生成汇总要**如实带一句**：本轮送了多少段/字、有多少段因无信号未送（仍在库中）。
     */
    convergence?: {
      contextRange: number
      gatedSegments: number
      gatedChars: number
      sources: number
      keptSegments: number
      keptChars: number
      droppedSegments: number
      droppedChars: number
      noSignalSources: number
    }
    /** 本轮真正送细读的候选块数（勾选「本轮不做收敛」时 = 闸门后的全部段数） */
    candidateChunks?: number
  }
): string {
  const pendingCount = comp.contradictions.filter((c) => c.status === 'pending').length
  const parts: string[] = [prefix + comp.items.length + ' 段']
  const ps = scans.extractScan
  if (ps && ps.inputCards != null && ps.outputParagraphs != null) {
    const keptPct = Math.round(((ps.outputChars ?? 0) / Math.max(1, ps.inputChars ?? 1)) * 100)
    parts.push(
      zhCN.compilation.extractSummary
        .replace('{fromCards}', String(ps.inputCards))
        .replace('{fromChars}', String(ps.inputChars ?? 0))
        .replace('{toParagraphs}', String(ps.outputParagraphs))
        .replace('{toChars}', String(ps.outputChars ?? 0))
        .replace('{kept}', String(keptPct))
    )
    // 诊断细分：本地校验通过/降级（数字无据），以及兜底粒度（只保留逐字证据片段）
    if (ps.accepted != null || ps.degraded != null) {
      parts.push(
        zhCN.compilation.extractDiagnostics
          .replace('{accepted}', String(ps.accepted ?? 0))
          .replace('{loose}', String(ps.evidenceLoose ?? 0))
          .replace('{degraded}', String(ps.degraded ?? 0))
          .replace('{numbers}', String(ps.invalidNumbers ?? 0))
          .replace('{fromEvidence}', String(ps.degradedFromEvidence ?? 0))
      )
    }
    if (ps.droppedUnverifiable) {
      parts.push(zhCN.compilation.extractDroppedUnverifiable.replace('{count}', String(ps.droppedUnverifiable)))
      if (ps.droppedUnparseable) {
        parts.push(zhCN.compilation.extractDroppedUnparseable.replace('{count}', String(ps.droppedUnparseable)))
      }
    }
    if (ps.droppedCards) parts.push(zhCN.compilation.extractDropped.replace('{count}', String(ps.droppedCards)))
    // C：两条硬校验的结果如实告知（标题型段落被丢弃 / 年份无据被标待核）
    if (ps.titleOnlyDropped) parts.push(zhCN.compilation.extractTitleOnly.replace('{count}', String(ps.titleOnlyDropped)))
    if (ps.timeUnsupported) parts.push(zhCN.compilation.extractTimeUnsupported.replace('{count}', String(ps.timeUnsupported)))
    if (ps.conflictsKept) parts.push(zhCN.compilation.extractConflictsKept.replace('{count}', String(ps.conflictsKept)))
  }
  // 网页资料本轮抓取情况：让用户知道"这次用上了多少网页材料"
  const ws = scans.webScan
  if (ws && ws.sites > 0) {
    parts.push(
      zhCN.compilation.webScan
        .replace('{hits}', String(ws.hits))
        .replace('{fetched}', String(ws.fetched))
        .replace('{chars}', String(ws.chars))
    )
    if (ws.cacheHits && ws.cacheHits > 0) parts.push(zhCN.compilation.webScanCacheReused.replace('{count}', String(ws.cacheHits)))
    if (ws.downgrades && ws.downgrades > 0) parts.push(zhCN.compilation.crawlDowngraded.replace('{count}', String(ws.downgrades)))
    // 抓回来发现"没取到正文"（老文章失效、站点返回模板页）→ 如实告知，别让用户以为材料本来就少
    if (ws.relevanceDropped && ws.relevanceDropped > 0) {
      parts.push(zhCN.compilation.webScanRelevanceDropped.replace('{count}', String(ws.relevanceDropped)))
    }
    if (ws.invalidBody && ws.invalidBody > 0) {
      parts.push(zhCN.compilation.webScanInvalidBody.replace('{count}', String(ws.invalidBody)))
    }
    // 2026-10-05（P0 兜底回归）：两类"空标题候选"丢弃现在真的会计数（此前恒为 0、分支不可达）
    if (ws.shortBody && ws.shortBody > 0) {
      parts.push(zhCN.compilation.webScanShortBody.replace('{count}', String(ws.shortBody)))
    }
    if (ws.templateRepeat && ws.templateRepeat > 0) {
      parts.push(zhCN.compilation.webScanTemplateRepeat.replace('{count}', String(ws.templateRepeat)))
    }
    if (ws.fetchFailed && ws.fetchFailed > 0) {
      parts.push(zhCN.compilation.webScanFetchFailed.replace('{count}', String(ws.fetchFailed)))
    }
    if (ws.blocked && ws.blocked > 0) {
      parts.push(zhCN.compilation.webScanBlocked.replace('{count}', String(ws.blocked)))
    }
    if (ws.fetched === 0 && ws.siteErrors === 0) parts.push(zhCN.compilation.webScanEmpty)
    // E1：站点同步失败 → 明确告知，别让用户以为"网页资料没用上是因为没内容"
    if (ws.siteErrors > 0) parts.push(zhCN.compilation.webScanSiteErrors.replace('{count}', String(ws.siteErrors)))
  }
  /*
   * 第二组 ⑤（2026-10-06）：生成汇总气泡里如实带一句"本轮送了多少段/字、多少段因无信号未送"。
   * 用户明确要求汇报口径如此——被跳过的材料**仍在库中**，必须在同一句里说清，避免被读成"资料被删了"。
   */
  const cv = scans.convergence
  if (cv) {
    parts.push(
      zhCN.compilation.convergenceSummary
        .replace('{segments}', String(cv.keptSegments))
        .replace('{wan}', (cv.keptChars / 10000).toFixed(1))
        .replace('{sources}', String(Math.max(0, cv.sources - cv.noSignalSources)))
        .replace('{dropped}', String(cv.droppedSegments))
    )
  } else {
    parts.push(
      zhCN.compilation.convergenceSummaryOff.replace('{segments}', String(scans.candidateChunks ?? 0))
    )
  }
  parts.push(pendingCount > 0 ? pendingCount + ' 组矛盾待处理' : '无未处理矛盾')
  let text = parts.join('，') + '。请审阅' + (pendingCount > 0 ? '并处理后' : '后') + '点击「确认汇编」。'
  if (scans.contradictionScan && scans.contradictionScan.ok === false) {
    text += ' 注意：' + zhCN.compilation.contradictionScanFailed.replace('{reason}', scans.contradictionScan.message ?? '未知')
  }
  if (ps && ps.ok === false) {
    text += ' 注意：' + zhCN.compilation.extractScanFailed.replace('{reason}', ps.message ?? '未知')
  }
  return text
}

/** 撰写工作台的「生成中」临时状态（跨任务切换用模块级 Map 快照恢复） */
interface WritingTransient {
  busy: BusyState
  busyText: string | null
  progress: { percent: number; etaSeconds?: number } | null
  compilationProgress: { percent: number; etaSeconds?: number; fetch?: { active: boolean; paused: boolean } } | null
  compilationInterrupt: { stage: string; message: string; percent: number } | null
  streamText: string | null
}
const transientByTask = new Map<string, WritingTransient>()
// 前端 429 自动续传兜底参数（限流中断时自动调用 continueCompilation；上限与递增延迟，避免无限重试）
const AUTO_RESUME_LIMIT = 2
const AUTO_RESUME_DELAYS_MS = [8000, 20000]

function WritingWorkspace({ taskId, mode, onChanged, reloadKey, onGoBuildCache }: { taskId: string; mode: 'compile' | 'draft'; onChanged: () => void; reloadKey?: number; onGoBuildCache?: () => void }) {
  const [task, setTask] = useState<TaskItem | null>(null)
  const [draft, setDraft] = useState<DraftItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessageItem[]>([])
  const [busy, setBusy] = useState<BusyState>(null)
  const [busyText, setBusyText] = useState<string | null>(null)
  const [streamText, setStreamText] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ percent: number; etaSeconds?: number } | null>(null)
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false)
  const [contradictions, setContradictions] = useState<Contradiction[]>([])
  const [dialogState, setDialogState] = useState<
    | { kind: 'contradiction' | 'warning'; mode: 'overview' }
    | { kind: 'contradiction' | 'warning'; mode: 'single'; seq: number }
    | null
  >(null)
  const [sourceRefs, setSourceRefs] = useState<SourceRefItem[]>([])
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const editorRef = useRef<DraftEditorHandle>(null)
  const adoptionSnapshotsRef = useRef(new Map<string, Contradiction[]>())
  const contradictionsRef = useRef(contradictions)
  contradictionsRef.current = contradictions

  // ---- 功能区（生成汇编 / 撰写初稿）----
  const [draftPhase, setDraftPhase] = useState<DraftPhase>('import')
  const [compilation, setCompilation] = useState<CompilationView | null>(null)
  // 「撰写初稿」导入资料汇编：可导入的已完成汇编列表 + 选中项
  const [importOptions, setImportOptions] = useState<{ taskId: string; taskTitle: string; compilation: CompilationView }[]>([])
  const [importing, setImporting] = useState(false)
  // 「生成汇编」导出菜单
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [compilationMeta, setCompilationMeta] = useState<{ candidateChunks?: number; candidateSources?: number } | null>(null)
  const [undoAvailable, setUndoAvailable] = useState(0)
  const [redoAvailable, setRedoAvailable] = useState(0)
  const [compilationProgress, setCompilationProgress] = useState<{ percent: number; etaSeconds?: number; fetch?: { active: boolean; paused: boolean } } | null>(null)
  /**
   * 2026-10-05（用户要求）：抓取暂停态。渲染层自己记一份 → 点按钮后**立刻**反馈（按钮文字与提示文本立即切换），
   * 同时通知主进程让抓取池在下一篇之前等待；点「继续抓取」再由主进程接着跑。
   */
  const [fetchPaused, setFetchPaused] = useState(false)
  const handleToggleFetchPause = useCallback((paused: boolean): void => {
    setFetchPaused(paused)
    void window.api.webSourceSetCrawlPaused(paused)
  }, [])
  const [compilationInterrupt, setCompilationInterrupt] = useState<{ stage: string; message: string; percent: number; retryable?: boolean } | null>(null)
  const [compilationInstruction, setCompilationInstruction] = useState('')
  /* ---- Phase 7.4/7.5：版本（对话修改后自动进入复核态） ---- */
  const [versions, setVersions] = useState<CompilationVersionView[]>([])
  const [versionDiff, setVersionDiff] = useState<CompilationVersionDiffView | null>(null)
  /** 本次对话修改产生的版本号（复核条上标注用） */
  const [reviewVersionNo, setReviewVersionNo] = useState<number | null>(null)
  const [onlyChanged, setOnlyChanged] = useState(false)
  /* ---- Phase 7.5：悬浮对话框（人机协同编辑） ---- */
  const [docMessages, setDocMessages] = useState<CompilationMessageView[]>([])
  const [docEditing, setDocEditing] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
  const [docChangedIds, setDocChangedIds] = useState<string[]>([])
  /** 第三批 A1：最近一次生成的网页材料情况（面板据此提示"已锁定 N 篇 / 新文章 M 篇"） */
  const [lastWebScan, setLastWebScan] = useState<CompilationWebScan | null>(null)
  /** 「重新生成汇编」二次确认（会替换当前汇编为新的一版） */
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false)

  /** 读取某汇编的版本列表（用于乐观锁的 baseVersionNo；不再有版本下拉/对比开关） */
  const loadVersions = useCallback(async (compilationId: string): Promise<void> => {
    const res = await window.api.listCompilationVersions(compilationId)
    if (res.ok && res.data) setVersions((res.data.versions ?? []) as CompilationVersionView[])
  }, [])

  // 汇编变化后刷新版本列表（对话修改 / 生成会产生新版本，主进程是权威来源）
  useEffect(() => {
    if (compilation?.id) void loadVersions(compilation.id)
    else setVersions([])
  }, [compilation, loadVersions])

  /* ---- Phase 7.5：与文档对话（大模型按 ops 修改汇编；软件内改动汇编的唯一入口） ---- */
  // 换汇编时清空对话、复核态与错误
  useEffect(() => {
    setDocMessages([])
    setDocError(null)
    setDocChangedIds([])
    setVersionDiff(null)
    setReviewVersionNo(null)
    setOnlyChanged(false)
    setDocEditing(false)
  }, [compilation?.id])

  const loadDocMessages = useCallback(async (compilationId: string): Promise<void> => {
    const res = await window.api.listCompilationMessages(compilationId)
    if (res.ok && res.data) setDocMessages((res.data.messages ?? []) as CompilationMessageView[])
  }, [])

  /**
   * 发送一条修改要求：主进程读取当前文档 → 调大模型 → 逐条校验 ops → 应用并记一个版本。
   * 失败（未配置模型 / 调用失败 / 格式无法解析 / 乐观锁冲突）**文档不变**，只回错误。
   * 成功则把主进程算好的「本次修改前后差异」置上 → **自动进入复核态**（用户 2026-09-10 裁定：
   * 不再需要用户手点「与上一版对比」按钮，直接给出「采纳 / 回退」）。
   * 返回给用户看的回复文本，供左侧对话框复用（右侧悬浮面板只读 docMessages）。
   */
  const handleDocSend = useCallback(
    async (instruction: string): Promise<{ ok: boolean; reply: string }> => {
      const text = (instruction ?? '').trim()
      if (!compilation || docEditing || !text) return { ok: false, reply: '' }
      setDocEditing(true)
      setDocError(null)
      setDocChangedIds([])
      setVersionDiff(null)
      setOnlyChanged(false)
      // 用户消息先本地显示（主进程也会写入 compilation_messages，成功后整体回读覆盖，不会重复）
      setDocMessages((prev) => [...prev, { role: 'user', content: text, createdAt: new Date().toISOString() }])
      try {
        const baseVersionNo = versions.length > 0 ? versions[versions.length - 1].versionNo : undefined
        const res = await window.api.editCompilationDoc(compilation.id, text, baseVersionNo)
        if (res.ok && res.data) {
          setCompilation(res.data.compilation as CompilationView)
          setDocChangedIds(res.data.changedIds ?? [])
          // **自动进入复核态**：主进程已算好"本次修改前后"的差异，用户只需「采纳 / 回退」
          setVersionDiff(res.data.diff as unknown as CompilationVersionDiffView)
          setReviewVersionNo(res.data.versionNo ?? null)
          await loadDocMessages(compilation.id)
          return { ok: true, reply: res.data.reply }
        }
        const msg = res.error?.message ?? '调用大模型失败'
        setDocError(msg)
        setDocMessages((prev) => [...prev, { role: 'assistant', content: '修改失败：' + msg, createdAt: new Date().toISOString() }])
        if (res.error?.code === 'VERSION_CONFLICT') await loadVersions(compilation.id)
        return { ok: false, reply: '修改失败：' + msg }
      } catch {
        const msg = '调用主进程出错，请确认应用已完整重启'
        setDocError(msg)
        setDocMessages((prev) => [...prev, { role: 'assistant', content: msg, createdAt: new Date().toISOString() }])
        return { ok: false, reply: msg }
      } finally {
        setDocEditing(false)
      }
    },
    [compilation, docEditing, versions, loadDocMessages, loadVersions]
  )
  // 前端 429 自动续传兜底：限流中断时自动调用 continueCompilation（上限限制，避免无限重试）
  const autoResumeAttemptRef = useRef(0)
  // ---- 矛盾回收站（Phase 6.1 优化） ----
  const [showRecycleBin, setShowRecycleBin] = useState(false)
  const [recycleBinItems, setRecycleBinItems] = useState<CompilationRecycleBinItem[]>([])
  // ---- 规范文档库入口（Phase 6.4.1） ----
  const [showStyleGuide, setShowStyleGuide] = useState(false)
  // ---- 左右分栏宽度（可拖拽，去除间隔） ----
  const [chatWidth, setChatWidth] = useState(380)
  const handleChatResize = useCallback((delta: number) => {
    setChatWidth((prev) => Math.max(320, Math.min(820, prev + delta)))
  }, [])

  // ---- Phase 8 / S1：右侧「来源」分栏（点段落来源 → 就地打开并定位）；Phase 9 / S4 起只报"页/段" ----
  const [sourcePane, setSourcePane] = useState<{ sourceId: string; locate?: SourceLocateAnchor; highlight?: string } | null>(null)
  const [sourceWidth, setSourceWidth] = useState(480)
  const handleSourceResize = useCallback((delta: number) => {
    // 分栏在右侧：向左拖（delta < 0）应把分栏拉宽
    setSourceWidth((prev) => Math.max(320, Math.min(900, prev - delta)))
  }, [])

  // 跨任务切换保留「生成中」临时状态（busy / busyText / progress / compilationProgress / streamText）：
  // 用模块级 Map 按 taskId 快照——挂载时恢复、卸载时保存，避免切走再切回时进度条消息消失（组件仍按任务 key 挂载）。
  const liveTransientRef = useRef<WritingTransient>({ busy: null, busyText: null, progress: null, compilationProgress: null, compilationInterrupt: null, streamText: null })
  liveTransientRef.current = { busy, busyText, progress, compilationProgress, compilationInterrupt, streamText }
  useEffect(() => {
    const snap = transientByTask.get(taskId)
    if (snap) {
      setBusy(snap.busy ?? null)
      setBusyText(snap.busyText ?? null)
      setProgress(snap.progress ?? null)
      setCompilationProgress(snap.compilationProgress ?? null)
      setCompilationInterrupt(snap.compilationInterrupt ?? null)
      setStreamText(snap.streamText ?? null)
    }
    return () => { transientByTask.set(taskId, liveTransientRef.current) }
  }, [taskId])

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const tRes = await window.api.listTasks()
      const found = tRes.ok && tRes.data
        ? (tRes.data.items as TaskItem[]).find((t) => t.id === taskId) ?? null
        : null
      setTask(found)
      if (!found) return

      const vRes = await window.api.getLatestDraftByTask(taskId)
      const latest = vRes.ok && vRes.data ? ((vRes.data as { draft: DraftItem | null }).draft ?? null) : null
      let hasDraft = false
      if (latest) {
        hasDraft = true
        setDraft(latest)
        const cRes = await window.api.getDraftContradictions(latest.id)
        if (cRes.ok && cRes.data) {
          setContradictions(cRes.data.contradictions as unknown as Contradiction[])
        } else {
          setContradictions([])
        }
      } else {
        setDraft(null)
        setContradictions([])
      }

      let comp: CompilationView | null = null
      const compRes = await window.api.listCompilations(taskId)
      if (compRes.ok && compRes.data && Array.isArray(compRes.data.compilations) && compRes.data.compilations.length > 0) {
        comp = compRes.data.compilations[0] as CompilationView
      }
      setCompilation(comp)
      // 恢复汇编指令（供“重新生成汇编”使用；编译的 title 存的就是用户完整撰写要求）
      setCompilationInstruction(comp?.title ?? '')

      if (mode === 'compile') {
        setDraftPhase(comp ? 'style' : 'import')
      } else {
        // 撰写初稿：已有汇编（已导入）则进入规范/撰写；否则停留在导入页
        setDraftPhase(comp ? (hasDraft ? 'write' : 'style') : 'import')
      }
      if (mode === 'draft') {
        const optRes = await window.api.listFinalizedCompilationsForImport()
        if (optRes.ok && optRes.data) {
          setImportOptions(optRes.data.items as { taskId: string; taskTitle: string; compilation: CompilationView }[])
        } else {
          setImportOptions([])
        }
      }

      const mRes = await window.api.listTaskMessages(taskId)
      if (mRes.ok && mRes.data) {
        setMessages(mRes.data.items.map((m) => ({ role: m.role, content: m.content })))
      }
    } catch {
      setErr(zhCN.writingWorkspace.loadFailed.replace('{message}', ''))
    } finally {
      setLoading(false)
    }
  }, [taskId, reloadKey])

  useEffect(() => { load() }, [load])

  /**
   * 加载「来源位置」覆盖情况（Phase 9 / S4 补）：锚点是生成后台**异步**算的，
   * 不查一次就完全看不见（用户只能一条条点圆标才发现"有的段没位置"）。
   * 汇编切换 / 生成完成 / 重新生成后刷新；锚点是断点式写入，界面顺手延迟一拍再取。
   */
  const [anchorStats, setAnchorStats] = useState<{ total: number; anchored: number; withPage: number; ambiguous: number } | null>(null)
  /*
   * 2026-10-05 用户裁定：「疑似超出范围 N 段」这类提示**无实际价值，已整体关闭**——
   * 越界段落直接保留在汇编里（不做任何自动移出）。原先在这里的 `scopeCheck` 状态、查询 effect、
   * `refreshScopeCheck` 与 `handleExcludeItems`（移出汇编）全部删除，不再调用 `compilation:scopeCheck` /
   * `compilation:excludeItems`；主进程引擎与通道保留不动，以免影响导出导入与旧数据。
   */
  useEffect(() => {
    if (!compilation?.id) {
      setAnchorStats(null)
      return
    }
    let alive = true
    const id = compilation.id
    const load = async (): Promise<void> => {
      const res = await window.api.getAnchorStats(id)
      if (alive && res.ok && res.data) setAnchorStats(res.data)
    }
    void load()
    const timer = window.setTimeout(() => void load(), 4000) // 生成刚结束后台还在写锚点 → 再取一次
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [compilation?.id, busy, reloadKey])

  useEffect(() => {
    const off = window.api.onDraftGenerateProgress?.((p) => {
      if (p.taskId === taskId) {
        setBusyText(p.stage)
        setProgress({ percent: p.percent, etaSeconds: p.etaSeconds })
      }
    })
    return () => { off?.() }
  }, [taskId])

  useEffect(() => {
    const off = window.api.onCompilationProgress?.((p) => {
      if (p.taskId === taskId) {
        setBusyText(p.stage)
        setCompilationProgress({ percent: p.percent, etaSeconds: p.etaSeconds, fetch: p.fetch })
        if (p.candidateChunks != null) {
          setCompilationMeta({ candidateChunks: p.candidateChunks, candidateSources: p.candidateSources })
        }
      }
    })
    return () => { off?.() }
  }, [taskId])

  useEffect(() => {
    const off = window.api.onWritingStreamDelta?.((p) => {
      if (p.taskId === taskId) {
        setStreamText((prev) => (prev ?? '') + p.text)
      }
    })
    return () => { off?.() }
  }, [taskId])

  const appendAssistant = (text: string) => {
    setMessages((prev) => [...prev, { role: 'assistant', content: text }])
  }

  // 订阅生成/续传过程中的建议提示（Phase A/B：429 限流后建议降低 Provider 并发数），翻译为中文并持久化
  useEffect(() => {
    const off = window.api.onCompilationAdvice?.((p) => {
      if (p.taskId !== taskId) return
      const msg = p.kind === 'reduce-concurrency' ? zhCN.compilation.adviceReduceConcurrency : ''
      if (!msg) return
      appendAssistant(msg)
      void window.api.addTaskMessage(taskId, 'assistant', msg, 'notice')
    })
    return () => { off?.() }
  }, [taskId, appendAssistant])

  const reloadMessages = useCallback(async () => {
    const res = await window.api.listTaskMessages(taskId)
    if (res.ok && res.data) {
      setMessages(res.data.items.map((m) => ({ role: m.role, content: m.content })))
    }
  }, [taskId])

  /** 刷新当前汇编的可撤销/可恢复步数（每次汇编变化后调用） */
  const refreshUndoState = useCallback(async (compilationId: string) => {
    const res = await window.api.getCompilationUndoState(compilationId)
    if (res.ok && res.data) {
      setUndoAvailable(res.data.undoAvailable)
      setRedoAvailable(res.data.redoAvailable)
    }
  }, [])

  // 汇编一旦变化（任何操作后），同步一次撤销/恢复可用步数
  useEffect(() => {
    if (compilation) void refreshUndoState(compilation.id)
  }, [compilation, refreshUndoState])

  const handleUndo = async () => {
    if (!compilation || busy) return
    try {
      const res = await window.api.undoCompilation(compilation.id)
      if (res.ok && res.data) {
        setCompilation(res.data.compilation as CompilationView)
        setUndoAvailable(res.data.undoAvailable)
        setRedoAvailable(res.data.redoAvailable)
      } else {
        appendAssistant('撤销失败：' + (res.error?.message ?? ''))
      }
    } catch {
      appendAssistant('撤销失败：请确认应用已完整重启')
    }
  }

  const handleRedo = async () => {
    if (!compilation || busy) return
    try {
      const res = await window.api.redoCompilation(compilation.id)
      if (res.ok && res.data) {
        setCompilation(res.data.compilation as CompilationView)
        setUndoAvailable(res.data.undoAvailable)
        setRedoAvailable(res.data.redoAvailable)
      } else {
        appendAssistant('恢复失败：' + (res.error?.message ?? ''))
      }
    } catch {
      appendAssistant('恢复失败：请确认应用已完整重启')
    }
  }

  const resetBusy = () => {
    setBusy(null)
    setBusyText(null)
    setProgress(null)
    setStreamText(null)
    setCompilationProgress(null)
  }

  // ---- 资料汇编（Phase 6.2）----

  /*
   * 资料年份范围（2026-10-05 用户裁定）：**在任务流程里**选——新建任务、第一次发撰写要求时，
   * 输入框上方内联选择；每个任务各存一份（`writing_tasks.web_year_from/to`）。
   * 这里用 ref 记「控件刚改成什么」，生成前会**再等一次写库**（见 handleGenerateCompilation）：
   * 主进程抓取时按任务级区间筛目录，若写库还在路上就会按旧区间抓一整轮。
   */
  const pendingWebYearsRef = useRef<{ from: number; to: number } | null>(null)
  /** 年份区间规模预览（"区间内 N 篇 / 占比 / 预计抓取时长"）——文案在这里拼好，控件只呈现 */
  const [webYearsPreview, setWebYearsPreview] = useState<{ text: string; distribution?: string | null; warning?: string | null } | null>(null)
  /** 预览请求自增序号：只认最后一次请求的响应（防旧响应覆盖新结果） */
  const webYearsPreviewSeqRef = useRef(0)
  /**
   * 只读统计"该区间有多少篇、预计抓多久"（主进程查目录，不抓正文）。
   * 年份控件在输入两个合法年份后按 400ms 防抖回调到这里；`null` = 输入不合法 → 清掉预览。
   * 说明：年份与预览从资料库面板搬到任务流程（2026-10-05 用户裁定 A），原先在面板里的 `loadStats`/`yearPreview` 即此逻辑。
   */
  const handleWebYearsPreviewQuery = useCallback(async (years: { from: number; to: number } | null): Promise<void> => {
    if (!years) {
      // 递增序号 → 之前已发出的请求回来时会被丢弃，避免"清空后又被旧结果填回"
      webYearsPreviewSeqRef.current += 1
      setWebYearsPreview((cur) => (cur === null ? cur : null))
      return
    }
    /*
     * 竞态防护（2026-10-05 P6 复查补）：用户快速改年（2005→2012→2015）时会并发发出多个统计请求，
     * 主进程返回顺序不保证 → 旧响应可能后到，把预览覆盖成上一个区间的数字（界面出现"框里 2012、预览写 2005–2020"）。
     * 用自增序号只认**最后一次**请求的结果。
     */
    webYearsPreviewSeqRef.current += 1
    const seq = webYearsPreviewSeqRef.current
    const res = await window.api.webSourceDateStats(years.from, years.to)
    if (seq !== webYearsPreviewSeqRef.current) return
    if (!res.ok || !res.data) {
      setWebYearsPreview({ text: zhCN.compilation.webYearPreviewError.replace('{message}', res.error?.message ?? '') })
      return
    }
    const s = res.data.stats as {
      total: number
      dated: number
      unknown: number
      inRange: number
      inRangeByYear: { year: string; count: number }[]
      estimatedMinutes: number
    }
    const pct = s.total > 0 ? ((s.inRange / s.total) * 100).toFixed(1) : '0.0'
    setWebYearsPreview({
      text: zhCN.compilation.webYearPreview
        .replace('{from}', String(years.from))
        .replace('{to}', String(years.to))
        .replace('{inRange}', String(s.inRange))
        .replace('{pct}', pct)
        .replace('{dated}', String(s.dated))
        .replace('{unknown}', String(s.unknown))
        .replace('{minutes}', String(s.estimatedMinutes)),
      distribution:
        s.inRangeByYear.length > 0
          ? zhCN.compilation.webYearDistribution + s.inRangeByYear.map((r) => `${r.year}(${r.count})`).join(' ')
          : null,
      warning: s.dated === 0 && s.total > 0 ? zhCN.compilation.webYearPreviewNoDates : null
    })
  }, [])

  const handleWebYearsChange = (from: number, to: number): void => {
    if (!task) return
    pendingWebYearsRef.current = { from, to }
    setTask((cur) => (cur ? { ...cur, webYearFrom: from, webYearTo: to } : cur))
    // 即时保存（主进程同时把全局默认更新为同一区间 → 下个新任务据此预填）
    void window.api.setTaskWebYears(task.id, from, to)
  }

  /**
   * 「取消生成」后把刚提交的文字回填输入框（2026-10-05 用户要求）。
   * `ChatPanel` 的输入框是它自己的 state，父组件只能靠这个**自增触发值**回填——用 `seq` 而不是
   * 直接比文本，是为了让「同一段文字被取消两次」也能回填（见 `ChatPanel` 的 `restoreDraft`）。
   */
  const [restoreDraft, setRestoreDraft] = useState<{ text: string; seq: number } | null>(null)
  const requestRestoreDraft = useCallback((text: string): void => {
    setRestoreDraft((cur) => ({ text, seq: (cur?.seq ?? 0) + 1 }))
  }, [])

  /**
   * 材料规模确认框的正文（2026-10-05 P1）：成品文案在 `zh-CN` 里，这里只做占位替换。
   * `{wan}` 用"万字"（1 位小数）——用户是按"多少万字"估耗时的。
   */
  const buildMaterialEstimateMessage = (est: {
    segments: number
    chars: number
    localSegments: number
    webSegments: number
    estimatedWindows: number
    estimatedMinutes: number
    fullSegments?: number
    fullChars?: number
    fullEstimatedWindows?: number
    fullEstimatedMinutes?: number
    droppedSegments?: number
    converged?: boolean
  }, skipConvergence: boolean): string => {
    const text = zhCN.compilation.materialEstimateBody
      .replace('{segments}', String(est.segments))
      .replace('{wan}', (est.chars / 10000).toFixed(1))
      .replace('{local}', String(est.localSegments))
      .replace('{web}', String(est.webSegments))
      .replace('{windows}', String(est.estimatedWindows))
      .replace('{minutes}', String(est.estimatedMinutes))
      .replace('{dropped}', String(est.droppedSegments ?? 0))
      .replace('{fullSegments}', String(est.fullSegments ?? est.segments))
      .replace('{fullWan}', ((est.fullChars ?? est.chars) / 10000).toFixed(1))
      .replace('{fullWindows}', String(est.fullEstimatedWindows ?? est.estimatedWindows))
      .replace('{fullMinutes}', String(est.fullEstimatedMinutes ?? est.estimatedMinutes))
    // 勾上"全量送入"时，正文要说清这一轮按哪个口径来（估算两套数都在，别让用户以为数字对不上）
    return skipConvergence ? text + '\n' + zhCN.compilation.materialEstimateConvergeSkipNote : text
  }

  /** 预检估算里界面要用到的字段（与 IPC `CompilationEstimateMaterialsRes` 同形） */
  type MaterialEstimateView = Parameters<typeof buildMaterialEstimateMessage>[0]

  /**
   * 2026-10-06（Phase 11 E 用户需求 ②）：把就绪检查的原始数字拼成一句人话。
   * 口径必须与主进程 `describeReadiness` 一致：**只列真正缺的**，并把"不算缺口"的两种
   * （白名单外、日期未知）如实摆出来——不让用户以为"怎么建都建不完"。
   * 这里用「；」串成一段（`ConfirmDialog` 的 message 是纯文本 `<p>`，不走 Markdown、也不认换行）。
   */
  function buildNotReadyMessage(r: CompilationReadiness): string {
    const c = zhCN.compilation
    const lacks: string[] = []
    if (r.reasons.includes('build-running')) lacks.push(c.notReadyBuilding)
    if (r.reasons.includes('web-pending')) {
      lacks.push(
        c.notReadyWeb
          .replace('{from}', String(r.fromYear ?? '?'))
          .replace('{to}', String(r.toYear ?? '?'))
          .replace('{pending}', String(r.webPending))
          .replace('{minutes}', String(r.estimatedMinutes))
      )
    }
    if (r.reasons.includes('local-pending')) {
      lacks.push(c.notReadyLocalPending.replace('{count}', String(r.localPending + r.localIndexing)))
    }
    if (r.reasons.includes('local-index-failed')) lacks.push(c.notReadyLocalFailed.replace('{count}', String(r.localFailed)))
    const notes: string[] = []
    if (r.webCached > 0) notes.push(c.notReadyAlready.replace('{cached}', String(r.webCached)))
    if (r.webBlocked > 0) notes.push(c.notReadyBlocked.replace('{blocked}', String(r.webBlocked)))
    if (r.webUndated > 0) notes.push(c.notReadyUndated.replace('{undated}', String(r.webUndated)))
    return c.notReadyBody + lacks.join('；') + '。' + notes.join('')
  }

  /**
   * 生成前的「材料规模」确认（2026-10-05 用户要求 P1）：非空 = 弹窗打开。
   * 动机（用户实测）：材料规模只有跑完"召回 + 闸门"才知道，上次**跑到一半**才发现要 20 多分钟；
   * 因此真正开始生成之前先把预计规模与耗时报出来。**只提示、不限制**：确认后走原生成流程，取消则什么都不生成。
   */
  const [materialEstimate, setMaterialEstimate] = useState<{
    instruction: string
    message: string
    error?: string
    /** 估算原始数据（勾选/取消"全量送入"时用它重算正文，两个口径都摆得出来） */
    data?: MaterialEstimateView
  } | null>(null)

  /**
   * 第二组 ⑤ 的**逃生门**（2026-10-06 用户已同意）：勾选则本轮不做收敛（全量送入），跳过"文章内取段"。
   * **每次生成单独选择、不持久化**：每次打开确认框都复位为 false（默认收敛）。
   */
  const [skipConvergence, setSkipConvergence] = useState(false)

  /**
   * 2026-10-06（Phase 11 E 用户需求 ②；用户裁定 1A「**严格阻断、无逃生门**」）：
   * 本次生成要用到的资料尚未建立缓存/索引时，只弹这个阻断框——**没有"仍然生成"这个选项**。
   * 唯一的出口是去设置页「建立缓存与索引」把它建起来。
   */
  const [notReady, setNotReady] = useState<{ instruction: string; readiness: CompilationReadiness } | null>(null)

  /** 生成入口：先**只读**估算材料规模（不消耗额度、不落库）→ 弹一次确认 → 才开始原来的生成流程 */
  const handleGenerateCompilation = async (instruction: string) => {
    if (busy) return
    const inst = instruction.trim()
    if (!inst) return
    // 生成前确保年份区间已落库（用户可能刚改完就按了发送）
    const pendingYears = pendingWebYearsRef.current
    if (pendingYears) {
      const yRes = await window.api.setTaskWebYears(taskId, pendingYears.from, pendingYears.to)
      if (!yRes.ok) {
        setErr(zhCN.compilation.webYearSaveFailed.replace('{message}', yRes.error?.message ?? ''))
        // 没能开始生成 → 把刚提交的要求放回输入框，不让用户重敲一遍
        requestRestoreDraft(instruction)
        return
      }
      pendingWebYearsRef.current = null
      setTask((cur) => (cur ? { ...cur, webYearFrom: pendingYears.from, webYearTo: pendingYears.to } : cur))
    }
    /*
     * 估算期间用 busy 如实显示"正在估算…"，估完**立刻**清掉再弹框——界面既不会看起来没反应，
     * 也不会卡在「生成中」。估算失败**不阻断**（只提示不限制）：照常弹确认框，由用户决定要不要继续。
     */
    setBusy('generating')
    setBusyText(zhCN.compilation.estimating)
    /*
     * ⓪ 生成前闸门（Phase 11 E）：先问主进程"本轮要用到的资料都建立好了吗"（只读、不花钱）。
     * 未就绪 → **直接弹阻断框，连估算都不做**（估了也不能生成，白等）。
     * 闸门查询本身失败**不阻断**：主进程在真正生成时还会再查一次，那里才是唯一真相。
     */
    try {
      const rd = typeof window.api.compilationReadiness === 'function' ? await window.api.compilationReadiness(taskId) : null
      if (rd?.ok && rd.data && !rd.data.ready) {
        setBusy(null)
        setBusyText(null)
        setNotReady({ instruction, readiness: rd.data })
        return
      }
    } catch {
      /* 桥不可用/查询失败：交给主进程在生成时拒绝（不在这里假装已知） */
    }
    let message: string = zhCN.compilation.materialEstimateUnavailable
    let estError: string | undefined
    let estData: MaterialEstimateView | undefined
    try {
      const est = await window.api.estimateCompilationMaterials(taskId, inst)
      if (est.ok && est.data) {
        estData = est.data
        message = buildMaterialEstimateMessage(est.data, false)
      } else estError = zhCN.compilation.materialEstimateError.replace('{message}', est.error?.message ?? '')
    } catch (e) {
      estError = zhCN.compilation.materialEstimateError.replace('{message}', String(e))
    } finally {
      setBusy(null)
      setBusyText(null)
    }
    // 每次进入确认框都回到"默认收敛"（逃生门是**单次**选择，不持久化、不跨轮继承）
    setSkipConvergence(false)
    setMaterialEstimate({
      instruction: inst,
      message,
      ...(estData ? { data: estData } : {}),
      ...(estError ? { error: estError } : {})
    })
  }

  /**
   * 真正开始生成资料汇编（在材料规模确认框里点「继续生成」之后调用；主体与原来的生成流程一致）
   * `skipConvergence` = 第二组 ⑤ 的逃生门（本轮不做收敛、全量送入），**每次生成单独选择**。
   */
  const startCompilationGeneration = async (instruction: string, skipConvergence = false) => {
    const inst = instruction.trim()
    setCompilationInstruction(inst)
    setMessages((prev) => [...prev, { role: 'user', content: instruction }])
    setBusy('generating')
    setBusyText(zhCN.compilation.generating)
    setStreamText(null)
    setCompilationProgress(null)
    setCompilationInterrupt(null)
    setFetchPaused(false)
    autoResumeAttemptRef.current = 0
    let keepProgress = false
    try {
      const res = await window.api.generateCompilation(taskId, inst, skipConvergence)
      if (res.ok && res.data) {
        const data = res.data as {
          compilation: CompilationView
          contradictionScan?: { ok: boolean; message?: string }
          extractScan?: {
            ok: boolean
            message?: string
            inputCards?: number
            outputParagraphs?: number
            inputChars?: number
            outputChars?: number
            accepted?: number
            degraded?: number
            invalidNumbers?: number
            invalidEvidence?: number
            degradedFromEvidence?: number
            evidenceLoose?: number
            droppedUnverifiable?: number
            droppedUnparseable?: number
            droppedCards?: number
            omitted?: number
            duplicatesDropped?: number
            conflictsKept?: number
            titleOnlyDropped?: number
            timeUnsupported?: number
          }
          webScan?: {
            sites: number
            siteErrors: number
            hits: number
            fetched: number
            chars: number
            relevanceDropped?: number
            invalidBody?: number
            shortBody?: number
            templateRepeat?: number
            fetchFailed?: number
            blocked?: number
            cacheHits?: number
            downgrades?: number
          }
          /* 第二组 ⑤：本轮的取段统计与"真正送细读"的段数（汇总气泡要如实带一句） */
          convergence?: {
            contextRange: number
            gatedSegments: number
            gatedChars: number
            sources: number
            keptSegments: number
            keptChars: number
            droppedSegments: number
            droppedChars: number
            noSignalSources: number
          }
          candidateChunks?: number
          interrupted?: { stage: string; message: string; percent: number; retryable?: boolean }
        }
        const comp = data.compilation
        setCompilation(comp)
        if (data.interrupted) {
          // 大模型异常中断：保留进度（冻结在中断处），展示「尝试继续」
          keepProgress = true
          setCompilationProgress({ percent: data.interrupted.percent })
          setCompilationInterrupt(data.interrupted)
          const msg = zhCN.compilation.interruptedMessage.replace('{stage}', data.interrupted.stage).replace('{reason}', data.interrupted.message)
          appendAssistant(msg)
          void window.api.addTaskMessage(taskId, 'assistant', msg, 'notice')
          // 429 限流：自动续传兜底（有限次自动调用 continueCompilation），否则留待用户点击「尝试继续」
          if (data.interrupted.retryable && autoResumeAttemptRef.current < AUTO_RESUME_LIMIT) {
            autoResumeAttemptRef.current += 1
            const delay = AUTO_RESUME_DELAYS_MS[autoResumeAttemptRef.current - 1] ?? 20000
            setTimeout(() => { void handleContinueCompilation() }, delay)
          }
        } else {
          setCompilationInterrupt(null)
          setLastWebScan(data.webScan ?? null)
          const summary = buildGeneratedSummary('已生成资料汇编：', comp, data)
          appendAssistant(summary)
          void window.api.addTaskMessage(taskId, 'assistant', summary, 'notice')
          // 生成时主进程可能已把任务标题从「新建任务」自动改为大模型提取的标题，此处刷新任务列表以同步显示新标题
          onChanged()
        }
      } else if (res.error?.code === 'NOT_READY') {
        /*
         * 2026-10-06（Phase 11 E）：竞态被拒——界面刚检查通过、主进程这次查到"还没建齐"
         * （例如用户中途点了「建立」，或界面被绕过）。主进程是唯一真相：如实说明 + 补弹阻断框给出按钮。
         */
        const msg = res.error.message || zhCN.compilation.notReadyTitle
        appendAssistant(msg)
        void window.api.addTaskMessage(taskId, 'assistant', msg, 'notice')
        try {
          const rd = typeof window.api.compilationReadiness === 'function' ? await window.api.compilationReadiness(taskId) : null
          if (rd?.ok && rd.data) setNotReady({ instruction: instruction.trim(), readiness: rd.data })
        } catch {
          /* 拿不到明细也不影响"已被拒绝"这个事实（聊天里已有原话） */
        }
      } else {
        const msg = '生成资料汇编失败：' + (res.error?.message ?? '')
        appendAssistant(msg)
        void window.api.addTaskMessage(taskId, 'assistant', msg, 'notice')
      }
    } finally {
      if (keepProgress) {
        // 中断：清 busy（可点「尝试继续」），但保留进度条与中断信息
        setBusy(null)
        setBusyText(null)
        setStreamText(null)
      } else {
        resetBusy()
      }
      await reloadMessages()
    }
  }

  /** 从大模型异常中断处继续生成资料汇编（会话内断点续传） */
  const handleContinueCompilation = async () => {
    if (busy || !compilation) return
    const cid = compilation.id
    setBusy('generating')
    setBusyText(zhCN.compilation.continuing)
    setStreamText(null)
    setCompilationProgress(null)
    setCompilationInterrupt(null)
    let keepProgress = false
    try {
      const res = await window.api.continueCompilation(cid)
      if (res.ok && res.data) {
        const data = res.data as {
          compilation: CompilationView
          interrupted?: { stage: string; message: string; percent: number; retryable?: boolean }
          /* 续跑也带 ⑤ 的取段统计（状态里带着走），汇总气泡同样如实说一句 */
          convergence?: {
            contextRange: number
            gatedSegments: number
            gatedChars: number
            sources: number
            keptSegments: number
            keptChars: number
            droppedSegments: number
            droppedChars: number
            noSignalSources: number
          }
          candidateChunks?: number
        }
        const comp = data.compilation
        setCompilation(comp)
        if (data.interrupted) {
          // 续跑仍中断：再次展示中断信息
          keepProgress = true
          setCompilationProgress({ percent: data.interrupted.percent })
          setCompilationInterrupt(data.interrupted)
          const msg = zhCN.compilation.againInterrupted.replace('{stage}', data.interrupted.stage).replace('{reason}', data.interrupted.message)
          appendAssistant(msg)
          void window.api.addTaskMessage(taskId, 'assistant', msg, 'notice')
          // 429 限流：自动续传兜底（有限次，重复调用 continueCompilation），否则留待用户点击「尝试继续」
          if (data.interrupted.retryable && autoResumeAttemptRef.current < AUTO_RESUME_LIMIT) {
            autoResumeAttemptRef.current += 1
            const delay = AUTO_RESUME_DELAYS_MS[autoResumeAttemptRef.current - 1] ?? 20000
            setTimeout(() => { void handleContinueCompilation() }, delay)
          } else {
            autoResumeAttemptRef.current = 0
          }
        } else {
          autoResumeAttemptRef.current = 0
          setCompilationInterrupt(null)
          const summary = buildGeneratedSummary('已继续生成资料汇编：', comp, data)
          appendAssistant(summary)
          void window.api.addTaskMessage(taskId, 'assistant', summary, 'notice')
          onChanged()
        }
      } else {
        autoResumeAttemptRef.current = 0
        const msg = zhCN.compilation.continueFailed + (res.error?.message ?? '')
        appendAssistant(msg)
        void window.api.addTaskMessage(taskId, 'assistant', msg, 'notice')
      }
    } finally {
      if (keepProgress) {
        setBusy(null)
        setBusyText(null)
        setStreamText(null)
      } else {
        resetBusy()
      }
      await reloadMessages()
    }
  }

  /**
   * 7.6.1：原 `handleAdjustCompilation`（左栏「调整现有汇编」的消息入口）已随左栏一并删除——
   * 汇编的修改统一走右侧悬浮面板的 `handleDocSend`（`doc:edit` 后端），不再有第二个入口。
   */

  /** 「导出资料汇编」：先确认（finalize），再弹出格式选择 */
  const handleExportCompilation = async () => {
    if (!compilation || busy) return
    setExporting(true)
    try {
      if (compilation.status !== 'finalized') {
        const res = await window.api.confirmCompilation(compilation.id)
        if (res.ok && res.data) setCompilation(res.data.compilation as CompilationView)
      }
      setShowExportMenu(true)
    } finally {
      setExporting(false)
    }
  }

  const handleExportDocx = async () => {
    if (!compilation) return
    setShowExportMenu(false)
    setExporting(true)
    try {
      const res = await window.api.exportCompilationDocx(compilation.id)
      if (res.ok && res.data) {
        appendAssistant('已导出 Word 文档：' + (res.data as { path: string }).path)
      } else {
        appendAssistant('导出失败：' + (res.error?.message ?? ''))
      }
    } catch (e) {
      appendAssistant('导出失败：' + String(e))
    } finally {
      setExporting(false)
    }
  }

  const handleExportArchive = async () => {
    if (!compilation) return
    setShowExportMenu(false)
    setExporting(true)
    try {
      const res = await window.api.exportCompilationArchive(compilation.id)
      if (res.ok && res.data) {
        appendAssistant('已导出软件格式(.xzsc)：' + (res.data as { path: string }).path)
      } else {
        appendAssistant('导出失败：' + (res.error?.message ?? ''))
      }
    } catch (e) {
      appendAssistant('导出失败：' + String(e))
    } finally {
      setExporting(false)
    }
  }

  /** 「撰写初稿」从「生成汇编」已完成任务导入其资料汇编（深拷贝到本任务） */
  const handleImportFromTask = async (sourceCompilationId: string) => {
    if (importing) return
    setImporting(true)
    try {
      const res = await window.api.importCompilationFromTask(taskId, sourceCompilationId)
      if (res.ok && res.data) {
        const comp = res.data.compilation as CompilationView
        setCompilation(comp)
        setDraftPhase('style')
        appendAssistant(zhCN.draftArea.imported.replace('{title}', comp.title))
        onChanged()
      } else {
        appendAssistant(zhCN.draftArea.importFailed.replace('{message}', res.error?.message ?? ''))
      }
    } catch (e) {
      appendAssistant(zhCN.draftArea.importFailed.replace('{message}', String(e)))
    } finally {
      setImporting(false)
    }
  }

  /** 「撰写初稿」导入外部 .xzsc（当前预留：仅按钮 + 占位提示） */
  const handleImportExternal = async () => {
    appendAssistant(zhCN.draftArea.externalSoon)
  }

  /** 资料汇编卡片重新按时间排序（asc 正序 / desc 反序） */
  const handleReorderItems = async (direction: 'asc' | 'desc') => {
    if (!compilation || busy) return
    // 主进程/preload 改动不会热加载：若旧实例未重启，reorderCompilation 尚未暴露，给出明确提示
    if (typeof (window.api as { reorderCompilation?: unknown }).reorderCompilation !== 'function') {
      appendAssistant('排序功能尚未加载，请完全退出并重启应用后再试')
      return
    }
    try {
      const res = await window.api.reorderCompilation(compilation.id, direction)
      if (res.ok && res.data) {
        setCompilation(res.data.compilation as CompilationView)
      } else {
        appendAssistant('排序失败：' + (res.error?.message ?? ''))
      }
    } catch {
      appendAssistant('排序失败：调用主进程出错，请确认应用已完整重启')
    }
  }

  // ---- 矛盾回收站 ----
  const loadRecycleBin = useCallback(async (compilationId: string) => {
    const res = await window.api.listCompilationRecycleBin(compilationId)
    if (res.ok && res.data) {
      setRecycleBinItems(res.data.items as CompilationRecycleBinItem[])
    } else {
      setRecycleBinItems([])
    }
  }, [])

  const openRecycleBin = () => {
    if (!compilation) return
    setShowRecycleBin(true)
    void loadRecycleBin(compilation.id)
  }

  const handleRestoreRecycleBin = async (binId: string) => {
    const res = await window.api.restoreCompilationRecycleBin(binId)
    if (res.ok && res.data) {
      if (compilation) {
        const getRes = await window.api.getCompilation(compilation.id)
        if (getRes.ok && getRes.data) setCompilation(getRes.data.compilation as CompilationView)
        await loadRecycleBin(compilation.id)
      }
      appendAssistant(zhCN.compilation.restored)
    } else {
      appendAssistant('恢复回收站条目失败：' + (res.error?.message ?? ''))
    }
  }

  /** 复核「采纳」：改动已经落库，只需退出复核态 */
  const handleAcceptDocEdit = (): void => {
    setVersionDiff(null)
    setReviewVersionNo(null)
    setOnlyChanged(false)
  }

  /**
   * 复核「回退」：弹出撤销栈中**最近登记的一次操作**（也就是这次对话修改），把文档还原到修改前。
   * 刻意**不登记新版本**（用户 2026-09-10 明确要求：回退不是一次新改动，否则会凭空多出一版）。
   */
  const handleRevertDocEdit = async (): Promise<void> => {
    if (!compilation || busy) return
    try {
      const res = await window.api.undoCompilation(compilation.id)
      if (res.ok && res.data) {
        setCompilation(res.data.compilation as CompilationView)
        setUndoAvailable(res.data.undoAvailable)
        setRedoAvailable(res.data.redoAvailable)
        setVersionDiff(null)
        setReviewVersionNo(null)
        setOnlyChanged(false)
      } else {
        appendAssistant('回退失败：' + (res.error?.message ?? ''))
      }
    } catch {
      appendAssistant('回退失败：请确认应用已完整重启')
    }
  }

  const handleResolveContradiction = async (contradictionId: string, action: 'resolve' | 'ignore', chosenItemId?: string) => {
    const res = await window.api.resolveCompilationContradiction(contradictionId, action, chosenItemId)
    if (res.ok && res.data) {
      // 采纳后后端会删除该矛盾分组中未被采纳的卡片；重新拉取汇编以同步被删除的卡片
      if (compilation) {
        const getRes = await window.api.getCompilation(compilation.id)
        if (getRes.ok && getRes.data) {
          setCompilation(getRes.data.compilation as CompilationView)
        } else {
          const c = res.data.contradiction as CompilationView['contradictions'][number]
          setCompilation((cur) =>
            cur ? { ...cur, contradictions: cur.contradictions.map((g) => (g.id === contradictionId ? c : g)) } : cur
          )
        }
      }
    } else {
      appendAssistant('处理矛盾失败：' + (res.error?.message ?? ''))
    }
  }

  /**
   * 重新生成汇编（补上此前缺失的入口）：按当前撰写要求重跑一遍生成管线。
   * 网页材料沿用 A1 已锁定的那一批（不会重新抓取）；结果是一版新的汇编（新版本、新对话记录）。
   */
  const handleRegenerateCompilation = () => {
    const inst = (compilationInstruction || task?.userInstruction || '').trim()
    if (!inst) {
      appendAssistant(zhCN.writingChat.generateFailed.replace('{message}', '没有可用的撰写要求'))
      return
    }
    setRegenConfirmOpen(false)
    void handleGenerateCompilation(inst)
  }

  // ---- 初稿生成（Phase 6.3）----
  const handleGenerateDraft = async (instruction: string) => {
    if (busy) return
    setMessages((prev) => [...prev, { role: 'user', content: instruction }])
    setBusy('generating')
    setBusyText(zhCN.writingChat.generating)
    setStreamText(null)
    setProgress(null)
    try {
      if (compilation?.status !== 'finalized') {
        appendAssistant(zhCN.writingChat.needConfirmedCompilation)
        return
      }
      const res = await window.api.generateDraft(taskId, instruction, compilation.id)
      if (res.ok && res.data) {
        const data = res.data as { draft: DraftItem; articleTitle: string | null; contradictions?: Contradiction[] }
        setDraft(data.draft)
        setContradictions(data.contradictions ?? [])
        setTask((cur) => (cur ? { ...cur, articleTitle: data.articleTitle ?? undefined } : cur))
        onChanged()
      } else if (!res.ok) {
        appendAssistant(zhCN.writingChat.generateFailed.replace('{message}', res.error?.message ?? ''))
      }
      await reloadMessages()
    } catch (e) {
      appendAssistant(zhCN.writingChat.generateFailed.replace('{message}', String(e)))
    } finally {
      resetBusy()
    }
  }

  /** 「开始撰写」：从规范面板进入初稿撰写视图 */
  const handleStartWriting = (): void => {
    setDraftPhase('write')
  }

  /** 初稿视图返回规范面板 */
  const handleBackToStyle = (): void => {
    setDraftPhase('style')
  }

  const handleChat = async (message: string) => {
    if (busy) return
    const history = messagesRef.current.map((m) => ({ role: m.role, content: m.content }))
    setMessages((prev) => [...prev, { role: 'user', content: message }])
    setBusy('chatting')
    setBusyText(zhCN.writingChat.thinking)
    setStreamText(null)
    try {
      await window.api.chatWithTask(taskId, message, history)
      await reloadMessages()
    } catch (e) {
      appendAssistant(zhCN.writingChat.generateFailed.replace('{message}', String(e)))
    } finally {
      resetBusy()
    }
  }

  const handleRegenerate = async () => {
    setConfirmingRegenerate(false)
    if (busy) return
    const lastUser = [...messagesRef.current].reverse().find((m) => m.role === 'user')?.content ?? ''
    const instruction = (task?.userInstruction ?? '').trim() || lastUser
    if (!instruction) {
      appendAssistant(zhCN.writingChat.generateFailed.replace('{message}', '没有可用的撰写要求'))
      return
    }
    setBusy('generating')
    setBusyText(zhCN.writingChat.regenerating)
    setStreamText(null)
    try {
      if (compilation?.status !== 'finalized') {
        appendAssistant(zhCN.writingChat.needConfirmedCompilation)
        return
      }
      const res = await window.api.regenerateDraft(taskId, instruction, compilation.id)
      if (res.ok && res.data) {
        const data = res.data as { draft: DraftItem; articleTitle: string | null; contradictions?: Contradiction[] }
        setDraft(data.draft)
        setContradictions(data.contradictions ?? [])
        setTask((cur) => (cur ? { ...cur, articleTitle: data.articleTitle ?? undefined } : cur))
        onChanged()
      } else if (!res.ok) {
        appendAssistant(zhCN.writingChat.generateFailed.replace('{message}', res.error?.message ?? ''))
      }
      await reloadMessages()
    } catch (e) {
      appendAssistant(zhCN.writingChat.generateFailed.replace('{message}', String(e)))
    } finally {
      resetBusy()
    }
  }

  const handleEditorHistoryChange = useCallback((markdown: string): void => {
    const snapshot = adoptionSnapshotsRef.current.get(markdown)
    if (!snapshot) return
    const current = contradictionsRef.current
    for (const target of snapshot) {
      const cur = current.find((c) => c.id === target.id)
      if (cur && cur.status !== target.status) {
        void window.api.resolveContradiction(
          target.id,
          target.status === 'adopted' ? 'adopt' : 'revert',
          target.status === 'adopted' ? target.adoptedVariantId : undefined
        )
      }
    }
    setContradictions(snapshot)
  }, [])

  if (loading) {
    return (
      <p className="source-list__status source-list__status--loading">
        <span className="spinner" aria-hidden="true" />
        {zhCN.writingWorkspace.loading}
      </p>
    )
  }
  if (err) return <p className="source-list__error">{err}</p>
  if (!task) return <p className="source-list__error">{zhCN.writingWorkspace.loadFailed.replace('{message}', '任务不存在')}</p>

  const handleContradictionResolved = (updated: Contradiction): void => {
    setContradictions((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
  }

  const handleContradictionApplied = (updated: Contradiction, draft: unknown): void => {
    const newDraft = draft as DraftItem
    const nextContradictions = contradictionsRef.current.map((c) => (c.id === updated.id ? updated : c))
    const beforeMd = editorRef.current?.getMarkdown() ?? ''
    const afterMd = editorRef.current?.applyDraftForAdoption(newDraft) ?? ''
    if (beforeMd && afterMd && beforeMd !== afterMd) {
      adoptionSnapshotsRef.current.set(beforeMd, contradictionsRef.current)
      adoptionSnapshotsRef.current.set(afterMd, nextContradictions)
    }
    setDraft(newDraft)
    setContradictions(nextContradictions)
  }

  const inDraftContradictions = contradictions.filter((c) => c.inDraft !== false)
  const warningContradictions = contradictions.filter((c) => c.inDraft === false)

  /**
   * 打开来源（Phase 9 / S4）：默认在**右侧分栏**里打开，并带上**定位锚**——
   * 锚点来自生成期算好的"卡片 → 块号 → 页码"，查看器只报「第 P 页 / 第 N 段 / 未记录来源位置」，
   * 不在打开来源时做任何全文检索。要用系统默认程序（WPS/Word/浏览器）打开时走
   * `handleOpenSourceExternal` —— 用户裁定 Q2：内部与外部两种打开方式都要有。
   */
  const handleOpenSource = (sourceId: string, locate?: SourceLocateAnchor, highlight?: string): void => {
    if (!sourceId) return
    setSourcePane({ sourceId, locate, highlight })
  }

  const handleAskSource = async (selection: string): Promise<void> => {
    if (busy) return
    const res = await window.api.askSource(taskId, selection)
    if (res.ok && res.data) {
      setSourceRefs(res.data.refs as SourceRefItem[])
    } else {
      appendAssistant('来源询问失败：' + (res.error?.message ?? ''))
    }
    await reloadMessages()
  }

  const renderChat = () => {
    if (mode === 'compile') {
      /*
       * 7.6.1（用户裁定 D7=A）：**「生成汇编」功能区不再有左栏对话框**——
       * 生成入口与大模型对话统一由右侧悬浮面板承载（生成模式 / 对话模式）。
       * 任务对话（`task_messages`）仍照旧落库，历史不丢，只是不再有独立面板。
       */
      return null
    }
    // 撰写初稿
    if (!compilation) {
      // 未导入资料汇编：仅自由对话
      return (
        <ChatPanel
          messages={messages}
          draftExisted={false}
          busy={busy !== null}
          busyText={busyText}
          streamText={streamText}
          progress={null}
          onGenerate={() => undefined}
          onChat={(message) => void handleChat(message)}
          primaryLabel={zhCN.writingChat.sendBtn}
          onPrimaryAction={(text) => void handleChat(text)}
          refs={sourceRefs}
          onOpenSource={(sourceId) => void handleOpenSource(sourceId)}
        />
      )
    }
    return (
      <ChatPanel
        messages={messages}
        draftExisted={!!draft}
        busy={busy !== null}
        busyText={busyText}
        streamText={streamText}
        progress={progress}
        onGenerate={(instruction) => void handleGenerateDraft((instruction || compilationInstruction || task?.userInstruction || '').trim())}
        onChat={(message) => void handleChat(message)}
        refs={sourceRefs}
        onOpenSource={(sourceId) => void handleOpenSource(sourceId)}
      />
    )
  }

  const renderContent = () => {
    if (mode === 'compile') {
      return (
        <CompilationStep
          compilation={compilation}
          busy={busy !== null}
          candidateChunks={compilationMeta?.candidateChunks}
          onConfirm={() => void handleExportCompilation()}
          onOpenSource={(sourceId, locate, highlight) => handleOpenSource(sourceId, locate, highlight)}
          onResolve={handleResolveContradiction}
          onReorderItems={(direction) => void handleReorderItems(direction)}
          onUndo={() => void handleUndo()}
          onRedo={() => void handleRedo()}
          undoAvailable={undoAvailable}
          redoAvailable={redoAvailable}
          versionDiff={versionDiff}
          reviewVersionNo={reviewVersionNo}
          onlyChanged={onlyChanged}
          onToggleOnlyChanged={setOnlyChanged}
          onAcceptEdit={handleAcceptDocEdit}
          onRevertEdit={() => void handleRevertDocEdit()}
          docMessages={docMessages}
          docEditing={docEditing}
          docError={docError}
          docChangedIds={docChangedIds}
          onDocSend={(instruction) => void handleDocSend(instruction)}
          onDocOpen={() => {
            if (compilation) void loadDocMessages(compilation.id)
          }}
          taskMessages={messages}
          generating={busy !== null}
          generatingText={busyText}
          generateProgress={compilationProgress}
          generateInterrupt={compilationInterrupt}
          onRetryCompilation={compilationInterrupt ? () => void handleContinueCompilation() : undefined}
          onGenerate={(instruction) => void handleGenerateCompilation(instruction)}
          restoreDraft={restoreDraft}
          webScan={lastWebScan}
          anchorStats={anchorStats}
          onRegenerateCompilation={() => setRegenConfirmOpen(true)}
          sourceRefs={sourceRefs}
          webYears={{ from: task?.webYearFrom, to: task?.webYearTo }}
          onWebYearsChange={handleWebYearsChange}
          webYearsPreview={webYearsPreview}
          onWebYearsPreviewQuery={handleWebYearsPreviewQuery}
          fetchPaused={fetchPaused}
          onToggleFetchPause={handleToggleFetchPause}
        />
      )
    }
    // 撰写初稿功能区
    if (!compilation || draftPhase === 'import') {
      return (
        <div className="draft-import">
          <h3 className="draft-import__title">{zhCN.draftArea.importTitle}</h3>
          <p className="draft-import__hint">{zhCN.draftArea.importHint}</p>
          <div className="draft-import__actions">
            <button type="button" className="source-list__btn" onClick={() => void handleImportExternal()} disabled={importing}>
              {zhCN.draftArea.importExternal}
            </button>
          </div>
          <div className="draft-import__list">
            <div className="draft-import__list-head">{zhCN.draftArea.fromCompile}</div>
            {importOptions.length === 0 ? (
              <p className="draft-import__empty">{zhCN.draftArea.emptyList}</p>
            ) : (
              importOptions.map((opt) => (
                <div key={opt.compilation.id} className="draft-import__item">
                  <div className="draft-import__item-info">
                    <span className="draft-import__item-title">{opt.compilation.title}</span>
                    <span className="draft-import__item-task">来源任务：{opt.taskTitle}</span>
                  </div>
                  <button
                    type="button"
                    className="source-list__btn source-list__btn--primary"
                    disabled={importing}
                    onClick={() => void handleImportFromTask(opt.compilation.id)}
                  >
                    {importing ? '...' : '导入'}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )
    }
    if (draftPhase === 'style') {
      return (
        <div className="draft-style-wrap">
          <StyleGuideEditor taskId={taskId} onNext={handleStartWriting} />
        </div>
      )
    }
    if (draft) {
      return (
        <DraftEditor
          key={draft.id}
          ref={editorRef}
          draft={draft}
          contradictions={contradictions}
          onContradictionClick={(seq) => setDialogState({ kind: 'contradiction', mode: 'single', seq })}
          onOpenContradictions={() => setDialogState({ kind: 'contradiction', mode: 'overview' })}
          onOpenWarnings={() => setDialogState({ kind: 'warning', mode: 'overview' })}
          onAskSource={(selection) => void handleAskSource(selection)}
          onHistoryChanged={handleEditorHistoryChange}
        />
      )
    }
    return (
      <div className="writing-workspace__editor-placeholder">
        <p>{zhCN.writingChat.noDraftHint}</p>
      </div>
    )
  }

  // 「生成汇编」功能区为 null（无左栏）；「撰写初稿」功能区是左侧任务对话框
  const chatNode = renderChat()

  return (
    <div className="writing-workspace writing-workspace--chat">
      <header className="writing-workspace__header">
        <div>
          <h3 className="writing-workspace__title">{zhCN.writingWorkspace.taskTitle.replace('{title}', task.title)}</h3>
          {task.articleTitle ? (
            <p className="writing-workspace__article-title">
              {zhCN.writingWorkspace.articleTitle.replace('{title}', task.articleTitle)}
            </p>
          ) : null}
        </div>
        <div className="writing-workspace__header-actions">
          {mode === 'draft' && draftPhase === 'write' ? (
            <button
              type="button"
              className="source-list__btn"
              disabled={busy !== null}
              onClick={handleBackToStyle}
            >
              {zhCN.draftArea.backToStyle}
            </button>
          ) : null}
          <button
            type="button"
            className="recycle-bin-btn style-guide-btn"
            title={zhCN.styleGuide.entry}
            aria-label={zhCN.styleGuide.entry}
            onClick={() => setShowStyleGuide(true)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 5h14l-14 14z" />
              <path d="M9 5v3M13 5v3M5 9h3M5 13h3" />
            </svg>
          </button>
          {mode === 'compile' && compilation ? (
            <button
              type="button"
              className="recycle-bin-btn"
              title={zhCN.compilation.recycleBin}
              aria-label={zhCN.compilation.recycleBin}
              onClick={openRecycleBin}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M10 11v6M14 11v6" />
              </svg>
            </button>
          ) : null}
          {mode === 'draft' && draft && draftPhase === 'write' ? (
            <button
              type="button"
              className="source-list__btn source-list__btn--danger"
              disabled={busy !== null}
              onClick={() => setConfirmingRegenerate(true)}
            >
              {zhCN.writingChat.regenerateBtn}
            </button>
          ) : null}
        </div>
      </header>

      <div className="writing-workspace__body">
        {/* 「生成汇编」功能区无左栏（7.6.1）；「撰写初稿」功能区保留左侧任务对话 */}
        {chatNode ? (
          <>
            <section className="writing-workspace__chat" style={{ width: chatWidth }}>{chatNode}</section>
            <ResizeHandle onResize={handleChatResize} direction="horizontal" />
          </>
        ) : null}
        <section className="writing-workspace__editor">{renderContent()}</section>
        {/* Phase 8 / S1：右侧「来源」分栏——点段落来源 / 矛盾说法时在此就地打开并定位（优先保证本处效果） */}
        {sourcePane ? (
          <>
            <ResizeHandle onResize={handleSourceResize} direction="horizontal" />
            <section className="writing-workspace__source" style={{ width: sourceWidth }}>
              <SourceViewer
                key={sourcePane.sourceId}
                sourceId={sourcePane.sourceId}
                dense
                locate={sourcePane.locate ?? null}
                snapshotHighlight={sourcePane.highlight}
                onClose={() => setSourcePane(null)}
              />
            </section>
          </>
        ) : null}
      </div>

      {/* 「生成汇编」导出格式选择 */}
      {showExportMenu && mode === 'compile' ? (
        <div className="export-menu">
          <div className="export-menu__title">{zhCN.compilation.exportTitle}</div>
          <button type="button" className="export-menu__btn" disabled={exporting} onClick={() => void handleExportDocx()}>
            {zhCN.compilation.exportDocx}
          </button>
          <button type="button" className="export-menu__btn" disabled={exporting} onClick={() => void handleExportArchive()}>
            {zhCN.compilation.exportArchive}
          </button>
          <button type="button" className="export-menu__btn export-menu__btn--cancel" disabled={exporting} onClick={() => setShowExportMenu(false)}>
            取消
          </button>
        </div>
      ) : null}

      {dialogState ? (
        <ContradictionDialog
          contradictions={dialogState.kind === 'warning' ? warningContradictions : inDraftContradictions}
          warningMode={dialogState.kind === 'warning'}
          initialSeq={dialogState.mode === 'single' ? dialogState.seq : undefined}
          onClose={() => setDialogState(null)}
          onResolved={handleContradictionResolved}
          onApplied={handleContradictionApplied}
          onOpenSource={(sourceId, highlight) => handleOpenSource(sourceId, undefined, highlight)}
        />
      ) : null}

      {confirmingRegenerate ? (
        <ConfirmDialog
          title={zhCN.writingChat.regenerateConfirmTitle}
          message={zhCN.writingChat.regenerateConfirmMessage}
          confirmText={zhCN.writingChat.regenerateConfirmBtn}
          danger
          busy={busy !== null}
          onConfirm={() => void handleRegenerate()}
          onCancel={() => setConfirmingRegenerate(false)}
        />
      ) : null}

      {regenConfirmOpen ? (
        <ConfirmDialog
          title={zhCN.compilation.regenerateConfirmTitle}
          message={zhCN.compilation.regenerateConfirmMessage}
          confirmText={zhCN.compilation.regenerateConfirmBtn}
          danger
          busy={busy !== null}
          onConfirm={() => handleRegenerateCompilation()}
          onCancel={() => setRegenConfirmOpen(false)}
        />
      ) : null}

      {/*
        生成前的「材料规模」确认（2026-10-05 用户要求 P1）：真正开始生成之前报一次预计规模与耗时，
        **只提示、不限制**。取消 = 不生成：清掉弹窗（busy 早在估算结束时已复位，不会卡在「生成中」），
        并把刚提交的撰写要求**放回输入框**（ChatPanel 的 submit 已先清空输入框，不回填就得重敲）。
      */}
      {/*
        2026-10-06（Phase 11 E 用户需求 ②；裁定 1A「严格阻断、无逃生门」）：
        未建立齐时**只有**一个出口——去设置页「建立缓存与索引」。刻意**不提供"仍然生成"**。
        两个按钮都把撰写要求放回输入框（否则用户建立完回来还得重敲一遍）。
      */}
      {notReady ? (
        <ConfirmDialog
          title={zhCN.compilation.notReadyTitle}
          message={buildNotReadyMessage(notReady.readiness)}
          confirmText={zhCN.compilation.notReadyGoBtn}
          cancelText={zhCN.compilation.notReadyCancelBtn}
          onConfirm={() => {
            const inst = notReady.instruction
            setNotReady(null)
            requestRestoreDraft(inst)
            const msg = zhCN.compilation.notReadyCancelled
            appendAssistant(msg)
            void window.api.addTaskMessage(taskId, 'assistant', msg, 'notice')
            onGoBuildCache?.()
          }}
          onCancel={() => {
            const inst = notReady.instruction
            setNotReady(null)
            requestRestoreDraft(inst)
            const msg = zhCN.compilation.notReadyCancelled
            appendAssistant(msg)
            void window.api.addTaskMessage(taskId, 'assistant', msg, 'notice')
          }}
        />
      ) : null}

      {materialEstimate ? (
        <ConfirmDialog
          title={zhCN.compilation.materialEstimateTitle}
          message={materialEstimate.data ? buildMaterialEstimateMessage(materialEstimate.data, skipConvergence) : materialEstimate.message}
          confirmText={zhCN.compilation.materialEstimateConfirm}
          cancelText={zhCN.compilation.materialEstimateCancel}
          error={materialEstimate.error}
          onConfirm={() => {
            const inst = materialEstimate.instruction
            const skip = skipConvergence
            setMaterialEstimate(null)
            void startCompilationGeneration(inst, skip)
          }}
          onCancel={() => {
            const inst = materialEstimate.instruction
            setMaterialEstimate(null)
            requestRestoreDraft(inst)
            const msg = zhCN.compilation.materialEstimateCancelled
            appendAssistant(msg)
            void window.api.addTaskMessage(taskId, 'assistant', msg, 'notice')
          }}
        >
          {/*
            第二组 ⑤ 的逃生门（2026-10-06）：默认收敛；勾选后本轮全量送入、行为回到今天。
            只有拿到估算数据（知道收敛前后面各多少）时才显示——估算失败时不摆一个说不清代价的开关。
          */}
          {materialEstimate.data?.converged ? (
            <label className="confirm-dialog__checkbox" title={zhCN.compilation.materialEstimateConvergeOffHint}>
              <input type="checkbox" checked={skipConvergence} onChange={(e) => setSkipConvergence(e.target.checked)} />
              <span>{zhCN.compilation.materialEstimateConvergeOff}</span>
            </label>
          ) : null}
        </ConfirmDialog>
      ) : null}

      {showRecycleBin ? (
        <div className="skills-manager__modal-backdrop" onMouseDown={() => setShowRecycleBin(false)}>
          <div className="skills-manager__modal recycle-bin-modal" onMouseDown={(e) => e.stopPropagation()}>
            <h4 className="skills-manager__modal-title">{zhCN.compilation.recycleBinTitle}</h4>
            {recycleBinItems.length === 0 ? (
              <p className="recycle-bin-empty">{zhCN.compilation.recycleBinEmpty}</p>
            ) : (
              <div className="recycle-bin-list">
                {recycleBinItems.map((item) => (
                  <div key={item.id} className="recycle-bin-item">
                    <div className="recycle-bin-item-head">
                      <b>⚠ {item.topic}</b>
                      <span>{item.status === 'resolved' ? zhCN.compilation.resolved : zhCN.compilation.ignored}</span>
                    </div>
                    <div className="recycle-bin-item-variants">
                      {item.contradiction.variants.map((v) => (
                        <div key={v.id} className="recycle-bin-variant">《{v.sourceTitle ?? v.sourceId}》 {v.variantText}</div>
                      ))}
                    </div>
                    <div className="recycle-bin-item-actions">
                      <button type="button" className="source-list__btn source-list__btn--primary" onClick={() => void handleRestoreRecycleBin(item.id)}>
                        {zhCN.compilation.restore}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="skills-manager__modal-actions">
              <button type="button" className="source-list__btn" onClick={() => setShowRecycleBin(false)}>{zhCN.compilation.close}</button>
            </div>
          </div>
        </div>
      ) : null}

      {showStyleGuide ? (
        <div className="skills-manager__modal-backdrop" onMouseDown={() => setShowStyleGuide(false)}>
          <div className="skills-manager__modal style-guide-modal" onMouseDown={(e) => e.stopPropagation()}>
            <h4 className="skills-manager__modal-title">{zhCN.styleGuide.entry}</h4>
            <div className="style-guide-modal__body"><StyleGuideEditor startInList /></div>
            <div className="skills-manager__modal-actions">
              <button type="button" className="source-list__btn" onClick={() => setShowStyleGuide(false)}>{zhCN.styleGuide.close}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default WritingWorkspace
