/**
 * compilations.ts —— 资料汇编仓储（Phase 6.0，2026-08-25）。
 * 三段式撰写第一步：compilations（一次汇编）+ compilation_items（资料卡片）+
 * compilation_contradictions / compilation_contradiction_variants（汇编阶段的资料矛盾与取舍）。
 */
import Database from 'better-sqlite3'
import type {
  Compilation,
  CompilationChangeSummary,
  CompilationContradiction,
  CompilationContradictionStatus,
  CompilationItem,
  CompilationMessage,
  CompilationParagraph,
  CompilationParagraphKind,
  CompilationParagraphOrigin,
  CompilationSourceRef,
  CompilationStatus,
  CompilationTimeConfidence,
  CompilationVersion,
  CompilationVersionOrigin,
  CompilationVersionSummary,
  CompilationRecycleBinItem
} from '../../shared/types'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'
import { insertRepair, listRepairsByCompilation } from './compilation-repairs'
import { buildParagraphSnapshot, renderDocumentMarkdown, summarizeParagraphChange } from '../writing/compilation-document'

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
  /* ---- Phase 7.1（Migration 030）新增列：旧数据迁移后同样存在 ---- */
  year: number | null
  month: number | null
  day: number | null
  time_confidence: CompilationTimeConfidence | null
  source_ordinal: number | null
  evidence: string | null
  origin: CompilationParagraphOrigin | null
  revision: number | null
  kind: CompilationParagraphKind | null
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
    createdAt: row.created_at,
    year: row.year ?? undefined,
    month: row.month ?? undefined,
    day: row.day ?? undefined,
    timeConfidence: row.time_confidence ?? undefined,
    sourceOrdinal: row.source_ordinal ?? undefined,
    evidence: row.evidence ?? undefined,
    origin: row.origin ?? undefined,
    revision: row.revision ?? undefined,
    kind: row.kind ?? undefined
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
  /**
   * 该卡片的「大模型修正」记录（生成管线在内存阶段算出，随卡片一起流转）。
   * 与卡片**同事务**写入 compilation_repairs（status='applied'），因此在 mapOutputItemsToInputs 过滤、
   * sortItemsByTs 重排之后仍与卡片严格对应，不会错位（这是徽标归属正确的关键）。
   */
  repair?: { originalText: string; revisedText: string; reason: string }
}

/** 批量写入资料卡片（事务，按传入顺序编号 position）；卡片携带的大模型修正记录一并写入。 */
export function insertCompilationItems(compilationId: string, inputs: CompilationItemInput[]): CompilationItem[] {
  const db = getDb()
  if (inputs.length === 0) return []
  const now = new Date().toISOString()
  const ins = db.prepare(
    'INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, ts, note, extra_tags, kept, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
  )
  const tx = db.transaction(() => {
    inputs.forEach((it, i) => {
      const itemId = crypto.randomUUID()
      ins.run(
        itemId,
        compilationId,
        i,
        it.sourceId,
        it.excerpt,
        it.ts ?? null,
        it.note ?? null,
        JSON.stringify(it.extraTags ?? []),
        now
      )
      if (it.repair && it.repair.revisedText !== it.repair.originalText) {
        insertRepair({
          compilationId,
          itemId,
          originalText: it.repair.originalText,
          revisedText: it.repair.revisedText,
          reason: it.repair.reason
        })
      }
    })
  })
  tx()
  return getItemsByCompilation(compilationId)
}

/** 删除某汇编的全部资料卡片（硬删除，不进回收站；用于生成/续跑时整体替换中间产物）。 */
export function deleteCompilationItems(compilationId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM compilation_items WHERE compilation_id = ?').run(compilationId)
}

