/**
 * ref-text.ts —— 对话消息中的来源编号引用解析（Phase 3.7 Task 3.7.5）。
 * 主进程返回的回复文本中含 `#N` 来源引用（与 refs 编号对应），前端据此渲染为可点击链接。
 * 纯函数，可在 vitest 下测试。
 */

export type RefToken =
  | { type: 'text'; text: string }
  | { type: 'ref'; index: number; text: string }

/**
 * 把文本切分为"普通文本 / 来源引用"片段。
 * 仅当 `#N` 存在于 validIndices（即 refs 中存在该编号）时才视为引用，避免误伤 `【矛盾#N】` 等其它内容。
 */
export function splitRefTokens(content: string, validIndices: ReadonlySet<number>): RefToken[] {
  if (!content) return []
  const tokens: RefToken[] = []
  const re = /#(\d+)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const index = Number(m[1])
    if (!validIndices.has(index)) continue
    if (m.index > last) tokens.push({ type: 'text', text: content.slice(last, m.index) })
    tokens.push({ type: 'ref', index, text: m[0] })
    last = m.index + m[0].length
  }
  if (last < content.length) tokens.push({ type: 'text', text: content.slice(last) })
  return tokens.length > 0 ? tokens : [{ type: 'text', text: content }]
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('source ref token splitting (Phase 3.7.5)', () => {
    it('splits valid #N refs into ref tokens keeping surrounding text', () => {
      const tokens = splitRefTokens('- 来源 #1：《年度报告A》（第 1 段）\n- 来源 #2：《统计年鉴B》', new Set([1, 2]))
      expect(tokens).toEqual([
        { type: 'text', text: '- 来源 ' },
        { type: 'ref', index: 1, text: '#1' },
        { type: 'text', text: '：《年度报告A》（第 1 段）\n- 来源 ' },
        { type: 'ref', index: 2, text: '#2' },
        { type: 'text', text: '：《统计年鉴B》' }
      ])
    })

    it('keeps unknown refs as plain text (e.g. 【矛盾#N】)', () => {
      const tokens = splitRefTokens('正文提及【矛盾#3】，但 refs 没有 3 号', new Set([1]))
      expect(tokens).toEqual([{ type: 'text', text: '正文提及【矛盾#3】，但 refs 没有 3 号' }])
    })

    it('returns single text token for empty or no-ref content', () => {
      expect(splitRefTokens('', new Set([1]))).toEqual([])
      expect(splitRefTokens('没有任何引用', new Set([1]))).toEqual([{ type: 'text', text: '没有任何引用' }])
    })
  })
}
