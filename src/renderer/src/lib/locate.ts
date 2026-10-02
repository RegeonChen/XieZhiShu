/**
 * locate.ts —— 「文内搜索定位」的纯逻辑（Phase 8 / S1）。
 *
 * 目标：拿到一段**引文**（段落的 `evidence`、矛盾说法文本等），在来源正文里找到它，
 * 好让分栏查看器滚动到该处并高亮。三件事必须做对：
 * ① **去空白归一化**——解析出来的正文里充满排版空格/换行（PDF、Word 抽文尤甚），
 *    引文里却没有；沿用本项目 `locateVerbatim` 的口径（去掉所有空白再比）。
 *    因此还需要一张"归一化下标 → 原文下标"的映射表，才能回到 DOM 里定位。
 * ② **候选检索词由长到短**——引文可能跨了标签或中间夹了别的字符，整段找不到时
 *    逐级截短重试（40 → 24 → 12 字），比"一次不中就放弃"稳得多。
 * ③ **先在字符串层定位到"哪一块"**——docx/大文本是分批进 DOM 的，必须先把命中所在的
 *    那一块渲染出来，才谈得上在 DOM 里高亮（否则"未找到"是假的）。
 *
 * 放在 .ts 而不是组件里：本项目的内联单测只覆盖 `src/**\/*.ts`。
 */

/** 归一化时忽略的字符：所有空白 + 零宽字符/BOM（解析器有时会带进来） */
const IGNORED = /[\s\u200b-\u200d\ufeff]/

/** 候选检索词的最小长度：太短的词（如「教育」）会到处命中，定位就没意义了 */
export const MIN_NEEDLE_CHARS = 4

/** 归一化（去空白）并给出"归一化下标 → 原文下标"的映射 */
export function normalizeWithMap(text: string): { normalized: string; map: number[] } {
  const chars: string[] = []
  const map: number[] = []
  const src = text ?? ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (IGNORED.test(ch)) continue
    chars.push(ch)
    map.push(i)
  }
  return { normalized: chars.join(''), map }
}

/** 纯归一化（去空白），等价于 `locateVerbatim` 的比较口径 */
export function normalizeText(text: string): string {
  return normalizeWithMap(text).normalized
}

/**
 * 把引文变成候选检索词：去空白后不足 `MIN_NEEDLE_CHARS` 返回空数组（**宁可不定位，也不乱定位**）。
 * 整段匹配不上时不需要在这里预先切短——`findNeedle` 会二分找"最长能匹配的前缀"，
 * 比固定档位（40/24/12）精度更高。
 */
export function buildNeedles(snippet: string, maxChars = 0): string[] {
  const n = normalizeText(snippet)
  if (n.length < MIN_NEEDLE_CHARS) return []
  return [maxChars > 0 ? n.slice(0, maxChars) : n]
}

/** 去掉 HTML 标签并解码常见实体（用于把 docx 的 HTML 块当纯文本检索） */
export function stripTags(html: string): string {
  let out = ''
  const src = html ?? ''
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      out += src.slice(i)
      break
    }
    out += src.slice(i, lt)
    let j = lt + 1
    let quote: string | null = null
    while (j < src.length) {
      const ch = src[j]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      j += 1
    }
    i = j + 1
  }
  return out
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

/**
 * 在归一化文本里找命中：先试整段；整段找不到（引文里夹了原文没有的字、或跨了标签）时，
 * **二分找出"最长且确实出现"的前缀**（≥ `MIN_NEEDLE_CHARS`）作为退让。
 * 返回的是**归一化坐标**——调用方用 `toOriginalRange` 还原回原文坐标。
 *
 * 为什么是"最长匹配前缀"而不是固定档位：档位会在 24 与 12 之间一步退太多，
 * 而前缀命中具有单调性（L 命中则 L-1 必命中），二分既准又快。
 */
