/**
 * web-sites.ts —— 网页资料库仓储（2026-08-11）。
 * web_sites：用户注册的站点（root_url 唯一）。
 * web_site_articles：站点文章 URL 清单缓存（site_id + url 唯一，增量 upsert）。
 * 生成初稿时先同步文章清单 → 用撰写要求标题粗筛 → 命中文章增量抓取正文落库为 kind='url' 的 sources。
 */
import Database from 'better-sqlite3'
import type { WebArticleDateStats, WebSite } from '../../shared/types'
import { estimateWebFetchMinutes } from '../web-source/fetch-estimate'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

interface WebSiteRow {
  id: string
  root_url: string
  title: string
  created_at: string
  updated_at: string
  last_synced_at: string | null
}

interface SiteArticleRow {
  url: string
  title: string
  etag: string | null
  last_modified: string | null
  body_hash: string | null
  last_fetched_at: string | null
  published_at: string | null
  // Phase 10（Migration 045）：日期阶梯结果与抓取状态
  published_date: string | null
  date_source: string | null
  date_confidence: string | null
  url_date: string | null
  sitemap_lastmod: string | null
  http_last_modified: string | null
  fetch_state: string | null
  body_chars: number | null
  screen_hit: number | null
  screened_at: string | null
}

function rowToWebSite(row: WebSiteRow): WebSite {
  return {
    id: row.id,
    rootUrl: row.root_url,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncedAt: row.last_synced_at ?? undefined
  }
}

export function listWebSites(): WebSite[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM web_sites ORDER BY created_at ASC').all() as WebSiteRow[]
  return rows.map(rowToWebSite)
}

export function getWebSiteById(id: string): WebSite | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM web_sites WHERE id = ?').get(id) as WebSiteRow | undefined
  return row ? rowToWebSite(row) : null
}

export function getWebSiteByRootUrl(rootUrl: string): WebSite | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM web_sites WHERE root_url = ?').get(rootUrl) as WebSiteRow | undefined
  return row ? rowToWebSite(row) : null
}

/** 注册站点；root_url 已存在时返回 null（由调用方提示重复） */
export function addWebSite(rootUrl: string, title?: string): WebSite | null {
  const db = getDb()
  const normalized = rootUrl.replace(/\/+$/, '') // 去尾部斜杠归一
  if (getWebSiteByRootUrl(normalized)) return null
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO web_sites (id, root_url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, normalized, title?.trim() ?? '', now, now)
  return getWebSiteById(id)
}

/** 删除站点（web_site_articles 随外键级联删除） */
export function removeWebSite(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM web_sites WHERE id = ?').run(id)
}

/** 更新站点（可改名称与根网址）；站点不存在或根网址重复时返回 null。 */
export function updateWebSite(id: string, patch: { rootUrl?: string; title?: string }): WebSite | null {
  const cur = getWebSiteById(id)
  if (!cur) return null
  const db = getDb()
  const rootUrl = patch.rootUrl !== undefined ? patch.rootUrl.trim().replace(/\/+$/, '') : cur.rootUrl
  if (!rootUrl) return null
  const dup = getWebSiteByRootUrl(rootUrl)
  if (dup && dup.id !== id) return null
  const title = patch.title !== undefined ? patch.title.trim() : cur.title
  db.prepare('UPDATE web_sites SET root_url = ?, title = ?, updated_at = ? WHERE id = ?')
    .run(rootUrl, title, new Date().toISOString(), id)
  return getWebSiteById(id)
}

export function updateWebSiteLastSynced(id: string, at: string): void {
  const db = getDb()
  db.prepare('UPDATE web_sites SET last_synced_at = ?, updated_at = ? WHERE id = ?').run(at, at, id)
}


// ---- 站点文章清单（web_site_articles） ----

