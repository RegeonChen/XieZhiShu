/**
 * adaptive-rate.ts —— 抓取节奏的**自适应降档**（2026-10-05，用户要求）。
 *
 * 用户裁定：默认用**标准档**（每请求间隔 60ms、同站并发 4），但如果"抓太快"导致批量失败
 * （站点限流 429/503、超时），要**自动降档**并把本轮的失败篇**重新抓一遍**；
 * **降档只对本次运行有效**——下一次任务仍然从标准档开始（不记忆、不持久化）。
 *
 * 判定口径（纯逻辑、可单测）：滑窗内失败数与"连续失败"任一越线即降档 ——
 * - 窗口 40 篇内失败 ≥ 6（15%）；
 * - 或出现"限流/服务不可用"（429/503）1 次（这类错误明确指向节奏过快，不等待累计）；
 * - 或连续失败 ≥ 3（可能是被临时封了）。
 * 降档 = 间隔 × 2（上限 `MAX_INTERVAL_MS`，默认 480ms），最多 `maxDowngrades` 次（默认 2）。
 * 每次降档都返回 `downgraded: true`，调用方据此**重抓本轮失败的文章**（有界，见 `article-crawl`）。
 */

/** 限流/服务不可用的错误特征（`fetchUrl` 的报错文案为「服务器返回 429」/「服务器返回 503」） */
export const RATE_LIMIT_RE = /\b(429|503)\b|too many requests|rate limit/i

export interface AdaptiveRateOptions {
  /** 起始间隔（毫秒，来自设置档位或 robots 的 Crawl-delay 下限） */
  intervalMs: number
  /** 间隔上限（毫秒） */
  maxIntervalMs?: number
  /** 窗口大小（篇） */
  windowSize?: number
  /** 窗口内失败数阈值 */
  failThreshold?: number
  /** 最大降档次数 */
  maxDowngrades?: number
}

export class AdaptiveRate {
  private interval: number
  private readonly maxInterval: number
  private readonly windowSize: number
  private readonly failThreshold: number
  private readonly maxDowngrades: number
  /** 滑窗：true = 失败 */
  private window: boolean[] = []
  private consecutiveFails = 0
  private downgrades = 0

  constructor(opts: AdaptiveRateOptions) {
    this.interval = Math.max(1, Math.round(opts.intervalMs))
    this.maxInterval = Math.max(this.interval, Math.round(opts.maxIntervalMs ?? 480))
    this.windowSize = Math.max(5, Math.round(opts.windowSize ?? 40))
    this.failThreshold = Math.max(2, Math.round(opts.failThreshold ?? 6))
    this.maxDowngrades = Math.max(0, Math.round(opts.maxDowngrades ?? 2))
  }

  /** 当前生效的请求间隔（毫秒）；调用方据此计算 ETA */
  get currentIntervalMs(): number {
    return this.interval
  }

  /** 已降档次数 */
  get downgradeCount(): number {
    return this.downgrades
  }

  /**
   * 记录一篇结果。返回 `{ downgraded, reason }`：`downgraded=true` 表示本次**触发了降档**，
   * 调用方应（a）更新 ETA 的间隔、（b）在本轮结束后重抓失败篇。
   */
  record(outcome: { failed: boolean; errorMessage?: string }): { downgraded: boolean; reason?: string } {
    if (!outcome.failed) {
      this.consecutiveFails = 0
      this.window.push(false)
      if (this.window.length > this.windowSize) this.window.shift()
      return { downgraded: false }
    }
    this.consecutiveFails += 1
    this.window.push(true)
    if (this.window.length > this.windowSize) this.window.shift()

    if (this.downgrades >= this.maxDowngrades) return { downgraded: false }

    const windowFails = this.window.filter(Boolean).length
    const isRateLimited = !!outcome.errorMessage && RATE_LIMIT_RE.test(outcome.errorMessage)
    let reason: string | undefined
    if (isRateLimited) {
      // 限流/服务不可用：明确指向节奏过快，**一次即降档**（不等待累计）
      reason = `站点限流/服务不可用（${outcome.errorMessage}）`
    } else if (this.consecutiveFails >= 3) {
      reason = `连续 ${this.consecutiveFails} 篇失败`
    } else if (windowFails >= this.failThreshold) {
      reason = `最近 ${this.window.length} 篇里失败 ${windowFails} 篇`
    }
    if (!reason) return { downgraded: false }

    this.interval = Math.min(this.maxInterval, this.interval * 2)
    this.downgrades += 1
    this.consecutiveFails = 0
    this.window = []
    return { downgraded: true, reason }
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('AdaptiveRate（抓取节奏自适应降档）', () => {
    it('正常不降档；连续失败 3 篇降一档；间隔翻倍且不超过上限', () => {
      const r = new AdaptiveRate({ intervalMs: 60, maxIntervalMs: 480 })
      for (let i = 0; i < 20; i++) expect(r.record({ failed: false }).downgraded).toBe(false)
      expect(r.currentIntervalMs).toBe(60)

      expect(r.record({ failed: true }).downgraded).toBe(false)
      expect(r.record({ failed: true }).downgraded).toBe(false)
      const d = r.record({ failed: true })
      expect(d.downgraded).toBe(true)
      expect(d.reason).toContain('连续')
      expect(r.currentIntervalMs).toBe(120)
      const d2 = r.record({ failed: true })
      expect(d2.downgraded).toBe(false) // 计数已清零，需再连续 3 篇
      expect(r.record({ failed: true }).downgraded).toBe(false)
      expect(r.record({ failed: true }).downgraded).toBe(true)
      expect(r.currentIntervalMs).toBe(240)
    })

    it('限流（429/503）一次即降档，且最多降档 maxDowngrades 次；上限封顶', () => {
      const r = new AdaptiveRate({ intervalMs: 60, maxIntervalMs: 200, maxDowngrades: 3 })
      const first = r.record({ failed: true, errorMessage: '服务器返回 429' })
      expect(first.downgraded).toBe(true)
      expect(first.reason).toContain('限流')
      expect(r.currentIntervalMs).toBe(120)
      // 第二次限流仍可降档
      expect(r.record({ failed: true, errorMessage: '服务器返回 503' }).downgraded).toBe(true)
      expect(r.currentIntervalMs).toBe(200) // 被 maxIntervalMs 封顶
      // 第三次仍可降档（次数未用尽），但间隔已封顶
      expect(r.record({ failed: true, errorMessage: '服务器返回 429' }).downgraded).toBe(true)
      expect(r.currentIntervalMs).toBe(200)
      // 第 4 次：次数用尽 → 不再降档
      expect(r.record({ failed: true, errorMessage: '服务器返回 429' }).downgraded).toBe(false)
      expect(r.downgradeCount).toBe(3)
    })

    it('滑窗失败率越线（40 篇里 6 篇，且不连续）也会降档', () => {
      const r = new AdaptiveRate({ intervalMs: 100, windowSize: 40, failThreshold: 6 })
      // 3 篇里 1 篇失败（永不超过"连续 3 篇"）→ 只能靠窗口失败数触发；第 18 篇（第 6 次失败）时越线
      let downgradedAt = -1
      for (let i = 0; i < 40; i++) {
        if (r.record({ failed: i % 3 === 2 }).downgraded) {
          downgradedAt = i
          break
        }
      }
      expect(downgradedAt).toBe(17)
      expect(r.currentIntervalMs).toBe(200)
    })
  })
}
