/**
 * watcher.ts —— 工作区实时监听（Phase 2.2 Task 2.2.2，性能优化版）。
 * 基于 chokidar 递归监听工作区（Windows 原生 fs.watch 递归不可靠）。
 * 性能要点（2026-08-06 优化）：
 *  - 增量处理：事件自带绝对路径，防抖聚合后只对变更文件调用 reconcilePaths，
 *    改动一个文件即为秒级，不再全量重扫整个工作区。
 *  - 互斥与兜底：对账互斥（runWorkspaceSync）与全量兜底对账由 auto-sync.ts 统一承担
 *    （窗口聚焦 / 进入资料库 / 每分钟定时），watcher 专注实时增量。
 *  - 防环路：对账只做"文件系统 → 数据库"方向、不写文件系统，
 *    应用自身的删除/改名（Task 2.2.3）不会再被监听回调改写，无自触发风暴。
 */
import chokidar, { type FSWatcher } from 'chokidar'
import { relative, join } from 'node:path'
import { getWorkspaceDir, reconcilePaths } from './reconcile'
import { runWorkspaceSync } from './auto-sync'
import { isIgnoredPath } from './scanner'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { setDb, getDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { updateSettings } from '../db/settings'

const DEBOUNCE_MS = 500

let watcher: FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingPaths = new Set<string>()
let onProgress: ((p: { done: number; total: number; newFiles?: number }) => void) | undefined

/** 增量处理：把绝对路径转换为工作区相对路径，经统一调度器交给 reconcilePaths */
function flushPendingPaths(): void {
  if (pendingPaths.size === 0) return
  const dir = getWorkspaceDir()
  if (!dir) {
    pendingPaths.clear()
    return
  }
  const paths = Array.from(pendingPaths)
  pendingPaths = new Set()

  const rels: string[] = []
  for (const p of paths) {
    try {
      const rel = relative(dir, p).split('\\').join('/')
      if (rel && !rel.startsWith('..') && !isIgnoredPath(p)) rels.push(rel)
    } catch {
      // 忽略无法相对化的路径
    }
  }
  if (rels.length === 0) return
  runWorkspaceSync(() => reconcilePaths(rels, onProgress))
}

function scheduleIncremental(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    flushPendingPaths()
  }, DEBOUNCE_MS)
}

/** 启动工作区监听（未配置工作区或已启动时为空操作）；onProgress 转发增量对账进度（Task 2.2.5） */
export function startWorkspaceWatcher(progress?: (p: { done: number; total: number; newFiles?: number }) => void): void {
  const dir = getWorkspaceDir()
  if (!dir || watcher) return
  if (progress) onProgress = progress

  watcher = chokidar.watch(dir, {
    ignoreInitial: true, // 初始扫描由启动对账完成，避免重复
    ignored: (p: string) => isIgnoredPath(p),
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignorePermissionErrors: true
  })
  watcher.on('all', (_event, path) => {
    pendingPaths.add(path)
    scheduleIncremental()
  })
}

export function stopWorkspaceWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (watcher) {
    void watcher.close()
    watcher = null
  }
  pendingPaths = new Set()
}

/** 工作区路径变更后重启监听（可替换 progress 回调，确保切换工作区后增量进度仍推送到界面） */
export function restartWorkspaceWatcher(progress?: (p: { done: number; total: number; newFiles?: number }) => void): void {
  stopWorkspaceWatcher()
  startWorkspaceWatcher(progress)
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    return predicate()
  }

  describe('workspace watcher (Task 2.2.2)', () => {
    it('auto-detects add/change/unlink in the workspace in real time', async () => {
      const db = new Database(':memory:')
      setDb(db)
      runMigrations(db)
      const tmp = mkdtempSync(join(tmpdir(), 'xie-watcher-'))
      updateSettings({ workspaceDir: tmp })

      startWorkspaceWatcher()

      try {
        // 等待 chokidar 完成初始扫描（ready 前的写入会被 ignoreInitial 忽略）
        await new Promise((r) => setTimeout(r, 1000))

        // 1) 新增文件 → 自动入库
        writeFileSync(join(tmp, '实时新增.txt'), '实时新增内容。')
        const added = await waitFor(() => {
          const row = getDb().prepare("SELECT COUNT(*) AS c FROM sources WHERE file_path = '实时新增.txt'").get() as { c: number }
          return row.c === 1
        })
        expect(added).toBe(true)

        // 2) 内容修改 → cleaned_text 自动更新
        writeFileSync(join(tmp, '实时新增.txt'), '实时新增内容——已修改。')
        const changed = await waitFor(() => {
          const row = getDb()
            .prepare("SELECT cleaned_text FROM sources WHERE file_path = '实时新增.txt'")
            .get() as { cleaned_text: string } | undefined
          return row?.cleaned_text.includes('已修改') ?? false
        })
        expect(changed).toBe(true)

        // 3) 删除文件 → 资料库记录实时删除（Task 2.2.4）
        rmSync(join(tmp, '实时新增.txt'))
        const removedOk = await waitFor(() => {
          const c = getDb().prepare("SELECT COUNT(*) AS c FROM sources WHERE file_path = '实时新增.txt'").get() as { c: number }
          return c.c === 0
        })
        expect(removedOk).toBe(true)
      } finally {
        stopWorkspaceWatcher()
        rmSync(tmp, { recursive: true, force: true })
        db.close()
      }
    }, 20000)
  })
}
