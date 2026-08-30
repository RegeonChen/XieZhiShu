/**
 * compilations.ts —— 资料汇编仓储（Phase 6.0，2026-08-25）。
 * 三段式撰写第一步：compilations（一次汇编）+ compilation_items（资料卡片）+
 * compilation_contradictions / compilation_contradiction_variants（汇编阶段的资料矛盾与取舍）。
 */
import Database from 'better-sqlite3'
import type {
  Compilation,
  CompilationContradiction,
  CompilationContradictionStatus,
  CompilationItem,
  CompilationStatus,
  CompilationRecycleBinItem
} from '../../shared/types'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'
import { insertRepair, listRepairRecycleBinByCompilation, listRepairsByCompilation } from './compilation-repairs'

interface CompilationRow {
  id: string
  task_id: string
  title: string
  status: CompilationStatus
  created_at: string
  updated_at: string
}

interface CompilationItemRow {
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
}

interface CompilationContradictionRow {
  id: string
  compilation_id: string
  topic: string
  kind: 'data' | 'time' | 'place' | 'fact' | 'other'
  status: CompilationContradictionStatus
  chosen_item_id: string | null
  created_at: string
}

interface CompilationVariantRow {
  id: string
  contradiction_id: string
  item_id: string
  variant_text: string
  source_id: string
  created_at: string
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function loadSourceTitles(ids: string[]): Map<string, string> {
  const db = getDb()
  const unique = Array.from(new Set(ids))
  const titles = new Map<string, string>()
  if (unique.length === 0) return titles
  const placeholders = unique.map(() => '?').join(',')
  const rows = db.prepare('SELECT id, title FROM sources WHERE id IN (' + placeholders + ')').all(...unique) as {
    id: string
    title: string
  }[]
  for (const r of rows) titles.set(r.id, r.title)
  return titles
}

function mapItem(row: CompilationItemRow, titles: Map<string, string>): CompilationItem {
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
    sourceTitle: titles.get(row.source_id) ?? row.source_id,
    createdAt: row.created_at
  }
}

function mapContradiction(
  row: CompilationContradictionRow,
  variants: CompilationContradiction['variants']
): CompilationContradiction {
  return {
    id: row.id,
    compilationId: row.compilation_id,
    topic: row.topic,
    kind: row.kind,
    status: row.status,
    chosenItemId: row.chosen_item_id ?? undefined,
    createdAt: row.created_at,
    variants
  }
}

function getContradictionById(id: string): CompilationContradiction | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM compilation_contradictions WHERE id = ?').get(id) as
    | CompilationContradictionRow
    | undefined
  if (!row) return null
  const vr = db
    .prepare('SELECT * FROM compilation_contradiction_variants WHERE contradiction_id = ? ORDER BY rowid ASC')
    .all(id) as CompilationVariantRow[]
  const titles = loadSourceTitles(vr.map((v) => v.source_id))
  return mapContradiction(row, vr.map((v) => ({
    id: v.id,
    contradictionId: v.contradiction_id,
    itemId: v.item_id,
    variantText: v.variant_text,
    sourceId: v.source_id,
    sourceTitle: titles.get(v.source_id) ?? v.source_id,
    createdAt: v.created_at
  })))
}

export function getContradictionsByCompilation(compilationId: string): CompilationContradiction[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM compilation_contradictions WHERE compilation_id = ? ORDER BY rowid ASC')
    .all(compilationId) as CompilationContradictionRow[]
  const out: CompilationContradiction[] = []
  for (const row of rows) {
    const c = getContradictionById(row.id)
    if (c) out.push(c)
  }
  return out
}

function getItemsByCompilation(compilationId: string): CompilationItem[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM compilation_items WHERE compilation_id = ? ORDER BY position ASC, rowid ASC')
    .all(compilationId) as CompilationItemRow[]
  const titles = loadSourceTitles(rows.map((r) => r.source_id))
  return rows.map((r) => mapItem(r, titles))
}

export function getCompilationById(id: string): Compilation | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM compilations WHERE id = ?').get(id) as CompilationRow | undefined
  if (!row) return null
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: getItemsByCompilation(row.id),
    contradictions: getContradictionsByCompilation(row.id),
    repairs: listRepairsByCompilation(row.id)
  }
}

export function listCompilationsByTask(taskId: string): Compilation[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM compilations WHERE task_id = ? ORDER BY created_at DESC')
    .all(taskId) as CompilationRow[]
  return rows.map((r) => {
    const c = getCompilationById(r.id)
    return c ?? {
      id: r.id,
      taskId: r.task_id,
      title: r.title,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      items: [],
      contradictions: [],
      repairs: []
    }
  })
}

