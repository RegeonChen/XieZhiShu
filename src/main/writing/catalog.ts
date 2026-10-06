/**
 * catalog.ts —— 资料库「目录」（2026-10-03 用户裁定：**完全依赖大模型自主决策**找资料）。
 *
 * 背景与取舍：整库正文在这个真实任务里是 **214.9 万字**（3 份年鉴 185 万字 + 300 篇网页 30 万字），
 * 装不进任何上下文；而**目录**很小（实测：303 条来源清单 ≈ 1.5 万字；全库小节标题 3642 个 ≈ 4.2 万字）。
 * 因此本方案**不做任何相似度/词法检索**——本地只负责把"目录"与"被模型选中的正文"准确搬给模型，
 * "看哪里"完全由大模型决定（见 `source-navigator.ts`）。
 *
 * 本文件只放纯函数（不碰数据库、不联网），便于单测与复算：**同一段正文切出的节 id 必须稳定**，
 * 因为第 2/3 轮里模型说的是"节 id"，第 4 轮要按同一规则取回正文。
 */
import { inferYearFromSource } from './compilation-document'

/** 单节最大字符（超过则按段落再切；节过大时模型读不动、提示词也放不下） */
export const SECTION_MAX_CHARS = 1200
/** 单个来源最多切多少节（防极端长文把目录撑爆） */
export const SECTION_MAX_COUNT = 1600

export interface CatalogSource {
  id: string
  title: string
  kind: 'file' | 'url'
  publishedAt?: string
  cleanedText: string
}

export interface CatalogSection {
  /** 来源内稳定的节序号（0 起） */
  index: number
  /** 小节标题（`【…】` 里的内容；无标题时用主题词/首句/"(开头)"） */
  title: string
  /** 该节正文（已按 `SECTION_MAX_CHARS` 切开时带 ①②… 后缀区分） */
  text: string
}

/**
 * 该来源的年份口径（年鉴 −1 惯例；网页用标题/发布时间里的年份）。
 *
 * 2026-10-05 用户裁定（P0-1 同期收口）：这里原来是**只看标题**的 `inferYearFromSourceTitle`，
 * 于是「福州新区年鉴（2025）」这类**网页**页面的年份也被减 1，与 `inferYearFromSource` 是同一个错年入口。
 * 现在统一走 `inferYearFromSource`（−1 只对本地年鉴类文件生效），使"生成汇编"与"导航问答"两条链路口径一致。
 */
export function sourceYearOf(source: CatalogSource): number | undefined {
  return inferYearFromSource({ title: source.title, kind: source.kind, publishedAt: source.publishedAt })?.year
}

function firstSentence(text: string, max = 24): string {
  const t = text.replace(/\s+/g, ' ').trim()
  const cut = t.split(/[。！？；;]/)[0] ?? t
  return cut.length > max ? cut.slice(0, max) + '…' : cut
}

/**
 * 把来源正文切成"节"：
 * - 有 `【…】` 标记（年鉴/年报的常见形态）→ 以标记为界切；
 * - 没有标记（多数网页）→ 按空行/换行切段，再把相邻短段合并到 ≤ `SECTION_MAX_CHARS`；
 * - 单节超过上限 → 继续按句读切成带 ①②… 后缀的子节（保证提示词与读取都放得下）。
 */
export function splitIntoSections(text: string): CatalogSection[] {
  const raw = String(text ?? '')
  if (!raw.trim()) return []
  const out: { title: string; text: string }[] = []
  const heads = [...raw.matchAll(/【([^】]{2,30})】/g)]
  /*
   * 走"标记切节"的条件：`【…】` ≥3 个（年鉴/年报的常态），或正文够长（≥800 字）时只要有 1 个标记。
   * 之所以不无条件用标记：短网页里 `【…】` 常是被引用的栏目标题（一份 300 篇网页的库里每篇恰好 2 个），
   * 此时按段落切更合理。
   */
  const useHeads = heads.length >= 3 || (heads.length >= 1 && raw.length >= 800)
  if (useHeads) {
    const first = heads[0].index ?? 0
    if (first > 0) out.push({ title: '（开头）', text: raw.slice(0, first).trim() })
    heads.forEach((h, i) => {
      const start = (h.index ?? 0) + h[0].length
      const end = i + 1 < heads.length ? heads[i + 1].index ?? raw.length : raw.length
      const title = h[1].trim()
      const body = raw.slice(start, end).trim()
      out.push({ title, text: ('【' + title + '】' + (body ? ' ' + body : '')).trim() })
    })
  } else {
    const paras = raw
      .split(/\n{2,}|\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean)
    let cur = ''
    const flush = (): void => {
      if (!cur.trim()) return
      out.push({ title: firstSentence(cur), text: cur.trim() })
      cur = ''
    }
    for (const p of paras) {
      if (cur.length + p.length + 1 > SECTION_MAX_CHARS) flush()
      cur = cur ? cur + '\n' + p : p
    }
    flush()
  }

  // 超长节再按句读切（带 ①②… 后缀），并截断到上限节数
  const sections: CatalogSection[] = []
  for (const s of out) {
    if (s.text.length <= SECTION_MAX_CHARS) {
      sections.push({ index: sections.length, title: s.title, text: s.text })
      continue
    }
    const sentences = s.text.split(/(?<=[。！？；!?;])/).map((x) => x.trim()).filter(Boolean)
    const parts: string[] = []
    let cur = ''
    for (const sen of sentences) {
      if (cur.length + sen.length > SECTION_MAX_CHARS && cur) {
        parts.push(cur)
        cur = ''
      }
      cur += sen
    }
    if (cur) parts.push(cur)
    const marks = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
    parts.forEach((p, i) => {
      sections.push({
        index: sections.length,
        title: s.title + (parts.length > 1 ? '（' + (marks[i] ?? String(i + 1)) + '）' : ''),
        text: p
      })
    })
    if (sections.length >= SECTION_MAX_COUNT) break
  }
  return sections.slice(0, SECTION_MAX_COUNT)
}

