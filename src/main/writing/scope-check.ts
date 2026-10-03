/**
 * scope-check.ts —— Phase 9 补充（2026-10-03，用户裁定「界面兜底」）：生成汇编后，
 * 把**疑似超出用户设定范围**的段落挑出来交人工复核。
 *
 * 为什么不做成"让大模型自动删"：要求里的范围（地域/层级）是语义判断，模型在检索、细读、整合
 * 各环节都可能漏（实测：一份 38 个来源的汇编里有 9 个省级/国家层面来源，全部进了汇编）。
 * 因此这里只做**确定性、可解释**的提示：
 *   某段（含其来源标题）命中"上级/全省/国家"词表，且通篇不含用户在要求里点名的本地地名全称或简称
 *   → 列为"疑似超出范围"，由用户自己判断。
 * 界面上的动作是**移出汇编**（`kept = false`）——不删数据、可撤销、导出与文档视图都按 `kept` 过滤，
 * 也避免删段落时级联删掉矛盾说法（`compilation_contradiction_variants.item_id` 是 ON DELETE CASCADE）。
 *
 * ⚠ 只做提示、不做判断：命中即列出，宁可多列（用户一眼就能否掉）也不漏；
 * 但**要求里既没点名本地地名、也没写"排除上级/全省"**时**一律不提示**——没有依据就别添噪声。
 */

/** 从要求里解析出的范围线索 */
export interface ScopeRequirement {
  /** 用户在要求里点名的本地地名（如「长乐区」）；空数组 = 没识别出来 */
  localities: string[]
  /** 要求里是否明确要排除上级/全省/国家层面的内容 */
  excludesHigherLevel: boolean
}

/** 上级/更高层级来源的标记词（只收"省 / 国家"两级；地级市层面口径不明，刻意不收） */
export const HIGHER_LEVEL_MARKERS = [
  '全省',
  '省内',
  '省级',
  '省属',
  '省政府',
  '省委',
  '省人大',
  '省政协',
  '省教育厅',
  '省教育',
  '福建省',
  '国务院',
  '教育部',
  '国家层面',
  '国家级',
  '全国',
  '中办',
  '国办'
]

/** 要求里出现这些说法 → 认为用户在设定"要什么/不要什么" */
const SCOPE_HINTS = [
  '不必纳入',
  '不用纳入',
  '不要纳入',
  '不纳入',
  '不必收录',
  '不要收录',
  '不必收集',
  '排除',
  '剔除',
  '只包含',
  '只写',
  '只收',
  '只要',
  '仅限',
  '限于',
  '范围',
  '注意'
]

/** 本地地名后缀 */
const LOCALITY_SUFFIX_RE = /(?:区|县|市|镇|乡|街道)/g
/**
 * 取地名时的"停用字"：这些字出现在后缀之前时，说明前面是**句子成分**而不是地名的一部分
 * （如「只能包含长乐区」里 长乐区 前面是「只能包含」）→ 回退取更短的候选。
 */
const STOP_CHARS = new Set('只仅要写收含容包是本的与该及和在于对把给从向为出入上下内外面量个种年月日范围注意内容资料汇编全部所有各个'.split(''))

/** 从一段文字里抽出本地地名（后缀锚定 + 向左取 2–3 字，遇停用字回退） */
function extractLocalities(text: string): string[] {
  const out: string[] = []
  LOCALITY_SUFFIX_RE.lastIndex = 0
  let m = LOCALITY_SUFFIX_RE.exec(text)
  while (m) {
    const at = m.index
    const suffix = m[0]
    const left = text.slice(Math.max(0, at - 3), at)
    let name = ''
    if (left.length >= 3 && !STOP_CHARS.has(left[0])) name = left.slice(-3)
    else if (left.length >= 2) name = left.slice(-2)
    if (name.length >= 2) out.push(name + suffix)
    m = LOCALITY_SUFFIX_RE.exec(text)
  }
  return [...new Set(out)]
}

/** 从撰写要求里解析范围线索 */
export function parseScopeRequirement(requirement: string): ScopeRequirement {
  const text = requirement ?? ''
  const localities = extractLocalities(text)
  const hasHint = SCOPE_HINTS.some((h) => text.includes(h))
  const hasHigher = HIGHER_LEVEL_MARKERS.some((w) => text.includes(w)) || text.includes('全省') || text.includes('省一级')
  return { localities, excludesHigherLevel: hasHint && hasHigher }
}

export interface ScopeFlagItem {
  id: string
  /** 文档内顺序（0 起） */
  position: number
  text: string
  sourceTitle?: string
  /** 命中的上级/全省/国家标记词 */
  markers: string[]
}

export interface ScopeCheckResult {
  /** 疑似超出范围的段落（按文档顺序） */
  flagged: ScopeFlagItem[]
  /** 被检查的有效段落数 */
  checked: number
  /** 解析出的范围线索（界面据此说明"按什么在查"） */
  scope: ScopeRequirement
  /** false = 要求里没有可依据的范围线索 → 本次不做提示（界面如实说明） */
  available: boolean
}

