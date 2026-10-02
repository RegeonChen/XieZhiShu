/**
 * file-range.ts —— 本地文件服务的**投递决策**（纯函数，无 Electron 依赖，便于单测）。
 *
 * 背景（Phase 8 / S2，2026-10-02）：原文件服务用 `readFileSync` 把**整个文件读进主进程内存**再一次性下发，
 * 且**完全不实现 HTTP Range**（只加了允许 Range 预检的 CORS 头）。后果：
 *   - 打开一本 200 MB 的年鉴 PDF：主进程同步读 200 MB（**界面卡住**）+ 全量传输 + 每次重开重读；
 *   - pdf.js 拿不到 `206 Partial Content`，无法按需分段取，只能整包下载后再解析。
 * 本模块只负责"该回什么状态码/哪些头/读哪一段字节"，真正的流式读取由调用方用 `createReadStream` 完成。
 *
 * 支持的 Range 形态（RFC 7233 单区间）：
 *   - `bytes=100-199`（闭区间，end 超长自动收敛到文件末尾）
 *   - `bytes=100-`   （开区间，到文件末尾）
 *   - `bytes=-100`   （后缀区间，最后 100 字节）
 * 其它情况（多区间、非 bytes 单位、语法错误）→ **忽略 Range 按 200 全量返回**（RFC 允许服务端忽略）。
 * 起点越界（start ≥ size）→ **416** + `Content-Range: bytes * /size`。
 */

export interface FileDeliveryInput {
  size: number
  mtimeMs: number
  /** 请求头 `Range`（原样传入；undefined 表示没有） */
  rangeHeader?: string
  /** 请求头 `If-None-Match`（用于 304 复用；只做精确匹配，支持 `W/` 前缀） */
  ifNoneMatch?: string
}

export interface FileDelivery {
  status: 200 | 206 | 304 | 416
  headers: Record<string, string>
  /** 需要读取的字节区间（含端点）；304/416 时为 undefined（无正文） */
  start?: number
  end?: number
}

/** 强 ETag：由「大小 + mtime」构成，文件一变即失效（无需读内容，代价低） */
export function fileEtag(size: number, mtimeMs: number): string {
  return `"${Math.max(0, Math.floor(size)).toString(16)}-${Math.max(0, Math.floor(mtimeMs)).toString(16)}"`
}

