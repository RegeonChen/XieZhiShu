/**
 * article-date.ts —— 网页文章来源的**日期阶梯**（Phase 10 P2，纯函数、可测试）。
 *
 * 为什么单独成模块：新流程的第一步是"用户给定年份区间 → 按发布时间筛"（用户裁定 ①），
 * 因此日期必须在**建目录时**就确定，而且要跨站普适。真实库取证（长乐新闻网 62,589 条）：
 * **URL 里能直接读出日期的占 100%**（62,588/62,589），与真实发布时间完全一致 72.4%；
 * 而"从页面文本猜日期"这一级反而是最不可信的——1,421 条里 **126 条的页面日期都等于同一个 `2018.6.15`**（模板日期污染）。
 *
 * 阶梯顺序（用户裁定 ⑤，**必须严格按此顺序回退**）：
 *   L1 RSS/Atom `pubDate`
 *   → L2 sitemap（`news:publication_date` 优先，其次 `lastmod`）
 *   → L3 **URL 内嵌日期**
 *   → L4 HTTP `Last-Modified`
 *   → L5 页面内日期（含 JSON-LD / meta / 可见文本）
 *
 * 本模块只做**纯计算**：解析、归一化、挑选、模板日期识别。L4/L5 的实际取值发生在抓取阶段（P4）。
 * 设计取舍：
 * - 归一化结果只有三档精度：`YYYY-MM-DD` / `YYYY-MM` / `YYYY`（区间筛选按"年月"比较，避免用 1 月 1 日伪造日子）；
 * - 年份合法区间 1990 ~ 当前年+1，且**校验日历真实存在**（`20260231` 这种要拒掉）；
 * - URL 日期按"从具体到笼统"依次尝试，命中即返回，并给出 `precision`（决定置信度）。
 */

/** 归一化精度：日 / 月 / 年 */
export type DatePrecision = 'day' | 'month' | 'year'

/** 日期来源（与 Migration 045 的 `date_source` 列一致） */
export type ArticleDateSource = 'feed' | 'sitemap-news' | 'sitemap-lastmod' | 'url' | 'http' | 'page'

/** 各来源的默认置信度；L4 `Last-Modified` 是"最后修改"而非"发布"，只能算中 */
export const DATE_SOURCE_CONFIDENCE: Record<ArticleDateSource, 'high' | 'medium' | 'low'> = {
  feed: 'high',
  'sitemap-news': 'high',
  'sitemap-lastmod': 'medium',
  url: 'high',
  http: 'medium',
  page: 'high'
}

export interface ParsedDate {
  /** 归一化后的日期：`YYYY-MM-DD` / `YYYY-MM` / `YYYY` */
  date: string
  precision: DatePrecision
}

export interface ArticleDate extends ParsedDate {
  source: ArticleDateSource
  confidence: 'high' | 'medium' | 'low'
}

/** URL 日期精度 → 置信度：只到年时不足以支撑"年份区间"边缘判断，故降为 low */
export function urlDateConfidence(precision: DatePrecision): 'high' | 'medium' | 'low' {
  return precision === 'day' ? 'high' : precision === 'month' ? 'medium' : 'low'
}

const MIN_YEAR = 1990

function maxYear(): number {
  return new Date().getFullYear() + 1
}

