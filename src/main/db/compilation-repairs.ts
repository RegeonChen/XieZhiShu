/**
 * compilation-repairs.ts —— 资料卡片二次加工（语义补全/修订）仓储（Phase 6.4.3，2026-08-25）。
 * 三步：① AI 扫描表意不明的卡片并生成 pending 修订（compilation_repairs）；
 *       ② 用户采纳/拒绝（decideRepair：采纳改写 item.excerpt + 状态 accepted；拒绝仅状态 rejected）；
 *       ③ 采纳/拒绝快照进 compilation_repair_recycle_bin 供恢复（restore 回退 pending + 恢复原文）。
 * 无 Provider / AI 失败时不阻断（additive），不修改卡片文本。
 */
import Database from 'better-sqlite3'
import type {
  CompilationItem,
  CompilationRepair,
  CompilationRepairStatus,
  CompilationRecycleBinRepair
} from '../../shared/types'
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

export function insertRepair(input: InsertRepairInput & { compilationId: string }): CompilationRepair {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO compilation_repairs (id, compilation_id, item_id, original_text, revised_text, reason, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, input.compilationId, input.itemId, input.originalText, input.revisedText, input.reason, now, now)
  return getRepairById(id)!
}

/** 批量写入候选修订（事务）；返回写入后的修订列表 */
export function insertRepairs(compilationId: string, items: InsertRepairInput[]): CompilationRepair[] {
  const db = getDb()
  if (items.length === 0) return []
  const now = new Date().toISOString()
  const ins = db.prepare(
    `INSERT INTO compilation_repairs (id, compilation_id, item_id, original_text, revised_text, reason, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  )
  const tx = db.transaction(() => {
    for (const it of items) {
      ins.run(crypto.randomUUID(), compilationId, it.itemId, it.originalText, it.revisedText, it.reason, now, now)
    }
  })
  tx()
  return listRepairsByCompilation(compilationId)
}

/**
 * 用户对某条修订做取舍：
 * - accept：卡片 excerpt 改写为 revised_text；修订状态 accepted；快照进回收站（chosen='accepted'）。
 * - reject：修订状态 rejected；卡片文本不变；快照进回收站（chosen='rejected'）。
 * 返回更新后的卡片与修订；不存在返回 null。
 */
export function decideRepair(
  repairId: string,
  action: 'accept' | 'reject'
): { item: CompilationItem; repair: CompilationRepair } | null {
  const db = getDb()
  const repair = getRepairById(repairId)
  if (!repair) return null
  const status: CompilationRepairStatus = action === 'accept' ? 'accepted' : 'rejected'
  const now = new Date().toISOString()

  const tx = db.transaction(() => {
    if (action === 'accept') {
      db.prepare('UPDATE compilation_items SET excerpt = ? WHERE id = ?').run(
        repair.revisedText,
        repair.itemId
      )
    }
    db.prepare("UPDATE compilation_repairs SET status = ?, updated_at = ? WHERE id = ?").run(status, now, repairId)
    db.prepare(
      `INSERT INTO compilation_repair_recycle_bin (id, compilation_id, repair_id, item_id, original_text, revised_text, chosen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), repair.compilationId, repairId, repair.itemId, repair.originalText, repair.revisedText, action === 'accept' ? 'accepted' : 'rejected', now)
  })
  tx()

  const updatedRepair = getRepairById(repairId)
  const item = getItemById(repair.itemId)
  if (!updatedRepair || !item) return null
  return { item, repair: updatedRepair }
}

export function deleteRepairsForCompilation(compilationId: string): void {
  getDb().prepare('DELETE FROM compilation_repairs WHERE compilation_id = ?').run(compilationId)
}

/** 某汇编的「语义补全/修订」回收站条目（按时间倒序） */
export function listRepairRecycleBinByCompilation(compilationId: string): CompilationRecycleBinRepair[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM compilation_repair_recycle_bin WHERE compilation_id = ? ORDER BY created_at DESC')
    .all(compilationId) as {
    id: string
    compilation_id: string
    repair_id: string
    item_id: string
    original_text: string
    revised_text: string
    chosen: 'accepted' | 'rejected'
    created_at: string
  }[]
  const out: CompilationRecycleBinRepair[] = []
  for (const r of rows) {
    const repair = getRepairById(r.repair_id)
    if (!repair) continue
    out.push({
      id: r.id,
      compilationId: r.compilation_id,
      kind: 'repair',
      repairId: r.repair_id,
      itemId: r.item_id,
      originalText: r.original_text,
      revisedText: r.revised_text,
      chosen: r.chosen,
      createdAt: r.created_at,
      repair
    })
  }
  return out
}

