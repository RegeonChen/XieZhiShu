/**
 * source-removal.test.ts —— 来源移除级联清理资料汇编（2026-08-28）。
 * 覆盖：isSourceUsedInCompilation、registerSourceRemoval(手动删除, origin='manual')、
 * decideSourceRemoval('delete') 删除来源与卡片、keep 仅删来源保留卡片。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { setDb } from '../src/main/db/connection'
import { runMigrations } from '../src/main/db/migrate'
import { createCompilation, insertCompilationItems, getCompilationById } from '../src/main/db/compilations'
import {
  isSourceUsedInCompilation,
  registerSourceRemoval,
  listPendingSourceRemovals,
  decideSourceRemoval
} from '../src/main/workspace/source-removal'

let db: Database.Database

beforeAll(() => {
  db = new Database(':memory:')
  setDb(db)
  runMigrations(db)
})
afterAll(() => db.close())

function seed(): { taskId: string; sourceIds: string[] } {
  const taskId = crypto.randomUUID()
  db.prepare("INSERT INTO writing_tasks (id, title, scope_json) VALUES (?, '来源删除测试', '{\"all\":true}')").run(taskId)
  const s1 = crypto.randomUUID()
  const s2 = crypto.randomUUID()
  db.prepare("INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', '甲', '正文', 'ready')").run(s1)
  db.prepare("INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', '乙', '正文', 'ready')").run(s2)
  return { taskId, sourceIds: [s1, s2] }
}

describe('source removal cascade (Task: 资料库直接删除来源触发级联清理)', () => {
  it('register manual origin then decide delete clears the source cards and removes the source', () => {
    const { taskId, sourceIds } = seed()
    const c = createCompilation({ taskId, title: '汇编' })
    insertCompilationItems(c.id, [
      { sourceId: sourceIds[0], excerpt: '卡片一', ts: '2005 年' },
      { sourceId: sourceIds[1], excerpt: '卡片二', ts: '2006 年' }
    ])

    expect(isSourceUsedInCompilation(sourceIds[0])).toBe(true)
    expect(isSourceUsedInCompilation(sourceIds[1])).toBe(true)

    const pending = registerSourceRemoval(sourceIds[0], '甲', 'manual')
    expect(pending.origin).toBe('manual')
    expect(pending.cardCount).toBe(1)
    expect(listPendingSourceRemovals()).toHaveLength(1)

    // 同一来源被多条路径重复登记（如工作区对账 / 手动删除同时触发）应幂等，不产生第二个待确认项
    registerSourceRemoval(sourceIds[0], '甲', 'workspace')
    expect(listPendingSourceRemovals()).toHaveLength(1)

    const res = decideSourceRemoval(sourceIds[0], 'delete')
    expect(res.deletedItems).toBe(1)
    // 来源被删除，来自它的卡片被清理，另一来源的卡片保留
    expect(getCompilationById(c.id)!.items).toHaveLength(1)
    expect(getCompilationById(c.id)!.items[0].sourceId).toBe(sourceIds[1])
  })
})
