/**
 * Phase 9 / S3：生成期的**块号锚点**纯逻辑（无 IO、无数据库）。
 *
 * 做法：把来源正文按 S2 的块表切成"带块号的文本"送模型（`〖S3-B07〗正文…`），
 * 要求每张资料卡片回报它取自哪些块。这样模型**不必逐字复现原文**——它只需指认自己读了哪一块，
 * 因此卡片被改写/整合后依然能定位（这正是"全文检索"路线走不通的原因）。
 *
 * 本地不信任模型：块号必须落在**本次输入允许集合**内，否则丢弃并计入 invalid；
 * 再用该卡自己的证据引文与所引块做交叉校验：引文落在块内 → `exact`，落不进 → `weak`（界面标"位置存疑"）。
 */

import type { BlockRange } from './page-map'

export interface NumberedBlocks {
  /** 送模型的文本（每块前面带 `〖S<来源号>-B<块号>〗`） */
  text: string
  /** 本次输入允许的块号标签集合（用于校验模型回报） */
  allowed: Set<string>
}

export interface ParsedAnchor {
  label: string
  sourceOrdinal: number
  blockIndex: number
}

const LABEL_RE = /S(\d+)\s*[-–—_]?\s*B(\d+)/gi

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 块号标签：`S<来源在本汇编中的编号>-B<块号>`（块号用块表里的 0 起下标，显示两位） */
export function blockLabel(sourceOrdinal: number, blockIndex: number): string {
  return `S${sourceOrdinal}-B${pad2(blockIndex)}`
}

/**
 * 给一份来源正文加块号标注。
 * `blocks` 必须是**同一份正文**的连续块（S2 的 `splitIntoBlocks`/`assignPages` 产出）。
 */
export function renderNumberedBlocks(
  sourceOrdinal: number,
  text: string,
  blocks: BlockRange[]
): NumberedBlocks {
  const allowed = new Set<string>()
  const parts: string[] = []
  for (const b of blocks) {
    const label = blockLabel(sourceOrdinal, b.blockIndex)
    allowed.add(label)
    parts.push(`〖${label}〗${text.slice(b.start, b.end)}`)
  }
  return { text: parts.join('\n'), allowed }
}

/**
 * 解析模型回报的块号（容忍大小写、空格、全角破折号、以及 `S3B7` 这类省略写法），
 * 并用 `allowed` 校验：合法的进 `refs`，不合法的进 `invalid`（调用方据此丢弃该锚或记诊断日志）。
 */
export function parseAnchorLabels(
  raw: unknown,
  allowed: Set<string>
): { refs: ParsedAnchor[]; invalid: string[] } {
  const refs: ParsedAnchor[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  const texts: string[] = []
  if (typeof raw === 'string') texts.push(raw)
  else if (Array.isArray(raw)) for (const v of raw) if (typeof v === 'string') texts.push(v)
  else if (raw && typeof raw === 'object') {
    // 容忍 {"blocks": [...]} / {"anchor": "S3-B07"} 这类包装
    const obj = raw as Record<string, unknown>
    for (const key of ['blocks', 'block', 'anchor', 'anchors', 'source']) {
      const v = obj[key]
      if (typeof v === 'string') texts.push(v)
      else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') texts.push(x)
    }
  }

  for (const t of texts) {
    LABEL_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LABEL_RE.exec(t)) !== null) {
      const sourceOrdinal = Number(m[1])
      const blockIndex = Number(m[2])
      const label = blockLabel(sourceOrdinal, blockIndex)
      if (seen.has(label)) continue
      seen.add(label)
      if (allowed.has(label)) refs.push({ label, sourceOrdinal, blockIndex })
      else invalid.push(label)
    }
  }
  return { refs, invalid }
}

/**
 * 引文是否落在本块内（去空白比对：卡片引文与原文常只差空白/换行）。
 * 用途：把"仅块号合法"升级为"引文确实在这个块里"的高置信锚点。
 */
export function evidenceHitsBlock(evidence: string, blockText: string): boolean {
  const needle = (evidence ?? '').replace(/\s+/g, '')
  if (needle.length < 4) return false // 太短不作为依据（与 S1 的"引文不足 4 字不发锚"同口径）
  const hay = (blockText ?? '').replace(/\s+/g, '')
  return hay.includes(needle)
}

/* ------------------------------ 单测 ------------------------------ */

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  const text = '甲甲甲甲。乙乙乙乙。丙丙丙丙。'
  const blocks: BlockRange[] = [
    { blockIndex: 0, start: 0, end: 5, page: 3 },
    { blockIndex: 1, start: 5, end: 10, page: 4 }
  ]

  describe('anchors: renderNumberedBlocks', () => {
    it('每块都带块号标注，且允许集合与之一致', () => {
      const { text: numbered, allowed } = renderNumberedBlocks(3, text, blocks)
      expect(numbered).toBe('〖S3-B00〗甲甲甲甲。\n〖S3-B01〗乙乙乙乙。')
      expect([...allowed]).toEqual(['S3-B00', 'S3-B01'])
    })
  })

  describe('anchors: parseAnchorLabels', () => {
    it('容忍大小写/空格/省略写法，并只接受本次输入内的块号', () => {
      const allowed = new Set(['S3-B00', 'S3-B01'])
      const { refs, invalid } = parseAnchorLabels('取自 s3-b0 与 S3B01，另外 S9-B99 不存在', allowed)
      expect(refs.map((r) => r.label)).toEqual(['S3-B00', 'S3-B01'])
      expect(invalid).toEqual(['S9-B99'])
    })

    it('容忍数组与包装对象，并去重', () => {
      const allowed = new Set(['S1-B02'])
      const a = parseAnchorLabels(['S1-B02', 'S1-B02'], allowed)
      expect(a.refs).toHaveLength(1)
      const b = parseAnchorLabels({ blocks: ['S1-B02'] }, allowed)
      expect(b.refs).toHaveLength(1)
      expect(b.refs[0].blockIndex).toBe(2)
    })

    it('拿不到块号时返回空（调用方按"来源位置待定"处理）', () => {
      const { refs, invalid } = parseAnchorLabels(null, new Set(['S1-B00']))
      expect(refs).toEqual([])
      expect(invalid).toEqual([])
    })
  })

  describe('anchors: evidenceHitsBlock', () => {
    it('去空白比对；过短（<4 字）不作为依据', () => {
      expect(evidenceHitsBlock('甲 甲甲 甲。', '〖X〗甲甲甲甲。')).toBe(true)
      expect(evidenceHitsBlock('丙丙', '甲甲甲甲。')).toBe(false) // 太短
      expect(evidenceHitsBlock('乙乙乙乙。', '甲甲甲甲。')).toBe(false)
    })
  })
}
