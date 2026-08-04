/**
 * template-books repository —— 范本 CRUD。
 */
import type { TemplateBook } from '../../shared/types'
import { getDb } from './connection'

interface TemplateRow {
  id: string
  name: string
  file_path: string
  outline_json: string
  style_profile_json: string | null
  created_at: string
}

function rowToTemplate(row: TemplateRow): TemplateBook {
  return {
    id: row.id,
    name: row.name,
    filePath: row.file_path,
    outline: row.outline_json,
    styleProfile: row.style_profile_json ?? undefined,
    createdAt: row.created_at
  }
}

export function listTemplates(): TemplateBook[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM template_books ORDER BY created_at DESC').all() as TemplateRow[]
  return rows.map(rowToTemplate)
}

export function getTemplateById(id: string): TemplateBook | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM template_books WHERE id = ?').get(id) as TemplateRow | undefined
  return row ? rowToTemplate(row) : null
}

export function insertTemplate(name: string, filePath: string, outlineJson: string): TemplateBook {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO template_books (id, name, file_path, outline_json, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, name, filePath, outlineJson, now)
  return { id, name, filePath, outline: outlineJson, createdAt: now }
}

export function deleteTemplate(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM template_books WHERE id = ?').run(id)
}
