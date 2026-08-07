/**
 * sync.ts —— 工作区反向同步（Phase 2.2 Task 2.2.3）。
 * 软件侧操作同步回本地文件：
 *  - 删除资料 → shell.trashItem 移入系统回收站（可反悔）
 *  - 改名资料 → 重命名工作区原文件（保留扩展名，重名自动加后缀）
 */
import { app, shell } from 'electron'
import { existsSync, renameSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, extname, join, sep } from 'node:path'
import type { Source } from '../../shared/types'
import { getWorkspaceDir } from './reconcile'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { updateSettings } from '../db/settings'

/** 解析资料文件绝对路径（workspace 资料指向工作区；其余指向旧的 userData/imports 目录） */
export function resolveSourceFilePath(source: Source): string | null {
  if (source.kind !== 'file' || !source.filePath) return null
  if (source.workspace) {
    const dir = getWorkspaceDir()
    return dir ? join(dir, source.filePath) : null
  }
  return join(app.getPath('userData'), 'imports', source.filePath)
}

/** 将资料原文件移入系统回收站；文件不存在视为已删除，返回成功 */
export async function trashSourceFile(source: Source): Promise<boolean> {
  const abs = resolveSourceFilePath(source)
  if (!abs) return true // 无文件路径（如 URL 资料）无需处理
  if (!existsSync(abs)) return true
  await shell.trashItem(abs)
  return true
}

/** Windows 文件名非法字符清洗（< > : " / \ | ? * 及控制字符） */
export function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || '未命名'
}

/**
 * 重命名工作区原文件（保留扩展名；目标重名自动加后缀），返回新的工作区相对路径。
 * 仅适用于 workspace=1 的文件资料；其余返回 null。
 */
export function renameSourceFile(source: Source, newTitle: string): string | null {
  if (source.kind !== 'file' || !source.filePath || !source.workspace) return null
  const dir = getWorkspaceDir()
  if (!dir) return null

  const ext = extname(source.filePath)
  const baseDir = dirname(source.filePath)
  const relDir = baseDir === '.' ? '' : `${baseDir.replace(/\\/g, '/')}/`

  let newRel = `${relDir}${sanitizeFileName(newTitle)}${ext}`
  let abs = join(dir, newRel)
  const oldAbs = join(dir, source.filePath)
  let i = 1
  while (existsSync(abs) && abs.toLowerCase() !== oldAbs.toLowerCase()) {
    newRel = `${relDir}${sanitizeFileName(newTitle)} (${i})${ext}`
    abs = join(dir, newRel)
    i += 1
  }
  renameSync(oldAbs, abs)
  return newRel.split(sep).join('/')
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  let tmp: string

  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
    tmp = mkdtempSync(join(tmpdir(), 'xie-sync-'))
    updateSettings({ workspaceDir: tmp })
  })
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
    db.close()
  })

  describe('workspace sync (Task 2.2.3)', () => {
    it('sanitizes illegal Windows filename characters', () => {
      expect(sanitizeFileName('关于<>:"/\\|?* 的报告')).toBe('关于_________ 的报告')
      expect(sanitizeFileName('   ')).toBe('未命名')
    })

    it('resolves workspace source file path', () => {
      const s: Source = {
        id: 'x', kind: 'file', title: 'a.md', filePath: '子目录/a.md', cleanedText: '', status: 'ready', workspace: true,
        createdAt: '', updatedAt: ''
      }
      expect(resolveSourceFilePath(s)).toBe(join(tmp, '子目录', 'a.md'))
      // 无文件路径的资料返回 null
      expect(resolveSourceFilePath({ ...s, filePath: undefined })).toBeNull()
    })

    it('renames the workspace file keeping extension', () => {
      writeFileSync(join(tmp, '旧标题.txt'), '内容')
      const s: Source = {
        id: 'x', kind: 'file', title: '旧标题.txt', filePath: '旧标题.txt', cleanedText: '', status: 'ready', workspace: true,
        createdAt: '', updatedAt: ''
      }
      const newRel = renameSourceFile(s, '新标题')
      expect(newRel).toBe('新标题.txt')
      expect(existsSync(join(tmp, '新标题.txt'))).toBe(true)
      expect(existsSync(join(tmp, '旧标题.txt'))).toBe(false)
    })

    it('appends a suffix when the target name already exists', () => {
      writeFileSync(join(tmp, '同名.txt'), '旧文件')
      writeFileSync(join(tmp, '源文件.txt'), '源内容')
      const s: Source = {
        id: 'x', kind: 'file', title: '源文件.txt', filePath: '源文件.txt', cleanedText: '', status: 'ready', workspace: true,
        createdAt: '', updatedAt: ''
      }
      const newRel = renameSourceFile(s, '同名')
      expect(newRel).toBe('同名 (1).txt')
      expect(existsSync(join(tmp, '同名 (1).txt'))).toBe(true)
    })
  })
}
