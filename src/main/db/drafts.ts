/**
 * drafts.ts —— 志稿版本与片段仓储。
 * 每稿为整稿快照：drafts 一行 + segments 多行 + segment_sources（来源标注）。
 */
import Database from 'better-sqlite3'
import type { Draft, Segment, SegmentSource, VersionListItem } from '../../shared/types'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

interface DraftRow {
  id: string
  task_id: string
  version_number: number
  status: 'editing' | 'confirmed'
  confirmed_at: string | null
  created_at: string
}

interface SegmentRow {
  id: string
  draft_id: string
  ordering: number
  heading: string | null
  content: string
  ai_generated: number
  created_at: string
  updated_at: string
}

interface SegmentSourceRow {
  segment_id: string
  source_id: string
  position: string
  quote: string | null
  source_title: string | null
}

export interface AddSegmentInput {
  draftId: string
  ordering: number
  heading?: string
  content: string
  aiGenerated: boolean
}

export function createDraft(taskId: string, versionNumber: number): Draft {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO drafts (id, task_id, version_number, status, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, taskId, versionNumber, 'editing', now)
  db.prepare('UPDATE writing_tasks SET current_version = ?, updated_at = ? WHERE id = ?')
    .run(versionNumber, now, taskId)
  return { id, taskId, versionNumber, status: 'editing', createdAt: now, segments: [] }
}

export function getDraftRowByVersion(taskId: string, versionNumber: number): DraftRow | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM drafts WHERE task_id = ? AND version_number = ?').get(taskId, versionNumber) as
    | DraftRow
    | undefined
}

export function addSegment(input: AddSegmentInput): Segment {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO segments (id, draft_id, ordering, heading, content, ai_generated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, input.draftId, input.ordering, input.heading ?? null, input.content, input.aiGenerated ? 1 : 0, now, now)
  return {
    id,
    draftId: input.draftId,
    ordering: input.ordering,
    heading: input.heading,
    content: input.content,
    aiGenerated: input.aiGenerated,
    createdAt: now,
    updatedAt: now,
    sources: []
  }
}

export function addSegmentSource(segmentId: string, sourceId: string, position: string, quote?: string): void {
  const db = getDb()
  db.prepare(
    'INSERT OR IGNORE INTO segment_sources (segment_id, source_id, position, quote) VALUES (?, ?, ?, ?)'
  ).run(segmentId, sourceId, position, quote ?? null)
}

function mapSegmentSource(row: SegmentSourceRow): SegmentSource {
  return {
    segmentId: row.segment_id,
    sourceId: row.source_id,
    position: row.position,
    quote: row.quote ?? undefined,
    sourceTitle: row.source_title ?? undefined
  }
}

/** 读取整稿（含片段与来源标注，来源带标题） */
export function getDraftById(id: string): Draft | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined
  if (!row) return null

  const segmentRows = db
    .prepare('SELECT * FROM segments WHERE draft_id = ? ORDER BY ordering ASC')
    .all(id) as SegmentRow[]
  const segments: Segment[] = segmentRows.map((sr) => {
    const sourceRows = db
      .prepare(
        `SELECT ss.segment_id, ss.source_id, ss.position, ss.quote, so.title AS source_title
         FROM segment_sources ss
         LEFT JOIN sources so ON so.id = ss.source_id
         WHERE ss.segment_id = ?`
      )
      .all(sr.id) as SegmentSourceRow[]
    return {
      id: sr.id,
      draftId: sr.draft_id,
      ordering: sr.ordering,
      heading: sr.heading ?? undefined,
      content: sr.content,
      aiGenerated: sr.ai_generated === 1,
      createdAt: sr.created_at,
      updatedAt: sr.updated_at,
      sources: sourceRows.map(mapSegmentSource)
    }
  })

  return {
    id: row.id,
    taskId: row.task_id,
    versionNumber: row.version_number,
    status: row.status,
    confirmedAt: row.confirmed_at ?? undefined,
    createdAt: row.created_at,
    segments
  }
}

/** 任务的版本列表（version:list） */
export function listVersions(taskId: string): VersionListItem[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM drafts WHERE task_id = ? ORDER BY version_number ASC').all(taskId) as DraftRow[]
  return rows.map((r) => ({
    draftId: r.id,
    versionNumber: r.version_number,
    status: r.status,
    confirmedAt: r.confirmed_at ?? undefined
  }))
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

  describe('draft store (Task 3.3)', () => {
    it('creates draft, segments and source annotations, reads back with titles', () => {
      db.prepare(
        `INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t1', '新区教育', '{"sourceIds":["s1"]}')`
      ).run()
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s1', 'file', '教育报告', '正文内容', 'ready')`
      ).run()

      const draft = createDraft('t1', 0)
      const seg = addSegment({ draftId: draft.id, ordering: 0, heading: '概述', content: '新区教育发展迅速。', aiGenerated: true })
      addSegmentSource(seg.id, 's1', '第1段', '原文摘句')

      const loaded = getDraftById(draft.id)!
      expect(loaded.versionNumber).toBe(0)
      expect(loaded.segments).toHaveLength(1)
      expect(loaded.segments[0].sources[0].sourceTitle).toBe('教育报告')
      expect(loaded.segments[0].sources[0].quote).toBe('原文摘句')
      // task current_version 同步更新
      const taskRow = db.prepare('SELECT current_version FROM writing_tasks WHERE id = ?').get('t1') as { current_version: number }
      expect(taskRow.current_version).toBe(0)
    })

    it('lists versions ascending', () => {
      createDraft('t1', 1)
      const versions = listVersions('t1')
      expect(versions.map((v) => v.versionNumber)).toEqual([0, 1])
    })
  })
}
