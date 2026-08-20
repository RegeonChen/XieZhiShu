/**
 * drafts.ts —— 志稿与片段仓储。
 * 每稿为整稿快照：drafts 一行 + segments 多行 + segment_sources（来源标注）。
 * 删去版本管理（2026-08-11）后每个任务仅保留一稿（version 0 初稿）。
 */
import Database from 'better-sqlite3'
import type { Draft, Segment, SegmentSource } from '../../shared/types'
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

/**
 * 整稿 Markdown → 片段序列（Task 3.4.1 整稿保存）。
 * 按 Markdown 标题行（#~######）切分：每个标题行开启一个新片段（heading=标题文字，content 收集其后非标题行）；
 * 无标题的正文部分并入前一片段；若整稿无任何标题则整体为单个片段。
 * 纯函数、可测试。
 */
export function splitMarkdownIntoSegments(markdown: string): { heading?: string; content: string }[] {
  const lines = markdown.split('\n')
  const segments: { heading?: string; content: string }[] = []
  let current: { heading?: string; lines: string[] } = { lines: [] }

  const flush = (): void => {
    const content = current.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    const hasContent = content.length > 0
    const hasHeading = current.heading !== undefined && current.heading.length > 0
    if (hasContent || hasHeading) {
      segments.push({ heading: hasHeading ? current.heading : undefined, content })
    }
    current = { lines: [] }
  }

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s*(.+)/)
    if (m) {
      flush()
      current.heading = m[2].trim()
    } else {
      current.lines.push(line)
    }
  }
  flush()

  // 空片段（无标题无内容）不保留；全空输入返回空数组
  return segments.filter((s) => s.content.length > 0 || (s.heading ?? '').length > 0)
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

