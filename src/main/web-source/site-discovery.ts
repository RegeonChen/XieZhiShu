/**
 * site-discovery.ts —— 站点清单发现的**自适应预算**（Phase 11 H，2026-10-06 用户提出）。
 *
 * ## 为什么要有这个文件
 * 原来"发现一个站点有哪些文章"（BFS 兜底路径）用**固定上限** `SYNC_MAX_PAGES = 20` / `SYNC_MAX_DEPTH = 2`。
 * 2026-10-06 实测证明这个口径不成立：
 *   - `clnews.com.cn` **既无 sitemap 也无 RSS**（`/sitemap.xml`、`/rss.xml` 等全部回落到首页 HTML），
 *     它的 **62,506** 条目录是 2026-09-12 一次**深层发现**的产物；之后 10-03 只 +83、10-05 只 +4 ——
 *     正是被 20 页/2 层卡住的症状。也就是说**旧站自己也不是"20 页就够"**。
 *   - 换一个政府站，归档结构可能更深更宽（每页下蛋 200+ 篇），20 页同样远远不够。
 *
 * 结论：**停止条件不该是"走了 N 页"，而该是"继续走已经不产出新东西了"**（收益饱和）。
 * 页数/层数不再是输入，而是**算法的输出**：停下来时的实际用量由 `site-crawler.ts` 记回站点行
 * （`web_sites.discovery_pages/discovery_depth`，Migration 052），下次当**起点下限**用——
 * 这样一次偶发失败（某页 502、首页临时改版）不会让发现范围**退化**。
 *
 * ## 本文件只管"纯判断"，不碰网络
 * 链接分类、出队优先级、饱和判据、限额解析、报告摘要都是**纯函数**，可被内联单测覆盖；
 * 真正的遍历与 I/O 在 `site-crawler.ts`（`discoverSiteArticlesDetailed`）。
 */

/** 安全阀默认值（**自动模式**下的硬顶）：防止某个归档无穷尽的站点把我们拖住 */
export const AUTO_MAX_PAGES = 300
export const AUTO_MAX_DEPTH = 6
export const AUTO_TIME_BUDGET_MS = 180_000
/** 手动模式的时间硬网（用户明确要多少就走多少，但兜一层防跑飞） */
export const MANUAL_TIME_BUDGET_MS = 600_000
/** 可选值范围（设置面板与主进程校验共用） */
export const MIN_DISCOVERY_PAGES = 10
export const MAX_DISCOVERY_PAGES = 2000
export const MIN_DISCOVERY_DEPTH = 1
export const MAX_DISCOVERY_DEPTH = 8
/** 硬深度上限（不管谁怎么说，超过这个层数没有意义：站点层级不会那么深） */
const ABSOLUTE_MAX_DEPTH = 8

/**
 * 饱和判据参数：
 * - 窗口 `SATURATION_WINDOW` 页；
 * - 窗口内新增文章合计 < `max(MIN_YIELD_ABS, 已发现总数 × MIN_YIELD_RATIO)` 且**没有新增"年-月"格子** → 饱和。
 *
 * 为什么要"× 比例"这一项：大站的绝对收益本来就大，用固定阈值会让大站在还有大量未发现文章时就停下。
 * 为什么还要"新增格子 = 0"：年份覆盖是本项目的真正目标（区间筛选只看年份）——只要还在开出新的年月格子，
 * 说明归档结构还没走完，这时不该停。
 */
export const SATURATION_WINDOW = 10
export const MIN_YIELD_ABS = 3
export const MIN_YIELD_RATIO = 0.02
/** 极速收工：连续这么多页**一篇新的都没有** → 立刻饱和（用于"目录已经建全了"的重复同步，省请求） */
export const FAST_ZERO_WINDOW = 5

export type DiscoveryMode = 'auto' | 'manual'

