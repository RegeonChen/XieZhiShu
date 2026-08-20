import { useEffect, useRef, useState } from 'react'
import { zhCN } from '../i18n/zh-CN'
import { copyPlainText } from '../utils/clipboard'
import { splitRefTokens } from '../utils/ref-text'
import SkillPickerDialog, { type PickerSkillOption } from './SkillPickerDialog'

export interface ChatMessageItem {
  role: 'user' | 'assistant'
  content: string
}
export interface ProviderOption { id: string; name: string }
export interface SkillOption { id: string; name: string; tags?: string[] }
/** 来源引用（Phase 3.7 Task 3.7.5：与回复中的 #N 对应，可点击打开原文） */
export interface SourceRefItem {
  index: number
  sourceId: string
  title: string
  position?: string
}

interface ChatPanelProps {
  messages: ChatMessageItem[]
  /** 初稿是否已生成：未生成时主按钮为「生成初稿」，已生成时为「发送」 */
  draftExisted: boolean
  /** 生成/对话进行中（展示状态文本并禁用输入） */
  busy: boolean
  busyText: string | null
  /** 流式增量文本（2026-08-19：生成/对话期间实时显示的正文或回复） */
  streamText?: string | null
  /** 生成初稿进度（2026-08-11：percent 进度百分比 + etaSeconds 预计剩余秒数，供进度条显示） */
  progress?: { percent: number; etaSeconds?: number } | null
  sectionSkills: SkillOption[] | null
  /** 已选中的部类细则规范 id；空数组 = 未手动选定（生成时按标题自动匹配） */
  selectedSkillIds: string[]
  onSkillsChange: (ids: string[]) => void
  /** 文章标题（初稿已生成时；智能匹配的兜底需求文本） */
  articleTitle?: string
  /** 智能匹配写作规范（上层调用大模型并写回任务） */
  onSuggestSkills: (need: string) => Promise<void>
  providers: ProviderOption[] | null
  providerId?: string
  onProviderChange: (id: string) => void
  onGenerate: (instruction: string) => void
  onChat: (message: string) => void
  /** 来源引用清单（最近一次文段来源询问），供消息内 #N 渲染为链接 */
  refs?: SourceRefItem[]
  /** 打开来源文件（系统默认软件） */
  onOpenSource?: (sourceId: string) => void
}

/** 秒 → "X 分 Y 秒"（进度剩余时间展示） */
function formatEta(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest > 0 ? `${m} 分 ${rest} 秒` : `${m} 分钟`
}