/**
 * 逐段检查：命中上级标记词、且通篇没提到要求点名的本地地名（全称或简称）→ 列为疑似。
 * 没有范围线索时 `available: false` 且 `flagged` 为空。
 */
export function flagOutOfScope(
  items: { id: string; position: number; text: string; sourceTitle?: string }[],
  requirement: string
): ScopeCheckResult {
  const scope = parseScopeRequirement(requirement)
  const available = scope.localities.length > 0 || scope.excludesHigherLevel
  if (!available) return { flagged: [], checked: items.length, scope, available: false }

  const names = [...scope.localities, ...scope.localities.map((l) => l.replace(/(?:区|县|市|镇|乡|街道)$/, ''))].filter(
    (s) => s.length >= 2
  )
  const flagged: ScopeFlagItem[] = []
  for (const it of items) {
    const hay = (it.text ?? '') + '\n' + (it.sourceTitle ?? '')
    const hit = HIGHER_LEVEL_MARKERS.filter((w) => hay.includes(w))
    // 收敛重复前缀（省教育 / 省教育厅 同时命中时只留最长的那个，界面读起来才清楚）
    const markers = hit.filter((w) => !hit.some((other) => other !== w && other.includes(w)))
    if (markers.length === 0) continue
    // 该段自己提到了本地（全称或简称）→ 认为它记的是本地的事，不提示
    if (names.length > 0 && names.some((n) => hay.includes(n))) continue
    flagged.push({ id: it.id, position: it.position, text: it.text, sourceTitle: it.sourceTitle, markers })
  }
  return { flagged, checked: items.length, scope, available: true }
}

/* ------------------------------ 单测 ------------------------------ */

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('scope check (Phase 9 补充：界面兜底)', () => {
    it('解析要求里的本地地名与"排除上级"线索', () => {
      const s = parseScopeRequirement('标题为“高中学校设置”，注意，这只能包含长乐区的内容，哪些全省性的综述不必纳入资料汇编中')
      expect(s.localities).toContain('长乐区')
      expect(s.excludesHigherLevel).toBe(true)
      // 只写"只包含某地"、没说上级的 → 地名有、排除线索为 false（仍可用地名做检查）
      const s2 = parseScopeRequirement('标题为“高中学校设置”，只包含长乐区的内容')
      expect(s2.localities).toContain('长乐区')
      expect(s2.excludesHigherLevel).toBe(false)
    })

    it('没有范围线索时不做提示（不添噪声）', () => {
      const res = flagOutOfScope(
        [{ id: 'i1', position: 0, text: '全省普通高中招生政策解读。', sourceTitle: '福建省教育厅' }],
        '标题为“高中学校设置”，包括学校的新建、扩建、改建、合并、规模、招生人数、地理分布等等'
      )
      expect(res.available).toBe(false)
      expect(res.flagged).toHaveLength(0)
    })

    it('命中上级标记且通篇不提本地 → 列为疑似；提到本地（含简称）则不列', () => {
      const requirement = '只包含长乐区的内容，全省性的综述不必纳入'
      const res = flagOutOfScope(
        [
          { id: 'i1', position: 0, text: '全省普通高中招生录取 4 万人。', sourceTitle: '福建省教育厅通知' },
          // 简称命中（长乐一中）→ 不列
          { id: 'i2', position: 1, text: '福建省长乐第一中学是一所百年老校。', sourceTitle: '长乐年鉴2021.pdf' },
          // 全称命中 → 不列
          { id: 'i3', position: 2, text: '长乐区新增公办普高学位 800 个（全省合计 3 万个）。', sourceTitle: '福建部署招生工作' },
          { id: 'i4', position: 3, text: '长乐某校新建教学楼。', sourceTitle: '长乐年鉴2022.pdf' }
        ],
        requirement
      )
      expect(res.available).toBe(true)
      expect(res.flagged.map((f) => f.id)).toEqual(['i1'])
      expect(res.flagged[0].markers).toContain('全省')
    })

    it('命中词只留最长的那个（省教育 / 省教育厅 不重复列出）', () => {
      const res = flagOutOfScope(
        [{ id: 'i1', position: 0, text: '省教育厅印发通知，全面加强招生管理。', sourceTitle: '省教育厅通知' }],
        '只包含长乐区的内容'
      )
      expect(res.flagged[0].markers).toEqual(['省教育厅'])
    })

    it('来源标题命中上级标记同样算（正文没写省级也一样）', () => {
      const res = flagOutOfScope(
        [{ id: 'i9', position: 0, text: '今年招生入学工作这样做。', sourceTitle: '省教育厅通知：2020年中小学招生入学工作这样做' }],
        '只包含长乐区的内容'
      )
      expect(res.flagged.map((f) => f.id)).toEqual(['i9'])
      expect(res.checked).toBe(1)
    })
  })
}
