/**
 * compilation-undo.test.ts —— 资料汇编撤销/恢复（2026-08-28）快照机制回归测试。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { setDb, getDb } from '../src/main/db/connection'
import { runMigrations } from '../src/main/db/migrate'
import { createCompilation, insertCompilationItems, insertCompilationContradictions, updateCompilationContradictionStatus, getCompilationById, upsertCompilationParagraphs } from '../src/main/db/compilations'
import { pushUndo, undoCompilation, redoCompilation, getUndoCount, getRedoCount, clearUndoStacks } from '../src/main/writing/compilation-undo'

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

  it('undo/redo covers contradiction decisions (user request 2026-09-10)', () => {
    const { taskId, sourceId } = seed()
    const c = createCompilation({ taskId, title: '汇编' })
    const items = insertCompilationItems(c.id, [
      { sourceId, excerpt: '全区普通中学 30 所', ts: '2018 年' },
      { sourceId, excerpt: '全区普通中学 32 所', ts: '2018 年' }
    ])
    const group = insertCompilationContradictions(c.id, [
      {
        topic: '2018 年普通中学数量',
        kind: 'data',
        variants: [
          { itemId: items[0].id, variantText: '30 所', sourceId },
          { itemId: items[1].id, variantText: '32 所', sourceId }
        ]
      }
    ])[0]
    expect(group.status).toBe('pending')

    // 采纳说法一：与 IPC handler 同口径——先压栈，再改状态（未被采纳的段会进入回收站/被排除）
    pushUndo(c.id)
    updateCompilationContradictionStatus(group.id, 'resolved', items[0].id)
    const afterResolve = getDb().prepare('SELECT status, chosen_item_id FROM compilation_contradictions WHERE id = ?').get(group.id)
    expect(afterResolve).toMatchObject({ status: 'resolved', chosen_item_id: items[0].id })

    // 撤销 → 回到「待处理」（用户要求：采纳/忽略也能用撤销按钮改回来）
    expect(getUndoCount(c.id)).toBe(1)
    undoCompilation(c.id)
    const afterUndo = getDb().prepare('SELECT status, chosen_item_id FROM compilation_contradictions WHERE id = ?').get(group.id)
    expect(afterUndo).toMatchObject({ status: 'pending', chosen_item_id: null })

    // 恢复 → 重新采纳
    expect(getRedoCount(c.id)).toBe(1)
    redoCompilation(c.id)
    expect(getDb().prepare('SELECT status, chosen_item_id FROM compilation_contradictions WHERE id = ?').get(group.id)).toMatchObject({
      status: 'resolved',
      chosen_item_id: items[0].id
    })

    // 排序等"只改顺序"的操作仍然作废撤销栈（用户 2026-09-10 早先的要求，不能因为本次放宽而回退）
    clearUndoStacks(c.id)
    expect(getUndoCount(c.id)).toBe(0)
    expect(getRedoCount(c.id)).toBe(0)
  })

  it('keeps 并列来源 relations across undo/redo (Phase 7.12)', () => {
    const { taskId, sourceId } = seed()
    const other = crypto.randomUUID()
    db.prepare('INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, ?, ?, ?, ?)').run(other, 'file', '乙', '正文', 'ready')
    const c = createCompilation({ taskId, title: '汇编' })
    const items = upsertCompilationParagraphs(c.id, [
      { sourceId, alsoSourceIds: [other], text: '2020 年，全区普通中学 28 所。' },
      { sourceId: other, text: '2019 年，全区教职工 900 人。' }
    ])
    const relCount = (): number =>
      (db.prepare('SELECT COUNT(*) c FROM compilation_item_sources WHERE item_id = ?').get(items[0].id) as { c: number }).c
    expect(relCount()).toBe(2)

    // 撤销是"先清空再重插"，且期间外键关闭（级联失效）——若快照不含关系表，
    // 一次撤销就会把"另一个出处"静默抹掉（同类事故见 2026-09-10 的 year/source_ordinal 全丢）
    pushUndo(c.id)
    db.prepare('DELETE FROM compilation_item_sources WHERE item_id = ?').run(items[0].id)
    expect(relCount()).toBe(0)

    undoCompilation(c.id)
    expect(relCount()).toBe(2)
    // 且恢复后仍能正确透出并列来源
    const loaded = getCompilationById(c.id)!
    expect(loaded.items.find((i) => i.id === items[0].id)?.alsoSourceIds).toEqual([other])

    // 恢复（重做）也不能丢
    redoCompilation(c.id)
    expect(relCount()).toBe(0)
    undoCompilation(c.id)
    expect(relCount()).toBe(2)
  })
})
