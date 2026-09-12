/**
 * web-materials.ts —— 「本任务锁定的网页材料」仓储（2026-09-12 第三批 A1）。
 *
 * 为什么需要它：网页资料库此前每次生成都重新发现/抓取最新命中文章，导致
 *   ① 同一指令在不同时间生成的汇编材料集合不同（不可复现）；
 *   ② 「重新生成汇编」可能引入用户从未见过的网页段落，污染版本差异与矛盾编号。
 * 现在首次生成时把**实际采用**的网页来源落定在本表；重新生成默认复用，
 * 新发现但未纳入的文章只统计数量，由用户在界面上显式「纳入新材料」才抓取。
 * 来源被删除时随外键级联（该材料自然从集合里消失）。
 */
import Database from 'better-sqlite3'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

export interface PinnedWebMaterial {
  sourceId: string
  url?: string
  title?: string
  addedAt: string
}

/** 某任务已锁定的网页材料 */
export function listPinnedWebMaterials(taskId: string): PinnedWebMaterial[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT source_id, url, title, added_at FROM task_web_materials WHERE task_id = ? ORDER BY added_at ASC')
    .all(taskId) as { source_id: string; url: string | null; title: string | null; added_at: string }[]
  return rows.map((r) => ({ sourceId: r.source_id, url: r.url ?? undefined, title: r.title ?? undefined, addedAt: r.added_at }))
}

/** 追加锁定一批网页材料（幂等：同任务同来源只记一次） */
export function pinWebMaterials(
  taskId: string,
  items: { sourceId: string; url?: string; title?: string }[]
): number {
  if (items.length === 0) return 0
  const db = getDb()
  const now = new Date().toISOString()
  const ins = db.prepare(
    'INSERT INTO task_web_materials (task_id, source_id, url, title, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, source_id) DO NOTHING'
  )
  let added = 0
  const tx = db.transaction(() => {
    for (const it of items) {
      added += ins.run(taskId, it.sourceId, it.url ?? null, it.title ?? null, now).changes
    }
  })
  tx()
  return added
}

/** 清空某任务锁定的网页材料（返回删除条数）；供「重新检索网页材料」重算材料集合用 */
export function clearPinnedWebMaterials(taskId: string): number {
  const db = getDb()
  return db.prepare('DELETE FROM task_web_materials WHERE task_id = ?').run(taskId).changes
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
    db.prepare("INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t1','任务','{\"all\":true}')").run()
    db.prepare("INSERT INTO sources (id, kind, title, url, cleaned_text, status) VALUES ('s1','url','甲文','https://x/1','正文','ready')").run()
    db.prepare("INSERT INTO sources (id, kind, title, url, cleaned_text, status) VALUES ('s2','url','乙文','https://x/2','正文','ready')").run()
  })
  afterAll(() => db.close())

  describe('task web materials (第三批 A1)', () => {
    it('pins materials idempotently and lists them in insertion order', () => {
      expect(listPinnedWebMaterials('t1')).toHaveLength(0)
      expect(pinWebMaterials('t1', [{ sourceId: 's1', url: 'https://x/1', title: '甲文' }])).toBe(1)
      // 幂等：同一任务同一来源不再重复记
      expect(pinWebMaterials('t1', [{ sourceId: 's1' }])).toBe(0)
      expect(pinWebMaterials('t1', [{ sourceId: 's2', url: 'https://x/2', title: '乙文' }])).toBe(1)
      expect(listPinnedWebMaterials('t1').map((p) => p.sourceId)).toEqual(['s1', 's2'])
    })

    it('drops pinned materials when their source is deleted (cascade)', () => {
      db.prepare("DELETE FROM sources WHERE id = 's1'").run()
      expect(listPinnedWebMaterials('t1').map((p) => p.sourceId)).toEqual(['s2'])
    })

    it('clears all pinned materials of a task (重新检索网页材料)', () => {
      expect(clearPinnedWebMaterials('t1')).toBe(1)
      expect(listPinnedWebMaterials('t1')).toHaveLength(0)
      expect(clearPinnedWebMaterials('t1')).toBe(0)
      // 不影响其它任务
      db.prepare("INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t2','另一任务','{\"all\":true}')").run()
      pinWebMaterials('t2', [{ sourceId: 's2', url: 'https://x/2', title: '乙文' }])
      expect(listPinnedWebMaterials('t2')).toHaveLength(1)
    })
  })
}
