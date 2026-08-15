/**
 * logger.ts —— 诊断日志核心（2026-08-14）。
 * 内存环形缓冲保存最近 N 条日志，供「日志导出」一键导出，用于复现用户试用过程中出现的 bug。
 * 记录来源：
 *   - 主进程：应用生命周期、IPC 调用、资料库/工作区变动、LLM 调用；
 *   - 渲染进程：UI 交互（按钮点击、页面切换等）通过 log:append 上报。
 * 敏感信息（API key / token / secret 等）一律脱敏，绝不写入日志。
 */
import { app } from 'electron'

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'
type LogSource = 'main' | 'renderer'

interface LogEntry {
  ts: number
  level: LogLevel
  source: LogSource
  /** 类别：app / ipc / ui / llm / db / workspace / web 等 */
  tag: string
  message: string
}

/** 环形缓冲上限：保留最近 1000 条交互日志（2026-08-14 由 2000 下调，为提交物记录留出空间） */
const MAX_BUFFER = 1000
const buffer: LogEntry[] = []

/** 大模型提交物（发送给模型的消息内容）记录上限：内容较大，保留最近 20 条 */
const MAX_PAYLOAD_BUFFER = 20
const payloadBuffer: LlmPayloadEntry[] = []

/** 单条 message 内容截断上限（超出则截断并标注原长度） */
const MAX_MESSAGE_CONTENT = 2000

/** 大模型提交物中的单条消息 */
export interface LlmMessage {
  role: string
  content: string
}

interface LlmPayloadEntry {
  ts: number
  kind: string
  model: string
  messages: LlmMessage[]
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function push(entry: LogEntry): void {
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER) buffer.shift()
  // 同步输出到主进程控制台，便于开发调试
  // eslint-disable-next-line no-console
  console.log(`[${formatTs(entry.ts)}] [${entry.level.padEnd(5)}] [${entry.source.padEnd(8)}] [${entry.tag}] ${entry.message}`)
}

export function log(level: LogLevel, source: LogSource, tag: string, message: string): void {
  try {
    push({ ts: Date.now(), level, source, tag, message })
  } catch {
    // 日志写入失败不影响主流程
  }
}

/** 主进程日志 */
export function logMain(tag: string, message: string, level: LogLevel = 'INFO'): void {
  log(level, 'main', tag, message)
}

/** 渲染进程上报的日志（经 log:append 进入） */
export function logRenderer(tag: string, message: string, level: LogLevel = 'INFO'): void {
  log(level, 'renderer', tag, message)
}

/** 脱敏：递归替换敏感字段，避免 API key 等泄入日志 */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[…]'
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/key|secret|token|authorization|password|apikey/i.test(k)) out[k] = '***'
      else out[k] = sanitize(v, depth + 1)
    }
    return out
  }
  return value
}

/** 将参数序列化为可读摘要（脱敏 + 截断，避免日志膨胀） */
function summarize(value: unknown, maxLen = 300): string {
  const json = JSON.stringify(sanitize(value))
  const text = json === undefined ? String(value) : json
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text
}

/** 记录一次 IPC 调用（通道 + 脱敏参数摘要） */
export function logIpc(channel: string, args: unknown[]): void {
  const argSummary = args.length === 0 ? '' : summarize(args.length === 1 ? args[0] : args)
  logMain('ipc', `${channel}${argSummary ? ` ${argSummary}` : ''}`)
}

/** 记录一次 LLM 调用（不含密钥与正文，只留元数据） */
export function logLlm(
  kind: string,
  model: string,
  inputChars: number,
  outputChars: number,
  elapsedMs: number,
  ok: boolean,
  errorCode?: string
): void {
  const status = ok ? '成功' : `失败${errorCode ? `(${errorCode})` : ''}`
  logMain('llm', `${kind} 模型=${model} 输入=${inputChars}字 输出=${outputChars}字 耗时=${elapsedMs}ms ${status}`)
}

/** 记录一次发送给大模型的提交物内容（system/user/assistant 消息全文，单条截断，供复现大模型相关 bug） */
export function logLlmPayload(kind: string, model: string, messages: LlmMessage[]): void {
  try {
    payloadBuffer.push({
      ts: Date.now(),
      kind,
      model,
      messages: messages.map((m) => {
        const content = m.content ?? ''
        return {
          role: m.role,
          content: content.length > MAX_MESSAGE_CONTENT
            ? `${content.slice(0, MAX_MESSAGE_CONTENT)}\n…（截断，原 ${content.length} 字）`
            : content
        }
      })
    })
    if (payloadBuffer.length > MAX_PAYLOAD_BUFFER) payloadBuffer.shift()
  } catch {
    // 记录失败不影响主流程
  }
}

/** 导出日志文本（含环境头部 + 交互日志 + 大模型提交物记录） */
export function exportLogsText(): string {
  const lines: string[] = []
  lines.push('================================================================')
  lines.push('志书撰写工具 诊断日志')
  lines.push(`导出时间: ${formatTs(Date.now())}`)
  try {
    lines.push(`应用版本: ${app.getVersion()}`)
  } catch {
    lines.push('应用版本: (未知)')
  }
  lines.push(`平台: ${process.platform} (${process.arch})`)
  lines.push(`Electron: ${process.versions.electron}`)
  lines.push(`交互日志条数: ${buffer.length}`)
  lines.push(`大模型提交物条数: ${payloadBuffer.length}`)
  lines.push('================================================================')
  for (const entry of buffer) {
    lines.push(`[${formatTs(entry.ts)}] [${entry.level.padEnd(5)}] [${entry.source.padEnd(8)}] [${entry.tag}] ${entry.message}`)
  }

  if (payloadBuffer.length > 0) {
    lines.push('')
    lines.push('================================================================')
    lines.push('大模型提交物记录（发送给模型的消息内容，单条已截断）')
    lines.push('================================================================')
    payloadBuffer.forEach((payload, index) => {
      lines.push('')
      lines.push(`#${index + 1} [${formatTs(payload.ts)}] kind=${payload.kind} 模型=${payload.model}`)
      payload.messages.forEach((m) => {
        lines.push(`  --- [${m.role}] ---`)
        lines.push(m.content)
      })
    })
  }

  return lines.join('\n')
}

export function getLogCount(): number {
  return buffer.length
}
