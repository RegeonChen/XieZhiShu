/**
 * pdf-hit.ts —— PDF 文内定位的"命中矩形"计算（Phase 8 / S3，纯函数、可单测）。
 *
 * 为什么要单独抽出来：这段几何换算决定"高亮会不会落在那句话上"，是最容易算错的地方
 * （坐标翻转、缩放因子、旋转、字符比例切分），所以放进 .ts 用单测钉住，而不是埋在组件里靠肉眼验。
 *
 * 坐标推导：
 *  - pdf.js 的 `viewport.transform` 把 **PDF 用户空间** 映射到 **设备像素**（含 y 轴翻转）；
 *  - 文本块的 `item.transform` 是它在用户空间里的位置/朝向，两者复合 → 该块在设备像素中的基线起点与朝向；
 *  - 块宽 = `item.width * viewport.scale`；命中字符区间按比例切出横向范围；
 *  - 纵向从基线上移约 0.88 个字高（近似 ascent）作为顶边；
 *  - 最后统一换算成**页面百分比** → 定位交给 CSS，窗口缩放/分栏拖宽都不需要重算。
 */

export interface PdfViewportLike {
  width: number
  height: number
  scale: number
  /** [a, b, c, d, e, f] 六元仿射矩阵 */
  transform: number[]
}

export interface PdfTextItemLike {
  str?: string
  transform?: number[]
  width?: number
}

/** 命中落在哪一个文本块上、以及块内的字符区间 */
export interface PdfHitSpan {
  itemIndex: number
  from: number
  to: number
}

export interface PdfHitRect {
  /** 以下均为相对页面的百分比（0–100） */
  left: number
  top: number
  width: number
  height: number
  /** 文本块旋转角（弧度），交给 CSS rotate */
  angle: number
}

/** 近似 ascent：基线上移到字形顶部约 0.88 个字高（pdf.js 文字层也用同一经验值） */
const ASCENT = 0.88
/** 矩形高度留一点余量，避免贴着字形显得太扁 */
const HEIGHT_MARGIN = 1.08

/** 六元仿射矩阵复合：等价于 pdf.js `Util.transform(m1, m2)`（自己实现以免依赖运行时） */
export function composeTransform(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ]
}

