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
  /**
   * 实际用于解码响应体的字符集（2026-10-04）。
   * 老政务站大量使用 GBK/GB2312：此前一律按 UTF-8 解码 → **整篇乱码仍照常入库**（用户看不出原因）。
   * 现在按 `Content-Type` 头 → `<meta charset>` → UTF-8 的顺序确定，并回传供日志/汇总如实告知。
   */
  charset?: string
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

  const buf = Buffer.concat(chunks)
  const charset = sniffCharset(response.headers.get('content-type'), buf)
  const rawHtml = decodeBody(buf, charset)

  // 清洗：去标签 → 去多余空白 → 截取合理长度供检索
  const cleanedText = stripHtml(rawHtml)

  return {
    url,
    rawHtml,
    cleanedText,
    snapshotAt: new Date().toISOString(),
    etag: response.headers.get('etag') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined,
    charset
  }
}

/**
 * 确定响应体字符集（2026-10-04 新增）：`Content-Type` 头优先，其次文档头部的 `<meta charset>`，最后 UTF-8。
 * GBK/GB2312 统一按 **GB18030** 解码（它是前两者的超集，能覆盖生僻字与全角符号）。
 */
export function sniffCharset(contentType: string | null, bytes: Buffer): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1]
  if (fromHeader) return normalizeCharset(fromHeader)
  // 头部 2KB 内找 <meta charset=…> / <meta http-equiv="Content-Type" content="…charset=…">（这些字节本身是 ASCII）
  const head = bytes.subarray(0, 2048).toString('latin1')
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]
  return normalizeCharset(fromMeta ?? 'utf-8')
}

/** 字符集名归一化：gb2312/gbk → gb18030；utf8 → utf-8；其余原样（未知标签会在解码时回退 UTF-8） */
export function normalizeCharset(raw: string): string {
  const c = (raw ?? '').trim().toLowerCase()
  if (!c) return 'utf-8'
  if (c === 'gb2312' || c === 'gbk' || c === 'gb18030') return 'gb18030'
  if (c === 'utf8') return 'utf-8'
  return c
}

/** 按字符集解码响应体；字符集不受支持时回退 UTF-8（绝不因为编码问题丢掉整篇文章） */
export function decodeBody(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return bytes.toString('utf-8')
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

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('url-fetcher charset decoding (2026-10-04 GBK 乱码修复)', () => {
    it('sniffs charset from Content-Type header first', () => {
      expect(sniffCharset('text/html; charset=gb2312', Buffer.from('<html>'))).toBe('gb18030')
      expect(sniffCharset('text/html; charset=GBK', Buffer.from('<html>'))).toBe('gb18030')
      expect(sniffCharset('text/html; charset="utf-8"', Buffer.from('<html>'))).toBe('utf-8')
    })

    it('falls back to <meta charset> in the document head, then utf-8', () => {
      const gbkMeta = Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"></head>', 'latin1')
      expect(sniffCharset(null, gbkMeta)).toBe('gb18030')
      expect(sniffCharset(null, Buffer.from('<html><head><meta charset="utf-8"></head>'))).toBe('utf-8')
      expect(sniffCharset(null, Buffer.from('<html>没有声明</html>'))).toBe('utf-8')
    })

    it('decodes GBK bytes correctly and never loses the page on an unknown charset', () => {
      const gbkBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) // "你好" 的 GBK 编码
      expect(decodeBody(gbkBytes, 'gb18030')).toBe('你好')
      expect(decodeBody(gbkBytes, 'utf-8')).not.toBe('你好') // 编码判断错了就是乱码（这正是此前的问题）
      expect(decodeBody(Buffer.from('正文', 'utf-8'), 'not-a-real-charset')).toBe('正文') // 未知字符集回退 UTF-8
    })
  })
}
