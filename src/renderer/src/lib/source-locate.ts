/**
 * source-locate.ts —— Phase 9 / S4：来源定位的**纯逻辑**（无 DOM、无 React）。
 *
 * S4 的口径变化（用户裁定 Q3/Q4）：**只报"页/段"，不再做句子级检索**。
 * 位置来自生成期算好的锚点（`compilation_item_anchors` 的块号 × `source_blocks` 的页码），
 * 因此卡片被大模型改写也不影响定位，也**不需要在打开来源时全文搜索**。
 *
 * 三种可以如实说出口的状态：
 *  - `page`：块表给出了页码 →「已定位到第 P 页」（PDF，含**没有文字层的扫描件**）；
 *  - `paragraph`：该来源没有页概念（Word/WPS/网页）→「已定位到第 N 段」，
 *    N 由块在正文里的起始偏移**数换行**得出（不做排版近似页，见 Q3）；
 *  - `unknown`：老汇编没有锚点 → 如实提示"未记录来源位置"，**绝不跳错页**（Q4）。
 *
 * 放在 .ts 而不是组件里：本项目的内联单测只覆盖 `src/**\/*.ts`（.tsx 的内联测试不会执行）。
 */

/** 来源锚点（与主进程 `CompilationItemAnchor` 同形，渲染层自己声明以免依赖主进程类型） */
export interface ItemAnchorView {
  sourceId: string
  /** 该段取自来源正文的第几块（0 起） */
  blockIndex: number
  /** 该块所属页码（1 起）；null = 无页码概念或页表未生成 */
  page: number | null
  /** 该块在来源正文里的起始字符偏移；块行缺失时为 null */
  charStart: number | null
  /** exact = 用该段的证据引文定位；weak = 证据缺失、用卡片正文定位。二者都是**逐字命中**，故不作界面警示 */
  confidence: 'exact' | 'weak'
}

/** 定位锚：查看器据此显示定位条（`label` 是右侧的说明，如「本汇编第 48 段」） */
export type SourceLocateAnchor =
  | { kind: 'page'; page: number; blockIndex: number; confidence: 'exact' | 'weak'; label?: string }
  | { kind: 'paragraph'; charStart: number; blockIndex: number; confidence: 'exact' | 'weak'; label?: string }
  | { kind: 'unknown'; label?: string }

/* ------------------------------ 高亮（2026-10-03 用户裁定新增） ------------------------------ */

/** 来源块表的一行（由只读 IPC `sources:blocks` 提供） */
export interface SourceBlockView {
  blockIndex: number
  charStart: number
  charEnd: number
  page: number | null
}

/**
 * 高亮区间（纯数据，查看器自己决定怎么画）：
 * - `docStart/docEnd`：**来源正文**里的字符区间（纯文本查看器用）；
 * - `page`/`localStart`/`localEnd`：该区间在目标页内的偏移（PDF 查看器用，块不跨页）；
 * - `pageStart/pageEnd`：该页在正文里的字符区间（PDF 端做夹取时用得上）；
 * - `how`：这个区间是**怎么来的**（2026-11-04 用户实测反馈后新增）：
 *   `evidence` = 引文在锚点块内逐字命中（最准）；
 *   `similar` = 块内找不到，在**同一页**内用相似度找到最像的一句（模型改写过，近似）；
 *   `block` = 只能给整块（约 500 字，包含目标但不精确）。
 */
export interface FlashRange {
  docStart: number
  docEnd: number
  page: number | null
  localStart: number
  localEnd: number
  /** 该高亮是"用证据引文收窄"得来的（更准）还是退化为"整块" */
  narrowed: boolean
  how: 'evidence' | 'similar' | 'block'
}

/**
 * 收窄的最小引文长度（去空白后）。短于这个长度**不做收窄**：
 * 实测「共享」这种 2 字引文会在全文里命中几十处，收窄反而把人带到错误位置。
 */
export const NARROW_MIN_CHARS = 8
/** 页内相似度兜底的接受门槛（bigram Dice）；低于它就是"不像"，宁可整块高亮 */
export const SIMILAR_MIN_DICE = 0.5

