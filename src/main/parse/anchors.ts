/**
 * Phase 9 / S3：来源锚点的**本地确定性**逻辑（无 IO、无数据库）。
 *
 * ⚠ 设计变更（2026-10-03，用户裁定「按建议来」）：原先打算让大模型在生成时回报块号
 * （`renderNumberedBlocks` 标注 + `parseAnchorLabels` 解析）。核查提示词后发现**模型根本看不到来源正文**——
 * 整合提取送给模型的是上一阶段切好的**卡片摘录**（`extract-service.ts` 的 `buildExtractMessages`：
 * `'下面每张【资料卡片】都是从来源文献中整段摘出的'` + `c.excerpt`）。让模型回报它没见过的块结构，
 * 等于又造一个幻觉源，与"否掉全文检索"的初衷相悖。
 *
 * 因此改为**确定性锚定**：卡片摘录与 `evidence` 都是从来源正文里**逐字**切出来的，
 * "位置"在切出来的那一刻就已确定——本地算出字符区间 → 查 `source_blocks` 得块号与页码，
 * **零幻觉、零 token 成本**，且不怕卡片被改写（锚点取自逐字的摘录/证据，不是改写后的卡片文字）。
 */

import { normalizeForMatch, type BlockRange } from './page-map'

/**
 * 在来源正文里定位一段**逐字摘录**（卡片摘录 / `evidence`）的字符区间。
 *
 * 两条路径：① 直接精确匹配（绝大多数情况）；② 失败时**去空白归一化**后匹配，并用下标映射回原文
 * （摘录与正文常只差排版空白/换行，与 S1「引文不足 4 字不发锚」同口径：太短不作为依据）。
 * 这是"确定性锚定"的第一步——有了区间才能算出块号与页码。
 */
export function findVerbatimRange(text: string, snippet: string): { start: number; end: number } | null {
  const needle = (snippet ?? '').trim()
  if (needle.length < 4) return null
  const exact = text.indexOf(needle)
  if (exact >= 0) return { start: exact, end: exact + needle.length }

  const hay = normalizeForMatch(text)
  const need = normalizeForMatch(needle)
  if (need.text.length === 0) return null
  const at = hay.text.indexOf(need.text)
  if (at < 0) return null
  const start = hay.map[at]
  const end = hay.map[Math.min(hay.map.length - 1, at + need.text.length - 1)] + 1
  return { start, end }
}

/**
 * 用字符区间找它所属的块（块表首尾相接且**不跨页**，所以一个位置只可能落在一块里；
 * 位置落在末尾之外时归入最后一块）。
 */
export function blockAtOffset(blocks: BlockRange[], offset: number): BlockRange | null {
  if (blocks.length === 0) return null
  for (const b of blocks) if (offset >= b.start && offset < b.end) return b
  const last = blocks[blocks.length - 1]
  return offset >= last.end ? last : blocks[0]
}

/**
 * 由"证据区间 / 卡片区间"定出锚点：**优先用证据**（更紧），卡片区间（段落正文逐字命中）兜底。
 * 都没有可用区间时返回 null（调用方按"未记录来源位置"处理）。
 * `confidence` 记录**用的是哪一种区间**（见 `ItemAnchorInput`）：两者都是逐字命中，不作界面警示。
 */
export function resolveAnchor(
  blocks: BlockRange[],
  ranges: { evidence?: { start: number; end: number } | null; excerpt?: { start: number; end: number } | null }
): { blockIndex: number; confidence: 'exact' | 'weak' } | null {
  const pick = ranges.evidence ?? ranges.excerpt ?? null
  if (!pick) return null
  const block = blockAtOffset(blocks, pick.start)
  if (!block) return null
  return { blockIndex: block.blockIndex, confidence: ranges.evidence ? 'exact' : 'weak' }
}

/**
 * 段落是否落在块的字符区间内（用**生成期记录的区间**判定，2026-10-05 用户裁定 P0-2）。
 *
 * 与 `blockAtOffset` 的差别：这里用 `charStart`（该段在来源正文里的起点）落块，
 * 而不是"用证据串去正文里找位置"。命中即 `exact`——区间是生成期算出来的，不是事后匹配猜的。
 * 落在所有块之外（正文被重新解析过、区间比块表长）时返回 null，由调用方回退到逐字匹配。
 */