/** 增量写入站点发现的文章（url 已存在则更新标题/发布时间，幂等） */
export function upsertSiteArticle(siteId: string, url: string, title: string, publishedAt?: string): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO web_site_articles (site_id, url, title, discovered_at, published_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(site_id, url) DO UPDATE SET title = excluded.title, published_at = COALESCE(excluded.published_at, web_site_articles.published_at)`
  ).run(siteId, url, title, new Date().toISOString(), publishedAt ?? null)
}

/** 批量 upsert 的输入条目（Phase 10：目录必须带日期） */
export interface SiteArticleInput {
  url: string
  title: string
  /** 页面抽取到的**原始**发布时间（保留旧语义，由抓取阶段写入 `published_at`） */
  publishedAt?: string
  /** **归一化**发布日期（`YYYY-MM-DD` / `YYYY-MM` / `YYYY`）——年份区间筛选只认它 */
  publishedDate?: string
  /** 日期来自哪一级：feed / sitemap-news / sitemap-lastmod / url / http / page */
  dateSource?: string
  dateConfidence?: string
  /** URL 内嵌日期（L3 原始证据） */
  urlDate?: string
  /** sitemap 的 `lastmod`（L2b 原始证据） */
  sitemapLastmod?: string
}

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 }

/**
 * 是否用新日期覆盖已有日期。
 * 规则：原本没有日期 → 覆盖；新来源**置信度更高** → 覆盖（例如后来才拿到的 feed/sitemap 日期可以升级 URL 日期）；
 * 否则保留已有值——**避免每次同步把更权威的日期降级**，也让重复同步是稳定的（幂等）。
 */
function shouldUpgradeDate(prevDate: string | null, prevConf: string | null, nextDate?: string, nextConf?: string): boolean {
  if (!nextDate) return false
  if (!prevDate) return true
  return (CONFIDENCE_RANK[nextConf ?? ''] ?? 0) > (CONFIDENCE_RANK[prevConf ?? ''] ?? 0)
}

/**
 * 批量 upsert（单个事务内完成，同步站点清单用）；返回**新增**文章数（用于增量判断）。
 * Phase 10：写入日期阶梯结果（`published_date` / `date_source` / `date_confidence` / `url_date` / `sitemap_lastmod`）。
 */
export function upsertSiteArticles(siteId: string, articles: SiteArticleInput[]): number {
  const db = getDb()
  const find = db.prepare('SELECT published_date, date_confidence FROM web_site_articles WHERE site_id = ? AND url = ?')
  const insert = db.prepare(
    `INSERT INTO web_site_articles
       (site_id, url, title, discovered_at, published_at, published_date, date_source, date_confidence, url_date, sitemap_lastmod, date_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const update = db.prepare(
    `UPDATE web_site_articles SET
       title = ?,
       published_date = ?,
       date_source = ?,
       date_confidence = ?,
       url_date = COALESCE(?, url_date),
       sitemap_lastmod = COALESCE(?, sitemap_lastmod),
       date_checked_at = ?
     WHERE site_id = ? AND url = ?`
  )
  let added = 0
  const now = new Date().toISOString()
  const tx = db.transaction((list: SiteArticleInput[]) => {
    for (const a of list) {
      const prev = find.get(siteId, a.url) as { published_date: string | null; date_confidence: string | null } | undefined
      if (prev) {
        const upgrade = shouldUpgradeDate(prev.published_date, prev.date_confidence, a.publishedDate, a.dateConfidence)
        update.run(
          a.title,
          upgrade ? (a.publishedDate ?? null) : prev.published_date,
          upgrade ? (a.dateSource ?? null) : null,
          upgrade ? (a.dateConfidence ?? null) : prev.date_confidence,
          a.urlDate ?? null,
          a.sitemapLastmod ?? null,
          now,
          siteId,
          a.url
        )
      } else {
        insert.run(
          siteId,
          a.url,
          a.title,
          now,
          a.publishedAt ?? null,
          a.publishedDate ?? null,
          a.dateSource ?? null,
          a.dateConfidence ?? null,
          a.urlDate ?? null,
          a.sitemapLastmod ?? null,
          now
        )
        added++
      }
    }
  })
  tx(articles)
  return added
}

/** 文章正文抓取后若解析出发布时间，更新该文章的 published_at（E10） */
export function updateSiteArticlePublished(siteId: string, url: string, publishedAt: string): void {
  const db = getDb()
  db.prepare('UPDATE web_site_articles SET published_at = ? WHERE site_id = ? AND url = ?').run(publishedAt, siteId, url)
}

/**
 * Phase 10 P3：目录的**日期统计**（年份区间筛选预览）。
 * 只读、不抓正文——用户在界面上选完起止年份就能立刻看到"这个区间里有多少篇、多少篇日期未知、预计抓多久"。
 * 口径：只认 `published_date`（日期阶梯的归一化结果）；`published_date` 为空的进 `unknown`（**不丢弃**）。
 */
export function getSiteArticleDateStats(fromYear: number, toYear: number): WebArticleDateStats {
  const db = getDb()
  const one = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...args) as { c: number } | undefined)?.c ?? 0
  const total = one('SELECT COUNT(*) c FROM web_site_articles')
  const dated = one('SELECT COUNT(*) c FROM web_site_articles WHERE published_date IS NOT NULL')
  const byYear = (
    db
      .prepare(
        `SELECT substr(published_date, 1, 4) AS year, COUNT(*) AS count
         FROM web_site_articles WHERE published_date IS NOT NULL
         GROUP BY year ORDER BY year`
      )
      .all() as { year: string; count: number }[]
  )
  const inRangeByYear = byYear.filter((r) => {
    const y = Number(r.year)
    return y >= fromYear && y <= toYear
  })
  const inRange = inRangeByYear.reduce((n, r) => n + r.count, 0)
  return {
    total,
    dated,
    unknown: total - dated,
    inRange,
    byYear,
    inRangeByYear,
    estimatedMinutes: estimateWebFetchMinutes(inRange)
  }
}