/** 校验年月日是否真实存在（含闰年、月份天数） */
export function isValidYmd(y: number, m: number, d: number): boolean {
  if (y < MIN_YEAR || y > maxYear()) return false
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 从 URL 解析内嵌发布日期（L3）。
 * 覆盖中文政务/新闻 CMS 的常见写法（真实库实测这两类占 100%）：
 *   `/2016-06-22/17321974146.shtml`、`/20220419/625e096ebc88e.shtml`、`/2026/09/03/x.html`、
 *   `/202609/x.html`（月精度）、`/2026/x.html`（年精度）、`t20260903_123.htm`
 * 只在 **path + query** 上匹配（不看 host，避免域名里的数字造成误判）。
 */
export function parseUrlDate(rawUrl: string): ParsedDate | null {
  let target = rawUrl ?? ''
  try {
    const u = new URL(target)
    target = u.pathname + u.search
  } catch {
    /* 非法 URL：退化为整串匹配 */
  }

  // ① 全日期：2026-09-03 / 2026/09/03 / 2026_09_03
  const dm = /(?<!\d)(\d{4})[-/_.](\d{1,2})[-/_.](\d{1,2})(?!\d)/.exec(target)
  if (dm) {
    const y = Number(dm[1])
    const mo = Number(dm[2])
    const d = Number(dm[3])
    if (isValidYmd(y, mo, d)) return { date: `${y}-${pad2(mo)}-${pad2(d)}`, precision: 'day' }
  }
  // ② 全日期：20260903（8 位连写，可出现在 `t20260903_` 这类文件名里）
  const cm = /(?<!\d)(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/.exec(target)
  if (cm) {
    const y = Number(cm[1])
    const mo = Number(cm[2])
    const d = Number(cm[3])
    if (isValidYmd(y, mo, d)) return { date: `${y}-${pad2(mo)}-${pad2(d)}`, precision: 'day' }
  }
  // ③ 年月：202609 / 2026-09
  const mm = /(?<!\d)(\d{4})(?:[-/_.]?)(0[1-9]|1[0-2])(?!\d)/.exec(target)
  if (mm) {
    const y = Number(mm[1])
    const mo = Number(mm[2])
    if (y >= MIN_YEAR && y <= maxYear()) return { date: `${y}-${pad2(mo)}`, precision: 'month' }
  }
  // ④ 仅年份（最笼统，置信度最低）
  const ym = /(?<!\d)(\d{4})(?!\d)/.exec(target)
  if (ym) {
    const y = Number(ym[1])
    if (y >= MIN_YEAR && y <= maxYear()) return { date: String(y), precision: 'year' }
  }
  return null
}

const MONTHS_EN: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
}

/**
 * 把各种"人写的日期"归一化成 `YYYY-MM-DD` / `YYYY-MM` / `YYYY`。
 * 需要它是因为真实数据很脏：`2018.6.15`、`2025-02-2`（旧实现把日期截断成一位日）、`2020年12月29日`、
 * `Fri, 01 Jan 2025 00:00:00 GMT`、`2021-03-05T08:00:00+08:00` 都要认。
 */
export function normalizeDateValue(raw: string | null | undefined): ParsedDate | null {
  const s = (raw ?? '').trim()
  if (!s) return null

  // 中文：2020年12月29日 / 2026年9月
  const cn = /(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/.exec(s)
  if (cn) {
    const y = Number(cn[1])
    const mo = Number(cn[2])
    if (cn[3] !== undefined) {
      const d = Number(cn[3])
      if (isValidYmd(y, mo, d)) return { date: `${y}-${pad2(mo)}-${pad2(d)}`, precision: 'day' }
    } else if (y >= MIN_YEAR && y <= maxYear() && mo >= 1 && mo <= 12) {
      return { date: `${y}-${pad2(mo)}`, precision: 'month' }
    }
  }
  // 英文月份：Fri, 01 Jan 2025 ... / 01 January 2025 / Jan 1, 2025
  const en = /(\d{1,2})?\s*([A-Za-z]{3,9})\.?\s*(\d{1,2})?,?\s*(\d{4})/.exec(s)
  if (en) {
    const mon = MONTHS_EN[(en[2] ?? '').slice(0, 3).toLowerCase()]
    const y = Number(en[4])
    const d = Number(en[1] ?? en[3] ?? '')
    if (mon && Number.isFinite(d) && isValidYmd(y, mon, d)) return { date: `${y}-${pad2(mon)}-${pad2(d)}`, precision: 'day' }
  }
  // 数字分隔：2026-09-03 / 2026.9.3 / 2026/09/03 / 20260903 / 2026-09
  const num = /(?<!\d)(\d{4})([-/_.]?)(\d{1,2})(?:\2(\d{1,2}))?(?!\d)/.exec(s)
  if (num) {
    const y = Number(num[1])
    const mo = Number(num[3])
    if (num[4] !== undefined) {
      const d = Number(num[4])
      if (isValidYmd(y, mo, d)) return { date: `${y}-${pad2(mo)}-${pad2(d)}`, precision: 'day' }
    } else if (y >= MIN_YEAR && y <= maxYear() && mo >= 1 && mo <= 12) {
      return { date: `${y}-${pad2(mo)}`, precision: 'month' }
    }
  }
  // 仅年份
  const y = /(?<!\d)(\d{4})(?!\d)/.exec(s)
  if (y) {
    const v = Number(y[1])
    if (v >= MIN_YEAR && v <= maxYear()) return { date: String(v), precision: 'year' }
  }
  return null
}

export interface ArticleDateInput {
  /** L1：RSS/Atom 的 `pubDate`/`updated` */
  feed?: string | null
  /** L2a：sitemap 的 `news:publication_date` */
  sitemapPublication?: string | null
  /** L2b：sitemap 的 `lastmod`（"最后修改"，非发布） */
  sitemapLastmod?: string | null
  /** L3：文章 URL（内部会解析内嵌日期） */
  url?: string | null
  /** L4：HTTP `Last-Modified` 响应头 */
  httpLastModified?: string | null
  /** L5：页面内日期（JSON-LD / meta / 可见文本），由抓取阶段提供 */
  pageDate?: string | null
}

/**
 * 按 L1 → L5 顺序挑选日期（用户裁定 ⑤：**前面的失败才回退到后面**）。
 * 返回 `null` 表示五级都拿不到日期 —— 调用方**不得丢弃**这篇文章，而是进"日期未知"桶（界面如实显示）。
 */
export function pickArticleDate(input: ArticleDateInput): ArticleDate | null {
  const l1 = normalizeDateValue(input.feed)
  if (l1) return { ...l1, source: 'feed', confidence: DATE_SOURCE_CONFIDENCE.feed }

  const l2a = normalizeDateValue(input.sitemapPublication)
  if (l2a) return { ...l2a, source: 'sitemap-news', confidence: DATE_SOURCE_CONFIDENCE['sitemap-news'] }

  const l2b = normalizeDateValue(input.sitemapLastmod)
  if (l2b) return { ...l2b, source: 'sitemap-lastmod', confidence: DATE_SOURCE_CONFIDENCE['sitemap-lastmod'] }

  const l3 = parseUrlDate(input.url ?? '')
  if (l3) return { ...l3, source: 'url', confidence: urlDateConfidence(l3.precision) }

  const l4 = normalizeDateValue(input.httpLastModified)
  if (l4) return { ...l4, source: 'http', confidence: DATE_SOURCE_CONFIDENCE.http }

  const l5 = normalizeDateValue(input.pageDate)
  if (l5) return { ...l5, source: 'page', confidence: DATE_SOURCE_CONFIDENCE.page }

  return null
}

/** 模板日期判定参数（默认值来自真实库取证，见文件头注释） */
export interface TemplateDateOptions {
  /** 至少出现这么多次才可能被判为模板日期 */
  minCount?: number
  /** 或达到该占比（取两者较大值作为门槛） */
  minRatio?: number
  /** 这些页面的 URL 日期至少要跨几个不同年份，才认为"同一日期出现在互不相关的文章上" */
  minDistinctUrlYears?: number
}

/**
 * **模板日期频次异常检测**（L5 专用）。
 *
 * 真实事故：1,421 篇里 126 篇的"页面日期"都等于 `2018.6.15`，而这些文章的 URL 日期分布在 2013–2016 年 ——
 * 说明该站某些页面上印的是一个**固定字符串**（模板/聚合位），不是这篇文章的发布时间。
 * 判别规则（纯频次 + 互校，不需要站点白名单）：
 *   某个页面日期值出现次数 ≥ max(minCount, 总数×minRatio)，**且**出现它的那些文章 URL 日期跨 ≥ minDistinctUrlYears 个年份
 *   → 该值判为模板日期，弃用（回退到 L3 URL 日期）。
 */
export function detectTemplateDates(
  entries: { dateValue: string; urlDate?: string | null }[],
  opts: TemplateDateOptions = {}
): Set<string> {
  const minCount = opts.minCount ?? 10
  const minRatio = opts.minRatio ?? 0.01
  const minDistinctUrlYears = opts.minDistinctUrlYears ?? 3
  const byValue = new Map<string, { count: number; urlYears: Set<string> }>()
  for (const e of entries) {
    const v = normalizeDateValue(e.dateValue)?.date
    if (!v) continue
    const bucket = byValue.get(v) ?? { count: 0, urlYears: new Set<string>() }
    bucket.count += 1
    const urlYear = (e.urlDate ?? '').slice(0, 4)
    if (urlYear) bucket.urlYears.add(urlYear)
    byValue.set(v, bucket)
  }
  const threshold = Math.max(minCount, Math.ceil(entries.length * minRatio))
  const out = new Set<string>()
  for (const [value, b] of byValue) {
    if (b.count >= threshold && b.urlYears.size >= minDistinctUrlYears) out.add(value)
  }
  return out
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('article-date（Phase 10 日期阶梯）', () => {
    it('parses URL-embedded dates in the formats the real corpus uses', () => {
      // 真实库两种格式（占 100%）
      expect(parseUrlDate('https://www.clnews.com.cn/html/2/2016-06-22/17321974146.shtml')).toEqual({
        date: '2016-06-22',
        precision: 'day'
      })
      expect(parseUrlDate('http://www.clnews.com.cn/html/10/20220419/625e096ebc88e.shtml')).toEqual({
        date: '2022-04-19',
        precision: 'day'
      })
      // 其他常见写法
      expect(parseUrlDate('https://x.gov.cn/news/2026/09/03/a.html')?.date).toBe('2026-09-03')
      expect(parseUrlDate('https://x.gov.cn/t20260903_12345.htm')?.date).toBe('2026-09-03')
      expect(parseUrlDate('https://x.gov.cn/news/202609/a.html')).toEqual({ date: '2026-09', precision: 'month' })
      expect(parseUrlDate('https://x.gov.cn/2026/a.html')).toEqual({ date: '2026', precision: 'year' })
    })

    it('rejects impossible or out-of-range dates in URLs', () => {
      expect(parseUrlDate('https://x.gov.cn/20261301/a.html')).toBeNull() // 月份 13
      expect(parseUrlDate('https://x.gov.cn/20260231/a.html')).toBeNull() // 2 月 31 日
      expect(parseUrlDate('https://x.gov.cn/18990101/a.html')).toBeNull() // 年份越界
      expect(parseUrlDate('https://x.gov.cn/12345678/a.html')).toBeNull() // 不是 20xx
      expect(parseUrlDate('https://x.gov.cn/news/1234567890.html')).toBeNull()
    })

    it('normalizes messy date strings (含旧实现截断成 "2025-02-2" 的情况)', () => {
      expect(normalizeDateValue('2025-02-2')?.date).toBe('2025-02-02')
      expect(normalizeDateValue('2018.6.15')?.date).toBe('2018-06-15')
      expect(normalizeDateValue('2020年12月29日')?.date).toBe('2020-12-29')
      expect(normalizeDateValue('2026年9月')?.date).toBe('2026-09')
      expect(normalizeDateValue('Fri, 01 Jan 2025 00:00:00 GMT')?.date).toBe('2025-01-01')
      expect(normalizeDateValue('2021-03-05T08:00:00+08:00')?.date).toBe('2021-03-05')
      expect(normalizeDateValue('20260903')?.date).toBe('2026-09-03')
      expect(normalizeDateValue('第60期 领航课堂')).toBeNull()
      expect(normalizeDateValue('')).toBeNull()
    })

    it('picks dates in the L1 → L5 order and never fabricates one', () => {
      // L1 优先于其它一切
      expect(
        pickArticleDate({
          feed: 'Fri, 01 Jan 2025 00:00:00 GMT',
          sitemapLastmod: '2024-12-31',
          url: 'https://x.gov.cn/20240101/a.html',
          pageDate: '2023年1月1日'
        })
      ).toEqual({ date: '2025-01-01', precision: 'day', source: 'feed', confidence: 'high' })
      // L2a（news:publication_date）优先于 L2b（lastmod）
      expect(pickArticleDate({ sitemapPublication: '2024-05-06', sitemapLastmod: '2024-05-07' })?.source).toBe('sitemap-news')
      // L2b 优先于 L3
      expect(pickArticleDate({ sitemapLastmod: '2024-05-07', url: 'https://x.gov.cn/20200101/a.html' })?.source).toBe(
        'sitemap-lastmod'
      )
      // L3 优先于 L5（这正是真实库里 126 篇"模板日期"被纠正的路径）
      expect(pickArticleDate({ url: 'https://x.gov.cn/2016-06-22/a.shtml', pageDate: '2018.6.15' })).toEqual({
        date: '2016-06-22',
        precision: 'day',
        source: 'url',
        confidence: 'high'
      })
      // L4 / L5 兜底
      expect(pickArticleDate({ httpLastModified: 'Wed, 01 Mar 2023 00:00:00 GMT' })?.source).toBe('http')
      expect(pickArticleDate({ pageDate: '2023年3月1日' })?.source).toBe('page')
      // 五级都拿不到 → null（调用方进"日期未知"桶，绝不丢弃）
      expect(pickArticleDate({ url: 'https://x.gov.cn/news/abc.html' })).toBeNull()
    })

    it('detects template dates by frequency + URL-date disagreement (真实事故 2018.6.15)', () => {
      // 126 篇页面日期都是 2018.6.15，但它们的 URL 日期分布在 2013–2016
      const entries = Array.from({ length: 126 }, (_, i) => ({
        dateValue: '2018.6.15',
        urlDate: `${2013 + (i % 4)}-06-15`
      }))
      // 再掺入 300 篇"页面日期与 URL 日期一致"的正常文章
      for (let i = 0; i < 300; i++) entries.push({ dateValue: `2021-0${(i % 9) + 1}-15`, urlDate: `2021-0${(i % 9) + 1}-15` })
      const bad = detectTemplateDates(entries)
      expect(bad.has('2018-06-15')).toBe(true)
      expect(bad.size).toBe(1)
      // 出现次数多、但 URL 年份一致（真是同一天的合集页）→ 不算模板日期
      const legit = Array.from({ length: 40 }, () => ({ dateValue: '2021-01-15', urlDate: '2021-01-15' }))
      expect(detectTemplateDates(legit).size).toBe(0)
      // 次数不够 → 不算
      expect(detectTemplateDates([{ dateValue: '2018-06-15', urlDate: '2013-01-01' }]).size).toBe(0)
    })
  })
}
