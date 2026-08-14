import { useState, useEffect, useCallback, useRef } from 'react'
import { zhCN } from '../i18n/zh-CN'
import DraftEditor, { type DraftEditorHandle } from './DraftEditor'
import ConfirmDialog from './ConfirmDialog'
import ContradictionDialog from './ContradictionDialog'
import ChatPanel, { type ChatMessageItem, type ProviderOption, type SkillOption, type SourceRefItem } from './ChatPanel'
import type { Contradiction } from '../../../shared/types'

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

function WritingWorkspace({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const [task, setTask] = useState<TaskItem | null>(null)
  const [sectionSkills, setSectionSkills] = useState<SkillOption[] | null>(null)
  const [providers, setProviders] = useState<ProviderOption[] | null>(null)
  const [draft, setDraft] = useState<DraftItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessageItem[]>([])
  const [busy, setBusy] = useState<BusyState>(null)
  const [busyText, setBusyText] = useState<string | null>(null)
  /** 生成初稿进度（2026-08-11：主进程推送 percent + etaSeconds，ChatPanel 进度条展示） */
  const [progress, setProgress] = useState<{ percent: number; etaSeconds?: number } | null>(null)
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false)
  /** 当前稿的矛盾清单（Phase 3.7：生成响应或 draft:getContradictions 加载） */
  const [contradictions, setContradictions] = useState<Contradiction[]>([])
  /** 矛盾弹窗状态：矛盾/警告 总览 或 单条（seq） */
  const [dialogState, setDialogState] = useState<
    | { kind: 'contradiction' | 'warning'; mode: 'overview' }
    | { kind: 'contradiction' | 'warning'; mode: 'single'; seq: number }
    | null
  >(null)
  /** 最近一次文段来源询问的引用清单（Phase 3.7 Task 3.7.5：消息内 #N 渲染为链接） */
  const [sourceRefs, setSourceRefs] = useState<SourceRefItem[]>([])
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  /** 编辑器实例引用（2026-08-11：采纳正文修改走编辑器事务而非重挂载，以保留撤销历史） */
  const editorRef = useRef<DraftEditorHandle>(null)
  /** 正文 Markdown 快照 → 对应矛盾状态：撤销/重做命中时恢复（2026-08-11） */
  const adoptionSnapshotsRef = useRef(new Map<string, Contradiction[]>())
  const contradictionsRef = useRef(contradictions)
  contradictionsRef.current = contradictions

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      window.api.listSkills().then((res) => {
        const items = (res.ok && res.data ? res.data.items : []) as { id: string; name: string; category: string; tags?: string[] }[]
        setSectionSkills(items.filter((s) => s.category === 'section') as SkillOption[])
      }).catch(() => setSectionSkills([]))
      window.api.listProviders().then((res) => {
        setProviders(res.ok && res.data ? (res.data.items as ProviderOption[]) : [])
      }).catch(() => setProviders([]))

      const tRes = await window.api.listTasks()
      const found = tRes.ok && tRes.data
        ? (tRes.data.items as TaskItem[]).find((t) => t.id === taskId) ?? null
        : null
      setTask(found)
      if (!found) return

      const vRes = await window.api.getLatestDraftByTask(taskId)
      // 无稿时主进程返回 DRAFT_NOT_FOUND（ok:false），需同样按"空白"处理，避免旧任务初稿残留
      const latest = vRes.ok && vRes.data ? ((vRes.data as { draft: DraftItem | null }).draft ?? null) : null
      if (latest) {
        setDraft(latest)
        // 加载该稿的矛盾清单（Phase 3.7：编辑器标注 / 矛盾按钮）
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

      // 加载任务持久化的对话历史（Phase 3.5 后续）
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

  // 订阅生成初稿阶段进度（整理摘要 / 检索 / 扫描窗口 / 等待大模型回应 / 定位矛盾），更新状态提示与进度条
  useEffect(() => {
    const off = window.api.onDraftGenerateProgress?.((p) => {
      if (p.taskId === taskId) {
        setBusyText(p.stage)
        setProgress({ percent: p.percent, etaSeconds: p.etaSeconds })
      }
    })
    return () => { off?.() }
  }, [taskId])

  const appendAssistant = (text: string) => {
    setMessages((prev) => [...prev, { role: 'assistant', content: text }])
  }

  /** 从主进程重新加载任务的持久化消息（对话/生成记录均由主进程写入） */
  const reloadMessages = useCallback(async () => {
    const res = await window.api.listTaskMessages(taskId)
    if (res.ok && res.data) {
      setMessages(res.data.items.map((m) => ({ role: m.role, content: m.content })))
    }
  }, [taskId])

  /** 生成初稿（初稿生成前的主按钮）：把输入作为用户要求提交 */
  const handleGenerate = async (instruction: string) => {
    if (busy) return
    setMessages((prev) => [...prev, { role: 'user', content: instruction }])
    setBusy('generating')
    setBusyText(zhCN.writingChat.generating)
    try {
      const res = await window.api.generateDraft(taskId, instruction)
      if (res.ok && res.data) {
        const data = res.data as { draft: DraftItem; articleTitle: string | null; contradictions?: Contradiction[] }
        setDraft(data.draft)
        setContradictions(data.contradictions ?? [])
        setTask((cur) => (cur ? { ...cur, articleTitle: data.articleTitle ?? undefined } : cur))
        onChanged()
      }
      await reloadMessages()
    } finally {
      setBusy(null)
      setBusyText(null)
      setProgress(null)
    }
  }

  /** 自由对话（初稿生成后）：history 为当前消息列表（不含本条） */
  const handleChat = async (message: string) => {
    if (busy) return
    const history = messagesRef.current.map((m) => ({ role: m.role, content: m.content }))
    setMessages((prev) => [...prev, { role: 'user', content: message }])
    setBusy('chatting')
    setBusyText('正在等待大模型回应…')
    try {
      await window.api.chatWithTask(taskId, message, history)
      // 用户消息与回复（或失败提示）均由主进程写入，成功后统一重新加载
      await reloadMessages()
    } finally {
      setBusy(null)
      setBusyText(null)
      setProgress(null)
    }
  }

  /** 更新任务选定的部类细则规范（空数组 = 未手动选定、自动匹配；初稿已生成后禁用） */
  const handleSkillsChange = async (skillIds: string[]) => {
    if (!task || busy) return
    const res = await window.api.updateTaskSkills(task.id, skillIds.length > 0 ? skillIds : null)
    if (res.ok) {
      setTask((cur) => (cur ? { ...cur, skillIds: skillIds.length > 0 ? skillIds : undefined } : cur))
    } else {
      appendAssistant(`更新写作规范失败：${res.error?.message ?? ''}`)
    }
  }

  /** 智能匹配写作规范（2026-08-14）：单独请求大模型，把匹配结果写回任务 skillIds */
  const handleSuggestSkills = async (need: string) => {
    if (!task || busy) return
    const res = await window.api.suggestSkills(task.id, need)
    if (!res.ok) {
      appendAssistant(`智能匹配写作规范失败：${res.error?.message ?? ''}`)
      return
    }
    const ids = res.data?.skillIds ?? []
    const writeRes = await window.api.updateTaskSkills(task.id, ids.length > 0 ? ids : null)
    if (!writeRes.ok) {
      appendAssistant(`更新写作规范失败：${writeRes.error?.message ?? ''}`)
      return
    }
    setTask((cur) => (cur ? { ...cur, skillIds: ids.length > 0 ? ids : undefined } : cur))
    const names = (sectionSkills ?? []).filter((s) => ids.includes(s.id)).map((s) => s.name)
    appendAssistant(
      names.length > 0
        ? `已智能匹配到写作规范：${names.join('、')}`
        : '未匹配到合适的部类细则规范，生成时将按标题自动匹配。'
    )
  }

  /** 更换任务固定使用的大模型（'' 表示跟随全局设置） */
  const handleProviderChange = async (llmProviderId: string) => {
    if (!task || busy) return
    const res = await window.api.updateTaskProvider(task.id, llmProviderId === '' ? null : llmProviderId)
    if (res.ok) {
      setTask((cur) => (cur ? { ...cur, llmProviderId: llmProviderId === '' ? undefined : llmProviderId } : cur))
    } else {
      appendAssistant(`切换大模型失败：${res.error?.message ?? ''}`)
    }
  }

  /** 重新生成初稿：用上次生成时保存的要求（无则取最后一条用户消息） */
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
    try {
      const res = await window.api.regenerateDraft(taskId, instruction)
      if (res.ok && res.data) {
        const data = res.data as { draft: DraftItem; articleTitle: string | null; contradictions?: Contradiction[] }
        setDraft(data.draft)
        setContradictions(data.contradictions ?? [])
        setTask((cur) => (cur ? { ...cur, articleTitle: data.articleTitle ?? undefined } : cur))
        onChanged()
      }
      await reloadMessages()
    } finally {
      setBusy(null)
      setBusyText(null)
      setProgress(null)
    }
  }

  /** 编辑器 undo/redo 引起正文变化：命中采纳快照时回退/恢复矛盾状态，并同步主进程数据库 */
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

  if (loading) return <p className="source-list__status">{zhCN.writingWorkspace.loading}</p>
  if (err) return <p className="source-list__error">{err}</p>
  if (!task) return <p className="source-list__error">{zhCN.writingWorkspace.loadFailed.replace('{message}', '任务不存在')}</p>

  /** 矛盾取舍成功：用返回的矛盾替换列表中的对应项（Phase 3.7） */
  const handleContradictionResolved = (updated: Contradiction): void => {
    setContradictions((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
  }

  /**
   * 矛盾采纳 → 正文同步修订（2026-08-11，兼容"撤销"）：
   * 通过编辑器事务应用新整稿（setContent 进入 ProseMirror undo 历史，内置"撤销"一次即可恢复），
   * 不再重挂载销毁编辑器实例；同时记录"采纳前/后正文 → 矛盾状态"快照，供撤销/重做命中时回退。
   */
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

  // 分类：在正文（含定位未知）→ 矛盾；定位审查确认不在正文 → 警告（仅查看/忽略，不影响正文）
  const inDraftContradictions = contradictions.filter((c) => c.inDraft !== false)
  const warningContradictions = contradictions.filter((c) => c.inDraft === false)

  /** 打开矛盾来源文件（系统默认软件）；失败在对话区提示（Phase 3.7 Task 3.7.6） */
  const handleOpenSource = async (sourceId: string): Promise<void> => {
    const res = await window.api.openSourcePath(sourceId)
    if (!res.ok) {
      appendAssistant(`打开来源文件失败：${res.error?.message ?? ''}`)
    }
  }

  /** 文段来源询问（Phase 3.7 Task 3.7.5）：调用主进程（本地匹配/检索/LLM 兜底），消息已持久化，刷新对话区 */
  const handleAskSource = async (selection: string): Promise<void> => {
    if (busy) return
    const res = await window.api.askSource(taskId, selection)
    if (res.ok && res.data) {
      setSourceRefs(res.data.refs as SourceRefItem[])
    } else {
      appendAssistant(`来源询问失败：${res.error?.message ?? ''}`)
    }
    await reloadMessages()
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
        {draft ? (
          <button
            type="button"
            className="source-list__btn source-list__btn--danger"
            disabled={busy !== null}
            onClick={() => setConfirmingRegenerate(true)}
          >
            {zhCN.writingChat.regenerateBtn}
          </button>
        ) : null}
      </header>

      <div className="writing-workspace__body">
        <section className="writing-workspace__chat">
          <ChatPanel
            messages={messages}
            draftExisted={!!draft}
            busy={busy !== null}
            busyText={busyText}
            progress={progress}
            sectionSkills={sectionSkills}
            selectedSkillIds={task.skillIds ?? []}
            onSkillsChange={(ids) => void handleSkillsChange(ids)}
            articleTitle={task.articleTitle}
            onSuggestSkills={handleSuggestSkills}
            providers={providers}
            providerId={task.llmProviderId}
            onProviderChange={(id) => void handleProviderChange(id)}
            onGenerate={(instruction) => void handleGenerate(instruction)}
            onChat={(message) => void handleChat(message)}
            refs={sourceRefs}
            onOpenSource={(sourceId) => void handleOpenSource(sourceId)}
          />
        </section>

        <section className="writing-workspace__editor">
          {draft ? (
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
          ) : (
            <div className="writing-workspace__editor-placeholder">
              <p>{zhCN.writingChat.noDraftHint}</p>
            </div>
          )}
        </section>
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
    </div>
  )
}

export default WritingWorkspace
