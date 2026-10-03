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
}