export function getLatestCompilationByTask(taskId: string): Compilation | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM compilations WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(taskId) as CompilationRow | undefined
  return row ? getCompilationById(row.id) : null
}

export interface CreateCompilationInput {
  taskId: string
  title: string
}

export function createCompilation(input: CreateCompilationInput): Compilation {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO compilations (id, task_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'drafting', ?, ?)"
  ).run(id, input.taskId, input.title, now, now)
  return getCompilationById(id)!
}

export interface CompilationItemInput {
  sourceId: string
  excerpt: string
  ts?: string
  note?: string
  extraTags?: string[]
}

/** 批量写入资料卡片（事务，按传入顺序编号 position）。 */
export function insertCompilationItems(compilationId: string, inputs: CompilationItemInput[]): CompilationItem[] {
  const db = getDb()
  if (inputs.length === 0) return []
  const now = new Date().toISOString()
  const ins = db.prepare(
    'INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, ts, note, extra_tags, kept, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
  )
  const tx = db.transaction(() => {
    inputs.forEach((it, i) => {
      ins.run(
        crypto.randomUUID(),
        compilationId,
        i,
        it.sourceId,
        it.excerpt,
        it.ts ?? null,
        it.note ?? null,
        JSON.stringify(it.extraTags ?? []),
        now
      )
    })
  })
  tx()
  return getItemsByCompilation(compilationId)
}

export interface CompilationItemPatch {
  excerpt?: string
  ts?: string | null
  note?: string | null
  extraTags?: string[]
  kept?: boolean
}

export function updateCompilationItem(itemId: string, patch: CompilationItemPatch): CompilationItem | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM compilation_items WHERE id = ?').get(itemId) as CompilationItemRow | undefined
  if (!row) return null
  const fields: string[] = []
  const values: unknown[] = []
  if (patch.excerpt !== undefined) {
    fields.push('excerpt = ?')
    values.push(patch.excerpt)
  }
  if (patch.ts !== undefined) {
    fields.push('ts = ?')
    values.push(patch.ts)
  }
  if (patch.note !== undefined) {
    fields.push('note = ?')
    values.push(patch.note)
  }
  if (patch.extraTags !== undefined) {
    fields.push('extra_tags = ?')
    values.push(JSON.stringify(patch.extraTags))
  }
  if (patch.kept !== undefined) {
    fields.push('kept = ?')
    values.push(patch.kept ? 1 : 0)
  }
  if (fields.length > 0) {
    db.prepare('UPDATE compilation_items SET ' + fields.join(', ') + ' WHERE id = ?').run(...values, itemId)
  }
  const titles = loadSourceTitles([row.source_id])
  const after = db.prepare('SELECT * FROM compilation_items WHERE id = ?').get(itemId) as CompilationItemRow
  return mapItem(after, titles)
}

/**【卡片回收站-内部行】**/
interface CardBinRow {
  id: string
  compilation_id: string
  item_id: string
  position: number
  source_id: string | null
  excerpt: string
  ts: string | null
  note: string | null
  extra_tags: string
  kept: number
  created_at: string
  deleted_at: string
  extra: string
}

