/**
 * chat.ts —— OpenAI-compatible 对话调用（主进程 net.fetch）。
 * 供初稿生成等后续功能复用；错误统一映射为稳定的 LLM 错误码；不记录密钥。
 * 2026-08-19 增强：
 *  - 瞬时故障自动重试（429 / 5xx / 网络错误，指数退避；经 ChatCallOptions.maxRetries 开启，默认 0）；
 *  - 流式输出（ChatCallOptions.onDelta 提供时走 SSE，边接收边回调增量文本，用于生成/对话的实时显示）。
 */
import { net } from 'electron'
import { ErrorCodes } from '../../shared/types'
import { getDb } from '../db/connection'
import { logLlm, logLlmPayload } from '../logger'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatProvider {
  apiBase: string
  model: string
  apiKey: string
}

export type ChatResult = { ok: true; text: string } | { ok: false; error: { code: string; message: string } }

export const DEFAULT_CHAT_TIMEOUT_MS = 60000

/** 调用附加选项（2026-08-11）：temperature 覆盖默认采样——矛盾扫描/定位等需要确定性的调用传低值 */
export interface ChatCallOptions {
  temperature?: number
  /** 瞬时故障自动重试次数（HTTP 429 / 5xx / 网络错误，指数退避）；默认 0 = 不重试。成功路径零成本 */
  maxRetries?: number
  /** 提供时启用流式输出（SSE）：每收到一段增量文本回调一次；仍以完整结果返回 */
  onDelta?: (text: string) => void
}

/** 调用用途标记（用于 llm_call_logs 痕迹）：generate 初稿 / chat 对话 / summarize 摘要 / template 范本 / misc 其它 */
export interface ChatCallMeta {
  kind: string
  taskId?: string
}

/** 瞬时故障重试的退避延迟（毫秒） */
const RETRY_BACKOFF_MS = [800, 2000, 4000]
/** 单次调用最大允许的重试次数（防御性封顶，避免指数放大） */
const MAX_RETRIES = 3

/** 记录一次 LLM 调用痕迹（元数据；不存密钥/正文，只存字符数与耗时/状态，用于诊断慢调用） */
function logLlmCall(meta: ChatCallMeta, model: string, inputChars: number, outputChars: number, elapsedMs: number, result: ChatResult): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO llm_call_logs (id, task_id, kind, model, input_chars, output_chars, elapsed_ms, status, error_code, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        meta.taskId ?? null,
        meta.kind,
        model,
        inputChars,
        outputChars,
        elapsedMs,
        result.ok ? 'ok' : 'error',
        result.ok ? null : result.error.code,
        result.ok ? null : (result.error.message ?? '').slice(0, 200)
      )
  } catch { /* 日志写入失败不影响主流程 */ }
}

/** 从响应体中提取可读错误信息（不含密钥） */
function extractErrorMessage(raw: string): string | null {
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown } }
    const msg = body?.error?.message
    if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 200)
  } catch {
    // 非 JSON 响应，忽略
  }
  return null
}

/** 依据 HTTP 状态码映射 LLM 错误 */
export function classifyHttpError(status: number, bodyText: string): { code: string; message: string } {
  if (status === 401 || status === 403) {
    return { code: ErrorCodes.LLM_UNAUTHORIZED, message: '认证失败：API 密钥无效或无权访问（HTTP 401/403）' }
  }
  if (status === 429) {
    return { code: ErrorCodes.LLM_RATE_LIMIT, message: '请求过于频繁：触发限流（HTTP 429）' }
  }
  const providerMsg = extractErrorMessage(bodyText)
  return {
    code: ErrorCodes.LLM_PROVIDER_ERROR,
    message: providerMsg ?? `模型服务返回错误（HTTP ${status}）`
  }
}

/** 是否为可安全重试的瞬时故障（限流 / 服务端 5xx / 网络抖动）；4xx 与超时/空响应不重试 */
function isRetryable(code: string, status: number | null): boolean {
  if (code === ErrorCodes.LLM_RATE_LIMIT || code === ErrorCodes.LLM_NETWORK) return true
  return status !== null && status >= 500
}

