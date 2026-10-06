/**
 * article-body-cache.ts —— **网页正文缓存**（站点级、跨任务复用；Migration 049，2026-10-05）。
 *
 * 为什么需要它（用户实测 2026-10-05）：区间 2021–2025 有 **21,341 篇**，而"每换一个任务都要重新联网抓一遍"
 * 的代价是 **52 分钟**（实测 6.83 篇/秒；2005–2025 区间要 150 分钟）。正文内容与主题无关，
 * **不该因为换了任务、换了筛选口径就重新下载**。
 *
 * 与 `task_web_fetch`（任务级账本）的分工：
 *   - 账本管"**这个任务**筛过哪些、结果如何"（诊断与计数）；
 *   - 本缓存管"**正文有没有**"——抓取前命中即**本地重筛**（毫秒级、零网络），抓取后一律写入。
 *
 * 用户裁定（2026-10-05）：账本**不再作为跳过依据**（每次生成都对本区间全量重筛），
 * 于是"是否联网"完全由本缓存决定。正文用 `deflateRaw` 压缩存储（平均 1,325 字/篇 ≈ 压缩后 1.3–1.8KB）。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

export interface BodyCacheEntry {
  /** 已解压的正文纯文本 */
  text: string
  bodyHash: string
  bodyChars: number
  /**
   * 抓取当时 **A1 标题探针**是否通过（1 = 通过）。
   * 为什么把它缓存下来：探针需要**原始 HTML**（要在 `<title>` 里找候选标题），而本缓存只存提取后的正文；
   * 若在缓存命中时重跑探针，会把"标题只出现在 `<title>`、正文里没重复标题"的**正常文章误杀**。
   * 探针判定与主题无关（只看这一页像不像那篇文章），所以缓存它的结论是安全且准确的。
   * `shortBody` / `templateRepeat` 与主题无关但**与其它页面有关**（正文长度、同站是否有相同正文），
   * 因此在缓存命中时仍按当前文本重新判定（成本可忽略）。
   */
  probeOk: boolean
  /** 正文来源（`extractor` = 结构化提取成功；`full-page` = 退回整页文本）—— 缓存命中时如实沿用首次抓取的结论 */
  textSource: string
  /** 这一篇的"尝试结论"（Migration 050）：见 {@link BodyCacheState} */
  state: BodyCacheState
}

/**
 * 一篇网页的**缓存尝试结论**（Migration 050，2026-10-06 用户裁定「决策 3A」）：
 *   - `ok`      = 正文可用；
 *   - `no-body` = **已尝试过**但没取到可用正文（老文章失效 / 站点返回通用模板页 / 过短）——
 *                 它**不是"待建立"**，否则生成前闸门会永远差这几篇、永远不放行；
 *   - `blocked` = URL 不在该站点的 http(s) 同域白名单内（见 `web-source/article-guards.ts`）——
 *                 **永不可建**，但仍要如实计数（否则"总篇数 ≠ 可建立篇数"无法向用户解释）。
 */
export type BodyCacheState = 'ok' | 'no-body' | 'blocked'

/** 压缩正文（失败则退化为不压缩的原始 UTF-8，保证"写缓存失败"不会阻断抓取） */
function compress(text: string): Buffer {
  const raw = Buffer.from(text, 'utf8')
  try {
    return deflateRawSync(raw)
  } catch {
    return raw
  }
}

/** 解压正文；解压失败时按原始 UTF-8 处理（兼容"当时没能压缩"的极端情况） */
function decompress(buf: Buffer): string {
  try {
    return inflateRawSync(buf).toString('utf8')
  } catch {
    return buf.toString('utf8')
  }
}

/** 读一条缓存（命中即返回正文，不联网）。**不写库**（避免上万次命中的 last_used_at 更新把 WAL 打满）。 */
export function getCachedBody(siteId: string, url: string): BodyCacheEntry | null {
  const db = getDb()
  const row = db
    .prepare('SELECT body_z, body_hash, body_chars, probe_ok, text_source, state FROM web_article_body WHERE site_id = ? AND url = ?')
    .get(siteId, url) as
    | { body_z: Buffer; body_hash: string; body_chars: number; probe_ok: number; text_source: string; state: string }
    | undefined
  if (!row) return null
  return {
    text: decompress(row.body_z),
    bodyHash: row.body_hash,
    bodyChars: row.body_chars,
    probeOk: row.probe_ok === 1,
    textSource: row.text_source,
    state: (row.state as BodyCacheState) ?? 'ok'
  }
}

