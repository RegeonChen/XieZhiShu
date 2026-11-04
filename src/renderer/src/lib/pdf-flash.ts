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

/**
 * 在**这一页自己的文字层**里按"目标文本"找区间（2026-11-04 用户实测反馈后新增）。
 *
 * 为什么需要：`flashRectsForRange` 拿的是"`cleaned_text` 里的**页内字符偏移**"，
 * 而 `cleaned_text` 是 pdf-parse 抽出来的、**页内阅读顺序与视觉栏序可能不同**（年鉴是三栏排版）。
 * 两套下标一旦错位，高亮就会落在隔壁几行、甚至只剩「共享」两个字。
 *
 * 做法：把该页文字项拼成一串（与画高亮用的是**同一份**数据），把目标文本去空白后在这串里找；
 * 找到就用**这一页的**下标画高亮——天然与字形对齐，不再依赖跨来源的下标一致性。
 * 找不到（扫描件没有文字层 / 卡片被模型改写到认不出）→ 返回 null，调用方退回旧的偏移口径。
 *
 * 退化匹配：先试完整目标文本；失败则按 3/4、1/2、1/3、12 字逐级缩短（应对"结尾被改写"的情况）。
 */
export function findPageTextRange(items: PdfTextItemLike[], needle: string): { start: number; end: number } | null {
  const want = (needle ?? '').replace(/\s+/g, '')
  if (want.length < 4) return null
  let pageText = ''
  const map: number[] = []
  // 游标口径与 flashRectsForRange 完全一致：按文字项顺序累加 str.length（空白也占位）
  let cursor = 0
  for (const item of items) {
    const str = item.str ?? ''
    for (let i = 0; i < str.length; i++) {
      if (/\s/.test(str[i])) continue
      pageText += str[i]
      map.push(cursor + i)
    }
    cursor += str.length
  }
  if (!pageText) return null
  const lengths = new Set<number>()
  for (const factor of [1, 0.75, 0.5, 0.34]) {
    const n = Math.floor(want.length * factor)
    if (n >= 4) lengths.add(n)
  }
  lengths.add(Math.min(12, want.length))
  for (const n of [...lengths].sort((a, b) => b - a)) {
    const probe = want.slice(0, n)
    const at = pageText.indexOf(probe)
    if (at < 0) continue
    const start = map[at]
    const end = map[Math.min(map.length - 1, at + probe.length - 1)] + 1
    return { start, end }
  }
  return null
}

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
    it('findPageTextRange：在本页文字层里按目标串定位（跨文字项、跨空白都能命中）', () => {
      const items: PdfTextItemLike[] = [
        { str: '前面一段与目标无关的记述。', width: 200, transform: [10, 0, 0, 10, 0, 900] },
        { str: '文武砂中学整合进长乐华侨中学', width: 200, transform: [10, 0, 0, 10, 0, 880] },
        { str: '教育集团滨海校区', width: 100, transform: [10, 0, 0, 10, 0, 860] }
      ]
      const hit = findPageTextRange(items, '文武砂中学整合进长乐华侨中学教育集团滨海校区')!
      expect(hit).not.toBeNull()
      // 命中的区间拼起来必须等于目标（说明跨项边界接得对）
      const joined = items.map((i) => i.str).join('')
      expect(joined.slice(hit.start, hit.end)).toBe('文武砂中学整合进长乐华侨中学教育集团滨海校区')
    })

    it('findPageTextRange：结尾被改写时逐级缩短仍能找到（落到共同前缀）', () => {
      const items: PdfTextItemLike[] = [{ str: '【社会事业】文武砂中学整合进教育集团，成为滨海校区。', width: 300, transform: [10, 0, 0, 10, 0, 500] }]
      const hit = findPageTextRange(items, '文武砂中学整合进教育集团滨海校区（改写过的尾巴）')!
      expect(hit).not.toBeNull()
      const joined = items.map((i) => i.str).join('')
      expect(joined.slice(hit.start, hit.end).startsWith('文武砂中学整合进教育集团')).toBe(true)
    })

    it('findPageTextRange：找不到 / 太短 / 没有文字层 → null（宁可不画）', () => {
      const items: PdfTextItemLike[] = [{ str: '本页与此无关。', width: 100, transform: [10, 0, 0, 10, 0, 500] }]
      expect(findPageTextRange(items, '完全不在这页的一段话')).toBeNull()
      expect(findPageTextRange(items, '共享')).toBeNull() // < 4 字
      expect(findPageTextRange([], '文武砂中学整合进')).toBeNull()
    })

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