/** 去掉所有空白 + 建立"紧凑下标 → 原文下标"映射（与 findVerbatimRange 同一口径） */
function compactWithMap(text: string): { compact: string; map: number[] } {
  let compact = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue
    compact += text[i]
    map.push(i)
  }
  return { compact, map }
}

/** 归一化（去空白）后做子串查找，返回**原文**里的区间；找不到返回 null */
export function findVerbatimRange(text: string, needle: string): { start: number; end: number } | null {
  const n = (needle ?? '').trim()
  if (!n) return null
  const target = n.replace(/\s+/g, '')
  if (target.length < 4) return null
  const { compact, map } = compactWithMap(text)
  const at = compact.indexOf(target)
  if (at < 0) return null
  const start = map[at]
  const last = map[Math.min(map.length - 1, at + target.length - 1)]
  return { start, end: last + 1 }
}

/** bigram 多重集 Dice（0–1）；两个串都先去掉空白 */
export function bigramDice(a: string, b: string): number {
  const x = a.replace(/\s+/g, '')
  const y = b.replace(/\s+/g, '')
  if (x.length < 2 || y.length < 2) return 0
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i + 1 < s.length; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ga = grams(x)
  const gb = grams(y)
  let inter = 0
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0)
  return (2 * inter) / (x.length - 1 + (y.length - 1))
}

/**
 * 在**一段正文区间**里找"最像 needle 的一小段"（用于模型改写过的卡片）。
 *
 * 口径：把该区间压成紧凑串，用与 needle 等长的滑窗逐位算 bigram Dice；取最高分。
 * 同分（差 ≤0.02）时**优先离 `preferAt` 近的**——锚点块是我们最好的先验，别被页内别的相似句抢走。
 * 返回的区间一定落在该页区间内（映射回原文下标后夹取）。
 */
export function findBestSimilarRange(
  text: string,
  from: number,
  to: number,
  needle: string,
  preferAt: number
): { start: number; end: number; dice: number } | null {
  const fn = (needle ?? '').trim()
  if (fn.length < 4) return null
  const pageRaw = text.slice(Math.max(0, from), Math.min(text.length, to))
  if (!pageRaw) return null
  const { compact, map } = compactWithMap(pageRaw)
  const want = fn.replace(/\s+/g, '')
  const win = Math.max(4, Math.min(want.length + 4, 60))
  if (compact.length < Math.min(4, win)) return null
  let best: { start: number; end: number; dice: number; dist: number } | null = null
  const limit = Math.max(1, compact.length - win + 1)
  for (let i = 0; i < limit; i++) {
    const cand = compact.slice(i, Math.min(compact.length, i + win))
    const dice = bigramDice(cand, want)
    if (dice < SIMILAR_MIN_DICE) continue
    const rawStart = map[i]
    const rawEnd = map[Math.min(map.length - 1, i + cand.length - 1)] + 1
    const dist = Math.abs(Math.max(0, from) + rawStart - preferAt)
    if (!best || dice > best.dice + 0.02 || (Math.abs(dice - best.dice) <= 0.02 && dist < best.dist)) {
      best = { start: Math.max(0, from) + rawStart, end: Math.max(0, from) + rawEnd, dice, dist }
    }
  }
  if (!best) return null
  return { start: Math.max(from, best.start), end: Math.min(to, best.end), dice: best.dice }
}

/**
 * 把"锚点 + 块表 + 证据引文"换算成**保证包含目标**的高亮区间（纯函数）。
 *
 * 2026-11-04（用户实测反馈：「文武砂中学…」那条高亮成「共享」两个字）后的三条口径：
 * ① **块内优先**：引文只在**锚点块区间内**找，不再对全文 `indexOf`——旧实现找全文第一次出现，
 *    短/常见引文会把高亮带到别的段落，或因交集为空退回整块（看着就"差几行"）；
 * ② **短引文不收窄**：去空白后 < `NARROW_MIN_CHARS`（8 字）不参与收窄，直接整块；
 * ③ **页内相似度兜底**：块内找不到逐字（卡片被模型改写过，或引文缺失）时，在**同一页**内找最像的一句，
 *    拿到就高亮它（`how='similar'`，界面如实说明"与原文不完全一致"）；仍找不到才整块。
 */
