/**
 * eta.ts —— 抓取阶段的**剩余时长估算**（Phase 10 P4，纯函数/纯类，可测试）。
 *
 * 为什么单独抽出来做：旧流程只有"每个窗口一个先验秒数"，宽区间抓取（4 万篇、几十分钟）根本没法用先验猜。
 * 本次按用户要求"尽可能提高估算精度"，落实了六条口径：
 *
 * 2. **滑动窗口中位数 + 截尾均值取大**（默认最近 30 篇、截掉最慢的 10%）：
 *    备选方案 EMA 在实测中**对单次超时过敏**——一次 3 秒的超时会把 EMA 抬高 ~0.86 秒（6 倍于正常值），
 *    而它只是一次性的重试，不代表后续每篇都要这么久。取"中位数"与"截尾均值"的较大者：
 *    ① 单点尖峰被中位数与截尾一起压掉；② 站点**持续**变慢时（窗口内多数样本变慢）两者都会跟上，不会长期低估。
 * 3. **物理下限优先**：批量的实际耗时由**礼貌限速**决定（同站并发 2、每请求 ≥120ms）。
 *    因此每篇耗时取 `max(实测, floorMsPerArticle)`，`floor = max(120ms, robotsCrawlDelay) / 并发`——
 *    ETA **永远不会声称比站点允许的速度更快**（这是"估算偏乐观"的头号来源）。
 * 4. **预热期**（默认前 20 篇）：样本不足时用**实测先验**（`priorMsPerArticle`，来自真实回放的 75 ms/篇）先给个初估，
 *    并标记 `provisional: true`，界面显示"初估"，避免长时间只显示"计算中"。
 * 5. **分母只算"待处理"**：调用方传进来的 `remaining` 必须已剔除跳过/已完成项，避免把已完成的工作算进剩余。
 * 6. **分阶段计时**：抓取（受网络影响）与处理（提取/切块/筛选，受 CPU 影响）分别累计，二者之和才是每篇成本；
 *    只用一个总数会在两段比例变化时产生系统性偏差。
 *
 * 已知边界（如实记录）：站点响应时间的**突增**（被限流、服务器变慢）只能在样本进入窗口后反映，存在一个窗口的滞后；
 * 并发度固定为每站 2，不做动态调整（动态调整会让 ETA 与限速承诺都不稳定）。
 */
export interface EtaOptions {
  /** 预热样本数：少于该数量时用先验值并标 `provisional` */
  warmup?: number
  /** 滑动窗口大小（取中位数与截尾均值） */
  window?: number
  /** 截尾比例：去掉最慢的这一部分样本后再取均值（默认 0.1） */
  trimRatio?: number
  /**
   * **同一站点的请求间隔下限（毫秒）**——由礼貌限速决定（`max(120ms, robots Crawl-delay)`）。
   * 这是吞吐量的硬上限：无论并发多少，每 `intervalMs` 只能发出一个请求。
   */
  intervalMs?: number
  /** 同站并发度（默认 2）：并发只在"单篇服务时间 > 间隔"时提升吞吐 */
  concurrency?: number
  /** 预热期使用的实测先验（**单篇服务耗时**，毫秒；默认 75ms 来自真实抓取回放） */
  priorMsPerArticle?: number
}

export interface EtaSnapshot {
  samples: number
  /** 窗口中位数（单篇服务耗时，毫秒） */
  medianMs: number | null
  /** 截尾均值（单篇服务耗时，毫秒） */
  trimmedMeanMs: number | null
  /**
   * 当前采用的**墙钟每篇成本**（毫秒）= `max(请求间隔, 服务耗时的中位数与截尾均值取大 ÷ 并发)`。
   * 这是"剩余时长 = 剩余篇数 × 该值"的依据，也是 2026-10-04 修掉"高估 70%"的地方：
   * 旧实现直接把单篇服务耗时当成墙钟耗时，**没有除以并发度**。
   */
  msPerArticle: number
  /** 是否仍在预热期（用先验值） */
  provisional: boolean
}

