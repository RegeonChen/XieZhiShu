/**
 * cache-build-plan.ts —— 「建立缓存与索引」的**就绪性规划**（Phase A，2026-10-06 用户需求）。
 *
 * 要解决的问题：用户要求"生成汇编前，若发现有用到未建立缓存/索引的资料，就**拦住**并让去设置页建立"
 * （用户裁定：**严格阻断**，不给"仍然生成"的逃生门）。拦人之前必须能秒级、**只读**地回答三个数：
 *   区间内共几篇 / 已经建立几篇 / 还差几篇（其中几篇"永远建不了"，不能算进缺口）。
 *
 * 与 `db/web-sites.ts#getSiteArticleDateStats` 的分工：那个函数回答"这个区间有多少篇"（P3 的年份预览），
 * 本模块回答"这个区间**还缺多少缓存**"——多了一层对 `web_article_body.state`（Migration 050）的核对
 * 与"同域白名单"归类（`article-guards.ts`）。
 *
 * ⚠ **只读保证**：本模块只做 SELECT，**不写任何表、不联网、不调大模型、不碰断点续传**。
 * 真正"写缓存"的是 Phase C 的建立引擎（`putCachedBody` / `putCacheMiss`）。
 *
 * ⚠ **绝不算进缺口的两种情形**（否则闸门永远不放行，这正是 Phase A 存在的意义）：
 *   ① `no-body`：已经尝试过、但站点给的是失效页/模板页/过短内容；
 *   ② `blocked`：URL 不在该注册站点的 http(s) 同域白名单内（`isAllowedTargetUrl`）——**永不可建**。
 */
import Database from 'better-sqlite3'
import { getDb, setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { putCachedBody, putCacheMiss } from '../db/article-body-cache'
import { allowedHostsForSite, isAllowedTargetUrl } from './article-guards'
import { estimateWebFetchMinutes } from './fetch-estimate'
import type {
  BuildNotReadyReason,
  BuildYearBucket,
  CacheBuildPlan,
  LocalBuildPlan,
  WebBuildPlan,
  WebLibrarySiteStats
} from '../../shared/types'

/** 需求给定的默认建立区间（用户 2026-10-06 原话：默认年份区间 2005–2025，用户可改） */
export const DEFAULT_BUILD_FROM_YEAR = 2005
export const DEFAULT_BUILD_TO_YEAR = 2025

/** 年份合法范围（防"1900 年"之类的输入把 SQL 扫成全表） */
export const MIN_BUILD_YEAR = 1900
export const MAX_BUILD_YEAR = 2100

/**
 * 校验并规范化年份区间（纯函数）。
 * 返回 `null` 表示**区间无效**（非整数 / 越界 / 起止颠倒）——调用方必须如实报错，
 * **不得静默纠正**（P3 的年份预览也是这个口径：反向区间提示无效且不落库）。
 */
export function normalizeYearRange(
  fromYear: number | undefined,
  toYear: number | undefined
): { fromYear: number; toYear: number } | null {
  const from = fromYear ?? DEFAULT_BUILD_FROM_YEAR
  const to = toYear ?? DEFAULT_BUILD_TO_YEAR
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from < MIN_BUILD_YEAR || to > MAX_BUILD_YEAR) return null
  if (from > to) return null
  return { fromYear: from, toYear: to }
}

/**
 * 把"区间内还没有缓存行"的目录条目分成 **待建立** 与 **永不可建**（纯函数，可单测）。
 *
 * 为什么不让 SQL 做：白名单判定是 `article-guards.ts` 的纯逻辑（协议 + `www.` 变体），
 * 在 SQL 里重写一遍必然与抓取路径的判定漂移——而这里错一次就是"永远建不上"或"反复去抓越权地址"。
 */
export function classifyUncachedUrls(input: {
  targets: { url: string; allowedHosts: readonly string[] }[]
}): { pending: number; blocked: number } {
  let pending = 0
  let blocked = 0
  for (const t of input.targets) {
    if (isAllowedTargetUrl(t.url, t.allowedHosts)) pending += 1
    else blocked += 1
  }
  return { pending, blocked }
}

