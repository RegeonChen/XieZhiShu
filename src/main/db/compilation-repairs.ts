/**
 * compilation-repairs.ts —— 资料卡片「大模型修正」仓储（原“二次加工/语义补全”，Phase 6.4.3 → 2026-09-08 改版）。
 *
 * 语义（2026-09-08 用户需求变更）：
 * - 修正由生成管线在「AI 细读」之后、「卡片矛盾扫描」之前产出，**默认直接应用到卡片**（status='applied'）；
 * - 卡片上以「经过大模型修正」标记承载，用户点标记可查看修正前原文与理由，并可**回退**（status='reverted'，
 *   卡片还原为 original_text）或**再次应用**（回到 revised_text）；
 * - 不再有「待裁定」状态，也不再进入回收站（`compilation_repair_recycle_bin` 已随 Migration 029 删除）。
 *
 * 时间戳（ts）的自动补齐不属于修正记录（用户确认：静默补齐、无标记、不可回退），由生成管线直接写入卡片 ts。
 */
import Database from 'better-sqlite3'
import type { CompilationItem, CompilationRepair, CompilationRepairStatus } from '../../shared/types'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

interface RepairRow {
  id: string
  compilation_id: string
  item_id: string
  original_text: string
  revised_text: string
  reason: string
  status: CompilationRepairStatus
  created_at: string
  updated_at: string
}