/** 写入/更新缓存（抓取后**一律**写，命中与否都写——"未命中"只对当前主题成立） */
export function putCachedBody(
  siteId: string,
  url: string,
  text: string,
  bodyHash: string,
  probeOk = true,
  textSource = 'extractor',
  state: BodyCacheState = 'ok'
): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO web_article_body (site_id, url, body_z, body_hash, body_chars, probe_ok, text_source, state, fetched_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, url) DO UPDATE SET
         body_z = excluded.body_z, body_hash = excluded.body_hash, body_chars = excluded.body_chars,
         probe_ok = excluded.probe_ok, text_source = excluded.text_source, state = excluded.state,
         fetched_at = excluded.fetched_at, last_used_at = excluded.last_used_at`
    )
    .run(siteId, url, compress(text), bodyHash, text.length, probeOk ? 1 : 0, textSource, state, now, now)
}

/**
 * 记下"这一篇试过了、但没有可用正文"（`no-body`）或"这一篇永远不能抓"（`blocked`）。
 *
 * **必须存在的理由**（2026-10-06）：生成前的缓存闸门按"有没有缓存行"判断缺口。若"尝试失败"不留痕迹，
 * 那些失效链接/模板页会被**永远**算作待建立 → 闸门永远不放行（用户裁定：严格阻断，没有逃生门）。
 *
 * ⚠ 两个刻意的设计：
 * ① `ON CONFLICT DO NOTHING` —— **绝不覆盖已有行**。一篇曾经抓到过正文的文章，即使后来抓取失败
 *    （站点临时抽风、超时），也不能把已经白抓一次的正文**抹掉**（那等于让缓存自己退化）；
 * ② 标记行**不写正文**（空 `body_z`、`body_chars = 0`），因此它**不会**被当成可用正文喂给筛选。
 */
export function putCacheMiss(siteId: string, url: string, state: Exclude<BodyCacheState, 'ok'>): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO web_article_body (site_id, url, body_z, body_hash, body_chars, probe_ok, text_source, state, fetched_at, last_used_at)
       VALUES (?, ?, ?, '', 0, 0, 'none', ?, ?, ?)
       ON CONFLICT(site_id, url) DO NOTHING`
    )
    .run(siteId, url, Buffer.alloc(0), state, now, now)
}

/** 缓存占用统计（资料库面板显示"缓存了多少篇 / 占多少 MB"；`byState` = Migration 050 的三态计数） */
export function bodyCacheStats(): { entries: number; bytes: number; byState: Record<BodyCacheState, number> } {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(length(body_z)), 0) b FROM web_article_body').get() as {
    c: number
    b: number
  }
  const states = db.prepare('SELECT state, COUNT(*) c FROM web_article_body GROUP BY state').all() as {
    state: string
    c: number
  }[]
  const count = (s: BodyCacheState): number => states.find((r) => r.state === s)?.c ?? 0
  return {
    entries: row.c,
    bytes: row.b,
    byState: { ok: count('ok'), 'no-body': count('no-body'), blocked: count('blocked') }
  }
}

/** 清空全部正文缓存（返回清掉的条数）。**只删缓存，不动 sources / 目录 / 账本。** */
export function clearBodyCache(): number {
  return getDb().prepare('DELETE FROM web_article_body').run().changes
}

/**
 * 2026-10-06（Phase 11 F，用户需求 ④「资料删除后对应缓存/索引同步删除」）：**清扫孤儿缓存**——
 * 删掉那些"目录（`web_site_articles`）里已经没有对应条目"的缓存行。
 *
 * 正常情况下应该是 **0 条**：Migration 051 的触发器保证"删目录行 → 缓存跟着删"，站点级联覆盖另一路。
 * 但仍然值得定期扫一遍，因为**历史数据**（051 之前的库）与"URL 规范化后目录行换了地址"这类情况
 * 都可能留下孤儿——它们白占磁盘，而且**谁也看不见**（既不在待建立里、也不在已建立里）。
 *
 * 只删缓存行：**不动目录、不动 sources、不动索引、不动任务账本**。返回清掉的条数，由调用方如实记日志。
 */
