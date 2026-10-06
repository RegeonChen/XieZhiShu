/**
 * fetch-control.ts —— 网页抓取的**运行期控制开关**（2026-10-05，用户要求「暂停抓取」）。
 *
 * 为什么是模块级状态：抓取发生在**生成管线内部**（`compilation:generate` 的 await 链里），
 * 渲染层只能通过 IPC 影响它。同一时刻只有一个生成在跑（生成入口本身有单飞保护），
 * 所以用一组模块级标志即可，无需把它塞进生成参数里。
 *
 * - `paused`：**暂停但保留进度**。抓取池在每篇开始前等待，暂停期间**不占限速名额、不发请求**；
 *   点「继续抓取」后从原处接着跑（同一次生成内，不重启管线）。
 * - `cancelled`：应用退出（`before-quit`）或用户显式取消 → 池立刻停止排新任务并尽快返回，
 *   已经处理过的篇都已记账/入缓存，下次重新生成会全量重筛（缓存命中则零网络）。
 */
let paused = false
let cancelled = false

/** 是否处于"暂停抓取"状态（供抓取池轮询） */
export function isFetchPaused(): boolean {
  return paused
}

/** 是否已请求取消（供抓取池轮询；应用退出时置位） */
export function isFetchCancelled(): boolean {
  return cancelled
}

/** 切换暂停状态（IPC 调用）；返回切换后的值 */
export function setFetchPaused(next: boolean): boolean {
  paused = next
  return paused
}

/** 请求取消（应用退出时调用） */
export function requestFetchCancel(): void {
  cancelled = true
  paused = false
}

/** 一次新的抓取开始时复位（避免上一次的暂停/取消状态残留到下一次生成） */
export function resetFetchControl(): void {
  paused = false
  cancelled = false
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('fetch-control（暂停/取消开关）', () => {
    it('暂停可来回切换，取消时自动解除暂停，复位后一切归零', () => {
      resetFetchControl()
      expect(isFetchPaused()).toBe(false)
      expect(isFetchCancelled()).toBe(false)

      expect(setFetchPaused(true)).toBe(true)
      expect(isFetchPaused()).toBe(true)

      expect(setFetchPaused(false)).toBe(false)
      expect(isFetchPaused()).toBe(false)

      // 取消：paused 一并解除，避免"暂停 + 取消"叠加时池里还在等暂停
      setFetchPaused(true)
      requestFetchCancel()
      expect(isFetchCancelled()).toBe(true)
      expect(isFetchPaused()).toBe(false)

      resetFetchControl()
      expect(isFetchCancelled()).toBe(false)
      expect(isFetchPaused()).toBe(false)
    })
  })
}