/** 用目标卡片整体替换某汇编的卡片（先删后插）；返回插入后的卡片。用于生成/续跑把中间/最终产物落库。 */
export function replaceCompilationItems(compilationId: string, inputs: CompilationItemInput[]): CompilationItem[] {
  deleteCompilationItems(compilationId)
  return insertCompilationItems(compilationId, inputs)
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

/** 把一张卡片（及其矛盾变异、大模型修正记录）快照进回收站，供恢复。返回是否成功入站。 */
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
  // 删除前快照进回收站（第二类：资料卡片），允许恢复
  snapshotCardToRecycleBin(itemId)
  db.prepare('DELETE FROM compilation_items WHERE id = ?').run(itemId)
}

/** 从回收站恢复一张被删除的资料卡片（含其矛盾变异与大模型修正记录），并删除回收站条目。 */
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
 * 并同步删除涉及这些卡片的**矛盾分组**（及其变异/回收站）与**大模型修正记录**。
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
    // compilation_repairs（大模型修正记录）随 item_id 级联删除；矛盾分组（含变异/回收站）随 contradiction_id 级联删除。
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
 * 矛盾分组（含变异/回收站）与大模型修正记录，硬删除修正记录不入回收站；若某汇编因此清空则回 drafting。
 */
export function deleteCompilationItemsByIds(itemIds: string[]): DeleteSourceItemsResult {
  const db = getDb()
  if (itemIds.length === 0) return { deletedItems: 0, deletedContradictions: 0, deletedRepairs: 0 }
  // 删除前把每张卡快照进回收站（第二类：资料卡片），允许恢复
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
    // compilation_repairs 随 item_id 级联删除（无需显式清理）
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

/**
 * 某汇编的回收站条目（2026-09-08 起仅两类：被删除的资料卡片 + 已取舍的矛盾，按时间倒序）。
 * 「大模型修正」不再进入回收站——由卡片上的标记承载（点开可查看原文/理由并回退）。
 */
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
  // 第二类：被删除的资料卡片（快照 + 恢复，含其矛盾变异与大模型修正记录）
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
  const all: CompilationRecycleBinItem[] = [...contradictions, ...cards]
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

/** 列出「生成汇编」功能区完成后(finalized)的汇编任务，供「撰写初稿」导入选择 */
export function listFinalizedCompilationsForImport(): { taskId: string; taskTitle: string; compilation: Compilation }[] {
  const db = getDb()
  const rows = db
    .prepare(`
      SELECT c.id AS cid, c.task_id AS task_id, c.title AS ctitle, t.title AS task_title
      FROM compilations c
      JOIN writing_tasks t ON t.id = c.task_id
      WHERE t.mode = 'compile' AND c.status = 'finalized'
      ORDER BY c.updated_at DESC
    `).all() as { cid: string; task_id: string; ctitle: string; task_title: string }[]
  const out: { taskId: string; taskTitle: string; compilation: Compilation }[] = []
  for (const r of rows) {
    const comp = getCompilationById(r.cid)
    if (comp) out.push({ taskId: r.task_id, taskTitle: r.task_title, compilation: comp })
  }
  return out
}

/** 把一份资料汇编深拷贝到指定任务（用于「撰写初稿」从「生成汇编」导入）。目标任务与源任务须不同。 */
export function importCompilationIntoTask(taskId: string, source: Compilation): Compilation {
  const db = getDb()
  const now = new Date().toISOString()
  const newCompId = crypto.randomUUID()
  db.prepare("INSERT INTO compilations (id, task_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(newCompId, taskId, source.title, `finalized`, now, now)

  const itemIdMap = new Map<string, string>()
  const insItem = db.prepare("INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, ts, note, extra_tags, kept, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  const insC = db.prepare("INSERT INTO compilation_contradictions (id, compilation_id, topic, kind, status, chosen_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
  const insV = db.prepare("INSERT INTO compilation_contradiction_variants (id, contradiction_id, item_id, variant_text, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
  const insR = db.prepare("INSERT INTO compilation_repairs (id, compilation_id, item_id, original_text, revised_text, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
  const tx = db.transaction(() => {
    source.items.forEach((it, i) => {
      const nid = crypto.randomUUID()
      itemIdMap.set(it.id, nid)
      insItem.run(nid, newCompId, i, it.sourceId, it.excerpt, it.ts ?? null, it.note ?? null, JSON.stringify(it.extraTags ?? []), it.kept ? 1 : 0, it.createdAt || now)
    })
    for (const c of source.contradictions) {
      const ncid = crypto.randomUUID()
      const chosen = c.chosenItemId ? itemIdMap.get(c.chosenItemId) ?? null : null
      insC.run(ncid, newCompId, c.topic, c.kind, c.status, chosen, c.createdAt || now)
      for (const v of c.variants) {
        insV.run(crypto.randomUUID(), ncid, itemIdMap.get(v.itemId) ?? '', v.variantText, v.sourceId, v.createdAt || now)
      }
    }
    for (const r of (source.repairs ?? [])) {
      insR.run(crypto.randomUUID(), newCompId, itemIdMap.get(r.itemId) ?? '', r.originalText, r.revisedText, r.reason, r.status, r.createdAt || now, r.updatedAt || now)
    }
  })
  tx()
  return getCompilationById(newCompId)!
}

// ============================================================
// Phase 7.1（2026-09-10）：连续文档模型 —— 来源编号表 / 段落 upsert / 版本历史 / 汇编级对话
// ============================================================

/** 段落写入入参（含可选 id：给了就复用，**段 id 稳定**是新模型的硬前提） */
export interface CompilationParagraphInput {
  id?: string
  sourceId: string
  text: string
  timeLabel?: string
  year?: number
  month?: number
  day?: number
  timeConfidence?: CompilationTimeConfidence
  sourceOrdinal?: number
  evidence?: string
  origin?: CompilationParagraphOrigin
  revision?: number
  kind?: CompilationParagraphKind
  note?: string
  extraTags?: string[]
  kept?: boolean
}

interface CompilationSourceRow {
  id: string
  compilation_id: string
  source_id: string | null
  ordinal: number
  title: string
  cited_count: number
}

function mapSourceRef(row: CompilationSourceRow): CompilationSourceRef {
  return {
    id: row.id,
    compilationId: row.compilation_id,
    sourceId: row.source_id ?? undefined,
    ordinal: row.ordinal,
    title: row.title,
    citedCount: row.cited_count
  }
}

/** 列出某汇编的来源编号表（按 ordinal 升序） */
export function listCompilationSources(compilationId: string): CompilationSourceRef[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM compilation_sources WHERE compilation_id = ? ORDER BY ordinal ASC')
    .all(compilationId) as CompilationSourceRow[]
  return rows.map(mapSourceRef)
}

/**
 * 按「文档中首次被引用」的顺序补齐来源编号（纯函数逻辑 + 落库）：
 * 已有编号的来源保持不变（**编号只增不回收**，避免历史版本与正文中的编号漂移），
 * 新出现的来源追加到末尾。返回最新的编号表。
 */
export function ensureCompilationSources(compilationId: string, ordered: { sourceId: string; title: string }[]): CompilationSourceRef[] {
  const db = getDb()
  const existing = listCompilationSources(compilationId)
  const bySource = new Map(existing.filter((s) => s.sourceId).map((s) => [s.sourceId as string, s]))
  let nextOrdinal = existing.reduce((max, s) => Math.max(max, s.ordinal), 0)
  const ins = db.prepare(
    'INSERT INTO compilation_sources (id, compilation_id, source_id, ordinal, title, cited_count, created_at) VALUES (?,?,?,?,?,0,?)'
  )
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    for (const o of ordered) {
      if (!o.sourceId || bySource.has(o.sourceId)) continue
      nextOrdinal += 1
      const id = crypto.randomUUID()
      ins.run(id, compilationId, o.sourceId, nextOrdinal, o.title || o.sourceId, now)
      bySource.set(o.sourceId, { id, compilationId, sourceId: o.sourceId, ordinal: nextOrdinal, title: o.title || o.sourceId, citedCount: 0 })
    }
    // 引用计数（用于"删除来源影响多少段"的提示）
    db.prepare(
      'UPDATE compilation_sources SET cited_count = (SELECT COUNT(*) FROM compilation_items i WHERE i.compilation_id = compilation_sources.compilation_id AND i.source_id = compilation_sources.source_id) WHERE compilation_id = ?'
    ).run(compilationId)
  })
  tx()
  return listCompilationSources(compilationId)
}

/**
 * 用目标段落整体替换某汇编的段落，但**保留段 id**（Phase 7.1 的核心改动）：
 * - 传入 `id` 且该行仍属本汇编 → UPDATE（id 不变，矛盾 variants / evidence / 版本快照继续有效）；
 * - 未传或已不存在 → INSERT 新行；
 * - 目标集合中不再出现的段落 → DELETE。
 * 与旧的 `replaceCompilationItems`（先删后插、id 全变）不同，本函数保证 id 稳定。
 */
export function upsertCompilationParagraphs(compilationId: string, inputs: CompilationParagraphInput[]): CompilationItem[] {
  const db = getDb()
  const now = new Date().toISOString()
  const existingRows = db
    .prepare('SELECT id FROM compilation_items WHERE compilation_id = ?')
    .all(compilationId) as { id: string }[]
  const existingIds = new Set(existingRows.map((r) => r.id))
  const keepIds = new Set<string>()
  const ins = db.prepare(
    `INSERT INTO compilation_items
      (id, compilation_id, position, source_id, excerpt, ts, note, extra_tags, kept, created_at,
       year, month, day, time_confidence, source_ordinal, evidence, origin, revision, kind)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  const upd = db.prepare(
    `UPDATE compilation_items SET position = ?, source_id = ?, excerpt = ?, ts = ?, note = ?, extra_tags = ?, kept = ?,
       year = ?, month = ?, day = ?, time_confidence = ?, source_ordinal = ?, evidence = ?, origin = ?, revision = ?, kind = ?
     WHERE id = ?`
  )
  const tx = db.transaction(() => {
    inputs.forEach((it, i) => {
      const confidence = it.timeConfidence ?? (it.year != null ? 'exact' : 'unknown')
      const origin = it.origin ?? 'generate'
      const kind = it.kind ?? 'paragraph'
      const revision = it.revision ?? 1
      const note = it.note ?? null
      const tags = JSON.stringify(it.extraTags ?? [])
      const kept = it.kept === false ? 0 : 1
      if (it.id && existingIds.has(it.id)) {
        keepIds.add(it.id)
        upd.run(
          i,
          it.sourceId,
          it.text,
          it.timeLabel ?? null,
          note,
          tags,
          kept,
          it.year ?? null,
          it.month ?? null,
          it.day ?? null,
          confidence,
          it.sourceOrdinal ?? null,
          it.evidence ?? null,
          origin,
          revision,
          kind,
          it.id
        )
      } else {
        const id = it.id ?? crypto.randomUUID()
        keepIds.add(id)
        ins.run(
          id,
          compilationId,
          i,
          it.sourceId,
          it.text,
          it.timeLabel ?? null,
          note,
          tags,
          kept,
          now,
          it.year ?? null,
          it.month ?? null,
          it.day ?? null,
          confidence,
          it.sourceOrdinal ?? null,
          it.evidence ?? null,
          origin,
          revision,
          kind
        )
      }
    })
    for (const id of existingIds) {
      if (!keepIds.has(id)) db.prepare('DELETE FROM compilation_items WHERE id = ?').run(id)
    }
  })
  tx()
  return getItemsByCompilation(compilationId)
}

interface CompilationVersionRow {
  id: string
  compilation_id: string
  version_no: number
  paragraphs: string
  markdown: string
  origin: CompilationVersionOrigin
  instruction: string | null
  reply: string | null
  change_summary: string
  base_version_no: number | null
  created_at: string
}

function parseChangeSummary(raw: string): CompilationChangeSummary {
  try {
    const v = JSON.parse(raw) as Partial<CompilationChangeSummary>
    return {
      added: Number(v.added ?? 0),
      removed: Number(v.removed ?? 0),
      modified: Number(v.modified ?? 0),
      moved: Number(v.moved ?? 0),
      paragraphIds: Array.isArray(v.paragraphIds) ? v.paragraphIds.filter((x): x is string => typeof x === 'string') : []
    }
  } catch {
    return { added: 0, removed: 0, modified: 0, moved: 0, paragraphIds: [] }
  }
}

function mapVersionSummary(row: CompilationVersionRow): CompilationVersionSummary {
  return {
    id: row.id,
    compilationId: row.compilation_id,
    versionNo: row.version_no,
    origin: row.origin,
    instruction: row.instruction ?? undefined,
    reply: row.reply ?? undefined,
    changeSummary: parseChangeSummary(row.change_summary),
    baseVersionNo: row.base_version_no ?? undefined,
    createdAt: row.created_at
  }
}

export function listCompilationVersions(compilationId: string): CompilationVersionSummary[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM compilation_versions WHERE compilation_id = ? ORDER BY version_no ASC')
    .all(compilationId) as CompilationVersionRow[]
  return rows.map(mapVersionSummary)
}

export function getLatestCompilationVersion(compilationId: string): CompilationVersion | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM compilation_versions WHERE compilation_id = ? ORDER BY version_no DESC LIMIT 1')
    .get(compilationId) as CompilationVersionRow | undefined
  return row ? mapVersion(row) : null
}

export function getCompilationVersion(compilationId: string, versionNo: number): CompilationVersion | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM compilation_versions WHERE compilation_id = ? AND version_no = ?')
    .get(compilationId, versionNo) as CompilationVersionRow | undefined
  return row ? mapVersion(row) : null
}

function mapVersion(row: CompilationVersionRow): CompilationVersion {
  let paragraphs: CompilationParagraph[] = []
  try {
    const v = JSON.parse(row.paragraphs) as unknown
    if (Array.isArray(v)) paragraphs = v as CompilationParagraph[]
  } catch {
    paragraphs = []
  }
  return { ...mapVersionSummary(row), paragraphs, markdown: row.markdown }
}

export interface InsertCompilationVersionInput {
  compilationId: string
  paragraphs: CompilationParagraph[]
  origin: CompilationVersionOrigin
  instruction?: string
  reply?: string
  /** 基线版本号（乐观锁与"相对哪一版"的记录） */
  baseVersionNo?: number
  /** 省略时按 `paragraphs` 与上一版本自动统计 */
  changeSummary?: CompilationChangeSummary
  createdAt?: string
}

/** 追加一个版本（version_no 自增）；markdown 由段落渲染（一段一行）。返回新版本摘要。 */
export function insertCompilationVersion(input: InsertCompilationVersionInput): CompilationVersionSummary {
  const db = getDb()
  const latest = db
    .prepare('SELECT version_no, paragraphs FROM compilation_versions WHERE compilation_id = ? ORDER BY version_no DESC LIMIT 1')
    .get(input.compilationId) as { version_no: number; paragraphs: string } | undefined
  const versionNo = (latest?.version_no ?? 0) + 1
  let summary = input.changeSummary
  if (!summary) {
    let prev: CompilationParagraph[] = []
    try {
      const v = JSON.parse(latest?.paragraphs ?? '[]') as unknown
      if (Array.isArray(v)) prev = v as CompilationParagraph[]
    } catch {
      prev = []
    }
    summary = summarizeParagraphChange(prev, input.paragraphs)
  }
  const id = crypto.randomUUID()
  const markdown = renderDocumentMarkdown(input.paragraphs)
  db.prepare(
    `INSERT INTO compilation_versions
      (id, compilation_id, version_no, paragraphs, markdown, origin, instruction, reply, change_summary, base_version_no, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    input.compilationId,
    versionNo,
    JSON.stringify(input.paragraphs),
    markdown,
    input.origin,
    input.instruction ?? null,
    input.reply ?? null,
    JSON.stringify(summary),
    input.baseVersionNo ?? (latest?.version_no ?? null),
    input.createdAt ?? new Date().toISOString()
  )
  return {
    id,
    compilationId: input.compilationId,
    versionNo,
    origin: input.origin,
    instruction: input.instruction,
    reply: input.reply,
    changeSummary: summary,
    baseVersionNo: input.baseVersionNo ?? (latest?.version_no ?? undefined),
    createdAt: input.createdAt ?? new Date().toISOString()
  }
}

/** 以当前段落为内容建版本（供生成/编辑落库后统一调用） */
export function snapshotCompilationVersion(
  compilationId: string,
  origin: CompilationVersionOrigin,
  extra?: { instruction?: string; reply?: string; baseVersionNo?: number }
): CompilationVersionSummary | null {
  const items = getItemsByCompilation(compilationId)
  if (items.length === 0) return null
  const sources = listCompilationSources(compilationId)
  const refsBySourceId = new Map(sources.filter((s) => s.sourceId).map((s) => [s.sourceId as string, s]))
  return insertCompilationVersion({
    compilationId,
    paragraphs: buildParagraphSnapshot(items, refsBySourceId),
    origin,
    instruction: extra?.instruction,
    reply: extra?.reply,
    baseVersionNo: extra?.baseVersionNo
  })
}

interface CompilationMessageRow {
  id: string
  compilation_id: string
  role: 'user' | 'assistant'
  content: string
  version_no: number | null
  applied: string | null
  rejected: string | null
  created_at: string
}

export function listCompilationMessages(compilationId: string): CompilationMessage[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM compilation_messages WHERE compilation_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(compilationId) as CompilationMessageRow[]
  return rows.map((r) => ({
    id: r.id,
    compilationId: r.compilation_id,
    role: r.role,
    content: r.content,
    versionNo: r.version_no ?? undefined,
    createdAt: r.created_at
  }))
}

export function insertCompilationMessage(input: {
  compilationId: string
  role: 'user' | 'assistant'
  content: string
  versionNo?: number
  applied?: unknown
  rejected?: unknown
}): CompilationMessage {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO compilation_messages (id, compilation_id, role, content, version_no, applied, rejected, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    id,
    input.compilationId,
    input.role,
    input.content,
    input.versionNo ?? null,
    input.applied === undefined ? null : JSON.stringify(input.applied),
    input.rejected === undefined ? null : JSON.stringify(input.rejected),
    now
  )
  return { id, compilationId: input.compilationId, role: input.role, content: input.content, versionNo: input.versionNo, createdAt: now }
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
      // 给 sourceIds[0] 的卡片加一条大模型修正记录（已应用）
      insertRepair({
        compilationId: c.id,
        itemId: items[0].id,
        originalText: '公办园 76 所',
        revisedText: '2021 年公办园 76 所。',
        reason: '表意不明'
      })

      const res = deleteCompilationItemsForSourceIds([sourceIds[0]])
      expect(res.deletedItems).toBe(2) // 来源0 的两张卡
      expect(res.deletedContradictions).toBe(1)
      expect(res.deletedRepairs).toBe(1)

      const after = getCompilationById(c.id)!
      expect(after.items.map((i) => i.excerpt)).toEqual(['公办园 82 所']) // 来源1 的卡保留
      expect(after.contradictions).toHaveLength(0) // 涉及被删卡片的矛盾整组删除
      expect(after.repairs).toHaveLength(0)
      // 不写入回收站：矛盾回收站为空；修正记录随卡片级联删除（不再有独立回收站表）
      expect(listRecycleBinByCompilation(c.id)).toHaveLength(0)
    })

    it('recycle bin holds only deleted cards and resolved contradictions (2026-09-08: 大模型修正不再入回收站)', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '汇编' })
      const items = insertCompilationItems(c.id, [
        { sourceId: sourceIds[0], excerpt: '公办园 76 所', ts: '2021 年' },
        { sourceId: sourceIds[1], excerpt: '公办园 82 所', ts: '2021 年' }
      ])
      insertRepair({ compilationId: c.id, itemId: items[0].id, originalText: '公办园 76 所', revisedText: '修正后', reason: '表意不明' })
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
      updateCompilationContradictionStatus(g.id, 'ignored')
      deleteCompilationItem(items[0].id)

      const bin = listRecycleBinByCompilation(c.id)
      expect(bin.map((b) => b.kind).sort()).toEqual(['card', 'contradiction'])
    })

    it('writes the card repair in the same transaction, mapped to the right card (2026-09-08)', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '汇编' })
      const items = insertCompilationItems(c.id, [
        {
          sourceId: sourceIds[0],
          excerpt: '2021 年公办园 76 所',
          ts: '2021 年',
          repair: { originalText: '公办园 76 所', revisedText: '2021 年公办园 76 所', reason: '缺少年份' }
        },
        { sourceId: sourceIds[1], excerpt: '2005 年全县幼儿园 89 所。', ts: '2005 年' }
      ])
      const loaded = getCompilationById(c.id)!
      const repairs = loaded.repairs ?? []
      expect(repairs).toHaveLength(1)
      expect(repairs[0].status).toBe('applied')
      expect(repairs[0].itemId).toBe(items[0].id) // 修正记录与卡片严格对应
      expect(repairs[0].originalText).toBe('公办园 76 所')
      expect(loaded.items[0].excerpt).toBe('2021 年公办园 76 所')
      // 卡片按时间重排后，修正记录仍指向原卡片（item id 不变）
      reorderCompilationItemsByTs(c.id, 'desc')
      const after = getCompilationById(c.id)!
      expect(after.repairs![0].itemId).toBe(items[0].id)
      expect(after.items.map((i) => i.excerpt)).toEqual(['2021 年公办园 76 所', '2005 年全县幼儿园 89 所。'])
    })
  })

  describe('compilation document store (Phase 7.1)', () => {
    it('assigns source ordinals by first reference and keeps them stable on re-assign', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '高中教育' })
      insertCompilationItems(c.id, [
        { sourceId: sourceIds[1], excerpt: '甲', ts: '2018 年' },
        { sourceId: sourceIds[0], excerpt: '乙', ts: '2019 年' },
        { sourceId: sourceIds[1], excerpt: '丙', ts: '2020 年' }
      ])
      const first = ensureCompilationSources(c.id, [
        { sourceId: sourceIds[1], title: '统计表' },
        { sourceId: sourceIds[0], title: '教育发展报告' }
      ])
      expect(first.map((s) => [s.ordinal, s.title])).toEqual([
        [1, '统计表'],
        [2, '教育发展报告']
      ])
      expect(first[0].citedCount).toBe(2)
      // 再次调用不会重排/回收编号，且新增来源追加到末尾
      const s3 = crypto.randomUUID()
      db.prepare("INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', '年鉴', '正文', 'ready')").run(s3)
      const second = ensureCompilationSources(c.id, [
        { sourceId: sourceIds[0], title: '教育发展报告' },
        { sourceId: s3, title: '年鉴' }
      ])
      expect(second.map((s) => [s.ordinal, s.title])).toEqual([
        [1, '统计表'],
        [2, '教育发展报告'],
        [3, '年鉴']
      ])
    })

    it('upserts paragraphs keeping existing ids and deleting the ones no longer present', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '高中教育' })
      const items = insertCompilationItems(c.id, [
        { sourceId: sourceIds[0], excerpt: '甲段', ts: '2018 年' },
        { sourceId: sourceIds[1], excerpt: '乙段', ts: '2019 年' }
      ])
      const keepId = items[0].id
      const after = upsertCompilationParagraphs(c.id, [
        // 复用第一段 id 并改写正文 → id 必须保持不变（矛盾/证据/版本快照都依赖它）
        {
          id: keepId,
          sourceId: sourceIds[0],
          text: '甲段（已整合）',
          timeLabel: '2018 年 5 月',
          year: 2018,
          month: 5,
          timeConfidence: 'exact',
          sourceOrdinal: 2,
          evidence: '甲段',
          origin: 'llm-edit',
          revision: 2
        },
        // 新增一段（无 id → 新分配）
        { sourceId: sourceIds[1], text: '丙段', timeLabel: '2020 年', year: 2020, timeConfidence: 'exact', sourceOrdinal: 1 }
        // 第二段（乙段）不再出现 → 被删除
      ])
      expect(after).toHaveLength(2)
      expect(after[0].id).toBe(keepId)
      expect(after[0].excerpt).toBe('甲段（已整合）')
      expect(after[0].year).toBe(2018)
      expect(after[0].month).toBe(5)
      expect(after[0].sourceOrdinal).toBe(2)
      expect(after[0].origin).toBe('llm-edit')
      expect(after[0].revision).toBe(2)
      expect(after[1].excerpt).toBe('丙段')
      expect(after[1].sourceOrdinal).toBe(1)
      expect(after.map((i) => i.position)).toEqual([0, 1])
      // 旧 id 集合里被移除的那段确实删掉了
      expect(after.some((i) => i.id === items[1].id)).toBe(false)
    })

    it('writes versions with auto change summary and lists them in order', () => {
      const { taskId, sourceIds } = seed()
      const c = createCompilation({ taskId, title: '高中教育' })
      insertCompilationItems(c.id, [{ sourceId: sourceIds[0], excerpt: '甲段', ts: '2018 年' }])
      ensureCompilationSources(c.id, [{ sourceId: sourceIds[0], title: '教育发展报告' }])

      const v1 = snapshotCompilationVersion(c.id, 'generate')!
      expect(v1.versionNo).toBe(1)
      expect(v1.changeSummary.added).toBe(1)
      expect(getLatestCompilationVersion(c.id)!.paragraphs[0].text).toBe('甲段')
      expect(getLatestCompilationVersion(c.id)!.paragraphs[0].sourceOrdinal).toBe(1)
      expect(getLatestCompilationVersion(c.id)!.markdown).toBe('2018 年　甲段')

      insertCompilationItems(c.id, [{ sourceId: sourceIds[1], excerpt: '乙段', ts: '2019 年' }])
      const v2 = snapshotCompilationVersion(c.id, 'llm-edit', { instruction: '补一段', reply: '已补充' })!
      expect(v2.versionNo).toBe(2)
      expect(v2.changeSummary.added).toBe(1)
      expect(v2.changeSummary.modified).toBe(0)
      expect(v2.baseVersionNo).toBe(1)

      const versions = listCompilationVersions(c.id)
      expect(versions.map((v) => v.versionNo)).toEqual([1, 2])
      expect(versions[1].origin).toBe('llm-edit')
      expect(versions[1].instruction).toBe('补一段')
      const loadedV1 = getCompilationVersion(c.id, 1)!
      expect(loadedV1.paragraphs).toHaveLength(1)
      expect(loadedV1.markdown).toBe('2018 年　甲段')
    })

    it('stores compilation-level chat messages in order', () => {
      const { taskId } = seed()
      const c = createCompilation({ taskId, title: '高中教育' })
      insertCompilationMessage({ compilationId: c.id, role: 'user', content: '删掉校区建设内容' })
      insertCompilationMessage({
        compilationId: c.id,
        role: 'assistant',
        content: '已删除 3 段',
        versionNo: 2,
        applied: [{ op: 'delete', ids: ['p1'] }],
        rejected: []
      })
      const msgs = listCompilationMessages(c.id)
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(msgs[1].versionNo).toBe(2)
      expect(msgs[0].content).toBe('删掉校区建设内容')
    })
  })
}
