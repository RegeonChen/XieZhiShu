/**
 * tags repository —— 事务安全的标签 CRUD + 级联标题重建。
 * 参照海地小纵队 Phase 4.1.3 方案：
 *   - 所有写操作在事务内执行
 *   - 标签改名/删改时自动重建受影响 sources 的标题前缀
 *   - 创建标签幂等（同名返回已有）
 */
import type { Tag } from '../../shared/types'
import { getDb } from './connection'
import { buildTaggedSourceTitle } from '../../utils/source-title-tags'

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

/** 为指定 tagId 下的所有资料重建标题前缀 */
function rebuildSourceTitlesForTag(tagId: string): void {
  const db = getDb()
  const rows = db.prepare('SELECT source_id FROM source_tags WHERE tag_id = ?').all(tagId) as { source_id: string }[]
  for (const row of rows) {
    rebuildSourceTitle(row.source_id)
  }
}

/** 为单个资料重建标题前缀 */
function rebuildSourceTitle(sourceId: string): void {
  const db = getDb()
  const s = db.prepare('SELECT title FROM sources WHERE id = ?').get(sourceId) as { title: string } | undefined
  if (!s) return
  const tagRows = db.prepare(
    `SELECT t.* FROM tags t INNER JOIN source_tags st ON t.id = st.tag_id WHERE st.source_id = ? ORDER BY t.name`
  ).all(sourceId) as TagRow[]
  const tags: Tag[] = tagRows.map(rowToTag)
  const newTitle = buildTaggedSourceTitle(s.title, tags)
  db.prepare('UPDATE sources SET title = ?, updated_at = ? WHERE id = ?')
    .run(newTitle, new Date().toISOString(), sourceId)
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

  transaction(db, () => {
    db.prepare('UPDATE tags SET name = ? WHERE id = ?')
      .run(newName, id)
    rebuildSourceTitlesForTag(id)
  })

  return getTagById(id)
}

export function deleteTag(id: string): void {
  const db = getDb()
  transaction(db, () => {
    // 先重建受影响资料的标题（移除已删除标签的标记），再删除关联和标签本身
    rebuildSourceTitlesForTag(id)
    db.prepare('DELETE FROM source_tags WHERE tag_id = ?').run(id)
    db.prepare('DELETE FROM tags WHERE id = ?').run(id)
  })
}

export function addTagToSource(sourceId: string, tagId: string): void {
  const db = getDb()
  transaction(db, () => {
    db.prepare('INSERT OR IGNORE INTO source_tags (source_id, tag_id) VALUES (?, ?)').run(sourceId, tagId)
    rebuildSourceTitle(sourceId)
  })
}

export function removeTagFromSource(sourceId: string, tagId: string): void {
  const db = getDb()
  transaction(db, () => {
    db.prepare('DELETE FROM source_tags WHERE source_id = ? AND tag_id = ?').run(sourceId, tagId)
    rebuildSourceTitle(sourceId)
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
    for (const sid of sourceIds) {
      rebuildSourceTitle(sid)
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
