/**
 * draft-context.ts —— 初稿生成上下文仓储（2026-08-11，Phase 3.7 增强）。
 * 记录初稿生成时实际使用的检索材料块（draft_generation_sources，Migration 010），
 * 供"文段来源询问"（writing:askSource）按生成时的上下文让大模型溯源；
 * 后续"采纳矛盾修订正文"等场景也可复用。
 */
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { RetrievedChunk } from '../../shared/types'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'
import { getSourcesByIds } from './sources'

/** 覆盖保存某稿的生成上下文（重新生成时替换；稿删除后由外键级联清理） */
export function saveDraftGenerationContext(draftId: string, chunks: RetrievedChunk[]): void {
  const db = getDb()
  db.prepare('DELETE FROM draft_generation_sources WHERE draft_id = ?').run(draftId)
  if (chunks.length === 0) return
  const ins = db.prepare(
    'INSERT OR IGNORE INTO draft_generation_sources (id, draft_id, source_id, position, chunk_text) VALUES (?, ?, ?, ?, ?)'
  )
  const tx = db.transaction(() => {
    for (const c of chunks) ins.run(randomUUID(), draftId, c.sourceId, c.position, c.text)
  })
  tx()
}

/** 读取某稿的生成上下文（按写入顺序；来源标题 JOIN 填充） */
export function getDraftGenerationContext(draftId: string): RetrievedChunk[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT source_id, position, chunk_text FROM draft_generation_sources WHERE draft_id = ? ORDER BY rowid ASC')
    .all(draftId) as { source_id: string; position: string; chunk_text: string }[]
  if (rows.length === 0) return []
  const titles = new Map(getSourcesByIds([...new Set(rows.map((r) => r.source_id))]).map((s) => [s.id, s.title]))
  return rows.map((r) => ({
    sourceId: r.source_id,
    sourceTitle: titles.get(r.source_id) ?? r.source_id,
    position: r.position,
    text: r.chunk_text,
    score: 0
  }))
}

/** 任务最新一稿 id（无稿返回 null） */
export function getLatestDraftIdByTask(taskId: string): string | null {
  const db = getDb()
  const row = db
    .prepare('SELECT id FROM drafts WHERE task_id = ? ORDER BY version_number DESC, created_at DESC LIMIT 1')
    .get(taskId) as { id: string } | undefined
  return row?.id ?? null
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
  afterAll(() => {
    db.close()
  })

  describe('draft generation context store (2026-08-11)', () => {
    it('saves and reads back generation context with source titles', () => {
      getDb().prepare(`INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t-ctx', '生成上下文测试', '{"all":true}')`).run()
      getDb().prepare(`INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s1', 'file', '报告A', '正文', 'ready')`).run()
      getDb().prepare("INSERT INTO drafts (id, task_id, version_number) VALUES ('d-ctx', 't-ctx', 0)").run()
      const chunks: RetrievedChunk[] = [
        { sourceId: 's1', sourceTitle: '报告A', position: '第1段', text: '2021年全区共有幼儿园28所。', score: 9 },
        { sourceId: 's1', sourceTitle: '报告A', position: '第2段', text: '在园幼儿两万余人。', score: 4 }
      ]
      saveDraftGenerationContext('d-ctx', chunks)
      const loaded = getDraftGenerationContext('d-ctx')
      expect(loaded).toHaveLength(2)
      expect(loaded[0]).toEqual({
        sourceId: 's1', sourceTitle: '报告A', position: '第1段', text: '2021年全区共有幼儿园28所。', score: 0
      })
      // 覆盖保存：重新生成后旧块被替换
      saveDraftGenerationContext('d-ctx', [chunks[1]])
      expect(getDraftGenerationContext('d-ctx')).toHaveLength(1)
      // 无上下文返回空
      expect(getDraftGenerationContext('nope')).toEqual([])
      // 最新稿查询
      expect(getLatestDraftIdByTask('t-ctx')).toBe('d-ctx')
    })
  })
}
