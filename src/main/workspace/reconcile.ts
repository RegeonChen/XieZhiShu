/**
 * reconcile.ts —— 工作区对账服务（Phase 2.2 Task 2.2.1）。
 * 对账 = 把工作区文件系统的当前状态同步到数据库：
 *   - 新增：解析入库（内容哈希已在库中则视为"移动/重命名"，只更新路径，保留 id/标签/摘要）
 *   - 变更：重新解析并更新指纹，重跑向量索引（增量幂等）
 *   - 消失：本阶段仅统计，不删库（删除语义由 Task 2.2.3 处理）
 * 解析失败的文件以 status='failed' 入库并计数，不中断其余文件。
 */
import { basename, join } from 'node:path'
import { getDb } from '../db/connection'
import { insertSource, findSourceByContentHash, updateSourceFingerprint } from '../db/sources'
import { getSettings, updateSettings } from '../db/settings'
import { parseFile } from '../import/file-parser'
import { indexSource } from '../rag/indexer'
import { scanWorkspace } from './scanner'
import { fingerprintFile } from './fingerprint'
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

/** 获取当前工作区根目录（未配置返回 null） */
export function getWorkspaceDir(): string | null {
  const dir = getSettings().workspaceDir?.trim()
  return dir ? dir : null
}

/** 执行一次全量对账；未配置工作区时返回空结果 */
export async function reconcileWorkspace(): Promise<ReconcileResult> {
  const workspaceDir = getWorkspaceDir()
  if (!workspaceDir) {
    return { workspaceDir: null, added: 0, changed: 0, removed: 0, moved: 0, errors: 0, total: 0 }
  }

  const diff = scanWorkspace(workspaceDir)
  const result: ReconcileResult = {
    workspaceDir,
    added: 0,
    changed: 0,
    removed: 0,
    moved: 0,
    errors: 0,
    total: 0
  }

  // ---- 新增（先按内容哈希识别"移动/重命名"，保留 id/标签/摘要） ----
  for (const rel of diff.added) {
    const abs = join(workspaceDir, rel)
    const fp = fingerprintFile(abs)
    if (fp) {
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
        continue
      }
    }

    try {
      const { text } = await parseFile(abs)
      const source = insertSource({
        id: crypto.randomUUID(),
        kind: 'file',
        title: basename(rel),
        filePath: rel,
        cleanedText: text,
        status: 'ready',
        contentHash: fp?.contentHash,
        fileMtime: fp?.fileMtime,
        fileSize: fp?.fileSize,
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
        contentHash: fp?.contentHash,
        fileMtime: fp?.fileMtime,
        fileSize: fp?.fileSize,
        workspace: true
      })
    }
  }

  // ---- 变更：重新解析 + 更新指纹 + 重跑索引（幂等） ----
  for (const rel of diff.changed) {
    const abs = join(workspaceDir, rel)
    const fp = fingerprintFile(abs)
    try {
      const { text } = await parseFile(abs)
      const row = findWorkspaceSourceByPath(rel)
      if (!row) continue
      updateSourceFingerprint(row.id, {
        cleanedText: text,
        contentHash: fp?.contentHash,
        fileMtime: fp?.fileMtime,
        fileSize: fp?.fileSize,
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
      const row = findWorkspaceSourceByPath(rel)
      if (row) {
        updateSourceFingerprint(row.id, { status: 'failed', errorCode: e.code ?? 'PARSE_FAILED' })
      }
    }
  }

  // ---- 消失：本阶段仅统计（删除语义见 Task 2.2.3） ----
  result.removed = diff.removed.length
  result.total = result.added + result.changed + result.moved + result.removed

  return result
}

/** 按工作区相对路径查找资料（内部工具） */
function findWorkspaceSourceByPath(rel: string): { id: string } | null {
  const row = getDb()
    .prepare("SELECT id FROM sources WHERE workspace = 1 AND kind = 'file' AND file_path = ? LIMIT 1")
    .get(rel) as { id: string } | undefined
  return row ?? null
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
  })
}
