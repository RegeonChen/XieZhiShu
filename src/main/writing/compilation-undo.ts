/**
 * compilation-undo.ts —— 资料汇编操作的撤销/恢复（2026-08-28）。
 * 采用“快照”机制：每次对汇编的可变操作（编辑/删除/调整/矛盾取舍/二次修改采纳/回收站恢复/排序/确认等）
 * 前，把该汇编在 6 张表中的完整状态快照入栈；撤销=恢复上一个快照，恢复=重做下一个快照。
 * 栈按 compilationId 各持一份，应用重启后清空（撤销/恢复为会话内能力）。
 */
import { getDb } from '../db/connection'

interface RowItem {
  id: string; compilation_id: string; position: number; source_id: string | null
  excerpt: string; ts: string | null; note: string | null; extra_tags: string; kept: number; created_at: string
}
interface RowContra {
  id: string; compilation_id: string; topic: string; kind: string; status: string; chosen_item_id: string | null; created_at: string
}
interface RowVariant {
  id: string; contradiction_id: string; item_id: string; variant_text: string; source_id: string | null; created_at: string
}
interface RowRecycle {
  id: string; compilation_id: string; contradiction_id: string; topic: string; kind: string; status: string; created_at: string
}
interface RowRepair {
  id: string; compilation_id: string; item_id: string; original_text: string; revised_text: string; reason: string; status: string; created_at: string; updated_at: string
}
interface RowRepairBin {
  id: string; compilation_id: string; repair_id: string; item_id: string; original_text: string; revised_text: string; chosen: string; created_at: string
}
interface RowComp {
  id: string; task_id: string; title: string; status: string; created_at: string; updated_at: string
}

export interface CompilationSnapshot {
  compilation: RowComp
  items: RowItem[]
  contradictions: RowContra[]
  variants: RowVariant[]
  recycleBin: RowRecycle[]
  repairs: RowRepair[]
  repairRecycleBin: RowRepairBin[]
}

const undoStacks = new Map<string, CompilationSnapshot[]>()
const redoStacks = new Map<string, CompilationSnapshot[]>()

function place(n: number): string {
  return new Array(n).fill('?').join(',')
}

/** 捕获某汇编的完整状态（6 张表 + compilations 行）。返回 null 表示汇编不存在。 */
export function captureCompilationSnapshot(compilationId: string): CompilationSnapshot | null {
  const db = getDb()
  const comp = db.prepare('SELECT * FROM compilations WHERE id = ?').get(compilationId) as RowComp | undefined
  if (!comp) return null
  const items = db.prepare('SELECT * FROM compilation_items WHERE compilation_id = ? ORDER BY position').all(compilationId) as RowItem[]
  const contradictions = db.prepare('SELECT * FROM compilation_contradictions WHERE compilation_id = ?').all(compilationId) as RowContra[]
  const contraIds = contradictions.map((c) => c.id)
  const variants = contraIds.length > 0
    ? db.prepare('SELECT * FROM compilation_contradiction_variants WHERE contradiction_id IN (' + place(contraIds.length) + ')').all(...contraIds) as RowVariant[]
    : []
  const recycleBin = db.prepare('SELECT * FROM compilation_recycle_bin WHERE compilation_id = ?').all(compilationId) as RowRecycle[]
  const repairs = db.prepare('SELECT * FROM compilation_repairs WHERE compilation_id = ?').all(compilationId) as RowRepair[]
  const repairRecycleBin = db.prepare('SELECT * FROM compilation_repair_recycle_bin WHERE compilation_id = ?').all(compilationId) as RowRepairBin[]
  return { compilation: comp, items, contradictions, variants, recycleBin, repairs, repairRecycleBin }
}

