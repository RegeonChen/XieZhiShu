/**
 * fetch-estimate.ts —— 网页抓取耗时估算（Phase 10，纯函数、可测试）。
 *
 * 为什么单独成模块：`db/web-sites.ts`（目录统计）与 `web-source/site-crawler.ts`（抓取）都要用它，
 * 放在任何一侧都会造成**循环依赖**，所以抽成这个零依赖的叶子模块。
 *
 * 口径来自真实实测（2026-10-04，长乐新闻网 6 篇文章、页面 26–30 KB）：
 * - 单篇"网络 + 解析"实测 **127–356 ms**（串行，含礼貌间隔）；
 * - 换用成熟提取器后解析只要 **4–17 ms**（trafilatura / readability 实测），所以瓶颈是网络与礼貌限速；
 * - 按用户裁定的"同站并发 2、每请求 ≥120ms 间隔"，取 **75 ms/篇** 作为估算口径（偏保守）。
 */
export const WEB_FETCH_MS_PER_ARTICLE = 75

/** 估算抓取耗时（分钟，向上取整）；`count ≤ 0` 记 0 */
export function estimateWebFetchMinutes(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.ceil((count * WEB_FETCH_MS_PER_ARTICLE) / 60000)
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('fetch-estimate（Phase 10 抓取耗时估算）', () => {
    it('estimates minutes from the measured per-article cost', () => {
      expect(estimateWebFetchMinutes(0)).toBe(0)
      expect(estimateWebFetchMinutes(-5)).toBe(0)
      // 800 篇 ≈ 1 分钟
      expect(estimateWebFetchMinutes(800)).toBe(1)
      // 真实库 2005–2020 区间 40,360 篇 → ≈50 分钟（与 PLAN Phase 10 的口径一致）
      expect(estimateWebFetchMinutes(40360)).toBe(51)
      expect(estimateWebFetchMinutes(Number.NaN)).toBe(0)
    })
  })
}
