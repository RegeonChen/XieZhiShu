/**
 * fetch-estimate.ts —— 网页抓取耗时估算（Phase 10，纯函数、可测试）。
 *
 * 为什么单独成模块：`db/web-sites.ts`（目录统计）与 `web-source/site-crawler.ts`（抓取）都要用它，
 * 放在任何一侧都会造成**循环依赖**，所以抽成这个零依赖的叶子模块。
 *
 * ## 口径演进（2026-11-02，第三项任务「真实窄区间建立速度实测」）
 * 初版把 `WEB_FETCH_MS_PER_ARTICLE = 75` 当**唯一口径**（依据 2026-10-04 的 6 篇串行实测：127–356ms，
 * 解析只要 4–17ms，瓶颈是网络与礼貌限速；按"同站并发 2、每请求 ≥120ms"取 75ms 偏保守）。
 * 但 2026-10-05 真实抓取实测约 **142ms/篇**——**差近一倍**，而"预计 N 分钟"直接写在闸门弹框与建立面板上，
 * 说 64 分钟却跑 2 小时会让用户以为卡死。
 *
 * 现在的口径分两层：
 * - **默认 75ms**：从未建立过、没有实测值时用（首次估算）；
 * - **实测值**：每次「建立」结束后，用**本次真实耗时 ÷ 篇数**（扣掉暂停时间）算出并写回设置
 *   （`web_fetch_ms_per_article`），下次估算与闸门提示都用它。见 {@link calibrateMsPerArticle}。
 *   **样本太小不校准**（<20 篇），否则 1–2 篇的偶然值会污染估算。
 */

/** 默认口径（未建立过 / 没有实测值时使用）：75ms/篇，来自 2026-10-04 串行实测的保守取值 */
export const WEB_FETCH_MS_PER_ARTICLE = 75

/** 校准所需的最小样本（篇）——低于它不写回，避免偶然值污染 */
export const MIN_CALIBRATION_SAMPLE = 20
/** 实测值的下限（再快也不该低于 20ms/篇：网络 + 礼貌间隔的物理下限） */
export const MIN_MEASURED_MS = 20
/** 实测值的上限（超过 2s/篇说明那条区间特殊/站点很慢，此时**不校准**而不是写一个离谱值） */
export const MAX_MEASURED_MS = 2000

/**
 * 估算抓取耗时（分钟，向上取整）；`count ≤ 0` 记 0。
 * `msPerArticle` 传空或非法时回退 {@link WEB_FETCH_MS_PER_ARTICLE}。
 */
export function estimateWebFetchMinutes(count: number, msPerArticle: number = WEB_FETCH_MS_PER_ARTICLE): number {
  if (!Number.isFinite(count) || count <= 0) return 0
  const per = Number.isFinite(msPerArticle) && msPerArticle > 0 ? msPerArticle : WEB_FETCH_MS_PER_ARTICLE
  return Math.ceil((count * per) / 60000)
}

/**
 * 从一次真实建立的实测结果算出"每篇毫秒"用于下次估算。
 *
 * 返回 `null` 的情形（**宁可不校准，也不要写坏值**）：
 * - 样本太小（`processed < MIN_CALIBRATION_SAMPLE`，例如只建了 3 篇就停止）；
 * - 耗时缺失或 ≤0；
 * - 结果离谱（> {@link MAX_MEASURED_MS}）——通常是中途长时间暂停/机器休眠，扣除暂停后仍异常说明这次数据不可用。
 *
 * ⚠ 调用方必须**扣除暂停时间**（`pausedMs`）：暂停期间池不发请求，把它算进耗时会把"每篇毫秒"抬高数倍。
 */
export function calibrateMsPerArticle(processed: number, activeElapsedMs: number): number | null {
  if (!Number.isFinite(processed) || !Number.isFinite(activeElapsedMs)) return null
  if (processed < MIN_CALIBRATION_SAMPLE || activeElapsedMs <= 0) return null
  const per = activeElapsedMs / processed
  if (!Number.isFinite(per) || per <= 0) return null
  if (per > MAX_MEASURED_MS) return null
  return Math.round(Math.max(MIN_MEASURED_MS, per))
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('fetch-estimate（抓取耗时估算 + 实测校准）', () => {
    it('默认口径：从实测的每篇成本估算分钟数', () => {
      expect(estimateWebFetchMinutes(0)).toBe(0)
      expect(estimateWebFetchMinutes(-5)).toBe(0)
      // 800 篇 ≈ 1 分钟
      expect(estimateWebFetchMinutes(800)).toBe(1)
      // 真实库 2005–2020 区间 40,360 篇 → ≈50 分钟（与 PLAN Phase 10 的口径一致）
      expect(estimateWebFetchMinutes(40360)).toBe(51)
      expect(estimateWebFetchMinutes(Number.NaN)).toBe(0)
    })

    it('传入实测值时按实测值估算（142ms/篇 ≈ 默认口径的两倍）', () => {
      expect(estimateWebFetchMinutes(1000, 142)).toBe(Math.ceil((1000 * 142) / 60000))
      expect(estimateWebFetchMinutes(45553, WEB_FETCH_MS_PER_ARTICLE)).toBe(57)
      expect(estimateWebFetchMinutes(45553, 142)).toBe(108)
      // 非法实测值（0 / NaN / 负数）回退默认口径，不产生 NaN 分钟
      expect(estimateWebFetchMinutes(1000, 0)).toBe(estimateWebFetchMinutes(1000))
      expect(estimateWebFetchMinutes(1000, Number.NaN)).toBe(estimateWebFetchMinutes(1000))
    })

    it('校准：扣掉暂停后的真实每篇耗时；样本太小 / 数据离谱时返回 null', () => {
      // 600 篇用了 90 秒（=150ms/篇）
      expect(calibrateMsPerArticle(600, 90_000)).toBe(150)
      // 样本太小：只建了 5 篇，不校准
      expect(calibrateMsPerArticle(5, 5000)).toBeNull()
      // 没有耗时数据
      expect(calibrateMsPerArticle(600, 0)).toBeNull()
      expect(calibrateMsPerArticle(Number.NaN, 1000)).toBeNull()
      // 离谱（5 篇用了 1 小时 / 平均 720s）：不校准
      expect(calibrateMsPerArticle(600, 600 * 5000)).toBeNull()
      // 快得不符合物理（0.1ms/篇）→ 抬到下限，不写 0
      expect(calibrateMsPerArticle(600, 60)).toBe(MIN_MEASURED_MS)
    })
  })
}
