/**
 * url-key.ts —— 文章 URL 的**规范化与去重键**（纯函数；2026-10-06 Phase 11 H 抽出来共享）。
 *
 * 为什么独立成模块：这两件事现在有**两个使用方**，且必须**完全同口径**：
 *   ① 站点发现（`site-crawler.ts`）：遍历时给链接去重、写入目录；
 *   ② 目录侧（`db/web-sites.ts#listSiteArticleKeys`）：把"这个站点已经有哪些 URL"喂给发现器，
 *      用于统计**真正的新增**并据此判断"收益是否饱和"。
 * 若两边口径有一丝不同（例如一边去查询参数、一边保留），重复同步时每篇文章都会被当成"新的"，
 * 饱和判据就永远不成立——发现会一直走到安全阀为止（白跑几百个请求）。所以只留这一份实现。
 *
 * 本文件**不得**依赖数据库 / Electron / 网络（纯字符串处理）。
 */

/** 常见跟踪参数（URL 规范化时移除，避免同一文章多入口重复抓取/入库） */
const TRACKING_QUERY_KEYS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'spm',
  'from',
  'ref',
  'share',
  'source',
  'redirect'
])

/** * URL 规范化（纯函数、可测试）：小写主机、去默认端口、去 fragment、去跟踪参数、去尾部斜杠。 * 用于文章去重（A3），使 `?utm_*`、`http/https`、尾斜杠等差异归并为同一篇。 */
export function normalizeArticleUrl(raw: string, baseUrl?: string): string {
  let u: URL
  try {
    u = new URL(raw, baseUrl)
  } catch {
    return raw
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw
  u.host = u.host.toLowerCase()
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = ''
  u.hash = ''
  const keep = new URLSearchParams()
  for (const [k, v] of u.searchParams.entries()) {
    if (!TRACKING_QUERY_KEYS.has(k.toLowerCase())) keep.append(k, v)
  }
  u.search = keep.toString()
  u.pathname = u.pathname.replace(/\/+$/, '')
  return u.toString()
}

/** 文章 URL 去重键（纯函数、可测试）：基于规范化 URL，去掉协议与尾部斜杠，使 http/https/跟踪参数/尾斜杠归并为同一篇 */
export function dedupeArticleKey(url: string): string {
  const n = normalizeArticleUrl(url)
  const i = n.indexOf('://')
  return i >= 0 ? n.slice(i + 3) : n
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('url-key（文章 URL 规范化与去重键，Phase 11 H 抽出共享）', () => {
    it('http/https、尾斜杠、跟踪参数、大小写主机归并为同一篇', () => {
      const a = dedupeArticleKey('http://www.clnews.com.cn/html/3/2016-09-28/09364019644.shtml')
      const b = dedupeArticleKey('https://WWW.CLNEWS.COM.CN/html/3/2016-09-28/09364019644.shtml')
      const c = dedupeArticleKey('http://www.clnews.com.cn/html/3/2016-09-28/09364019644.shtml?utm_source=weixin')
      const d = dedupeArticleKey('http://www.clnews.com.cn/html/3/2016-09-28/09364019644.shtml/')
      expect(b).toBe(a)
      expect(c).toBe(a)
      expect(d).toBe(a)
      // 非跟踪参数必须保留（它可能是文章身份的一部分）
      expect(dedupeArticleKey('http://x.cn/a.htm?id=7')).not.toBe(dedupeArticleKey('http://x.cn/a.htm?id=8'))
      // 非法 URL 原样返回（不抛）
      expect(dedupeArticleKey('not a url')).toBe('not a url')
    })
  })
}
