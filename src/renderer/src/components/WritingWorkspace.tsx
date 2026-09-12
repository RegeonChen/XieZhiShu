import { useState, useEffect, useCallback, useRef } from 'react'
import { zhCN } from '../i18n/zh-CN'
import DraftEditor, { type DraftEditorHandle } from './DraftEditor'
import ConfirmDialog from './ConfirmDialog'
import ContradictionDialog from './ContradictionDialog'
import ResizeHandle from './ResizeHandle'
import StyleGuideEditor from './StyleGuideEditor'
import ChatPanel, { type ChatMessageItem, type SourceRefItem } from './ChatPanel'
import CompilationStep, {
  type CompilationView,
  type CompilationVersionView,
  type CompilationVersionDiffView,
  type CompilationMessageView
} from './CompilationStep'
import type { Contradiction, CompilationRecycleBinItem } from '../../../shared/types'
import type { CompilationWebScan } from '../../../shared/ipc'

interface TaskItem {
  id: string
  title: string
  skillIds?: string[]
  llmProviderId?: string
  articleTitle?: string
  userInstruction?: string
  currentVersion: number
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
      degradedFromEvidence?: number
      degradedWholeCard?: number
      droppedCards?: number
      omitted?: number
      passthrough?: number
      duplicatesDropped?: number
      conflictsKept?: number
    }
    webScan?: { sites: number; siteErrors: number; hits: number; fetched: number; skippedByCap: number; chars: number; reused?: number; newCandidates?: number }
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
    // 诊断细分：本地校验通过/降级（数字无据 · 证据非原文），以及降级粒度（evidence 片段 / 整卡原文）
    if (ps.accepted != null || ps.degraded != null) {
      parts.push(
        zhCN.compilation.extractDiagnostics
          .replace('{accepted}', String(ps.accepted ?? 0))
          .replace('{degraded}', String(ps.degraded ?? 0))
          .replace('{numbers}', String(ps.invalidNumbers ?? 0))
          .replace('{evidence}', String(ps.invalidEvidence ?? 0))
          .replace('{fromEvidence}', String(ps.degradedFromEvidence ?? 0))
          .replace('{wholeCard}', String(ps.degradedWholeCard ?? 0))
      )
    }
    if (ps.droppedCards) parts.push(zhCN.compilation.extractDropped.replace('{count}', String(ps.droppedCards)))
    if (ps.conflictsKept) parts.push(zhCN.compilation.extractConflictsKept.replace('{count}', String(ps.conflictsKept)))
  }
  // 网页资料本轮抓取情况（含上限截断）：让用户知道"这次用上了多少网页材料"
  const ws = scans.webScan
  if (ws && ws.sites > 0) {
    if (ws.reused && ws.reused > 0) {
      // A1：复用已锁定材料时本轮**没有新抓取**，不能报"实际采用 0 篇"（会读成一篇都没用上）
      parts.push(zhCN.compilation.webScanReused.replace('{count}', String(ws.reused)))
      if (ws.newCandidates && ws.newCandidates > 0) {
        parts.push(zhCN.compilation.webScanNewCandidates.replace('{count}', String(ws.newCandidates)))
      }
    } else {
      parts.push(
        zhCN.compilation.webScan
          .replace('{hits}', String(ws.hits))
          .replace('{fetched}', String(ws.fetched))
          .replace('{chars}', String(ws.chars))
      )
      if (ws.skippedByCap > 0) parts.push(zhCN.compilation.webScanCapped.replace('{count}', String(ws.skippedByCap)))
      if (ws.fetched === 0 && ws.siteErrors === 0) parts.push(zhCN.compilation.webScanEmpty)
    }
    // E1：站点同步失败 → 明确告知，别让用户以为"网页资料没用上是因为没内容"
    if (ws.siteErrors > 0) parts.push(zhCN.compilation.webScanSiteErrors.replace('{count}', String(ws.siteErrors)))
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
  compilationProgress: { percent: number; etaSeconds?: number } | null
  compilationInterrupt: { stage: string; message: string; percent: number } | null
  streamText: string | null
}
const transientByTask = new Map<string, WritingTransient>()
// 前端 429 自动续传兜底参数（限流中断时自动调用 continueCompilation；上限与递增延迟，避免无限重试）
const AUTO_RESUME_LIMIT = 2
const AUTO_RESUME_DELAYS_MS = [8000, 20000]