/** 停止原因（**必须如实报给用户**：撞安全阀时不能假装"抓全了"） */
export type DiscoveryStopReason =
  /** 收益饱和（正常收工） */
  | 'saturated'
  /** 前沿走空（站点结构就这么大） */
  | 'frontier-empty'
  /** 撞页数上限（含安全阀或手动值） */
  | 'page-cap'
  /** 撞时间预算 */
  | 'time-budget'
  /** 撞层数上限 */
  | 'depth-cap'

export interface DiscoveryLimits {
  /** 页数上限（硬顶） */
  maxPages: number
  /** 层数上限（硬顶） */
  maxDepth: number
  /**
   * 页数**下限**（= 上次实际用量）：在走到这个页数之前**不许**因"收益饱和"提前收工。
   * 为什么需要它：一次偶发失败（某页 502、首页临时改版）会让当次收益看起来很低，
   * 若就此收工，发现范围会**逐次退化**；有了下限，下次至少回到上次的规模再看要不要继续。
   */
  minPages: number
  /** 是否启用"收益饱和"提前收工（自动模式 = true；手动模式 = 用满用户给的预算） */
  saturation: boolean
  /** 时间预算（毫秒） */
  timeBudgetMs: number
  mode: DiscoveryMode
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.round(v)))
}

/**
 * 解析本次运行的限额（纯函数）。
 * - `auto`：硬顶 = 安全阀（300/6/3 分钟）+ 饱和提前收工；
 * - `manual`：硬顶 = 用户填的页/层（夹到合法范围）+ **不**提前收工（用户要多少就走多少）+ 10 分钟硬网；
 * - 两者都吃**上次用量**当**下限**（`hintPages/hintDepth`）：否则一次偶发失败会让发现范围退化。
 */
export function resolveLimits(input: {
  mode?: DiscoveryMode
  manualPages?: number
  manualDepth?: number
  hintPages?: number | null
  hintDepth?: number | null
}): DiscoveryLimits {
  const mode: DiscoveryMode = input.mode === 'manual' ? 'manual' : 'auto'
  const hintPages = Number.isFinite(input.hintPages as number) ? Math.max(0, Math.round(input.hintPages as number)) : 0
  const hintDepth = Number.isFinite(input.hintDepth as number) ? Math.max(0, Math.round(input.hintDepth as number)) : 0

  if (mode === 'manual') {
    const pages = clampInt(input.manualPages ?? AUTO_MAX_PAGES, MIN_DISCOVERY_PAGES, MAX_DISCOVERY_PAGES, AUTO_MAX_PAGES)
    const depth = clampInt(input.manualDepth ?? AUTO_MAX_DEPTH, MIN_DISCOVERY_DEPTH, MAX_DISCOVERY_DEPTH, AUTO_MAX_DEPTH)
    return {
      // 手动值是"至少走这么多"：上次用量更大时以更大者为准（防退化），但仍然受绝对范围约束
      maxPages: Math.min(MAX_DISCOVERY_PAGES, Math.max(pages, hintPages)),
      maxDepth: Math.min(ABSOLUTE_MAX_DEPTH, Math.max(depth, hintDepth)),
      minPages: 0, // 手动模式本来就走满预算，不需要下限
      saturation: false,
      timeBudgetMs: MANUAL_TIME_BUDGET_MS,
      mode
    }
  }
  return {
    maxPages: Math.max(AUTO_MAX_PAGES, hintPages),
    maxDepth: Math.min(ABSOLUTE_MAX_DEPTH, Math.max(AUTO_MAX_DEPTH, hintDepth)),
    minPages: hintPages, // 本次至少走到上次的用量，再按饱和规则决定是否继续
    saturation: true,
    timeBudgetMs: AUTO_TIME_BUDGET_MS,
    mode
  }
}

/** 单页收益记录（供饱和判据与报告） */
export interface PageYield {
  /** 该页给出的、**站内目录里还没有**的文章数（重复同步时这才会是 0） */
  newArticles: number
  /** 该页是否带来了新的"年-月"格子（年份覆盖是否还在改善） */
  newCells: number
}