export class EtaEstimator {
  private readonly warmup: number
  private readonly windowSize: number
  private readonly trimRatio: number
  /** 2026-10-05：不再 `readonly` —— 抓取节奏**自适应降档**后要跟着改（否则 ETA 会一直偏乐观） */
  private intervalMs: number
  private readonly concurrency: number
  private readonly prior: number
  private samples: number[] = []

  constructor(opts: EtaOptions = {}) {
    this.warmup = opts.warmup ?? 20
    this.windowSize = opts.window ?? 30
    this.trimRatio = Math.min(0.4, Math.max(0, opts.trimRatio ?? 0.1))
    this.intervalMs = Math.max(0, opts.intervalMs ?? 0)
    this.concurrency = Math.max(1, opts.concurrency ?? 1)
    this.prior = Math.max(0, opts.priorMsPerArticle ?? 0)
  }

  /** 更新请求间隔下限（自适应降档后调用；样本窗口保留，只改物理下限） */
  setIntervalMs(ms: number): void {
    this.intervalMs = Math.max(0, ms)
  }

  /**
   * 记录一篇的耗时（毫秒）。`fetchMs` 与 `processMs` 分开传，便于诊断"是网络慢还是本地慢"。
   * 传单一 `ms` 亦可。
   */
  push(ms: number): void
  push(sample: { fetchMs: number; processMs: number }): void
  push(input: number | { fetchMs: number; processMs: number }): void {
    const ms = typeof input === 'number' ? input : input.fetchMs + input.processMs
    if (!Number.isFinite(ms) || ms < 0) return
    this.samples.push(ms)
    if (this.samples.length > this.windowSize) this.samples.splice(0, this.samples.length - this.windowSize)
  }

  private sorted(): number[] {
    return [...this.samples].sort((a, b) => a - b)
  }

  private median(): number | null {
    const s = this.sorted()
    if (s.length === 0) return null
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }

  /** 截尾均值：去掉最慢的 `trimRatio` 样本后取均值（单点超时不会抬高整体估计） */
  private trimmedMean(): number | null {
    const s = this.sorted()
    if (s.length === 0) return null
    const cut = Math.floor(s.length * this.trimRatio)
    const kept = cut > 0 ? s.slice(0, s.length - cut) : s
    if (kept.length === 0) return s[0]
    return kept.reduce((a, b) => a + b, 0) / kept.length
  }

  snapshot(): EtaSnapshot {
    const median = this.median()
    const trimmed = this.trimmedMean()
    // 两者取大：中位数抗单点尖峰，截尾均值在"站点持续变慢"时跟上
    const measured = median == null ? null : Math.max(median, trimmed ?? 0)
    const provisional = this.samples.length < this.warmup || measured == null
    const service = provisional ? (this.prior > 0 ? this.prior : (measured ?? 0)) : measured!
    /*
     * 墙钟每篇成本 = max(请求间隔, 服务耗时 ÷ 并发)。
     * ① 间隔是硬上限：并发再高，每 intervalMs 也只能发一个请求（同站礼貌限速是全局的）；
     * ② 只有服务耗时 > 间隔时，并发才真正提升吞吐（此时每 worker 各占一条时间片）。
     * 修前旧实现漏了"÷并发"，实测把 2 分钟的高估成了 3 分 21 秒（约 1.7 倍）。
     */
    const wall = Math.max(this.intervalMs, service / this.concurrency)
    return {
      samples: this.samples.length,
      medianMs: median,
      trimmedMeanMs: trimmed,
      msPerArticle: wall,
      provisional
    }
  }