export function findNeedle(
  normalizedHaystack: string,
  needles: string[]
): { start: number; end: number; needle: string } | null {
  if (!normalizedHaystack) return null
  for (const needle of needles) {
    if (needle.length < MIN_NEEDLE_CHARS) continue
    const exact = normalizedHaystack.indexOf(needle)
    if (exact >= 0) return { start: exact, end: exact + needle.length, needle }
    // 二分：找最大的 L，使 needle.slice(0, L) 出现在正文里
    let ok = 0
    let lo = MIN_NEEDLE_CHARS
    let hi = needle.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (normalizedHaystack.includes(needle.slice(0, mid))) {
        ok = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (ok >= MIN_NEEDLE_CHARS) {
      const cut = needle.slice(0, ok)
      const at = normalizedHaystack.indexOf(cut)
      if (at >= 0) return { start: at, end: at + cut.length, needle: cut }
    }
  }
  return null
}

export interface BlockHit {
  /** 命中所在块的下标（用于先渲染出这一块） */
  blockIndex: number
  /** 该块归一化文本内的命中区间 */
  start: number
  end: number
  needle: string
  /** 该块的归一化映射表（块内归一化下标 → 块原文下标） */
  map: number[]
  /** 该块的归一化文本 */
  normalized: string
}

/**
 * 在若干"块"里定位检索词（块 = docx 的顶层 HTML 块、或纯文本的行批）。
 * 逐块检索：引文通常落在同一段内，逐块比"跨块拼接"更稳，也更容易把那一块先渲染出来。
 * 命中不了返回 null（调用方必须如实提示"未找到"，不得假装定位成功）。
 */
export function locateInBlocks(
  blocks: string[],
  needles: string[],
  options: { html?: boolean } = {}
): BlockHit | null {
  if (needles.length === 0) return null
  for (let i = 0; i < blocks.length; i++) {
    const raw = options.html ? stripTags(blocks[i]) : blocks[i]
    const { normalized, map } = normalizeWithMap(raw)
    const hit = findNeedle(normalized, needles)
    if (hit) return { blockIndex: i, start: hit.start, end: hit.end, needle: hit.needle, map, normalized }
  }
  return null
}

/**
 * 把"归一化坐标"还原成"原文坐标"（DOM 定位要用）。
 * `map` 来自 `normalizeWithMap`；区间为空或越界时返回 null。
 */
export function toOriginalRange(map: number[], start: number, end: number): { start: number; end: number } | null {
  if (start < 0 || end <= start || start >= map.length) return null
  const lastIndex = Math.min(end, map.length) - 1
  return { start: map[start], end: map[lastIndex] + 1 }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('in-document locating helpers (Phase 8 / S1)', () => {
    it('normalizes away layout whitespace and keeps a back-map to the original offsets', () => {
      const text = '全区\n普通  中学 30 所。'
      const { normalized, map } = normalizeWithMap(text)
      expect(normalized).toBe('全区普通中学30所。')
      // 映射表必须能把归一化下标还原成原文下标（否则 DOM 高亮会偏位）
      for (let i = 0; i < normalized.length; i++) {
        expect(text[map[i]]).toBe(normalized[i])
      }
    })

    it('builds a single usable needle and refuses needles that are too short to be meaningful', () => {
      const needles = buildNeedles('全区普通中学 30 所，其中独立高中 1 所。')
      expect(needles).toEqual(['全区普通中学30所，其中独立高中1所。'])
      // 太短 → 不生成任何候选（宁可不定位，也不乱定位）
      expect(buildNeedles('教育')).toEqual([])
      expect(buildNeedles('  ')).toEqual([])
      // 调用方可以主动限制长度
      expect(buildNeedles('全区普通中学 30 所，其中独立高中 1 所。', 12)).toEqual(['全区普通中学30所，其中'])
    })

    it('falls back to the LONGEST matching prefix when the full quote cannot be matched', () => {
      // 原文在句子中间插了引文没有的「【注】」，整段找不到 → 退到"最长能匹配的前缀"（而非固定档位）
      const normalized = normalizeText('2018年，全区普通中学30所【注】，在校生2万人。')
      const needles = buildNeedles('2018年，全区普通中学30所，在校生2万人。')
      const hit = findNeedle(normalized, needles)
      expect(hit).not.toBeNull()
      // 退让到「…30所」为止就停下（而不是一路退到 12 字的「2018年，全区普通中学」）
      expect(hit?.needle).toBe('2018年，全区普通中学30所')
      expect(hit?.needle.length).toBeGreaterThan(12)
      // 完全找不到 → null（调用方必须如实提示，不得假装成功）
      expect(findNeedle(normalized, buildNeedles('这段话原文里根本没有出现过'))).toBeNull()
    })

    it('locates the block that holds the quote (so batching can reveal it first)', () => {
      const blocks = ['<h1>标题</h1>', '<p>第一段：全区幼儿园 212 所。</p>', '<p>第二段：全区普通中学 30 所。</p>']
      const hit = locateInBlocks(blocks, buildNeedles('全区普通中学 30 所'), { html: true })
      expect(hit?.blockIndex).toBe(2)
      expect(hit?.needle).toBe('全区普通中学30所')
      // 找不到时如实返回 null
      expect(locateInBlocks(blocks, buildNeedles('这段原文里根本没有'), { html: true })).toBeNull()
    })

    it('strips tags with quoted ">" and decodes entities before matching', () => {
      expect(stripTags('<p title="a > b">x &amp; y</p>')).toBe('x & y')
      const blocks = ['<p>长乐&nbsp;一中&nbsp;新建教学楼</p>']
      const hit = locateInBlocks(blocks, buildNeedles('长乐 一中 新建教学楼'), { html: true })
      expect(hit).not.toBeNull()
      expect(hit?.start).toBe(0)
    })

    it('maps a normalized hit back to original offsets inside the block', () => {
      const raw = '前 缀 全区 普通中学 30 所'
      const { normalized, map } = normalizeWithMap(raw)
      const hit = findNeedle(normalized, buildNeedles('全区普通中学30所'))
      expect(hit).not.toBeNull()
      const range = toOriginalRange(map, hit!.start, hit!.end)
      expect(range).not.toBeNull()
      expect(raw.slice(range!.start, range!.end)).toBe('全区 普通中学 30 所')
      expect(toOriginalRange(map, 0, 0)).toBeNull()
    })
  })
}
