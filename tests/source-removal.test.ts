/**
 * source-removal.test.ts —— 来源移除级联清理资料汇编（2026-08-28）。
 * 覆盖：isSourceUsedInCompilation、registerSourceRemoval(手动删除, origin='manual')、
 * decideSourceRemoval('delete') 删除来源与卡片、keep 仅删来源保留卡片。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { setDb } from '../src/main/db/connection'
import { runMigrations } from '../src/main/db/migrate'
import { createCompilation, insertCompilationItems, getCompilationById, ensureCompilationSources, upsertCompilationParagraphs } from '../src/main/db/compilations'
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

  /* ---- Phase 7.12（多来源标注）：来源删除时"还有别的出处"的段必须活下来 ---- */

  function seedMulti(): { taskId: string; sourceIds: string[]; compilationId: string; ord: (sid: string) => number } {
    const { taskId, sourceIds } = seed()
    const c = createCompilation({ taskId, title: '汇编' })
    const refs = ensureCompilationSources(c.id, [
      { sourceId: sourceIds[0], title: '甲' },
      { sourceId: sourceIds[1], title: '乙' }
    ])
    const ord = (sid: string): number => refs.find((r) => r.sourceId === sid)!.ordinal
    upsertCompilationParagraphs(c.id, [
      { sourceId: sourceIds[0], sourceOrdinal: ord(sourceIds[0]), text: '只由甲记载的一段。' },
      {
        sourceId: sourceIds[0],
        alsoSourceIds: [sourceIds[1]],
        sourceOrdinal: ord(sourceIds[0]),
        text: '甲与乙共同记载的一段。'
      },
      { sourceId: sourceIds[1], sourceOrdinal: ord(sourceIds[1]), text: '只由乙记载的一段。' }
    ])
    return { taskId, sourceIds, compilationId: c.id, ord }
  }

  it('splits 只由它记载 / 还有其它来源 两档，并在删除后把共同段改指剩余来源 (Phase 7.12)', () => {
    const { sourceIds, compilationId, ord } = seedMulti()
    const pending = registerSourceRemoval(sourceIds[0], '甲', 'manual')
    // 段数按并列来源关系表统计：甲涉及 2 段（孤本 1 + 与乙共同 1）
    expect(pending.cardCount).toBe(2)
    expect(pending.sharedCount).toBe(1)

    const res = decideSourceRemoval(sourceIds[0], 'delete')
    expect(res.deletedItems).toBe(1) // 只删孤本段
    expect(res.repointedItems).toBe(1) // 共同记载那段改指乙，而不是被删

    const after = getCompilationById(compilationId)!
    expect(after.items).toHaveLength(2)
    expect(after.items.map((i) => i.excerpt).sort()).toEqual(['只由乙记载的一段。', '甲与乙共同记载的一段。'])
    const shared = after.items.find((i) => i.excerpt === '甲与乙共同记载的一段。')!
    // 主来源改指剩余来源，圆标编号随之改号；并列关系随删来源级联清理
    expect(shared.sourceId).toBe(sourceIds[1])
    expect(shared.sourceOrdinal).toBe(ord(sourceIds[1]))
    expect(shared.sourceTitle).toBe('乙')
    expect(shared.alsoSourceIds).toBeUndefined()
    expect(shared.alsoSourceOrdinals).toBeUndefined()
    expect(after.items.find((i) => i.excerpt === '只由乙记载的一段。')!.sourceId).toBe(sourceIds[1])
  })

  it('keeps 孤本段 as 来源待补 when the user chooses 保留 (Phase 7.12, Q4)', () => {
    const { sourceIds, compilationId } = seedMulti()
    registerSourceRemoval(sourceIds[0], '甲', 'manual')
    const res = decideSourceRemoval(sourceIds[0], 'keep')
    expect(res.deletedItems).toBe(0) // 保留 = 不删段
    expect(res.repointedItems).toBe(1) // 共同段仍改指乙（比变成"来源待补"更可溯源）
    const after = getCompilationById(compilationId)!
    expect(after.items).toHaveLength(3)
    const orphan = after.items.find((i) => i.excerpt === '只由甲记载的一段。')!
    // 外键 SET NULL → 该段没有来源了（界面显示「来源待补」）；注意此处运行时是 null
    expect(orphan.sourceId ?? '').toBe('')
    const shared = after.items.find((i) => i.excerpt === '甲与乙共同记载的一段。')!
    expect(shared.sourceId).toBe(sourceIds[1])
  })
})
