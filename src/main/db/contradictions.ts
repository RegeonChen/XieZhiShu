/**
 * contradictions.ts —— 初稿矛盾检测数据仓储（Phase 3.7 Task 3.7.1）。
 * draft_contradictions（矛盾分组：同一"事实主题"一个分组，seq 与生成提示词序号 #N 对应）+
 * contradiction_variants（组内每条相左"说法"，source_ids 为 JSON 数组，支持同主题 3+ 来源）。
 */
import Database from 'better-sqlite3'
import type {
  Contradiction,
  ContradictionInput,
  ContradictionKind,
  ContradictionStatus,
  ContradictionVariant
} from '../../shared/types'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

interface ContradictionRow {
  id: string
  draft_id: string
  seq: number
  topic: string
  kind: ContradictionKind
  status: ContradictionStatus
  merged: number
  draft_quote: string | null
  adopted_variant_id: string | null
  in_draft: number | null
  created_at: string
}

interface VariantRow {
  id: string
  contradiction_id: string
  variant_text: string
  source_ids: string
  position: string | null
  replacement: string | null
}

function parseSourceIds(raw: string): string[] {
  try {
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 批量加载来源标题（缺失时回退为 sourceId，便于界面仍能展示条目） */
function loadSourceTitles(sourceIds: string[]): Map<string, string> {
  const db = getDb()
  const unique = [...new Set(sourceIds)]
  const titles = new Map<string, string>()
  if (unique.length === 0) return titles
  const placeholders = unique.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, title FROM sources WHERE id IN (${placeholders})`)
    .all(...unique) as { id: string; title: string }[]
  for (const r of rows) titles.set(r.id, r.title)
  return titles
}

function mapVariant(row: VariantRow, titles: Map<string, string>): ContradictionVariant {
  const ids = parseSourceIds(row.source_ids)
  return {
    id: row.id,
    contradictionId: row.contradiction_id,
    variantText: row.variant_text,
    sourceIds: ids,
    position: row.position ?? undefined,
    sourceTitles: ids.map((id) => titles.get(id) ?? id),
    replacement: row.replacement ?? undefined
  }
}

function mapContradiction(row: ContradictionRow, variants: ContradictionVariant[]): Contradiction {
  return {
    id: row.id,
    draftId: row.draft_id,
    seq: row.seq,
    topic: row.topic,
    kind: row.kind,
    status: row.status,
    merged: row.merged === 1,
    draftQuote: row.draft_quote ?? undefined,
    adoptedVariantId: row.adopted_variant_id ?? undefined,
    inDraft: row.in_draft === null ? undefined : row.in_draft === 1,
    createdAt: row.created_at,
    variants
  }
}

/** 读取单个矛盾分组（含说法与来源标题）；采纳修订等复用 */
export function getContradictionById(id: string): Contradiction | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM draft_contradictions WHERE id = ?').get(id) as ContradictionRow | undefined
  if (!row) return null
  const variantRows = db
    .prepare('SELECT * FROM contradiction_variants WHERE contradiction_id = ? ORDER BY rowid ASC')
    .all(id) as VariantRow[]
  const titles = loadSourceTitles(variantRows.flatMap((v) => parseSourceIds(v.source_ids)))
  return mapContradiction(row, variantRows.map((v) => mapVariant(v, titles)))
}

/**
 * 读取某稿的全部矛盾分组（按 seq 升序，含说法与来源标题）。
 * 生成链路落库与前端"矛盾清单/弹窗"均走此函数。
 */
export function getContradictionsByDraft(draftId: string): Contradiction[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM draft_contradictions WHERE draft_id = ? ORDER BY seq ASC')
    .all(draftId) as ContradictionRow[]
  if (rows.length === 0) return []
  const variantRows = db
    .prepare(
      `SELECT cv.* FROM contradiction_variants cv
       JOIN draft_contradictions dc ON dc.id = cv.contradiction_id
       WHERE dc.draft_id = ? ORDER BY dc.seq ASC, cv.rowid ASC`
    )
    .all(draftId) as VariantRow[]
  const byGroup = new Map<string, VariantRow[]>()
  for (const v of variantRows) {
    const list = byGroup.get(v.contradiction_id) ?? []
    list.push(v)
    byGroup.set(v.contradiction_id, list)
  }
  const titles = loadSourceTitles(variantRows.flatMap((v) => parseSourceIds(v.source_ids)))
  return rows.map((r) => mapContradiction(r, (byGroup.get(r.id) ?? []).map((v) => mapVariant(v, titles))))
}

/**
 * 批量写入一组矛盾（预扫描产出，随初稿落库，事务）。
 * 返回写入后的完整矛盾列表（读回，便于生成链路直接返回给前端）。
 */
export function insertContradictions(draftId: string, inputs: ContradictionInput[]): Contradiction[] {
  const db = getDb()
  if (inputs.length === 0) return []
  const now = new Date().toISOString()
  const insertC = db.prepare(
    "INSERT INTO draft_contradictions (id, draft_id, seq, topic, kind, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
  )
  const insertV = db.prepare(
    'INSERT INTO contradiction_variants (id, contradiction_id, variant_text, source_ids, position, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const tx = db.transaction(() => {
    for (const input of inputs) {
      const cid = crypto.randomUUID()
      insertC.run(cid, draftId, input.seq, input.topic, input.kind ?? 'other', now)
      for (const v of input.variants) {
        insertV.run(crypto.randomUUID(), cid, v.variantText, JSON.stringify(v.sourceIds), v.position ?? null, now)
      }
    }
  })
  tx()
  return getContradictionsByDraft(draftId)
}

/**
 * 更新矛盾取舍状态（Phase 3.7 Task 3.7.4 弹窗操作）：
 * - status='adopted'：必须传入属于该矛盾的 adoptedVariantId（否则拒绝返回 null）；记录被采纳的说法。
 * - status='ignored'：清空已采纳说法。
 * 不存在返回 null。
 */
export function updateContradictionStatus(
  contradictionId: string,
  status: ContradictionStatus,
  adoptedVariantId?: string
): Contradiction | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM draft_contradictions WHERE id = ?').get(contradictionId) as
    | ContradictionRow
    | undefined
  if (!row) return null

  let adopted: string | null = null
  if (status === 'adopted') {
    if (!adoptedVariantId) return null
    const belongs = db
      .prepare('SELECT id FROM contradiction_variants WHERE id = ? AND contradiction_id = ?')
      .get(adoptedVariantId, contradictionId)
    if (!belongs) return null
    adopted = adoptedVariantId
  }

  db.prepare('UPDATE draft_contradictions SET status = ?, adopted_variant_id = ? WHERE id = ?').run(
    status,
    adopted,
    contradictionId
  )
  return getContradictionById(contradictionId)
}

/**
 * 回填定位审查结果（生成后审查）：draft_quote 为正文中涉及该矛盾的原文原句（用于正文定位与采纳修订的 from），
 * merged 标记正文是否自然合并了矛盾说法（兜底提示）；inDraft=是否在正文中发现该矛盾
 * （true=矛盾 / false=不在正文→警告 / 缺省=定位审查未执行）。不存在返回 null。
 */
export function updateContradictionQuote(
  contradictionId: string,
  draftQuote: string | null,
  merged: boolean,
  inDraft?: boolean
): Contradiction | null {
  const db = getDb()
  const row = db.prepare('SELECT id FROM draft_contradictions WHERE id = ?').get(contradictionId)
  if (!row) return null
  db.prepare('UPDATE draft_contradictions SET draft_quote = ?, merged = ?, in_draft = ? WHERE id = ?').run(
    draftQuote,
    merged ? 1 : 0,
    inDraft === undefined ? null : inDraft ? 1 : 0,
    contradictionId
  )
  return getContradictionById(contradictionId)
}

/**
 * 写入某说法的"采纳替换文句"（定位审查预生成）：用户采纳该说法时本地直接替换，不再调用大模型。
 * 不存在返回 null。
 */
export function updateVariantReplacement(variantId: string, replacement: string | null): boolean {
  const db = getDb()
  const row = db.prepare('SELECT id FROM contradiction_variants WHERE id = ?').get(variantId)
  if (!row) return false
  db.prepare('UPDATE contradiction_variants SET replacement = ? WHERE id = ?').run(replacement, variantId)
  return true
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  let draftId: string
  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
    db.prepare(`INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t1', '矛盾测试', '{"all":true}')`).run()
    for (const [id, title] of [
      ['s1', '年度报告A'],
      ['s2', '统计年鉴B'],
      ['s3', '工作纪要C']
    ]) {
      db.prepare(`INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', ?, '正文', 'ready')`).run(
        id,
        title
      )
    }
    const draft = db.prepare("INSERT INTO drafts (id, task_id, version_number) VALUES ('d1', 't1', 0)").run()
    void draft
    draftId = 'd1'
  })
  afterAll(() => db.close())

  describe('contradiction store (Phase 3.7.1)', () => {
    it('inserts contradiction groups with multi-source variants and reads back with titles', () => {
      const created = insertContradictions(draftId, [
        {
          seq: 1,
          topic: '2022 年全县小学在校生人数',
          kind: 'data',
          variants: [
            { variantText: '据《年度报告A》记载为 3.2 万人。', sourceIds: ['s1'] },
            { variantText: '据《统计年鉴B》《工作纪要C》记载为 3.6 万人。', sourceIds: ['s2', 's3'] }
          ]
        },
        {
          seq: 2,
          topic: '县教育局成立时间',
          kind: 'time',
          variants: [
            { variantText: '1984 年。', sourceIds: ['s2'] },
            { variantText: '1986 年。', sourceIds: ['s1'] },
            { variantText: '1987 年。', sourceIds: ['s3'] }
          ]
        }
      ])

      expect(created).toHaveLength(2)
      expect(created.map((c) => c.seq)).toEqual([1, 2])
      const c1 = created[0]
      expect(c1.status).toBe('pending')
      expect(c1.merged).toBe(false)
      expect(c1.variants).toHaveLength(2)
      // 来源标题 JOIN 填充
      expect(c1.variants[0].sourceIds).toEqual(['s1'])
      expect(c1.variants[0].sourceTitles).toEqual(['年度报告A'])
      expect(c1.variants[1].sourceIds).toEqual(['s2', 's3'])
      expect(c1.variants[1].sourceTitles).toEqual(['统计年鉴B', '工作纪要C'])
      // 同一事实主题 3+ 来源
      const c2 = created[1]
      expect(c2.variants).toHaveLength(3)
      expect(c2.variants[2].sourceTitles).toEqual(['工作纪要C'])

      // 读回一致
      const loaded = getContradictionsByDraft(draftId)
      expect(loaded).toHaveLength(2)
      expect(loaded[1].variants).toHaveLength(3)
    })

    it('updates status to adopted with ownership validation and ignored clears adoption', () => {
      const list = getContradictionsByDraft(draftId)
      const c = list[0]
      const variant = c.variants[1]

      const adopted = updateContradictionStatus(c.id, 'adopted', variant.id)
      expect(adopted).not.toBeNull()
      expect(adopted!.status).toBe('adopted')
      expect(adopted!.adoptedVariantId).toBe(variant.id)

      // 不属于该矛盾的 variant 被拒绝
      const otherVariant = list[1].variants[0]
      expect(updateContradictionStatus(c.id, 'adopted', otherVariant.id)).toBeNull()
      // 采纳但未指定说法被拒绝
      expect(updateContradictionStatus(c.id, 'adopted')).toBeNull()

      // ignored 清空已采纳说法
      const ignored = updateContradictionStatus(c.id, 'ignored')
      expect(ignored!.status).toBe('ignored')
      expect(ignored!.adoptedVariantId).toBeUndefined()
      // 不存在返回 null
      expect(updateContradictionStatus('nope', 'ignored')).toBeNull()
    })

    it('reverts an adopted contradiction back to pending and clears adoption (undo adoption, 2026-08-11)', () => {
      const c = getContradictionsByDraft(draftId)[0]
      const variant = c.variants[0]
      const adopted = updateContradictionStatus(c.id, 'adopted', variant.id)
      expect(adopted!.status).toBe('adopted')
      expect(adopted!.adoptedVariantId).toBe(variant.id)
      // 撤销采纳：状态回退为待处理、清空已采纳说法（正文恢复由编辑器 undo 处理）
      const reverted = updateContradictionStatus(c.id, 'pending')
      expect(reverted).not.toBeNull()
      expect(reverted!.status).toBe('pending')
      expect(reverted!.adoptedVariantId).toBeUndefined()
    })

    it('updates draft quote, in-draft flag and merged flag (location review)', () => {
      const c = getContradictionsByDraft(draftId)[1]
      const updated = updateContradictionQuote(c.id, '全县小学在校生人数为三万余人。', true, true)
      expect(updated!.draftQuote).toBe('全县小学在校生人数为三万余人。')
      expect(updated!.merged).toBe(true)
      expect(updated!.inDraft).toBe(true)
      // merged 可清除（正文定位后未发现合并）；不在正文 → 警告（inDraft=false）
      const cleared = updateContradictionQuote(c.id, '县教育局成立于一九八六年。', false, true)
      expect(cleared!.draftQuote).toBe('县教育局成立于一九八六年。')
      expect(cleared!.merged).toBe(false)
      expect(cleared!.inDraft).toBe(true)
      const absent = updateContradictionQuote(c.id, null, false, false)
      expect(absent!.draftQuote).toBeUndefined()
      expect(absent!.inDraft).toBe(false)
      // 缺省 inDraft → 未知（undefined）
      const unknown = updateContradictionQuote(c.id, '县教育局成立于一九八六年。', false)
      expect(unknown!.inDraft).toBeUndefined()
      expect(updateContradictionQuote('nope', null, false)).toBeNull()
    })

    it('stores per-variant adoption replacements and reads them back', () => {
      const c = getContradictionsByDraft(draftId)[1]
      const v = c.variants[0]
      expect(v.replacement).toBeUndefined()
      expect(updateVariantReplacement(v.id, '县教育局成立于1986年。')).toBe(true)
      const loaded = getContradictionById(c.id)
      expect(loaded!.variants[0].replacement).toBe('县教育局成立于1986年。')
      // 不存在 → false
      expect(updateVariantReplacement('nope', 'x')).toBe(false)
    })

    it('cascades contradictions and variants when draft is deleted', () => {
      const before = getContradictionsByDraft(draftId)
      expect(before.length).toBeGreaterThan(0)
      const variantCount = db
        .prepare(
          `SELECT COUNT(*) AS c FROM contradiction_variants cv
           JOIN draft_contradictions dc ON dc.id = cv.contradiction_id WHERE dc.draft_id = ?`
        )
        .get(draftId) as { c: number }
      expect(variantCount.c).toBeGreaterThan(0)

      db.prepare('DELETE FROM drafts WHERE id = ?').run(draftId)
      expect(getContradictionsByDraft(draftId)).toHaveLength(0)
      const after = db
        .prepare(
          `SELECT COUNT(*) AS c FROM contradiction_variants cv
           JOIN draft_contradictions dc ON dc.id = cv.contradiction_id WHERE dc.draft_id = ?`
        )
        .get(draftId) as { c: number }
      expect(after.c).toBe(0)
    })
  })
}
