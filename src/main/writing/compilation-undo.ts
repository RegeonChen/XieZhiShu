/**
 * compilation-undo.ts —— 资料汇编操作的撤销/恢复（2026-08-28）。
 * 采用“快照”机制：每次对汇编的可变操作（编辑/删除/调整/矛盾取舍/大模型修正回退或应用/回收站恢复/排序/确认等）
 * 前，把该汇编在 5 张表中的完整状态快照入栈；撤销=恢复上一个快照，恢复=重做下一个快照。
 * 栈按 compilationId 各持一份，应用重启后清空（撤销/恢复为会话内能力）。
 */
import { getDb } from '../db/connection'

interface RowItem {
  id: string; compilation_id: string; position: number; source_id: string | null
  excerpt: string; ts: string | null; note: string | null; extra_tags: string; kept: number; created_at: string
  /* Phase 7.1（Migration 030）新增列：**恢复快照时必须一并写回**，
     否则每次撤销/恢复都会把段落元数据（时间、来源编号、证据等）重置为默认值——
     2026-09-10 实测就发生过：一次撤销让整份汇编的 year/source_ordinal 全部丢失。 */
  year: number | null; month: number | null; day: number | null
  time_confidence: string | null; source_ordinal: number | null; evidence: string | null
  origin: string | null; revision: number | null; kind: string | null
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
/**
 * 并列来源关系行（Phase 7.12，Migration 042）。
 * **必须随快照一起保存/恢复**：恢复是"先清空 5 张表再重插"，且期间外键关闭（级联失效），
 * 若不带这一张表，一次撤销就会把"另一个出处"静默抹掉——与 2026-09-10 那次
 * 「漏写 9 个段落列导致 year/source_ordinal 全丢」属同一类事故。
 */
interface RowItemSource {
  item_id: string; source_id: string; created_at: string
}
interface RowComp {
  id: string; task_id: string; title: string; status: string; created_at: string; updated_at: string
}

export interface CompilationSnapshot {
  compilation: RowComp
  items: RowItem[]
  /** 段落 ↔ 来源（含主来源与并列来源）：Phase 7.12 */
  itemSources: RowItemSource[]
  contradictions: RowContra[]
  variants: RowVariant[]
  recycleBin: RowRecycle[]
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
  const itemSources = db
    .prepare(
      'SELECT r.item_id AS item_id, r.source_id AS source_id, r.created_at AS created_at FROM compilation_item_sources r WHERE r.item_id IN (SELECT id FROM compilation_items WHERE compilation_id = ?)'
    )
    .all(compilationId) as RowItemSource[]
  const contradictions = db.prepare('SELECT * FROM compilation_contradictions WHERE compilation_id = ?').all(compilationId) as RowContra[]
  const contraIds = contradictions.map((c) => c.id)
  const variants = contraIds.length > 0
    ? db.prepare('SELECT * FROM compilation_contradiction_variants WHERE contradiction_id IN (' + place(contraIds.length) + ')').all(...contraIds) as RowVariant[]
    : []
  const recycleBin = db.prepare('SELECT * FROM compilation_recycle_bin WHERE compilation_id = ?').all(compilationId) as RowRecycle[]
  return { compilation: comp, items, itemSources, contradictions, variants, recycleBin }
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
      db.prepare('DELETE FROM compilation_contradiction_variants WHERE contradiction_id IN (SELECT id FROM compilation_contradictions WHERE compilation_id = ?)').run(cid)
      db.prepare('DELETE FROM compilation_contradictions WHERE compilation_id = ?').run(cid)
      // 关系行必须先清（期间外键关闭，删除段落不会级联清理，会留下指向已删段落的孤儿行）
      db.prepare(
        'DELETE FROM compilation_item_sources WHERE item_id IN (SELECT id FROM compilation_items WHERE compilation_id = ?)'
      ).run(cid)
      db.prepare('DELETE FROM compilation_items WHERE compilation_id = ?').run(cid)