/** 把一张卡片（及其矛盾变异、语义补全修订）快照进回收站，供恢复。返回是否成功入站。 */
function snapshotCardToRecycleBin(itemId: string): boolean {
  const db = getDb()
  const item = db.prepare('SELECT * FROM compilation_items WHERE id = ?').get(itemId) as CompilationItemRow | undefined
  if (!item) return false
  const variants = db.prepare('SELECT * FROM compilation_contradiction_variants WHERE item_id = ?').all(itemId)
  const repairs = db.prepare('SELECT * FROM compilation_repairs WHERE item_id = ?').all(itemId)
  db.prepare(
    'INSERT INTO compilation_card_recycle_bin (id, compilation_id, item_id, position, source_id, excerpt, ts, note, extra_tags, kept, created_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(crypto.randomUUID(), item.compilation_id, item.id, item.position, item.source_id, item.excerpt, item.ts, item.note, item.extra_tags, item.kept, item.created_at, new Date().toISOString(), JSON.stringify({ variants, repairs }))
  return true
}

export function deleteCompilationItem(itemId: string): void {
  const db = getDb()
  // 删除前快照进回收站（第三类：资料卡片），允许恢复
  snapshotCardToRecycleBin(itemId)
  db.prepare('DELETE FROM compilation_items WHERE id = ?').run(itemId)
}

/** 从回收站恢复一张被删除的资料卡片（含其矛盾变异/语义补全修订），并删除回收站条目。 */
export function restoreCompilationCardRecycleBin(binId: string): CompilationItem | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM compilation_card_recycle_bin WHERE id = ?').get(binId) as CardBinRow | undefined
  if (!row) return null
  let extra: { variants?: Record<string, unknown>[]; repairs?: Record<string, unknown>[] } = {}
  try { extra = JSON.parse(row.extra || '{}') } catch { extra = {} }
  const fkOn = db.pragma('foreign_keys', { simple: true })
  db.pragma('foreign_keys = OFF')
  try {
    const tx = db.transaction(() => {
      db.prepare(
        'INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, ts, note, extra_tags, kept, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).run(row.item_id, row.compilation_id, row.position, row.source_id, row.excerpt, row.ts, row.note, row.extra_tags, row.kept, row.created_at)
      const insVar = db.prepare('INSERT INTO compilation_contradiction_variants (id, contradiction_id, item_id, variant_text, source_id, created_at) VALUES (?,?,?,?,?,?)')
      for (const v of extra.variants ?? []) {
        insVar.run(v.id, v.contradiction_id, v.item_id, v.variant_text, v.source_id ?? null, v.created_at)
      }
      const insRepair = db.prepare('INSERT INTO compilation_repairs (id, compilation_id, item_id, original_text, revised_text, reason, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      for (const r of extra.repairs ?? []) {
        insRepair.run(r.id, r.compilation_id, r.item_id, r.original_text, r.revised_text, r.reason, r.status, r.created_at, r.updated_at)
      }
      db.prepare('DELETE FROM compilation_card_recycle_bin WHERE id = ?').run(binId)
    })
    tx()
  } finally {
    db.pragma('foreign_keys = ' + (fkOn ? 'ON' : 'OFF'))
  }
  const after = db.prepare('SELECT * FROM compilation_items WHERE id = ?').get(row.item_id) as CompilationItemRow | undefined
  return after ? mapItem(after, loadSourceTitles([after.source_id])) : null
}

export interface DeleteSourceItemsResult {
  deletedItems: number
  deletedContradictions: number
  deletedRepairs: number
}

/**
 * 工作区文件被删除后的确认清理（2026-08-28）：删除某来源在**全部资料汇编**中的资料卡片，
 * 并同步删除涉及这些卡片的**矛盾分组**（及其变异/回收站）与**语义补全/修订**（及其回收站）。
 * 硬删除、**不写入回收站**；若某汇编因此清空，则把状态重置回 drafting（便于重新生成）。
 * 需要先调用方删除来源（本函数基于 source_id 匹配卡片）；来源删除后卡片 source_id 会置空，
 * 因此调用方应在删除来源前捕获 sourceId（本函数仍按传入 sourceId 检索仍存在的卡片）。
 */
export function deleteCompilationItemsForSourceIds(sourceIds: string[]): DeleteSourceItemsResult {
  const db = getDb()
  if (sourceIds.length === 0) return { deletedItems: 0, deletedContradictions: 0, deletedRepairs: 0 }
  const sPlace = sourceIds.map(() => '?').join(',')
  const items = db
    .prepare(`SELECT id, compilation_id FROM compilation_items WHERE source_id IN (${sPlace})`)
    .all(...sourceIds) as { id: string; compilation_id: string }[]
  if (items.length === 0) return { deletedItems: 0, deletedContradictions: 0, deletedRepairs: 0 }

  const itemIds = items.map((i) => i.id)
  const iPlace = itemIds.map(() => '?').join(',')
  const affectedCompIds = Array.from(new Set(items.map((i) => i.compilation_id)))
  const contradictionIds = (
    db
      .prepare(`SELECT DISTINCT contradiction_id FROM compilation_contradiction_variants WHERE item_id IN (${iPlace})`)
      .all(...itemIds) as { contradiction_id: string }[]
  ).map((r) => r.contradiction_id)
  const repairCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM compilation_repairs WHERE item_id IN (${iPlace})`).get(...itemIds) as { c: number }
  ).c

  const tx = db.transaction(() => {
    let deletedContradictions = 0
    if (contradictionIds.length > 0) {
      const cPlace = contradictionIds.map(() => '?').join(',')
      deletedContradictions = db
        .prepare(`DELETE FROM compilation_contradictions WHERE id IN (${cPlace})`)
        .run(...contradictionIds).changes
    }
    const deletedItems = db.prepare(`DELETE FROM compilation_items WHERE id IN (${iPlace})`).run(...itemIds).changes
    // compilation_repairs 随 item_id 级联删除；但 compilation_repair_recycle_bin.item_id 无外键，需显式清理，
    // 避免删除卡片后回收站残留指向已删卡片的“待恢复”修订条目（否则恢复时卡片已不存在）。
    db.prepare(`DELETE FROM compilation_repair_recycle_bin WHERE item_id IN (${iPlace})`).run(...itemIds)
    // 矛盾卡片随 item_id 级联删除；矛盾分组（含变异/回收站）随 contradiction_id 级联删除。
    // 若受影响汇编因此清空，重置为 drafting，解除「已确认汇编」锁定，提示用户重新生成。
    const now = new Date().toISOString()
    for (const cid of affectedCompIds) {
      const left = db.prepare('SELECT COUNT(*) AS c FROM compilation_items WHERE compilation_id = ?').get(cid) as { c: number }
      if (left.c === 0) {
        db.prepare("UPDATE compilations SET status = 'drafting', updated_at = ? WHERE id = ?").run(now, cid)
      }
    }
    return { deletedItems, deletedContradictions }
  })
  const res = tx()
  return { deletedItems: res.deletedItems, deletedContradictions: res.deletedContradictions, deletedRepairs: repairCount }
}

/**
 * 按卡片 id 批量删除（资料汇编调整用，2026-08-28）：删除指定卡片，并同步删除涉及这些卡片的
 * 矛盾分组（含变异/回收站）与语义补全/修订（含回收站），硬删除、不入回收站；若某汇编因此清空则回 drafting。
 */
export function deleteCompilationItemsByIds(itemIds: string[]): DeleteSourceItemsResult {
  const db = getDb()
  if (itemIds.length === 0) return { deletedItems: 0, deletedContradictions: 0, deletedRepairs: 0 }
  // 删除前把每张卡快照进回收站（第三类：资料卡片），允许恢复
  for (const id of itemIds) snapshotCardToRecycleBin(id)
  const iPlace = itemIds.map(() => '?').join(',')
  const affectedCompIds = Array.from(
    new Set(
      (db.prepare(`SELECT DISTINCT compilation_id FROM compilation_items WHERE id IN (${iPlace})`).all(...itemIds) as { compilation_id: string }[]).map((r) => r.compilation_id)
    )
  )
  const contradictionIds = (
    db
      .prepare(`SELECT DISTINCT contradiction_id FROM compilation_contradiction_variants WHERE item_id IN (${iPlace})`)
      .all(...itemIds) as { contradiction_id: string }[]
  ).map((r) => r.contradiction_id)
  const repairCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM compilation_repairs WHERE item_id IN (${iPlace})`).get(...itemIds) as { c: number }
  ).c

  const tx = db.transaction(() => {
    let deletedContradictions = 0
    if (contradictionIds.length > 0) {
      const cPlace = contradictionIds.map(() => '?').join(',')
      deletedContradictions = db
        .prepare(`DELETE FROM compilation_contradictions WHERE id IN (${cPlace})`)
        .run(...contradictionIds).changes
    }
    const deletedItems = db.prepare(`DELETE FROM compilation_items WHERE id IN (${iPlace})`).run(...itemIds).changes
    // compilation_repair_recycle_bin.item_id 无外键，删除卡片后需显式清理，避免回收站残留指向已删卡片的条目
    db.prepare(`DELETE FROM compilation_repair_recycle_bin WHERE item_id IN (${iPlace})`).run(...itemIds)
    const now = new Date().toISOString()
    for (const cid of affectedCompIds) {
      const left = db.prepare('SELECT COUNT(*) AS c FROM compilation_items WHERE compilation_id = ?').get(cid) as { c: number }
      if (left.c === 0) {
        db.prepare("UPDATE compilations SET status = 'drafting', updated_at = ? WHERE id = ?").run(now, cid)
      }
    }
    return { deletedItems, deletedContradictions }
  })
  const res = tx()
  return { deletedItems: res.deletedItems, deletedContradictions: res.deletedContradictions, deletedRepairs: repairCount }
}