/** 从回收站恢复某条语义补全/修订：修订状态回到 pending，卡片摘录恢复为 originalText，并删除回收站条目 */
export function restoreRepairRecycleBin(binId: string): CompilationRepair | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM compilation_repair_recycle_bin WHERE id = ?')
    .get(binId) as { id: string; repair_id: string; item_id: string; original_text: string } | undefined
  if (!row) return null
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    db.prepare("UPDATE compilation_repairs SET status = 'pending', updated_at = ? WHERE id = ?").run(now, row.repair_id)
    db.prepare('UPDATE compilation_items SET excerpt = ? WHERE id = ?').run(row.original_text, row.item_id)
    db.prepare('DELETE FROM compilation_repair_recycle_bin WHERE id = ?').run(binId)
  })
  tx()
  return getRepairById(row.repair_id)
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
    db.prepare(`INSERT INTO writing_tasks (id, title, scope_json) VALUES (?, '语义补全测试', '{"all":true}')`).run(taskId)
    db.prepare("INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', '统计表', '正文', 'ready')").run(sourceId)
    db.prepare(`INSERT INTO compilations (id, task_id, title, status, created_at, updated_at) VALUES (?, ?, '汇编', 'drafting', ?, ?)`).run(compilationId, taskId, new Date().toISOString(), new Date().toISOString())
    const itemId = crypto.randomUUID()
    db.prepare(
      `INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, extra_tags, kept, created_at)
       VALUES (?, ?, 0, ?, '原文', '[]', 1, ?)`
    ).run(itemId, compilationId, sourceId, new Date().toISOString())
    return { compilationId, itemId }
  }

  describe('compilation repairs store (Phase 6.4.3)', () => {
    it('inserts and lists repairs by compilation', () => {
      const { compilationId, itemId } = seed()
      const r = insertRepair({ compilationId, itemId, originalText: '原文', revisedText: '补全文本', reason: '表意不明' })
      expect(r.status).toBe('pending')
      const list = listRepairsByCompilation(compilationId)
      expect(list).toHaveLength(1)
      expect(list[0].revisedText).toBe('补全文本')
    })

    it('accept writes revised text to item and snapshots to repair recycle bin', () => {
      const { compilationId, itemId } = seed()
      const r = insertRepair({ compilationId, itemId, originalText: '原文', revisedText: '补全文本', reason: '表意不明' })
      const res = decideRepair(r.id, 'accept')!
      expect(res.item.excerpt).toBe('补全文本')
      expect(res.repair.status).toBe('accepted')
      const bin = listRepairRecycleBinByCompilation(compilationId)
      expect(bin).toHaveLength(1)
      expect(bin[0].chosen).toBe('accepted')
      expect(bin[0].kind).toBe('repair')
    })

    it('reject keeps item unchanged and snapshots with chosen rejected', () => {
      const { compilationId, itemId } = seed()
      const r = insertRepair({ compilationId, itemId, originalText: '原文', revisedText: '补全文本', reason: '表意不明' })
      const res = decideRepair(r.id, 'reject')!
      expect(res.item.excerpt).toBe('原文')
      expect(res.repair.status).toBe('rejected')
      const bin = listRepairRecycleBinByCompilation(compilationId)
      expect(bin[0].chosen).toBe('rejected')
    })

    it('restores a repair to pending and reverts item excerpt', () => {
      const { compilationId, itemId } = seed()
      const r = insertRepair({ compilationId, itemId, originalText: '原文', revisedText: '补全文本', reason: '表意不明' })
      decideRepair(r.id, 'accept')
      const bin = listRepairRecycleBinByCompilation(compilationId)[0]
      const restored = restoreRepairRecycleBin(bin.id)!
      expect(restored.status).toBe('pending')
      const item = getItemById(itemId)!
      expect(item.excerpt).toBe('原文')
      expect(listRepairRecycleBinByCompilation(compilationId)).toHaveLength(0)
    })

    it('deletes repairs for compilation', () => {
      const { compilationId, itemId } = seed()
      insertRepair({ compilationId, itemId, originalText: '原文', revisedText: '补全文本', reason: '表意不明' })
      deleteRepairsForCompilation(compilationId)
      expect(listRepairsByCompilation(compilationId)).toHaveLength(0)
    })
  })
}