/** Phase 10 P4：待抓取的目录条目（只取"未处理"的，保证可续跑） */
export interface CrawlTarget {
  url: string
  title: string
  siteId: string
  siteTitle: string
  publishedDate?: string
  dateSource?: string
  dateConfidence?: string
}

/**
 * 列出年份区间内**尚未处理**的文章（`fetch_state IS NULL`）。
 * 已 `fetched`（命中并落库）与 `dropped`（未命中，只留哈希）都不会重复抓取——这就是断点续跑的实现方式。
 * `failed` 默认也不重试（避免一次网络抖动让整批卡在同一篇上）；需要重试时用 `resetArticleFetchState`。
 */
export function listArticlesForCrawl(fromYear: number, toYear: number): CrawlTarget[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT a.url, a.title, a.site_id, s.title AS site_title, a.published_date, a.date_source, a.date_confidence
       FROM web_site_articles a
       JOIN web_sites s ON s.id = a.site_id
       WHERE a.published_date IS NOT NULL
         AND CAST(substr(a.published_date, 1, 4) AS INTEGER) BETWEEN ? AND ?
         AND a.fetch_state IS NULL
       ORDER BY a.published_date DESC, a.rowid`
    )
    .all(fromYear, toYear) as {
    url: string
    title: string
    site_id: string
    site_title: string | null
    published_date: string | null
    date_source: string | null
    date_confidence: string | null
  }[]
  return rows.map((r) => ({
    url: r.url,
    title: r.title,
    siteId: r.site_id,
    siteTitle: r.site_title ?? '',
    publishedDate: r.published_date ?? undefined,
    dateSource: r.date_source ?? undefined,
    dateConfidence: r.date_confidence ?? undefined
  }))
}

/** 年份区间内的总篇数 / 已处理 / 失败（进度与"这次要不要抓"的依据） */
export function countArticlesInRange(fromYear: number, toYear: number): { total: number; processed: number; failed: number } {
  const db = getDb()
  const q = (where: string): number =>
    (
      db
        .prepare(
          `SELECT COUNT(*) c FROM web_site_articles
           WHERE published_date IS NOT NULL
             AND CAST(substr(published_date, 1, 4) AS INTEGER) BETWEEN ? AND ?${where}`
        )
        .get(fromYear, toYear) as { c: number }
    ).c
  return {
    total: q(''),
    processed: q(" AND fetch_state IN ('fetched','dropped')"),
    failed: q(" AND fetch_state = 'failed'")
  }
}

/**
 * 抓取后回写状态。
 * `state='fetched'`（命中并落库）/ `'dropped'`（未命中：**只留 body_hash + 字数**，正文丢弃）/ `'failed'`。
 * 同时可回填 L4/L5 日期（仅在该行**没有更可信日期**时写入，规则与发现期一致）。
 */
export function updateArticleFetchState(
  siteId: string,
  url: string,
  patch: {
    state: 'fetched' | 'dropped' | 'failed'
    bodyHash?: string
    bodyChars?: number
    screenHit?: boolean
    publishedDate?: string
    dateSource?: string
    dateConfidence?: string
    httpLastModified?: string
  }
): void {
  const db = getDb()
  const now = new Date().toISOString()
  const cur = db
    .prepare('SELECT published_date, date_confidence FROM web_site_articles WHERE site_id = ? AND url = ?')
    .get(siteId, url) as { published_date: string | null; date_confidence: string | null } | undefined
  const upgrade = shouldUpgradeDate(cur?.published_date ?? null, cur?.date_confidence ?? null, patch.publishedDate, patch.dateConfidence)
  db.prepare(
    `UPDATE web_site_articles SET
       fetch_state = ?, body_hash = COALESCE(?, body_hash), body_chars = COALESCE(?, body_chars),
       screen_hit = ?, screened_at = ?,
       published_date = ?, date_source = ?, date_confidence = ?,
       http_last_modified = COALESCE(?, http_last_modified)
     WHERE site_id = ? AND url = ?`
  ).run(
    patch.state,
    patch.bodyHash ?? null,
    patch.bodyChars ?? null,
    patch.screenHit == null ? null : patch.screenHit ? 1 : 0,
    now,
    upgrade ? (patch.publishedDate ?? null) : (cur?.published_date ?? null),
    upgrade ? (patch.dateSource ?? null) : null,
    upgrade ? (patch.dateConfidence ?? null) : (cur?.date_confidence ?? null),
    patch.httpLastModified ?? null,
    siteId,
    url
  )
}

/**
 * 重置年份区间内的抓取状态（清空 `fetch_state` / `screen_hit` / `body_hash` / `body_chars`）。
 * 用途：**换了主题关键词想重新筛选**时必须先重置——未命中粗筛的正文已被丢弃，只能重新抓一遍。
 * 只清状态，不删任何 `sources` 行（已落库的来源保持不动）。
 */
export function resetArticleFetchState(fromYear: number, toYear: number): number {
  const db = getDb()
  const info = db
    .prepare(
      `UPDATE web_site_articles SET fetch_state = NULL, screen_hit = NULL, screened_at = NULL, body_hash = NULL, body_chars = NULL
       WHERE published_date IS NOT NULL
         AND CAST(substr(published_date, 1, 4) AS INTEGER) BETWEEN ? AND ?`
    )
    .run(fromYear, toYear)
  return info.changes
}

/**
 * 站点文章清单条目（Phase 10：带日期阶梯结果与抓取状态） */
export interface SiteArticleRecord {
  url: string
  title: string
  etag?: string
  lastModified?: string
  bodyHash?: string
  lastFetchedAt?: string
  /** 页面抽取到的原始发布时间 */
  publishedAt?: string
  /** 归一化发布日期（`YYYY-MM-DD` / `YYYY-MM` / `YYYY`） */
  publishedDate?: string
  /** feed / sitemap-news / sitemap-lastmod / url / http / page */
  dateSource?: string
  /** high / medium / low */
  dateConfidence?: string
  /** URL 内嵌日期（L3 证据） */
  urlDate?: string
  /** sitemap `lastmod`（L2b 证据） */
  sitemapLastmod?: string
  /** HTTP `Last-Modified`（L4 证据） */
  httpLastModified?: string
  /** null=未处理 / fetched / dropped / failed */
  fetchState?: string
  /** 正文字数（未命中粗筛的正文会被丢弃，只留哈希与字数） */
  bodyChars?: number
  /** 本地粗筛是否命中 */
  screenHit?: boolean
  screenedAt?: string
}

const ARTICLE_COLUMNS =
  'url, title, etag, last_modified, body_hash, last_fetched_at, published_at, published_date, date_source, date_confidence, url_date, sitemap_lastmod, http_last_modified, fetch_state, body_chars, screen_hit, screened_at'

function rowToArticle(r: SiteArticleRow): SiteArticleRecord {
  return {
    url: r.url,
    title: r.title,
    etag: r.etag ?? undefined,
    lastModified: r.last_modified ?? undefined,
    bodyHash: r.body_hash ?? undefined,
    lastFetchedAt: r.last_fetched_at ?? undefined,
    publishedAt: r.published_at ?? undefined,
    publishedDate: r.published_date ?? undefined,
    dateSource: r.date_source ?? undefined,
    dateConfidence: r.date_confidence ?? undefined,
    urlDate: r.url_date ?? undefined,
    sitemapLastmod: r.sitemap_lastmod ?? undefined,
    httpLastModified: r.http_last_modified ?? undefined,
    fetchState: r.fetch_state ?? undefined,
    bodyChars: r.body_chars ?? undefined,
    screenHit: r.screen_hit == null ? undefined : r.screen_hit === 1,
    screenedAt: r.screened_at ?? undefined
  }
}

export function listSiteArticles(siteId: string): SiteArticleRecord[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT ${ARTICLE_COLUMNS} FROM web_site_articles WHERE site_id = ? ORDER BY COALESCE(published_date, published_at, discovered_at) DESC`
  ).all(siteId) as SiteArticleRow[]
  return rows.map(rowToArticle)
}

