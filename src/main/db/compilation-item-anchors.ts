import Database from 'better-sqlite3'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

/**
 * Phase 9 / S3：卡片的**来源锚点**（Migration 044）——"这张卡取自哪几块"。
 *
 * 与 S2 的 `source_blocks` 相乘即页码：卡片 → 块号 → 页。全程不做文本匹配，
 * 因此**卡片被大模型改写后仍能定位**（这正是用户否掉"全文检索"路线的原因）。
 *
 * `confidence` 的两种取值（由生成期本地校验给出，见 `../parse/anchors.ts`）：
 *  - `exact`：该卡的证据引文确实落在所引块内 → 位置可信；
 *  - `weak`：仅块号合法、引文落不进块内（可能是改写版）→ 界面如实显示"位置存疑"。
 */

export type AnchorConfidence = 'exact' | 'weak'

export interface ItemAnchorInput {
  sourceId: string
  blockIndex: number
  confidence: AnchorConfidence
}

export interface ItemAnchorWithPage extends ItemAnchorInput {
  /** 由 source_blocks 解析出的页码；该来源无页概念（Word/WPS/网页）或页表未生成时为 null */
  page: number | null
}

/** 覆盖写入某段的锚点（事务内先删后插：关系行必须与本次生成结果一致） */
export function replaceItemAnchors(
  db: Database.Database,
  itemId: string,
  anchors: ItemAnchorInput[],
  at: string = new Date().toISOString()
): number {
  const del = db.prepare('DELETE FROM compilation_item_anchors WHERE item_id = ?')
  const ins = db.prepare(
    `INSERT OR REPLACE INTO compilation_item_anchors (item_id, source_id, block_index, confidence, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  const seen = new Set<string>()
  const run = db.transaction(() => {
    del.run(itemId)
    let n = 0
    for (const a of anchors) {
      const key = `${a.sourceId}#${a.blockIndex}`
      if (seen.has(key)) continue // 同一段同一块只记一次（模型可能重复回报）
      seen.add(key)
      ins.run(itemId, a.sourceId, a.blockIndex, a.confidence, at)
      n++
    }
    return n
  })
  return run() as number
}

/** 某段的锚点（带页码）；没有锚点返回空数组（老汇编即如此） */
export function listItemAnchorsWithPage(itemId: string, db: Database.Database = getDb()): ItemAnchorWithPage[] {
  return db
    .prepare(
      `SELECT a.source_id, a.block_index, a.confidence, b.page
       FROM compilation_item_anchors a
       LEFT JOIN source_blocks b ON b.source_id = a.source_id AND b.block_index = a.block_index
       WHERE a.item_id = ?
       ORDER BY a.source_id ASC, a.block_index ASC`
    )
    .all(itemId)
    .map((r) => {
      const row = r as { source_id: string; block_index: number; confidence: AnchorConfidence; page: number | null }
      return { sourceId: row.source_id, blockIndex: row.block_index, confidence: row.confidence, page: row.page }
    })
}

/**
 * 一次取多段的锚点（查看器渲染整篇时用，避免 N 次查询）。
 * 返回 `itemId → 锚点数组`，没有锚点的段不出现在 Map 里。
 */
export function listAnchorsForItems(itemIds: string[], db: Database.Database = getDb()): Map<string, ItemAnchorWithPage[]> {
  const out = new Map<string, ItemAnchorWithPage[]>()
  if (itemIds.length === 0) return out
  const chunkSize = 400 // 避开 SQLite 变量上限
  for (let i = 0; i < itemIds.length; i += chunkSize) {
    const slice = itemIds.slice(i, i + chunkSize)
    const placeholders = slice.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT a.item_id, a.source_id, a.block_index, a.confidence, b.page
         FROM compilation_item_anchors a
         LEFT JOIN source_blocks b ON b.source_id = a.source_id AND b.block_index = a.block_index
         WHERE a.item_id IN (${placeholders})
         ORDER BY a.item_id ASC, a.source_id ASC, a.block_index ASC`
      )
      .all(...slice)
    for (const r of rows) {
      const row = r as { item_id: string; source_id: string; block_index: number; confidence: AnchorConfidence; page: number | null }
      const list = out.get(row.item_id) ?? []
      list.push({ sourceId: row.source_id, blockIndex: row.block_index, confidence: row.confidence, page: row.page })
      out.set(row.item_id, list)
    }
  }
  return out
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
    db.prepare("INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t1','任务','{\"all\":true}')").run()
    db.prepare(
      "INSERT INTO compilations (id, task_id, title, status, created_at, updated_at) VALUES ('c1','t1','汇编','drafting','2026-10-03','2026-10-03')"
    ).run()
    db.prepare(
      "INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s1','file','年鉴','甲乙丙丁戊己庚辛壬癸','ready')"
    ).run()
    db.prepare(
      "INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s2','file','Word','甲乙丙','ready')"
    ).run()
    db.prepare(
      "INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, created_at) VALUES ('i1','c1',1,'s1','甲段','2026-10-03')"
    ).run()
    db.prepare(
      "INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, created_at) VALUES ('i2','c1',2,'s1','乙段','2026-10-03')"
    ).run()
    // s1 有块表（1、2 块分别属于第 3、4 页）；s2 没有块表（模拟"未生成页表"）
    const ins = db.prepare(
      "INSERT INTO source_blocks (source_id, block_index, char_start, char_end, page, label, created_at) VALUES (?,?,?,?,?,NULL,'2026-10-03')"
    )
    ins.run('s1', 0, 0, 5, 3)
    ins.run('s1', 1, 5, 10, 4)
  })
  afterAll(() => db.close())

  describe('compilation item anchors (Phase 9 / S3)', () => {
    it('写入后可解析出页码（块号 → 页）', () => {
      expect(replaceItemAnchors(db, 'i1', [{ sourceId: 's1', blockIndex: 0, confidence: 'exact' }])).toBe(1)
      const list = listItemAnchorsWithPage('i1', db)
      expect(list).toHaveLength(1)
      expect(list[0]).toEqual({ sourceId: 's1', blockIndex: 0, confidence: 'exact', page: 3 })
    })

    it('重复块号只记一次；覆盖写入保证与本次生成结果一致', () => {
      replaceItemAnchors(
        db,
        'i2',
        [
          { sourceId: 's1', blockIndex: 1, confidence: 'weak' },
          { sourceId: 's1', blockIndex: 1, confidence: 'exact' }
        ]
      )
      expect(listItemAnchorsWithPage('i2', db)).toHaveLength(1)
      replaceItemAnchors(db, 'i2', [{ sourceId: 's1', blockIndex: 0, confidence: 'exact' }])
      const after = listItemAnchorsWithPage('i2', db)
      expect(after.map((a) => a.blockIndex)).toEqual([0]) // 旧锚点被清掉，不是累加
    })

    it('没有块表的来源：锚点在，但页码为 null（界面按"未记录位置"处理）', () => {
      replaceItemAnchors(db, 'i1', [{ sourceId: 's2', blockIndex: 0, confidence: 'weak' }])
      const list = listItemAnchorsWithPage('i1', db)
      const s2 = list.find((a) => a.sourceId === 's2')
      expect(s2?.page).toBeNull()
    })

    it('批量查询按段归组', () => {
      const map = listAnchorsForItems(['i1', 'i2'], db)
      expect(map.get('i1')?.length).toBeGreaterThan(0)
      expect(map.get('i2')?.length).toBe(1)
      expect(map.has('不存在')).toBe(false)
    })
  })
}
