import { useEffect, useRef, useState } from 'react'
import { zhCN } from '../i18n/zh-CN'
import { copyPlainText } from '../utils/clipboard'
import { splitRefTokens } from '../utils/ref-text'

export interface ChatMessageItem {
  role: 'user' | 'assistant'
  content: string
}
export interface ProviderOption { id: string; name: string }
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
  onGenerate: (instruction: string) => void
  onChat: (message: string) => void
  /** 自定义主按钮文案（如「生成资料汇编」），提供时覆盖 draftExisted 判断的默认文案 */
  primaryLabel?: string
  /** 自定义主按钮动作：提供时点击主按钮优先走此动作（用于 Step 1 生成资料汇编） */
  onPrimaryAction?: (text: string) => void
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
  onGenerate,
  onChat,
  primaryLabel,
  onPrimaryAction,
  refs,
  onOpenSource
}: ChatPanelProps) {
  const [input, setInput] = useState('')
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
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
    if (onPrimaryAction) onPrimaryAction(v)
    else if (draftExisted) onChat(v)
    else onGenerate(v)
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
          {primaryLabel ?? (draftExisted ? zhCN.writingChat.sendBtn : zhCN.writingChat.generateBtn)}
        </button>
      </div>
    </div>
  )
}

export default ChatPanel
