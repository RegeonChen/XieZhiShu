/**
 * migrate.ts —— 存量资料迁移（Phase 2.2 Task 2.2.3）。
 * 将传统导入的 userData/imports 副本一次性迁移到用户工作区：
 * 移动文件 → 计算指纹 → 更新 DB（file_path 为工作区相对路径、workspace=1）。
 * 迁移顺序保证：先移动文件并同步更新 DB 记录，再由监听防抖对账兜底，
 * 不会产生重复导入。重名文件自动追加后缀。
 */
import { app } from 'electron'
import { existsSync, renameSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { getDb } from '../db/connection'
import { fingerprintFile } from './fingerprint'
import { getWorkspaceDir } from './reconcile'

export interface MigrateResult {
  migrated: number
  failed: number
  skipped: number
}

/** 一次性迁移存量导入资料到工作区；未配置工作区或无存量时返回空结果 */
export async function migrateLegacyToWorkspace(): Promise<MigrateResult> {
  const workspaceDir = getWorkspaceDir()
  if (!workspaceDir) return { migrated: 0, failed: 0, skipped: 0 }

  const db = getDb()
  const rows = db
    .prepare("SELECT id, file_path FROM sources WHERE kind = 'file' AND workspace = 0 AND file_path IS NOT NULL")
    .all() as { id: string; file_path: string }[]
  if (rows.length === 0) return { migrated: 0, failed: 0, skipped: 0 }

  const importDir = join(app.getPath('userData'), 'imports')
  const result: MigrateResult = { migrated: 0, failed: 0, skipped: 0 }

  for (const r of rows) {
    const src = join(importDir, r.file_path)
    if (!existsSync(src)) {
      result.skipped += 1
      continue
    }
    try {
      const ext = extname(src)
      const base = basename(src, ext)
      let dest = join(workspaceDir, `${base}${ext}`)
      let i = 1
      while (existsSync(dest)) {
        dest = join(workspaceDir, `${base}_${i}${ext}`)
        i += 1
      }
      // 先移动文件，再更新 DB（监听事件经 500ms 防抖后触发对账，此时 DB 已就绪，不会重复导入）
      renameSync(src, dest)
      const fp = fingerprintFile(dest)
      const now = new Date().toISOString()
      db.prepare(
        `UPDATE sources
         SET file_path = ?, content_hash = ?, file_mtime = ?, file_size = ?, workspace = 1, updated_at = ?
         WHERE id = ?`
      ).run(basename(dest), fp?.contentHash ?? null, fp?.fileMtime ?? null, fp?.fileSize ?? null, now, r.id)
      result.migrated += 1
    } catch {
      result.failed += 1
    }
  }

  return result
}