/**
 * 就绪性判定（纯函数）：**只有这里返回 `ready: true`，生成汇编才允许开始**。
 *
 * - 网页侧：`pending > 0` 即未就绪；
 * - 本地侧：`pending + indexing > 0` 即未就绪；
 * - 索引失败（`failed > 0`）：默认**也算未就绪**（用户选择严格阻断），但做成可关的参数——
 *   因为"引擎不可用自动降级纯词法"是这个项目一直有的兜底，若用户想保留该兜底，把
 *   `treatIndexFailuresAsBlocking` 传 false 即可（界面会如实显示失败原因）。
 */
export function decideReadiness(
  web: Pick<WebBuildPlan, 'pending'>,
  local: Pick<LocalBuildPlan, 'pending' | 'indexing' | 'failed'>,
  opts: { treatIndexFailuresAsBlocking?: boolean } = { treatIndexFailuresAsBlocking: true }
): { ready: boolean; reasons: BuildNotReadyReason[] } {
  const reasons: BuildNotReadyReason[] = []
  if (web.pending > 0) reasons.push('web-pending')
  if (local.pending + local.indexing > 0) reasons.push('local-pending')
  if (opts.treatIndexFailuresAsBlocking !== false && local.failed > 0) reasons.push('local-index-failed')
  return { ready: reasons.length === 0, reasons }
}

/** 把按年分桶的原始行补齐成 `BuildYearBucket[]`（纯函数：pending/blocked 由调用方分年统计后传入） */
export function mergeYearBuckets(
  rows: { year: number; total: number; cached: number; noBody: number; blockedStored: number }[],
  extra: { year: number; pending: number; blocked: number }[]
): BuildYearBucket[] {
  const byYear = new Map<number, BuildYearBucket>()
  for (const r of rows) {
    byYear.set(r.year, {
      year: r.year,
      total: r.total,
      cached: r.cached,
      noBody: r.noBody,
      blocked: r.blockedStored,
      pending: 0
    })
  }
  for (const e of extra) {
    const b = byYear.get(e.year)
    if (!b) continue
    b.pending += e.pending
    b.blocked += e.blocked
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year)
}

/**
 * 本地资料库索引的建立情况（口径与设置页「已索引 N / 共 M 篇」一致，但**排除**正文缺失的来源）。
 * 导出供生成前就绪检查复用（`cache-build.checkCompilationReadiness`）——**本地侧与年份区间无关**，
 * 所以"本轮不用网页资料"（任务与全局都没设年份）时也要单独拿到这几个数。
 */