/**
 * 饱和阈值：`max(3, 已发现总数 × 2%)`。
 * 注意"已发现总数"用**本次发现总数 + 站内目录原有条数**（重复同步时后者很大 → 阈值大 →
 * 只要还有成批新文章就会继续走；而目录已建全时窗口内新增为 0 → 立刻饱和）。
 */
export function yieldThreshold(alreadyKnown: number, discoveredNow: number): number {
  return Math.max(MIN_YIELD_ABS, Math.ceil((alreadyKnown + discoveredNow) * MIN_YIELD_RATIO))
}

/** 判定停止（纯函数）；返回 `null` 表示继续走 */
export function decideStop(input: {
  /** 最近若干页的收益（**最近的在后面**） */
  recent: PageYield[]
  /** 是否还有待访问的列表页 */
  frontierEmpty: boolean
  /** 已抓列表页数（不含探测阶段？包含——它就是"走了多少页"） */
  pages: number
  limits: DiscoveryLimits
  /** 下一个待抓页面的层数（用来判层数上限） */
  nextDepth: number
  elapsedMs: number
  alreadyKnown: number
  discoveredNow: number
}): DiscoveryStopReason | null {
  if (input.frontierEmpty) return 'frontier-empty'
  if (input.pages >= input.limits.maxPages) return 'page-cap'
  if (input.nextDepth > input.limits.maxDepth) return 'depth-cap'
  if (input.elapsedMs >= input.limits.timeBudgetMs) return 'time-budget'
  if (!input.limits.saturation) return null
  // 还没走到**上次的用量**之前不许收工（防"一次偶发失败导致发现范围逐次退化"）
  if (input.pages < input.limits.minPages) return null

  const recent = input.recent
  /*
   * 极速收工：连续若干页**既没有新文章、也没有新的年月格子** → 目录已经建全了
   * （重复同步的常见情形，省请求）。
   * ⚠ 必须同时看 newCells：只要还在开出新的年月格子，就说明归档结构还没走完，不能收工。
   */
  if (recent.length >= FAST_ZERO_WINDOW) {
    const tail = recent.slice(-FAST_ZERO_WINDOW)
    if (tail.every((p) => p.newArticles === 0 && p.newCells === 0)) return 'saturated'
  }
  if (recent.length < SATURATION_WINDOW) return null
  const win = recent.slice(-SATURATION_WINDOW)
  const sumNew = win.reduce((n, p) => n + p.newArticles, 0)
  const sumCells = win.reduce((n, p) => n + p.newCells, 0)
  if (sumNew < yieldThreshold(input.alreadyKnown, input.discoveredNow) && sumCells === 0) return 'saturated'
  return null
}

/**
 * 链接形态签名（纯函数）：用于**按形态统计收益**，让出队顺序自己学出来
 * （哪种页面在下蛋，就优先抓哪种）。
 */
export function patternOf(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'other'
  }
  const p = u.pathname
  // 年月归档：支持 `2016-09/`、`2016/09/`、`201609/`，以及带日的 `2016-09-28/`（clnews 就是这种）
  if (/\/\d{4}[-_/]\d{1,2}(?:[-_/]\d{1,2})?(\/|$)/.test(p) || /\/\d{6}(\/|$)/.test(p)) return 'year-month'
  if (/\/\d{4}(\/|$)/.test(p)) return 'year'
  if (/(?:^|\/)(?:node|list|index|column|category|channel|col|lm|more)(?:_|\/|\.|$)/i.test(p)) return 'index'
  if (u.search && /(?:^\?|&)(?:page|pn|pageno|pageindex|p|offset)=\d+/i.test(u.search)) return 'paginated'
  if (/\/\d{1,3}(\/|$)/.test(p)) return 'num-dir'
  return 'other'
}

