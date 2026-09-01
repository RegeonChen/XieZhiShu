/**
 * url-fetcher.ts —— 信源网址抓取与正文提取。
 * 使用 Electron net 模块（继承 Chromium 网络栈，支持系统代理）。
 * 仅允许 http/https 协议，抓取结果保存原文快照供溯源。
 */
import { net } from 'electron'

const FETCH_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 5 * 1024 * 1024 // 5 MB
const URL_PATTERN = /^https?:\/\/.+/i

export interface FetchResult {
  url: string
  rawHtml: string
  cleanedText: string
  snapshotAt: string
  /** 条件请求下服务器返回 304（内容未变）时为 true，rawHtml/cleanedText 为空 */
  notModified?: boolean
  /** 响应头 ETag（无条件刷新时可能为空） */
  etag?: string
  /** 响应头 Last-Modified（无条件刷新时可能为空） */
  lastModified?: string
}

export interface FetchUrlOptions {
  /** 条件请求：If-None-Match（服务器返回 304 时表示内容未变） */
  ifNoneMatch?: string
  /** 条件请求：If-Modified-Since（服务器返回 304 时表示内容未变） */
  ifModifiedSince?: string
}

/**
 * 验证 URL 格式与协议白名单
 */
export function validateUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!URL_PATTERN.test(trimmed)) {
    throw Object.assign(new Error('URL 格式不正确，仅支持 http/https'), { code: 'URL_INVALID' })
  }
  return trimmed
}

/**
 * 抓取网页正文并清洗为纯文本
 */
export async function fetchUrl(url: string, opts: FetchUrlOptions = {}): Promise<FetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  const headers: Record<string, string> = {}
  if (opts.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch
  if (opts.ifModifiedSince) headers['If-Modified-Since'] = opts.ifModifiedSince

  let response: globalThis.Response
  try {
    response = await net.fetch(url, { signal: controller.signal, headers } as RequestInit)
  } catch (err) {
    clearTimeout(timer)
    const msg = (err as Error).message ?? ''
    if (msg.includes('abort') || msg.includes('AbortError')) {
      throw Object.assign(new Error(`抓取超时（${FETCH_TIMEOUT_MS / 1000}s）`), { code: 'FETCH_TIMEOUT' })
    }
    throw Object.assign(new Error(`网络请求失败: ${msg}`), { code: 'FETCH_FAILED' })
  } finally {
    clearTimeout(timer)
  }

  // 条件请求 304：内容未变，调用方按“复用已有正文”处理
  if (response.status === 304) {
    return {
      url,
      rawHtml: '',
      cleanedText: '',
      snapshotAt: new Date().toISOString(),
      notModified: true,
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined
    }
  }

  if (!response.ok) {
    throw Object.assign(new Error(`服务器返回 ${response.status}`), { code: 'FETCH_FAILED' })
  }

  // 读取响应体，限制大小
  if (!response.body) {
    throw Object.assign(new Error('响应体为空'), { code: 'FETCH_FAILED' })
  }
  const chunks: Buffer[] = []
  let total = 0
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_BODY_BYTES) {
      reader.cancel()
      throw Object.assign(new Error(`响应体超过 ${MAX_BODY_BYTES / 1024 / 1024}MB 限制`), { code: 'FETCH_FAILED' })
    }
    chunks.push(Buffer.from(value))
  }

  const rawHtml = Buffer.concat(chunks).toString('utf-8')

  // 清洗：去标签 → 去多余空白 → 截取合理长度供检索
  const cleanedText = stripHtml(rawHtml)

  return {
    url,
    rawHtml,
    cleanedText,
    snapshotAt: new Date().toISOString(),
    etag: response.headers.get('etag') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined
  }
}

/**
 * 简单 HTML → 纯文本（不依赖外部库，避免增加包体积）
 */
function stripHtml(html: string): string {
  return html
    // 移除 script / style 标签及其内容
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // 移除所有 HTML 标签
    .replace(/<[^>]+>/g, '')
    // 解码常见实体
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    // 合并空白行
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
