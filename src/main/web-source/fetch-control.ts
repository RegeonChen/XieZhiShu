/**
 * fetch-control.ts —— 网页抓取的**运行期控制开关**与**独占租约**（2026-10-05 暂停/取消；2026-11-02 加租约）。
 *
 * ## 为什么是模块级状态
 * 抓取发生在主进程内部（`compilation:generate` 与 `cacheBuild:start` 的 await 链里），渲染层只能通过 IPC 影响它。
 *
 * ## 为什么必须有「独占租约」（2026-11-02 审查发现的隐患）
 * 旧实现只有 `paused` / `cancelled` 两个全局标志，而且 `crawlAndScreenArticles` **每次进来都复位**它们。
 * 于是出现两条真实故障路径：
 *   ① 生成正在抓取时，用户去设置页点「建立」→ 建立侧又一次 `resetFetchControl()` → 用户在生成页按下的
 *      **"暂停抓取"被静默清除**，生成侧继续联网；同时两条抓取并行（同站并发翻倍、ETA 失真）。
 *   ② 用户点「停止建立」→ 旧实现调 `requestFetchCancel()`（全局）→ **正在跑的生成抓取被一并掐断**，
 *      生成随后以"部分/零网页材料"结束，而用户只在设置页点了一个按钮。
 *
 * 现在改为**租约模型**：抓取前先 `acquireCrawlFor(owner)`，拿到租约才能跑，跑完 `releaseCrawlFrom(owner)`；
 * 同一时刻只允许一个 owner（`screen` = 生成期抓取，`build` = 建立缓存）。取消是**按归属**的：
 * `requestFetchCancel('build')` 不会碰正在跑的生成抓取，只有应用退出（不传 owner）才是强制取消。
 */

/** 抓取的归属方：生成期筛选 / 建立缓存 */
export type CrawlOwner = 'screen' | 'build'

let paused = false
let cancelled = false
/** 当前持有抓取租约的 owner（null = 没有抓取在跑） */
let leaseOwner: CrawlOwner | null = null

export interface CrawlBusyErrorOptions {
  /** 当前占用者（拿不到租约时） */
  busyOwner: CrawlOwner | null
}

/**
 * 拿不到抓取权的**具名错误**：调用方据此区分"真的抓取失败"与"另一条抓取正在跑"。
 * ⚠ 生成管线原来把抓取异常 `catch` 成"不阻断生成"（只记日志），这条错误必须**穿透**那层 catch，
 * 否则用户只会看到"网页材料为 0"而不知道原因（见 `compilation-service.ts` 对它的重新抛出）。
 */
export class CrawlBusyError extends Error {
  readonly busyOwner: CrawlOwner | null
  readonly code = 'CRAWL_BUSY'

  constructor(opts: CrawlBusyErrorOptions) {
    super(
      opts.busyOwner === 'build'
        ? '正在「建立缓存与索引」（抓取进行中）：同一时刻只能有一条抓取，等它结束再试。'
        : opts.busyOwner === 'screen'
          ? '正在生成汇编（网页抓取进行中）：同一时刻只能有一条抓取，等它结束再试。'
          : '已有另一条网页抓取在进行中：同一时刻只能有一条抓取，等它结束再试。'
    )
    this.name = 'CrawlBusyError'
    this.busyOwner = opts.busyOwner
  }
}

/** 当前抓取的归属方（null = 空闲）；界面与闸门用它判断"有没有抓取在跑" */
export function getCrawlOwner(): CrawlOwner | null {
  return leaseOwner
}

/**
 * 取得抓取独占权（**成功时复位暂停/取消**，因为这是一轮全新的抓取）。
 * 已有其它 owner 在跑时返回 `false`（不排队、不抢占——调用方应如实报"等它结束"）。
 */
export function acquireCrawlFor(owner: CrawlOwner): boolean {
  if (leaseOwner !== null) return false
  leaseOwner = owner
  paused = false
  cancelled = false
  return true
}

/** 释放抓取独占权（只有持有者能释放；顺带清掉暂停状态，避免残留到下一轮） */
export function releaseCrawlFrom(owner: CrawlOwner): void {
  if (leaseOwner !== owner) return
  leaseOwner = null
  paused = false
  // `cancelled` 刻意**不**在这里清：释放后马上可能有新一轮 acquire，由它统一复位；
  // 若应用正在退出，保持 cancelled = true 才能让后续的抓取立即退出。
}