export async function chatCompletion(provider: ChatProvider, messages: ChatMessage[], timeoutMs = DEFAULT_CHAT_TIMEOUT_MS, meta?: ChatCallMeta, opts?: ChatCallOptions): Promise<ChatResult> {
  const inputChars = JSON.stringify(messages).length
  const started = Date.now()
  const result = await doCompletion(provider, messages, timeoutMs, opts)
  const elapsedMs = Date.now() - started
  const kind = meta?.kind ?? 'misc'
  logLlmCall(
    meta ?? { kind: 'misc' },
    provider.model,
    inputChars,
    result.ok ? result.text.length : 0,
    elapsedMs,
    result
  )
  // 诊断日志（内存缓冲，供「日志导出」；不含密钥）
  logLlm(
    kind,
    provider.model,
    inputChars,
    result.ok ? result.text.length : 0,
    elapsedMs,
    result.ok,
    result.ok ? undefined : result.error.code
  )
  // 记录提交物内容（仅关键调用；矛盾扫描/摘要等高频调用跳过，避免淹没提交物缓冲）
  if (kind === 'generate' || kind === 'chat' || kind === 'suggest-skills' || kind === 'contradiction-locate') {
    logLlmPayload(kind, provider.model, messages)
  }
  return result
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 单次请求（无重试）：返回结果 + HTTP 状态（用于重试判定） */
async function requestOnce(
  provider: ChatProvider,
  messages: ChatMessage[],
  timeoutMs: number,
  opts?: ChatCallOptions
): Promise<{ result: ChatResult; status: number | null }> {
  const endpoint = `${provider.apiBase}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const body: Record<string, unknown> = {
      model: provider.model,
      messages,
      stream: opts?.onDelta ? true : false
    }
    if (typeof opts?.temperature === 'number') body.temperature = opts.temperature
    const res = await net.fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      return { result: { ok: false, error: classifyHttpError(res.status, bodyText) }, status: res.status }
    }

    if (opts?.onDelta) {
      // 流式：SSE 逐段解析，把每个 delta.content（模型输出原文片段，对 JSON 输出型调用即 JSON 文本片段）回调给调用方
      const content = await readStreamContent(res.body, opts.onDelta)
      if (content == null) {
        return { result: { ok: false, error: { code: ErrorCodes.LLM_FORMAT_INVALID, message: '模型返回内容无法解析' } }, status: res.status }
      }
      if (!content.trim()) {
        return { result: { ok: false, error: { code: ErrorCodes.LLM_EMPTY_RESPONSE, message: '模型返回了空内容' } }, status: res.status }
      }
      return { result: { ok: true, text: content }, status: res.status }
    }

    const bodyText = await res.text()
    const content = parseContent(bodyText)
    if (content == null) {
      return { result: { ok: false, error: { code: ErrorCodes.LLM_FORMAT_INVALID, message: '模型返回内容无法解析' } }, status: res.status }
    }
    if (!content.trim()) {
      return { result: { ok: false, error: { code: ErrorCodes.LLM_EMPTY_RESPONSE, message: '模型返回了空内容' } }, status: res.status }
    }
    return { result: { ok: true, text: content }, status: res.status }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { result: { ok: false, error: { code: ErrorCodes.LLM_TIMEOUT, message: '模型响应超时，请稍后重试' } }, status: null }
    }
    return { result: { ok: false, error: { code: ErrorCodes.LLM_NETWORK, message: '网络连接失败，请检查网络与 API 地址' } }, status: null }
  } finally {
    clearTimeout(timer)
  }
}

async function doCompletion(provider: ChatProvider, messages: ChatMessage[], timeoutMs: number, opts?: ChatCallOptions): Promise<ChatResult> {
  const maxRetries = Math.max(0, Math.min(opts?.maxRetries ?? 0, MAX_RETRIES))
  let last: { result: ChatResult; status: number | null } | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)])
    const res = await requestOnce(provider, messages, timeoutMs, opts)
    last = res
    if (res.result.ok) return res.result
    // 仅瞬时故障才重试（限流/5xx/网络）；认证错误、超时、空响应、格式错误不重试
    if (attempt < maxRetries && isRetryable(res.result.error.code, res.status)) continue
    return res.result
  }
  return last?.result ?? { ok: false, error: { code: ErrorCodes.LLM_NETWORK, message: '网络连接失败' } }
}

// ============================================================
// 流式输出支持（SSE）
// ============================================================

/**
 * JSON 字段流式提取器：边接收 JSON 片段边输出某个字符串字段的内容（含 \n、\"、\uXXXX 等转义还原）。
 * 用于生成初稿时只把 {title,content,error} 中的 content 增量展示给用户，而不是把原始 JSON 逐字刷屏。
 */
export function createJsonFieldStreamer(field: string): { feed: (text: string) => string } {
  const marker = `"${field}"`
  let buffer = ''
  let state: 'scan' | 'emit' | 'end' = 'scan'

  return {
    feed(text: string): string {
      if (state === 'end' || !text) return ''
      buffer += text
      let out = ''

      if (state === 'scan') {
        const re = new RegExp(`"${field}"\\s*:\\s*"`)
        const m = re.exec(buffer)
        if (!m) {
          // 尚未出现字段开头：只保留可能构成 marker 前缀的尾部字符，其余丢弃（防内存增长）
          buffer = buffer.slice(-Math.max(marker.length + 6, 8))
          return ''
        }
        buffer = buffer.slice(m.index + m[0].length)
        state = 'emit'
      }

      if (state === 'emit') {
        const escapeMap: Record<string, string> = {
          n: '\n',
          r: '\r',
          t: '\t',
          b: '\b',
          f: '\f',
          '"': '"',
          '/': '/',
          '\\': '\\'
        }
        let i = 0
        while (i < buffer.length) {
          const ch = buffer[i]
          if (ch === '\\') {
            if (i + 1 >= buffer.length) {
              buffer = buffer.slice(i)
              return out
            }
            const nx = buffer[i + 1]
            if (nx === 'u') {
              if (i + 6 > buffer.length) {
                buffer = buffer.slice(i)
                return out
              }
              const code = parseInt(buffer.slice(i + 2, i + 6), 16)
              out += Number.isNaN(code) ? '\ufffd' : String.fromCharCode(code)
              i += 6
              continue
            }
            out += escapeMap[nx] ?? nx
            i += 2
            continue
          }
          if (ch === '"') {
            state = 'end'
            buffer = ''
            return out
          }
          out += ch
          i += 1
        }
        buffer = ''
      }
      return out
    }
  }
}

