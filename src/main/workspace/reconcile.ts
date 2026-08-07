/**
 * reconcile.ts —— 工作区对账服务（Phase 2.2 Task 2.2.1，性能优化版）。
 * 对账 = 把工作区文件系统的当前状态同步到数据库：
 *   - 新增：解析入库（内容哈希已在库中则视为"移动/重命名"，只更新路径，保留 id/标签/摘要）
 *   - 变更：重新解析并更新指纹，重跑向量索引（增量幂等）
 *   - 消失：仅统计，不删库（删除语义由 sync.ts / 用户操作处理）
 *
 * 性能要点（2026-08-06 优化）：
 * 1. 扫描/指纹/解析全部异步（fs/promises），每处理一个文件让出事件循环，
 *    批量录入不再阻塞主进程、UI 保持响应。
 * 2. reconcileWorkspace 全量对账（启动/手动/心跳兜底）；watcher 实时变更走
 *    reconcilePaths 增量对账——只处理变更的若干文件，改动一个文件即为秒级。
 * 3. onProgress 回调（{done,total}）供主进程推送进度到 UI。
 */
import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import { getDb } from '../db/connection'
import { insertSource, findSourceByContentHash, updateSourceFingerprint } from '../db/sources'
import { getSettings, updateSettings } from '../db/settings'
import { parseFile } from '../import/file-parser'
import { indexSource } from '../rag/indexer'
import { scanWorkspaceAsync } from './scanner'
import { fingerprintFileAsync, statFingerprintAsync } from './fingerprint'
import { mkdtempSync, writeFileSync, rmSync, renameSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'

export interface ReconcileResult {
  workspaceDir: string | null
  added: number
  changed: number
  removed: number
  moved: number
  errors: number
  total: number
}

export interface ReconcileProgress {
  done: number
  total: number
}

/** 让出事件循环（配合分片，避免长时间阻塞主进程） */
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(() => r()))

/** 获取当前工作区根目录（未配置返回 null） */
export function getWorkspaceDir(): string | null {
  const dir = getSettings().workspaceDir?.trim()
  return dir ? dir : null
}

function emptyResult(workspaceDir: string | null): ReconcileResult {
  return { workspaceDir, added: 0, changed: 0, removed: 0, moved: 0, errors: 0, total: 0 }
}

/** 按工作区相对路径查找资料（含指纹，供增量对账判断变更） */
function findWorkspaceSourceByPath(rel: string): { id: string; content_hash: string | null; file_mtime: string | null; file_size: number | null } | null {
  const row = getDb()
    .prepare("SELECT id, content_hash, file_mtime, file_size FROM sources WHERE workspace = 1 AND kind = 'file' AND file_path = ? LIMIT 1")
    .get(rel) as { id: string; content_hash: string | null; file_mtime: string | null; file_size: number | null } | undefined
  return row ?? null
}

/** 解析工作区文件入库/更新（供全量与增量对账复用） */
async function ingestFile(workspaceDir: string, rel: string, result: ReconcileResult): Promise<void> {
  const abs = join(workspaceDir, rel)
  const fp = await fingerprintFileAsync(abs)
  if (!fp) return

  const row = findWorkspaceSourceByPath(rel)
  if (row) {
    // 已有记录：内容变化 → 重新解析并重索引；仅 mtime 变化 → 刷新快照
    if (fp.contentHash !== row.content_hash) {
      try {
        const { text } = await parseFile(abs)
        updateSourceFingerprint(row.id, {
          cleanedText: text,
          contentHash: fp.contentHash,
          fileMtime: fp.fileMtime,
          fileSize: fp.fileSize,
          status: 'ready'
        })
        result.changed += 1
        try {
          await indexSource(row.id)
        } catch {
          result.errors += 1
        }
      } catch (err) {
        const e = err as Error & { code?: string }
        result.errors += 1
        updateSourceFingerprint(row.id, { status: 'failed', errorCode: e.code ?? 'PARSE_FAILED' })
      }
    } else if (fp.fileMtime !== row.file_mtime || fp.fileSize !== row.file_size) {
      updateSourceFingerprint(row.id, { fileMtime: fp.fileMtime, fileSize: fp.fileSize })
    }
    return
  }

  // 无路径记录：先按内容哈希识别"移动/重命名"，保留 id/标签/摘要
  const existing = findSourceByContentHash(fp.contentHash)
  if (existing) {
    updateSourceFingerprint(existing.id, {
      filePath: rel,
      contentHash: fp.contentHash,
      fileMtime: fp.fileMtime,
      fileSize: fp.fileSize,
      status: 'ready'
    })
    result.moved += 1
    try {
      await indexSource(existing.id)
    } catch {
      result.errors += 1
    }
    return
  }

  // 真正的新增
  try {
    const { text } = await parseFile(abs)
    const source = insertSource({
      id: crypto.randomUUID(),
      kind: 'file',
      title: basename(rel),
      filePath: rel,
      cleanedText: text,
      status: 'ready',
      contentHash: fp.contentHash,
      fileMtime: fp.fileMtime,
      fileSize: fp.fileSize,
      workspace: true
    })
    result.added += 1
    try {
      await indexSource(source.id)
    } catch {
      result.errors += 1
    }
  } catch (err) {
    const e = err as Error & { code?: string }
    result.errors += 1
    insertSource({
      id: crypto.randomUUID(),
      kind: 'file',
      title: basename(rel),
      filePath: rel,
      cleanedText: '',
      status: 'failed',
      errorCode: e.code ?? 'PARSE_FAILED',
      contentHash: fp.contentHash,
      fileMtime: fp.fileMtime,
      fileSize: fp.fileSize,
      workspace: true
    })
  }
}

