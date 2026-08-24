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
  CompilationStatus
} from '../../shared/types'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

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
    contradictions: getContradictionsByCompilation(row.id)
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
      contradictions: []
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

export function deleteCompilationItem(itemId: string): void {
  getDb().prepare('DELETE FROM compilation_items WHERE id = ?').run(itemId)
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
  })
}