interface ItemRow {
  id: string
  compilation_id: string
  position: number
  source_id: string
  excerpt: string
  ts: string | null
  note: string | null
  extra_tags: string
  kept: number
  created_at: string
  source_title: string | null
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function mapRepair(row: RepairRow): CompilationRepair {
  return {
    id: row.id,
    compilationId: row.compilation_id,
    itemId: row.item_id,
    originalText: row.original_text,
    revisedText: row.revised_text,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapItem(row: ItemRow): CompilationItem {
  return {
    id: row.id,
    compilationId: row.compilation_id,
    position: row.position,
    sourceId: row.source_id,
    excerpt: row.excerpt,
    ts: row.ts ?? undefined,
    note: row.note ?? undefined,
    extraTags: parseJsonArray(row.extra_tags),
    kept: row.kept === 1,
    sourceTitle: row.source_title ?? row.source_id,
    createdAt: row.created_at
  }
}

/** 读取卡片（含来源标题） */
function getItemById(itemId: string): CompilationItem | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT ci.*, s.title AS source_title
       FROM compilation_items ci
       LEFT JOIN sources s ON s.id = ci.source_id
       WHERE ci.id = ?`
    )
    .get(itemId) as ItemRow | undefined
  return row ? mapItem(row) : null
}

export function listRepairsByCompilation(compilationId: string): CompilationRepair[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM compilation_repairs WHERE compilation_id = ? ORDER BY created_at DESC')
    .all(compilationId) as RepairRow[]
  return rows.map(mapRepair)
}

export function getRepairById(id: string): CompilationRepair | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM compilation_repairs WHERE id = ?').get(id) as RepairRow | undefined
  return row ? mapRepair(row) : null
}

export interface InsertRepairInput {
  itemId: string
  originalText: string
  revisedText: string
  reason: string
}

/**
 * 写入一条「大模型修正」记录（status='applied'）。
 * 注意：本函数**只写记录、不改卡片**——卡片文本由生成管线在内存阶段改好并落库（见 db/compilations.ts
 * 的 insertCompilationItems：卡片与修正记录在同一事务内按新 itemId 一起写入）。
 */
export function insertRepair(input: InsertRepairInput & { compilationId: string }): CompilationRepair {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO compilation_repairs (id, compilation_id, item_id, original_text, revised_text, reason, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'applied', ?, ?)`
  ).run(id, input.compilationId, input.itemId, input.originalText, input.revisedText, input.reason, now, now)
  return getRepairById(id)!
}

/**
 * 应用 / 回退一条修正（卡片文本与状态在同一事务内切换）：
 * - applied=true（再次应用）：卡片 excerpt ← revised_text，状态 applied；
 * - applied=false（回退到修正前）：卡片 excerpt ← original_text，状态 reverted。
 * 幂等：已是目标状态时也返回当前结果；修正或卡片不存在返回 null。
 */
export function setRepairApplied(
  repairId: string,
  applied: boolean
): { item: CompilationItem; repair: CompilationRepair } | null {
  const db = getDb()
  const repair = getRepairById(repairId)
  if (!repair) return null
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    db.prepare('UPDATE compilation_items SET excerpt = ? WHERE id = ?').run(
      applied ? repair.revisedText : repair.originalText,
      repair.itemId
    )
    db.prepare('UPDATE compilation_repairs SET status = ?, updated_at = ? WHERE id = ?').run(
      applied ? 'applied' : 'reverted',
      now,
      repairId
    )
  })
  tx()
  const updatedRepair = getRepairById(repairId)
  const item = getItemById(repair.itemId)
  if (!updatedRepair || !item) return null
  return { item, repair: updatedRepair }
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

  function seed(): { compilationId: string; itemId: string } {
    const taskId = crypto.randomUUID()
    const sourceId = crypto.randomUUID()
    const compilationId = crypto.randomUUID()
    db.prepare(`INSERT INTO writing_tasks (id, title, scope_json) VALUES (?, '大模型修正测试', '{"all":true}')`).run(taskId)
    db.prepare("INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', '统计表', '正文', 'ready')").run(sourceId)
    db.prepare(`INSERT INTO compilations (id, task_id, title, status, created_at, updated_at) VALUES (?, ?, '汇编', 'drafting', ?, ?)`).run(compilationId, taskId, new Date().toISOString(), new Date().toISOString())
    const itemId = crypto.randomUUID()
    db.prepare(
      `INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, extra_tags, kept, created_at)
       VALUES (?, ?, 0, ?, '原文', '[]', 1, ?)`
    ).run(itemId, compilationId, sourceId, new Date().toISOString())
    return { compilationId, itemId }
  }

  describe('compilation repairs store (2026-09-08 默认应用改版)', () => {
    it('inserts repairs as applied and lists them by compilation', () => {
      const { compilationId, itemId } = seed()
      const r = insertRepair({ compilationId, itemId, originalText: '原文', revisedText: '修正文本', reason: '表意不明' })
      expect(r.status).toBe('applied')
      const list = listRepairsByCompilation(compilationId)
      expect(list).toHaveLength(1)
      expect(list[0].revisedText).toBe('修正文本')
    })

    it('reverts a repair: item excerpt back to original, status reverted', () => {
      const { compilationId, itemId } = seed()
      // 管线落库时卡片文本已是修正后文本
      db.prepare('UPDATE compilation_items SET excerpt = ? WHERE id = ?').run('修正文本', itemId)
      const r = insertRepair({ compilationId, itemId, originalText: '原文', revisedText: '修正文本', reason: '表意不明' })
      const res = setRepairApplied(r.id, false)!
      expect(res.repair.status).toBe('reverted')
      expect(res.item.excerpt).toBe('原文')
      expect(getItemById(itemId)!.excerpt).toBe('原文')
    })

    it('re-applies a reverted repair', () => {
      const { compilationId, itemId } = seed()
      const r = insertRepair({ compilationId, itemId, originalText: '原文', revisedText: '修正文本', reason: '表意不明' })
      setRepairApplied(r.id, false)
      const res = setRepairApplied(r.id, true)!
      expect(res.repair.status).toBe('applied')
      expect(res.item.excerpt).toBe('修正文本')
    })

    it('returns null for unknown repair id', () => {
      expect(setRepairApplied('not-exist', false)).toBeNull()
    })

    it('cascades repairs when the card is deleted', () => {
      const { compilationId, itemId } = seed()
      insertRepair({ compilationId, itemId, originalText: '原文', revisedText: '修正文本', reason: '表意不明' })
      db.prepare('DELETE FROM compilation_items WHERE id = ?').run(itemId)
      expect(listRepairsByCompilation(compilationId)).toHaveLength(0)
    })
  })
}