/** 是否处于"暂停抓取"状态（供抓取池轮询） */
export function isFetchPaused(): boolean {
  return paused
}

/** 是否已请求取消（供抓取池轮询） */
export function isFetchCancelled(): boolean {
  return cancelled
}

/** 切换暂停状态（IPC 调用）；返回切换后的值 */
export function setFetchPaused(next: boolean): boolean {
  paused = next
  return paused
}

/**
 * 请求取消。
 * - **不传 owner**：强制取消（应用退出 `before-quit` 用这个）；
 * - **传 owner**：只在**该 owner 持有租约时**才生效，绝不越权掐断别人的抓取
 *   （「停止建立」就是传 `'build'`——它不会中断正在跑的生成抓取）。
 * 返回是否真的置位。
 */
export function requestFetchCancel(owner?: CrawlOwner): boolean {
  if (owner && leaseOwner !== owner) return false
  cancelled = true
  paused = false
  return true
}

/** 强制复位（应用退出/单测用）：清空暂停、取消与租约 */
export function resetFetchControl(): void {
  paused = false
  cancelled = false
  leaseOwner = null
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeEach } = import.meta.vitest

  describe('fetch-control（暂停/取消 + 抓取独占租约）', () => {
    beforeEach(() => resetFetchControl())

    it('暂停可来回切换，取消时自动解除暂停，复位后一切归零', () => {
      expect(isFetchPaused()).toBe(false)
      expect(isFetchCancelled()).toBe(false)
      expect(setFetchPaused(true)).toBe(true)
      expect(isFetchPaused()).toBe(true)
      expect(setFetchPaused(false)).toBe(false)

      setFetchPaused(true)
      requestFetchCancel()
      expect(isFetchCancelled()).toBe(true)
      expect(isFetchPaused()).toBe(false)

      resetFetchControl()
      expect(isFetchCancelled()).toBe(false)
      expect(isFetchPaused()).toBe(false)
    })

    it('租约：同一时刻只允许一个 owner；并发的第二个拿不到（不排队、不抢占）', () => {
      expect(getCrawlOwner()).toBeNull()
      expect(acquireCrawlFor('screen')).toBe(true)
      expect(getCrawlOwner()).toBe('screen')
      // 建立缓存不能与生成抓取并行
      expect(acquireCrawlFor('build')).toBe(false)
      expect(getCrawlOwner()).toBe('screen')
      // 只有持有者能释放；非持有者释放无效
      releaseCrawlFrom('build')
      expect(getCrawlOwner()).toBe('screen')
      releaseCrawlFrom('screen')
      expect(getCrawlOwner()).toBeNull()
      // 释放后可以换人
      expect(acquireCrawlFor('build')).toBe(true)
      expect(getCrawlOwner()).toBe('build')
    })

    it('取租约等于开始新一轮抓取：上一轮残留的暂停/取消会被复位', () => {
      acquireCrawlFor('screen')
      setFetchPaused(true)
      releaseCrawlFrom('screen')
      expect(isFetchPaused()).toBe(false) // 释放即清暂停
      requestFetchCancel()
      expect(isFetchCancelled()).toBe(true)
      // 新一轮抓取（无论谁）复位取消标志
      expect(acquireCrawlFor('build')).toBe(true)
      expect(isFetchCancelled()).toBe(false)
    })

    it('取消按归属：停止建立不会掐断正在跑的生成抓取；应用退出（不传 owner）才强制', () => {
      acquireCrawlFor('screen')
      // 生成在跑时，「停止建立」传 'build' —— 不生效（防止误伤）
      expect(requestFetchCancel('build')).toBe(false)
      expect(isFetchCancelled()).toBe(false)
      // 生成自己取消 —— 生效
      expect(requestFetchCancel('screen')).toBe(true)
      expect(isFetchCancelled()).toBe(true)

      // 应用退出：不传 owner，无论谁持有都强制
      resetFetchControl()
      acquireCrawlFor('build')
      expect(requestFetchCancel()).toBe(true)
      expect(isFetchCancelled()).toBe(true)
    })

    it('CrawlBusyError 带明确文案与当前占用者（生成管线据此重新抛出）', () => {
      const e = new CrawlBusyError({ busyOwner: 'build' })
      expect(e.code).toBe('CRAWL_BUSY')
      expect(e.busyOwner).toBe('build')
      expect(e.message).toContain('建立缓存与索引')
      expect(new CrawlBusyError({ busyOwner: null }).message).toContain('另一条网页抓取')
    })
  })
}
