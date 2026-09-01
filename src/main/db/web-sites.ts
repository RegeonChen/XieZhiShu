/**
 * web-sites.ts —— 网页资料库仓储（2026-08-11）。
 * web_sites：用户注册的站点（root_url 唯一）。
 * web_site_articles：站点文章 URL 清单缓存（site_id + url 唯一，增量 upsert）。
 * 生成初稿时先同步文章清单 → 用撰写要求标题粗筛 → 命中文章增量抓取正文落库为 kind='url' 的 sources。
 */
import Database from 'better-sqlite3'
import type { WebSite } from '../../shared/types'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

interface WebSiteRow {
  id: string
  root_url: string
  title: string
  created_at: string
  updated_at: string
  last_synced_at: string | null
  keywords: string
}

interface SiteArticleRow {
  url: string
  title: string
  etag: string | null
  last_modified: string | null
  body_hash: string | null
  last_fetched_at: string | null
  published_at: string | null
}

function rowToWebSite(row: WebSiteRow): WebSite {
  return {
    id: row.id,
    rootUrl: row.root_url,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncedAt: row.last_synced_at ?? undefined,
    keywords: row.keywords ?? ''
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

export function updateWebSiteLastSynced(id: string, at: string): void {
  const db = getDb()
  db.prepare('UPDATE web_sites SET last_synced_at = ?, updated_at = ? WHERE id = ?').run(at, at, id)
}

/** 配置站点用户关键词（逗号分隔），参与该站点标题/正文召回（E11） */
export function updateWebSiteKeywords(id: string, keywords: string): void {
  const db = getDb()
  db.prepare('UPDATE web_sites SET keywords = ?, updated_at = ? WHERE id = ?').run(keywords, new Date().toISOString(), id)
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

/** 批量 upsert（单个事务内完成，同步站点清单用）；返回**新增**文章数（用于增量判断） */
export function upsertSiteArticles(siteId: string, articles: { url: string; title: string; publishedAt?: string }[]): number {
  const db = getDb()
  const exists = db.prepare('SELECT 1 FROM web_site_articles WHERE site_id = ? AND url = ?')
  const insert = db.prepare('INSERT INTO web_site_articles (site_id, url, title, discovered_at, published_at) VALUES (?, ?, ?, ?, ?)')
  const update = db.prepare('UPDATE web_site_articles SET title = ? WHERE site_id = ? AND url = ?')
  let added = 0
  const now = new Date().toISOString()
  const tx = db.transaction((list: { url: string; title: string; publishedAt?: string }[]) => {
    for (const a of list) {
      if (exists.get(siteId, a.url)) {
        update.run(a.title, siteId, a.url)
      } else {
        insert.run(siteId, a.url, a.title, now, a.publishedAt ?? null)
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

/** 站点文章清单（按发布时间倒序，无发布时间的按发现时间倒序） */
export interface SiteArticleRecord {
  url: string
  title: string
  etag?: string
  lastModified?: string
  bodyHash?: string
  lastFetchedAt?: string
  publishedAt?: string
}

export function listSiteArticles(siteId: string): SiteArticleRecord[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT url, title, etag, last_modified, body_hash, last_fetched_at, published_at FROM web_site_articles WHERE site_id = ? ORDER BY COALESCE(published_at, discovered_at) DESC'
  ).all(siteId) as SiteArticleRow[]
  return rows.map((r) => ({
    url: r.url,
    title: r.title,
    etag: r.etag ?? undefined,
    lastModified: r.last_modified ?? undefined,
    bodyHash: r.body_hash ?? undefined,
    lastFetchedAt: r.last_fetched_at ?? undefined,
    publishedAt: r.published_at ?? undefined
  }))
}

/** 读取单篇站点文章的抓取元数据（含 etag/last-modified/正文哈希/发布时间），供条件请求与去重用。 */
export function getSiteArticle(siteId: string, url: string): SiteArticleRecord | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT url, title, etag, last_modified, body_hash, last_fetched_at, published_at FROM web_site_articles WHERE site_id = ? AND url = ?'
  ).get(siteId, url) as SiteArticleRow | undefined
  if (!row) return null
  return {
    url: row.url,
    title: row.title,
    etag: row.etag ?? undefined,
    lastModified: row.last_modified ?? undefined,
    bodyHash: row.body_hash ?? undefined,
    lastFetchedAt: row.last_fetched_at ?? undefined,
    publishedAt: row.published_at ?? undefined
  }
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
  })
}
