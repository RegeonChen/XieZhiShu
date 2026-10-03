/**
 * Phase 9 / S2：来源"块表"的纯逻辑（无 IO、无数据库、无 Electron 依赖）。
 *
 * 为什么要它：定位到页 = **块号（生成期由大模型给出）** × **块属于第几页（解析期算好）**。
 * 本模块负责后半截：
 *  ① `splitIntoBlocks` 把正文切成 ~500 字、按句读吸附的块（块是"定位的最小单位"）；
 *  ② `assignPages` 用解析期得到的**每页字符区间**给块标页，并把跨页的块切开
 *     —— "块绝不跨页"是页级定位精度的硬保证（块一大就横跨两三页，页码就含糊了）；
 *  ③ `alignPageTexts` 把"逐页文字"对齐到"库里存的正文"，得到每页的字符区间。
 *     对齐用的是**去空白归一化 + 下标映射**（同一份文字在不同提取器下只差空白/换行）；
 *     只要有非空页对不上就返回 null，**宁可不落页表，也不给错页码**。
 *
 * 设计取舍：块之间**首尾相接**（`char_end` = 下一块的 `char_start`），这样"证据引文落在哪一块"
 * 这类交叉校验可以只用区间判断，不必重新搜索文本。
 */

export interface BlockRange {
  /** 从 0 开始的块序号（同一来源内连续、唯一） */
  blockIndex: number
  /** 在来源正文中的字符区间（左闭右开） */
  start: number
  end: number
  /** 所属页码（1 起）；无页码概念的文件（Word/WPS/网页）为 null */
  page: number | null
}

export interface PageRange {
  page: number
  start: number
  end: number
}

/** 句末标点（中文与英文）；换行也视为可切点 */
const SENTENCE_END = /[。！？；!?;]/
const MAX_SNAP_LOOKAHEAD = 160

/**
 * 切块：每块目标 `maxChars` 字，向后最多再找 `MAX_SNAP_LOOKAHEAD` 字内的句末标点作为切点
 * （找不到就就地切），保证**块的边界尽量落在句子之间**，模型指认块号时更不容易跨语义单元。
 * 返回的块首尾相接、非空，覆盖整段文字。
 */
export function splitIntoBlocks(text: string, maxChars = 500): BlockRange[] {
  const blocks: BlockRange[] = []
  const total = text.length
  if (total === 0) return blocks
  let start = 0
  let index = 0
  while (start < total) {
    const hardEnd = Math.min(total, start + maxChars)
    let end = hardEnd
    if (hardEnd < total) {
      // 句读吸附：先**向前**看一小段（把句子读完），再**向后**回退到最近的句末标点。
      // 优先回退，是为了既不把句子切两半、又不让块明显超过 maxChars（回退下限 = 目标字数的 60%）。
      const lookEnd = Math.min(total, hardEnd + MAX_SNAP_LOOKAHEAD)
      let forward = -1
      for (let i = hardEnd; i < lookEnd; i++) {
        if (SENTENCE_END.test(text[i]) || text[i] === '\n') {
          forward = i + 1
          break
        }
      }
      const minEnd = start + Math.floor(maxChars * 0.6)
      let backward = -1
      for (let i = hardEnd - 1; i >= minEnd; i--) {
        if (SENTENCE_END.test(text[i]) || text[i] === '\n') {
          backward = i + 1
          break
        }
      }
      if (backward >= 0) end = backward
      else if (forward >= 0) end = forward
    }
    blocks.push({ blockIndex: index++, start, end, page: null })
    start = end
  }
  return blocks
}

/**
 * 按**段落**切块（Phase 9 / S4）：用于**没有页概念**的来源（Word/WPS/网页/图片）。
 *
 * 为什么不能沿用 `splitIntoBlocks` 的"每 ~500 字一块"：那样"这一块"会横跨好几段，
 * 而 Q3 裁定 Word/WPS 要"定位到段/标题"——若块首落在第 1 段、卡片其实取自同一块里的第 3 段，
 * 界面报"第 1 段"就是**给错位置**（正是 Phase 9 要消灭的东西）。
 * 这里让块边界与段落边界一致：块 = [本段起点, 下段起点)，段间换行归前一段（与页区间同一体例），
 * 于是"块起点是第几段"就等于"这一块是第几段"。超长段落再按 `splitIntoBlocks` 细分（句读吸附）。
 */
export function splitByParagraphs(text: string, maxChars = 500): BlockRange[] {
  const out: BlockRange[] = []
  const total = text.length
  if (total === 0) return out
  const starts: number[] = [0]
  const re = /\n+/g
  let m = re.exec(text)
  while (m) {
    const at = m.index + m[0].length
    if (at < total) starts.push(at) // 末尾换行不算新段
    m = re.exec(text)
  }
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : total
    if (to - from <= maxChars) {
      out.push({ blockIndex: out.length, start: from, end: to, page: null })
      continue
    }
    // 超长段落：按句读细分成首尾相接的子块（都落在同一段里）
    for (const b of splitIntoBlocks(text.slice(from, to), maxChars)) {
      out.push({ blockIndex: out.length, start: from + b.start, end: from + b.end, page: null })
    }
  }
  return out
}