function WritingWorkspace({ taskId, mode, onChanged, reloadKey }: { taskId: string; mode: 'compile' | 'draft'; onChanged: () => void; reloadKey?: number }) {
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
  const [compilationProgress, setCompilationProgress] = useState<{ percent: number; etaSeconds?: number } | null>(null)
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
  const [adoptingWeb, setAdoptingWeb] = useState(false)
  /** 正在重新检索网页材料（清空并重算本任务的材料集合） */
  const [refreshingWeb, setRefreshingWeb] = useState(false)

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
        setCompilationProgress({ percent: p.percent, etaSeconds: p.etaSeconds })
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

  const handleGenerateCompilation = async (instruction: string) => {
    if (busy) return
    const inst = instruction.trim()
    if (!inst) return
    setCompilationInstruction(inst)
    setMessages((prev) => [...prev, { role: 'user', content: instruction }])
    setBusy('generating')
    setBusyText(zhCN.compilation.generating)
    setStreamText(null)
    setCompilationProgress(null)
    setCompilationInterrupt(null)
    autoResumeAttemptRef.current = 0
    let keepProgress = false
    try {
      const res = await window.api.generateCompilation(taskId, inst)
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
            degradedWholeCard?: number
            droppedCards?: number
            omitted?: number
            passthrough?: number
            duplicatesDropped?: number
            conflictsKept?: number
          }
          webScan?: { sites: number; siteErrors: number; hits: number; fetched: number; skippedByCap: number; chars: number; reused?: number; newCandidates?: number }
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
        const data = res.data as { compilation: CompilationView; interrupted?: { stage: string; message: string; percent: number; retryable?: boolean } }
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
          const summary = buildGeneratedSummary('已继续生成资料汇编：', comp, {})
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
   * 纳入新网页材料（第三批 A1）：把站点上"新命中但未纳入"的文章抓取入库并锁定到本任务。
   * 纳入完成后需要用户再点一次「重新生成汇编」才会用上（不自动重跑，避免意外覆盖当前汇编）。
   */
  const handleAdoptWebMaterials = async () => {
    if (adoptingWeb) return
    setAdoptingWeb(true)
    try {
      const query = compilationInstruction.trim() || (task?.userInstruction ?? '').trim()
      const res = await window.api.adoptWebMaterials(taskId, query)
      if (res.ok && res.data) {
        const text =
          res.data.added > 0
            ? zhCN.compilation.webMaterialsAdopted.replace('{count}', String(res.data.added))
            : zhCN.compilation.webMaterialsAdoptNone
        appendAssistant(text)
        void window.api.addTaskMessage(taskId, 'assistant', text, 'notice')
        // 纳入后新文章数清零（重新生成时会重新统计）
        setLastWebScan((prev) => (prev ? { ...prev, newCandidates: 0 } : prev))
      } else {
        appendAssistant(zhCN.compilation.webMaterialsAdoptFailed.replace('{message}', res.error?.message ?? ''))
      }
    } catch (e) {
      appendAssistant(zhCN.compilation.webMaterialsAdoptFailed.replace('{message}', String(e)))
    } finally {
      setAdoptingWeb(false)
    }
  }

  /**
   * 重新检索网页材料（第三批 A1 补强）：清空并重算本任务锁定的网页材料集合。
   * 用途：首次落定用的材料不理想（例如抓取上限按错误的顺序截断、切题文章没抓到）时不必新建任务。
   * 只改材料集合，不动当前汇编——需再点一次「重新生成汇编」才生效。
   */
  const handleRefreshWebMaterials = async () => {
    if (refreshingWeb) return
    setRefreshingWeb(true)
    try {
      const query = compilationInstruction.trim() || (task?.userInstruction ?? '').trim()
      const res = await window.api.refreshWebMaterials(taskId, query)
      if (res.ok && res.data) {
        const d = res.data
        const text = zhCN.compilation.webMaterialsRefreshed
          .replace('{fetched}', String(d.pinned))
          .replace('{hits}', String(d.hits))
          .replace('{skipped}', String(d.skippedByCap))
        appendAssistant(text)
        void window.api.addTaskMessage(taskId, 'assistant', text, 'notice')
        // 材料集合已重算：面板显示"已锁定 N 篇"，新命中数归零（下次生成时重新统计）
        setLastWebScan({
          sites: d.sites,
          siteErrors: d.siteErrors,
          hits: d.hits,
          fetched: d.fetched,
          skippedByCap: d.skippedByCap,
          chars: d.chars,
          reused: d.pinned,
          newCandidates: 0
        })
      } else {
        appendAssistant(zhCN.compilation.webMaterialsRefreshFailed.replace('{message}', res.error?.message ?? ''))
      }
    } catch (e) {
      appendAssistant(zhCN.compilation.webMaterialsRefreshFailed.replace('{message}', String(e)))
    } finally {
      setRefreshingWeb(false)
    }
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

  const handleOpenSource = async (sourceId: string): Promise<void> => {
    const res = await window.api.openSourcePath(sourceId)
    if (!res.ok) {
      appendAssistant('打开来源文件失败：' + (res.error?.message ?? ''))
    }
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
          onOpenSource={(sourceId) => void handleOpenSource(sourceId)}
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
          webScan={lastWebScan}
          adoptingWeb={adoptingWeb}
          onAdoptWebMaterials={() => void handleAdoptWebMaterials()}
          refreshingWeb={refreshingWeb}
          onRefreshWebMaterials={() => void handleRefreshWebMaterials()}
          sourceRefs={sourceRefs}
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
          onOpenSource={(sourceId) => void handleOpenSource(sourceId)}
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
