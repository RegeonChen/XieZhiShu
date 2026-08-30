/**
 * compilation-undo.test.ts —— 资料汇编撤销/恢复（2026-08-28）快照机制回归测试。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { setDb, getDb } from '../src/main/db/connection'
import { runMigrations } from '../src/main/db/migrate'
import { createCompilation, insertCompilationItems } from '../src/main/db/compilations'
import { pushUndo, undoCompilation, redoCompilation, getUndoCount, getRedoCount } from '../src/main/writing/compilation-undo'

let db: Database.Database

beforeAll(() => {
  db = new Database(':memory:')
  setDb(db)
  runMigrations(db)
})
afterAll(() => db.close())

function seed(): { taskId: string; sourceId: string } {
  const taskId = crypto.randomUUID()
  const sourceId = crypto.randomUUID()
  db.prepare('INSERT INTO writing_tasks (id, title, scope_json) VALUES (?, ?, ?)').run(taskId, '撤测试', '{"all":true}')
  db.prepare('INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, ?, ?, ?, ?)').run(sourceId, 'file', '甲', '正文', 'ready')
  return { taskId, sourceId }
}

describe('compilation undo/redo (2026-08-28)', () => {
  it('undo restores a deleted card and redo re-deletes it', () => {
    const { taskId, sourceId } = seed()
    const c = createCompilation({ taskId, title: '汇编' })
    insertCompilationItems(c.id, [
      { sourceId, excerpt: '卡片一', ts: '2015 年' },
      { sourceId, excerpt: '卡片二', ts: '2017 年' }
    ])
    const itemIds = (db.prepare('SELECT id FROM compilation_items WHERE compilation_id = ? ORDER BY position').all(c.id) as { id: string }[]).map((r) => r.id)
    expect(itemIds).toHaveLength(2)

    // 删除卡片二前登记撤销
    pushUndo(c.id)
    db.prepare('DELETE FROM compilation_items WHERE id = ?').run(itemIds[1])
    expect(getDb().prepare('SELECT COUNT(*) c FROM compilation_items WHERE compilation_id = ?').get(c.id)).toMatchObject({ c: 1 })

    // 撤销 → 恢复 2 张卡
    const restored = undoCompilation(c.id)
    expect(restored).not.toBeNull()
    expect(getDb().prepare('SELECT COUNT(*) c FROM compilation_items WHERE compilation_id = ?').get(c.id)).toMatchObject({ c: 2 })
    expect(getUndoCount(c.id)).toBe(0)
    expect(getRedoCount(c.id)).toBe(1)

    // 恢复 → 再次删掉卡片二
    redoCompilation(c.id)
    expect(getDb().prepare('SELECT COUNT(*) c FROM compilation_items WHERE compilation_id = ?').get(c.id)).toMatchObject({ c: 1 })
    expect(getRedoCount(c.id)).toBe(0)
  })
})