/** 解析单区间 Range；返回 null 表示「忽略 Range 按全量返回」，'unsatisfiable' 表示 416 */
export function parseRangeHeader(
  header: string | undefined,
  size: number
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null // 多区间 / 其它单位 / 语法错误 → 忽略（回 200 全量，最稳妥）
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null
  if (size <= 0) return 'unsatisfiable'
  if (rawStart === '') {
    // 后缀区间：最后 N 字节（N ≥ size 时等价于整个文件；N = 0 无意义）
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable'
  return { start, end }
}

/**
 * 决定本次请求的投递方式（纯函数）。
 *
 * 头策略说明：
 * - `Accept-Ranges: bytes` 必须给——否则 pdf.js 等客户端不会发 Range，就又退回整包下载；
 * - `Cache-Control: private, max-age=0, must-revalidate` + ETag：允许**用 304 复用**（重开同一文件不再传字节），
 *   但每次都要校验（本地文件随时可能被改动）；
 * - 416 也要带 `Content-Range: bytes * /size`（RFC 要求，客户端据此知道文件实际大小）。
 */
export function resolveFileDelivery(input: FileDeliveryInput): FileDelivery {
  const { size, mtimeMs } = input
  const etag = fileEtag(size, mtimeMs)
  const base: Record<string, string> = {
    'accept-ranges': 'bytes',
    etag,
    'cache-control': 'private, max-age=0, must-revalidate'
  }
  const notModified = (input.ifNoneMatch ?? '').trim()
  if (notModified && (notModified === etag || notModified.replace(/^W\//, '') === etag)) {
    return { status: 304, headers: base }
  }
  const range = parseRangeHeader(input.rangeHeader, size)
  if (range === 'unsatisfiable') {
    return { status: 416, headers: { ...base, 'content-range': `bytes */${Math.max(0, size)}` } }
  }
  if (range) {
    const length = range.end - range.start + 1
    return {
      status: 206,
      headers: { ...base, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(length) },
      start: range.start,
      end: range.end
    }
  }
  return { status: 200, headers: { ...base, 'content-length': String(Math.max(0, size)) } }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('file delivery with HTTP Range (Phase 8 / S2)', () => {
    it('returns the whole file with Accept-Ranges when no Range header is sent', () => {
      const d = resolveFileDelivery({ size: 1000, mtimeMs: 1 })
      expect(d.status).toBe(200)
      expect(d.headers['accept-ranges']).toBe('bytes')
      expect(d.headers['content-length']).toBe('1000')
      // 没有 Accept-Ranges 客户端就不会发 Range（pdf.js 会整包下载）→ 这条是 S2 的关键前提
      expect(d.start).toBeUndefined()
    })

    it('parses the three single-range forms', () => {
      expect(parseRangeHeader('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
      expect(parseRangeHeader('bytes=100-', 1000)).toEqual({ start: 100, end: 999 })
      expect(parseRangeHeader('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    })

    it('clamps an over-long end and a huge suffix to the file end', () => {
      expect(parseRangeHeader('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
      expect(parseRangeHeader('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
    })

    it('answers 206 with Content-Range and the sliced length', () => {
      const d = resolveFileDelivery({ size: 1000, mtimeMs: 2, rangeHeader: 'bytes=100-199' })
      expect(d.status).toBe(206)
      expect(d.headers['content-range']).toBe('bytes 100-199/1000')
      expect(d.headers['content-length']).toBe('100')
      expect([d.start, d.end]).toEqual([100, 199])
    })

    it('ignores multi-range / bad unit / malformed headers (falls back to 200)', () => {
      for (const bad of ['bytes=0-1,5-6', 'items=0-1', 'bytes=abc-def', 'garbage', '']) {
        expect(parseRangeHeader(bad, 1000)).toBeNull()
      }
      expect(resolveFileDelivery({ size: 1000, mtimeMs: 1, rangeHeader: 'bytes=0-1,5-6' }).status).toBe(200)
    })

    it('answers 416 with "bytes */size" when the start is beyond the file', () => {
      const d = resolveFileDelivery({ size: 1000, mtimeMs: 1, rangeHeader: 'bytes=1000-' })
      expect(d.status).toBe(416)
      expect(d.headers['content-range']).toBe('bytes */1000')
      expect(d.start).toBeUndefined()
      // 空文件同样 416（任何区间都无意义）
      expect(resolveFileDelivery({ size: 0, mtimeMs: 1, rangeHeader: 'bytes=0-' }).status).toBe(416)
    })

    it('reuses bytes with 304 when If-None-Match matches (reopen does not re-transfer)', () => {
      const etag = fileEtag(1000, 123)
      expect(resolveFileDelivery({ size: 1000, mtimeMs: 123, ifNoneMatch: etag }).status).toBe(304)
      // 弱校验前缀 W/ 也认
      expect(resolveFileDelivery({ size: 1000, mtimeMs: 123, ifNoneMatch: 'W/' + etag }).status).toBe(304)
      // 文件变了（size/mtime 不同）→ ETag 不同 → 正常返回
      expect(resolveFileDelivery({ size: 1000, mtimeMs: 124, ifNoneMatch: etag }).status).toBe(200)
      expect(resolveFileDelivery({ size: 999, mtimeMs: 123, ifNoneMatch: etag }).status).toBe(200)
    })

    it('keeps ETag stable for the same size+mtime and changes when either changes', () => {
      expect(fileEtag(10, 20)).toBe(fileEtag(10, 20))
      expect(fileEtag(10, 20)).not.toBe(fileEtag(11, 20))
      expect(fileEtag(10, 20)).not.toBe(fileEtag(10, 21))
    })
  })
}