      db.prepare('UPDATE compilations SET title = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(snapshot.compilation.title, snapshot.compilation.status, snapshot.compilation.updated_at, cid)

      const insItem = db.prepare(
        `INSERT INTO compilation_items
          (id, compilation_id, position, source_id, excerpt, ts, note, extra_tags, kept, created_at,
           year, month, day, time_confidence, source_ordinal, evidence, origin, revision, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      for (const r of snapshot.items) {
        insItem.run(
          r.id, r.compilation_id, r.position, r.source_id, r.excerpt, r.ts, r.note, r.extra_tags, r.kept, r.created_at,
          r.year ?? null, r.month ?? null, r.day ?? null, r.time_confidence ?? 'unknown', r.source_ordinal ?? null,
          r.evidence ?? null, r.origin ?? 'generate', r.revision ?? 1, r.kind ?? 'paragraph'
        )
      }

      // 段落 ↔ 来源关系（含并列来源，Phase 7.12）：与段落行同一事务重插
      const insItemSource = db.prepare('INSERT OR IGNORE INTO compilation_item_sources (item_id, source_id, created_at) VALUES (?,?,?)')
      for (const r of snapshot.itemSources ?? []) insItemSource.run(r.item_id, r.source_id, r.created_at)

      const insContra = db.prepare('INSERT INTO compilation_contradictions (id, compilation_id, topic, kind, status, chosen_item_id, created_at) VALUES (?,?,?,?,?,?,?)')
      for (const r of snapshot.contradictions) insContra.run(r.id, r.compilation_id, r.topic, r.kind, r.status, r.chosen_item_id, r.created_at)

      const insVar = db.prepare('INSERT INTO compilation_contradiction_variants (id, contradiction_id, item_id, variant_text, source_id, created_at) VALUES (?,?,?,?,?,?)')
      for (const r of snapshot.variants) insVar.run(r.id, r.contradiction_id, r.item_id, r.variant_text, r.source_id, r.created_at)

      const insRecycle = db.prepare('INSERT INTO compilation_recycle_bin (id, compilation_id, contradiction_id, topic, kind, status, created_at) VALUES (?,?,?,?,?,?,?)')
      for (const r of snapshot.recycleBin) insRecycle.run(r.id, r.compilation_id, r.contradiction_id, r.topic, r.kind, r.status, r.created_at)
    })
    tx()
  } finally {
    db.pragma('foreign_keys = ' + (fkOn ? 'ON' : 'OFF'))
  }
}

/** 在执行一次可变操作前调用：把当前状态压入撤销栈，并清空恢复栈。 */
export function pushUndo(compilationId: string): CompilationSnapshot | null {  const snap = captureCompilationSnapshot(compilationId)
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

/**
 * 清空某汇编的撤销/恢复栈。
 *
 * 撤销栈登记的范围（用户 2026-09-10 敲定）：**对话编辑**（`runDocEdit`）与**矛盾采纳/忽略**，各自压一个快照；
 * 其余只改顺序或非用户裁定的路径（排序 / 回收站恢复 / 修正回退与再应用 / 目录级编辑 / 版本恢复 / 汇编调整）
 * 一律**作废**撤销栈。
 *
 * 为什么"作废"而不是"不管"：快照是整个汇编的状态，若某条改动没有压栈，撤销就会**跳过它**去弹更早的快照，
 * 把这次改动一并回滚掉（用户实测："点排序按钮也会点亮撤销"，撤销后连排序前的对话编辑也没了）。
 * 压栈与作废必须二选一：**要么这次改动可单独撤销，要么撤销栈失效**。
 */
export function clearUndoStacks(compilationId: string | null | undefined): void {
  if (!compilationId) return
  undoStacks.delete(compilationId)
  redoStacks.delete(compilationId)
}

export function getUndoCount(compilationId: string): number {
  return (undoStacks.get(compilationId) ?? []).length
}
export function getRedoCount(compilationId: string): number {
  return (redoStacks.get(compilationId) ?? []).length
}

/** 由矛盾 id 反查所属汇编 id。 */
export function compilationIdOfContradiction(id: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT compilation_id FROM compilation_contradictions WHERE id = ?').get(id) as { compilation_id: string } | undefined
  return row?.compilation_id ?? null
}
/** 由回收站条目 id 反查所属汇编 id。 */
export function compilationIdOfBin(binId: string): string | null {
  const db = getDb()
  const a = db.prepare('SELECT compilation_id FROM compilation_recycle_bin WHERE id = ?').get(binId) as { compilation_id: string } | undefined
  return a?.compilation_id ?? null
}