/** 形态收益统计（遍历过程中累积） */
export interface PatternStat {
  pages: number
  articles: number
}

/**
 * 出队优先级（**数越小越先走**）。三项相加：
 * ① 形态基分：年-月归档最优先（一次能吐整月文章），其次年归档 / 索引页 / 翻页 / 数字目录；
 * ② 形态**实测收益**加成：本次遍历中这种形态平均下蛋越多，越优先（自己学出来，而不是我拍脑袋）；
 * ③ 层数惩罚：同样条件下浅层先走（先把宽度铺开，避免一头扎进某个栏目）。
 */
export function pagePriority(input: {
  url: string
  depth: number
  stats: Map<string, PatternStat>
  /** 目标区间里**还没发现任何文章**的年份（这些年份相关的页面优先） */
  uncoveredYears?: Set<number>
}): number {
  const pattern = patternOf(input.url)
  const BASE: Record<string, number> = {
    'year-month': 0,
    year: 20,
    index: 40,
    paginated: 60,
    'num-dir': 80,
    other: 100
  }
  const base = BASE[pattern] ?? 100

  const st = input.stats.get(pattern)
  // 平均收益（每页新增文章数），封顶 30 分；一页都没抓过时给中性值 10 分（鼓励试探新形态）
  const avg = st && st.pages > 0 ? st.articles / st.pages : 10
  const learnBonus = -Math.min(30, avg)

  // 未覆盖年份：URL 里出现该年份 → 强烈优先（补齐年份覆盖是本项目的目标）
  let coverageBonus = 0
  if (input.uncoveredYears && input.uncoveredYears.size > 0) {
    for (const y of input.uncoveredYears) {
      if (input.url.includes(String(y))) {
        coverageBonus = -50
        break
      }
    }
  }

  return base + learnBonus + coverageBonus + input.depth * 2
}

/** 从 URL 取年月格子键（`YYYY-MM` / `YYYY`）；取不到返回 null */
export function cellOf(url: string): string | null {
  const p = (() => {
    try {
      return new URL(url).pathname
    } catch {
      return url
    }
  })()
  const ym =
    p.match(/(\d{4})[-_/](\d{1,2})[-_/](\d{1,2})/) ?? // 带日：YYYY-MM-DD（clnews 的 URL 就是这种）
    p.match(/(\d{4})[-_/](\d{1,2})(?:\/|$)/) ?? // 段末：YYYY-MM
    p.match(/(\d{4})(\d{2})(?:\/|$)/) // 连写：YYYYMM
  if (ym) {
    const m = Number(ym[2])
    if (m >= 1 && m <= 12) return `${ym[1]}-${String(m).padStart(2, '0')}`
  }
  const y = p.match(/(\d{4})(?:\/|$)/)
  if (y && Number(y[1]) >= 1990 && Number(y[1]) <= 2100) return y[1]
  return null
}

/** 从 URL 取年份（用于"未覆盖年份"与年份分布报告）；取不到返回 null */
export function yearOf(url: string): number | null {
  const cell = cellOf(url)
  if (!cell) return null
  const y = Number(cell.slice(0, 4))
  return Number.isFinite(y) ? y : null
}

