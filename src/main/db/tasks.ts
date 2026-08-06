/**
 * tasks.ts —— 撰写任务仓储。
 */
import Database from 'better-sqlite3'
import type { WritingScope, WritingTask } from '../../shared/types'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

interface TaskRow {
  id: string
  title: string
  scope_json: string
  template_book_id: string | null
  current_version: number
  created_at: string
  updated_at: string
}

function rowToTask(row: TaskRow): WritingTask {
  let scope: WritingScope
  try {
    scope = JSON.parse(row.scope_json) as WritingScope
  } catch {
    scope = { sourceIds: [] }
  }
  return {
    id: row.id,
    title: row.title,
    scope,
    templateBookId: row.template_book_id ?? undefined,
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function getTaskRowById(id: string): TaskRow | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM writing_tasks WHERE id = ?').get(id) as TaskRow | undefined
}

export interface CreateTaskInput {
  title: string
  scope: WritingScope
  templateBookId?: string
}

export function createTask(input: CreateTaskInput): WritingTask {
  const title = input.title.trim()
  if (!title) throw new Error('请填写撰写标题')
  const scope = input.scope
  const hasScope = 'sourceIds' in scope ? scope.sourceIds.length > 0 : scope.tagIds.length > 0
  if (!hasScope) throw new Error('请选择文件范围（至少一项资料或标签）')

  const db = getDb()
  if (input.templateBookId) {
    const exists = db.prepare('SELECT id FROM template_books WHERE id = ?').get(input.templateBookId)
    if (!exists) throw new Error('指定的范本不存在')
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO writing_tasks (id, title, scope_json, template_book_id, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
  ).run(id, title, JSON.stringify(scope), input.templateBookId ?? null, now, now)
  const row = getTaskRowById(id)
  return rowToTask(row!)
}

export function listTasks(): WritingTask[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM writing_tasks ORDER BY created_at DESC').all() as TaskRow[]
  return rows.map(rowToTask)
}

export function getTaskById(id: string): WritingTask | null {
  const row = getTaskRowById(id)
  return row ? rowToTask(row) : null
}

/** 删除撰写任务（drafts/segments/segment_sources 由外键级联清理） */
export function deleteTask(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM writing_tasks WHERE id = ?').run(id)
}

/** 解析任务范围到具体资料 ID（标签范围展开为关联资料） */
export function resolveScopeSourceIds(task: WritingTask, getSourceIdsByTag: (tagId: string) => string[]): string[] {
  const scope = task.scope
  if ('sourceIds' in scope) return scope.sourceIds
  const ids = scope.tagIds.flatMap((tid) => getSourceIdsByTag(tid))
  return Array.from(new Set(ids))
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

  describe('writing task store (Task 3.3)', () => {
    it('creates and lists tasks with scope', () => {
      const t = createTask({ title: '新区教育发展', scope: { sourceIds: ['s1', 's2'] } })
      expect(t.title).toBe('新区教育发展')
      expect(t.currentVersion).toBe(0)
      const items = listTasks()
      expect(items).toHaveLength(1)
      expect(getTaskById(t.id)?.scope).toEqual({ sourceIds: ['s1', 's2'] })
    })

    it('rejects empty title and empty scope', () => {
      expect(() => createTask({ title: '', scope: { sourceIds: ['s1'] } })).toThrow('标题')
      expect(() => createTask({ title: 'x', scope: { sourceIds: [] } })).toThrow('范围')
    })

    it('resolves tag scope to source ids', () => {
      const tagIds = ['t1']
      const resolved = resolveScopeSourceIds({ id: 'x', title: 't', scope: { tagIds }, currentVersion: 0, createdAt: '', updatedAt: '' }, (id) => (id === 't1' ? ['a', 'b', 'a'] : []))
      expect(resolved).toEqual(['a', 'b'])
    })

    it('deletes task and cascades drafts/segments', () => {
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s1', 'file', '资料', '', 'ready')`
      ).run()
      const t = createTask({ title: '待删除任务', scope: { sourceIds: ['s1'] } })
      db.prepare(
        `INSERT INTO drafts (id, task_id, version_number, status) VALUES ('d1', ?, 0, 'editing')`
      ).run(t.id)
      db.prepare(
        `INSERT INTO segments (id, draft_id, ordering, content, ai_generated) VALUES ('seg1', 'd1', 0, '内容', 1)`
      ).run()
      db.prepare(
        `INSERT INTO segment_sources (segment_id, source_id, position) VALUES ('seg1', 's1', '第1段')`
      ).run()

      deleteTask(t.id)

      expect(getTaskById(t.id)).toBeNull()
      expect(db.prepare("SELECT COUNT(*) AS c FROM drafts WHERE task_id = ?").get(t.id) as { c: number }).toEqual({ c: 0 })
      expect(db.prepare('SELECT COUNT(*) AS c FROM segments WHERE id = ?').get('seg1') as { c: number }).toEqual({ c: 0 })
      expect(db.prepare('SELECT COUNT(*) AS c FROM segment_sources WHERE segment_id = ?').get('seg1') as { c: number }).toEqual({ c: 0 })
    })
  })
}