/** 从时间标签中提取年份（无年份则 null），用于时间排序 */
function yearOfTs(ts?: string): number | null {
  if (!ts) return null
  const m = ts.match(/(18|19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

/**
 * 按时间标签（年份）重新排序汇编卡片并重写 position，使资料汇编始终按时间顺序展示。
 * 无时间标签的卡片排最后（保持原有相对顺序）。二次修改自动补齐时间戳后、汇编调整后调用，刷新卡片顺序。
 */
export function reorderCompilationItemsByTs(compilationId: string, direction: 'asc' | 'desc' = 'asc'): void {
  const db = getDb()
  const comp = getCompilationById(compilationId)
  if (!comp || comp.items.length === 0) return
  const dirMul = direction === 'desc' ? -1 : 1
  const sorted = [...comp.items].sort((a, b) => {
    const ya = yearOfTs(a.ts)
    const yb = yearOfTs(b.ts)
    if (ya === null && yb === null) return a.position - b.position
    if (ya === null) return 1
    if (yb === null) return -1
    if (ya !== yb) return (ya - yb) * dirMul
    return a.position - b.position
  })
  const upd = db.prepare('UPDATE compilation_items SET position = ? WHERE id = ?')
  const tx = db.transaction(() => {
    sorted.forEach((it, i) => upd.run(i, it.id))
  })
  tx()
}

export interface CompilationContradictionInput {
  topic: string
  kind?: 'data' | 'time' | 'place' | 'fact' | 'other'
  variants: { itemId: string; variantText: string; sourceId: string }[]
}

export function insertCompilationContradictions(
  compilationId: string,
  groups: CompilationContradictionInput[]
): CompilationContradiction[] {
  const db = getDb()
  if (groups.length === 0) return []
  const now = new Date().toISOString()
  const insC = db.prepare(
    "INSERT INTO compilation_contradictions (id, compilation_id, topic, kind, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
  )
  const insV = db.prepare(
    'INSERT INTO compilation_contradiction_variants (id, contradiction_id, item_id, variant_text, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const tx = db.transaction(() => {
    for (const g of groups) {
      const cid = crypto.randomUUID()
      insC.run(cid, compilationId, g.topic, g.kind ?? 'other', now)
      for (const v of g.variants) {
        insV.run(crypto.randomUUID(), cid, v.itemId, v.variantText, v.sourceId, now)
      }
    }
  })
  tx()
  return getContradictionsByCompilation(compilationId)
}

export function updateCompilationContradictionStatus(
  contradictionId: string,
  status: CompilationContradictionStatus,
  chosenItemId?: string
): CompilationContradiction | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM compilation_contradictions WHERE id = ?').get(contradictionId) as
    | CompilationContradictionRow
    | undefined
  if (!row) return null
  let chosen: string | null = null
  if (status === 'resolved') {
    if (!chosenItemId) return null
    const belongs = db
      .prepare('SELECT 1 FROM compilation_contradiction_variants WHERE contradiction_id = ? AND item_id = ?')
      .get(contradictionId, chosenItemId)
    if (!belongs) return null
    chosen = chosenItemId
  }
  db.prepare('UPDATE compilation_contradictions SET status = ?, chosen_item_id = ? WHERE id = ?').run(
    status,
    chosen,
    contradictionId
  )
  // 2026-08-25：采纳/忽略后，把整组矛盾“原封不动”快照到回收站；采纳时用 kept=0 软删除未被采纳的卡片，
  // 以便恢复时直接改回 kept=1（不重建卡片，避免重复卡片 / 卡片数异常）。
  const now = new Date().toISOString()
  const binId = crypto.randomUUID()
  db.prepare(
    'INSERT INTO compilation_recycle_bin (id, compilation_id, contradiction_id, topic, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(binId, row.compilation_id, contradictionId, row.topic, row.kind, status, now)
  if (status === 'resolved' && chosenItemId) {
    const variantItems = db
      .prepare('SELECT item_id FROM compilation_contradiction_variants WHERE contradiction_id = ?')
      .all(contradictionId) as { item_id: string }[]
    const softDel = db.prepare('UPDATE compilation_items SET kept = 0 WHERE id = ?')
    for (const v of variantItems) {
      if (v.item_id !== chosenItemId) softDel.run(v.item_id)
    }
  }
  return getContradictionById(contradictionId)
}

export function confirmCompilation(compilationId: string): Compilation | null {
  const db = getDb()
  const row = db.prepare('SELECT id FROM compilations WHERE id = ?').get(compilationId)
  if (!row) return null
  db.prepare("UPDATE compilations SET status = 'finalized', updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    compilationId
  )
  return getCompilationById(compilationId)
}

/** 某汇编的回收站条目（矛盾 + 语义补全/修订，按时间倒序） */
export function listRecycleBinByCompilation(compilationId: string): CompilationRecycleBinItem[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM compilation_recycle_bin WHERE compilation_id = ? ORDER BY created_at DESC')
    .all(compilationId) as { id: string; contradiction_id: string; topic: string; kind: string; status: string; created_at: string }[]
  const contradictions: CompilationRecycleBinItem[] = []
  for (const r of rows) {
    const contradiction = getContradictionById(r.contradiction_id)
    if (!contradiction) continue
    contradictions.push({
      id: r.id,
      compilationId,
      kind: 'contradiction',
      contradictionId: r.contradiction_id,
      topic: r.topic,
      status: r.status === 'resolved' ? 'resolved' : 'ignored',
      createdAt: r.created_at,
      contradiction
    })
  }
  const repairs = listRepairRecycleBinByCompilation(compilationId)
  // 第三类：被删除的资料卡片（快照 + 恢复，含其矛盾变异/语义补全修订）
  const cardRows = db.prepare('SELECT * FROM compilation_card_recycle_bin WHERE compilation_id = ?').all(compilationId) as CardBinRow[]
  const cards: CompilationRecycleBinItem[] = cardRows.map((c) => {
    const srcTitle = loadSourceTitles(c.source_id ? [c.source_id] : []).get(c.source_id ?? '') ?? c.source_id ?? ''
    const item: CompilationItem = {
      id: c.item_id,
      compilationId: c.compilation_id,
      position: c.position,
      sourceId: c.source_id ?? '',
      excerpt: c.excerpt,
      ts: c.ts ?? undefined,
      note: c.note ?? undefined,
      extraTags: parseJsonArray(c.extra_tags),
      kept: c.kept === 1,
      sourceTitle: srcTitle || undefined,
      createdAt: c.created_at
    }
    return {
      id: c.id,
      compilationId,
      kind: 'card',
      itemId: c.item_id,
      excerpt: c.excerpt,
      ts: c.ts ?? undefined,
      sourceTitle: srcTitle || undefined,
      item,
      createdAt: c.deleted_at
    }
  })
  const all: CompilationRecycleBinItem[] = [...contradictions, ...repairs, ...cards]
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/** 从回收站恢复某组矛盾：所有 variant 卡片改回 kept=1，矛盾状态回到 pending，并删除回收站条目 */
export function restoreRecycleBinContradiction(binId: string): CompilationContradiction | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM compilation_recycle_bin WHERE id = ?')
    .get(binId) as { id: string; contradiction_id: string } | undefined
  if (!row) return null
  db.prepare('UPDATE compilation_items SET kept = 1 WHERE id IN (SELECT item_id FROM compilation_contradiction_variants WHERE contradiction_id = ?)').run(row.contradiction_id)
  db.prepare("UPDATE compilation_contradictions SET status = 'pending', chosen_item_id = NULL WHERE id = ?").run(row.contradiction_id)
  db.prepare('DELETE FROM compilation_recycle_bin WHERE id = ?').run(binId)
  return getContradictionById(row.contradiction_id)
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

  function seed(): { taskId: string; sourceIds: string[] } {
    const taskId = crypto.randomUUID()
    db.prepare(`INSERT INTO writing_tasks (id, title, scope_json) VALUES (?, '汇编测试', '{"all":true}')`).run(taskId)
    const s1 = crypto.randomUUID()
    const s2 = crypto.randomUUID()
    db.prepare("INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', '教育发展报告', '正文', 'ready')").run(s1)
    db.prepare("INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', '统计表', '正文', 'ready')").run(s2)
    return { taskId, sourceIds: [s1, s2] }
  }

  describe('compilation store (Phase 6.0)', () => {
    it('creates and reads back a compilation with ordered items and source titles', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '学前教育中的园所设置' })
      expect(c.status).toBe('drafting')
      expect(c.items).toHaveLength(0)

      insertCompilationItems(c.id, [
        { sourceId: sourceIds[0], excerpt: '2005 年全县幼儿园 89 所。', ts: '2005 年' },
        { sourceId: sourceIds[1], excerpt: '2021 年全区幼儿园 212 所。', ts: '2021 年' }
      ])

      const loaded = getCompilationById(c.id)!
      expect(loaded.items).toHaveLength(2)
      expect(loaded.items.map((i) => i.position)).toEqual([0, 1])
      expect(loaded.items.map((i) => i.ts)).toEqual(['2005 年', '2021 年'])
      expect(loaded.items[0].sourceTitle).toBe('教育发展报告')
    })

    it('reorders compilation items by ts (no-ts cards last, 2026-08-28)', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '汇编' })
      insertCompilationItems(c.id, [
        { sourceId: sourceIds[0], excerpt: '2015 年事件', ts: '2015 年' },
        { sourceId: sourceIds[0], excerpt: '无时间戳卡片' },
        { sourceId: sourceIds[0], excerpt: '2020 年事件', ts: '2020 年' },
        { sourceId: sourceIds[0], excerpt: '2017 年事件', ts: '2017 年' }
      ])
      reorderCompilationItemsByTs(c.id)
      const after = getCompilationById(c.id)!
      expect(after.items.map((i) => i.ts)).toEqual(['2015 年', '2017 年', '2020 年', undefined])
      expect(after.items.map((i) => i.position)).toEqual([0, 1, 2, 3])

      // 反序：年份新→旧，无时间戳仍排最后
      reorderCompilationItemsByTs(c.id, 'desc')
      const desc = getCompilationById(c.id)!
      expect(desc.items.map((i) => i.ts)).toEqual(['2020 年', '2017 年', '2015 年', undefined])
      expect(desc.items.map((i) => i.position)).toEqual([0, 1, 2, 3])
    })

    it('deleted card goes to recycle bin and can be restored (2026-08-28)', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '汇编' })
      const items = insertCompilationItems(c.id, [
        { sourceId: sourceIds[0], excerpt: '卡片一', ts: '2015 年' },
        { sourceId: sourceIds[1], excerpt: '卡片二', ts: '2017 年' }
      ])
      deleteCompilationItem(items[0].id)
      expect(getCompilationById(c.id)!.items).toHaveLength(1)

      const bin = listRecycleBinByCompilation(c.id)
      const cardEntry = bin.find((b) => b.kind === 'card')
      expect(cardEntry).toBeDefined()
      expect(cardEntry!.kind).toBe('card')

      const restored = restoreCompilationCardRecycleBin(cardEntry!.id)
      expect(restored).not.toBeNull()
      expect(restored!.excerpt).toBe('卡片一')
      expect(getCompilationById(c.id)!.items).toHaveLength(2)
    })

    it('updates and deletes compilation items', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '汇编' })
      insertCompilationItems(c.id, [{ sourceId: sourceIds[0], excerpt: '原文', ts: '2005 年' }])
      const item = getCompilationById(c.id)!.items[0]

      const updated = updateCompilationItem(item.id, { excerpt: '修订后的摘录', kept: false, extraTags: ['重点'] })!
      expect(updated.excerpt).toBe('修订后的摘录')
      expect(updated.kept).toBe(false)
      expect(updated.extraTags).toEqual(['重点'])

      deleteCompilationItem(item.id)
      expect(getCompilationById(c.id)!.items).toHaveLength(0)
    })

    it('stores contradiction groups with variants and resolves/ignores with ownership check', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '汇编' })
      const items = insertCompilationItems(c.id, [
        { sourceId: sourceIds[0], excerpt: '公办园 76 所', ts: '2021 年' },
        { sourceId: sourceIds[1], excerpt: '公办园 82 所', ts: '2021 年' }
      ])
      const g = insertCompilationContradictions(c.id, [
        {
          topic: '2021 年公办园数量',
          kind: 'data',
          variants: [
            { itemId: items[0].id, variantText: '公办园 76 所', sourceId: sourceIds[0] },
            { itemId: items[1].id, variantText: '公办园 82 所', sourceId: sourceIds[1] }
          ]
        }
      ])[0]
      expect(g.status).toBe('pending')
      expect(g.variants).toHaveLength(2)
      expect(g.variants[0].sourceTitle).toBe('教育发展报告')

      // resolve 必须传属于该矛盾的说法
      expect(updateCompilationContradictionStatus(g.id, 'resolved')).toBeNull()
      expect(updateCompilationContradictionStatus(g.id, 'resolved', 'no-such-item')).toBeNull()
      const resolved = updateCompilationContradictionStatus(g.id, 'resolved', items[1].id)!
      expect(resolved.status).toBe('resolved')
      expect(resolved.chosenItemId).toBe(items[1].id)

      // ignore 清空 chosen
      const ignored = updateCompilationContradictionStatus(g.id, 'ignored')!
      expect(ignored.status).toBe('ignored')
      expect(ignored.chosenItemId).toBeUndefined()
    })
    it('resolving soft-deletes non-chosen cards and pushes to recycle bin; restore reverses (2026-08-25)', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '汇编' })
      const items = insertCompilationItems(c.id, [
        { sourceId: sourceIds[0], excerpt: '公办园 76 所', ts: '2021 年' },
        { sourceId: sourceIds[1], excerpt: '公办园 82 所', ts: '2021 年' },
        { sourceId: sourceIds[1], excerpt: '无关卡片', ts: '2000 年' }
      ])
      const g = insertCompilationContradictions(c.id, [
        {
          topic: '2021 年公办园数量',
          kind: 'data',
          variants: [
            { itemId: items[0].id, variantText: '公办园 76 所', sourceId: sourceIds[0] },
            { itemId: items[1].id, variantText: '公办园 82 所', sourceId: sourceIds[1] }
          ]
        }
      ])[0]
      const resolved = updateCompilationContradictionStatus(g.id, 'resolved', items[1].id)!
      expect(resolved.status).toBe('resolved')
      const after = getCompilationById(c.id)!
      const byId = new Map(after.items.map((it) => [it.id, it]))
      expect(byId.get(items[1].id)!.kept).toBe(true)
      expect(byId.get(items[0].id)!.kept).toBe(false)
      expect(byId.get(items[2].id)!.kept).toBe(true)
      expect(getContradictionById(g.id)!.variants).toHaveLength(2)
      const bin = listRecycleBinByCompilation(c.id)
      expect(bin).toHaveLength(1)
      expect(bin[0].kind === 'contradiction' ? bin[0].topic : '').toBe('2021 年公办园数量')
      const restored = restoreRecycleBinContradiction(bin[0].id)!
      expect(restored.status).toBe('pending')
      expect(restored.chosenItemId).toBeUndefined()
      const after2 = getCompilationById(c.id)!
      expect(after2.items.every((it) => it.kept)).toBe(true)
      expect(after2.items).toHaveLength(3)
    })

    it('cascades compilation data on task delete and confirm marks finalized', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '汇编' })
      insertCompilationItems(c.id, [{ sourceId: sourceIds[0], excerpt: '卡片', ts: '2005 年' }])

      const confirmed = confirmCompilation(c.id)!
      expect(confirmed.status).toBe('finalized')

      db.prepare('DELETE FROM writing_tasks WHERE id = ?').run(taskId)
      expect(getCompilationById(c.id)).toBeNull()
      const count = db
        .prepare('SELECT COUNT(*) AS c FROM compilation_items WHERE compilation_id = ?')
        .get(c.id) as { c: number }
      expect(count.c).toBe(0)
    })

    it('deleteCompilationItemsForSourceIds removes source cards + contradictions + repairs, nothing recyclable (2026-08-28)', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '汇编' })
      const items = insertCompilationItems(c.id, [
        { sourceId: sourceIds[0], excerpt: '公办园 76 所', ts: '2021 年' },
        { sourceId: sourceIds[1], excerpt: '公办园 82 所', ts: '2021 年' },
        { sourceId: sourceIds[0], excerpt: '无关卡片' }
      ])
      const g = insertCompilationContradictions(c.id, [
        {
          topic: '2021 年公办园数量',
          kind: 'data',
          variants: [
            { itemId: items[0].id, variantText: '公办园 76 所', sourceId: sourceIds[0] },
            { itemId: items[1].id, variantText: '公办园 82 所', sourceId: sourceIds[1] }
          ]
        }
      ])[0]
      // 让该矛盾先进入回收站（模拟已被采纳/忽略过），删除后应一并清除
      updateCompilationContradictionStatus(g.id, 'resolved', items[0].id)
      // 给 sourceIds[0] 的卡片加一条语义补全/修订，并快照进回收站（模拟已采纳/拒绝过）
      const repair = insertRepair({
        compilationId: c.id,
        itemId: items[0].id,
        originalText: '公办园 76 所',
        revisedText: '2021 年公办园 76 所。',
        reason: '表意不明'
      })
      db.prepare(
        'INSERT INTO compilation_repair_recycle_bin (id, compilation_id, repair_id, item_id, original_text, revised_text, chosen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(crypto.randomUUID(), c.id, repair.id, items[0].id, '公办园 76 所', '2021 年公办园 76 所。', 'accepted', new Date().toISOString())

      const res = deleteCompilationItemsForSourceIds([sourceIds[0]])
      expect(res.deletedItems).toBe(2) // 来源0 的两张卡
      expect(res.deletedContradictions).toBe(1)
      expect(res.deletedRepairs).toBe(1)

      const after = getCompilationById(c.id)!
      expect(after.items.map((i) => i.excerpt)).toEqual(['公办园 82 所']) // 来源1 的卡保留
      expect(after.contradictions).toHaveLength(0) // 涉及被删卡片的矛盾整组删除
      expect(after.repairs).toHaveLength(0)
      // 不写入回收站：矛盾回收站为空；语义补全回收站（含已快照条目）也清空，避免残留指向已删卡片的条目
      expect(listRepairRecycleBinByCompilation(c.id)).toHaveLength(0)
      expect(listRecycleBinByCompilation(c.id)).toHaveLength(0)
    })
  })
}
