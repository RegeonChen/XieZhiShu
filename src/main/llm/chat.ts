/**
 * chat.ts —— OpenAI-compatible 对话调用（主进程 net.fetch）。
 * 供初稿生成等后续功能复用；错误统一映射为稳定的 LLM 错误码；不记录密钥。
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
}

/** 调用用途标记（用于 llm_call_logs 痕迹）：generate 初稿 / chat 对话 / summarize 摘要 / template 范本 / misc 其它 */
export interface ChatCallMeta {
  kind: string
  taskId?: string
}

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

async function doCompletion(provider: ChatProvider, messages: ChatMessage[], timeoutMs: number, opts?: ChatCallOptions): Promise<ChatResult> {
  const endpoint = `${provider.apiBase}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const body: Record<string, unknown> = { model: provider.model, messages, stream: false }
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

    const bodyText = await res.text()
    if (res.ok) {
      const content = parseContent(bodyText)
      if (content == null) {
        return { ok: false, error: { code: ErrorCodes.LLM_FORMAT_INVALID, message: '模型返回内容无法解析' } }
      }
      if (!content.trim()) {
        return { ok: false, error: { code: ErrorCodes.LLM_EMPTY_RESPONSE, message: '模型返回了空内容' } }
      }
      return { ok: true, text: content }
    }
    return { ok: false, error: classifyHttpError(res.status, bodyText) }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: { code: ErrorCodes.LLM_TIMEOUT, message: '模型响应超时，请稍后重试' } }
    }
    return { ok: false, error: { code: ErrorCodes.LLM_NETWORK, message: '网络连接失败，请检查网络与 API 地址' } }
  } finally {
    clearTimeout(timer)
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
