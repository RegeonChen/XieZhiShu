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
 * - `pageStart/pageEnd`：该页在正文里的字符区间（PDF 端做夹取时用得上）。
 */
export interface FlashRange {
  docStart: number
  docEnd: number
  page: number | null
  localStart: number
  localEnd: number
  /** 该高亮是"用证据引文收窄"得来的（更准）还是退化为"整块" */
  narrowed: boolean
}

/** 归一化（去空白）后做子串查找，返回**原文**里的区间；找不到返回 null */
export function findVerbatimRange(text: string, needle: string): { start: number; end: number } | null {
  const n = (needle ?? '').trim()
  if (!n) return null
  const compact = (s: string): string => s.replace(/\s+/g, '')
  const target = compact(n)
  if (target.length < 2) return null
  // 建立"紧凑下标 → 原文下标"的映射
  const map: number[] = []
  let built = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) continue
    built += ch
    map.push(i)
  }
  const at = built.indexOf(target)
  if (at < 0) return null
  const start = map[at]
  const last = map[at + target.length - 1]
  return { start, end: last + 1 }
}

/**
 * 把"锚点 + 块表 + 证据引文"换算成**保证包含目标**的高亮区间（纯函数）。
 *
 * 保证来自锚点的定义：`attachAnchors` 是把**证据引文（或卡片正文）逐字命中**到某个块上才写的锚点，
 * 所以"锚点那一块的区间"必然包含目标。这里再用证据引文把区间**收窄**（通常只有一两句话、跨几行），
 * 收窄结果若不与锚点块相交（理论上不该发生）就退回整块 —— 退一步也仍然"目标一定在内"。
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
  let narrowed = false
  if (evidence && sourceText) {
    const hit = findVerbatimRange(sourceText, evidence)
    if (hit && hit.start < blockEnd && hit.end > blockStart) {
      // 收窄，但**不能越出锚点块**（否则可能把目标切掉）
      docStart = Math.max(blockStart, hit.start)
      docEnd = Math.min(blockEnd, hit.end)
      narrowed = true
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
    narrowed
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

    it('高亮区间：证据引文把区间收窄，且**永不越出锚点块**（目标一定在内）', () => {
      const text = '开头一段无关内容。' + '2022 年，全区有省一级达标高中 2 所，具体名单见下文。' + '后面还有很多别的文字，用来撑开长度。'.repeat(20)
      const evidence = '省一级达标高中 2 所'
      const block0 = { blockIndex: 0, charStart: 0, charEnd: 300, page: 3 }
      const block1 = { blockIndex: 1, charStart: 300, charEnd: 900, page: 3 }
      const blocks = [block0, block1]
      const hit = findVerbatimRange(text, evidence)!
      expect(hit.start).toBeGreaterThan(0)
      // 锚点在块 0 上 → 收窄到证据区间（在块 0 内）
      const narrow = flashRangeFor({ kind: 'page', blockIndex: 0 }, blocks, evidence, text)!
      expect(narrow.narrowed).toBe(true)
      expect(narrow.docStart).toBe(hit.start)
      expect(narrow.docEnd).toBe(hit.end)
      expect(narrow.page).toBe(3)
      expect(narrow.localStart).toBe(hit.start) // 该页起点 = 块 0 起点 = 0
      // 锚点在块 1 上、而证据落在块 0 内 → 不能收窄（否则把目标切掉），退回整块 1
      const fallback = flashRangeFor({ kind: 'page', blockIndex: 1 }, blocks, evidence, text)!
      expect(fallback.narrowed).toBe(false)
      expect(fallback.docStart).toBe(300)
      expect(fallback.docEnd).toBe(900)
      // 没有证据 → 整块；没有块表 → null（宁可不画，也不乱画）
      expect(flashRangeFor({ kind: 'page', blockIndex: 0 }, blocks)!.docEnd).toBe(300)
      expect(flashRangeFor({ kind: 'page', blockIndex: 9 }, blocks, evidence, text)).toBeNull()
      expect(flashRangeFor({ kind: 'unknown' }, blocks, evidence, text)).toBeNull()
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
