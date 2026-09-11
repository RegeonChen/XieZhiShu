/**
 * compilation-diff.ts —— 版本差异计算（Phase 7.4，2026-09-10）。
 *
 * 两级 diff（调研结论）：
 * ① **段落级结构 diff**：以段 id 为主键比对两版段落，得出 新增 / 删除 / 修改；
 * ② **段内字符级 diff**：只对"修改"的段落跑 LCS 字符级比对——中文散文没有分词假设，字符级最保真。
 * 不引入第三方 diff 库：段落数在数百量级、段落长度在数百字量级，本地 LCS 足够快且无依赖。
 */
import type { CompilationParagraph } from '../../shared/types'

export interface InlineDiffPart {
  type: 'same' | 'add' | 'del'
  text: string
}

export type ParagraphDiffKind = 'added' | 'removed' | 'modified' | 'unchanged'

/** 一段在两版之间的差异（`id` 稳定，故用 id 对齐） */
export interface ParagraphDiffSegment {
  kind: ParagraphDiffKind
  id: string
  /** 旧版文本（added 时缺省） */
  prevText?: string
  /** 新版文本（removed 时缺省） */
  nextText?: string
  /** 仅 modified：段内字符级差异 */
  inline?: InlineDiffPart[]
  /**
   * 仅 removed：该段在被删除前位于**哪个当前段落之前**（渲染时据此把它插回原位，而不是堆在文末）；
   * 缺省表示它原本在整篇最后。
   */
  beforeId?: string
}

export interface ParagraphDiffSummary {
  added: number
  removed: number
  modified: number
  unchanged: number
}

/** 段内字符级 diff 的规模上限（LCS 为 O(n×m)；超限则退化为"整段替换"，避免长段落卡住界面） */
const INLINE_DIFF_MAX_CELLS = 400000

/**
 * 段内字符级差异（LCS，按 code point 处理，中文安全）。
 * 返回按顺序排列的 same/add/del 片段；规模超限时退化为 del(旧)+add(新)。
 */
export function diffParagraphTexts(prevText: string, nextText: string): InlineDiffPart[] {
  const a = Array.from(prevText)
  const b = Array.from(nextText)
  if (a.length * b.length > INLINE_DIFF_MAX_CELLS) {
    return [
      { type: 'del', text: prevText },
      { type: 'add', text: nextText }
    ]
  }
  const n = a.length
  const m = b.length
  // LCS 长度表（滚动一维即可回溯方向时用二维，段落级规模可接受）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const parts: InlineDiffPart[] = []
  const push = (type: InlineDiffPart['type'], ch: string): void => {
    const last = parts[parts.length - 1]
    if (last && last.type === type) last.text += ch
    else parts.push({ type, text: ch })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('same', a[i])
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', a[i])
      i += 1
    } else {
      push('add', b[j])
      j += 1
    }
  }
  while (i < n) push('del', a[i++])
  while (j < m) push('add', b[j++])
  return parts
}

/**
 * 段落级结构 diff（纯函数，可测试）：按 `id` 对齐两版段落。
 * 新出现 → added；旧版有而新版没有 → removed；同 id 但文本不同 → modified；文本相同 → unchanged。
 * 被删除的段落带 `beforeId`（它在旧版里紧邻其后的那个**仍然存在**的段落），
 * 使界面能把它插回**原位**展示，而不是一股脑堆在文末（用户 2026-09-10 要求）。
 */