/** 删除指定版本初稿（segments/segment_sources 由外键级联删除）；不存在返回 false */
export function deleteDraftByVersion(taskId: string, versionNumber: number): boolean {
  const db = getDb()
  const row = getDraftRowByVersion(taskId, versionNumber)
  if (!row) return false
  db.prepare('DELETE FROM drafts WHERE id = ?').run(row.id)
  return true
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

/** 整稿保存（Task 3.4.1）：删除旧片段并按整稿 Markdown 重建片段（新片段无来源关联）；稿不存在返回 null */
export function replaceDraftSegments(draftId: string, markdown: string): Draft | null {
  const db = getDb()
  const draft = getDraftById(draftId)
  if (!draft) return null

  const segments = splitMarkdownIntoSegments(markdown)
  const now = new Date().toISOString()
  // segment_sources 由外键级联删除
  db.prepare('DELETE FROM segments WHERE draft_id = ?').run(draftId)
  segments.forEach((seg, i) => {
    db.prepare(
      'INSERT INTO segments (id, draft_id, ordering, heading, content, ai_generated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), draftId, i, seg.heading ?? null, seg.content, 1, now, now)
  })
  db.prepare('UPDATE drafts SET status = ? WHERE id = ?').run('editing', draftId)

  return getDraftById(draftId)
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

/** 读取单个片段（含来源标注） */
export function getSegmentById(segmentId: string): Segment | null {
  const db = getDb()
  const sr = db.prepare('SELECT * FROM segments WHERE id = ?').get(segmentId) as SegmentRow | undefined
  if (!sr) return null
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
}

/** 修改片段内容（内容以 Markdown 存储；记录 review_records 留痕） */
export function updateSegmentContent(segmentId: string, content: string): Segment | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM segments WHERE id = ?').get(segmentId) as SegmentRow | undefined
  if (!row) return null

  const trimmed = content.trim()
  const now = new Date().toISOString()
  db.prepare('UPDATE segments SET content = ?, updated_at = ? WHERE id = ?').run(trimmed, now, segmentId)

  if (row.content !== trimmed) {
    db.prepare(
      `INSERT INTO review_records (id, draft_id, segment_id, action, before_content, after_content, created_at)
       VALUES (?, ?, ?, 'edit', ?, ?, ?)`
    ).run(crypto.randomUUID(), row.draft_id, segmentId, row.content, trimmed, now)
  }

  return getSegmentById(segmentId)
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

/** 任务最新一稿（draft:getLatest；删去版本管理后仅保留初稿）；无稿返回 null */
export function getLatestDraftByTask(taskId: string): Draft | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM drafts WHERE task_id = ? ORDER BY version_number DESC LIMIT 1')
    .get(taskId) as DraftRow | undefined
  if (!row) return null
  return getDraftById(row.id)
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

    it('returns the latest (only) draft for a task (draft:getLatest)', () => {
      const latest = getLatestDraftByTask('t1')
      expect(latest).not.toBeNull()
      expect(latest!.versionNumber).toBe(0)
      expect(getLatestDraftByTask('no-such-task')).toBeNull()
    })

    it('deletes draft by version with cascade cleanup (Task 3.4.5)', () => {
      db.prepare(`INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t3', '重新生成', '{"sourceIds":["s1"]}')`).run()
      const draft = createDraft('t3', 0)
      const seg = addSegment({ draftId: draft.id, ordering: 0, heading: '旧段', content: '旧内容。', aiGenerated: true })
      addSegmentSource(seg.id, 's1', '第1段', '原文摘句')
      const segCount = db.prepare('SELECT COUNT(*) AS c FROM segments WHERE draft_id = ?').get(draft.id) as { c: number }
      expect(segCount.c).toBe(1)

      expect(deleteDraftByVersion('t3', 0)).toBe(true)
      // 初稿与片段、来源标注级联清理
      expect(db.prepare('SELECT id FROM drafts WHERE id = ?').get(draft.id)).toBeUndefined()
      expect(db.prepare('SELECT COUNT(*) AS c FROM segments WHERE draft_id = ?').get(draft.id) as { c: number }).toEqual({ c: 0 })
      expect(db.prepare('SELECT COUNT(*) AS c FROM segment_sources WHERE segment_id = ?').get(seg.id) as { c: number }).toEqual({ c: 0 })
      // 不存在时返回 false
      expect(deleteDraftByVersion('t3', 0)).toBe(false)
    })
  })

  describe('whole-draft save (Task 3.4.1)', () => {
    it('splits markdown into segments by heading', () => {
      const md = '## 概述\n\n本县地处江南水乡。\n\n## 建制沿革\n\n本县建制始于唐代。'
      const segs = splitMarkdownIntoSegments(md)
      expect(segs).toHaveLength(2)
      expect(segs[0]).toEqual({ heading: '概述', content: '本县地处江南水乡。' })
      expect(segs[1]).toEqual({ heading: '建制沿革', content: '本县建制始于唐代。' })
    })

    it('keeps headingless leading text merged into first segment', () => {
      const segs = splitMarkdownIntoSegments('开篇引言内容。\n\n## 第一章 概述\n\n正文内容。')
      expect(segs).toHaveLength(2)
      expect(segs[0].heading).toBeUndefined()
      expect(segs[0].content).toContain('开篇引言内容')
      expect(segs[1].heading).toBe('第一章 概述')
    })

    it('returns single segment for headingless whole doc, empty array for blank', () => {
      expect(splitMarkdownIntoSegments('整篇只有一段正文，没有任何标题。')).toHaveLength(1)
      expect(splitMarkdownIntoSegments('')).toEqual([])
      expect(splitMarkdownIntoSegments('   \n\n  ')).toEqual([])
    })

    it('replaces segments and drops sources', () => {
      db.prepare(`INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t2', '整稿测试', '{"sourceIds":["s1"]}')`).run()
      const draft = createDraft('t2', 0)
      const seg = addSegment({ draftId: draft.id, ordering: 0, heading: '旧段', content: '旧内容。', aiGenerated: true })
      addSegmentSource(seg.id, 's1', '第1段')

      const updated = replaceDraftSegments(draft.id, '## 新段一\n\n新内容一。\n\n## 新段二\n\n新内容二。')
      expect(updated).not.toBeNull()
      expect(updated!.segments).toHaveLength(2)
      expect(updated!.segments[0].heading).toBe('新段一')
      expect(updated!.segments[1].heading).toBe('新段二')
      // 旧来源关联随片段删除而清空
      expect(updated!.segments[0].sources).toHaveLength(0)
      expect(updated!.segments[1].sources).toHaveLength(0)
      // 重建后读回内容一致
      const loaded = getDraftById(draft.id)!
      expect(loaded.segments.map((s) => s.content)).toEqual(['新内容一。', '新内容二。'])
    })
  })
}