export function flashRangeFor(
  anchor: { kind: string; blockIndex?: number; page?: number | null },
  blocks: SourceBlockView[],
  evidence?: string,
  sourceText?: string
): FlashRange | null {
  if (typeof anchor.blockIndex !== 'number') return null
  const block = blocks.find((b) => b.blockIndex === anchor.blockIndex)
  if (!block) return null
  const blockStart = Math.min(block.charStart, block.charEnd)
  const blockEnd = Math.max(block.charStart, block.charEnd)

  // 该页在正文里的字符区间（块不跨页，故取该页所有块的并集）
  const page = block.page ?? (typeof anchor.page === 'number' ? anchor.page : null)
  let pageStart = blockStart
  let pageEnd = blockEnd
  if (page != null) {
    const same = blocks.filter((b) => b.page === page)
    if (same.length > 0) {
      pageStart = Math.min(...same.map((b) => Math.min(b.charStart, b.charEnd)))
      pageEnd = Math.max(...same.map((b) => Math.max(b.charStart, b.charEnd)))
    }
  }

  let docStart = blockStart
  let docEnd = blockEnd
  let how: FlashRange['how'] = 'block'

  const ev = (evidence ?? '').trim()
  const longEnough = ev.replace(/\s+/g, '').length >= NARROW_MIN_CHARS
  if (ev && sourceText && longEnough) {
    // ① 块内优先（把搜索范围限制在锚点块里，天然不会跑到别处）
    const blockHit = findVerbatimRange(sourceText.slice(blockStart, blockEnd), ev)
    if (blockHit) {
      docStart = blockStart + blockHit.start
      docEnd = blockStart + blockHit.end
      how = 'evidence'
    } else if (page != null) {
      // ③ 页内相似度兜底（只在同一页里找，且离锚点块越近越优先）
      const near = findBestSimilarRange(sourceText, pageStart, pageEnd, ev, blockStart)
      if (near) {
        docStart = near.start
        docEnd = near.end
        how = 'similar'
      }
    }
  }
  if (page != null) {
    docStart = Math.max(pageStart, docStart)
    docEnd = Math.min(pageEnd, docEnd)
  }
  if (docEnd <= docStart) return null
  return {
    docStart,
    docEnd,
    page,
    localStart: page != null ? docStart - pageStart : docStart,
    localEnd: page != null ? docEnd - pageStart : docEnd,
    narrowed: how === 'evidence',
    how
  }
}

/** 取某一段在**指定来源**上的锚点（并列来源各开各的，所以必须按 sourceId 挑，不能只看第一行） */
export function anchorForItem(item: { anchors?: ItemAnchorView[] }, sourceId: string): ItemAnchorView | null {
  if (!sourceId) return null
  return item.anchors?.find((a) => a.sourceId === sourceId) ?? null
}

/**
 * 把锚点翻译成"能说出口的状态"。
 * 注意：块号本身**不给用户看**（不是他能核对的东西），所以只有块号而没有字符偏移时
 * 一律归入 `unknown`，宁可说"没有位置"，也不给一个看起来像位置的东西。
 */
export function locateAnchorForItem(
  item: { anchors?: ItemAnchorView[] },
  sourceId: string,
  label?: string
): SourceLocateAnchor {
  const anchor = anchorForItem(item, sourceId)
  if (!anchor) return { kind: 'unknown', label }
  if (anchor.page != null) return { kind: 'page', page: anchor.page, blockIndex: anchor.blockIndex, confidence: anchor.confidence, label }
  if (anchor.charStart != null) {
    return {
      kind: 'paragraph',
      charStart: anchor.charStart,
      blockIndex: anchor.blockIndex,
      confidence: anchor.confidence,
      label
    }
  }
  return { kind: 'unknown', label }
}

