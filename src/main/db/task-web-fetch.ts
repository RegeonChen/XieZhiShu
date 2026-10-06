/**
 * task-web-fetch.ts —— **任务级**"网页抓取 + 筛选"账本（Phase 10 P5，Migration 047）。
 *
 * 为什么必须任务级（用户裁定 2026-10-04）：
 * 新建任务、开始一个新主题的汇编生成时，**必须重新抓取网页资料库并重跑一遍筛选**，而且这是默认行为、用户零操作。
 * 此前账本记在 `web_site_articles`（站点目录）上 → 新任务会把别的任务抓过的文章当成"已处理"而跳过；
 * 又因为"未命中粗筛的正文丢弃"，新任务连本地复筛都不可能。所以：
 *
 * - 抓取目标 = 该任务**自己**还没处理过的区间内文章（不看他人的账本）；
 * - 命中 → 正文落成该任务的 `sources`（kind='url'）+ 账本记 `fetched`；
 * - 未命中 → 正文丢弃，账本记 `dropped`（只留 `body_hash` + 字数）；
 * - 同一任务内可**续跑**（只处理账本里没有的条目），任务删除时账本随外键级联清理。
 *
 * 站点级旧列（`web_site_articles.fetch_state` 等）只保留为**最近一次抓取的诊断痕迹**，不再作为跳过依据。
 */
import Database from 'better-sqlite3'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'
import { putCachedBody, putCacheMiss } from './article-body-cache'

export interface TaskFetchTarget {
  url: string
  title: string
  siteId: string
  siteTitle: string
  publishedDate?: string
  dateSource?: string
  dateConfidence?: string
}

/**
 * 列出**区间内的全部文章**（按发布时间倒序）——**不看任何账本**。
 *
 * 2026-10-05（用户裁定 A）：账本**不再作为跳过依据**。用户实测 21,341 篇的区间每换任务都要重抓 52 分钟，
 * 而"跳过已记账"会让调过阈值后的旧任务**永远不会重筛**。现在每次生成都对区间全量重筛，
 * **是否联网由 `article-body-cache`（正文缓存）决定**——缓存命中即本地重筛，零网络。
 * 账本（`task_web_fetch`）降级为**诊断与计数**用途，仍按任务分别记录。
 */
