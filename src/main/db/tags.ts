/**
 * tags repository —— 标签 CRUD + 关联操作
 */
import type { Tag } from '../../shared/types'
import { getDb } from './connection'

interface TagRow {
  id: string
  name: string
  color: string | null
  created_at: string
}

function rowToTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    color: row.color ?? undefined,
    createdAt: row.created_at
  }
}

export function listTags(): Tag[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM tags ORDER BY created_at ASC').all() as TagRow[]
  return rows.map(rowToTag)
}

export function getTagById(id: string): Tag | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow | undefined
  return row ? rowToTag(row) : null
}

export function createTag(name: string, color?: string): Tag {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    color ?? null,
    now
  )
  return { id, name, color, createdAt: now }
}

export function updateTag(id: string, name?: string, color?: string): Tag | null {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow | undefined
  if (!existing) return null
  db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(
    name ?? existing.name,
    color !== undefined ? color : existing.color,
    id
  )
  return getTagById(id)
}

export function deleteTag(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM tags WHERE id = ?').run(id)
}

export function addTagToSource(sourceId: string, tagId: string): void {
  const db = getDb()
  db.prepare('INSERT OR IGNORE INTO source_tags (source_id, tag_id) VALUES (?, ?)').run(sourceId, tagId)
}

export function removeTagFromSource(sourceId: string, tagId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM source_tags WHERE source_id = ? AND tag_id = ?').run(sourceId, tagId)
}
