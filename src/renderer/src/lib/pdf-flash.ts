/**
 * pdf-flash.ts —— PDF「高亮框」的**纯几何计算**（2026-10-03 用户裁定新增，Phase 9 高亮补充）。
 *
 * 需求原话（要点）：定位跳转不够精确，希望加一个高亮，**不必精确到句、可以包含好几行**，
 * 但要"缩小范围、保证目标一定在高亮内部"；高亮显示约 1 秒后自动消失，不影响阅览。
 *
 * 做法：范围由生成期锚点给出（块 ↔ 字符区间，见 `source-locate.flashRangeFor`），
 * 这里只把它换成**页面内的矩形**：取该页的文字项（`getTextContent()`），按字符区间找出覆盖的文字项，
 * 用 `viewport.transform × item.transform` 复合出每个文字项在设备像素里的位置，
 * 再换算成**页面百分比**（分栏拖宽/缩放/画布被 CSS 拉伸都无需重算）。
 * 同一行的矩形合并成一条 —— 于是最终是"几行而不是整页"的高亮框。
 *
 * 几何口径沿用 Phase 8 / S3 那版**已在真实年鉴上验证过**的实现（当时核对过 16/16 段引文
 * 确实出现在所报页里）：`item.width` 是 PDF 用户空间宽度，渲染宽度 = `item.width × viewport.scale`；
 * 字高取 `hypot(c, d)`（退化时取 `hypot(a, b)`）；基线上移 0.88 字高作顶边。
 *
 * 放在 .ts 而不是组件里：本项目的内联单测只覆盖 `src/**\/*.ts`，而这段几何必须用手算期望值钉住。
 */

/** 页面内的矩形（百分比：left/top/width/height 都是 0–100） */
export interface FlashRect {
  left: number
  top: number
  width: number
  height: number
  /** 文本块旋转角（弧度），交给 CSS rotate（绝大多数页面为 0） */
  angle: number
}

/** pdf.js viewport 里我们用到的字段 */
export interface FlashViewportLike {
  width: number
  height: number
  scale: number
  transform: number[]
}

/** pdf.js 文字项里我们用到的字段（避免把 pdfjs 类型引进来） */
export interface PdfTextItemLike {
  str?: string
  width?: number
  transform?: number[]
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

/**
 * 计算 `[start, end)`（**页内**字符偏移）对应的页面百分比矩形（按行合并）。
 * 空项不占字符偏移；越界/空区间返回空数组（宁可不画，也不乱画）。
 */
export function flashRectsForRange(
  viewport: FlashViewportLike,
  items: PdfTextItemLike[],
  start: number,
  end: number
): FlashRect[] {
  if (!(end > start) || !viewport || viewport.width <= 0 || viewport.height <= 0) return []
  const boxes: FlashRect[] = []
  let cursor = 0
  for (const item of items) {
    const str = item.str ?? ''
    if (!str || !item.transform) {
      cursor += str.length
      continue
    }
    const itemStart = cursor
    const itemEnd = cursor + str.length
    cursor = itemEnd
    if (itemEnd <= start || itemStart >= end) continue
    const tx = composeTransform(viewport.transform, item.transform)
    const fontHeight = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]) || 0
    if (fontHeight <= 0) continue
    const itemWidth = (item.width ?? 0) * viewport.scale
    const from = Math.max(start, itemStart) - itemStart
    const to = Math.min(end, itemEnd) - itemStart
    const x = tx[4] + itemWidth * (from / str.length)
    const w = Math.max(1, itemWidth * ((to - from) / str.length))
    const y = tx[5] - fontHeight * ASCENT
    boxes.push({
      left: (x / viewport.width) * 100,
      top: (y / viewport.height) * 100,
      width: (w / viewport.width) * 100,
      height: ((fontHeight * HEIGHT_MARGIN) / viewport.height) * 100,
      angle: Math.atan2(tx[1], tx[0])
    })
  }
  if (boxes.length === 0) return []
  // 按行合并：纵向重叠超过半行高就并成一条（高亮"几行"而不是"一串碎块"）
  const sorted = [...boxes].sort((a, b) => a.top - b.top || a.left - b.left)
  const merged: FlashRect[] = []
  for (const b of sorted) {
    const cur = merged[merged.length - 1]
    const overlap = cur ? Math.min(cur.top + cur.height, b.top + b.height) - Math.max(cur.top, b.top) : -1
    const lineHeight = cur ? Math.min(cur.height, b.height) : 0
    const sameAngle = cur ? Math.abs(cur.angle - b.angle) < 0.01 : false
    if (cur && sameAngle && overlap > lineHeight * 0.5) {
      const right = Math.max(cur.left + cur.width, b.left + b.width)
      cur.left = Math.min(cur.left, b.left)
      cur.width = right - cur.left
      cur.top = Math.min(cur.top, b.top)
      cur.height = Math.max(cur.top + cur.height, b.top + b.height) - cur.top
    } else {
      merged.push({ ...b })
    }
  }
  return merged
}