/**
 * 给块标页：把与页区间相交的块**切开**，使每块只属于一页。
 * `pages` 需按 start 升序且互不重叠；块与页都不覆盖的文字（如页间分隔符）会落到"前一页"，
 * 保证不会凭空丢字、也不会把分隔符算成新块。
 */
export function assignPages(blocks: BlockRange[], pages: PageRange[]): BlockRange[] {
  if (pages.length === 0) return blocks.map((b, i) => ({ ...b, blockIndex: i, page: null }))
  const out: BlockRange[] = []
  let index = 0
  for (const block of blocks) {
    let cursor = block.start
    for (const page of pages) {
      if (page.end <= cursor || page.start >= block.end) continue
      const from = Math.max(cursor, page.start)
      const to = Math.min(block.end, page.end)
      if (to <= from) continue
      if (from > cursor) {
        // 落在页间空隙（分隔符）→ 并入该页，避免产生"无页"的碎块
        out.push({ blockIndex: index++, start: cursor, end: from, page: page.page })
      }
      out.push({ blockIndex: index++, start: from, end: to, page: page.page })
      cursor = to
      if (cursor >= block.end) break
    }
    if (cursor < block.end) {
      // 尾部落在所有页区间之外（理论上前一页已覆盖）→ 归到最后一页
      out.push({ blockIndex: index++, start: cursor, end: block.end, page: pages[pages.length - 1].page })
    }
  }
  return out
}

/** 去空白归一化，并给出"归一化下标 → 原文下标"的映射（对齐与高亮都要用） */
export function normalizeForMatch(text: string): { text: string; map: number[] } {
  let stripped = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue
    stripped += text[i]
    map.push(i)
  }
  return { text: stripped, map }
}

/**
 * 把逐页文字对齐到库里存的正文，得到每页字符区间。
 * 逐页文字必须**按顺序**出现在正文里；只要有非空页对不上就返回 null（调用方据此不落页表）。
 * 空页（扫描页没有文字层）会得到一个空区间，仍保留页码——扫描件因此也能定位到页。
 */
export function alignPageTexts(storedText: string, pageTexts: string[]): PageRange[] | null {
  const stored = normalizeForMatch(storedText)
  const starts: number[] = []
  let from = 0
  for (let i = 0; i < pageTexts.length; i++) {
    const page = normalizeForMatch(pageTexts[i] ?? '')
    if (page.text.length === 0) {
      // 空页（扫描页没有文字层）：位置取当前游标，页码照记——扫描件因此也能定位到页
      starts.push(from < stored.map.length ? stored.map[from] : storedText.length)
      continue
    }
    // 先用整页匹配；匹配不到时退一步：只要求该页**开头 30 字**能对上
    // （页眉页脚/表格重排会让整页对不上，但开头一段通常稳定），仍对不上则整体失败。
    let at = stored.text.indexOf(page.text, from)
    if (at < 0) {
      at = stored.text.indexOf(page.text.slice(0, 30), from)
      if (at < 0) return null
    }
    starts.push(stored.map[at])
    from = at + page.text.length
  }

  /**
   * 区间口径：**页 N = [页 N 起点, 页 N+1 起点)**，末页到正文末尾。
   * 为什么不用"起点 + 整页长度"：一旦某页靠"开头 30 字"匹配上，那个长度会**越过后面若干页**，
   * 使区间相互重叠，块就会被标成更小的页码（真实年鉴实测出现过 351 → 11 的倒退）。
   * 用"下一票起点"兜底后，区间天然有序、不重叠、无洞，页间分隔符自然归到前一页。
   */
  const ranges: PageRange[] = []
  for (let i = 0; i < starts.length; i++) {
    const start = i === 0 ? starts[0] : Math.max(starts[i], starts[i - 1])
    const end = i + 1 < starts.length ? Math.max(start, starts[i + 1]) : storedText.length
    ranges.push({ page: i + 1, start, end })
  }
  return ranges
}