export function blockForRecordedRange(blocks: BlockRange[], charStart: number): BlockRange | null {
  const hit = blocks.find((b) => charStart >= b.start && charStart < b.end)
  if (hit) return hit
  // 恰好落在最后一块的末端（区间右端点）→ 归最后一块；其余越界一律不猜
  const last = blocks[blocks.length - 1]
  return last && charStart === last.end ? last : null
}

/**
 * 逐句切分并给出每句在原文里的**真实区间**（跳过空白、保留未去空白的字符数）。
 * 与 `chunkByParagraphs` 里超长段落按句折分时用的是同一套拆分规则，因此两侧的字符区间口径一致。
 */
export function sentenceRanges(text: string, from: number, to: number): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = []
  let start = from
  for (let i = from; i < to; i++) {
    if (!/[。！？；;]/.test(text[i])) continue
    let rawFrom = start
    let rawTo = i + 1
    while (rawFrom < rawTo && /\s/.test(text[rawFrom])) rawFrom += 1
    while (rawTo > rawFrom && /\s/.test(text[rawTo - 1])) rawTo -= 1
    if (rawFrom < rawTo) out.push({ text: text.slice(rawFrom, rawTo), start: rawFrom, end: rawTo })
    start = i + 1
  }
  // 收尾：末尾没有句末标点的残段也要算上（否则这段文字会在锚点里凭空少一截）
  let rawFrom = start
  let rawTo = to
  while (rawFrom < rawTo && /\s/.test(text[rawFrom])) rawFrom += 1
  while (rawTo > rawFrom && /\s/.test(text[rawTo - 1])) rawTo -= 1
  if (rawFrom < rawTo) out.push({ text: text.slice(rawFrom, rawTo), start: rawFrom, end: rawTo })
  return out
}

/**
 * **唯一**一处"由文字得到字符区间"的生成期入口（2026-10-05 用户裁定 P0-2）。
 *
 * 什么时候用它、什么时候不该用它：
 *  - 生成期：候选块已经在**切块时**自带区间（`chunkParagraphs` / `chunkByParagraphs` / `chunkText`），
 *    卡片与段落**一路携带**即可，**不要**调用本函数做二次定位；
 *  - 只有**旧路径/降级路径**（模型改写过的卡片、历史向量块、以及没有候选元数据的兜底）才在这里
 *    把"逐字证据/段落正文"对回来源正文，取到一个区间。这一步仍然只是"把已知的逐字文字换算成下标"，
 *    不是"搜一个大概像的位置"——找不到就返回 null，由调用方回退或如实留空。
 */
export function rangeOfRecordedText(
  sourceText: string,
  ...candidates: (string | undefined)[]
): { start: number; end: number } | null {
  for (const c of candidates) {
    const t = (c ?? '').trim()
    if (!t) continue
    const r = findVerbatimRange(sourceText, t)
    if (r) return r
  }
  return null
}

