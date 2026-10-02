/**
 * pdf-pages.ts —— PDF 查看器的纯逻辑（Phase 8 / S2）。
 * 放在 .ts 而不是组件文件里：本项目的内联单测只覆盖 `src/**\/*.ts`（`vitest.config.ts` 的 includeSource），
 * `.tsx` 组件不参与单测。
 */

/**
 * 解析"页码跳转"输入（纯函数）：只接受 1..total 的整数。
 * 非法输入返回 null——调用方**不要**静默跳到第 1 页（本项目吃过"静默降级"的亏），
 * 应当保持当前位置并给用户反馈。
 */
export function parsePageInput(raw: string, total: number): number | null {
  const n = Number((raw ?? '').trim())
  if (!Number.isInteger(n) || n < 1) return null
  if (total > 0 && n > total) return null
  return n
}

/**
 * 计算"要保留已渲染画布"的页号区间（纯函数，PDF 虚拟化的核心判断）。
 * @param visiblePages 当前视口（含预渲染余量）内的页号集合，1 起
 * @param keep 视口外额外保留的页数
 */
export function keepRange(visiblePages: number[], keep: number): { min: number; max: number } | null {
  const list = visiblePages.filter((n) => Number.isInteger(n) && n > 0)
  if (list.length === 0) return null
  return { min: Math.min(...list) - keep, max: Math.max(...list) + keep }
}

/** 某页是否应当被释放（纯函数）：有保留区间、且该页在区间外 */
export function shouldRelease(pageNumber: number, range: { min: number; max: number } | null): boolean {
  if (!range) return false
  return pageNumber < range.min || pageNumber > range.max
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('pdf viewer helpers (Phase 8 / S2 虚拟化)', () => {
    it('parses a page number inside 1..total only', () => {
      expect(parsePageInput('1', 100)).toBe(1)
      expect(parsePageInput(' 37 ', 100)).toBe(37)
      expect(parsePageInput('100', 100)).toBe(100)
      // 越界 / 非整数 / 空 / 负数一律拒绝（不静默跳到第 1 页）
      expect(parsePageInput('101', 100)).toBeNull()
      expect(parsePageInput('0', 100)).toBeNull()
      expect(parsePageInput('-3', 100)).toBeNull()
      expect(parsePageInput('3.5', 100)).toBeNull()
      expect(parsePageInput('abc', 100)).toBeNull()
      expect(parsePageInput('', 100)).toBeNull()
      // 页数未知（还在加载）时不设上界，只保证 ≥1
      expect(parsePageInput('9', 0)).toBe(9)
    })

    it('keeps visible pages plus a margin, and releases pages outside it', () => {
      const range = keepRange([10, 11, 12], 2)
      expect(range).toEqual({ min: 8, max: 14 })
      // 区间内保留
      expect(shouldRelease(8, range)).toBe(false)
      expect(shouldRelease(14, range)).toBe(false)
      // 滚远了的释放（几百页的年鉴只留视口附近的几页）
      expect(shouldRelease(7, range)).toBe(true)
      expect(shouldRelease(15, range)).toBe(true)
      // 没有可见页（例如正在切换文档）时不释放任何东西，避免误删
      expect(keepRange([], 2)).toBeNull()
      expect(shouldRelease(1, null)).toBe(false)
    })
  })
}