/** 用快照替换某汇编的全部状态（先清空 6 张表中属于该汇编的行，再按原 ID 重插）。 */
export function restoreCompilationSnapshot(snapshot: CompilationSnapshot): void {
  const db = getDb()
  const cid = snapshot.compilation.id
  const fkOn = db.pragma('foreign_keys', { simple: true })
  db.pragma('foreign_keys = OFF')
  try {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM compilation_recycle_bin WHERE compilation_id = ?').run(cid)
      db.prepare('DELETE FROM compilation_repair_recycle_bin WHERE compilation_id = ?').run(cid)
      db.prepare('DELETE FROM compilation_repairs WHERE compilation_id = ?').run(cid)
      db.prepare('DELETE FROM compilation_contradiction_variants WHERE contradiction_id IN (SELECT id FROM compilation_contradictions WHERE compilation_id = ?)').run(cid)
      db.prepare('DELETE FROM compilation_contradictions WHERE compilation_id = ?').run(cid)
      db.prepare('DELETE FROM compilation_items WHERE compilation_id = ?').run(cid)

      db.prepare('UPDATE compilations SET title = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(snapshot.compilation.title, snapshot.compilation.status, snapshot.compilation.updated_at, cid)

      const insItem = db.prepare('INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, ts, note, extra_tags, kept, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      for (const r of snapshot.items) insItem.run(r.id, r.compilation_id, r.position, r.source_id, r.excerpt, r.ts, r.note, r.extra_tags, r.kept, r.created_at)

      const insContra = db.prepare('INSERT INTO compilation_contradictions (id, compilation_id, topic, kind, status, chosen_item_id, created_at) VALUES (?,?,?,?,?,?,?)')
      for (const r of snapshot.contradictions) insContra.run(r.id, r.compilation_id, r.topic, r.kind, r.status, r.chosen_item_id, r.created_at)

      const insVar = db.prepare('INSERT INTO compilation_contradiction_variants (id, contradiction_id, item_id, variant_text, source_id, created_at) VALUES (?,?,?,?,?,?)')
      for (const r of snapshot.variants) insVar.run(r.id, r.contradiction_id, r.item_id, r.variant_text, r.source_id, r.created_at)

      const insRecycle = db.prepare('INSERT INTO compilation_recycle_bin (id, compilation_id, contradiction_id, topic, kind, status, created_at) VALUES (?,?,?,?,?,?,?)')
      for (const r of snapshot.recycleBin) insRecycle.run(r.id, r.compilation_id, r.contradiction_id, r.topic, r.kind, r.status, r.created_at)

      const insRepair = db.prepare('INSERT INTO compilation_repairs (id, compilation_id, item_id, original_text, revised_text, reason, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      for (const r of snapshot.repairs) insRepair.run(r.id, r.compilation_id, r.item_id, r.original_text, r.revised_text, r.reason, r.status, r.created_at, r.updated_at)

      const insRepairBin = db.prepare('INSERT INTO compilation_repair_recycle_bin (id, compilation_id, repair_id, item_id, original_text, revised_text, chosen, created_at) VALUES (?,?,?,?,?,?,?,?)')
      for (const r of snapshot.repairRecycleBin) insRepairBin.run(r.id, r.compilation_id, r.repair_id, r.item_id, r.original_text, r.revised_text, r.chosen, r.created_at)
    })
    tx()
  } finally {
    db.pragma('foreign_keys = ' + (fkOn ? 'ON' : 'OFF'))
  }
}

/** 在执行一次可变操作前调用：把当前状态压入撤销栈，并清空恢复栈。 */
export function pushUndo(compilationId: string): CompilationSnapshot | null {
  const snap = captureCompilationSnapshot(compilationId)
  if (!snap) return null
  const stack = undoStacks.get(compilationId) ?? []
  stack.push(snap)
  undoStacks.set(compilationId, stack)
  redoStacks.delete(compilationId)
  return snap
}

/** 撤销：回滚到上一个操作前的状态；返回 null 表示没有可撤销的操作。 */
export function undoCompilation(compilationId: string): CompilationSnapshot | null {
  const stack = undoStacks.get(compilationId)
  if (!stack || stack.length === 0) return null
  const prev = stack.pop()!
  const cur = captureCompilationSnapshot(compilationId)
  if (cur) {
    const redo = redoStacks.get(compilationId) ?? []
    redo.push(cur)
    redoStacks.set(compilationId, redo)
  }
  restoreCompilationSnapshot(prev)
  return prev
}

/** 恢复：重做被撤销的操作；返回 null 表示没有可恢复的操作。 */
export function redoCompilation(compilationId: string): CompilationSnapshot | null {
  const stack = redoStacks.get(compilationId)
  if (!stack || stack.length === 0) return null
  const next = stack.pop()!
  const cur = captureCompilationSnapshot(compilationId)
  if (cur) {
    const undo = undoStacks.get(compilationId) ?? []
    undo.push(cur)
    undoStacks.set(compilationId, undo)
  }
  restoreCompilationSnapshot(next)
  return next
}

export function getUndoCount(compilationId: string): number {
  return (undoStacks.get(compilationId) ?? []).length
}
export function getRedoCount(compilationId: string): number {
  return (redoStacks.get(compilationId) ?? []).length
}

/** 由 itemId 反查所属汇编 id（编辑/删除卡片前用于登记撤销）。 */
export function compilationIdOfItem(itemId: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT compilation_id FROM compilation_items WHERE id = ?').get(itemId) as { compilation_id: string } | undefined
  return row?.compilation_id ?? null
}
/** 由矛盾 id 反查所属汇编 id。 */
export function compilationIdOfContradiction(id: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT compilation_id FROM compilation_contradictions WHERE id = ?').get(id) as { compilation_id: string } | undefined
  return row?.compilation_id ?? null
}
/** 由修订 id 反查所属汇编 id。 */
export function compilationIdOfRepair(id: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT compilation_id FROM compilation_repairs WHERE id = ?').get(id) as { compilation_id: string } | undefined
  return row?.compilation_id ?? null
}
/** 由回收站条目 id 反查所属汇编 id（矛盾或语义补全回收站）。 */
export function compilationIdOfBin(binId: string): string | null {
  const db = getDb()
  const a = db.prepare('SELECT compilation_id FROM compilation_recycle_bin WHERE id = ?').get(binId) as { compilation_id: string } | undefined
  if (a) return a.compilation_id
  const b = db.prepare('SELECT compilation_id FROM compilation_repair_recycle_bin WHERE id = ?').get(binId) as { compilation_id: string } | undefined
  return b?.compilation_id ?? null
}
