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

import type { BlockRange } from './page-map'

/**
 * 引文是否落在本块内（去空白比对：卡片引文与原文常只差空白/换行）。
 * 用途：把锚点的 `confidence` 定为 `exact`（引文确实在这一块里）或 `weak`（只有卡片区间可用）。
 */
export function evidenceHitsBlock(evidence: string, blockText: string): boolean {
  const needle = (evidence ?? '').replace(/\s+/g, '')
  if (needle.length < 4) return false // 太短不作为依据（与 S1 的"引文不足 4 字不发锚"同口径）
  const hay = (blockText ?? '').replace(/\s+/g, '')
  return hay.includes(needle)
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
 * 由"证据区间 / 卡片区间"定出锚点：**优先用证据**（更紧、且是逐字校验过的），
 * 卡片区间兜底。返回块号与置信度；都没有可用区间时返回 null（调用方按"来源位置待定"处理）。
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

  describe('anchors: evidenceHitsBlock', () => {
    it('去空白比对；过短（<4 字）不作为依据', () => {
      expect(evidenceHitsBlock('甲 甲甲 甲。', '〖X〗甲甲甲甲。')).toBe(true)
      expect(evidenceHitsBlock('丙丙', '甲甲甲甲。')).toBe(false) // 太短
      expect(evidenceHitsBlock('乙乙乙乙。', '甲甲甲甲。')).toBe(false)
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
