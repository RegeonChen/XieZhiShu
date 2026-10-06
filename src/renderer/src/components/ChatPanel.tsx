import { useEffect, useRef, useState } from 'react'
import { zhCN } from '../i18n/zh-CN'
import { copyPlainText } from '../utils/clipboard'
import { splitRefTokens } from '../utils/ref-text'
import MarkdownText from './MarkdownText'
import EdgeResizeHandle from './EdgeResizeHandle'

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

/**
 * 2026-10-05（用户要求）：抓取中的「暂停抓取 / 继续抓取」。
 * 只在网页抓取**正在进行**时出现（`fetch.active`）；暂停后按钮变「继续抓取」并显示提示文本，
 * 点「继续抓取」后按钮变回「暂停抓取」、提示消失、进度从原处接着跑。
 */
function FetchPauseControl({
  fetch,
  paused,
  onToggle
}: {
  fetch?: { active: boolean; paused: boolean }
  paused: boolean
  onToggle?: (paused: boolean) => void
}): React.ReactElement | null {
  if (!fetch?.active || !onToggle) return null
  const isPaused = paused || fetch.paused
  return (
    <div className="chat-panel__fetch-ctl">
      <button
        type="button"
        className="chat-panel__fetch-btn"
        onClick={() => onToggle(!isPaused)}
      >
        {isPaused ? zhCN.compilation.crawlResumeBtn : zhCN.compilation.crawlPauseBtn}
      </button>
      {isPaused ? <div className="chat-panel__fetch-hint">{zhCN.compilation.crawlPausedHint}</div> : null}
    </div>
  )
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
  /** 生成初稿进度（2026-08-11：percent 进度百分比 + etaSeconds 预计剩余秒数，供进度条显示）
   *  2026-10-05：`fetch` 表示"网页抓取正在进行"（据此显示「暂停抓取 / 继续抓取」按钮） */
  progress?: { percent: number; etaSeconds?: number; fetch?: { active: boolean; paused: boolean } } | null
  /** 2026-10-05：抓取是否处于暂停态（渲染层自己的状态，点按钮后立即反馈，不等主进程回包） */
  fetchPaused?: boolean
  /** 2026-10-05：点「暂停抓取 / 继续抓取」 */
  onToggleFetchPause?: (paused: boolean) => void
  /** 生成资料汇编时大模型异常中断信息（Phase 6.x：展示「尝试继续」断点续传） */
  interrupt?: { stage: string; message: string; percent: number } | null
  /** 点击「尝试继续」：从断点继续生成资料汇编 */
  onRetryCompilation?: () => void
  onGenerate: (instruction: string) => void
  onChat: (message: string) => void
  /** 自定义主按钮文案（如「生成资料汇编」），提供时覆盖 draftExisted 判断的默认文案 */
  primaryLabel?: string
  /** 自定义主按钮动作：提供时点击主按钮优先走此动作（用于 Step 1 生成资料汇编） */
  onPrimaryAction?: (text: string) => void
  /** 展示「预设提示词」按钮 + 弹出面板（点击把模板填入输入框） */
  showPresetButton?: boolean
  /** 当前任务是否已有资料汇编：决定「调整现有汇编」一组预设是否可用 */
  hasCompilation?: boolean
  /** 来源引用清单（最近一次文段来源询问），供消息内 #N 渲染为链接 */
  refs?: SourceRefItem[]
  /** 打开来源文件（系统默认软件） */
  onOpenSource?: (sourceId: string) => void
  /**
   * 资料年份范围（2026-10-04 用户裁定）：**在任务流程里**选择，不再去资料库面板。
   * 不传 = 不渲染该控件（其它调用方零影响）；只有「生成汇编」的首次撰写要求才传。
   */
  webYears?: { from?: number; to?: number }
  /** 是否显示年份控件（仅"还没有汇编"的新任务显示；发送成功后由父组件收起） */
  showWebYears?: boolean
  /** 年份变化：合法即回调（保存由调用方负责，走任务级 IPC） */
  onWebYearsChange?: (from: number, to: number) => void
  /**
   * 区间规模预览（2026-10-05 用户裁定 A：从资料库面板搬到这里的年份控件下方）。
   * **成品文案由父组件查主进程后传入**——本组件与 `CompilationStep` 一样**不直接调 IPC**（纯呈现约定）。
   */
  webYearsPreview?: { text: string; distribution?: string | null; warning?: string | null } | null
  /** 年份输入两个都合法时按 400ms 防抖回调一次（`null` = 当前输入不合法，请清掉预览） */
  onWebYearsPreviewQuery?: (years: { from: number; to: number } | null) => void
  /**
   * 「取消生成」后把刚提交的那段文字**回填输入框**（2026-10-05 用户要求）。
   * 为什么需要它：`submit()` 会先清空输入框再回调父组件，父组件若因二次确认被取消而不生成，
   * 用户刚敲的撰写要求就被吞掉了，只能重敲一遍——这与项目「不让用户重复操作」的口径相悖。
   * 语义：`seq` 是自增触发值，**同一段文字被取消两次也能回填**（只比较文本会让第二次失效）。
   */
  restoreDraft?: { text: string; seq: number } | null
}