/** 读取单篇站点文章的抓取元数据（含 etag/last-modified/正文哈希/日期阶梯结果），供条件请求与去重用。 */
export function getSiteArticle(siteId: string, url: string): SiteArticleRecord | null {
  const db = getDb()
  const row = db.prepare(
    `SELECT ${ARTICLE_COLUMNS} FROM web_site_articles WHERE site_id = ? AND url = ?`
  ).get(siteId, url) as SiteArticleRow | undefined
  return row ? rowToArticle(row) : null
}

/** 文章正文抓取成功后更新其抓取元数据（条件请求与正文哈希去重用）。 */
export function updateSiteArticleFetched(
  siteId: string,
  url: string,
  meta: { etag?: string; lastModified?: string; bodyHash?: string; fetchedAt?: string }
): void {
  const db = getDb()
  db.prepare(
    'UPDATE web_site_articles SET etag = ?, last_modified = ?, body_hash = ?, last_fetched_at = ? WHERE site_id = ? AND url = ?'
  ).run(meta.etag ?? null, meta.lastModified ?? null, meta.bodyHash ?? null, meta.fetchedAt ?? new Date().toISOString(), siteId, url)
}

/**
 * 清除该文章的条件请求记录（ETag / Last-Modified）。
 * **2026-10-04 修 304 死锁**：条件请求命中 304、但库里已无可复用的正文时（例如正文所在来源随任务被删除），
 * 若不清理这两个字段，此后每次抓取都会继续 304 → 该 URL **永久抓不到**，而界面只表现为"抓到的篇数变少"。
 */