export function diffParagraphVersions(
  prev: CompilationParagraph[],
  next: CompilationParagraph[]
): ParagraphDiffSegment[] {
  const prevById = new Map(prev.map((p) => [p.id, p]))
  const nextIds = new Set(next.map((p) => p.id))
  // ① 计算每个被删除段落的 beforeId：在旧版顺序里，向后找第一个"新版仍存在"的段落
  const beforeIdOf = new Map<string, string | undefined>()
  for (let i = 0; i < prev.length; i++) {
    if (nextIds.has(prev[i].id)) continue
    let anchor: string | undefined
    for (let j = i + 1; j < prev.length; j++) {
      if (nextIds.has(prev[j].id)) {
        anchor = prev[j].id
        break
      }
    }
    beforeIdOf.set(prev[i].id, anchor)
  }
  const segments: ParagraphDiffSegment[] = []
  for (const p of prev) {
    if (!nextIds.has(p.id)) segments.push({ kind: 'removed', id: p.id, prevText: p.text, beforeId: beforeIdOf.get(p.id) })
  }
  for (const p of next) {
    const before = prevById.get(p.id)
    if (!before) {
      segments.push({ kind: 'added', id: p.id, nextText: p.text })
      continue
    }
    if (before.text !== p.text) {
      segments.push({ kind: 'modified', id: p.id, prevText: before.text, nextText: p.text, inline: diffParagraphTexts(before.text, p.text) })
      continue
    }
    segments.push({ kind: 'unchanged', id: p.id, prevText: before.text, nextText: p.text })
  }
  return segments
}

export function summarizeParagraphDiff(segments: ParagraphDiffSegment[]): ParagraphDiffSummary {
  const summary: ParagraphDiffSummary = { added: 0, removed: 0, modified: 0, unchanged: 0 }
  for (const s of segments) summary[s.kind] += 1
  return summary
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  const para = (id: string, text: string, ordinal = 0): CompilationParagraph => ({
    id,
    ordinal,
    text,
    timeConfidence: 'exact',
    kind: 'paragraph',
    revision: 1,
    origin: 'generate',
    kept: true
  })

  describe('compilation diff (Phase 7.4 版本差异)', () => {
    it('computes a character-level inline diff for Chinese prose', () => {
      const parts = diffParagraphTexts('2018 年全区普通中学 30 所。', '2018 年全区普通中学 32 所。')
      expect(parts.map((p) => p.type)).toEqual(['same', 'del', 'add', 'same'])
      expect(parts.find((p) => p.type === 'del')!.text).toBe('0')
      expect(parts.find((p) => p.type === 'add')!.text).toBe('2')
      expect(parts.map((p) => p.text).join('').length).toBeGreaterThan(0)
      // 完全相同 → 单一 same
      expect(diffParagraphTexts('甲', '甲')).toEqual([{ type: 'same', text: '甲' }])
    })

    it('classifies added / removed / modified / unchanged by paragraph id', () => {
      const prev = [para('p1', '甲'), para('p2', '乙'), para('p3', '丙')]
      const next = [para('p1', '甲'), para('p3', '丙改'), para('p4', '丁')]
      const segs = diffParagraphVersions(prev, next)
      const summary = summarizeParagraphDiff(segs)
      expect(summary).toEqual({ added: 1, removed: 1, modified: 1, unchanged: 1 })
      expect(segs.find((s) => s.kind === 'removed')!.id).toBe('p2')
      // 被删除的段落带 beforeId（它旧版里后面第一个仍存在的段落）→ 界面据此插回原位，而不是堆到文末
      expect(segs.find((s) => s.kind === 'removed')!.beforeId).toBe('p3')
      // 删掉的是最后一段时 → beforeId 缺省（原本就在最后）
      const tailRemoved = diffParagraphVersions([para('q1', '甲'), para('q2', '乙')], [para('q1', '甲')])
      expect(tailRemoved.find((s) => s.kind === 'removed')!.beforeId).toBeUndefined()
      expect(segs.find((s) => s.kind === 'added')!.id).toBe('p4')
      const modified = segs.find((s) => s.kind === 'modified')!
      expect(modified.prevText).toBe('丙')
      expect(modified.nextText).toBe('丙改')
      expect(modified.inline!.some((p) => p.type === 'add' && p.text.includes('改'))).toBe(true)
      // 顺序以新版为主：unchanged 保留、removed 单独列出
      expect(segs.filter((s) => s.kind !== 'removed').map((s) => s.id)).toEqual(['p1', 'p3', 'p4'])
    })

    it('degrades to whole-paragraph replace when the inline diff would be too large', () => {
      const long = '甲'.repeat(700)
      const parts = diffParagraphTexts(long, long + '乙')
      expect(parts).toEqual([
        { type: 'del', text: long },
        { type: 'add', text: long + '乙' }
      ])
    })
  })
}