/**
 * 内联「资料年份范围」（仅生成汇编首次撰写要求时显示）。
 * 口径与后端一致：`published_date` 落在区间内的网页文章才会被抓取并按正文重筛；
 * 本地资料（年鉴/文档）不受此限。
 */
function WebYearsInline({
  years,
  busy,
  preview,
  onChange,
  onPreviewQuery
}: {
  years?: { from?: number; to?: number }
  busy: boolean
  preview?: { text: string; distribution?: string | null; warning?: string | null } | null
  onChange?: (from: number, to: number) => void
  onPreviewQuery?: (years: { from: number; to: number } | null) => void
}): JSX.Element {
  const maxYear = new Date().getFullYear() + 1
  const [from, setFrom] = useState(years?.from != null ? String(years.from) : '')
  const [to, setTo] = useState(years?.to != null ? String(years.to) : '')
  useEffect(() => {
    setFrom(years?.from != null ? String(years.from) : '')
    setTo(years?.to != null ? String(years.to) : '')
  }, [years?.from, years?.to])
  const f = Number(from)
  const t = Number(to)
  const valid = Number.isInteger(f) && Number.isInteger(t) && f >= 1990 && t <= maxYear && f <= t
  // 输入合法 → 防抖 400ms 通知父组件统计"区间内多少篇、预计抓多久"（IPC 在父组件里）
  useEffect(() => {
    if (!onPreviewQuery) return
    if (!valid) {
      onPreviewQuery(null)
      return
    }
    const timer = setTimeout(() => onPreviewQuery({ from: f, to: t }), 400)
    return () => clearTimeout(timer)
  }, [f, t, valid, onPreviewQuery])
  return (
    <div className="chat-panel__web-years">
      <div className="chat-panel__web-years-row">
        <span className="chat-panel__web-years-title">{zhCN.compilation.webYearTitle}</span>
        <input
          type="number"
          className="chat-panel__web-years-input"
          placeholder={zhCN.compilation.webYearFrom}
          min={1990}
          max={maxYear}
          value={from}
          disabled={busy}
          onChange={(e) => setFrom(e.target.value)}
          aria-label={zhCN.compilation.webYearFrom}
        />
        <span className="chat-panel__web-years-sep">–</span>
        <input
          type="number"
          className="chat-panel__web-years-input"
          placeholder={zhCN.compilation.webYearTo}
          min={1990}
          max={maxYear}
          value={to}
          disabled={busy}
          onChange={(e) => setTo(e.target.value)}
          aria-label={zhCN.compilation.webYearTo}
        />
        <span className="chat-panel__web-years-hint">{valid ? zhCN.compilation.webYearHint : zhCN.compilation.webYearInvalid}</span>
        <button
          type="button"
          className="source-list__btn chat-panel__web-years-save"
          disabled={busy || !valid}
          onClick={() => onChange?.(f, t)}
        >
          {zhCN.compilation.webYearApply}
        </button>
      </div>
      {/* 区间规模预览（选完年份立刻知道"这次要抓多少篇、大概多久"） */}
      {valid && preview?.text ? <p className="chat-panel__web-years-preview">{preview.text}</p> : null}
      {valid && preview?.distribution ? (
        <p className="chat-panel__web-years-preview chat-panel__web-years-preview--dist">{preview.distribution}</p>
      ) : null}
      {valid && preview?.warning ? (
        <p className="chat-panel__web-years-preview chat-panel__web-years-preview--warn">{preview.warning}</p>
      ) : null}
    </div>
  )
}