export function sweepOrphanBodyCaches(): number {
  return getDb()
    .prepare(
      `DELETE FROM web_article_body
        WHERE NOT EXISTS (
          SELECT 1 FROM web_site_articles a
           WHERE a.site_id = web_article_body.site_id AND a.url = web_article_body.url
        )`
    )
    .run().changes
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
    db.prepare("INSERT INTO web_sites (id, root_url, title, created_at, updated_at) VALUES ('s1','https://x.gov.cn','X站','2026-01-01','2026-01-01')").run()
  })
  afterAll(() => db.close())

  describe('article-body-cache（Migration 049 正文缓存）', () => {
    it('写入后可读回（压缩往返不掉字）、统计与清空正常', () => {
      const text = '长乐区某中学新建项目开工。'.repeat(60) // 780 字左右，含中文与标点
      putCachedBody('s1', 'https://x.gov.cn/a.htm', text, 'hash-a')
      const back = getCachedBody('s1', 'https://x.gov.cn/a.htm')
      expect(back?.text).toBe(text)
      expect(back?.bodyHash).toBe('hash-a')
      expect(back?.bodyChars).toBe(text.length)

      const stats = bodyCacheStats()
      expect(stats.entries).toBe(1)
      // 压缩确实生效：存进去的字节数明显小于原文 UTF-8 长度
      expect(stats.bytes).toBeLessThan(Buffer.byteLength(text, 'utf8'))

      // 幂等覆盖
      putCachedBody('s1', 'https://x.gov.cn/a.htm', '短正文', 'hash-b')
      expect(getCachedBody('s1', 'https://x.gov.cn/a.htm')?.text).toBe('短正文')

      // 未命中的 URL 返回 null
      expect(getCachedBody('s1', 'https://x.gov.cn/none.htm')).toBeNull()

      expect(clearBodyCache()).toBe(1)
      expect(bodyCacheStats().entries).toBe(0)
    })

    it('站点删除时缓存级联清理', () => {
      putCachedBody('s1', 'https://x.gov.cn/b.htm', '正文'.repeat(50), 'hash-c')
      expect(bodyCacheStats().entries).toBe(1)
      db.prepare("DELETE FROM web_sites WHERE id = 's1'").run()
      expect(bodyCacheStats().entries).toBe(0)
    })

    it('三态标记（Migration 050）：默认 ok、可记 no-body/blocked、且绝不覆盖已有正文', () => {
      db.prepare("INSERT INTO web_sites (id, root_url, title, created_at, updated_at) VALUES ('s2','https://y.gov.cn','Y站','2026-01-01','2026-01-01')").run()

      // ① 默认态 = ok，且 Migration 050 的列真的存在
      putCachedBody('s2', 'https://y.gov.cn/1.htm', '某中学新建项目开工。', 'h1')
      expect(getCachedBody('s2', 'https://y.gov.cn/1.htm')?.state).toBe('ok')

      // ② 显式记 no-body（老文章失效 / 模板页 / 过短）
      putCachedBody('s2', 'https://y.gov.cn/2.htm', '短', 'h2', true, 'extractor', 'no-body')
      expect(getCachedBody('s2', 'https://y.gov.cn/2.htm')?.state).toBe('no-body')

      // ③ 标记行：没有正文（body_chars = 0），不会被当成可用正文
      putCacheMiss('s2', 'https://y.gov.cn/3.htm', 'no-body')
      const marked = getCachedBody('s2', 'https://y.gov.cn/3.htm')
      expect(marked?.state).toBe('no-body')
      expect(marked?.text).toBe('')
      expect(marked?.bodyChars).toBe(0)

      // ④ 越权地址记 blocked（永不可建，但仍要有行 —— 否则闸门永远差这几篇）
      putCacheMiss('s2', 'https://evil.example.com/x.htm', 'blocked')
      expect(getCachedBody('s2', 'https://evil.example.com/x.htm')?.state).toBe('blocked')

      // ⑤ **关键**：一篇已抓到正文的文章，之后失败也不能被标记抹掉
      putCacheMiss('s2', 'https://y.gov.cn/1.htm', 'no-body')
      expect(getCachedBody('s2', 'https://y.gov.cn/1.htm')?.text).toBe('某中学新建项目开工。')
      expect(getCachedBody('s2', 'https://y.gov.cn/1.htm')?.state).toBe('ok')

      // ⑥ 三态计数
      const stats = bodyCacheStats()
      expect(stats.byState['ok']).toBe(1)
      expect(stats.byState['no-body']).toBe(2)
      expect(stats.byState['blocked']).toBe(1)
      expect(stats.entries).toBe(4)
    })

    /*
     * Phase 11 F（用户需求 ④「资料删除后对应缓存/索引同步删除」）：
     * 两条防线各测一次——**Migration 051 的触发器**（删目录行 → 缓存跟着删）与
     * **孤儿清扫**（历史遗留：目录里根本没有对应条目的缓存行）。
     */
    it('Migration 051：删掉目录行时，它的缓存行必须跟着删（无论谁删、用什么 SQL 删）', () => {
      db.prepare("INSERT INTO web_sites (id, root_url, title, created_at, updated_at) VALUES ('s3','https://z.gov.cn','Z站','2026-01-01','2026-01-01')").run()
      const art = db.prepare(
        'INSERT INTO web_site_articles (site_id, url, title, discovered_at, published_date) VALUES (?,?,?,?,?)'
      )
      art.run('s3', 'https://z.gov.cn/keep.htm', 'K', '2026-01-01', '2020-01-01')
      art.run('s3', 'https://z.gov.cn/gone.htm', 'G', '2026-01-01', '2020-02-01')
      putCachedBody('s3', 'https://z.gov.cn/keep.htm', '保留的正文。', 'hk')
      putCachedBody('s3', 'https://z.gov.cn/gone.htm', '要被删掉的正文。', 'hg')

      db.prepare('DELETE FROM web_site_articles WHERE site_id = ? AND url = ?').run('s3', 'https://z.gov.cn/gone.htm')

      expect(getCachedBody('s3', 'https://z.gov.cn/gone.htm')).toBeNull()
      // **只删这一条**：别的缓存不受影响（触发器按 (site_id,url) 精确匹配）
      expect(getCachedBody('s3', 'https://z.gov.cn/keep.htm')?.text).toBe('保留的正文。')
    })

    it('孤儿缓存清扫：只清掉"目录里没有对应条目"的行，其余一律不动', () => {
      /*
       * ⚠ 用例里的站点归属要小心：`s1` 在前面的用例里**已被删除**（级联测试），
       * 再往 s1 插目录行会违反外键。这里用仍然存在的 s3。
       */
      // ① 正常配对（目录 + 缓存）→ 必须保留
      db.prepare(
        "INSERT INTO web_site_articles (site_id, url, title, discovered_at, published_date) VALUES ('s3','https://z.gov.cn/paired.htm','P','2026-01-01','2021-01-01')"
      ).run()
      putCachedBody('s3', 'https://z.gov.cn/paired.htm', '配对正文。', 'hp')
      // ② 孤儿：缓存有行、目录没有（历史遗留 / URL 规范化换了地址）
      putCachedBody('s3', 'https://z.gov.cn/orphan.htm', '孤儿正文。', 'ho')
      const articlesBefore = (db.prepare('SELECT COUNT(*) c FROM web_site_articles').get() as { c: number }).c
      // ③ 按定义数一遍孤儿（与实现无关的独立口径），清扫结果必须与它一致
      const orphansBefore = (
        db
          .prepare(
            `SELECT COUNT(*) c FROM web_article_body b
              WHERE NOT EXISTS (SELECT 1 FROM web_site_articles a WHERE a.site_id = b.site_id AND a.url = b.url)`
          )
          .get() as { c: number }
      ).c
      expect(orphansBefore).toBeGreaterThanOrEqual(1)

      const swept = sweepOrphanBodyCaches()

      expect(swept).toBe(orphansBefore)
      expect(getCachedBody('s3', 'https://z.gov.cn/orphan.htm')).toBeNull()
      expect(getCachedBody('s3', 'https://z.gov.cn/paired.htm')?.text).toBe('配对正文。')
      // 目录一条都不能少（清扫只针对缓存表）
      expect((db.prepare('SELECT COUNT(*) c FROM web_site_articles').get() as { c: number }).c).toBe(articlesBefore)
      // 再扫一次是幂等的（正常库应为 0 条）
      expect(sweepOrphanBodyCaches()).toBe(0)
    })
  })
}