export function clearSiteArticleValidators(siteId: string, url: string): void {
  const db = getDb()
  db.prepare('UPDATE web_site_articles SET etag = NULL, last_modified = NULL WHERE site_id = ? AND url = ?').run(siteId, url)
}

/**
 * 同站点是否已有**别的 URL** 抓到过完全相同的正文。
 * 用途（2026-10-04）：老文章失效时站点会对一群 URL 返回同一份通用模板页，正文逐字相同且 `body_hash` 也相同；
 * 空标题候选（sitemap 发现）的标题探针天生失效，这条"模板页成群出现"是最可靠的可判定信号。
 */
export function findSiteArticleByBodyHash(
  siteId: string,
  bodyHash: string,
  excludeUrl: string
): { url: string; title: string } | null {
  const db = getDb()
  const row = db
    .prepare('SELECT url, title FROM web_site_articles WHERE site_id = ? AND body_hash = ? AND url <> ? LIMIT 1')
    .get(siteId, bodyHash, excludeUrl) as { url: string; title: string } | undefined
  return row ?? null
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
  })
  afterAll(() => db.close())

  describe('web-sites repository (web source sites)', () => {
    it('adds site with normalized root url and rejects duplicate', () => {
      const a = addWebSite('https://example.gov.cn/', '示例站')
      expect(a).not.toBeNull()
      expect(a!.rootUrl).toBe('https://example.gov.cn')
      expect(addWebSite('https://example.gov.cn', '重复')).toBeNull()
    })

    it('upserts site articles incrementally', () => {
      const site = addWebSite('https://fzxq.fuzhou.gov.cn')!
      upsertSiteArticle(site.id, 'https://fzxq.fuzhou.gov.cn/a.htm', '标题A')
      upsertSiteArticle(site.id, 'https://fzxq.fuzhou.gov.cn/a.htm', '标题A2') // 更新标题，不新增
      upsertSiteArticle(site.id, 'https://fzxq.fuzhou.gov.cn/b.htm', '标题B')
      const articles = listSiteArticles(site.id)
      expect(articles).toHaveLength(2)
      expect(articles.some((a) => a.url.endsWith('/a.htm') && a.title === '标题A2')).toBe(true)
    })

    it('removes site and cascades its article list', () => {
      const site = addWebSite('https://example2.gov.cn')!
      upsertSiteArticle(site.id, 'https://example2.gov.cn/x.htm', 'X')
      removeWebSite(site.id)
      expect(getWebSiteById(site.id)).toBeNull()
      expect(listSiteArticles(site.id)).toHaveLength(0)
    })

    it('clears conditional-request validators (304 死锁修复 2026-10-04)', () => {
      const site = addWebSite('https://example3.gov.cn')!
      upsertSiteArticle(site.id, 'https://example3.gov.cn/a.htm', '甲文')
      updateSiteArticleFetched(site.id, 'https://example3.gov.cn/a.htm', {
        etag: 'W/"abc"',
        lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
        bodyHash: 'deadbeef'
      })
      let meta = getSiteArticle(site.id, 'https://example3.gov.cn/a.htm')!
      expect(meta.etag).toBe('W/"abc"')
      expect(meta.lastModified).toBe('Mon, 01 Jan 2024 00:00:00 GMT')
      // 清掉条件请求记录后必须真的不再带 If-None-Match，否则该 URL 会永远 304、永远抓不到
      clearSiteArticleValidators(site.id, 'https://example3.gov.cn/a.htm')
      meta = getSiteArticle(site.id, 'https://example3.gov.cn/a.htm')!
      expect(meta.etag).toBeUndefined()
      expect(meta.lastModified).toBeUndefined()
      expect(meta.bodyHash).toBe('deadbeef') // 正文哈希不是条件请求字段，不应被清掉
    })

    it('finds another url on the same site with an identical body hash (模板页判定 2026-10-04)', () => {
      const site = addWebSite('https://example4.gov.cn')!
      upsertSiteArticle(site.id, 'https://example4.gov.cn/old1.htm', '老文章一')
      upsertSiteArticle(site.id, 'https://example4.gov.cn/old2.htm', '老文章二')
      updateSiteArticleFetched(site.id, 'https://example4.gov.cn/old1.htm', { bodyHash: 'samehash' })
      expect(findSiteArticleByBodyHash(site.id, 'samehash', 'https://example4.gov.cn/old2.htm')?.url).toBe(
        'https://example4.gov.cn/old1.htm'
      )
      // 排除自己：不把自己当重复
      expect(findSiteArticleByBodyHash(site.id, 'samehash', 'https://example4.gov.cn/old1.htm')).toBeNull()
      expect(findSiteArticleByBodyHash(site.id, 'otherhash', 'https://example4.gov.cn/old2.htm')).toBeNull()
    })

    it('stores ladder dates and only upgrades them on higher confidence (Phase 10 P2)', () => {
      const site = addWebSite('https://example5.gov.cn')!
      const url = 'https://example5.gov.cn/a.htm'
      // ① 首次同步：只拿到 URL 的"月精度"日期（中等置信度）
      upsertSiteArticles(site.id, [
        { url, title: '甲文', publishedDate: '2022-04', dateSource: 'url', dateConfidence: 'medium', urlDate: '2022-04' }
      ])
      let rec = getSiteArticle(site.id, url)!
      expect(rec.publishedDate).toBe('2022-04')
      expect(rec.dateSource).toBe('url')
      expect(rec.urlDate).toBe('2022-04')
      expect(rec.dateConfidence).toBe('medium')

      // ② 再次同步拿到 sitemap 的 lastmod（同为中等）→ **不得**覆盖
      upsertSiteArticles(site.id, [
        { url, title: '甲文', publishedDate: '2022-03-31', dateSource: 'sitemap-lastmod', dateConfidence: 'medium', sitemapLastmod: '2022-03-31' }
      ])
      rec = getSiteArticle(site.id, url)!
      expect(rec.publishedDate).toBe('2022-04')
      expect(rec.sitemapLastmod).toBe('2022-03-31') // 证据列仍要补齐
      expect(rec.urlDate).toBe('2022-04') // COALESCE：旧证据不被抹掉

      // ③ 后来 feed 给了高置信度的精确日期 → 允许升级
      upsertSiteArticles(site.id, [
        { url, title: '甲文', publishedDate: '2022-04-19', dateSource: 'feed', dateConfidence: 'high', urlDate: '2022-04' }
      ])
      rec = getSiteArticle(site.id, url)!
      expect(rec.publishedDate).toBe('2022-04-19')
      expect(rec.dateSource).toBe('feed')

      // ④ 页面日期（高置信度但同级）**不得**把 feed 的日期覆盖回模板日期 2018-06-15
      upsertSiteArticles(site.id, [
        { url, title: '甲文', publishedDate: '2018-06-15', dateSource: 'page', dateConfidence: 'high' }
      ])
      expect(getSiteArticle(site.id, url)!.publishedDate).toBe('2022-04-19')

      // ⑤ 未命中时也不得把日期清空（幂等）
      upsertSiteArticles(site.id, [{ url, title: '甲文' }])
      expect(getSiteArticle(site.id, url)!.publishedDate).toBe('2022-04-19')

      // ⑥ 无日期文章照样入库（进"日期未知"桶，绝不丢弃）
      upsertSiteArticles(site.id, [{ url: 'https://example5.gov.cn/b.htm', title: '乙文' }])
      expect(getSiteArticle(site.id, 'https://example5.gov.cn/b.htm')!.publishedDate).toBeUndefined()
      expect(listSiteArticles(site.id)).toHaveLength(2)
    })

    it('computes year-range date stats for the P3 preview (Phase 10 P3)', () => {
      const before = getSiteArticleDateStats(2005, 2020)
      const site = addWebSite('https://example6.gov.cn')!
      upsertSiteArticles(site.id, [
        { url: 'https://example6.gov.cn/2005/a.htm', title: 'A', publishedDate: '2005-03-01', dateSource: 'url', dateConfidence: 'high' },
        { url: 'https://example6.gov.cn/2010/b.htm', title: 'B', publishedDate: '2010-07', dateSource: 'url', dateConfidence: 'medium' },
        { url: 'https://example6.gov.cn/2020/c.htm', title: 'C', publishedDate: '2020-12-31', dateSource: 'feed', dateConfidence: 'high' },
        { url: 'https://example6.gov.cn/2026/d.htm', title: 'D', publishedDate: '2026-01-01', dateSource: 'url', dateConfidence: 'high' },
        { url: 'https://example6.gov.cn/unknown/e.htm', title: 'E' } // 日期未知：进 unknown 桶，不丢弃
      ])
      const after = getSiteArticleDateStats(2005, 2020)
      expect(after.total - before.total).toBe(5)
      expect(after.dated - before.dated).toBe(4)
      expect(after.unknown - before.unknown).toBe(1)
      expect(after.inRange - before.inRange).toBe(3) // 2005 / 2010 / 2020（2026 在区间外）
      const years = after.inRangeByYear.map((r) => r.year)
      expect(years).toContain('2005')
      expect(years).toContain('2010')
      expect(years).toContain('2020')
      expect(years).not.toContain('2026')
      // 只到"年月"精度的日期按年月比较，仍算在区间内；空区间耗时估算为 0
      expect(getSiteArticleDateStats(2010, 2010).inRange).toBeGreaterThanOrEqual(1)
      const y2027 = getSiteArticleDateStats(2027, 2027)
      expect(y2027.inRange).toBe(0)
      expect(y2027.estimatedMinutes).toBe(0)
    })
  })
}