/** 读取 SSE 响应流：解析 data: 行中的 delta.content，逐段回调；返回拼接后的完整内容。非 SSE 响应回退 JSON 解析 */
async function readStreamContent(body: ReadableStream<Uint8Array> | null, onDelta: (text: string) => void): Promise<string | null> {
  if (!body) return null
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let raw = ''
  // 用对象承载可变量，避免 TS 对闭包内赋值的控制流收窄
  const state: { deltas: string[]; sawData: boolean } = { deltas: [], sawData: false }

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') return
    if (!payload) return
    state.sawData = true
    try {
      const obj = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] }
      const d = obj?.choices?.[0]?.delta?.content
      if (typeof d === 'string' && d.length > 0) {
        state.deltas.push(d)
        onDelta(d)
      }
    } catch {
      // 单行 JSON 解析失败：保留原始文本作为兜底（部分兼容非标准流实现）
      if (state.deltas.length === 0) state.deltas.push(payload)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      raw += text
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    }
    buffer += decoder.decode()
    for (const line of buffer.split('\n')) handleLine(line)

    if (state.sawData && state.deltas.length > 0) return state.deltas.join('')
    // 未收到 SSE 数据行：按普通 JSON 响应兜底解析
    return parseContent(raw)
  } catch {
    return state.deltas.length > 0 ? state.deltas.join('') : null
  }
}

/** 解析 chat.completions 响应中的正文文本 */
function parseContent(bodyText: string): string | null {
  try {
    const body = JSON.parse(bodyText) as {
      choices?: { message?: { content?: unknown } }[]
    }
    const content = body?.choices?.[0]?.message?.content
    if (typeof content === 'string') return content
    return null
  } catch {
    return null
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('llm chat helpers (2026-08-19)', () => {
    it('streams a JSON string field with escape restoration', () => {
      const s = createJsonFieldStreamer('content')
      const json = `{"title":"教育事业","content":"第一段正文\\n第二段\u201c引文\u201d\\n最后。","error":null}`
      const emitted: string[] = []
      // 按小块喂入（模拟 SSE 分片），尾部分批
      for (let i = 0; i < json.length; i += 3) {
        const piece = s.feed(json.slice(i, i + 3))
        if (piece) emitted.push(piece)
      }
      expect(emitted.join('')).toBe('第一段正文\n第二段“引文”\n最后。')
    })

    it('emits nothing when the field is null (missing-title error case)', () => {
      const s = createJsonFieldStreamer('content')
      const json = `{"title":null,"content":null,"error":"请补充标题"}`
      let out = ''
      for (let i = 0; i < json.length; i += 5) out += s.feed(json.slice(i, i + 5))
      expect(out).toBe('')
    })

    it('survives escapes and unicode split across chunk boundaries', () => {
      const s = createJsonFieldStreamer('content')
      // 转义引号 + 反斜杠 + 4 位 unicode 恰好被分片切断
      const json = `{"title":"x","content":"说\\"某某\\"路径为 C:\\\\data 与\u201c引文\u201d","error":null}`
      let out = ''
      // 逐字符喂入，制造最苛刻的边界条件
      for (let i = 0; i < json.length; i += 1) out += s.feed(json.charAt(i))
      expect(out).toBe('说"某某"路径为 C:\\data 与“引文”')
    })
  })
}
