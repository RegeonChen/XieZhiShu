/**
 * chat.ts —— OpenAI-compatible 对话调用（主进程 net.fetch）。
 * 供初稿生成等后续功能复用；错误统一映射为稳定的 LLM 错误码；不记录密钥。
 */
import { net } from 'electron'
import { ErrorCodes } from '../../shared/types'

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

export async function chatCompletion(provider: ChatProvider, messages: ChatMessage[], timeoutMs = DEFAULT_CHAT_TIMEOUT_MS): Promise<ChatResult> {
  const endpoint = `${provider.apiBase}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await net.fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({ model: provider.model, messages, stream: false })
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
