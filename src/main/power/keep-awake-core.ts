/**
 * keep-awake-core.ts —— 保持唤醒控制器的纯逻辑（不依赖 electron，便于内联单测）。
 * 引用计数：多段长任务重叠时不提前释放；幂等：已启动则不重复 start。
 */
export type PowerSaveBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep'

export interface PowerSaveBlockerLike {
  start(type: PowerSaveBlockerType): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export interface KeepAwakeController {
  /** 引用计数 +1；首次启动真正开启（幂等） */
  start(): void
  /** 引用计数 -1；减到 0 时真正关闭 */
  stop(): void
  /** 是否仍在保持唤醒（引用计数 > 0） */
  active(): boolean
  /** 当前引用计数 */
  count(): number
}

interface KeepAwakeImplLike {
  start(type: PowerSaveBlockerType): number
  stop(id: number): void
}

function noopImpl(): KeepAwakeImplLike {
  return { start: () => 0, stop: () => {} }
}

/**
 * 需要时传入 electron 的 powerSaveBlocker 适配；缺省使用 no-op（测试/非 Electron 环境降级）。
 */
export function createKeepAwakeController(impl?: KeepAwakeImplLike): KeepAwakeController {
  const real = impl ?? noopImpl()
  let id: number | null = null
  let count = 0
  let started = false
  return {
    start() {
      count += 1
      if (started) return
      // 幂等：已启动（如 electron 已运行且某次 start 成功）则不重复 start
      // 用 prevent-display-sleep：既阻止显示器休眠（不熄屏），也保持系统不休眠——
      // 长任务（AI 细读 / 矛盾扫描与汇总 / 二次修改）全过程都要求电脑保持唤醒。
      try {
        id = real.start('prevent-display-sleep')
        started = true
      } catch {
        // 无 electron / 启动失败：降级为计数但不再尝试（避免反复抛错）
        started = true
      }
    },
    stop() {
      if (count === 0) return
      count -= 1
      if (count === 0 && id != null) {
        try { real.stop(id) } catch { /* 忽略 */ }
        id = null
        started = false
      }
    },
    active: () => count > 0,
    count: () => count
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  function fakeImpl() {
    const calls: string[] = []
    let id = 0
    return {
      calls,
      impl: {
        start(type: PowerSaveBlockerType): number { calls.push('start:' + type); id += 1; return id },
        stop(n: number): void { calls.push('stop:' + n) },
        isStarted(_n: number): boolean { return false }
      }
    }
  }

  describe('keep-awake controller (Phase A: 长任务防睡眠)', () => {
    it('refcount: multiple start, stop at zero releases', () => {
      const f = fakeImpl()
      const c = createKeepAwakeController(f.impl)
      c.start() // count 1 → start
      c.start() // count 2, 不重复 start（幂等）
      expect(f.calls.filter((x) => x.startsWith('start:')).length).toBe(1)
      c.stop() // count 1（仍保持）
      expect(c.active()).toBe(true)
      c.stop() // count 0 → stop
      expect(c.active()).toBe(false)
      expect(f.calls.some((x) => x.startsWith('stop:'))).toBe(true)
    })

    it('no-op when nothing started / double stop safe', () => {
      const c = createKeepAwakeController(undefined)
      c.stop() // 不应抛错
      expect(c.active()).toBe(false)
      c.start()
      expect(c.active()).toBe(true)
      c.stop()
      expect(c.active()).toBe(false)
    })

    it('uses prevent-display-sleep type (防熄屏 + 防睡眠，覆盖长任务全过程)', () => {
      const f = fakeImpl()
      const c = createKeepAwakeController(f.impl)
      c.start()
      expect(f.calls[0]).toBe('start:prevent-display-sleep')
    })
  })
}
