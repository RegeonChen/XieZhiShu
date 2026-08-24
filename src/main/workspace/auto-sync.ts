/**
 * auto-sync.ts —— 工作区同步统一调度器（Task 2.2.5）。
 * 职责：
 *  - 全量对账（reconcileWorkspace）的确定性触发源：窗口聚焦 / 进入资料库 / 每分钟定时 / 启动 / 设置页变更工作区。
 *    每个触发的效果一致（全量对账 + 进度推送）；手动"同步工作区"按钮已于 2026-08-24 移除（被这些自动触发覆盖）。
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
/** 排队中的最新任务（对账任务都是幂等/收敛的，排队期间只保留最新一个即可）；null = 无排队 */
let queuedTask: (() => Promise<unknown>) | null = null
/** 等待队列清空的 resolver（供 runWorkspaceSync 的调用方 await 完成） */
const queuedWaiters: (() => void)[] = []

/** 前一个任务结束：若有排队任务则继续跑；否则唤醒所有等待者 */
function finishRun(): void {
  busy = false
  const next = queuedTask
  queuedTask = null
  if (next) {
    busy = true
    void (async () => {
      try {
        await next()
      } catch (err) {
        console.error('workspace sync failed:', err)
      } finally {
        finishRun()
      }
    })()
    return
  }
  const waiters = queuedWaiters.splice(0)
  for (const w of waiters) w()
}

/**
 * 通用工作区对账调度：**所有**工作区对账（全量 / 增量 / 手动 / 设置触发）必须经此入口，
 * 同一时刻只跑一个对账任务（2026-08-20 修复：此前设置页触发与手动按钮直接调用 reconcileWorkspace，
 * 绕过互斥，与自动同步/监听增量并发执行，同一新文件被两次扫描、两次入库 → 列表重复显示）。
 * 对账进行中到达的新请求按「最新任务优先」排队补跑（对账幂等，旧请求可被新请求合并）；
 * 返回的 Promise 在本次提交（或其后排队的任务）执行完毕后 resolve。
 */
export function runWorkspaceSync(task: () => Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve) => {
    // 无论首发还是排队提交，都把 resolver 挂到「队列清空」上统一 resolve（首发任务在 finishRun 时一并唤醒）
    queuedWaiters.push(resolve)
    if (busy) {
      queuedTask = task
      return
    }
    busy = true
    void (async () => {
      try {
        await task()
      } catch (err) {
        console.error('workspace sync failed:', err)
      } finally {
        finishRun()
      }
    })()
  })
}

/** 触发一次全量对账（自动同步触发源统一入口：聚焦 / 进资料库 / 定时 / 设置变更 / 启动） */
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

    it('awaits queue drain and runs the latest queued task (manual sync contract, 2026-08-24)', async () => {
      let firstRan = false
      let secondRan = false
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => {
        release = r
      })
      const p1 = runWorkspaceSync(async () => {
        firstRan = true
        await gate
      })
      await new Promise((r) => setTimeout(r, 20))
      let captured: string | null = null
      const p2 = runWorkspaceSync(async () => {
        secondRan = true
        captured = 'done'
      })
      // 释放首发任务 → 排队中的最新任务继续执行，两个提交的 Promise 均在队列清空后 resolve
      release()
      await p1
      await p2
      expect(firstRan).toBe(true)
      expect(secondRan).toBe(true)
      expect(captured).toBe('done')
    })
  })
}
