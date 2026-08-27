/**
 * test.ts —— Provider 连通性测试。
 * 使用 Electron net.fetch 调用 OpenAI-compatible 的 /chat/completions 端点，
 * 将各类失败映射为稳定的 LLM 错误码。日志中不写入密钥。
 */
import { net } from 'electron'
import { ErrorCodes } from '../../shared/types'
import { getProviderSecret } from './provider-store'
import type { SecretCodec } from './secret'

const TEST_TIMEOUT_MS = 15000

export interface ConnectionTestResult {
  ok: boolean
  error?: { code: string; message: string }
}

/** 从 provider 错误响应体中尽量提取可读 message（不包含密钥/URL 本身） */
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

export async function testProviderConnection(id: string, codec: SecretCodec): Promise<ConnectionTestResult> {
  let provider: ReturnType<typeof getProviderSecret>
  try {
    provider = getProviderSecret(id, codec)
  } catch {
    provider = null
  }
  if (!provider) return { ok: false, error: { code: ErrorCodes.INVALID_PARAM, message: 'Provider 不存在（或密钥无法读取）' } }
  if (!provider.apiKey) {
    return { ok: false, error: { code: ErrorCodes.LLM_UNAUTHORIZED, message: '未设置 API 密钥' } }
  }

  const endpoint = `${provider.config.apiBase}/chat/completions`
  const controller = new AbortController()
  // 保证到 TEST_TIMEOUT_MS 一定返回（即使 net.fetch 未按预期响应 abort），避免「测试连接」无限挂起
  let timer: ReturnType<typeof setTimeout> | undefined
  const hardTimeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new DOMException('timeout', 'AbortError'))
    }, TEST_TIMEOUT_MS)
  })
  try {
    const res = await Promise.race([
      net.fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`
        },
        body: JSON.stringify({
          model: provider.config.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        })
      }),
      hardTimeout
    ])

    if (res.ok) return { ok: true }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: { code: ErrorCodes.LLM_UNAUTHORIZED, message: '认证失败：API 密钥无效或无权访问（HTTP 401/403）' } }
    }
    if (res.status === 429) {
      return { ok: false, error: { code: ErrorCodes.LLM_RATE_LIMIT, message: '请求过于频繁：触发限流（HTTP 429）' } }
    }

    let bodyText = ''
    try {
      bodyText = await res.text()
    } catch {
      // 忽略响应体读取失败
    }
    const providerMsg = extractErrorMessage(bodyText)
    return {
      ok: false,
      error: {
        code: ErrorCodes.LLM_PROVIDER_ERROR,
        message: providerMsg ?? `Provider 返回错误（HTTP ${res.status}）`
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: { code: ErrorCodes.LLM_TIMEOUT, message: '连接超时，请检查网络与 API 地址' } }
    }
    return { ok: false, error: { code: ErrorCodes.LLM_NETWORK, message: '网络连接失败，请检查 API 地址与网络' } }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