/* ------------------------------ 单测 ------------------------------ */

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('page-map: splitIntoBlocks', () => {
    it('首尾相接且覆盖全部文字', () => {
      const text = '甲'.repeat(1200)
      const blocks = splitIntoBlocks(text, 500)
      expect(blocks[0].start).toBe(0)
      expect(blocks[blocks.length - 1].end).toBe(text.length)
      for (let i = 1; i < blocks.length; i++) expect(blocks[i].start).toBe(blocks[i - 1].end)
      for (const b of blocks) expect(b.end).toBeGreaterThan(b.start)
    })

    it('优先在句末标点处切（不硬切在句中）', () => {
      const head = '甲'.repeat(480)
      const text = head + '第一句结束。' + '乙'.repeat(400)
      const blocks = splitIntoBlocks(text, 500)
      // 500 字硬切点落在"第一句结束。"之后 → 切点应吸附到句号
      expect(text.slice(blocks[0].end - 1, blocks[0].end)).toBe('。')
    })

    it('空文本返回空数组', () => {
      expect(splitIntoBlocks('', 500)).toEqual([])
    })
  })

  describe('page-map: splitByParagraphs', () => {
    it('块边界与段落边界一致：块起点就是该段起点', () => {
      const text = '第一段。\n\n第二段。\n第三段。'
      const blocks = splitByParagraphs(text)
      expect(blocks.map((b) => b.start)).toEqual([0, text.indexOf('第二段'), text.indexOf('第三段')])
      // 首尾相接、覆盖全文（与 splitIntoBlocks 同一不变量）
      expect(blocks[0].start).toBe(0)
      expect(blocks[blocks.length - 1].end).toBe(text.length)
      for (let i = 1; i < blocks.length; i++) expect(blocks[i].start).toBe(blocks[i - 1].end)
      expect(blocks.every((b) => b.page === null)).toBe(true)
    })

    it('超长段落按句读细分成首尾相接的子块', () => {
      const text = '甲'.repeat(480) + '第一句结束。' + '乙'.repeat(400) + '\n短段。'
      const blocks = splitByParagraphs(text, 500)
      expect(blocks.length).toBeGreaterThan(2)
      expect(blocks[0].start).toBe(0)
      expect(blocks[blocks.length - 1].end).toBe(text.length)
      for (let i = 1; i < blocks.length; i++) expect(blocks[i].start).toBe(blocks[i - 1].end)
      // 细分点仍吸附在句末标点之后
      expect(text.slice(blocks[0].end - 1, blocks[0].end)).toBe('。')
    })

    it('空文本 / 只有换行 / 末尾换行', () => {
      expect(splitByParagraphs('')).toEqual([])
      expect(splitByParagraphs('\n\n\n').length).toBe(1)
      const blocks = splitByParagraphs('甲\n')
      expect(blocks.length).toBe(1)
      expect(blocks[0].end).toBe(2)
    })
  })

  describe('page-map: assignPages', () => {
    it('跨页的块被切开，每块只属于一页', () => {
      const text = '甲'.repeat(1000)
      const blocks = splitIntoBlocks(text, 500) // [0,500) [500,1000)
      const pages = [
        { page: 1, start: 0, end: 400 },
        { page: 2, start: 400, end: 1000 }
      ]
      const out = assignPages(blocks, pages)
      expect(out.map((b) => b.page)).toEqual([1, 2, 2])
      expect(out.map((b) => [b.start, b.end])).toEqual([
        [0, 400],
        [400, 500],
        [500, 1000]
      ])
      // 序号重排为连续
      expect(out.map((b) => b.blockIndex)).toEqual([0, 1, 2])
    })

    it('没有页信息时全部标 null（Word/WPS/网页）', () => {
      const out = assignPages(splitIntoBlocks('甲'.repeat(600), 500), [])
      expect(out.every((b) => b.page === null)).toBe(true)
    })
  })

  describe('page-map: alignPageTexts', () => {
    it('容忍空白差异并对出每页区间', () => {
      const storedText = '第一页正文。\n\n第二页正文。'
      const ranges = alignPageTexts(storedText, ['第 一 页 正 文 。', '第二页正文。'])
      expect(ranges).not.toBeNull()
      const r = ranges as PageRange[]
      expect(r).toHaveLength(2)
      // 区间口径 = [本页起点, 下一页起点)：页 1 含页间分隔符，页 2 到正文末尾
      expect(r[0].start).toBe(0)
      expect(storedText.slice(r[0].start, r[0].end).startsWith('第一页正文。')).toBe(true)
      expect(storedText.slice(r[1].start, r[1].end)).toBe('第二页正文。')
    })

    it('区间不重叠且严格有序（页 N 的终点 = 页 N+1 的起点）', () => {
      const storedText = '甲甲甲。乙乙乙。丙丙丙。'
      // 第 2 页整页对不上（模拟页眉页脚/重排），只有开头 2 字能对上：
      // 旧口径会把它"整页长度"的终点算到第 3 页之外，导致区间重叠、块被标成更小的页码
      const r = alignPageTexts(storedText, ['甲甲甲。', '乙乙', '丙丙丙。']) as PageRange[]
      expect(r).not.toBeNull()
      expect(r.map((x) => x.page)).toEqual([1, 2, 3])
      for (let i = 1; i < r.length; i++) {
        expect(r[i].start).toBeGreaterThanOrEqual(r[i - 1].start)
        expect(r[i - 1].end).toBe(r[i].start)
      }
      expect(r[r.length - 1].end).toBe(storedText.length)
    })

    it('空页（扫描页无文字层）保留页码但区间为零长度', () => {
      const storedText = '有字的一页'
      const r = alignPageTexts(storedText, ['', '有字的一页']) as PageRange[]
      expect(r).not.toBeNull()
      expect(r[0].page).toBe(1)
      expect(r[0].end - r[0].start).toBe(0)
      expect(r[1].page).toBe(2)
    })

    it('某页文字对不上就整体返回 null（宁可不落页表，也不给错页码）', () => {
      expect(alignPageTexts('第一页正文。', ['第一页正文。', '完全不存在的一页'])).toBeNull()
    })
  })
}