/** 秒 → "约 X–Y 秒 / 约 X–Y 分钟"（区间化，体现 AI 耗时不确定性，C） */
function formatEtaRange(sec: number): string {
  const s = Math.max(5, Math.round(sec))
  const low = Math.max(0, s - Math.round(s * 0.2))
  const high = s + Math.round(s * 0.25)
  if (high < 60) return `约 ${low}–${high} 秒`
  const lowM = Math.max(0, Math.round(low / 60))
  const highM = Math.max(0, Math.round(high / 60))
  if (lowM !== highM) return `约 ${lowM}–${highM} 分钟`
  return `约 ${lowM} 分钟`
}

/** 预设提示词的图标（与全站一致：24×24 描边内联 SVG，随文字色） */
function PresetIcon({ name }: { name: 'doc' | 'trash' | 'plus' }): React.ReactElement {
  const common = {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  if (name === 'trash') {
    return (
      <svg {...common}>
        <path d="M3 6h18" />
        <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
        <path d="M18.5 6l-.9 13a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.5 6" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    )
  }
  if (name === 'plus') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8.5v7M8.5 12h7" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z" />
      <path d="M14 3v4h4" />
      <path d="M9.5 12.5h5M9.5 16h3.5" />
    </svg>
  )
}

/** 预设提示词分组（文本取自 i18n 文案资源） */
interface PresetItem {
  id: string
  label: string
  desc: string
  text: string
  icon: 'doc' | 'trash' | 'plus'
}
function presetGroups(t: typeof zhCN.compilation): { id: 'generate' | 'adjust'; title: string; items: PresetItem[] }[] {
  return [
    {
      id: 'generate',
      title: t.presetGroupGenerate,
      items: [
        { id: 'title-req', label: t.presetTitleReqLabel, desc: t.presetTitleReqDesc, text: t.presetTitleReq, icon: 'doc' }
      ]
    },
    {
      id: 'adjust',
      title: t.presetGroupAdjust,
      items: [
        { id: 'batch-delete', label: t.presetBatchDeleteLabel, desc: t.presetBatchDeleteDesc, text: t.presetBatchDelete, icon: 'trash' },
        { id: 'add-content', label: t.presetAddContentLabel, desc: t.presetAddContentDesc, text: t.presetAddContent, icon: 'plus' }
      ]
    }
  ]
}

