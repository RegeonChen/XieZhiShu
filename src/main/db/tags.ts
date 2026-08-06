/**
 * tags repository —— 事务安全的标签 CRUD。
 * 标签与资料为独立关联（source_tags 表），不再嵌入资料标题。
 *   - 所有写操作在事务内执行
 *   - 删除标签时级联解除全部资料的该标签关联
 *   - 创建标签幂等（同名返回已有）
 */
import Database from 'better-sqlite3'
import type { Tag } from '../../shared/types'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

interface TagRow {
  id: string
  name: string
  created_at: string
}

function rowToTag(row: TagRow): Tag {
  return { id: row.id, name: row.name, createdAt: row.created_at }
}

/** 事务执行器（better-sqlite3 同步 API：手动 BEGIN/COMMIT/ROLLBACK） */
function transaction<T>(db: ReturnType<typeof getDb>, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function listTags(): Tag[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM tags ORDER BY name ASC').all() as TagRow[]
  return rows.map(rowToTag)
}

export function getTagById(id: string): Tag | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow | undefined
  return row ? rowToTag(row) : null
}

function getTagByName(name: string): Tag | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM tags WHERE name = ?').get(name) as TagRow | undefined
  return row ? rowToTag(row) : null
}

export function createTag(name: string): Tag {
  const db = getDb()
  // 幂等：同名标签返回已有
  const existing = getTagByName(name)
  if (existing) return existing

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)')
    .run(id, name, now)
  return { id, name, createdAt: now }
}

export function updateTag(id: string, name?: string): Tag | null {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow | undefined
  if (!existing) return null

  const newName = name ?? existing.name
  db.prepare('UPDATE tags SET name = ? WHERE id = ?')
    .run(newName, id)

  return getTagById(id)
}

export function deleteTag(id: string): void {
  const db = getDb()
  transaction(db, () => {
    // 级联解除所有资料的该标签关联，再删除标签本身（同一事务，实时生效）
    db.prepare('DELETE FROM source_tags WHERE tag_id = ?').run(id)
    db.prepare('DELETE FROM tags WHERE id = ?').run(id)
  })
}

export function addTagToSource(sourceId: string, tagId: string): void {
  const db = getDb()
  transaction(db, () => {
    db.prepare('INSERT OR IGNORE INTO source_tags (source_id, tag_id) VALUES (?, ?)').run(sourceId, tagId)
  })
}

export function removeTagFromSource(sourceId: string, tagId: string): void {
  const db = getDb()
  transaction(db, () => {
    db.prepare('DELETE FROM source_tags WHERE source_id = ? AND tag_id = ?').run(sourceId, tagId)
  })
}

/** 获取资料的所有标签 */
export function getTagsBySource(sourceId: string): Tag[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT t.* FROM tags t INNER JOIN source_tags st ON t.id = st.tag_id WHERE st.source_id = ? ORDER BY t.name`
  ).all(sourceId) as TagRow[]
  return rows.map(rowToTag)
}

/** 批量打标 */
export function batchAddTags(sourceIds: string[], tagIds: string[]): void {
  const db = getDb()
  transaction(db, () => {
    const stmt = db.prepare('INSERT OR IGNORE INTO source_tags (source_id, tag_id) VALUES (?, ?)')
    for (const sid of sourceIds) {
      for (const tid of tagIds) {
        stmt.run(sid, tid)
      }
    }
  })
}

/** 获取带有指定标签的所有资料 ID */
export function getSourceIdsByTag(tagId: string): string[] {
  const db = getDb()
  const rows = db.prepare('SELECT source_id FROM source_tags WHERE tag_id = ?').all(tagId) as { source_id: string }[]
  return rows.map((r) => r.source_id)
}

/* ---------- 相似标签搜索（新建标签时的 Top5 建议） ---------- */

/** 字符 bigram（中文无空格分词，用相邻字符对近似文本相似度） */
function bigrams(s: string): string[] {
  const chars = Array.from(s)
  const out: string[] = []
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1])
  return out
}

function tagSimilarity(query: string, name: string): number {
  if (query === name) return 1000
  if (name.includes(query)) return 500 + name.length // 已存在标签名包含输入
  if (query.includes(name)) return 300 + name.length // 输入包含已有标签名
  const qs = bigrams(query)
  const ns = bigrams(name)
  if (qs.length === 0 || ns.length === 0) return 0
  const common = qs.filter((b) => ns.includes(b)).length
  return (common / (qs.length + ns.length - common)) * 100 // Jaccard 相似度
}

/** 搜索与查询词最相似的标签，返回 Top N（无匹配返回空数组） */
export function searchTags(query: string, limit = 5): Tag[] {
  const q = query.trim()
  if (!q) return []
  const db = getDb()
  const all = db.prepare('SELECT * FROM tags').all() as TagRow[]
  return all
    .map((row) => ({ tag: rowToTag(row), score: tagSimilarity(q, row.name) }))
    .filter((x) => x.score >= 40)
    .sort((a, b) => b.score - a.score || a.tag.name.localeCompare(b.tag.name))
    .slice(0, limit)
    .map((x) => x.tag)
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

  function insertSource(id: string): void {
    db.prepare(
      `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', ?, '', 'ready')`
    ).run(id, `资料-${id}`)
  }

  describe('tag delete cascade (标签删除级联解除关联)', () => {
    it('deleteTag removes the tag from all sources immediately', () => {
      insertSource('s1')
      insertSource('s2')
      const tag = createTag('小学教育')
      addTagToSource('s1', tag.id)
      addTagToSource('s2', tag.id)
      expect(getSourceIdsByTag(tag.id)).toHaveLength(2)
      expect(getTagsBySource('s1').some((t) => t.id === tag.id)).toBe(true)

      deleteTag(tag.id)

      // source_tags 无残留、资料不再持有该标签、标签本身已删除
      const count = db.prepare('SELECT COUNT(*) AS c FROM source_tags WHERE tag_id = ?').get(tag.id) as { c: number }
      expect(count.c).toBe(0)
      expect(getTagsBySource('s1').some((t) => t.id === tag.id)).toBe(false)
      expect(getTagsBySource('s2')).toHaveLength(0)
      expect(getTagById(tag.id)).toBeNull()
      // 其他标签不受影响
      const other = createTag('其他标签')
      expect(listTags().map((t) => t.id)).toContain(other.id)
    })

    it('tag CRUD does not touch source titles', () => {
      const tag = createTag('标题不动')
      addTagToSource('s1', tag.id)
      const row = db.prepare('SELECT title FROM sources WHERE id = ?').get('s1') as { title: string }
      expect(row.title).toBe('资料-s1')
      removeTagFromSource('s1', tag.id)
      expect(row.title).toBe('资料-s1')
    })
  })
}