/** 来源清单（第 1 轮给模型"先挑资料"）：`[S3] 《标题》 年鉴 2022年 61.4万字 1040节` */
export function buildSourceCatalog(sources: CatalogSource[], sectionCounts?: Map<string, number>): string {
  return sources
    .map((s, i) => {
      const year = sourceYearOf(s)
      const kindLabel = s.kind === 'file' ? '文件' : '网页'
      const chars = s.cleanedText.length
      const n = sectionCounts?.get(s.id)
      return (
        '[S' + (i + 1) + '] 《' + s.title + '》 ' + kindLabel +
        (year ? ' ' + year + '年口径' : '') +
        ' ' + (chars >= 10000 ? (chars / 10000).toFixed(1) + '万字' : chars + '字') +
        (n != null ? ' ' + n + '节' : '')
      )
    })
    .join('\n')
}

/**
 * 单条小节清单行。**重名条目**（同一来源里标题重复 ≥ `repeatedMin` 次，实测年鉴里
 * "概况"重复 174 次、"城乡建设"12 次）单靠标题无法分辨，故补一小段**正文特征**（纯结构性规则，
 * 不是相关性筛选）：`931 概 况 2024年，长乐区普通高中有12所 225`。
 */
export function sectionCatalogLine(section: CatalogSection, titleCount: number, repeatedMin = 4, snippetChars = 12): string {
  const ambiguous = titleCount >= repeatedMin
  const snippet = ambiguous
    ? ' ' + section.text.replace(/^【[^】]*】\s*/, '').replace(/\s+/g, '').slice(0, snippetChars)
    : ''
  return section.index + ' ' + section.title + snippet + ' ' + section.text.length
}

/** 行 + 可引用 id（打包与整份清单共用同一渲染，保证预算计算一致） */
export function sectionCatalogLines(
  sourceRef: string,
  sections: CatalogSection[]
): { id: string; line: string }[] {
  const counts = new Map<string, number>()
  for (const s of sections) counts.set(s.title, (counts.get(s.title) ?? 0) + 1)
  return sections.map((s) => ({ id: sourceRef + '#' + s.index, line: sectionCatalogLine(s, counts.get(s.title) ?? 1) }))
}

/**
 * 小节清单（第 2/3 轮给模型"挑章节"）——**紧凑格式**，因为实测它直接决定轮次：
 * 三份年鉴共约 3300 个小节，早期格式（`[S1#1234] 【普通高中教育（①）】 1200字`，约 30 字/行）
 * 合计 9.2 万字 → 按 2.2 万字/轮要 3 批（超出"最多 4 轮"）。
 * 紧凑成「来源头一行 + `节号 标题 字数`」（重名条目带正文特征）后总量约 7.5 万字 → **2 批装下**。
 * 节 id 由提示词规定为 `S编号#节号`（来源头里给出 S 编号）。
 */
export function buildSectionCatalog(sourceRef: string, sourceTitle: string, sections: CatalogSection[]): string {
  const head = '【' + sourceRef + ' 《' + sourceTitle + '》小节清单】（格式：节号 标题 [正文特征] 字数；引用时写作 ' + sourceRef + '#节号）'
  return [head, ...sectionCatalogLines(sourceRef, sections).map((x) => x.line)].join('\n')
}

/** 按预算把清单切成若干批（第 2/3 轮各自 ≤ 预算），返回每批的来源下标 */
export function splitByBudget<T>(items: T[], sizeOf: (t: T) => number, maxChars: number): T[][] {
  const batches: T[][] = []
  let cur: T[] = []
  let used = 0
  for (const it of items) {
    const n = sizeOf(it)
    if (cur.length > 0 && used + n > maxChars) {
      batches.push(cur)
      cur = []
      used = 0
    }
    cur.push(it)
    used += n
  }
  if (cur.length > 0) batches.push(cur)
  return batches
}