export function listRangeArticles(fromYear: number, toYear: number): TaskFetchTarget[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT a.url, a.title, a.site_id, s.title AS site_title, a.published_date, a.date_source, a.date_confidence
       FROM web_site_articles a
       JOIN web_sites s ON s.id = a.site_id
       WHERE a.published_date IS NOT NULL
         AND CAST(substr(a.published_date, 1, 4) AS INTEGER) BETWEEN ? AND ?
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

/**
 * 「建立缓存」用：区间内**还没有缓存行**的文章（Phase 11 C，2026-10-06）。
 *
 * 为什么单独一条查询（而不是"取全区间再靠缓存命中跳过"）：
 * ① 建立缓存时 `total` 必须是**真正要干活的篇数**（真实库 2005–2025 是 50,825，而不是目录的 61,701），
 *    否则进度条与 ETA 会被 1 万多篇"命中即跳过"的篇冲淡；
 * ② 已经写过 `no-body` / `blocked` 标记的篇**也不该再进队列**——它们已经"试过了"，
 *    这正是 Phase 11 决策 3A 的要点（否则闸门永远差这几篇）。
 */
export function listUncachedRangeArticles(fromYear: number, toYear: number): TaskFetchTarget[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT a.url, a.title, a.site_id, s.title AS site_title, a.published_date, a.date_source, a.date_confidence
       FROM web_site_articles a
       JOIN web_sites s ON s.id = a.site_id
       WHERE a.published_date IS NOT NULL
         AND CAST(substr(a.published_date, 1, 4) AS INTEGER) BETWEEN ? AND ?
         AND NOT EXISTS (
           SELECT 1 FROM web_article_body b WHERE b.site_id = a.site_id AND b.url = a.url
         )
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

/** 该任务在区间内的进度（用于进度显示与"这次要不要抓"的判断） */
export function countTaskFetch(taskId: string, fromYear: number, toYear: number): { total: number; processed: number; failed: number } {
  const db = getDb()
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM web_site_articles
         WHERE published_date IS NOT NULL AND CAST(substr(published_date, 1, 4) AS INTEGER) BETWEEN ? AND ?`
      )
      .get(fromYear, toYear) as { c: number }
  ).c
  const rows = db
    .prepare(
      `SELECT f.state, COUNT(*) c FROM task_web_fetch f
       JOIN web_site_articles a ON a.site_id = f.site_id AND a.url = f.url
       WHERE f.task_id = ? AND a.published_date IS NOT NULL
         AND CAST(substr(a.published_date,1,4) AS INTEGER) BETWEEN ? AND ?
       GROUP BY f.state`
    )
    .all(taskId, fromYear, toYear) as { state: string; c: number }[]
  const byState = new Map(rows.map((r) => [r.state, r.c]))
  return { total, processed: (byState.get('fetched') ?? 0) + (byState.get('dropped') ?? 0), failed: byState.get('failed') ?? 0 }
}

/*
 * 2026-10-05 删除了 `clearTaskFetchFailed`：它原本用来让"抓取失败"的篇能被重试，前提是账本会跳过已记账的条目。
 * 现在每次生成都对区间**全量重筛**（用户裁定 A），失败篇天然会在下一次被重试，这个函数就没有存在意义了。
 */

/** 写入/更新该任务对某篇文章的处理结果 */
export function recordTaskFetch(
  taskId: string,
  siteId: string,
  url: string,
  patch: {
    state: 'fetched' | 'dropped' | 'failed'
    hit?: boolean
    bestScore?: number
    bodyHash?: string
    bodyChars?: number
    publishedDate?: string
  }
): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO task_web_fetch (task_id, site_id, url, state, hit, best_score, body_hash, body_chars, published_date, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id, site_id, url) DO UPDATE SET
       state = excluded.state, hit = excluded.hit, best_score = excluded.best_score,
       body_hash = excluded.body_hash, body_chars = excluded.body_chars,
       published_date = excluded.published_date, fetched_at = excluded.fetched_at`
  ).run(
    taskId,
    siteId,
    url,
    patch.state,
    patch.hit == null ? null : patch.hit ? 1 : 0,
    patch.bestScore ?? null,
    patch.bodyHash ?? null,
    patch.bodyChars ?? null,
    patch.publishedDate ?? null,
    new Date().toISOString()
  )
}

/*
 * 2026-10-05 P6 已删除 `resetTaskFetch`（清该任务在区间内的抓取账本）。
 * 原因：唯一调用方是手动抓取入口的「重置抓取状态」（用户裁定 A 一并删除）。
 * 账本本身仍按任务级工作（新任务默认重抓重筛）；若日后要恢复"同任务原地重抓"，
 * 从 git 历史取回该函数即可（实现很简单：按 task_id + 区间 DELETE `task_web_fetch` 行）。
 */

/** 该任务已抓取（命中并落库）的 URL 集合——生成管线据此把来源并入 scope */
export function listTaskFetchedUrls(taskId: string): string[] {
  const db = getDb()
  return (
    db.prepare("SELECT url FROM task_web_fetch WHERE task_id = ? AND state = 'fetched'").all(taskId) as { url: string }[]
  ).map((r) => r.url)
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

  describe('task-web-fetch（Phase 10 P5 任务级账本 + 2026-10-05 全量重筛）', () => {
    it('抓取目标 = 区间内**全部**文章（账本不再作为跳过依据，用户裁定 2026-10-05 A）', () => {
      db.prepare("INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t1','任务一','{\"all\":true}'), ('t2','任务二','{\"all\":true}')").run()
      db.prepare("INSERT INTO web_sites (id, root_url, title, created_at, updated_at) VALUES ('s1','https://x.gov.cn','X站','2026-01-01','2026-01-01')").run()
      const ins = db.prepare(
        'INSERT INTO web_site_articles (site_id, url, title, discovered_at, published_date, date_source, date_confidence) VALUES (?,?,?,?,?,?,?)'
      )
      ins.run('s1', 'https://x.gov.cn/2020/a.htm', '甲文', '2026-01-01', '2020-05-01', 'url', 'high')
      ins.run('s1', 'https://x.gov.cn/2021/b.htm', '乙文', '2026-01-01', '2021-06-01', 'url', 'high')

      expect(listRangeArticles(2020, 2021).map((t) => t.url)).toHaveLength(2)
      // 记过账之后（哪怕这篇属于别的任务）→ 目标**依然是全部 2 篇**：每次生成都全量重筛
      recordTaskFetch('t1', 's1', 'https://x.gov.cn/2020/a.htm', { state: 'fetched', hit: true, bestScore: 25 })
      recordTaskFetch('t1', 's1', 'https://x.gov.cn/2021/b.htm', { state: 'dropped', hit: false, bestScore: 0 })
      expect(listRangeArticles(2020, 2021)).toHaveLength(2)

      // 账本仍按任务分开记（诊断与计数用）
      expect(countTaskFetch('t1', 2020, 2021)).toEqual({ total: 2, processed: 2, failed: 0 })
      expect(countTaskFetch('t2', 2020, 2021)).toEqual({ total: 2, processed: 0, failed: 0 })
      expect(listTaskFetchedUrls('t1')).toEqual(['https://x.gov.cn/2020/a.htm'])
      expect(listTaskFetchedUrls('t2')).toEqual([])
      // 区间之外的不进目标
      expect(listRangeArticles(2022, 2023)).toHaveLength(0)
    })

    it('cascades the ledger on task deletion', () => {
      db.prepare("INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t3','任务三','{\"all\":true}')").run()
      recordTaskFetch('t3', 's1', 'https://x.gov.cn/2020/a.htm', { state: 'dropped', hit: false })
      expect(countTaskFetch('t3', 2020, 2021).processed).toBe(1)
      // 删任务 → 账本级联清理
      db.prepare("DELETE FROM writing_tasks WHERE id = 't1'").run()
      expect(
        (db.prepare("SELECT COUNT(*) c FROM task_web_fetch WHERE task_id = 't1'").get() as { c: number }).c
      ).toBe(0)
    })

    it('建立缓存的目标 = 区间内**还没有缓存行**的文章（三态标记也算"有"）', () => {
      // 前置：上一用例已在 2020/2021 各插了一篇，且都还没有缓存行
      expect(listUncachedRangeArticles(2020, 2021)).toHaveLength(2)

      // ① 抓到正文 → 写 ok → 不再进建立队列
      putCachedBody('s1', 'https://x.gov.cn/2020/a.htm', '某中学新建项目开工。', 'h-a')
      expect(listUncachedRangeArticles(2020, 2021).map((t) => t.url)).toEqual(['https://x.gov.cn/2021/b.htm'])

      // ② "试过但没正文"的标记行**也算已建立**（否则闸门永远差这几篇 —— Phase 11 决策 3A 的要点）
      putCacheMiss('s1', 'https://x.gov.cn/2021/b.htm', 'no-body')
      expect(listUncachedRangeArticles(2020, 2021)).toHaveLength(0)
      // 但 `listRangeArticles`（生成期全量重筛）**不受缓存影响**，仍然是 2 篇
      expect(listRangeArticles(2020, 2021)).toHaveLength(2)
    })
  })
}