/**
 * 某个字符偏移落在来源正文的第几段（1 起）。
 * 口径：**连续换行算一次分段**（Word 抽文多为 `\n\n` 分段、纯文本多为 `\n`），
 * 因此"第 N 段"与非空段落序号一致；正文为空或偏移未知时返回 null（调用方如实降级）。
 */
export function paragraphNumberAt(text: string, offset: number | null | undefined): number | null {
  if (offset == null || !text) return null
  const at = Math.max(0, Math.min(text.length, offset))
  const head = text.slice(0, at)
  const breaks = head.match(/\n+/g)
  return 1 + (breaks ? breaks.length : 0)
}

/**
 * 定位条的**显示状态**（纯函数算出来，界面只负责套文案）。
 * `null` = 没有定位锚（不显示定位条）；`none` = 有锚点但说不出位置 → 如实提示"未记录来源位置"。
 * 注意「数不出第几段」（拿不到正文偏移或正文为空）也归入 `none`：宁可说没有位置，也不给近似值。
 *
 * 这里**不区分** `confidence`：确定性锚定下 exact 与 weak 都是"某段逐字出现在这里"，
 * 位置可靠性没有差别（旧的"模型回报块号"路线才需要拿引文交叉校验、标"位置存疑"；那条路已废弃）。
 */
export const LOCATE_BAR_NONE = 'none' as const

export type LocateBarState =
  | { kind: 'page'; page: number; label?: string }
  | { kind: 'paragraph'; paragraph: number; label?: string }
  | { kind: 'page-unknown'; label?: string }
  | { kind: 'none'; label?: string }

/**
 * `paged` = 该来源本来就有页（PDF）。有页却没算出页码（逐页文字与正文对不上）时**不能**报"第 N 段"
 * ——那是把 PDF 的行当成段，说了等于乱说；这时如实报"未能确定页码"。
 */
export function locateBarState(
  locate: SourceLocateAnchor | null | undefined,
  sourceText: string,
  paged = false
): LocateBarState | null {
  if (!locate) return null
  if (locate.kind === 'page') return { kind: 'page', page: locate.page, label: locate.label }
  if (locate.kind === 'paragraph') {
    if (paged) return { kind: 'page-unknown', label: locate.label }
    const paragraph = paragraphNumberAt(sourceText, locate.charStart)
    if (paragraph != null) return { kind: 'paragraph', paragraph, label: locate.label }
  }
  return { kind: LOCATE_BAR_NONE, label: locate.label }
}