/**
 * 按节的清单定位节（提示词里用 `S3#12` 这种 id）：越界/不存在返回 null。
 * 只做 id 解析，不做任何相关性判断——选择是模型给的。
 */
export function resolveSection(
  sourceRefToId: Map<string, string>,
  id: string,
  sectionsBySourceId: Map<string, CatalogSection[]>
): { sourceId: string; section: CatalogSection } | null {
  const m = /^(S\d+)#(\d+)$/.exec(String(id ?? '').trim())
  if (!m) return null
  const sourceId = sourceRefToId.get(m[1])
  if (!sourceId) return null
  const section = sectionsBySourceId.get(sourceId)?.[Number(m[2])]
  if (!section) return null
  return { sourceId, section }
}

/* ------------------------------ 单测 ------------------------------ */

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('source catalog (大模型自主导航的目录层)', () => {
    it('有【…】标记时按标记切节，标记前的内容单列"(开头)"', () => {
      const pad = '（补充说明：本节用于测试，正文足够长以走"标记切节"分支。）'.repeat(30)
      const text = '卷首语若干。' + pad + '\n【概况】2022 年，全区有普通中学 28 所。\n【普通高中教育】2022 年，招生 4123 人。'
      const s = splitIntoSections(text)
      expect(s.map((x) => x.title)).toEqual(['（开头）', '概况', '普通高中教育'])
      expect(s[1].text).toContain('【概况】')
      expect(s[1].text).toContain('普通中学 28 所')
      expect(s[2].text).toContain('4123 人')
    })

    it('没有标记时按段落合并成 ≤1200 字的节，标题取首句', () => {
      const text = Array.from({ length: 200 }, (_, i) => `第${i + 1}段内容，用于测试切节逻辑是否按段落合并。`).join('\n')
      const s = splitIntoSections(text)
      expect(s.length).toBeGreaterThan(1)
      expect(s.every((x) => x.text.length <= 1200)).toBe(true)
      expect(s[0].title).toContain('第1段内容')
    })

    it('超长单节继续按句读切开，标题带 ①②… 后缀', () => {
      const one = '【长节】' + '这是一句很长的正文内容。'.repeat(200)
      const s = splitIntoSections(one)
      expect(s.length).toBeGreaterThan(1)
      expect(s[0].title).toBe('长节（①）')
      expect(s[1].title).toBe('长节（②）')
      expect(s.every((x) => x.text.length <= 1200)).toBe(true)
    })

    it('来源清单带类型/年份口径/字号/节数；年鉴年份走 −1 惯例', () => {
      const cat = buildSourceCatalog(
        [
          { id: 'a', title: '长乐年鉴2023（完整版）.pdf', kind: 'file', cleanedText: 'x'.repeat(614116) },
          { id: 'b', title: '长乐新添一所普通高中！将于9月开学！', kind: 'url', publishedAt: '2022-08-30', cleanedText: 'y'.repeat(1022) }
        ],
        new Map([['a', 1040]])
      )
      expect(cat).toContain('[S1] 《长乐年鉴2023（完整版）.pdf》 文件 2022年口径 61.4万字 1040节')
      expect(cat).toContain('[S2] 《长乐新添一所普通高中！将于9月开学！》 网页 2022年口径 1022字')
    })

    it('按预算分批（第 2/3 轮各自不超预算）与节 id 解析', () => {
      const batches = splitByBudget([{ n: 10 }, { n: 10 }, { n: 10 }], (x) => x.n, 25)
      expect(batches.map((b) => b.length)).toEqual([2, 1])
      // 小节清单是紧凑格式（来源头 + `节号 标题 字数`），且带引用格式说明
      const terse = buildSectionCatalog('S1', '长乐年鉴2023（完整版）.pdf', splitIntoSections('补充正文。'.repeat(200) + '\n【概况】甲。\n【普通高中教育】乙。'))
      expect(terse.split('\n')[0]).toContain('【S1 《长乐年鉴2023（完整版）.pdf》小节清单】')
      expect(terse).toContain('S1#节号')
      expect(terse).toMatch(/\n2 普通高中教育 \d+/)
      const refs = new Map([['S3', 'src-3']])
      const body = '补充正文。'.repeat(200) + '\n【概况】甲。\n【普通高中教育】乙。'
      const sections = new Map([['src-3', splitIntoSections(body)]])
      // 节 0 = （开头）的长正文，节 1 = 概况，节 2 = 普通高中教育
      expect(resolveSection(refs, 'S3#2', sections)?.section.title).toBe('普通高中教育')
      expect(resolveSection(refs, 'S3#9', sections)).toBeNull()
      expect(resolveSection(refs, 'S9#0', sections)).toBeNull()
      expect(resolveSection(refs, '乱写的', sections)).toBeNull()
    })
  })
}