/** 续抓提示：撞上限且前沿非空时，如实告诉用户"还没走完" */
export function describeStop(reason: DiscoveryStopReason, pages: number, maxPages: number, frontierLeft: number): string {
  switch (reason) {
    case 'saturated':
      return `收益饱和（走到 ${pages} 页后，连续多页已无新文章）`
    case 'frontier-empty':
      return `已走完站点可达的列表页（${pages} 页）`
    case 'page-cap':
      return `已达页数上限 ${maxPages} 页，仍有 ${frontierLeft} 个列表页未访问（如需更全可提高上限）`
    case 'time-budget':
      return `已达时间预算，仍有 ${frontierLeft} 个列表页未访问（如需更全可提高上限）`
    case 'depth-cap':
      return `已达层数上限，仍有 ${frontierLeft} 个列表页未访问（如需更全可提高上限）`
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('site-discovery（自适应发现预算，Phase 11 H）', () => {
    it('限额解析：自动=安全阀+饱和；手动=用户值且不提前收工；两者都吃"上次用量"下限', () => {
      const auto = resolveLimits({})
      expect(auto).toMatchObject({ maxPages: AUTO_MAX_PAGES, maxDepth: AUTO_MAX_DEPTH, saturation: true, mode: 'auto', minPages: 0 })
      // 上次走了 420 页 → 本次至少给 420（防退化），但仍受绝对上限约束
      expect(resolveLimits({ hintPages: 420 }).maxPages).toBe(420)
      expect(resolveLimits({ hintPages: 420 }).minPages).toBe(420)
      expect(resolveLimits({ hintPages: 99999 }).maxPages).toBe(99999)
      expect(resolveLimits({ hintPages: null, hintDepth: 7 }).maxDepth).toBe(7)

      const manual = resolveLimits({ mode: 'manual', manualPages: 50, manualDepth: 3 })
      expect(manual).toMatchObject({ maxPages: 50, maxDepth: 3, saturation: false, mode: 'manual' })
      // 手动值夹到合法范围
      expect(resolveLimits({ mode: 'manual', manualPages: 1, manualDepth: 99 }).maxPages).toBe(MIN_DISCOVERY_PAGES)
      expect(resolveLimits({ mode: 'manual', manualPages: 1, manualDepth: 99 }).maxDepth).toBe(MAX_DISCOVERY_DEPTH)
      // 手动 + 上次用量更大 → 取大者
      expect(resolveLimits({ mode: 'manual', manualPages: 50, hintPages: 120 }).maxPages).toBe(120)
    })

    it('链接形态签名与年月格子：归档页/索引页/翻页各归其类', () => {
      expect(patternOf('http://www.clnews.com.cn/html/3/2016-09/')).toBe('year-month')
      expect(patternOf('http://www.clnews.com.cn/html/3/2016-09-28/')).toBe('year-month')
      expect(patternOf('http://x.gov.cn/2016/')).toBe('year')
      expect(patternOf('http://x.gov.cn/news/list.shtml')).toBe('index')
      expect(patternOf('http://x.gov.cn/news/node_1234.htm')).toBe('index')
      expect(patternOf('http://x.gov.cn/news/?page=3')).toBe('paginated')
      expect(patternOf('http://x.gov.cn/t20250101_1.htm')).toBe('other')

      expect(cellOf('http://www.clnews.com.cn/html/3/2016-09-28/09364019644.shtml')).toBe('2016-09')
      expect(cellOf('http://x.gov.cn/201609/t1.htm')).toBe('2016-09')
      expect(cellOf('http://x.gov.cn/2016/09/')).toBe('2016-09')
      expect(cellOf('http://x.gov.cn/2016/')).toBe('2016')
      expect(cellOf('http://x.gov.cn/about.htm')).toBeNull()
      expect(yearOf('http://x.gov.cn/2016/')).toBe(2016)
    })

    it('出队优先级：年-月归档最优先；有实测收益的形态加档；未覆盖年份强优先', () => {
      const stats = new Map<string, PatternStat>()
      const ym = pagePriority({ url: 'http://a.cn/2016-09/', depth: 2, stats })
      const idx = pagePriority({ url: 'http://a.cn/news/list.shtml', depth: 2, stats })
      const other = pagePriority({ url: 'http://a.cn/foo/bar.htm', depth: 2, stats })
      expect(ym).toBeLessThan(idx)
      expect(idx).toBeLessThan(other)

      // 实测"索引页"平均每页 50 篇 → 它的优先级应超过同等条件的 other 页
      stats.set('index', { pages: 2, articles: 100 })
      expect(pagePriority({ url: 'http://a.cn/news/list.shtml', depth: 2, stats })).toBeLessThan(
        pagePriority({ url: 'http://a.cn/foo/bar.htm', depth: 2, stats })
      )

      // 未覆盖年份 2016：含 2016 的页面强优先
      const uncovered = new Set([2016])
      expect(pagePriority({ url: 'http://a.cn/2016/', depth: 3, stats, uncoveredYears: uncovered })).toBeLessThan(
        pagePriority({ url: 'http://a.cn/2020/', depth: 1, stats, uncoveredYears: uncovered })
      )
    })

    it('停止判据：前沿空/页数上限/层数上限/时间预算/收益饱和/零收益快速收工', () => {
      const limits = resolveLimits({})
      const base = {
        recent: [] as PageYield[],
        frontierEmpty: false,
        pages: 5,
        limits,
        nextDepth: 1,
        elapsedMs: 1000,
        alreadyKnown: 0,
        discoveredNow: 10
      }
      expect(decideStop({ ...base, frontierEmpty: true })).toBe('frontier-empty')
      expect(decideStop({ ...base, pages: limits.maxPages })).toBe('page-cap')
      expect(decideStop({ ...base, nextDepth: limits.maxDepth + 1 })).toBe('depth-cap')
      expect(decideStop({ ...base, elapsedMs: limits.timeBudgetMs })).toBe('time-budget')
      expect(decideStop(base)).toBeNull() // 窗口不满，继续走

      // 连续 5 页零新增 → 立刻饱和（重复同步省请求）
      const zeros = Array.from({ length: FAST_ZERO_WINDOW }, () => ({ newArticles: 0, newCells: 0 }))
      expect(decideStop({ ...base, recent: zeros })).toBe('saturated')

      // 10 页窗口：新增合计低于阈值且没有新格子 → 饱和
      const low = Array.from({ length: SATURATION_WINDOW }, () => ({ newArticles: 0, newCells: 0 }))
      expect(decideStop({ ...base, recent: low, alreadyKnown: 62000, discoveredNow: 0 })).toBe('saturated')

      // 仍在开出新格子 → 不饱和（归档结构还没走完）
      const cells = Array.from({ length: SATURATION_WINDOW }, () => ({ newArticles: 0, newCells: 1 }))
      expect(decideStop({ ...base, recent: cells })).toBeNull()

      // 收益仍高于阈值（大站早期）→ 不饱和
      const rich = Array.from({ length: SATURATION_WINDOW }, () => ({ newArticles: 100, newCells: 0 }))
      expect(decideStop({ ...base, recent: rich, alreadyKnown: 0, discoveredNow: 1000 })).toBeNull()

      // 手动模式：不提前收工（用满预算）
      const manual = resolveLimits({ mode: 'manual', manualPages: 30, manualDepth: 2 })
      expect(decideStop({ ...base, limits: manual, recent: zeros })).toBeNull()

      // 页数**下限**：还没走到上次用量时，即使看起来饱和也不许收工（防发现范围逐次退化）
      const floored = resolveLimits({ hintPages: 60 })
      const low2 = Array.from({ length: SATURATION_WINDOW }, () => ({ newArticles: 0, newCells: 0 }))
      expect(decideStop({ ...base, limits: floored, pages: 12, recent: low2 })).toBeNull()
      expect(decideStop({ ...base, limits: floored, pages: 60, recent: low2 })).toBe('saturated')
    })

    it('停止原因必须能如实说明"还没走完"', () => {
      expect(describeStop('saturated', 47, 300, 0)).toContain('收益饱和')
      expect(describeStop('frontier-empty', 12, 300, 0)).toContain('已走完')
      expect(describeStop('page-cap', 300, 300, 187)).toContain('仍有 187 个列表页未访问')
      expect(describeStop('time-budget', 120, 300, 40)).toContain('时间预算')
    })
  })
}
