import { useState, useEffect, useCallback, useRef } from 'react'
import { zhCN } from '../i18n/zh-CN'
import DraftEditor, { type DraftEditorHandle } from './DraftEditor'
import ConfirmDialog from './ConfirmDialog'
import ContradictionDialog from './ContradictionDialog'
import ResizeHandle from './ResizeHandle'
import StyleGuideEditor from './StyleGuideEditor'
import ChatPanel, { type ChatMessageItem, type SourceRefItem } from './ChatPanel'
import CompilationStep, { type CompilationView } from './CompilationStep'
import type { Contradiction, CompilationRecycleBinItem } from '../../../shared/types'

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
type WizardStep = 0 | 1 | 2

/** 撰写工作台的「生成中」临时状态（跨任务切换用模块级 Map 快照恢复） */
interface WritingTransient {
  busy: BusyState
  busyText: string | null
  progress: { percent: number; etaSeconds?: number } | null
  compilationProgress: { percent: number; etaSeconds?: number } | null
  streamText: string | null
}
const transientByTask = new Map<string, WritingTransient>()

function WritingWorkspace({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
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

  // ---- Phase 6.2：三段式向导 ----
  const [step, setStep] = useState<WizardStep>(0)
  const [compilation, setCompilation] = useState<CompilationView | null>(null)
  const [compilationMeta, setCompilationMeta] = useState<{ candidateChunks?: number; candidateSources?: number } | null>(null)
  const [compilationProgress, setCompilationProgress] = useState<{ percent: number; etaSeconds?: number } | null>(null)
  const [compilationInstruction, setCompilationInstruction] = useState('')
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
  const liveTransientRef = useRef<WritingTransient>({ busy: null, busyText: null, progress: null, compilationProgress: null, streamText: null })
  liveTransientRef.current = { busy, busyText, progress, compilationProgress, streamText }
  useEffect(() => {
    const snap = transientByTask.get(taskId)
    if (snap) {
      setBusy(snap.busy ?? null)
      setBusyText(snap.busyText ?? null)
      setProgress(snap.progress ?? null)
      setCompilationProgress(snap.compilationProgress ?? null)
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

      if (hasDraft) setStep(2)
      else if (comp && comp.status === 'finalized') setStep(2)
      else setStep(0)

      const mRes = await window.api.listTaskMessages(taskId)
      if (mRes.ok && mRes.data) {
        setMessages(mRes.data.items.map((m) => ({ role: m.role, content: m.content })))
      }
    } catch {
      setErr(zhCN.writingWorkspace.loadFailed.replace('{message}', ''))
    } finally {
      setLoading(false)
    }
  }, [taskId])

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

  const reloadMessages = useCallback(async () => {
    const res = await window.api.listTaskMessages(taskId)
    if (res.ok && res.data) {
      setMessages(res.data.items.map((m) => ({ role: m.role, content: m.content })))
    }
  }, [taskId])

  const refreshCompilation = useCallback(async (compilationId: string) => {
    const getRes = await window.api.getCompilation(compilationId)
    if (getRes.ok && getRes.data) setCompilation(getRes.data.compilation as CompilationView)
  }, [])

  /** 生成/重新生成汇编后：扫描语义补全/修订（additive）并重载汇编，让修订出现在卡片上 */
  const scanRepairsAndReload = useCallback(async (compilationId: string) => {
    try {
      await window.api.scanCompilationRepairs(compilationId)
    } catch {
      // 扫描失败是 additive，不阻断（忽略）
    }
    await refreshCompilation(compilationId)
  }, [refreshCompilation])

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
    try {
      const res = await window.api.generateCompilation(taskId, inst)
      if (res.ok && res.data) {
        const comp = res.data.compilation as CompilationView
        setCompilation(comp)
        const pendingCount = comp.contradictions.filter((c) => c.status === 'pending').length
        const summary = pendingCount > 0
          ? '已生成资料汇编：' + comp.items.length + ' 张卡片，' + pendingCount + ' 组矛盾待处理。请审阅并处理后点击「确认汇编」。'
          : '已生成资料汇编：' + comp.items.length + ' 张卡片，无未处理矛盾。请审阅后点击「确认汇编」。'
        appendAssistant(summary)
        void window.api.addTaskMessage(taskId, 'assistant', summary, 'notice')
        void scanRepairsAndReload(comp.id)
      } else {
        const msg = '生成资料汇编失败：' + (res.error?.message ?? '')
        appendAssistant(msg)
        void window.api.addTaskMessage(taskId, 'assistant', msg, 'notice')
      }
    } finally {
      resetBusy()
      await reloadMessages()
    }
  }

  const handleRegenerateCompilation = async () => {
    if (busy) return
    const inst = compilationInstruction.trim() || (task?.userInstruction ?? '').trim()
    if (!inst) {
      appendAssistant('没有可用的撰写要求，无法重新生成资料汇编。')
      return
    }
    setBusy('generating')
    setBusyText(zhCN.compilation.generating)
    setCompilationProgress(null)
    try {
      const res = await window.api.regenerateCompilation(taskId, inst)
      if (res.ok && res.data) {
        const comp = res.data.compilation as CompilationView
        setCompilation(comp)
        const summary = zhCN.compilation.regenerated.replace('{count}', String(comp.items.length))
        appendAssistant(summary)
        void window.api.addTaskMessage(taskId, 'assistant', summary, 'notice')
        void scanRepairsAndReload(comp.id)
      } else {
        const msg = '重新生成资料汇编失败：' + (res.error?.message ?? '')
        appendAssistant(msg)
        void window.api.addTaskMessage(taskId, 'assistant', msg, 'notice')
      }
    } finally {
      resetBusy()
      await reloadMessages()
    }
  }

  const handleConfirmCompilation = async () => {
    if (!compilation || busy) return
    const res = await window.api.confirmCompilation(compilation.id)
    if (res.ok && res.data) {
      setCompilation(res.data.compilation as CompilationView)
      appendAssistant(zhCN.compilation.confirmed)
      setStep(1)
    } else {
      appendAssistant('确认汇编失败：' + (res.error?.message ?? ''))
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

  const handleUpdateItem = async (itemId: string, patch: { excerpt?: string; ts?: string | null; note?: string | null }) => {
    const res = await window.api.updateCompilationItem(itemId, patch)
    if (res.ok && res.data) {
      const item = res.data.item as CompilationView['items'][number]
      setCompilation((cur) => (cur ? { ...cur, items: cur.items.map((it) => (it.id === itemId ? item : it)) } : cur))
    } else {
      appendAssistant('编辑资料卡片失败：' + (res.error?.message ?? ''))
    }
  }

  const handleDeleteItem = async (itemId: string) => {
    const res = await window.api.deleteCompilationItem(itemId)
    if (res.ok) {
      setCompilation((cur) => (cur ? { ...cur, items: cur.items.filter((it) => it.id !== itemId) } : cur))
    } else {
      appendAssistant('删除资料卡片失败：' + (res.error?.message ?? ''))
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

  // ---- 语义补全/修订（Phase 6.4.3）----

  const handleDecideRepair = async (repairId: string, action: 'accept' | 'reject') => {
    const res = await window.api.decideCompilationRepair(repairId, action)
    if (res.ok && res.data) {
      if (compilation) {
        await refreshCompilation(compilation.id)
      }
    } else {
      appendAssistant('处理语义补全失败：' + (res.error?.message ?? ''))
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
      const compilationId = compilation?.status === 'finalized' ? compilation.id : undefined
      const res = await window.api.generateDraft(taskId, instruction, compilationId)
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

  /** 第二步「下一步」：进入第三步并自动基于已确认汇编生成初稿（进度在左侧对话框体现） */
  const handleNextToStep3 = (): void => {
    setStep(2)
    const instruction = (compilationInstruction || task?.userInstruction || '').trim()
    if (instruction && !draft) {
      void handleGenerateDraft(instruction)
    }
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
      const compilationId = compilation?.status === 'finalized' ? compilation.id : undefined
      const res = await window.api.regenerateDraft(taskId, instruction, compilationId)
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

  const compilationFinalized = compilation?.status === 'finalized'

  const goToStep = (target: WizardStep): void => {
    if (target === 0) {
      setStep(0)
      return
    }
    if (compilationFinalized) setStep(target)
  }

  const renderChat = () => {
    if (step === 0) {
      return (
        <ChatPanel
          messages={messages}
          draftExisted={false}
          busy={busy !== null}
          busyText={busyText}
          streamText={streamText}
          progress={compilationProgress}
          onGenerate={() => undefined}
          onChat={(message) => void handleChat(message)}
          primaryLabel={zhCN.compilation.generateBtn}
          onPrimaryAction={(text) => void handleGenerateCompilation(text)}
          refs={sourceRefs}
          onOpenSource={(sourceId) => void handleOpenSource(sourceId)}
        />
      )
    }
    if (step === 1) {
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
        onGenerate={(instruction) => void handleGenerateDraft(instruction)}
        onChat={(message) => void handleChat(message)}
        refs={sourceRefs}
        onOpenSource={(sourceId) => void handleOpenSource(sourceId)}
      />
    )
  }

  const renderContent = () => {
    if (step === 0) {
      return (
        <CompilationStep
          compilation={compilation}
          busy={busy !== null}
          candidateChunks={compilationMeta?.candidateChunks}
          onRegenerate={() => void handleRegenerateCompilation()}
          onConfirm={() => void handleConfirmCompilation()}
          onOpenSource={(sourceId) => void handleOpenSource(sourceId)}
          onUpdateItem={handleUpdateItem}
          onDeleteItem={(itemId) => void handleDeleteItem(itemId)}
          onResolve={handleResolveContradiction}
          onDecideRepair={(repairId, action) => void handleDecideRepair(repairId, action)}
        />
      )
    }
    if (step === 1) {
      return <StyleGuideEditor taskId={taskId} onNext={handleNextToStep3} />
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

  const stepClass = (i: WizardStep): string => {
    const parts = ['writing-stepper__step']
    if (i === step) parts.push('is-active')
    else if (i < step) parts.push('is-done')
    else if (!compilationFinalized) parts.push('is-locked')
    return parts.join(' ')
  }

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
          {compilation ? (
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
          {draft && step === 2 ? (
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

      <nav className="writing-stepper" data-onboarding="writing-stepper" aria-label="撰写步骤">
        {zhCN.writingWorkspace.steps.map((label, i) => (
          <button
            key={i}
            type="button"
            className={stepClass(i as WizardStep)}
            disabled={i > step && !compilationFinalized}
            onClick={() => goToStep(i as WizardStep)}
          >
            <span className="writing-stepper__index">{i + 1}</span>
            <span className="writing-stepper__label">{label}</span>
          </button>
        ))}
      </nav>

      <div className="writing-workspace__body">
        <section className="writing-workspace__chat" style={{ width: chatWidth }}>{renderChat()}</section>
        <ResizeHandle onResize={handleChatResize} direction="horizontal" />
        <section className="writing-workspace__editor">{renderContent()}</section>
      </div>

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
                      {item.kind === 'contradiction' ? (
                        <b>⚠ {item.topic}</b>
                      ) : (
                        <b>✎ {zhCN.compilation.recycleBinRepair}</b>
                      )}
                      <span>
                        {item.kind === 'contradiction'
                          ? (item.status === 'resolved' ? zhCN.compilation.resolved : zhCN.compilation.ignored)
                          : (item.chosen === 'accepted' ? zhCN.compilation.repairAccepted : zhCN.compilation.repairReject)}
                      </span>
                    </div>
                    <div className="recycle-bin-item-variants">
                      {item.kind === 'contradiction' ? (
                        item.contradiction.variants.map((v) => (
                          <div key={v.id} className="recycle-bin-variant">《{v.sourceTitle ?? v.sourceId}》 {v.variantText}</div>
                        ))
                      ) : (
                        <div className="recycle-bin-variant">
                          <div className="compilation-repair__original">{zhCN.compilation.repairOriginal}：{item.originalText}</div>
                          <div className="compilation-repair__revised">{zhCN.compilation.repairRevised}：{item.revisedText}</div>
                        </div>
                      )}
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
