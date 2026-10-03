import Database from 'better-sqlite3'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'
import { splitIntoBlocks, assignPages, alignPageTexts, type BlockRange } from '../parse/page-map'

/**
 * Phase 9 / S2：来源「块表」——把来源正文切块并记下每块属于第几页（Migration 043）。
 *
 * 用途：S3 让大模型在生成资料汇编时回报"这张卡取自哪几块"（块号），本表把块号翻译成页码，
 * 于是"点来源 → 跳到第 P 页"**全程不需要任何文本匹配**（卡片被改写也不影响）。
 *
 * 生成策略按用户裁定 Q6：**懒生成 + 缓存**——第一次需要定位某来源时才解析并落库，
 * 不做存量全量回填。解析不出页表时如实返回原因，**绝不猜页码**。
 */

export interface SourceBlock {
  blockIndex: number
  charStart: number
  charEnd: number
  page: number | null
  label: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 覆盖写入某来源的块表（事务内先删后插，保证"块号 → 页"是一份完整口径） */
export function replaceSourceBlocks(
  db: Database.Database,
  sourceId: string,
  blocks: BlockRange[],
  at: string = nowIso()
): number {
  const del = db.prepare('DELETE FROM source_blocks WHERE source_id = ?')
  const ins = db.prepare(
    `INSERT INTO source_blocks (source_id, block_index, char_start, char_end, page, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const run = db.transaction(() => {
    del.run(sourceId)
    for (const b of blocks) ins.run(sourceId, b.blockIndex, b.start, b.end, b.page, null, at)
  })
  run()
  return blocks.length
}

export function listSourceBlocks(sourceId: string, db: Database.Database = getDb()): SourceBlock[] {
  return db
    .prepare(
      `SELECT block_index, char_start, char_end, page, label FROM source_blocks
       WHERE source_id = ? ORDER BY block_index ASC`
    )
    .all(sourceId)
    .map((r) => {
      const row = r as { block_index: number; char_start: number; char_end: number; page: number | null; label: string | null }
      return { blockIndex: row.block_index, charStart: row.char_start, charEnd: row.char_end, page: row.page, label: row.label }
    })
}

/** 只要"块号 → 页码"的映射（S4 定位时用；无页表的来源返回空 Map） */
export function blockPageMap(sourceId: string, db: Database.Database = getDb()): Map<number, number> {
  const map = new Map<number, number>()
  for (const b of listSourceBlocks(sourceId, db)) if (b.page != null) map.set(b.blockIndex, b.page)
  return map
}

export type EnsureBlocksResult =
  | { ok: true; blocks: SourceBlock[]; cached: boolean; pageCount: number | null }
  | { ok: false; reason: string }

/**
 * 懒生成块表：已有则直接用；没有就按当前正文生成并落库。
 * `getPageTexts` 由调用方注入（PDF → 逐页文字；其它格式 → 返回 null 表示"无页概念"），
 * 这样本函数不依赖具体解析器，也便于单测。
 */
export async function ensureSourceBlocks(
  sourceId: string,
  getPageTexts: (sourceId: string, text: string) => Promise<string[] | null>,
  db: Database.Database = getDb()
): Promise<EnsureBlocksResult> {
  const cachedRows = listSourceBlocks(sourceId, db)
  if (cachedRows.length > 0) {
    const pages = cachedRows.map((b) => b.page).filter((p): p is number => p != null)
    return { ok: true, blocks: cachedRows, cached: true, pageCount: pages.length > 0 ? Math.max(...pages) : null }
  }

  const row = db.prepare('SELECT cleaned_text FROM sources WHERE id = ?').get(sourceId) as
    | { cleaned_text: string | null }
    | undefined
  if (!row) return { ok: false, reason: '来源不存在' }
  const text = row.cleaned_text ?? ''
  if (!text.trim()) return { ok: false, reason: '该来源没有可切块的正文' }

  let pageTexts: string[] | null = null
  try {
    pageTexts = await getPageTexts(sourceId, text)
  } catch {
    // 解析失败不抛出：退化为"无页码的块表"，定位到块/段仍可用
    pageTexts = null
  }

  let blocks = splitIntoBlocks(text, 500)
  let pageCount: number | null = null
  if (pageTexts && pageTexts.length > 0) {
    const ranges = alignPageTexts(text, pageTexts)
    if (ranges) {
      blocks = assignPages(blocks, ranges)
      pageCount = pageTexts.length
      // 不变量复核：已经拿到页区间，就不该有块落不到任何页（否则说明页区间有洞）
      if (blocks.some((b) => b.page == null)) return { ok: false, reason: '块表生成异常：有块没有落到任何页' }
    }
    // ranges === null：逐页文字与正文对不上 → **不写页码**（blocks 保持 page=null），如实降级
  }

  replaceSourceBlocks(db, sourceId, blocks)
  return { ok: true, blocks: listSourceBlocks(sourceId, db), cached: false, pageCount }
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
      "INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s1','file','年鉴','第一页正文。第二页正文。','ready')"
    ).run()
  })
  afterAll(() => db.close())

  describe('source blocks (Phase 9 / S2)', () => {
    it('懒生成：先落块表，第二次直接命中缓存', async () => {
      const pages = ['第一页正文。', '第二页正文。']
      const first = await ensureSourceBlocks('s1', async () => pages, db)
      expect(first.ok).toBe(true)
      if (first.ok) {
        expect(first.cached).toBe(false)
        expect(first.blocks.length).toBeGreaterThan(0)
        // 每块都有页码，且页码只可能是 1 或 2（块不跨页）
        expect(first.blocks.every((b) => b.page === 1 || b.page === 2)).toBe(true)
      }
      const second = await ensureSourceBlocks('s1', async () => pages, db)
      expect(second.ok && second.cached).toBe(true)
    })

    it('逐页文字对不上时退化为"无页码块表"，不猜页码', async () => {
      db.prepare("INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s2','file','核对','甲甲甲。乙乙乙。','ready')").run()
      const res = await ensureSourceBlocks('s2', async () => ['完全对不上的一页'], db)
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.blocks.length).toBeGreaterThan(0)
        expect(res.blocks.every((b) => b.page == null)).toBe(true)
        expect(res.pageCount).toBeNull()
      }
    })

    it('无页概念（返回 null）也照样出块表，页码全空', async () => {
      db.prepare("INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s3','file','Word','一二三四五六七八九十。','ready')").run()
      const res = await ensureSourceBlocks('s3', async () => null, db)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.blocks.every((b) => b.page == null)).toBe(true)
    })

    it('块表覆盖全文且首尾相接（同一来源内）', async () => {
      const rows = listSourceBlocks('s1', db)
      expect(rows[0].charStart).toBe(0)
      for (let i = 1; i < rows.length; i++) expect(rows[i].charStart).toBe(rows[i - 1].charEnd)
    })

    it('blockPageMap 只给有页码的块', async () => {
      expect(blockPageMap('s1', db).size).toBeGreaterThan(0)
      expect(blockPageMap('s3', db).size).toBe(0)
    })
  })
}