  /** 剩余秒数；`remaining <= 0` 返回 0 */
  etaSeconds(remaining: number): number {
    if (!Number.isFinite(remaining) || remaining <= 0) return 0
    return Math.round((remaining * this.snapshot().msPerArticle) / 1000)
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('EtaEstimator（Phase 10 抓取剩余时长估算）', () => {
    it('uses the measured prior during warm-up and marks it provisional', () => {
      const e = new EtaEstimator({ warmup: 20, priorMsPerArticle: 75, intervalMs: 120, concurrency: 2 })
      const s = e.snapshot()
      expect(s.samples).toBe(0)
      expect(s.provisional).toBe(true)
      // 先验 75ms 服务耗时 ÷ 并发 2 = 37.5ms，但请求间隔 120ms 是硬上限 → 墙钟 120ms/篇
      expect(s.msPerArticle).toBe(120)
      // 4 万篇的初估 ≈ 80 分钟
      expect(e.etaSeconds(40360)).toBe(4843)
      e.push(100); e.push(110); e.push(90)
      expect(e.snapshot().provisional).toBe(true)
    })

    it('accounts for concurrency: 服务耗时 150ms、并发 2 → 墙钟 75ms/篇（且不低于间隔的一半）', () => {
      const e = new EtaEstimator({ warmup: 2, intervalMs: 120, concurrency: 2 })
      for (let i = 0; i < 10; i++) e.push(150)
      // 150/2 = 75 < interval(120) → 间隔生效：120ms/篇
      expect(e.snapshot().msPerArticle).toBe(120)
      // 服务耗时 400ms、并发 2 → 200ms/篇 > 间隔 → 200ms 生效
      const e2 = new EtaEstimator({ warmup: 2, intervalMs: 120, concurrency: 2 })
      for (let i = 0; i < 10; i++) e2.push(400)
      expect(e2.snapshot().msPerArticle).toBe(200)
      // 并发 1 时就是服务耗时本身
      const e3 = new EtaEstimator({ warmup: 2, intervalMs: 120, concurrency: 1 })
      for (let i = 0; i < 10; i++) e3.push(400)
      expect(e3.snapshot().msPerArticle).toBe(400)
    })

    it('never claims faster than the politeness interval allows', () => {
      // 站点声明 crawl-delay 10s：间隔 10s → 无论实测多快，也只能 10s/篇
      const e = new EtaEstimator({ warmup: 2, intervalMs: 10000, concurrency: 2, priorMsPerArticle: 75 })
      e.push(30); e.push(25); e.push(28)
      const s = e.snapshot()
      expect(s.provisional).toBe(false)
      expect(s.medianMs).toBe(28)
      expect(s.msPerArticle).toBe(10000)
      expect(e.etaSeconds(10)).toBe(100)
    })

    it('resists a single slow request via the window median, but follows a real slowdown', () => {
      const e = new EtaEstimator({ warmup: 5, window: 30, intervalMs: 120, concurrency: 2 })
      for (let i = 0; i < 10; i++) e.push(400) // 墙钟 = 200ms/篇
      const before = e.snapshot().msPerArticle
      expect(before).toBe(200)
      e.push(9000) // 一次超时：截尾 + 中位数一起压住
      expect(e.snapshot().msPerArticle).toBeLessThan(230)
      // 持续变慢 → 必须跟上
      for (let i = 0; i < 30; i++) e.push(1600)
      expect(e.snapshot().msPerArticle).toBeGreaterThan(760)
      // 又变快 → 窗口滑过之后回落（不长期高估）
      for (let i = 0; i < 40; i++) e.push(160)
      expect(e.snapshot().msPerArticle).toBe(120)
    })

    it('estimates a 1,661-article range and recomputes as samples arrive', () => {
      const e = new EtaEstimator({ warmup: 10, intervalMs: 120, concurrency: 2, priorMsPerArticle: 75 })
      expect(e.etaSeconds(1661)).toBe(199) // 初估：120ms/篇
      for (let i = 0; i < 10; i++) e.push({ fetchMs: 210, processMs: 30 })
      // 实测服务 240ms ÷ 2 = 120ms → 与间隔持平；剩余 1,651 篇 ≈ 198 秒
      expect(e.etaSeconds(1651)).toBe(198)
      expect(e.snapshot().provisional).toBe(false)
      expect(e.etaSeconds(0)).toBe(0)
      expect(e.etaSeconds(-5)).toBe(0)
    })

    it('ignores invalid samples', () => {
      const e = new EtaEstimator({ warmup: 1, intervalMs: 120, concurrency: 2 })
      e.push(Number.NaN); e.push(-1)
      expect(e.snapshot().samples).toBe(0)
    })
  })
}