export function readLocalBuildPlan(): LocalBuildPlan {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN index_state = 'ready' THEN 1 ELSE 0 END) AS ready,
         SUM(CASE WHEN index_state = 'pending' AND body_missing = 0 THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN index_state = 'indexing' AND body_missing = 0 THEN 1 ELSE 0 END) AS indexing,
         SUM(CASE WHEN index_state = 'failed' AND body_missing = 0 THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN body_missing = 1 THEN 1 ELSE 0 END) AS body_missing
       FROM sources`
    )
    .get() as {
    total: number
    ready: number | null
    pending: number | null
    indexing: number | null
    failed: number | null
    body_missing: number | null
  }
  return {
    total: row.total,
    ready: row.ready ?? 0,
    pending: row.pending ?? 0,
    indexing: row.indexing ?? 0,
    failed: row.failed ?? 0,
    bodyMissing: row.body_missing ?? 0
  }
}

/**
 * 生成「建立缓存与索引」的完整计划（**只读**）。
 * 年份非法时抛错（由 IPC 转成 `ApiResult.error`，界面如实提示），**不静默回退默认区间**。
 */
export function buildCacheBuildPlan(req?: { fromYear?: number; toYear?: number }): CacheBuildPlan {
  const range = normalizeYearRange(req?.fromYear, req?.toYear)
  if (!range) {
    throw new Error('年份区间无效：起止年份必须是整数、且起始不晚于结束（1900–2100）')
  }
  const { fromYear, toYear } = range
  const db = getDb()

  // ① 按年分桶：目录条数 + 已有缓存的三态（Migration 050 的 state）
  const bucketRows = db
    .prepare(
      `SELECT CAST(substr(t.published_date, 1, 4) AS INTEGER) AS year,
              COUNT(*) AS total,
              SUM(CASE WHEN b.state = 'ok' THEN 1 ELSE 0 END) AS cached,
              SUM(CASE WHEN b.state = 'no-body' THEN 1 ELSE 0 END) AS no_body,
              SUM(CASE WHEN b.state = 'blocked' THEN 1 ELSE 0 END) AS blocked_stored
       FROM web_site_articles t
       LEFT JOIN web_article_body b ON b.site_id = t.site_id AND b.url = t.url
       WHERE t.published_date IS NOT NULL
         AND CAST(substr(t.published_date, 1, 4) AS INTEGER) BETWEEN ? AND ?
       GROUP BY year ORDER BY year`
    )
    .all(fromYear, toYear) as {
    year: number
    total: number
    cached: number | null
    no_body: number | null
    blocked_stored: number | null
  }[]

  // ② 还没有任何缓存行的条目 → 用白名单分出"待建立"与"永不可建"（只读）
  const uncached = db
    .prepare(
      `SELECT CAST(substr(t.published_date, 1, 4) AS INTEGER) AS year, t.site_id, t.url
       FROM web_site_articles t
       LEFT JOIN web_article_body b ON b.site_id = t.site_id AND b.url = t.url
       WHERE t.published_date IS NOT NULL
         AND CAST(substr(t.published_date, 1, 4) AS INTEGER) BETWEEN ? AND ?
         AND b.site_id IS NULL`
    )
    .all(fromYear, toYear) as { year: number; site_id: string; url: string }[]

  const sites = db.prepare('SELECT id, root_url FROM web_sites').all() as { id: string; root_url: string }[]
  const hostsBySite = new Map(sites.map((s) => [s.id, allowedHostsForSite(s.root_url)]))

  const perYear = new Map<number, { year: number; pending: number; blocked: number }>()
  for (const row of uncached) {
    const hosts = hostsBySite.get(row.site_id) ?? []
    const allowed = isAllowedTargetUrl(row.url, hosts)
    const slot = perYear.get(row.year) ?? { year: row.year, pending: 0, blocked: 0 }
    if (allowed) slot.pending += 1
    else slot.blocked += 1
    perYear.set(row.year, slot)
  }

  const byYear = mergeYearBuckets(
    bucketRows.map((r) => ({
      year: r.year,
      total: r.total,
      cached: r.cached ?? 0,
      noBody: r.no_body ?? 0,
      blockedStored: r.blocked_stored ?? 0
    })),
    [...perYear.values()]
  )

  const sum = (pick: (b: BuildYearBucket) => number): number => byYear.reduce((n, b) => n + pick(b), 0)
  const undated = (
    db.prepare('SELECT COUNT(*) AS c FROM web_site_articles WHERE published_date IS NULL').get() as { c: number }
  ).c

  const web: WebBuildPlan = {
    fromYear,
    toYear,
    total: sum((b) => b.total),
    cached: sum((b) => b.cached),
    noBody: sum((b) => b.noBody),
    blocked: sum((b) => b.blocked),
    pending: sum((b) => b.pending),
    byYear,
    estimatedMinutes: estimateWebFetchMinutes(sum((b) => b.pending)),
    undatedArticles: undated
  }

  const local = readLocalBuildPlan()
  const { ready, reasons } = decideReadiness(web, local)
  return { web, local, sites: readSiteStats(), ready, reasons }
}

/**
 * 站点概况（Phase 11 G）：有几个注册站点、其中几个**从来没同步过清单**。
 *
 * 为什么必须报给界面：没同步过的站点在目录里是 0 条，于是"本次要建 N 篇"看起来与它无关——
 * 用户会以为软件漏了这个站点（2026-10-06 实测反馈）。现在建立会**先同步再统计**，
 * 而计划里这个数让"建立前会先同步"这件事在点「建立」之前就看得见。
 */
function readSiteStats(): WebLibrarySiteStats {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN last_synced_at IS NOT NULL THEN 1 ELSE 0 END) AS synced
         FROM web_sites`
    )
    .get() as { total: number; synced: number | null }
  const synced = row.synced ?? 0
  return { total: row.total, synced, neverSynced: row.total - synced }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
    db.prepare(
      "INSERT INTO web_sites (id, root_url, title, created_at, updated_at) VALUES ('s1','https://x.gov.cn','X站','2026-01-01','2026-01-01')"
    ).run()
    const art = db.prepare(
      'INSERT INTO web_site_articles (site_id, url, title, discovered_at, published_date) VALUES (?,?,?,?,?)'
    )
    // 2020 年：1 篇已缓存(ok)、1 篇已尝试无正文(no-body)、1 篇越权(blocked)、1 篇待建立
    art.run('s1', 'https://x.gov.cn/a.htm', 'A', '2026-01-01', '2020-01-01')
    art.run('s1', 'https://x.gov.cn/b.htm', 'B', '2026-01-01', '2020-02-01')
    art.run('s1', 'https://x.gov.cn/c.htm', 'C', '2026-01-01', '2020-03-01')
    art.run('s1', 'https://x.gov.cn/d.htm', 'D', '2026-01-01', '2020-04-01')
    // 2021 年：2 篇待建立（其中 1 篇跨域）
    art.run('s1', 'https://x.gov.cn/e.htm', 'E', '2026-01-01', '2021-01-01')
    art.run('s1', 'https://evil.example.com/f.htm', 'F', '2026-01-01', '2021-02-01')
    // 日期未知：不参与任何年份区间，但必须如实报数
    art.run('s1', 'https://x.gov.cn/nodate.htm', 'G', '2026-01-01', null)

    putCachedBody('s1', 'https://x.gov.cn/a.htm', '某中学新建项目开工。', 'h-a')
    putCacheMiss('s1', 'https://x.gov.cn/b.htm', 'no-body')
    putCacheMiss('s1', 'https://x.gov.cn/c.htm', 'blocked')

    // 本地：2 篇就绪、1 篇待索引、1 篇正文缺失（**不该**算缺口）、1 篇索引失败
    const src = db.prepare('INSERT INTO sources (id, kind, title, body_missing, index_state) VALUES (?,?,?,?,?)')
    src.run('L1', 'file', '年鉴A', 0, 'ready')
    src.run('L2', 'file', '年鉴B', 0, 'ready')
    src.run('L3', 'file', '年鉴C', 0, 'pending')
    src.run('L4', 'url', '模板页', 1, 'pending')
    src.run('L5', 'file', '索引失败篇', 0, 'failed')
  })
  afterAll(() => db.close())

  describe('cache-build-plan（建立缓存与索引的只读规划）', () => {
    it('年份区间校验：默认 2005–2025、反向/越界/非整数一律无效', () => {
      expect(normalizeYearRange(undefined, undefined)).toEqual({ fromYear: 2005, toYear: 2025 })
      expect(normalizeYearRange(2012, 2012)).toEqual({ fromYear: 2012, toYear: 2012 })
      expect(normalizeYearRange(2020, 2005)).toBeNull()
      expect(normalizeYearRange(1800, 2025)).toBeNull()
      expect(normalizeYearRange(2005, 2200)).toBeNull()
      expect(normalizeYearRange(2005.5, 2025)).toBeNull()
    })

    it('白名单归类：同域放行→待建立；跨域/非 http(s)→永不可建', () => {
      const hosts = allowedHostsForSite('https://x.gov.cn')
      const res = classifyUncachedUrls({
        targets: [
          { url: 'https://x.gov.cn/a.htm', allowedHosts: hosts },
          { url: 'https://www.x.gov.cn/b.htm', allowedHosts: hosts },
          { url: 'https://evil.example.com/c.htm', allowedHosts: hosts },
          { url: 'file:///D:/secret.txt', allowedHosts: hosts },
          { url: 'javascript:alert(1)', allowedHosts: hosts },
          { url: 'https://x.gov.cn:8443/d.htm', allowedHosts: hosts }
        ]
      })
      // 同域两条放行；跨域、file:、javascript: 判 blocked；带端口的与白名单不同主机 → blocked
      expect(res.pending).toBe(2)
      expect(res.blocked).toBe(4)
      expect(classifyUncachedUrls({ targets: [] })).toEqual({ pending: 0, blocked: 0 })
    })

    it('只读规划：三态分类正确、no-body/blocked 不计入缺口、未知日期如实报数', () => {
      const plan = buildCacheBuildPlan({ fromYear: 2020, toYear: 2021 })
      expect(plan.web.total).toBe(6) // a,b,c,d,e,F（nodate 不算）
      expect(plan.web.cached).toBe(1) // a
      expect(plan.web.noBody).toBe(1) // b
      // c 是按白名单**预判** blocked（还没抓过），F 是跨域 → 都算 blocked
      expect(plan.web.blocked).toBe(2)
      expect(plan.web.pending).toBe(2) // d + e
      expect(plan.web.byYear.map((b) => b.year)).toEqual([2020, 2021])
      expect(plan.web.byYear[0]).toMatchObject({ total: 4, cached: 1, noBody: 1, blocked: 1, pending: 1 })
      expect(plan.web.byYear[1]).toMatchObject({ total: 2, cached: 0, noBody: 0, blocked: 1, pending: 1 })
      expect(plan.web.undatedArticles).toBe(1)
      expect(plan.web.estimatedMinutes).toBe(estimateWebFetchMinutes(2))
      expect(plan.ready).toBe(false)
      expect(plan.reasons).toContain('web-pending')
    })

    it('站点概况（Phase 11 G）：如实报"共几个站、其中几个从来没同步过清单"', () => {
      const plan = buildCacheBuildPlan({ fromYear: 2020, toYear: 2021 })
      // 夹具里只有 s1，且它没有 last_synced_at → 1 个站点、0 个已同步、1 个从未同步
      expect(plan.sites).toEqual({ total: 1, synced: 0, neverSynced: 1 })

      // 同步过一次之后 → 变成"已同步"
      db.prepare("UPDATE web_sites SET last_synced_at = '2026-10-06T00:00:00.000Z' WHERE id = 's1'").run()
      expect(buildCacheBuildPlan({ fromYear: 2020, toYear: 2021 }).sites).toEqual({ total: 1, synced: 1, neverSynced: 0 })
    })

    it('本地侧：正文缺失的来源不算缺口，但仍如实计数；索引失败默认阻断', () => {
      const plan = buildCacheBuildPlan({ fromYear: 2020, toYear: 2021 })
      expect(plan.local).toEqual({ total: 5, ready: 2, pending: 1, indexing: 0, failed: 1, bodyMissing: 1 })
      // 待索引（L3）与索引失败（L5）各一条原因；正文缺失（L4）**不产生**原因
      expect(plan.reasons).toContain('local-pending')
      expect(plan.reasons).toContain('local-index-failed')
      expect(decideReadiness({ pending: 0 }, { pending: 0, indexing: 0, failed: 1 })).toEqual({
        ready: false,
        reasons: ['local-index-failed']
      })
      // 可关的参数：保留"引擎不可用降级纯词法"这一既有兜底
      expect(
        decideReadiness({ pending: 0 }, { pending: 0, indexing: 0, failed: 1 }, { treatIndexFailuresAsBlocking: false })
      ).toEqual({ ready: true, reasons: [] })
      // indexing 也算未就绪
      expect(decideReadiness({ pending: 0 }, { pending: 0, indexing: 1, failed: 0 }).reasons).toEqual(['local-pending'])
      // 全建齐
      expect(decideReadiness({ pending: 0 }, { pending: 0, indexing: 0, failed: 0 })).toEqual({ ready: true, reasons: [] })
    })

    it('空目录/无该年份区间：pending 0 且不报错', () => {
      const plan = buildCacheBuildPlan({ fromYear: 1990, toYear: 1999 })
      expect(plan.web.total).toBe(0)
      expect(plan.web.pending).toBe(0)
      expect(plan.web.byYear).toEqual([])
      expect(plan.web.estimatedMinutes).toBe(0)
      // 本地侧与年份无关，仍如实报
      expect(plan.local.total).toBe(5)
    })

    it('年份非法时抛错（不静默回退默认区间）', () => {
      expect(() => buildCacheBuildPlan({ fromYear: 2025, toYear: 2005 })).toThrow(/年份区间无效/)
    })

    it('mergeYearBuckets：无 pending 的年份照常返回，bucket 缺失时不凭空造年份', () => {
      const merged = mergeYearBuckets(
        [{ year: 2020, total: 3, cached: 1, noBody: 0, blockedStored: 0 }],
        [
          { year: 2020, pending: 2, blocked: 0 },
          { year: 2099, pending: 5, blocked: 5 } // 目录里没有这一年 → 忽略
        ]
      )
      expect(merged).toEqual([{ year: 2020, total: 3, cached: 1, noBody: 0, blocked: 0, pending: 2 }])
    })
  })
}
