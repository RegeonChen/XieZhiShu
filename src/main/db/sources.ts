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
  content_hash: string | null
  file_mtime: string | null
  file_size: number | null
  workspace: number
  task_id: string | null
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
    contentHash: row.content_hash ?? undefined,
    fileMtime: row.file_mtime ?? undefined,
    fileSize: row.file_size ?? undefined,
    workspace: row.workspace === 1,
    taskId: row.task_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listSources(params?: { tagIds?: string[]; search?: string }): Source[] {
  const db = getDb()

  // 只返回长期资料（task_id IS NULL）：任务绑定的网页缓存文章不进资料库列表（2026-08-13）
  if (params?.search) {
    // FTS5 全文检索
    const rows = db
      .prepare(
        `SELECT s.* FROM sources s
         INNER JOIN sources_fts ON sources_fts.rowid = s.rowid
         WHERE sources_fts MATCH ? AND s.task_id IS NULL
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
         WHERE st.tag_id IN (${placeholders}) AND s.task_id IS NULL
         GROUP BY s.id
         HAVING COUNT(DISTINCT st.tag_id) = ${params.tagIds.length}
         ORDER BY s.created_at DESC`
      )
      .all(...params.tagIds) as SourceRow[]
    return rows.map(rowToSource)
  }

  const rows = db.prepare('SELECT * FROM sources WHERE task_id IS NULL ORDER BY created_at DESC').all() as SourceRow[]
  return rows.map(rowToSource)
}

export function getSourceById(id: string): Source | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined
  return row ? rowToSource(row) : null
}

/** 按抓取网址定位资料（网页资料库增量判断：已抓过则跳过）。taskId 非空时按 (url, task_id) 判重，否则仅匹配长期资料（task_id IS NULL） */
export function getSourceByUrl(url: string, taskId?: string): Source | null {
  const db = getDb()
  const row = (taskId
    ? db.prepare('SELECT * FROM sources WHERE url = ? AND task_id = ?').get(url, taskId)
    : db.prepare('SELECT * FROM sources WHERE url = ? AND task_id IS NULL').get(url)) as SourceRow | undefined
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
    `INSERT INTO sources (id, kind, title, file_path, url, url_snapshot_at, cleaned_text, status, error_code,
       content_hash, file_mtime, file_size, workspace, task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    source.contentHash ?? null,
    source.fileMtime ?? null,
    source.fileSize ?? null,
    source.workspace ? 1 : 0,
    source.taskId ?? null,
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

// ============================================================
// Phase 2.2 工作区支持：指纹更新 / 按内容哈希定位
// ============================================================

export interface SourceFingerprintPatch {
  cleanedText?: string
  contentHash?: string
  fileMtime?: string
  fileSize?: number
  filePath?: string
  status?: SourceStatus
  errorCode?: string | null
  workspace?: boolean
  title?: string
}

/** 更新资料的正文与文件指纹（工作区扫描/对账时调用） */
export function updateSourceFingerprint(id: string, patch: SourceFingerprintPatch): Source | null {
  const db = getDb()
  const now = new Date().toISOString()
  const fields: string[] = []
  const values: (string | number | null)[] = []
  const push = (col: string, v: string | number | null | undefined): void => {
    fields.push(`${col} = ?`)
    values.push(v ?? null)
  }
  if (patch.cleanedText !== undefined) push('cleaned_text', patch.cleanedText)
  if (patch.contentHash !== undefined) push('content_hash', patch.contentHash)
  if (patch.fileMtime !== undefined) push('file_mtime', patch.fileMtime)
  if (patch.fileSize !== undefined) push('file_size', patch.fileSize)
  if (patch.filePath !== undefined) push('file_path', patch.filePath)
  if (patch.status !== undefined) push('status', patch.status)
  if (patch.errorCode !== undefined) push('error_code', patch.errorCode)
  if (patch.workspace !== undefined) push('workspace', patch.workspace ? 1 : 0)
  if (patch.title !== undefined) push('title', patch.title)
  if (fields.length === 0) return getSourceById(id)
  db.prepare(`UPDATE sources SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, now, id)
  return getSourceById(id)
}

/** 按内容 sha256 查找工作区资料（用于文件移动/重命名时保持 id/标签/摘要） */
export function findSourceByContentHash(contentHash: string): Source | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM sources WHERE workspace = 1 AND content_hash = ? LIMIT 1').get(contentHash) as
    | SourceRow
    | undefined
  return row ? rowToSource(row) : null
}

/**
 * 按内容 sha256 查找「存量导入副本」（workspace=0 的旧导入文件，2026-08-24 审计）：
 * 用户把同一批文件既通过旧版「导入文件」存过副本、又将来源文件夹指定为工作区时，
 * 会出现「旧副本记录 + 工作区记录」并存导致同一文件显示两次。
 * 对账扫描到工作区内同哈希文件时，用此函数定位旧记录并吸收（保留 id/标签/摘要），而非再插一行。
 */
export function findLegacySourceByContentHash(contentHash: string): Source | null {
  const db = getDb()
  const row = db
    .prepare(
      "SELECT * FROM sources WHERE kind = 'file' AND content_hash = ? AND workspace = 0 ORDER BY created_at ASC, rowid ASC LIMIT 1"
    )
    .get(contentHash) as SourceRow | undefined
  return row ? rowToSource(row) : null
}
