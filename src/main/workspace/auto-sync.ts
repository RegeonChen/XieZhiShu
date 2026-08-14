/**
 * auto-sync.ts —— 工作区同步统一调度器（Task 2.2.5）。
 * 职责：
 *  - 全量对账（reconcileWorkspace）的确定性触发源：窗口聚焦 / 进入资料库 / 每分钟定时 / 启动。
 *    每个触发的效果与手动点击"同步工作区"按钮完全一致（全量对账 + 进度推送）。
 *  - 通用互斥调度 `runWorkspaceSync`：全量对账与 watcher 增量对账共用，
 *    同一时刻只跑一个对账任务，期间到达的请求排队补跑（事件不丢）。
 * 全量对账带 mtime/size 快筛，重复触发开销低。
 */
import { getWorkspaceDir, reconcileWorkspace, type ReconcileProgress } from './reconcile'
import Database from 'better-sqlite3'
import { setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { updateSettings } from '../db/settings'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let busy = false
let queued = false

/**
 * 通用工作区对账调度：同一时刻只跑一个对账任务（全量对账 / watcher 增量对账共用）。
 * 对账进行中到达的新请求不丢弃——置 queued 标记，当前任务结束后立即补跑同一个任务。
 */
export function runWorkspaceSync(task: () => Promise<unknown>): void {
  if (busy) {
    queued = true
    return
  }
  busy = true
  void (async () => {
    try {
      await task()
    } catch (err) {
      console.error('workspace sync failed:', err)
    } finally {
      busy = false
      if (queued) {
        queued = false
        runWorkspaceSync(task)
      }
    }
  })()
}

/** 触发一次全量对账（效果等同手动"同步工作区"） */
export function requestWorkspaceSync(onProgress?: (p: ReconcileProgress) => void): void {
  if (!getWorkspaceDir()) return
  runWorkspaceSync(() => reconcileWorkspace(onProgress))
}

let timer: ReturnType<typeof setInterval> | null = null

/** 每分钟自动触发一次全量对账（需求 3）；未配置工作区时定时器保持空闲，配置后自动生效 */
export function startAutoSyncTimer(onProgress?: (p: ReconcileProgress) => void): void {
  if (timer) return
  timer = setInterval(() => requestWorkspaceSync(onProgress), 60 * 1000)
}

export function stopAutoSyncTimer(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 是否有全量对账正在执行（测试与状态展示用） */
export function isWorkspaceSyncBusy(): boolean {
  return busy
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
  })
  afterAll(() => db.close())

  describe('workspace auto-sync (Task 2.2.5)', () => {
    it('does nothing without a configured workspace', async () => {
      updateSettings({ workspaceDir: undefined })
      requestWorkspaceSync()
      await new Promise((r) => setTimeout(r, 30))
      expect(getWorkspaceDir()).toBeNull()
    })

    it('triggers a full reconcile (same as manual sync) when workspace is configured', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'xie-autosync-'))
      try {
        writeFileSync(join(tmp, 'a.txt'), 'A 内容。')
        updateSettings({ workspaceDir: tmp })
        requestWorkspaceSync()
        // 轮询等待对账完成
        const ok = await new Promise<boolean>((resolve) => {
          const t = setInterval(() => {
            if (!isWorkspaceSyncBusy()) {
              clearInterval(t)
              resolve(true)
            }
          }, 20)
          setTimeout(() => { clearInterval(t); resolve(false) }, 5000)
        })
        expect(ok).toBe(true)
        const c = db.prepare("SELECT COUNT(*) AS c FROM sources WHERE file_path = 'a.txt'").get() as { c: number }
        expect(c.c).toBe(1)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })

    it('queues and reruns a task submitted while another is running (Task 2.2.5)', async () => {
      let calls = 0
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => {
        release = r
      })
      runWorkspaceSync(async () => {
        calls += 1
        await gate
      })
      // 等待第一个任务进入 busy
      await new Promise((r) => setTimeout(r, 20))
      runWorkspaceSync(async () => {
        calls += 1
      })
      // 释放第一个任务 → finally 触发补跑同一个任务
      release()
      await new Promise((r) => setTimeout(r, 50))
      expect(calls).toBe(2)
    })
  })
}
