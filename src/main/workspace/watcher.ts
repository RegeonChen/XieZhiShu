/**
 * watcher.ts —— 工作区实时监听（Phase 2.2 Task 2.2.2）。
 * 基于 chokidar 递归监听工作区（Windows 原生 fs.watch 递归不可靠），
 * 事件防抖聚合后触发一次增量对账（新增/变更→解析+索引；删除→统计），
 * 并设 5 分钟兜底对账定时器覆盖监听漏事件场景（网络盘/杀软干扰）。
 * 防环路：对账只做"文件系统 → 数据库"方向、不写文件系统，
 * 应用自身的删除/改名（Task 2.2.3）不会再被监听回调改写，无自触发风暴。
 */
import chokidar, { type FSWatcher } from 'chokidar'
import { getWorkspaceDir, reconcileWorkspace } from './reconcile'
import { isIgnoredPath } from './scanner'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { setDb, getDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { updateSettings } from '../db/settings'

const DEBOUNCE_MS = 500
const HEARTBEAT_MS = 5 * 60 * 1000

let watcher: FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconciling = false

async function runReconcile(): Promise<void> {
  if (reconciling) return
  reconciling = true
  try {
    await reconcileWorkspace()
  } catch (err) {
    console.error('workspace reconcile failed:', err)
  } finally {
    reconciling = false
  }
}

function scheduleReconcile(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runReconcile()
  }, DEBOUNCE_MS)
}

/** 启动工作区监听（未配置工作区或已启动时为空操作） */
export function startWorkspaceWatcher(): void {
  const dir = getWorkspaceDir()
  if (!dir || watcher) return

  watcher = chokidar.watch(dir, {
    ignoreInitial: true, // 初始扫描由启动对账完成，避免重复
    ignored: (p: string) => isIgnoredPath(p),
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignorePermissionErrors: true
  })
  watcher.on('all', () => scheduleReconcile())

  // 兜底对账：覆盖监听漏事件场景
  heartbeatTimer = setInterval(() => {
    void runReconcile()
  }, HEARTBEAT_MS)
}

export function stopWorkspaceWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (watcher) {
    void watcher.close()
    watcher = null
  }
}

/** 工作区路径变更后重启监听 */
export function restartWorkspaceWatcher(): void {
  stopWorkspaceWatcher()
  startWorkspaceWatcher()
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

        // 3) 删除文件 → 文件系统确实消失（库记录保留，删除语义属 Task 2.2.3）
        rmSync(join(tmp, '实时新增.txt'))
        const removedOk = await waitFor(() => readdirSync(tmp).length === 0)
        expect(removedOk).toBe(true)
      } finally {
        stopWorkspaceWatcher()
        rmSync(tmp, { recursive: true, force: true })
        db.close()
      }
    }, 20000)
  })
}