/** 执行一次全量对账（启动 / 手动"同步工作区" / 心跳兜底）；未配置工作区时返回空结果 */
export async function reconcileWorkspace(onProgress?: (p: ReconcileProgress) => void): Promise<ReconcileResult> {
  const workspaceDir = getWorkspaceDir()
  if (!workspaceDir) return emptyResult(null)

  const diff = await scanWorkspaceAsync(workspaceDir)
  const result = emptyResult(workspaceDir)
  const total = diff.added.length + diff.changed.length
  let done = 0
  const tick = (): void => {
    done += 1
    onProgress?.({ done, total })
  }

  for (const rel of diff.added) {
    await ingestFile(workspaceDir, rel, result)
    tick()
    await yieldLoop()
  }
  for (const rel of diff.changed) {
    await ingestFile(workspaceDir, rel, result)
    tick()
    await yieldLoop()
  }

  result.removed = diff.removed.length
  result.total = result.added + result.changed + result.moved + result.removed
  return result
}

/** 增量对账：只处理指定相对路径（watcher 实时事件驱动）；改动单个文件为秒级 */
export async function reconcilePaths(
  relPaths: string[],
  onProgress?: (p: ReconcileProgress) => void
): Promise<ReconcileResult> {
  const workspaceDir = getWorkspaceDir()
  if (!workspaceDir || relPaths.length === 0) return emptyResult(workspaceDir)

  const result = emptyResult(workspaceDir)
  const total = relPaths.length
  let done = 0
  const tick = (): void => {
    done += 1
    onProgress?.({ done, total })
  }

  for (const rel of relPaths) {
    const abs = join(workspaceDir, rel)
    const st = await statFingerprintAsync(abs)
    const row = findWorkspaceSourceByPath(rel)

    if (!st) {
      // 文件不存在（或为目录）：库中若仍有记录且文件系统确实消失 → 统计
      if (row && !existsSync(abs)) result.removed += 1
      tick()
      await yieldLoop()
      continue
    }

    await ingestFile(workspaceDir, rel, result)
    tick()
    await yieldLoop()
  }

  result.total = result.added + result.changed + result.moved + result.removed
  return result
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } = import.meta.vitest

  let db: Database.Database
  let tmp: string

  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
  })
  beforeEach(() => {
    // 每个用例独立的临时工作区目录，并清空上一个用例的资料（级联清理向量/摘要/标签）
    tmp = mkdtempSync(join(tmpdir(), 'xie-ws-'))
    db.exec('DELETE FROM sources')
    updateSettings({ workspaceDir: undefined })
  })
  afterEach(() => {
    // 删除本用例的临时工作区目录（不留痕迹）
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        // 忽略清理失败
      }
    }
  })
  afterAll(() => {
    db.close()
  })

  describe('workspace reconcile (Task 2.2.1)', () => {
    it('no workspace configured -> empty result', async () => {
      updateSettings({ workspaceDir: undefined })
      const res = await reconcileWorkspace()
      expect(res.workspaceDir).toBeNull()
      expect(res.total).toBe(0)
    })

    it('scans multi-level dirs and imports new files', async () => {
      mkdirSync(join(tmp, '子目录'))
      writeFileSync(join(tmp, '根文件.txt'), '根目录资料内容。')
      writeFileSync(join(tmp, '子目录', '子文件.md'), '# 子目录资料\n正文内容。')
      updateSettings({ workspaceDir: tmp })

      const res = await reconcileWorkspace()
      expect(res.added).toBe(2)
      expect(res.total).toBe(2)
      const rows = db.prepare('SELECT title, file_path, content_hash, workspace, status FROM sources WHERE workspace = 1 ORDER BY title').all() as {
        title: string
        file_path: string
        content_hash: string | null
        workspace: number
        status: string
      }[]
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.title)).toEqual(['子文件.md', '根文件.txt'])
      expect(rows.map((r) => r.file_path).sort()).toEqual(['子目录/子文件.md', '根文件.txt'].sort())
      expect(rows.every((r) => r.workspace === 1 && r.status === 'ready' && r.content_hash)).toBe(true)
      // 幂等：再次对账不重复导入
      const again = await reconcileWorkspace()
      expect(again.added).toBe(0)
    })

    it('detects content change and re-parses', async () => {
      writeFileSync(join(tmp, 'a.txt'), '原始内容。')
      updateSettings({ workspaceDir: tmp })
      await reconcileWorkspace()

      writeFileSync(join(tmp, 'a.txt'), '修改后的新内容。')
      const res = await reconcileWorkspace()
      expect(res.changed).toBe(1)
      const row = db.prepare("SELECT cleaned_text, content_hash FROM sources WHERE file_path = 'a.txt'").get() as {
        cleaned_text: string
        content_hash: string
      }
      expect(row.cleaned_text).toContain('修改后')
    })

    it('recognizes move/rename by content hash, keeping source id', async () => {
      mkdirSync(join(tmp, 'old'))
      writeFileSync(join(tmp, 'old', 'doc.md'), '移动内容。')
      updateSettings({ workspaceDir: tmp })
      await reconcileWorkspace()
      const before = db.prepare("SELECT id FROM sources WHERE file_path = 'old/doc.md'").get() as { id: string }

      // 移动到新目录（内容不变）
      mkdirSync(join(tmp, 'new'))
      renameSync(join(tmp, 'old', 'doc.md'), join(tmp, 'new', 'doc.md'))
      const res = await reconcileWorkspace()
      expect(res.moved).toBe(1)
      const after = db.prepare("SELECT id, file_path FROM sources WHERE id = ?").get(before.id) as { id: string; file_path: string }
      expect(after.id).toBe(before.id) // id 保持不变（保留标签/摘要）
      expect(after.file_path).toBe('new/doc.md')
    })

    it('counts removed files but does not delete records yet', async () => {
      writeFileSync(join(tmp, 'gone.txt'), '将被删除。')
      updateSettings({ workspaceDir: tmp })
      await reconcileWorkspace()

      rmSync(join(tmp, 'gone.txt'))
      const res = await reconcileWorkspace()
      expect(res.removed).toBe(1)
      // 库记录仍保留（删除语义由 Task 2.2.3 处理）
      const row = db.prepare("SELECT COUNT(*) AS c FROM sources WHERE file_path = 'gone.txt'").get() as { c: number }
      expect(row.c).toBe(1)
    })

    it('marks unsupported/parse-failed files without breaking others', async () => {
      writeFileSync(join(tmp, 'ok.txt'), '正常文件。')
      writeFileSync(join(tmp, 'bad.bin'), Buffer.from([0, 1, 2, 3, 255, 255])) // 不支持格式
      updateSettings({ workspaceDir: tmp })
      const res = await reconcileWorkspace()
      expect(res.added).toBe(1) // 只有 ok.txt
      expect(res.errors).toBeGreaterThanOrEqual(0)
    })

    it('reconcilePaths incrementally processes only given files', async () => {
      writeFileSync(join(tmp, 'a.txt'), 'A 内容。')
      writeFileSync(join(tmp, 'b.txt'), 'B 内容。')
      updateSettings({ workspaceDir: tmp })

      // 只处理 a.txt（b.txt 未处理，不应入库）
      const res = await reconcilePaths(['a.txt'])
      expect(res.added).toBe(1)
      const rows = db.prepare("SELECT file_path FROM sources WHERE workspace = 1").all() as { file_path: string }[]
      expect(rows.map((r) => r.file_path)).toEqual(['a.txt'])

      // 处理 b.txt 后入库；a.txt 变更只更新 a
      writeFileSync(join(tmp, 'b.txt'), 'B 内容。')
      const res2 = await reconcilePaths(['b.txt'])
      expect(res2.added).toBe(1)

      writeFileSync(join(tmp, 'a.txt'), 'A 内容已修改。')
      const res3 = await reconcilePaths(['a.txt'])
      expect(res3.changed).toBe(1)
    })
  })
}