/* ------------------------------ 单测 ------------------------------ */

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  /** 1000×1000 的页、scale=1、无旋转；字号 10（字高 10px）、用户空间宽度 100 → 渲染宽 100px = 10% */
  const viewport: FlashViewportLike = { width: 1000, height: 1000, scale: 1, transform: [1, 0, 0, 1, 0, 0] }
  const item = (str: string, x: number, y: number, width: number): PdfTextItemLike => ({
    str,
    width,
    transform: [10, 0, 0, 10, x, y]
  })

  describe('pdf flash geometry (Phase 9 高亮补充)', () => {
    it('整项命中：宽度按 item.width × scale 换算，基线换算成行框（手算值钉住）', () => {
      const rects = flashRectsForRange(viewport, [item('abcdefghij', 100, 500, 100)], 0, 10)
      expect(rects).toHaveLength(1)
      expect(rects[0].left).toBeCloseTo(10, 3) // 100 / 1000
      expect(rects[0].width).toBeCloseTo(10, 3) // 100 * 1 / 1000
      expect(rects[0].top).toBeCloseTo(49.12, 2) // (500 - 10 * 0.88) / 1000
      expect(rects[0].height).toBeCloseTo(1.08, 2) // 10 * 1.08 / 1000
      expect(rects[0].angle).toBe(0)
    })

    it('部分命中：按字符比例切出横向区间（左半 / 右半）', () => {
      const one = [item('abcdefghij', 0, 100, 100)]
      const leftHalf = flashRectsForRange(viewport, one, 0, 5)[0]
      expect(leftHalf.left).toBeCloseTo(0, 3)
      expect(leftHalf.width).toBeCloseTo(5, 3)
      const rightHalf = flashRectsForRange(viewport, one, 5, 10)[0]
      expect(rightHalf.left).toBeCloseTo(5, 3)
      expect(rightHalf.width).toBeCloseTo(5, 3)
    })

    it('同一行的多个文字项合并成一条，不同行分成两条（这就是"高亮几行"）', () => {
      const rects = flashRectsForRange(
        viewport,
        [
          item('aaaa', 0, 100, 40),
          item('bbbb', 40, 101, 40), // 同一行（y 差 1px）
          item('cccc', 0, 300, 40) // 另一行
        ],
        0,
        12
      )
      expect(rects).toHaveLength(2)
      expect(rects[0].left).toBeCloseTo(0, 3)
      expect(rects[0].width).toBeCloseTo(8, 3) // 合并 0–80px
      expect(rects[1].top).toBeGreaterThan(rects[0].top)
    })

    it('空项/越界/空区间/坏数据都不产生矩形（宁可不画，也不乱画）', () => {
      expect(flashRectsForRange(viewport, [], 0, 5)).toEqual([])
      expect(flashRectsForRange(viewport, [item('abc', 0, 100, 30)], 5, 5)).toEqual([])
      expect(flashRectsForRange(viewport, [item('abc', 0, 100, 30)], 10, 20)).toEqual([])
      expect(flashRectsForRange(viewport, [{ str: 'abc' }], 0, 3)).toEqual([]) // 缺 transform
      expect(flashRectsForRange({ ...viewport, width: 0 }, [item('abc', 0, 100, 30)], 0, 3)).toEqual([])
      // 空字符串项不占字符偏移，后续项照常命中
      const rects = flashRectsForRange(viewport, [{ str: '', transform: [1, 0, 0, 1, 0, 0] }, item('xyz', 0, 50, 30)], 0, 3)
      expect(rects).toHaveLength(1)
      expect(rects[0].left).toBeCloseTo(0, 3)
    })
  })
}