/* ------------------------------ 单测 ------------------------------ */

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  const paged: ItemAnchorView = { sourceId: 's1', blockIndex: 7, page: 216, charStart: 100, confidence: 'exact' }
  const noPage: ItemAnchorView = { sourceId: 'w1', blockIndex: 3, page: null, charStart: 40, confidence: 'weak' }
  const broken: ItemAnchorView = { sourceId: 'x1', blockIndex: 3, page: null, charStart: null, confidence: 'weak' }

  describe('source locate anchors (Phase 9 / S4)', () => {
    it('页码优先：有页就报页（PDF / 扫描件）', () => {
      const a = locateAnchorForItem({ anchors: [paged] }, 's1', '本汇编第 48 段')
      expect(a).toEqual({ kind: 'page', page: 216, blockIndex: 7, confidence: 'exact', label: '本汇编第 48 段' })
    })

    it('无页码来源报"第 N 段"（Word/WPS，Q3）', () => {
      expect(locateAnchorForItem({ anchors: [noPage] }, 'w1')).toEqual({
        kind: 'paragraph',
        charStart: 40,
        blockIndex: 3,
        confidence: 'weak'
      })
    })

    it('并列来源各挑各的锚点，不串位', () => {
      const item = { anchors: [paged, noPage] }
      expect(anchorForItem(item, 's1')?.page).toBe(216)
      expect(anchorForItem(item, 'w1')?.blockIndex).toBe(3)
      expect(anchorForItem(item, '不存在')).toBeNull()
    })

    it('没有锚点 / 只有块号没有偏移 → unknown（老汇编：如实提示，不跳错页）', () => {
      expect(locateAnchorForItem({}, 's1')).toEqual({ kind: 'unknown', label: undefined })
      expect(locateAnchorForItem({ anchors: [broken] }, 'x1').kind).toBe('unknown')
    })

    it('数段：连续换行算一段，偏移未知/正文为空时返回 null', () => {
      const text = '第一段。\n\n第二段。\n第三段。'
      expect(paragraphNumberAt(text, 0)).toBe(1)
      expect(paragraphNumberAt(text, text.indexOf('第二段'))).toBe(2)
      expect(paragraphNumberAt(text, text.indexOf('第三段'))).toBe(3)
      // 偏移落在换行串中间（空行里）→ 归入下一段
      expect(paragraphNumberAt(text, 5)).toBe(2)
      // 越界夹取到末尾
      expect(paragraphNumberAt(text, 9999)).toBe(3)
      expect(paragraphNumberAt(text, null)).toBeNull()
      expect(paragraphNumberAt('', 0)).toBeNull()
    })

    it('高亮区间：引文在**锚点块内**逐字命中才收窄（不再被全文别处的同一句带偏）', () => {
      const evidence = '省一级达标高中 2 所'
      const sent = '2022 年，全区有省一级达标高中 2 所，具体名单见下文。'
      const first = '开头一段无关内容。' + sent
      const pad = 'A'.repeat(300)
      const text = first + pad + sent
      const split = first.length + pad.length
      const blocks = [
        { blockIndex: 0, charStart: 0, charEnd: split, page: 3 },
        { blockIndex: 1, charStart: split, charEnd: text.length, page: 3 }
      ]
      const second = text.indexOf(evidence, split)
      expect(second).toBeGreaterThanOrEqual(split)
      // 锚点在块 1 → 必须落在块 1 那一处（旧实现在全文找第一次出现，会被块 0 带偏）
      const narrow = flashRangeFor({ kind: 'page', blockIndex: 1 }, blocks, evidence, text)!
      expect(narrow.how).toBe('evidence')
      expect(narrow.narrowed).toBe(true)
      expect(narrow.docStart).toBe(second)
      expect(narrow.docEnd).toBe(second + evidence.length)
      expect(narrow.page).toBe(3)
      // 锚点块里找不到 → 页内相似度兜底（同页有一模一样的一句）
      const otherBlocks = [
        { blockIndex: 0, charStart: 0, charEnd: 20, page: 3 },
        { blockIndex: 1, charStart: split, charEnd: text.length, page: 3 }
      ]
      const other = flashRangeFor({ kind: 'page', blockIndex: 0 }, otherBlocks, evidence, text)!
      expect(other.how).toBe('similar')
      expect(other.narrowed).toBe(false)
      // 没有证据 → 整块；找不到块 → null
      expect(flashRangeFor({ kind: 'page', blockIndex: 0 }, blocks)!.docEnd).toBe(split)
      expect(flashRangeFor({ kind: 'page', blockIndex: 9 }, blocks, evidence, text)).toBeNull()
      expect(flashRangeFor({ kind: 'unknown' }, blocks, evidence, text)).toBeNull()
    })

    it('短引文（如「共享」两字）不收窄：整块高亮，避免把人带到别的段落', () => {
      const text = '共享单车在城区投放。' + '共享'.repeat(30) + '目标：文武砂中学整合进长乐华侨中学教育集团滨海校区。'
      const blocks = [{ blockIndex: 0, charStart: 0, charEnd: text.length, page: 257 }]
      const r = flashRangeFor({ kind: 'page', blockIndex: 0 }, blocks, '共享', text)!
      expect(r.how).toBe('block')
      expect(r.docStart).toBe(0)
      expect(r.docEnd).toBe(text.length)
    })

    it('模型改写过的引文 → 页内相似度兜底，落到原文最像的那一句', () => {
      const origin = '【社会事业】2022 年，文武砂中学整合进长乐华侨中学教育集团，成为滨海校区。'
      const text = '前面是垃圾分类与人居环境的记述。'.repeat(3) + origin + '后面继续讲别的事情。'.repeat(3)
      const pageStart = 0
      const pageEnd = text.length
      const blocks = [{ blockIndex: 0, charStart: pageStart, charEnd: pageEnd, page: 257 }]
      // 模型写的版本与原文不同（"整合进…滨海校区"），逐字必然找不到
      const rewritten = '文武砂中学整合进长乐华侨中学教育集团滨海校区'
      expect(findVerbatimRange(text, rewritten)).toBeNull()
      const r = flashRangeFor({ kind: 'page', blockIndex: 0 }, blocks, rewritten, text)!
      expect(r.how).toBe('similar')
      const at = text.indexOf('文武砂中学整合进')
      expect(r.docStart).toBeLessThanOrEqual(at)
      expect(r.docEnd).toBeGreaterThan(at)
      expect(r.page).toBe(257)
    })

    it('页内也不像 → 退回整块（不猜）', () => {
      const text = '完全不相关的甲甲甲甲。'.repeat(10)
      const blocks = [{ blockIndex: 0, charStart: 0, charEnd: text.length, page: 1 }]
      const r = flashRangeFor({ kind: 'page', blockIndex: 0 }, blocks, '乙方乙方的投资协议内容', text)!
      expect(r.how).toBe('block')
    })

    it('高亮区间按页夹取：块不跨页，页码不同则局内偏移从该页起点算起', () => {
      const text = 'A'.repeat(500) + '目标句子在这里。' + 'B'.repeat(500)
      const at = text.indexOf('目标句子')
      const blocks = [
        { blockIndex: 0, charStart: 0, charEnd: 500, page: 1 },
        { blockIndex: 1, charStart: 500, charEnd: 1000, page: 2 }
      ]
      const r = flashRangeFor({ kind: 'page', blockIndex: 1 }, blocks, '目标句子在这里', text)!
      expect(r.page).toBe(2)
      expect(r.docStart).toBe(at)
      expect(r.localStart).toBe(at - 500) // 页 2 的正文起点是 500
      expect(r.localEnd).toBeLessThanOrEqual(500) // 不越出该页
    })

    it('归一化查找：允许排版空白差异，找不到返回 null', () => {
      const text = '2022 年，全区有省一级达标高中 2 所。'
      expect(findVerbatimRange(text, '省一级达标高中2所')).toEqual({ start: text.indexOf('省一级达标高中'), end: text.indexOf('省一级达标高中') + '省一级达标高中 2 所'.length })
      expect(findVerbatimRange(text, '并不存在的内容')).toBeNull()
      expect(findVerbatimRange(text, '')).toBeNull()
    })

    it('定位条状态：页 / 段 / 未记录位置三分支', () => {
      const text = '第一段。\n第二段。'
      expect(locateBarState(null, text)).toBeNull()
      expect(locateBarState({ kind: 'page', page: 216, blockIndex: 7, confidence: 'exact' }, text)).toEqual({
        kind: 'page',
        page: 216,
        label: undefined
      })
      expect(locateBarState({ kind: 'paragraph', charStart: 5, blockIndex: 1, confidence: 'weak' }, text)).toEqual({
        kind: 'paragraph',
        paragraph: 2,
        label: undefined
      })
      expect(locateBarState({ kind: 'unknown' }, text)).toEqual({ kind: 'none', label: undefined })
      // 数不出段号（没有正文）→ 同样如实说"未记录来源位置"
      expect(
        locateBarState({ kind: 'paragraph', charStart: 4, blockIndex: 1, confidence: 'exact' }, '')?.kind
      ).toBe('none')
      // 本来就是有页的来源（PDF）却没算出页码 → 不许拿"第 N 段"糊弄
      expect(
        locateBarState({ kind: 'paragraph', charStart: 4, blockIndex: 1, confidence: 'exact' }, text, true)
      ).toEqual({ kind: 'page-unknown', label: undefined })
    })
  })
}