/* ------------------------------ 单测 ------------------------------ */

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  const blocks: BlockRange[] = [
    { blockIndex: 0, start: 0, end: 100, page: 3 },
    { blockIndex: 1, start: 100, end: 200, page: 3 },
    { blockIndex: 2, start: 200, end: 300, page: 4 }
  ]

  describe('anchors: findVerbatimRange', () => {
    it('精确匹配直接给出区间', () => {
      const text = '前言。某区新增高中一所，招生 300 人。后记。'
      const r = findVerbatimRange(text, '某区新增高中一所，招生 300 人。') as { start: number; end: number }
      expect(r).not.toBeNull()
      expect(text.slice(r.start, r.end)).toBe('某区新增高中一所，招生 300 人。')
    })

    it('只差排版空白时也能定位，且区间覆盖原文真实字符', () => {
      const text = '第一段。\n某 区 新增 高中 一所。\n第二段。'
      const r = findVerbatimRange(text, '某区新增高中一所。') as { start: number; end: number }
      expect(r).not.toBeNull()
      // 原文里这段本身带空格，切片应覆盖到句号为止
      expect(text.slice(r.start, r.end)).toBe('某 区 新增 高中 一所。')
    })

    it('找不到或过短时返回 null（宁可不发锚，也不乱定位）', () => {
      expect(findVerbatimRange('甲甲甲甲。', '乙乙乙乙。')).toBeNull()
      expect(findVerbatimRange('甲甲甲甲。', '甲甲')).toBeNull() // 不足 4 字
    })
  })

  describe('anchors: blockAtOffset / resolveAnchor', () => {
    it('按字符区间落到正确块（边界归后一块）', () => {
      expect(blockAtOffset(blocks, 0)?.blockIndex).toBe(0)
      expect(blockAtOffset(blocks, 99)?.blockIndex).toBe(0)
      expect(blockAtOffset(blocks, 100)?.blockIndex).toBe(1)
      expect(blockAtOffset(blocks, 500)?.blockIndex).toBe(2) // 超出末尾 → 最后一块
    })

    it('证据区间优先、置信度为 exact；只有卡片区间时为 weak', () => {
      expect(resolveAnchor(blocks, { evidence: { start: 150, end: 180 } })).toEqual({
        blockIndex: 1,
        confidence: 'exact'
      })
      expect(resolveAnchor(blocks, { excerpt: { start: 210, end: 260 } })).toEqual({
        blockIndex: 2,
        confidence: 'weak'
      })
      // 两者都有时用证据（更紧）
      expect(
        resolveAnchor(blocks, { evidence: { start: 10, end: 20 }, excerpt: { start: 210, end: 260 } })
      ).toEqual({ blockIndex: 0, confidence: 'exact' })
    })

    it('没有任何区间或没有块表时返回 null', () => {
      expect(resolveAnchor(blocks, {})).toBeNull()
      expect(resolveAnchor([], { evidence: { start: 1, end: 5 } })).toBeNull()
    })
  })

  describe('anchors: 生成期记录的字符区间（2026-10-05 P0-2）', () => {
    it('blockForRecordedRange 按区间落块，越界不猜', () => {
      expect(blockForRecordedRange(blocks, 0)?.blockIndex).toBe(0)
      expect(blockForRecordedRange(blocks, 99)?.blockIndex).toBe(0)
      expect(blockForRecordedRange(blocks, 100)?.blockIndex).toBe(1)
      expect(blockForRecordedRange(blocks, 299)?.blockIndex).toBe(2)
      // 区间右端点落在最后一块末尾 → 归最后一块；再往外就是"正文与块表对不上"→ 不猜
      expect(blockForRecordedRange(blocks, 300)?.blockIndex).toBe(2)
      expect(blockForRecordedRange(blocks, 301)).toBeNull()
      expect(blockForRecordedRange([], 0)).toBeNull()
    })

    it('sentenceRanges 给出每句在原文里的真实区间（跳过句首空白，不吞下一句）', () => {
      const text = '甲甲甲。 乙乙乙。丙丙丙'
      const rs = sentenceRanges(text, 0, text.length)
      expect(rs.map((r) => r.text)).toEqual(['甲甲甲。', '乙乙乙。', '丙丙丙'])
      // 区间取回原文必须与句子逐字一致（含"跳过句首空白"这一条）
      for (const r of rs) expect(text.slice(r.start, r.end)).toBe(r.text)
      expect(rs[1].start).toBe(text.indexOf('乙乙乙'))
      // 从中间起算（模拟超长段落折分）时偏移正确
      const half = sentenceRanges(text, 4, text.length)
      expect(half[0].text).toBe('乙乙乙。')
      expect(half[0].start).toBe(text.indexOf('乙乙乙'))
    })

    it('rangeOfRecordedText 把逐字文字换算成区间；找不到就 null（不猜）', () => {
      const text = '前言与凡例。某区新增高中一所，招生 300 人。后记。'
      const r = rangeOfRecordedText(text, undefined, '某区新增高中一所，招生 300 人。')
      expect(r).not.toBeNull()
      expect(text.slice(r!.start, r!.end)).toBe('某区新增高中一所，招生 300 人。')
      // 证据优先于段落正文（更紧）
      expect(rangeOfRecordedText(text, '招生 300 人', '某区新增高中一所')).toEqual({ start: text.indexOf('招生'), end: text.indexOf('招生') + '招生 300 人'.length })
      expect(rangeOfRecordedText(text, undefined, '来源里根本没有的一段')).toBeNull()
    })
  })
}
