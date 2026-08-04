/**
 * sources repository —— 资料 CRUD + 全文检索。
 * 遵循 better-sqlite3 同步风格，FTS5 触发器自动维护索引。
 */
import type { Source, SourceStatus } from '../../shared/types'
import { getDb } from './connection'

export interface SourceRow {
  id: string
  kind: 'file' | 'url'
  title: string
  file_path: string | null
  url: string | null
  url_snapshot_at: string | null
  raw_text: string | null
  cleaned_text: string
  status: SourceStatus
  error_code: string | null
  created_at: string
  updated_at: string
}

function rowToSource(row: SourceRow): Source {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    filePath: row.file_path ?? undefined,
    url: row.url ?? undefined,
    urlSnapshotAt: row.url_snapshot_at ?? undefined,
    cleanedText: row.cleaned_text,
    status: row.status,
    errorCode: row.error_code ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listSources(params?: { tagIds?: string[]; search?: string }): Source[] {
  const db = getDb()

  if (params?.search) {
    // FTS5 全文检索
    const rows = db
      .prepare(
        `SELECT s.* FROM sources s
         INNER JOIN sources_fts ON sources_fts.rowid = s.rowid
         WHERE sources_fts MATCH ?
         ORDER BY rank LIMIT 50`
      )
      .all(params.search) as SourceRow[]
    return rows.map(rowToSource)
  }

  if (params?.tagIds && params.tagIds.length > 0) {
    const placeholders = params.tagIds.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT DISTINCT s.* FROM sources s
         INNER JOIN source_tags st ON st.source_id = s.id
         WHERE st.tag_id IN (${placeholders})
         ORDER BY s.created_at DESC`
      )
      .all(...params.tagIds) as SourceRow[]
    return rows.map(rowToSource)
  }

  const rows = db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all() as SourceRow[]
  return rows.map(rowToSource)
}

export function getSourceById(id: string): Source | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined
  return row ? rowToSource(row) : null
}

export function insertSource(source: Omit<Source, 'createdAt' | 'updatedAt'>): Source {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO sources (id, kind, title, file_path, url, url_snapshot_at, cleaned_text, status, error_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    source.id,
    source.kind,
    source.title,
    source.filePath ?? null,
    source.url ?? null,
    source.urlSnapshotAt ?? null,
    source.cleanedText,
    source.status,
    source.errorCode ?? null,
    now,
    now
  )
  return { ...source, createdAt: now, updatedAt: now }
}

export function updateSourceTitle(id: string, title: string): Source | null {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare('UPDATE sources SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id)
  return getSourceById(id)
}

export function deleteSource(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM sources WHERE id = ?').run(id)
}