function ChatPanel({
  messages,
  draftExisted,
  busy,
  busyText,
  streamText = null,
  progress,
  interrupt = null,
  onRetryCompilation,
  onGenerate,
  onChat,
  primaryLabel,
  onPrimaryAction,
  showPresetButton,
  hasCompilation = false,
  refs,
  onOpenSource,
  webYears,
  showWebYears,
  onWebYearsChange,
  webYearsPreview,
  onWebYearsPreviewQuery,
  fetchPaused = false,
  onToggleFetchPause,
  restoreDraft = null
}: ChatPanelProps) {
  const [input, setInput] = useState('')
  /** 输入框高度（null = 用 rows 默认；拖它的上边界后为显式像素值） */
  const [inputH, setInputH] = useState<number | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [presetOpen, setPresetOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const presetRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // C：对预计剩余秒数做 EMA 平滑，避免进度回调抖动；新一次生成时重置
  const smoothEtaRef = useRef<number | null>(null)
  const rawEta = progress?.etaSeconds
  if (progress && rawEta != null && rawEta > 0) {
    const prev = smoothEtaRef.current
    smoothEtaRef.current = prev == null ? Math.round(rawEta) : Math.round(prev * 0.5 + rawEta * 0.5)
  } else if (!progress) {
    smoothEtaRef.current = null
  }
  const displayEtaSec = smoothEtaRef.current

  // 自动滚动：用户已接近底部时才跟随（正在阅读历史时不抢滚动位置）；busy 提示始终可见
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom || busyText) el.scrollTop = el.scrollHeight
  }, [messages, busyText, streamText])

  /** 已回填过的 `restoreDraft.seq`（只处理比它更大的触发值，避免 effect 重跑把用户新输入覆盖掉） */
  const restoredSeqRef = useRef(0)
  /** 「取消生成」后回填文字（见 props.restoreDraft）：写入输入框并聚焦、光标落在末尾，用户可直接改完再发 */
  useEffect(() => {
    if (!restoreDraft || restoreDraft.seq <= restoredSeqRef.current) return
    restoredSeqRef.current = restoreDraft.seq
    if (!restoreDraft.text.trim()) return
    setInput(restoreDraft.text)
    window.requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(restoreDraft.text.length, restoreDraft.text.length)
    })
  }, [restoreDraft])

  /** 复制某条 AI 回复（纯文本） */
  const handleCopy = async (idx: number, text: string): Promise<void> => {
    const ok = await copyPlainText(text)
    if (ok) {
      setCopiedIdx(idx)
      window.setTimeout(() => setCopiedIdx(null), 1500)
    }
  }

  /** 预设面板：点击面板外或按 Esc 关闭（与全站弹层一致的关闭预期） */
  useEffect(() => {
    if (!presetOpen) return
    const onDocDown = (e: MouseEvent): void => {
      if (presetRef.current && !presetRef.current.contains(e.target as Node)) setPresetOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPresetOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [presetOpen])

  /**
   * 填入一条预设提示词：追加到输入框（已有内容时换行追加，不覆盖用户已输入的文字），
   * 并把光标选中第一个「……」占位符，用户可直接输入覆盖；随后聚焦输入框。
   */
  const applyPreset = (text: string): void => {
    setPresetOpen(false)
    const next = input.trim() ? input.replace(/\s+$/, '') + '\n' + text : text
    setInput(next)
    window.requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const at = next.indexOf('……')
      if (at >= 0) el.setSelectionRange(at, at + 2)
      else el.setSelectionRange(next.length, next.length)
    })
  }

  const submit = () => {
    const v = input.trim()
    if (!v || busy) return
    setInput('')
    if (onPrimaryAction) onPrimaryAction(v)
    else if (draftExisted) onChat(v)
    else onGenerate(v)
  }

  /**
   * 渲染 assistant 消息（2026-10-03 起支持 Markdown）：
   * 标题/列表/代码/引用/表格由 `MarkdownText` 建元素渲染；**行内文字**走 `splitRefTokens`，
   * 于是"Markdown 里的 `#N` 来源引用"照样是可点链接。
   */
  const renderAssistantContent = (content: string, trailing?: React.ReactNode): React.ReactNode => {
    const valid = new Set((refs ?? []).map((r) => r.index))
    const sourceByIndex = new Map((refs ?? []).map((r) => [r.index, r]))
    const renderText = (text: string): React.ReactNode =>
      splitRefTokens(text, valid).map((tok, i) =>
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
    return <MarkdownText text={content} renderText={renderText} trailing={trailing} />
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
                    {displayEtaSec != null && displayEtaSec > 0 ? (
                      <span>{zhCN.writingChat.etaText.replace('{time}', formatEtaRange(displayEtaSec))}</span>
                    ) : null}
                  </div>
                  <FetchPauseControl fetch={progress.fetch} paused={fetchPaused} onToggle={onToggleFetchPause} />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {busy && streamText ? (
          <div className="chat-panel__msg chat-panel__msg--assistant">
            <div className="chat-panel__assistant-block">
              <span className="chat-panel__bubble chat-panel__bubble--streaming">
                {renderAssistantContent(streamText, <span className="stream-cursor" aria-hidden="true" />)}
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
                    {displayEtaSec != null && displayEtaSec > 0 ? (
                      <span>{zhCN.writingChat.etaText.replace('{time}', formatEtaRange(displayEtaSec))}</span>
                    ) : null}
                  </div>
                  <FetchPauseControl fetch={progress.fetch} paused={fetchPaused} onToggle={onToggleFetchPause} />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {interrupt ? (
          <div className="chat-panel__interrupt">
            <div className="chat-panel__interrupt-title">{zhCN.compilation.interruptedTitle}</div>
            <div className="chat-panel__progress-track">
              <div className="chat-panel__progress-bar" style={{ width: `${Math.min(100, Math.max(0, interrupt.percent))}%` }} />
            </div>
            <div className="chat-panel__progress-meta"><span>{Math.round(interrupt.percent)}%</span></div>
            <div className="chat-panel__interrupt-stage">{interrupt.stage}</div>
            <div className="chat-panel__interrupt-reason">{interrupt.message}</div>
            {onRetryCompilation ? (
              <button type="button" className="chat-panel__retry-btn" onClick={onRetryCompilation}>
                {zhCN.compilation.continueBtn}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {showPresetButton ? (
        <div className="chat-panel__presets" ref={presetRef}>
          <button
            type="button"
            className={`chat-panel__preset-trigger${presetOpen ? ' is-open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={presetOpen}
            disabled={busy}
            onClick={() => setPresetOpen((o) => !o)}
          >
            <svg
              className="chat-panel__preset-trigger-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M11 3.5l1.5 4.2 4.2 1.5-4.2 1.5L11 15l-1.5-4.3L5.3 9.2l4.2-1.5z" />
              <path d="M18 15l.8 2.2 2.2.8-2.2.8L18 21l-.8-2.2-2.2-.8 2.2-.8z" />
            </svg>
            <span>{zhCN.compilation.presetButton}</span>
            <svg
              className="chat-panel__preset-trigger-chevron"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 14.5l6-6 6 6" />
            </svg>
          </button>
          {presetOpen ? (
            <div className="chat-panel__preset-popover" role="menu">
              <div className="chat-panel__preset-head">
                <div className="chat-panel__preset-title">{zhCN.compilation.presetMenuTitle}</div>
                <div className="chat-panel__preset-hint">{zhCN.compilation.presetMenuHint}</div>
              </div>
              {presetGroups(zhCN.compilation).map((group) => {
                const locked = group.id === 'adjust' && !hasCompilation
                return (
                  <div className="chat-panel__preset-group" key={group.id}>
                    <div className="chat-panel__preset-group-title">{group.title}</div>
                    {group.items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        className={`chat-panel__preset-item${locked ? ' is-locked' : ''}`}
                        disabled={locked}
                        title={locked ? zhCN.compilation.presetLockedHint : item.text}
                        onClick={() => applyPreset(item.text)}
                      >
                        <span className="chat-panel__preset-item-icon">
                          <PresetIcon name={item.icon} />
                        </span>
                        <span className="chat-panel__preset-item-body">
                          <span className="chat-panel__preset-item-name">{item.label}</span>
                          <span className="chat-panel__preset-item-desc">{item.desc}</span>
                          <span className="chat-panel__preset-item-preview">{item.text.replace(/\n+/g, ' ')}</span>
                        </span>
                        <span className="chat-panel__preset-item-badge">
                          {locked ? zhCN.compilation.presetLockedHint : zhCN.compilation.presetInsert}
                        </span>
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {/*
        2026-10-05 用户裁定：年份范围在**任务流程里**选、显示在**输入框上方**（独立一行）。
        ⚠ 真机自检（CDP 截图）抓到过一版错误实现：把它塞进下面这个 `.chat-panel__input-row`
        里就变成横向 flex 的第三个子元素，输入框 `flex:1; min-width:0` 被挤成 0 宽、直接从界面上消失。
        所以它必须在输入行**之外、之上**。
      */}
      {showWebYears ? (
        <WebYearsInline
          years={webYears}
          busy={busy}
          preview={webYearsPreview}
          onChange={onWebYearsChange}
          onPreviewQuery={onWebYearsPreviewQuery}
        />
      ) : null}

      <div className="chat-panel__input-row">
        <textarea
          className="chat-panel__input"
          ref={inputRef}
          rows={2}
          style={inputH != null ? { height: inputH } : undefined}
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
        {/* 输入框的上边界：拖着它上下移动即改输入框高度（边界跟着鼠标走，符合常见习惯） */}
        <EdgeResizeHandle
          edge="top"
          className="chat-panel__input-edge"
          title={zhCN.writingChat.inputResizeHint}
          onStart={() => setInputH((h) => h ?? inputRef.current?.offsetHeight ?? null)}
          onDelta={(d) => {
            setInputH((h) => {
              const base = h ?? inputRef.current?.offsetHeight
              if (base == null) return h
              return Math.round(Math.min(Math.max(base + d, 44), 320))
            })
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
