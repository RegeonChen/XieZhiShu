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
    // AND 语义：同时具有所有所选标签
    const placeholders = params.tagIds.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT s.* FROM sources s
         INNER JOIN source_tags st ON st.source_id = s.id
         WHERE st.tag_id IN (${placeholders})
         GROUP BY s.id
         HAVING COUNT(DISTINCT st.tag_id) = ${params.tagIds.length}
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

/** 批量按 ID 获取资料（保持传入顺序去重；用于 RAG 检索范围） */
export function getSourcesByIds(ids: string[]): Source[] {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return []
  const db = getDb()
  const placeholders = unique.map(() => '?').join(',')
  const rows = db.prepare(`SELECT * FROM sources WHERE id IN (${placeholders})`).all(...unique) as SourceRow[]
  const byId = new Map(rows.map((r) => [r.id, rowToSource(r)]))
  return unique.map((id) => byId.get(id)).filter((s): s is Source => s != null)
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

/** 批量删除资料（事务包裹，级联清理标签关联与 FTS 索引） */
export function deleteSources(ids: string[]): void {
  const db = getDb()
  const del = db.prepare('DELETE FROM sources WHERE id = ?')
  const tx = db.transaction((list: string[]) => {
    for (const id of list) del.run(id)
  })
  tx(ids)
}