/** 由文本块 + 命中区间算出高亮矩形（页面百分比）；数据不完整就跳过该块 */
export function hitRectsForPage(
  viewport: PdfViewportLike,
  items: PdfTextItemLike[],
  spans: PdfHitSpan[]
): PdfHitRect[] {
  const out: PdfHitRect[] = []
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return out
  for (const span of spans) {
    const item = items[span.itemIndex]
    if (!item?.str || !item.transform) continue
    const tx = composeTransform(viewport.transform, item.transform)
    const fontHeight = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]) || 0
    if (fontHeight <= 0) continue
    const itemWidth = (item.width ?? 0) * viewport.scale
    const total = item.str.length || 1
    const from = Math.max(0, Math.min(span.from, total))
    const to = Math.max(from, Math.min(span.to, total))
    const x = tx[4] + itemWidth * (from / total)
    const w = Math.max(1, itemWidth * ((to - from) / total))
    const y = tx[5] - fontHeight * ASCENT
    out.push({
      left: (x / viewport.width) * 100,
      top: (y / viewport.height) * 100,
      width: (w / viewport.width) * 100,
      height: ((fontHeight * HEIGHT_MARGIN) / viewport.height) * 100,
      angle: Math.atan2(tx[1], tx[0])
    })
  }
  return out
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('pdf hit rects (Phase 8 / S3)', () => {
    const near = (a: number, b: number, tol = 0.05): boolean => Math.abs(a - b) < tol

    it('composes affine matrices like pdf.js Util.transform', () => {
      // 单位矩阵不改变任何东西
      expect(composeTransform([1, 0, 0, 1, 0, 0], [3, 4, 5, 6, 7, 8])).toEqual([3, 4, 5, 6, 7, 8])
      // 典型 pdf.js 视口：x 放大 2 倍、y 翻转并平移（页面高 1400）
      const tx = composeTransform([2, 0, 0, -2, 0, 1400], [10, 0, 0, 10, 100, 20])
      expect(tx).toEqual([20, 0, 0, -20, 200, 1360])
    })

    it('maps a full-block hit to page percentages (font size and scale respected)', () => {
      const viewport: PdfViewportLike = { width: 1000, height: 1400, scale: 2, transform: [2, 0, 0, -2, 0, 1400] }
      const items: PdfTextItemLike[] = [{ str: '全区普通中学30所', transform: [10, 0, 0, 10, 100, 20], width: 60 }]
      const rects = hitRectsForPage(viewport, items, [{ itemIndex: 0, from: 0, to: 9 }])
      expect(rects).toHaveLength(1)
      const r = rects[0]
      // 设备坐标：x 从 200 起、宽 120（60 × scale 2）；字高 20；基线 1360 → 顶边 1360 - 17.6
      expect(near(r.left, (200 / 1000) * 100)).toBe(true)
      expect(near(r.width, (120 / 1000) * 100)).toBe(true)
      expect(near(r.top, ((1360 - 20 * 0.88) / 1400) * 100)).toBe(true)
      expect(near(r.height, ((20 * 1.08) / 1400) * 100)).toBe(true)
      expect(near(r.angle, 0, 0.001)).toBe(true)
    })

    it('slices the block horizontally for a partial character range', () => {
      const viewport: PdfViewportLike = { width: 1000, height: 1000, scale: 1, transform: [1, 0, 0, -1, 0, 1000] }
      const items: PdfTextItemLike[] = [{ str: '0123456789', transform: [1, 0, 0, 1, 0, 100], width: 100 }]
      const rects = hitRectsForPage(viewport, items, [{ itemIndex: 0, from: 2, to: 6 }])
      const r = rects[0]
      // 起点 = 0 + 100 × (2/10) = 20；宽 = 100 × (4/10) = 40
      expect(near(r.left, 2)).toBe(true)
      expect(near(r.width, 4)).toBe(true)
    })

    it('reports rotation for rotated text blocks', () => {
      const viewport: PdfViewportLike = { width: 1000, height: 1000, scale: 1, transform: [1, 0, 0, 1, 0, 0] }
      // 顺时针 90°：a=0, b=1
      const items: PdfTextItemLike[] = [{ str: 'abcd', transform: [0, 1, -1, 0, 500, 500], width: 40 }]
      const rects = hitRectsForPage(viewport, items, [{ itemIndex: 0, from: 0, to: 4 }])
      expect(near(rects[0].angle, Math.PI / 2, 0.001)).toBe(true)
    })

    it('skips damaged / out-of-range input instead of throwing', () => {
      const viewport: PdfViewportLike = { width: 1000, height: 1000, scale: 2, transform: [2, 0, 0, -2, 0, 1000] }
      const items: PdfTextItemLike[] = [
        { str: '', transform: [1, 0, 0, 1, 0, 0], width: 10 }, // 空串
        { str: 'x', width: 10 }, // 缺 transform
        { str: '正常一段', transform: [1, 0, 0, 1, 10, 10], width: 20 }
      ]
      expect(hitRectsForPage(viewport, items, [{ itemIndex: 0, from: 0, to: 1 }])).toEqual([])
      expect(hitRectsForPage(viewport, items, [{ itemIndex: 1, from: 0, to: 1 }])).toEqual([])
      expect(hitRectsForPage(viewport, items, [{ itemIndex: 9, from: 0, to: 1 }])).toEqual([])
      // 越界的字符区间会被收敛到块内，而不是产出 NaN
      const r = hitRectsForPage(viewport, items, [{ itemIndex: 2, from: -5, to: 99 }])[0]
      expect(Number.isFinite(r.left) && Number.isFinite(r.width)).toBe(true)
      expect(r.width).toBeGreaterThan(0)
      // 坏视口（宽高为 0）直接返回空
      expect(hitRectsForPage({ width: 0, height: 0, scale: 2, transform: [1, 0, 0, 1, 0, 0] }, items, [{ itemIndex: 2, from: 0, to: 1 }])).toEqual([])
    })
  })
}