function ChatPanel({
  messages,
  draftExisted,
  busy,
  busyText,
  streamText = null,
  progress,
  sectionSkills,
  selectedSkillIds,
  onSkillsChange,
  articleTitle,
  onSuggestSkills,
  providers,
  providerId,
  onProviderChange,
  onGenerate,
  onChat,
  refs,
  onOpenSource
}: ChatPanelProps) {
  const [input, setInput] = useState('')
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestHint, setSuggestHint] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // 自动滚动：用户已接近底部时才跟随（正在阅读历史时不抢滚动位置）；busy 提示始终可见
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom || busyText) el.scrollTop = el.scrollHeight
  }, [messages, busyText, streamText])

  /** 复制某条 AI 回复（纯文本） */
  const handleCopy = async (idx: number, text: string): Promise<void> => {
    const ok = await copyPlainText(text)
    if (ok) {
      setCopiedIdx(idx)
      window.setTimeout(() => setCopiedIdx(null), 1500)
    }
  }

  const submit = () => {
    const v = input.trim()
    if (!v || busy) return
    setInput('')
    if (draftExisted) onChat(v)
    else onGenerate(v)
  }

  /** 智能匹配：优先用输入框中的撰写要求，其次用文章标题 */
  const handleSuggest = async () => {
    if (suggesting || busy) return
    const need = input.trim() || (articleTitle ?? '').trim()
    if (!need) {
      setSuggestHint(zhCN.writingChat.suggestNeedEmpty)
      return
    }
    setSuggesting(true)
    setSuggestHint(null)
    try {
      await onSuggestSkills(need)
    } finally {
      setSuggesting(false)
    }
  }

  /** 手动选择弹窗确认：写回选中的规范 id */
  const handlePickerConfirm = (ids: string[]) => {
    setPickerOpen(false)
    onSkillsChange(ids)
  }

  /** 渲染 assistant 消息：来源编号 #N 渲染为可点击链接（来源引用），其余为纯文本 */
  const renderAssistantContent = (content: string): React.ReactNode => {
    const valid = new Set((refs ?? []).map((r) => r.index))
    const sourceByIndex = new Map((refs ?? []).map((r) => [r.index, r]))
    return splitRefTokens(content, valid).map((tok, i) =>
      tok.type === 'ref' ? (
        <button
          key={i}
          type="button"
          className="chat-panel__ref-link"
          title={zhCN.writingChat.openSourceHint.replace('{title}', sourceByIndex.get(tok.index)?.title ?? '')}
          onClick={() => {
            const s = sourceByIndex.get(tok.index)
            if (s) onOpenSource?.(s.sourceId)
          }}
        >
          {tok.text}
        </button>
      ) : (
        <span key={i}>{tok.text}</span>
      )
    )
  }

  return (
    <div className="chat-panel">
      <div className="chat-panel__messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-panel__empty">
            <p className="chat-panel__empty-title">{zhCN.writingChat.emptyHintTitle}</p>
            <p className="chat-panel__empty-steps">
              {zhCN.writingChat.emptyHintSteps.split('\n').map((line, i) => (
                <span key={i}>
                  {line}
                  <br />
                </span>
              ))}
            </p>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`chat-panel__msg chat-panel__msg--${m.role}`}>
              {m.role === 'assistant' ? (
                <div className="chat-panel__assistant-block">
                  <span className="chat-panel__bubble">{renderAssistantContent(m.content)}</span>
                  <button
                    type="button"
                    className={`chat-panel__copy${copiedIdx === i ? ' is-copied' : ''}`}
                    title={zhCN.writingChat.copyReply}
                    onClick={() => void handleCopy(i, m.content)}
                  >
                    {copiedIdx === i ? (
                      <span className="chat-panel__copy-check">已复制</span>
                    ) : (
                      <svg className="copy-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                      </svg>
                    )}
                  </button>
                </div>
              ) : (
                <span className="chat-panel__bubble">{m.content}</span>
              )}
            </div>
          ))
        )}
        {busyText && !streamText ? (
          <div className="chat-panel__msg chat-panel__msg--assistant">
            <div className="chat-panel__bubble chat-panel__bubble--busy">
              <div>
                {busyText}
                <span className="typing-dots" aria-hidden="true">
                  <i /><i /><i />
                </span>
              </div>
              {progress ? (
                <div className="chat-panel__progress">
                  <div className="chat-panel__progress-track">
                    <div
                      className="chat-panel__progress-bar"
                      style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
                    />
                  </div>
                  <div className="chat-panel__progress-meta">
                    <span>{Math.round(progress.percent)}%</span>
                    {progress.etaSeconds != null && progress.etaSeconds > 0 ? (
                      <span>{zhCN.writingChat.etaText.replace('{time}', formatEta(progress.etaSeconds))}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {busy && streamText ? (
          <div className="chat-panel__msg chat-panel__msg--assistant">
            <div className="chat-panel__assistant-block">
              <span className="chat-panel__bubble chat-panel__bubble--streaming">
                {streamText}
                <span className="stream-cursor" aria-hidden="true" />
              </span>
              {progress ? (
                <div className="chat-panel__progress">
                  <div className="chat-panel__progress-track">
                    <div
                      className="chat-panel__progress-bar"
                      style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
                    />
                  </div>
                  <div className="chat-panel__progress-meta">
                    <span>{Math.round(progress.percent)}%</span>
                    {progress.etaSeconds != null && progress.etaSeconds > 0 ? (
                      <span>{zhCN.writingChat.etaText.replace('{time}', formatEta(progress.etaSeconds))}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="chat-panel__toolbar">
        <div className="chat-panel__field">
          <span className="chat-panel__label">{zhCN.writingChat.skillLabel}</span>
          <div className="chat-panel__skill-picker">
            {selectedSkillIds.length > 0 ? (
              <div className="chat-panel__skill-chips">
                {(sectionSkills ?? []).filter((s) => selectedSkillIds.includes(s.id)).map((s) => (
                  <span key={s.id} className="chat-panel__skill-chip">{s.name}</span>
                ))}
              </div>
            ) : (
              <span className="chat-panel__hint">{zhCN.writingChat.skillAuto}</span>
            )}
            <div className="chat-panel__skill-actions">
              <button
                type="button"
                className="source-list__btn"
                onClick={() => void handleSuggest()}
                disabled={draftExisted || suggesting || busy}
              >
                {suggesting ? zhCN.writingChat.suggesting : zhCN.writingChat.suggestBtn}
              </button>
              <button
                type="button"
                className="source-list__btn"
                onClick={() => setPickerOpen(true)}
                disabled={draftExisted || busy}
              >
                {zhCN.writingChat.pickBtn}
              </button>
            </div>
            {suggestHint ? <span className="chat-panel__hint">{suggestHint}</span> : null}
          </div>
        </div>
        <label className="chat-panel__field">
          <span className="chat-panel__label">{zhCN.writingChat.providerLabel}</span>
          <select
            className="writing-form__input writing-form__select"
            value={providerId ?? ''}
            onChange={(e) => onProviderChange(e.target.value)}
          >
            <option value="">{zhCN.writingChat.providerNone}</option>
            {(providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        {providers !== null && providers.length === 0 ? (
          <span className="chat-panel__hint">{zhCN.writingChat.providerLockHint}</span>
        ) : null}
      </div>

      <div className="chat-panel__input-row">
        <textarea
          className="chat-panel__input"
          rows={2}
          value={input}
          placeholder={zhCN.writingChat.inputPlaceholder}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button
          type="button"
          className={`source-list__btn${draftExisted ? '' : ' source-list__btn--primary'} chat-panel__send`}
          disabled={busy || !input.trim()}
          onClick={submit}
        >
          {draftExisted ? zhCN.writingChat.sendBtn : zhCN.writingChat.generateBtn}
        </button>
      </div>

      {pickerOpen ? (
        <SkillPickerDialog
          skills={(sectionSkills ?? []) as PickerSkillOption[]}
          selectedIds={selectedSkillIds}
          onConfirm={handlePickerConfirm}
          onCancel={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  )
}

export default ChatPanel
