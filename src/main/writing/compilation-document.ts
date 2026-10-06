/**
 * compilation-document.ts —— 资料汇编「连续文档」模型的纯函数（Phase 7.1，2026-09-10）。
 *
 * 资料汇编由「资料卡片列表」改为「一篇连续文档」：每段**段首注明时间（须含年份）**、**段尾带来源编号圆标**。
 * 本模块只放**无副作用、可单测**的规则与转换，供仓储层、生成管线与渲染层共用：
 * - 时间标签解析（结构化 year/month/day + 可信度）——排序不再靠正则现抽年份；
 * - 文档 markdown 渲染（**一段一行**，段内换行转空格，使"行级 diff ≈ 段落级 diff"）；
 * - 段落快照与版本变更统计（版本历史与差异高亮的共同基线）。
 *
 * 约定：段首时间**不写进段落正文**（正文里重复写时间会在编辑时被改坏），
 * 而是渲染时由 `timeLabel` 单独呈现；markdown 快照里为可读性把时间写在行首。
 */
import type {
  CompilationChangeSummary,
  CompilationItem,
  CompilationParagraph,
  CompilationParagraphKind,
  CompilationParagraphOrigin,
  CompilationSourceRef,
  CompilationTimeConfidence
} from '../../shared/types'

/** 时间标签解析结果 */
export interface ParsedTimeLabel {
  year?: number
  month?: number
  day?: number
  /** exact=含 4 位年份；unknown=没有年份（缺年份的时间不能用于排序，界面提示「时间待核」） */
  confidence: CompilationTimeConfidence
  /** 归一化后的显示文本（去多余空白）；无法确定时为「时间待核」 */
  label?: string
}

const YEAR_RE = /(?:18|19|20)\d{2}/
const MONTH_RE = /(\d{1,2})\s*月/
const DAY_RE = /(\d{1,2})\s*日/

/**
 * 解析时间标签（纯函数）：
 * - 含 4 位年份 → confidence='exact'，并抽出月/日（如「2018 年 5 月 19 日」）；
 * - **只有月日没有年份**（如「5 月 19 日」「7—9 日」）→ 仍抽出月/日但 confidence='unknown'
 *   （实测真实数据中存在 12 张此类卡片，不能当"有时间戳"放过）；
 * - 年份区间（如「2005—2010 年」）取**起始年**作为排序键；同理「7—9 日」是**日**区间，
 *   只从「…日」抽出 day（month 必须保持为空，否则会被误排到 7 月）；
 * - 无年份依据（如「十三五规划期间」）→ confidence='unknown'。
 */
export function parseTimeLabel(ts?: string | null): ParsedTimeLabel {
  const raw = (ts ?? '').trim()
  if (!raw) return { confidence: 'unknown' }
  const yearMatch = raw.match(YEAR_RE)
  const monthMatch = raw.match(MONTH_RE)
  const dayMatch = raw.match(DAY_RE)
  const parsed: ParsedTimeLabel = {
    confidence: yearMatch ? 'exact' : 'unknown',
    label: raw
  }
  if (yearMatch) parsed.year = Number(yearMatch[0])
  if (monthMatch) parsed.month = Number(monthMatch[1])
  if (dayMatch) parsed.day = Number(dayMatch[1])
  return parsed
}

/** 段首时间标签的显示文本（未确定时间时给出统一提示词，便于 UI 与统计共用） */
export const TIME_PENDING_LABEL = '时间待核'

/** 段落正文哈希（版本对比与"是否被改动"判定；短哈希足够） */
export function paragraphTextHash(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = (h1 ^ c) * 0x01000193
    h2 = (h2 + c * (i + 1)) | 0
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

/** 单段落渲染为一行 markdown：`时间标签　正文`（无时间则只输出正文；段内 ASCII 空白归一为单个空格） */
export function renderParagraphLine(p: Pick<CompilationParagraph, 'timeLabel' | 'text'>): string {
  // 注意：只归一 ASCII 空白（空格/制表/换行），保留段首时间与正文之间的全角空格 U+3000 作为稳定分隔符。
  // 年鉴 PDF 抽出的正文里常有制表符（表格残留），归一后既能保证"一段一行"，也让 diff 不受空白噪声干扰。
  const text = (p.text ?? '').replace(/[ \t\r\n\f\v]+/g, ' ').trim()
  const label = (p.timeLabel ?? '').replace(/[ \t\r\n\f\v]+/g, ' ').trim()
  return label ? label + '　' + text : text
}

/** 整篇文档渲染为 markdown（**一段一行**，便于 diff 与并排对比） */
export function renderDocumentMarkdown(paragraphs: Pick<CompilationParagraph, 'timeLabel' | 'text' | 'kind'>[]): string {
  return paragraphs
    .map((p) => (p.kind === 'heading' ? '## ' + renderParagraphLine(p).replace(/^##\s*/, '') : renderParagraphLine(p)))
    .join('\n')
}

/**
 * 由汇编条目构造段落快照（纯函数）：把 DB 行归一为文档段落，缺失的元数据按规则补齐。
 * - 时间：优先用 `year`/`ts`，都没有则 `timeConfidence='unknown'`；
 * - 来源编号：用 `sourceOrdinal`，缺失时按 sourceId 在 refsBySourceId 中反查（迁移期兜底）。
 */
export function buildParagraphSnapshot(
  items: CompilationItem[],
  refsBySourceId?: Map<string, CompilationSourceRef>
): CompilationParagraph[] {
  return items.map((it, index) => {
    const parsed = it.year != null ? null : parseTimeLabel(it.ts)
    const ref = it.sourceOrdinal == null && it.sourceId ? refsBySourceId?.get(it.sourceId) : undefined
    const timeConfidence: CompilationTimeConfidence =
      it.timeConfidence ?? (it.year != null ? 'exact' : (parsed?.confidence ?? 'unknown'))
    const year = it.year ?? parsed?.year
    const timeLabel = it.ts ?? parsed?.label
    return {
      id: it.id,
      ordinal: index,
      text: it.excerpt,
      timeLabel: year != null && !timeLabel ? String(year) + ' 年' : timeLabel,
      year,
      month: it.month ?? parsed?.month,
      day: it.day ?? parsed?.day,
      timeConfidence,
      sourceOrdinal: it.sourceOrdinal ?? ref?.ordinal,
      sourceId: it.sourceId || undefined,
      alsoSourceIds: it.alsoSourceIds && it.alsoSourceIds.length > 0 ? it.alsoSourceIds : undefined,
      alsoSourceOrdinals: it.alsoSourceOrdinals && it.alsoSourceOrdinals.length > 0 ? it.alsoSourceOrdinals : undefined,
      sourceTitle: it.sourceTitle,
      evidence: it.evidence,
      kind: (it.kind ?? 'paragraph') as CompilationParagraphKind,
      revision: it.revision ?? 1,
      origin: (it.origin ?? 'generate') as CompilationParagraphOrigin,
      kept: it.kept
    }
  })
}

/** 变更统计（纯函数）：按段 id 比对两版段落，得出新增/删除/修改/移动与涉及段落 id */
export function summarizeParagraphChange(
  prev: CompilationParagraph[],
  next: CompilationParagraph[]
): CompilationChangeSummary {
  const prevById = new Map(prev.map((p) => [p.id, p]))
  const nextIds = new Set(next.map((p) => p.id))
  let added = 0
  let removed = 0
  let modified = 0
  let moved = 0
  const paragraphIds: string[] = []
  for (const p of next) {
    const q = prevById.get(p.id)
    if (!q) {
      added += 1
      paragraphIds.push(p.id)
      continue
    }
    if (q.text !== p.text) {
      modified += 1
      paragraphIds.push(p.id)
    }
    if (q.ordinal !== p.ordinal) moved += 1
  }
  for (const p of prev) if (!nextIds.has(p.id)) removed += 1
  return { added, removed, modified, moved, paragraphIds }
}

/** 按「年 → 月 → 来源编号 → 生成序」稳定排序（D4：排序确定性由本地保证，段序稳定可复现） */
export function sortParagraphsByTime<
  T extends { ordinal: number; year?: number; month?: number; sourceOrdinal?: number }
>(paragraphs: T[]): T[] {
  return paragraphs
    .map((p, index) => ({ p, index }))
    .sort((a, b) => {
      const ya = a.p.year
      const yb = b.p.year
      if (ya == null && yb != null) return 1
      if (ya != null && yb == null) return -1
      if (ya != null && yb != null && ya !== yb) return ya - yb
      const ma = a.p.month ?? 0
      const mb = b.p.month ?? 0
      if (ma !== mb) return ma - mb
      const oa = a.p.sourceOrdinal ?? Number.MAX_SAFE_INTEGER
      const ob = b.p.sourceOrdinal ?? Number.MAX_SAFE_INTEGER
      if (oa !== ob) return oa - ob
      return a.index - b.index
    })
    .map((x, index) => ({ ...x.p, ordinal: index }))
}

// ---------------------------------------------------------------- 整合提取（Phase 7.2）：本地校验与成文

/** 时间标签是否含 4 位年份（缺年份的时间不能参与排序，需在界面提示「时间待核」） */
export function hasYear(ts?: string | null): boolean {
  return !!ts && YEAR_RE.test(ts)
}

/** 去掉所有空白（保留标点）：用于「逐字包含」判定，容忍 PDF 排版空格（`普 通 中 学`） */
export function stripSpaces(text: string): string {
  return text.replace(/\s+/g, '')
}

/** 去空白与标点（保留数字与汉字）：用于相似度比较（与 compilation-service 的卡片预筛同口径） */
function normalizeForCompare(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '')
}

function bigramSet(text: string): Set<string> {
  const grams = new Set<string>()
  for (let i = 0; i + 1 < text.length; i++) grams.add(text.slice(i, i + 2))
  return grams
}

/** bigram Dice 相似度（0~1）；用于跨窗口近似重复检测 */
export function textSimilarity(a: string, b: string): number {
  const ga = bigramSet(normalizeForCompare(a))
  const gb = bigramSet(normalizeForCompare(b))
  if (ga.size === 0 || gb.size === 0) return 0
  const [small, large] = ga.size <= gb.size ? [ga, gb] : [gb, ga]
  let common = 0
  for (const g of small) if (large.has(g)) common += 1
  return (2 * common) / (ga.size + gb.size)
}

/**
 * 在原文中定位**逐字连续**出现的片段（容忍空白差异），返回原文区间；未命中返回 null。
 * 用于校验大模型给出的 `evidence` 引文确实是原文，而不是编造或改写。
 */
export function locateVerbatim(parentText: string, needle: string): { start: number; end: number } | null {
  let norm = ''
  const map: number[] = []
  for (let i = 0; i < parentText.length; i++) {
    const ch = parentText[i]
    if (/\s/.test(ch)) continue
    norm += ch
    map.push(i)
  }
  const target = stripSpaces(needle)
  if (!target) return null
  const at = norm.indexOf(target)
  if (at < 0) return null
  return { start: map[at], end: map[at + target.length - 1] + 1 }
}

/** 抽出文本中的数字串（含小数与千分位），用于「不得凭空造数」校验 */
export function numbersIn(text: string): string[] {
  return text.match(/\d+(?:[.,]\d+)*/g) ?? []
}

/** 中文数字（含"两"），用于 ③ 的等价类与低置信标记 */
const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }

/** 解析简单中文数字（十二 / 三十 / 三百二十 / 一万二千 …）；解析不出返回 null */
export function parseChineseNumber(raw: string): number | null {
  const s = (raw ?? '').trim()
  if (!s || !/^[零一二三四五六七八九十百千万亿两]+$/.test(s)) return null
  let total = 0
  let section = 0
  let digit = 0
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch]
      continue
    }
    if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch]
      section += (digit === 0 ? 1 : digit) * unit
      digit = 0
      continue
    }
    // 万 / 亿：把当前 section 结算进 total
    const big = ch === '万' ? 1e4 : 1e8
    total += (section + digit || 1) * big
    section = 0
    digit = 0
  }
  const value = total + section + digit
  return Number.isFinite(value) && value > 0 ? value : null
}

/** 抽出中文数字串（用于等价类匹配） */
export function chineseNumbersIn(text: string): string[] {
  return [...String(text ?? '').matchAll(/[零一二三四五六七八九十百千万亿两]{2,}/g)].map((m) => m[0])
}

interface NumberAtom {
  token: string
  /** 归一化后的绝对值（把 亿/万/千 折算进去） */
  canonical: number
  /** 是否带"量级/小数"（这类值允许末位 1 个单位的舍入容差） */
  scaled: boolean
  /** 末位精度（10 的幂）：用于算舍入容差 */
  lastUnit: number
}

function numberAtoms(text: string): NumberAtom[] {
  const out: NumberAtom[] = []
  const re = /(\d+(?:[.,]\d+)*)\s*(亿|万|千)?/g
  let m = re.exec(String(text ?? ''))
  while (m) {
    const raw = m[1].replace(/,/g, '')
    const value = Number(raw)
    if (Number.isFinite(value)) {
      const unit = m[2]
      const factor = unit === '亿' ? 1e8 : unit === '万' ? 1e4 : unit === '千' ? 1e3 : 1
      const decimals = (raw.split('.')[1] ?? '').length
      out.push({
        token: raw,
        canonical: value * factor,
        scaled: factor > 1 || decimals > 0,
        lastUnit: factor * Math.pow(10, -decimals)
      })
    }
    m = re.exec(String(text ?? ''))
  }
  return out
}

/**
 * 数字是否"有据"（2026-10-03 用户裁定重做 ③）：
 * - **等价类**：`5.09 亿元` ↔ `50900 万元` ↔ `5.09亿`（量级折算）、`1.2 万` ↔ `12000`、
 *   `三十所` ↔ `30 所`（中文数字）；
 * - **舍入容差**：只对带量级/小数的值给"末位 1 个单位"的容差（四舍五入），且相对误差 ≤5%；
 *   整数（如 `30 所`）仍要求精确相等——保住"`2` 不能混进 `2018`、`30` 不能混进 `130`"这条护栏；
 * - **区间/合计**：`2018—2020`、`30+5=35` 这类由多个数字组成，逐个数字判定即可。
 */
export function numbersCoveredBy(text: string, sourceText: string): boolean {
  const srcAtoms = numberAtoms(sourceText)
  const srcTokens = new Set(numbersIn(sourceText).map((t) => t.replace(/,/g, '')))
  const srcCn = new Set(
    chineseNumbersIn(sourceText)
      .map((s) => parseChineseNumber(s))
      .filter((n): n is number => n !== null)
  )
  for (const atom of numberAtoms(text)) {
    if (srcTokens.has(atom.token)) continue
    if (srcAtoms.some((s) => s.canonical === atom.canonical)) continue
    // 舍入容差：仅当两侧有一侧带量级/小数
    const tolerant = srcAtoms.some((s) => {
      if (!(s.scaled || atom.scaled)) return false
      const tol = Math.max(s.lastUnit, atom.lastUnit)
      const diff = Math.abs(s.canonical - atom.canonical)
      return diff <= tol && diff <= Math.max(s.canonical, atom.canonical) * 0.05
    })
    if (tolerant) continue
    return false
  }
  // 中文数字也要能对上（否则"三十所"会被当成没据）
  for (const cn of chineseNumbersIn(text)) {
    const value = parseChineseNumber(cn)
    if (value === null) continue
    if (srcCn.has(value)) continue
    if (srcAtoms.some((s) => s.canonical === value)) continue
    return false
  }
  return true
}

/**
 * 年鉴/年报类来源标题判定：只有这类"次年产出的年度出版物"，其标题年份才表示**记述年份的上一年**
 * （《长乐年鉴2019》记述 2018 年）。普通文件（《2019年教育统计表》）与网页新闻标题（《2021年全区教育工作总结》）
 * 里的年份指向的是**内容年本身**，不能减 1——这是 2026-09-10 网页资料库并入后修掉的一处静默错年。
 */
export function isYearbookLikeTitle(title?: string | null): boolean {
  return /(年鉴|年报|年度报告|大事记|地方志|县志|市志|区志|省志|专业志|志书)/.test(title ?? '')
}

/**
 * 从来源标题推断年份（**年鉴惯例**）：仅对年鉴/年报类标题生效，取标题中的 4 位年份**减 1**。
 * 非年鉴标题（含网页新闻标题）不在此处理——见 `inferYearFromSource`。
 *
 * ⚠ 本函数**只按标题判断**，不看来源类型。因此它只能用于**已知是本地年鉴文件**的场合；
 * 网页来源（`kind === 'url'`）**不得**走这里——2026-10-05 用户裁定：年 −1 只对"年鉴/年报/志书"类**本地文件**生效。
 */
export function inferYearFromSourceTitle(title?: string | null): number | undefined {
  if (!isYearbookLikeTitle(title)) return undefined
  const m = (title ?? '').match(/(?:18|19|20)\d{2}/)
  if (!m) return undefined
  const year = Number(m[0]) - 1
  return year >= 1900 ? year : undefined
}

/** 年份兜底的依据（用于日志与诊断，说明这一年是怎么来的） */
export type YearBasis = 'text' | 'title-yearbook' | 'title' | 'published'

export interface InferredYear {
  year: number
  basis: YearBasis
}

/** 从任意日期字符串取 4 位年份（发布时间可能是 ISO 或「2021-03-05」「2021年3月5日」） */
export function yearOfDate(value?: string | null): number | undefined {
  const m = (value ?? '').match(/(?:18|19|20)\d{2}/)
  if (!m) return undefined
  const year = Number(m[0])
  return year >= 1900 ? year : undefined
}

/**
 * 把来源发布时间**如实**缩短成提示词里好读的形式（2026-10-05）：
 * 库里存的是 ISO（`2021-05-06T00:00:00.000Z`），直接塞进提示词对模型只是噪声且占字符；
 * 截到「日」为止既保留了"发布时间"这个证据本身，又与方志语境的"某年某月某日"一致。
 * 只做**截取**、不做任何时区换算或推算——取不到日期形态时原样返回，绝不瞎编。
 */
export function formatSourceDate(value?: string | null): string {
  const v = (value ?? '').trim()
  if (!v) return ''
  const m = v.match(/(?:18|19|20)\d{2}(?:-\d{1,2}(?:-\d{1,2})?)?/)
  return m ? m[0] : v
}

/**
 * 段落是否只是"把来源标题复述了一遍"（纯函数，2026-09-12 用户实测后新增）。
 *
 * 动因：真实库里出现过「长乐新添一所普通高中，将于9月开学。」这类段落——正文与**来源标题**几乎一致，
 * 校名/规模/投资/地点等正文里的具体信息全被丢掉；它还常常带着一个正文中查不到的年份（实测 2019
 * 而文章发布于 2023）。用户明确要求：**绝不能只看文章标题**。
 *
 * 判定：归一化（去空白与标点）后，段落与标题互为子串，或标题包含段落的全部字符 —— 即"段落没有比标题多出信息"。
 * 注意：这是**收窄判定**（宁少勿错）：只有段落确实没带来新信息时才判为标题型；
 * 段落比标题长且含正文要素（数字/专名）时一律放行。
 */
export function isTitleOnlyParagraph(text: string | undefined, sourceTitle: string | undefined): boolean {
  const t = normalizeForMatch(text)
  const s = normalizeForMatch(sourceTitle)
  if (!t || !s) return false
  if (s.includes(t)) return true // 段落是标题的一部分（如标题「今日获批！36个班！长乐将新增一所高中！」→ 段落「长乐将新增一所高中」）
  // 段落比标题更长时：只有当它只是标题 + 极少量连接词（≤6 字新增内容）才算"只复述标题"
  if (t.includes(s)) return t.length - s.length <= 6
  // 与标题"同词不同序的改写"（「可容3000名学生！长乐将新建一所高中！」→「长乐将新建一所高中，可容纳3000名学生。」）
  // 用 bigram 相似度兜住；加长度护栏：只有"短段"才可能是标题复述，长段必然含正文要素，不判。
  if (t.length > TITLE_ONLY_MAX_CHARS) return false
  return textSimilarity(t, s) >= TITLE_ONLY_DICE
}

/**
 * 「段落≈标题」判定阈值（2026-09-12 用真实数据标定）：
 * 三条实测标题复述段的相似度为 **0.58–0.60**（同词不同序 + 少量连接词），
 * 而正常段落（带校名/规模/地点）与标题的相似度通常 <0.3，取 0.55 留出安全边际；
 * 同时只在段落较短（≤40 字归一化后）时才做相似度判定——长段必然带来了正文信息。
 */
export const TITLE_ONLY_DICE = 0.55
/** 段落超过这个长度（归一化后）就不再判"标题复述" */
export const TITLE_ONLY_MAX_CHARS = 40

/**
 * 段落的年份是否有据可查（纯函数，2026-09-12 新增，配合「时间必须有据」的硬校验）。
 *
 * 依据按优先级：① 年份在该来源正文/卡片原文里出现；② 等于该来源的推测年份（年鉴 −1 / 标题年份 / 网页发布时间）。
 * 都查不到 → 说明模型自己编了一个年份（实测：正文无 2019 的文章被标成 2019 年），调用方应降级为「时间待核」。
 */
export function isYearSupportedBySource(
  year: number | undefined,
  source: { text?: string | null; title?: string | null; kind?: 'file' | 'url'; publishedAt?: string | null }
): boolean {
  if (year == null) return true
  const text = source.text ?? ''
  if (text.includes(String(year))) return true
  const inferred = inferYearFromSource({ title: source.title, kind: source.kind, publishedAt: source.publishedAt })
  return inferred?.year === year
}

/** 匹配用归一化：去空白、常见标点与装饰符号（纯函数） */
function normalizeForMatch(value: string | undefined): string {
  return (value ?? '').replace(/[\s　，。；、,.!?！？：:（）()「」“”"'《》\-—_·|【】\[\]]/g, '')
}

/**
 * 标题是否像一个 URL/域名（E2：URL 里的 `t20251203` 之类数字不能被当作年份依据） */
export function looksLikeUrl(value?: string | null): boolean {
  const v = (value ?? '').trim()
  if (!v) return false
  return /^https?:\/\//i.test(v) || /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(v)
}

/**
 * 段落缺少年份时的**来源级兜底**（纯函数，优先级从高到低）：
 * 1. **本地年鉴/年报/志书类文件**（`kind === 'file'` 且标题像年鉴）→ 标题年份 − 1（`title-yearbook`，地方志行业惯例）；
 * 2. 其它标题里出现的年份 → **原样采用**（`title`；新闻标题《2021年全区教育工作总结》指的就是 2021 年）；
 * 3. 网页来源（kind='url'）且解析到发布时间 → 发布时间年份（`published`；网页正文常用「近日/今年」，
 *    标题里也没年份时这是唯一可靠依据）；
 * 4. 都推不出 → undefined（保持「时间待核」，**不编造**）。
 * 注：标题若本身就是 URL/域名则**跳过第 1、2 条**——`/202512/t20251203_xxx.htm` 这类数字不是内容年份。
 *
 * ⚠ 2026-10-05 用户裁定（实测缺陷）：**`kind === 'url'` 的来源一律不做年鉴 −1**。
 * 旧实现在这里**只按标题**判断年鉴，于是同一站点既发新闻也发年鉴时，网页版年鉴页的标题年份被 −1，
 * 用户实测到"网页来源的段落年份 = 网页发布年 − 1"的整片错年。−1 是"年度出版物次年产出的体例"，
 * 只对**本地文件**成立；网页页面本身就是内容载体，标题里的年份指向内容年。
 */
export function inferYearFromSource(source: {
  title?: string | null
  kind?: 'file' | 'url'
  publishedAt?: string | null
}): InferredYear | undefined {
  const titleUsable = !looksLikeUrl(source.title)
  if (titleUsable) {
    // 年鉴惯例 −1 只认可"本地文件"这一条证据：网页没有"年度出版物"这个载体语义（2026-10-05 裁定）
    if (source.kind === 'file') {
      const yearbook = inferYearFromSourceTitle(source.title)
      if (yearbook != null) return { year: yearbook, basis: 'title-yearbook' }
    }
    const titleYear = yearOfDate(source.title)
    if (titleYear != null) return { year: titleYear, basis: 'title' }
  }
  if (source.kind === 'url') {
    const published = yearOfDate(source.publishedAt)
    if (published != null) return { year: published, basis: 'published' }
  }
  return undefined
}

/**
 * 段首时间兜底（纯函数）：模型的 `timeLabel` 里没有年份时，用来源信息推断的年份补上，标为 `inferred`。
 * - 原标签带月份（如「5 月 19 日」）→ 拼成「2018 年 5 月 19 日」；
 * - 原标签只有日（如「29 日」，缺月份本身已无意义）或为空 → 只写「2018 年」；
 * - 来源也推断不出年份 → 保持 `unknown`（界面「时间待核」），不编造。
 * 依据（`basis`）透出给调用方做诊断：年鉴惯例 / 标题年份 / 网页发布时间。
 */
export function withFallbackYear(
  timeLabel: string | undefined,
  sourceTitle: string | undefined,
  source?: { kind?: 'file' | 'url'; publishedAt?: string | null }
): {
  timeLabel?: string
  year?: number
  month?: number
  day?: number
  timeConfidence: CompilationTimeConfidence
  basis?: YearBasis
} {
  const parsed = parseTimeLabel(timeLabel)
  if (parsed.year) {
    return { timeLabel: parsed.label, year: parsed.year, month: parsed.month, day: parsed.day, timeConfidence: 'exact', basis: 'text' }
  }
  const inferred = inferYearFromSource({ title: sourceTitle, kind: source?.kind, publishedAt: source?.publishedAt })
  if (!inferred) {
    return { timeLabel: parsed.label, month: parsed.month, day: parsed.day, timeConfidence: 'unknown' }
  }
  const rest = (parsed.label ?? '').replace(/(?:18|19|20)\d{2}\s*年?/, '').trim()
  const label = /月/.test(rest) ? String(inferred.year) + ' 年 ' + rest : String(inferred.year) + ' 年'
  return {
    timeLabel: label,
    year: inferred.year,
    month: parsed.month,
    day: parsed.day,
    timeConfidence: 'inferred',
    basis: inferred.basis
  }
}

/** 大模型「整合提取」返回的一段（本地校验前的原始形态） */
export interface ExtractedParagraphDraft {
  /** 该段所属来源（提示词中的 `#N`） */
  sourceRef: string
  /** 段落正文（**不含**段首时间标签） */
  text: string
  /** 段首时间标签（应含 4 位年份；推断不出时可为「5 月 19 日」这类缺年份写法，由本地标为 unknown） */
  timeLabel?: string
  /** 模型自报的时间依据强度（本地以 timeLabel 的解析结果为准，不采信模型自报） */
  confidence?: string
  /** 原文逐字证据引文（本地据此确认段落确实来自该来源） */
  evidence?: string
  reason?: string
}

/**
 * 段落校验失败的原因（失败即按句修剪，并计入诊断）。
 * 2026-10-03 起 `evidence-not-found` **不再是失败原因**（证据从门槛降为充分度之一，见
 * `validateExtractedParagraph`），保留在类型里只为读旧诊断数据。
 */
export type ParagraphRejectReason = 'empty-text' | 'evidence-not-found' | 'number-not-in-source'

export type ParagraphValidation =
  | {
      ok: true
      text: string
      timeLabel?: string
      timeConfidence: CompilationTimeConfidence
      year?: number
      month?: number
      day?: number
      evidence?: string
      /** true = 模型给的 evidence 不是逐字命中（已忽略），但事实逐句核验通过 */
      evidenceLoose?: boolean
    }
  | { ok: false; reason: ParagraphRejectReason }

/** 抽句子（保留句末标点；换行也当边界） */
export function splitSentences(text: string): string[] {
  return String(text ?? '')
    .split(/(?<=[。！？；!?;\n])/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** 句子里的《标题》引用 */
function titlesIn(text: string): string[] {
  return [...String(text ?? '').matchAll(/《([^》]{2,40})》/g)].map((m) => m[1])
}

/**
 * 该句是否"可核验"：句中的数字都能在来源原文里找到，且引用的《标题》也出现在来源原文里。
 * 句子里的**文字**无法本地核验（这是本地校验的边界，故只做"关键 token"核验）。
 */
export function sentenceFactsVerified(sentence: string, sourceText: string): boolean {
  if (!numbersCoveredBy(sentence, sourceText)) return false
  const src = stripSpaces(sourceText)
  for (const title of titlesIn(sentence)) {
    if (!src.includes(stripSpaces(title))) return false
  }
  return true
}

/**
 * 逐句核验一段正文（2026-10-03 用户裁定：把"证据必须逐字"从**门槛**降为**充分度**之一）：
 * 只要每个"带数字或《引用》"的句子都能在来源原文里找到依据，就认为事实有据；
 * 返回第一句不过的句子（供诊断/降级按句修剪）。
 */
export function verifySentenceFacts(text: string, sourceText: string): { ok: boolean; badSentence?: string } {
  for (const s of splitSentences(text)) {
    if (!sentenceFactsVerified(s, sourceText)) return { ok: false, badSentence: s }
  }
  return { ok: true }
}

/**
 * 时间可信度**采信大模型自报**（用户 2026-09-10 裁定：去掉"本地再校验时间"这一条）：
 * 模型给出可识别的取值就照用（精确/exact、推断/inferred、未知/unknown 及常见中文写法），
 * 给不出时按"有标签即 exact、无标签即 unknown"兜底。本地不再用解析结果去覆盖模型的判断，
 * 解析只服务于**排序**（结构化 year/month/day）与界面提示（标签里到底有没有年份）。
 */
export function mapModelConfidence(raw: string | undefined, timeLabel: string | undefined): CompilationTimeConfidence {
  const v = (raw ?? '').trim().toLowerCase()
  if (v) {
    if (/exact|精确|明确|确定|explicit/.test(v)) return 'exact'
    if (/infer|推断|推定|inferred|estimated/.test(v)) return 'inferred'
    if (/unknown|未知|无|未定|none|missing/.test(v)) return 'unknown'
  }
  return (timeLabel ?? '').trim() ? 'exact' : 'unknown'
}

/**
 * 校验一段整合提取结果（纯函数）——2026-10-03 用户裁定后重做：
 *
 * 旧口径的问题：把「`evidence` 必须逐字命中」当**门槛**，而这一步的任务恰恰是**压缩重写**——
 * 段落整合得越通顺，越难给出一段覆盖要点的逐字引文；给不出就掉进粒度最粗的兜底。
 * 新口径（放开的是形式，收紧的是事实）：
 *  ① 正文非空；
 *  ② **逐句事实核验**：每个"带数字或《引用》"的句子都必须能在来源原文里找到依据
 *     （数字支持 亿/万/千 折算、中文数字、单位舍入容差，见 `numbersCoveredBy`）；
 *  ③ `evidence` 能逐字命中就带上（供来源定位）；命中不了**不再判失败**，而是记 `evidenceLoose`
 *     ——事实已经逐句核验过了，"证据"从门槛降为充分度之一。
 * **时间不参与校验**（用户裁定：只靠提示词规范格式），仅解析出结构化 year/month/day 供排序。
 * 任一硬失败 → 调用方按句修剪（见 extract-service），**绝不退回整卡原文**。
 */
export function validateExtractedParagraph(draft: ExtractedParagraphDraft, sourceText: string): ParagraphValidation {
  const text = (draft.text ?? '').trim()
  if (!text) return { ok: false, reason: 'empty-text' }
  const facts = verifySentenceFacts(text, sourceText)
  if (!facts.ok) return { ok: false, reason: 'number-not-in-source' }
  const evidenceRaw = (draft.evidence ?? '').trim()
  const evidence = evidenceRaw && locateVerbatim(sourceText, evidenceRaw) ? evidenceRaw : undefined
  const timeLabel = (draft.timeLabel ?? '').trim()
  const parsed = parseTimeLabel(timeLabel)
  return {
    ok: true,
    text,
    timeLabel: timeLabel || undefined,
    timeConfidence: mapModelConfidence(draft.confidence, timeLabel),
    year: parsed.year,
    month: parsed.month,
    day: parsed.day,
    evidence,
    evidenceLoose: !!evidenceRaw && !evidence
  }
}

/** 成文输入：已通过校验（或降级）的一段 */
export interface AssembleInputParagraph {
  text: string
  timeLabel?: string
  /** 时间可信度（本地已判定时传入；缺省则按 timeLabel 现解析） */
  timeConfidence?: CompilationTimeConfidence
  /** 所属来源 id（调用方按 `#N` 解析后传入）；空串表示无来源 */
  sourceId: string
  sourceTitle?: string
  /** 并列来源 id（Phase 7.12；通常由 `assembleDocument` 在合并重复段时补齐） */
  alsoSourceIds?: string[]
  evidence?: string
  origin?: CompilationParagraphOrigin
  /** 该段来自本批的第几个候选（用于窗口级矛盾说法的映射与诊断） */
  parentIndex: number
  /**
   * 该段在**来源正文**里的字符区间（2026-10-05 用户裁定 P0-2）：由生成期（切块 → 成卡 → 提取）
   * 一路携带下来，落锚点时直接映射 `source_blocks` 得到块号与页码，不再拿文字去正文里回溯匹配。
   * 缺省（老链路/模型改写掉的卡片）时落锚点会回退逐字匹配，**不影响旧数据**。
   */
  charStart?: number
  charEnd?: number
}

/** 成文输出的一段（尚无数据库 id：由仓储层 upsert 时分配/复用） */
export type AssembledParagraph = Omit<CompilationParagraph, 'id'> & {
  parentIndex: number
  /**
   * 该段在来源正文里的**生成期字符区间**（P0-2）。落锚点时用它映射 `source_blocks` 得块号与页码；
   * 缺省时回退逐字匹配。**只走内存**（与 `anchorCandidates` 同一体例），
   * 因此不落库、不进版本快照、不进导出，撤销/版本恢复/导入链路一概不用改。
   */
  charStart?: number
  charEnd?: number
  /**
   * 各来源**可用来定位的逐字候选文字**（Phase 9 / S3 修复，2026-10-03）：
   * 主来源与每个并列来源各一份，落库时就地算锚点（`attachAnchors`）时按来源取用。
   *
   * 为什么不只留主来源：并列来源是"被合并掉的那一段"的出处，它的位置只能靠**那一段自己的**
   * `evidence`/正文去找；用合并后的正文去别的来源里找是另一回事（会锚错）。
   *
   * ⚠ **只走内存**：不落库、不进版本快照、不进导出/归档，因此撤销、版本恢复、导入等链路一概不用改。
   */
  anchorCandidates?: SourceAnchorCandidate[]
}

/** 某个来源的定位候选（excerpt = 该段在该来源上的正文；evidence = 逐字证据引文，可能没有） */
export interface SourceAnchorCandidate {
  sourceId: string
  evidence?: string
  excerpt: string
  /**
   * 该段在该来源正文里的**生成期字符区间**（P0-2）。有它就直接映射块表得页码；
   * 没有（并列来源的候选是"被合并掉那一段"的文字，可能没记区间）则回退逐字匹配。
   */
  charStart?: number
  charEnd?: number
}

/** 合并候选列表：按 sourceId 去重（先出现的优先），并丢掉空 sourceId */
function mergeAnchorCandidates(...lists: (SourceAnchorCandidate[] | undefined)[]): SourceAnchorCandidate[] {
  const out: SourceAnchorCandidate[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const c of list ?? []) {
      if (!c?.sourceId || seen.has(c.sourceId)) continue
      seen.add(c.sourceId)
      out.push(c)
    }
  }
  return out
}

/** 某一段自身的候选（主来源） */
function ownAnchorCandidate(p: {
  sourceId?: string
  evidence?: string
  text: string
  charStart?: number
  charEnd?: number
}): SourceAnchorCandidate[] {
  return p.sourceId ? [{ sourceId: p.sourceId, evidence: p.evidence, excerpt: p.text, charStart: p.charStart, charEnd: p.charEnd }] : []
}

/**
 * 把所有"参与过这段"的来源都补进候选列表（Phase 9 / S3 修复）。
 * 合并路径有多条（完全重复 / 包含关系两个方向 / 近似重复两个方向），漏一条就会静默丢掉某个来源的位置，
 * 因此这里集中成一个函数，并在单测里用"候选来源集合 ⊇ {主来源} ∪ 并列来源"的不变量钉住。
 */
export function absorbAnchorCandidates(
  target: { sourceId?: string; evidence?: string; text: string; anchorCandidates?: SourceAnchorCandidate[]; charStart?: number; charEnd?: number },
  ...absorbed: { sourceId?: string; evidence?: string; text: string; anchorCandidates?: SourceAnchorCandidate[]; charStart?: number; charEnd?: number }[]
): SourceAnchorCandidate[] {
  return mergeAnchorCandidates(
    target.anchorCandidates ?? [],
    ownAnchorCandidate(target),
    ...absorbed.flatMap((p) => [p.anchorCandidates ?? [], ownAnchorCandidate(p)])
  )
}

export interface AssembleResult {
  /** 已去重、已按时间稳定排序、ordinal 已重写 */
  paragraphs: AssembledParagraph[]
  /** 按（排序后）首次引用顺序排列的来源 id：编号表 `compilation_sources` 依此分配 1..N */
  sourceOrder: string[]
  /** 完全/近似重复被丢弃的段数 */
  duplicatesDropped: number
  /** 「疑似同一事实但数字不一致」而**特意保留**的段数（矛盾候选，交给矛盾扫描） */
  conflictsKept: number
  /** 其中**跨来源**合并掉的段数（网页转载 / 网站版与工作区同文档；2026-09-12 第二批） */
  crossSourceMerged: number
  /** 其中由「包含关系」判定合并掉的段数（Phase 7.12 新增规则，诊断用） */
  containmentMerged: number
}

/** 近似重复判定阈值（同来源、数字一致时才视为重复；略低以覆盖"改一两个字"的重复表述） */
export const NEAR_DUPLICATE_DICE = 0.85

/**
 * 跨来源近似重复阈值（更严）：不同来源措辞接近，比同一来源更容易是"两件不同的事"，
 * 因此只在非常接近、且**数字完全一致**时才合并（合并后并列来源一并保留，见 assembleDocument）。
 *
 * ⚠ 2026-10-02（Phase 7.12 S1）实测后**刻意不降低本阈值**：曾计划降到 0.85 以覆盖
 * 0.85–0.92 区间的 2 对真实重复，但同批实测发现该区间存在**误合并**风险——
 * 「长乐七中教学综合楼项目投资1200万元新建教学综合楼。」vs「长乐三中…」Dice=0.905、
 * 「长乐一中首占校区的学生宿舍楼工程已完工。」vs「长乐二中…」Dice=0.889（数字完全一致），
 * 区别只在主体名一个字，降阈值会把不同学校的材料静默吞掉。**宁多勿漏**，故保持 0.92。
 */
export const NEAR_DUPLICATE_DICE_CROSS = 0.92

/**
 * 「包含关系」判定的最短字数（归一化后）：一段的文字**逐字完整包含**另一段时，
 * 短的那段至少要有这么多字才认定重复——避免把「XX中学」这类短语并进长段。
 */
export const CONTAINMENT_MIN_CHARS = 12

/** 合并「并列来源」：保留主来源之外的其它出处，去重、去掉空值、且不含主来源自身（Phase 7.12） */
export function mergeAlsoSourceIds(
  mainSourceId: string | undefined,
  ...lists: ((string | undefined)[] | undefined)[]
): string[] {
  const out: string[] = []
  for (const list of lists) {
    for (const id of list ?? []) {
      if (!id || id === mainSourceId) continue
      if (!out.includes(id)) out.push(id)
    }
  }
  return out
}

/**
 * 把各批「整合提取」结果拼成一篇文档（纯函数）：
 * ① 完全重复（去空白标点后相同）→ 保留信息更全的一条（**跨来源也算重复**）；
 * ② 包含关系（一段的文字**逐字完整包含**另一段，`CONTAINMENT_MIN_CHARS` 起）→ **数字一致**才算重复：
 *    短句被长段完整包含时 Dice 天然偏低（真实数据实测 0.507 / 0.529 / 0.563 / 0.839 都被阈值漏掉），
 *    而"一段是另一段的超集"在语义上不可能是两件事，属于**最安全**的合并判据；
 * ③ 近似重复（Dice 相似）→ **数字一致**才算重复（保留更长的一条）；
 *    跨来源（网页转载、网站版与工作区同文档）用更严格的阈值 `NEAR_DUPLICATE_DICE_CROSS`；
 *    **数字不一致则两段都保留** —— 这是"疑似矛盾的说法"，绝不能在这里被合并掉，交给矛盾扫描处理；
 * ④ 按 `年 → 月 → 生成序` 稳定排序，并重写 ordinal（无年份的段落沉底）。
 *
 * Phase 7.12（2026-10-02，用户裁定 Q1=B/Q3=i）：**合并时把被合并那一段的来源记为"并列来源"**
 * （`alsoSourceIds`），因此合并不再丢失"这件事还有另一个出处"。主来源仍是 `sourceId`，
 * 所以 evidence 逐字校验、矛盾归因与「不得跨来源拼接」（Phase 7.2 裁定 D1）都不受影响。
 *
 * 来源编号（sourceOrdinal）不在这里分配：由仓储层按 `sourceOrder`（**含并列来源**）统一编号后回填。
 */
export function assembleDocument(inputs: AssembleInputParagraph[]): AssembleResult {
  const kept: AssembledParagraph[] = []
  let duplicatesDropped = 0
  let conflictsKept = 0
  /** 跨来源合并掉的段数（诊断用：说明"同一件事两个来源"确实发生了） */
  let crossSourceMerged = 0
  /** 由「包含关系」判定合并掉的段数（Phase 7.12 新增规则，诊断用） */
  let containmentMerged = 0
  for (const input of inputs) {
    const text = (input.text ?? '').trim()
    if (!text) continue
    const parsed = parseTimeLabel(input.timeLabel)
    const draft: AssembledParagraph = {
      ordinal: kept.length,
      text,
      timeLabel: (input.timeLabel ?? '').trim() || undefined,
      year: parsed.year,
      month: parsed.month,
      day: parsed.day,
      timeConfidence: input.timeConfidence ?? parsed.confidence,
      sourceId: input.sourceId || undefined,
      sourceTitle: input.sourceTitle,
      alsoSourceIds: mergeAlsoSourceIds(input.sourceId || undefined, input.alsoSourceIds) ,
      evidence: input.evidence,
      kind: 'paragraph',
      revision: 1,
      origin: input.origin ?? 'generate',
      kept: true,
      parentIndex: input.parentIndex,
      charStart: input.charStart,
      charEnd: input.charEnd,
      anchorCandidates: ownAnchorCandidate({
        sourceId: input.sourceId || undefined,
        evidence: input.evidence,
        text,
        charStart: input.charStart,
        charEnd: input.charEnd
      })
    }
    if (draft.alsoSourceIds && draft.alsoSourceIds.length === 0) draft.alsoSourceIds = undefined
    const norm = normalizeForCompare(text)

    // ① 完全重复（去空白标点后相同，跨来源也算）→ 保留先出现者，另一处的来源记为并列来源
    const exactAt = kept.findIndex((p) => normalizeForCompare(p.text) === norm)
    if (exactAt >= 0) {
      const prev = kept[exactAt]
      prev.alsoSourceIds = mergeAlsoSourceIds(prev.sourceId, prev.alsoSourceIds, draft.alsoSourceIds, [draft.sourceId])
      prev.anchorCandidates = absorbAnchorCandidates(prev, draft)
      duplicatesDropped += 1
      continue
    }

    // ② 包含关系（逐字包含 + 数字一致）→ 保留信息更全（更长）的一条，另一条记为并列来源
    let decidedByContainment = false
    if (norm.length >= CONTAINMENT_MIN_CHARS) {
      const containAt = kept.findIndex((p) => {
        const pn = normalizeForCompare(p.text)
        return pn.length >= CONTAINMENT_MIN_CHARS && (pn.includes(norm) || norm.includes(pn))
      })
      if (containAt >= 0) {
        const prev = kept[containAt]
        const crossSource = (prev.sourceId ?? '') !== (draft.sourceId ?? '')
        const sameNumbers = numbersCoveredBy(text, prev.text) && numbersCoveredBy(prev.text, text)
        if (sameNumbers) {
          const draftLonger = norm.length > normalizeForCompare(prev.text).length
          if (draftLonger) {
            kept[containAt] = {
              ...draft,
              ordinal: prev.ordinal,
              alsoSourceIds: mergeAlsoSourceIds(draft.sourceId, draft.alsoSourceIds, prev.alsoSourceIds, [prev.sourceId]),
              anchorCandidates: absorbAnchorCandidates(draft, prev)
            }
          } else {
            prev.alsoSourceIds = mergeAlsoSourceIds(prev.sourceId, prev.alsoSourceIds, draft.alsoSourceIds, [draft.sourceId])
            prev.anchorCandidates = absorbAnchorCandidates(prev, draft)
          }
          duplicatesDropped += 1
          containmentMerged += 1
          if (crossSource) crossSourceMerged += 1
          continue
        }
        // 数字不一致 → 疑似矛盾，两段都留（下面照常 push）；同一对不再走 Dice，避免重复计数
        conflictsKept += 1
        decidedByContainment = true
      }
    }

    // ③ 近似重复：先在同一来源里找（阈值较松），找不到再跨来源找（阈值更严）
    if (!decidedByContainment) {
      const sameSourceAt = kept.findIndex(
        (p) => p.sourceId && p.sourceId === draft.sourceId && textSimilarity(p.text, text) >= NEAR_DUPLICATE_DICE
      )
      const crossSourceAt =
        sameSourceAt >= 0
          ? -1
          : kept.findIndex(
              (p) => p.sourceId && p.sourceId !== draft.sourceId && textSimilarity(p.text, text) >= NEAR_DUPLICATE_DICE_CROSS
            )
      const nearAt = sameSourceAt >= 0 ? sameSourceAt : crossSourceAt
      if (nearAt >= 0) {
        const prev = kept[nearAt]
        const sameNumbers = numbersCoveredBy(text, prev.text) && numbersCoveredBy(prev.text, text)
        if (sameNumbers) {
          // 数字一致 → 视为同一段的重复表述；仅当新文本真的**包含了**旧文本（信息更全）时才替换，否则保留先出现者
          if (text.length > prev.text.length && stripSpaces(text).includes(stripSpaces(prev.text))) {
            kept[nearAt] = {
              ...draft,
              ordinal: prev.ordinal,
              alsoSourceIds: mergeAlsoSourceIds(draft.sourceId, draft.alsoSourceIds, prev.alsoSourceIds, [prev.sourceId]),
              anchorCandidates: absorbAnchorCandidates(draft, prev)
            }
          } else {
            prev.alsoSourceIds = mergeAlsoSourceIds(prev.sourceId, prev.alsoSourceIds, draft.alsoSourceIds, [draft.sourceId])
            prev.anchorCandidates = absorbAnchorCandidates(prev, draft)
          }
          duplicatesDropped += 1
          if (crossSourceAt >= 0) crossSourceMerged += 1
          continue
        }
        // 数字不一致 → 疑似矛盾，两段都留（下面照常 push）
        conflictsKept += 1
      }
    }
    kept.push({ ...draft, ordinal: kept.length })
  }
  const sorted = sortParagraphsByTime(kept)
  const sourceOrder: string[] = []
  for (const p of sorted) {
    for (const sid of [p.sourceId, ...(p.alsoSourceIds ?? [])]) {
      if (sid && !sourceOrder.includes(sid)) sourceOrder.push(sid)
    }
  }
  return { paragraphs: sorted, sourceOrder, duplicatesDropped, conflictsKept, crossSourceMerged, containmentMerged }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('compilation document helpers (Phase 7.1 连续文档)', () => {
    it('parses a full date label with a year as exact', () => {
      expect(parseTimeLabel('2018 年 5 月 19 日')).toEqual({ year: 2018, month: 5, day: 19, confidence: 'exact', label: '2018 年 5 月 19 日' })
      expect(parseTimeLabel('2018年')).toMatchObject({ year: 2018, confidence: 'exact' })
      // 年份区间取起始年（排序键）
      expect(parseTimeLabel('2005—2010 年')).toMatchObject({ year: 2005, confidence: 'exact' })
    })

    it('keeps month/day but marks a label without a year as unknown', () => {
      expect(parseTimeLabel('5 月 19 日')).toMatchObject({ month: 5, day: 19, confidence: 'unknown' })
      expect(parseTimeLabel('7—9 日')).toMatchObject({ confidence: 'unknown' })
      expect(parseTimeLabel('十三五规划期间')).toMatchObject({ confidence: 'unknown' })
      expect(parseTimeLabel('')).toEqual({ confidence: 'unknown' })
      expect(parseTimeLabel(null)).toEqual({ confidence: 'unknown' })
    })

    /*
     * 2026-10-05 用户裁定（P0-1）：来源发布时间要作为**证据**注入提示词，所以需要一个"如实缩短"的展示格式。
     * 只截取、不做时区换算，取不到日期形态时原样返回（绝不瞎编）。
     */
    it('formatSourceDate 把 ISO 发布时间缩到「日」，取不到时原样返回', () => {
      expect(formatSourceDate('2021-05-06T00:00:00.000Z')).toBe('2021-05-06')
      expect(formatSourceDate('2021-05-06')).toBe('2021-05-06')
      expect(formatSourceDate('2021-05')).toBe('2021-05')
      expect(formatSourceDate('2021')).toBe('2021')
      expect(formatSourceDate('2021年5月6日')).toBe('2021')
      expect(formatSourceDate('')).toBe('')
      expect(formatSourceDate(undefined)).toBe('')
      // 取不到年份的数字串 → 原样返回（宁可显示原值，也不编一个日期）
      expect(formatSourceDate('未知')).toBe('未知')
    })

    it('renders one line per paragraph with the time label prefix', () => {
      expect(renderParagraphLine({ timeLabel: '2018 年', text: '全区普通中学 30 所。' })).toBe('2018 年　全区普通中学 30 所。')
      // 段内换行/制表符归一为单个空格（年鉴 PDF 抽出的正文常带表格残留），保证"一段一行"
      expect(renderParagraphLine({ text: '甲\n乙' })).toBe('甲 乙')
      expect(renderParagraphLine({ text: '【侨胞服务】 \t 2020 年，出具证明 12 份。' })).toBe('【侨胞服务】 2020 年，出具证明 12 份。')
      // 全角空格（时间与正文之间的分隔符）必须保留
      expect(renderParagraphLine({ timeLabel: '2018 年', text: '甲' })).toContain('　')
      const md = renderDocumentMarkdown([
        { timeLabel: '2018 年', text: '甲。', kind: 'paragraph' },
        { timeLabel: '2019 年', text: '乙。', kind: 'paragraph' }
      ])
      expect(md).toBe('2018 年　甲。\n2019 年　乙。')
      expect(md.split('\n')).toHaveLength(2)
    })

    it('summarizes added / removed / modified / moved paragraphs by id', () => {
      const mk = (id: string, ordinal: number, text: string): CompilationParagraph => ({
        id,
        ordinal,
        text,
        timeConfidence: 'exact',
        kind: 'paragraph',
        revision: 1,
        origin: 'generate',
        kept: true
      })
      const prev = [mk('p1', 0, '甲'), mk('p2', 1, '乙')]
      const next = [mk('p1', 0, '甲'), mk('p3', 1, '丙'), mk('p2', 0, '乙改')]
      const sum = summarizeParagraphChange(prev, next)
      expect(sum.added).toBe(1)
      expect(sum.removed).toBe(0)
      expect(sum.modified).toBe(1)
      expect(sum.moved).toBe(1)
      expect(sum.paragraphIds.sort()).toEqual(['p2', 'p3'])
      // 首版：全部计为新增
      expect(summarizeParagraphChange([], prev)).toMatchObject({ added: 2, removed: 0, modified: 0 })
    })

    it('sorts paragraphs by year → month → source ordinal → original order, unknown last', () => {
      const mk = (id: string, year: number | undefined, month: number | undefined, ordinal?: number): CompilationParagraph => ({
        id,
        ordinal: 0,
        text: id,
        year,
        month,
        timeConfidence: year == null ? 'unknown' : 'exact',
        sourceOrdinal: ordinal,
        kind: 'paragraph',
        revision: 1,
        origin: 'generate',
        kept: true
      })
      const sorted = sortParagraphsByTime([
        mk('b', 2019, 3),
        mk('unknown', undefined, undefined),
        mk('a', 2018, 5),
        mk('c', 2019, 1),
        mk('d', 2019, 3, 1)
      ])
      expect(sorted.map((p) => p.id)).toEqual(['a', 'c', 'd', 'b', 'unknown'])
      expect(sorted.map((p) => p.ordinal)).toEqual([0, 1, 2, 3, 4])
    })

    it('detects a year and locates verbatim evidence tolerating layout spaces (Phase 7.2)', () => {
      expect(hasYear('2018 年 5 月')).toBe(true)
      expect(hasYear('5 月 19 日')).toBe(false)
      expect(hasYear(null)).toBe(false)
      const src = '【概况】2018 年，全 区 普 通 中 学 30 所，在校生 1.2 万人。'
      expect(locateVerbatim(src, '全区普通中学 30 所')).not.toBeNull()
      expect(locateVerbatim(src, '在校生1.2万人')).not.toBeNull()
      expect(locateVerbatim(src, '全区小学 30 所')).toBeNull()
      expect(locateVerbatim(src, '   ')).toBeNull()
      // 回取的是原文真实区间（含排版空格）
      const hit = locateVerbatim(src, '全区普通中学')!
      expect(src.slice(hit.start, hit.end)).toBe('全 区 普 通 中 学')
    })

    it('checks that every number in a rewritten paragraph exists in the source (no invented facts)', () => {
      const src = '2018 年，全区普通中学 30 所，在校生 1.2 万人，教职工 900 人。'
      expect(numbersIn('2018 年 30 所 1.2 万人')).toEqual(['2018', '30', '1.2'])
      expect(numbersCoveredBy('全区普通中学 30 所，在校生 1.2 万人。', src)).toBe(true)
      // 千分位/小数点分隔差异容忍
      expect(numbersCoveredBy('教职工 900 人。', src)).toBe(true)
      // **整 token 比较**：`2` 不能因为出现在 `2018` 里就算"有依据"，`30` 也不能由 `130` 蒙混
      expect(numbersCoveredBy('其中独立高中 2 所。', '2018 年，全区普通中学 30 所，其中独立高中 1 所。')).toBe(false)
      expect(numbersCoveredBy('全区共 130 所。', '全区共 30 所。')).toBe(false)
      expect(numbersCoveredBy('在校生 1.2 万人。', src)).toBe(true)
      // 编造的数字必须被拦住（这是"允许自由整合"的底线）
      expect(numbersCoveredBy('全区普通中学 32 所。', src)).toBe(false)
      expect(numbersCoveredBy('2019 年，全区普通中学 30 所。', src)).toBe(false)
      // 无数字的改写（补主语、删无关内容）放行
      expect(numbersCoveredBy('普通中学共 30 所。', src)).toBe(true)
    })

    it('validates an extracted paragraph: empty text / missing evidence / invented numbers are rejected', () => {
      const src = '2018 年，全区普通中学 30 所。另：幼儿园 89 所。'
      const ok = validateExtractedParagraph(
        { sourceRef: '#1', text: '2018 年，全区普通中学 30 所。', timeLabel: '2018 年', evidence: '全区普通中学 30 所' },
        src
      )
      expect(ok.ok).toBe(true)
      if (ok.ok) {
        expect(ok.year).toBe(2018)
        expect(ok.timeConfidence).toBe('exact')
        expect(ok.evidence).toBe('全区普通中学 30 所')
      }
      // 时间**不再本地复核**：模型自报的 confidence 一律采信（用户裁定），解析只用于排序与界面提示
      const pending = validateExtractedParagraph(
        { sourceRef: '#1', text: '7—9 日开展招生宣传。', timeLabel: '7—9 日', confidence: 'exact', evidence: '7—9 日' },
        '7—9 日开展招生宣传。'
      )
      expect(pending.ok).toBe(true)
      if (pending.ok) {
        expect(pending.timeConfidence).toBe('exact')
        expect(pending.year).toBeUndefined()
        expect(pending.timeLabel).toBe('7—9 日')
      }
      const inferred = validateExtractedParagraph(
        { sourceRef: '#1', text: '2018 年，全区普通中学 30 所。', timeLabel: '2018 年', confidence: '推断', evidence: '全区普通中学 30 所' },
        src
      )
      if (inferred.ok) {
        expect(inferred.timeConfidence).toBe('inferred')
        expect(inferred.year).toBe(2018)
      }
      // 模型没给 confidence 但有标签 → 视为 exact
      const noConfidence = validateExtractedParagraph(
        { sourceRef: '#1', text: '2018 年，全区普通中学 30 所。', timeLabel: '2018 年', evidence: '全区普通中学 30 所' },
        src
      )
      if (noConfidence.ok) expect(noConfidence.timeConfidence).toBe('exact')
      expect(validateExtractedParagraph({ sourceRef: '#1', text: '  ' }, src)).toEqual({ ok: false, reason: 'empty-text' })
      /*
       * 2026-10-03 用户裁定：**证据不再是门槛**——事实逐句核验通过就接受，
       * 只是把非逐字的 evidence 丢掉并记 `evidenceLoose`（证据降为充分度之一）。
       */
      const loose = validateExtractedParagraph({ sourceRef: '#1', text: '普通中学 30 所。', evidence: '这段原文里没有' }, src)
      expect(loose.ok).toBe(true)
      if (loose.ok) {
        expect(loose.evidence).toBeUndefined()
        expect(loose.evidenceLoose).toBe(true)
      }
      const noEvidence = validateExtractedParagraph({ sourceRef: '#1', text: '普通中学 30 所。' }, src)
      expect(noEvidence.ok).toBe(true)
      // 但**事实无据**仍然拒绝（把无关数字删掉不会失败，写来源里没有的数字一定失败）
      expect(
        validateExtractedParagraph({ sourceRef: '#1', text: '全区普通中学 32 所。', evidence: '全区普通中学 30 所' }, src)
      ).toEqual({ ok: false, reason: 'number-not-in-source' })
      // 数字等价类：量级折算 / 中文数字 / 舍入（用户裁定"形式变化不该被误杀"）
      expect(validateExtractedParagraph({ sourceRef: '#1', text: '2018 年，普通中学共三十所。' }, src).ok).toBe(true)
      const money = '项目总投资 5.09 亿元。'
      expect(validateExtractedParagraph({ sourceRef: '#1', text: '项目总投资 50900 万元。' }, money).ok).toBe(true)
      expect(validateExtractedParagraph({ sourceRef: '#1', text: '项目总投资约 5.1 亿元。' }, money).ok).toBe(true)
      expect(validateExtractedParagraph({ sourceRef: '#1', text: '项目总投资 5.9 亿元。' }, money).ok).toBe(false)
    })

    it('infers a fallback year from the source title (年鉴年份 − 1) when the label has no year', () => {
      // 年鉴惯例：《长乐年鉴2019》记述的是 2018 年（**只对年鉴/年报类标题生效**）
      expect(inferYearFromSourceTitle('长乐年鉴2019')).toBe(2018)
      expect(inferYearFromSourceTitle('长乐年鉴2023（完整版）.pdf')).toBe(2022)
      expect(inferYearFromSourceTitle('教育发展报告')).toBeUndefined()
      expect(inferYearFromSourceTitle(undefined)).toBeUndefined()
      // 非年鉴标题（含网页新闻标题）不走 −1：年份指的就是内容年
      expect(inferYearFromSourceTitle('2021年全区教育工作总结')).toBeUndefined()

      // 有年份 → exact，原样保留（依据记为 text）
      expect(withFallbackYear('2018 年 5 月', '长乐年鉴2020', { kind: 'file' })).toEqual({
        timeLabel: '2018 年 5 月',
        year: 2018,
        month: 5,
        day: undefined,
        timeConfidence: 'exact',
        basis: 'text'
      })
      /*
       * 缺年份 + 标题可推断 → inferred，并补出年份（带月份时保留月日）。
       * ⚠ 2026-10-05 用户裁定后必须显式传 `kind: 'file'`：年鉴 −1 只对**本地年鉴类文件**生效，
       * 不传 kind 时按"来源类型未知"处理 → 不走 −1（这正是"网页被减 1"那个缺陷的根治方式）。
       */
      expect(withFallbackYear('5 月 19 日', '长乐年鉴2019', { kind: 'file' })).toEqual({
        timeLabel: '2018 年 5 月 19 日',
        year: 2018,
        month: 5,
        day: 19,
        timeConfidence: 'inferred',
        basis: 'title-yearbook'
      })
      // 只有日（缺月份本身已无意义）→ 只写年份
      expect(withFallbackYear('29 日', '长乐年鉴2019', { kind: 'file' })).toMatchObject({ timeLabel: '2018 年', timeConfidence: 'inferred' })
      expect(withFallbackYear(undefined, '长乐年鉴2019', { kind: 'file' })).toMatchObject({ timeLabel: '2018 年', timeConfidence: 'inferred' })
      // 同一份年鉴标题、但来源是**网页**时不得 −1：年份按内容年原样采用（这条差异就是本次修复的可见效果）
      expect(inferYearFromSource({ title: '长乐年鉴2019', kind: 'file' })).toEqual({ year: 2018, basis: 'title-yearbook' })
      expect(inferYearFromSource({ title: '长乐年鉴2019', kind: 'url' })).toEqual({ year: 2019, basis: 'title' })
      // 网页标题里没有年份 → 推不出就是推不出（如实留空，不编造）
      expect(inferYearFromSource({ title: '长乐年鉴（未标年份）', kind: 'url' })).toBeUndefined()
      // 标题也推断不出 → 保持 unknown（不编造）
      expect(withFallbackYear('7—9 日', '教育发展报告')).toMatchObject({ timeConfidence: 'unknown' })
    })

    it('infers the year for web sources without applying the yearbook −1 rule (Phase 7.7 网页第一批 + 2026-10-05 裁定)', () => {
      // ① 网页新闻标题里的年份 = 内容年，**不减 1**（旧实现会推成 2020，静默错年）
      expect(inferYearFromSource({ title: '2021年全区教育工作总结', kind: 'url' })).toEqual({ year: 2021, basis: 'title' })
      // ② 网页标题没有年份 → 用发布时间（网页正文常用「近日/今年」，这是唯一依据）
      expect(inferYearFromSource({ title: '全区教育工作会议召开', kind: 'url', publishedAt: '2021-03-05T00:00:00.000Z' })).toEqual({
        year: 2021,
        basis: 'published'
      })
      // ③ 标题里有年份时**标题优先于发布时间**（内容年比发布年更贴近事实）
      expect(inferYearFromSource({ title: '2020年工作总结', kind: 'url', publishedAt: '2021-03-05' })).toEqual({
        year: 2020,
        basis: 'title'
      })
      /*
       * ④ 2026-10-05 用户裁定（本轮 P0-1 修复）：**网页来源一律不做年鉴 −1**。
       * 旧行为是"只按标题判断年鉴"，于是 `kind === 'url'` 且标题含「年鉴」时也会 −1（期望 2024），
       * 用户实测到的正是这类整片错年：同一站点既发新闻也发年鉴，网页版年鉴页的标题年份被减 1。
       * −1 是"年度出版物次年产出的体例"，只对**本地文件**成立 → 网页标题里的年份按内容年原样采用。
       */
      expect(inferYearFromSource({ title: '福州新区年鉴（2025）', kind: 'url' })).toEqual({ year: 2025, basis: 'title' })
      // 网页标题里没有年份时也不 −1，只能靠发布时间
      expect(inferYearFromSource({ title: '福州新区年鉴', kind: 'url' })).toBeUndefined()
      expect(inferYearFromSource({ title: '福州新区年鉴', kind: 'url', publishedAt: '2025-06-01' })).toEqual({
        year: 2025,
        basis: 'published'
      })
      // ⑤ 本地文件里出现年份也不再一律 −1（只有年鉴类才 −1）
      expect(inferYearFromSource({ title: '2019年教育统计表.xlsx', kind: 'file' })).toEqual({ year: 2019, basis: 'title' })
      // ⑤b 本地**年鉴/年报/志书类**文件仍按惯例 −1（−1 没有被取消，只是收窄到本地文件）
      expect(inferYearFromSource({ title: '长乐年鉴2019.pdf', kind: 'file' })).toEqual({ year: 2018, basis: 'title-yearbook' })
      expect(inferYearFromSource({ title: '2019年教育年度报告.docx', kind: 'file' })).toEqual({
        year: 2018,
        basis: 'title-yearbook'
      })
      // ⑥ 本地文件不会用发布时间兜底（文件没有"发布时间"概念）
      expect(inferYearFromSource({ title: '教育发展报告', kind: 'file', publishedAt: '2021-03-05' })).toBeUndefined()
      // ⑦ 都没有 → 不编造
      expect(inferYearFromSource({ title: '教育发展报告', kind: 'url' })).toBeUndefined()

      // 落到段首时间兜底：网页段落缺年份时按发布时间补，标 inferred
      expect(withFallbackYear('近日', '全区教育工作会议召开', { kind: 'url', publishedAt: '2021-03-05' })).toMatchObject({
        timeLabel: '2021 年',
        year: 2021,
        timeConfidence: 'inferred',
        basis: 'published'
      })
      expect(withFallbackYear('', '2021年全区教育工作总结', { kind: 'url', publishedAt: '2022-01-20' })).toMatchObject({
        timeLabel: '2021 年',
        year: 2021,
        basis: 'title'
      })
      expect(withFallbackYear('近日', '教育发展报告', { kind: 'url' })).toMatchObject({ timeConfidence: 'unknown' })
    })

    it('assembles a document: dedupes duplicates, keeps conflicting numbers, sorts and numbers sources', () => {
      const inputs = [
        { text: '2020 年，全区幼儿园 212 所。', timeLabel: '2020 年', sourceId: 's2', parentIndex: 2 },
        { text: '7—9 日开展招生宣传。', timeLabel: '7—9 日', sourceId: 's1', parentIndex: 4 },
        { text: '2018 年，全区普通中学 30 所，其中独立高中 1 所。', timeLabel: '2018 年', sourceId: 's1', parentIndex: 0 },
        // 同来源、改一两个字的重复表述（数字一致）→ 视为重复丢弃
        { text: '2018 年，全区普通中学 30 所，其中有独立高中 1 所。', timeLabel: '2018 年', sourceId: 's1', parentIndex: 1 },
        // 同来源、极相似但**数字不一致** → 疑似矛盾说法，两段都必须保留（绝不在此合并）
        { text: '2018 年，全区普通中学 30 所，其中独立高中 2 所。', timeLabel: '2018 年', sourceId: 's1', parentIndex: 5 },
        // 仅空白差异 → 归一化后完全相同，去重
        { text: '2018 年，全区普通中学 30 所，其中独立高中 1 所。  ', timeLabel: '2018 年', sourceId: 's1', parentIndex: 6 }
      ]
      const out = assembleDocument(inputs)
      // 排序：2018（s1）在前 → 2020（s2）→ 缺年份沉底
      expect(out.paragraphs.map((p) => p.year)).toEqual([2018, 2018, 2020, undefined])
      expect(out.paragraphs[0].text).toBe('2018 年，全区普通中学 30 所，其中独立高中 1 所。')
      expect(out.paragraphs[1].text).toBe('2018 年，全区普通中学 30 所，其中独立高中 2 所。')
      expect(out.duplicatesDropped).toBe(2)
      expect(out.conflictsKept).toBe(1)
      // 来源编号顺序：排序后首次引用顺序
      expect(out.sourceOrder).toEqual(['s1', 's2'])
      expect(out.paragraphs.map((p) => p.ordinal)).toEqual([0, 1, 2, 3])
      // 缺年份段保留原标签，但可信度为 unknown
      expect(out.paragraphs[3].timeConfidence).toBe('unknown')
      expect(out.paragraphs[3].timeLabel).toBe('7—9 日')
      // 空正文不入文
      expect(assembleDocument([{ text: '   ', sourceId: 's1', parentIndex: 0 }]).paragraphs).toHaveLength(0)
    })

    it('merges the same fact across sources when the numbers match (2026-09-12 第二批)', () => {
      /*
       * 网页转载 / 网站版与工作区同文档：同一件事被两个来源分别收录。
       * 跨来源阈值更严（0.92），且**数字必须完全一致**才合并。
       * Phase 7.12 起：合并后主来源不变，另一处出处记入 `alsoSourceIds`（见下一个用例）。
       */
      const out = assembleDocument([
        { text: '2021 年，全区新增幼儿园 6 所，公办园占比 42%。', timeLabel: '2021 年', sourceId: 's1', parentIndex: 0 },
        { text: '2021 年，全区新增幼儿园 6 所，公办园占比达 42%。', timeLabel: '2021 年', sourceId: 's2', parentIndex: 1 }
      ])
      expect(out.paragraphs).toHaveLength(1)
      expect(out.duplicatesDropped).toBe(1)
      expect(out.crossSourceMerged).toBe(1)
      expect(out.paragraphs[0].sourceId).toBe('s1') // 保留先出现者作为主来源
      expect(out.paragraphs[0].alsoSourceIds).toEqual(['s2']) // 另一处出处被标注，而不是被丢掉
    })

    it('never merges across sources when the numbers differ — that is a contradiction', () => {
      const out = assembleDocument([
        { text: '2021 年，全区新增幼儿园 6 所，公办园占比 42%。', timeLabel: '2021 年', sourceId: 's1', parentIndex: 0 },
        { text: '2021 年，全区新增幼儿园 7 所，公办园占比 42%。', timeLabel: '2021 年', sourceId: 's2', parentIndex: 1 }
      ])
      // 数字不一致 → 两段都留（交给矛盾扫描）；绝不因为"长得像"就合并掉一个说法
      expect(out.paragraphs).toHaveLength(2)
      expect(out.paragraphs.map((p) => p.sourceId)).toEqual(['s1', 's2'])
      expect(out.crossSourceMerged).toBe(0)
    })

    it('keeps slightly-similar but genuinely different cross-source paragraphs (threshold 0.92)', () => {
      const out = assembleDocument([
        { text: '2021 年，全区新增幼儿园 6 所，其中城区 3 所。', timeLabel: '2021 年', sourceId: 's1', parentIndex: 0 },
        { text: '2021 年，全区新增幼儿园 6 所，另外还改扩建 2 所。', timeLabel: '2021 年', sourceId: 's2', parentIndex: 1 }
      ])
      // 措辞接近但讲的是不同的事（数字集合也不同）→ 不合并
      expect(out.paragraphs).toHaveLength(2)
      expect(out.crossSourceMerged).toBe(0)
    })

    it('合并后记录并列来源，另一处出处不再丢失（Phase 7.12 S1）', () => {
      const out = assembleDocument([
        { text: '2021 年，全区新增幼儿园 6 所，公办园占比 42%。', timeLabel: '2021 年', sourceId: 's1', parentIndex: 0 },
        { text: '2021 年，全区新增幼儿园 6 所，公办园占比达 42%。', timeLabel: '2021 年', sourceId: 's2', parentIndex: 1 },
        { text: '2021 年，全区新增幼儿园 6 所，公办园占比42%。', timeLabel: '2021 年', sourceId: 's3', parentIndex: 2 }
      ])
      expect(out.paragraphs).toHaveLength(1)
      // 主来源仍是先出现者（evidence 逐字校验与矛盾归因都以它为准）
      expect(out.paragraphs[0].sourceId).toBe('s1')
      // 另外两个出处被记为并列来源，不再被静默丢掉
      expect(out.paragraphs[0].alsoSourceIds).toEqual(['s2', 's3'])
      // 并列来源也要进编号顺序，否则界面显示不出它们的编号
      expect(out.sourceOrder).toEqual(['s1', 's2', 's3'])
    })

    it('包含关系（数字一致）→ 合并并保留信息更全的一条，另一条记为并列来源', () => {
      const out = assembleDocument([
        { text: '融侨国际双语学校奠基仪式举行。', timeLabel: '2019 年', sourceId: 's1', parentIndex: 0 },
        { text: '融侨国际双语学校奠基仪式举行，市领导及相关部门负责人参加活动。', timeLabel: '2019 年', sourceId: 's2', parentIndex: 1 }
      ])
      // 短句被长句逐字包含时 Dice 只有约 0.6，旧口径判不出来 → 这是本规则补上的缺口
      expect(out.paragraphs).toHaveLength(1)
      expect(out.containmentMerged).toBe(1)
      expect(out.paragraphs[0].text).toBe('融侨国际双语学校奠基仪式举行，市领导及相关部门负责人参加活动。')
      expect(out.paragraphs[0].sourceId).toBe('s2')
      expect(out.paragraphs[0].alsoSourceIds).toEqual(['s1'])
    })

    it('包含关系但数字不一致 → 两段都保留（「数字不一致一律保留」这条底线不动）', () => {
      const out = assembleDocument([
        { text: '2024 年，长乐区新增公办普高学位近 800 个。', timeLabel: '2024 年', sourceId: 's1', parentIndex: 0 },
        { text: '2024 年，长乐区新增公办普高学位近 800 个，投入 2147 万元落实免学费政策。', timeLabel: '2024 年', sourceId: 's2', parentIndex: 1 }
      ])
      // 长句多出的 2147 万元是新信息 → 不能因为"短句被包含"就把它吞掉
      expect(out.paragraphs).toHaveLength(2)
      expect(out.containmentMerged).toBe(0)
      expect(out.conflictsKept).toBe(1)
    })

    it('太短的包含关系不合并（避免把短语并进长段）', () => {
      const out = assembleDocument([
        { text: '长乐一中。', timeLabel: '2019 年', sourceId: 's1', parentIndex: 0 },
        { text: '长乐一中新校区已于 2019 年投入使用。', timeLabel: '2019 年', sourceId: 's2', parentIndex: 1 }
      ])
      expect(out.paragraphs).toHaveLength(2)
      expect(out.containmentMerged).toBe(0)
    })

    it('不同主体的同形句绝不合并（0.85–0.92 区间不降阈值的回归护栏，2026-10-02 实测）', () => {
      const out = assembleDocument([
        { text: '长乐七中教学综合楼项目投资1200万元新建教学综合楼。', timeLabel: '2020 年', sourceId: 's1', parentIndex: 0 },
        { text: '长乐三中教学综合楼项目投资1200万元新建教学综合楼。', timeLabel: '2020 年', sourceId: 's2', parentIndex: 1 },
        { text: '长乐一中首占校区的学生宿舍楼工程已完工。', timeLabel: '2021 年', sourceId: 's1', parentIndex: 2 },
        { text: '长乐二中首占校区的学生宿舍楼工程已完工。', timeLabel: '2021 年', sourceId: 's2', parentIndex: 3 }
      ])
      // 实测这两对的 Dice 分别是 0.905 / 0.889、数字完全一致：
      // 若把跨来源阈值降到 0.85，会把"三中"的材料并进"七中"、静默丢材料，因此阈值保持 0.92
      expect(out.paragraphs).toHaveLength(4)
      expect(out.duplicatesDropped).toBe(0)
    })

    it('定位候选：每条合并路径都要把"被合并来源自己的文字"带上（Phase 9 / S3 修复）', () => {
      // 不变量：候选来源集合 ⊇ {主来源} ∪ 并列来源 —— 漏一条合并路径就会在这里失败
      const invariant = (ps: ReturnType<typeof assembleDocument>['paragraphs']): void => {
        for (const p of ps) {
          const have = new Set((p.anchorCandidates ?? []).map((c) => c.sourceId))
          for (const sid of [p.sourceId, ...(p.alsoSourceIds ?? [])]) expect(have.has(sid as string)).toBe(true)
          // 并列来源的候选文字必须是**它自己**那一段的文字，而不是合并后的正文
          for (const c of p.anchorCandidates ?? []) expect(c.excerpt.length).toBeGreaterThan(0)
        }
      }
      // ① 完全重复
      const exact = assembleDocument([
        { text: '长乐一中新校区投入使用。', timeLabel: '2019 年', sourceId: 's1', evidence: '长乐一中新校区投入使用', parentIndex: 0 },
        { text: '长乐一中新校区投入使用。', timeLabel: '2019 年', sourceId: 's2', evidence: '新校区投入使用', parentIndex: 1 }
      ])
      invariant(exact.paragraphs)
      expect(exact.paragraphs[0].anchorCandidates?.map((c) => c.sourceId)).toEqual(['s1', 's2'])
      expect(exact.paragraphs[0].anchorCandidates?.[1].evidence).toBe('新校区投入使用')
      // ② 包含关系（替换 / 吸收两个方向）
      invariant(
        assembleDocument([
          { text: '融侨国际双语学校奠基仪式举行。', timeLabel: '2019 年', sourceId: 's1', parentIndex: 0 },
          { text: '融侨国际双语学校奠基仪式举行，市领导及相关部门负责人参加活动。', timeLabel: '2019 年', sourceId: 's2', parentIndex: 1 }
        ]).paragraphs
      )
      invariant(
        assembleDocument([
          { text: '融侨国际双语学校奠基仪式举行，市领导及相关部门负责人参加活动。', timeLabel: '2019 年', sourceId: 's1', parentIndex: 0 },
          { text: '融侨国际双语学校奠基仪式举行。', timeLabel: '2019 年', sourceId: 's2', parentIndex: 1 }
        ]).paragraphs
      )
      // ③ 近似重复（Dice ≥ 0.92、数字一致）：替换 / 吸收两个方向
      invariant(
        assembleDocument([
          { text: '2020 年，全区新增幼儿园 3 所，投入 100 万元。', timeLabel: '2020 年', sourceId: 's1', parentIndex: 0 },
          { text: '2020 年，全区新增幼儿园 3 所，共计投入 100 万元。', timeLabel: '2020 年', sourceId: 's2', parentIndex: 1 }
        ]).paragraphs
      )
      invariant(
        assembleDocument([
          { text: '2020 年，全区新增幼儿园 3 所，共计投入 100 万元。', timeLabel: '2020 年', sourceId: 's1', parentIndex: 0 },
          { text: '2020 年，全区新增幼儿园 3 所，投入 100 万元。', timeLabel: '2020 年', sourceId: 's2', parentIndex: 1 }
        ]).paragraphs
      )
      // 未合并的段也要带自己的候选
      const plain = assembleDocument([{ text: '甲。', sourceId: 's9', evidence: '甲', parentIndex: 0 }])
      invariant(plain.paragraphs)
      expect(plain.paragraphs[0].anchorCandidates).toEqual([{ sourceId: 's9', evidence: '甲', excerpt: '甲。' }])
    })

    it('detects title-only paragraphs and unsupported years (2026-09-12 用户实测回归)', () => {
      // 段落就是标题复述（含只比标题多几个连接词）→ 判为标题型
      expect(isTitleOnlyParagraph('长乐新添一所普通高中，将于9月开学。', '长乐新添一所普通高中！将于9月开学！')).toBe(true)
      expect(isTitleOnlyParagraph('长乐将新增一所高中', '今日获批！36个班！长乐将新增一所高中！')).toBe(true)
      // 同词不同序的标题复述（真实模型输出）→ 由相似度规则兜住
      expect(isTitleOnlyParagraph('长乐将新增一所高中，已获批准，办学规模为36个班。', '今日获批！36个班！长乐将新增一所高中！')).toBe(true)
      expect(isTitleOnlyParagraph('长乐将新建一所高中，可容纳3000名学生。', '可容3000名学生！长乐将新建一所高中！')).toBe(true)
      // 段落带来了正文信息（校名/规模/地点）→ 放行
      expect(
        isTitleOnlyParagraph(
          '福州市福外高级中学是全日制民办普通高级中学，设计规模为高中3个年级60个班，可容纳3000名学生。',
          '长乐新添一所普通高中！将于9月开学！'
        )
      ).toBe(false)
      expect(isTitleOnlyParagraph('长乐区普通高中招生录取3625人。', '长乐区2020年教育事业发展情况')).toBe(false)

      // 年份有据：出现在正文里 / 等于网页发布时间 / 等于年鉴 −1 推断年 → 放行
      expect(isYearSupportedBySource(2023, { text: '项目自2022年9月开工…2023年投用' })).toBe(true)
      expect(isYearSupportedBySource(2023, { text: '预计今年9月开学', kind: 'url', publishedAt: '2023-03-07' })).toBe(true)
      expect(isYearSupportedBySource(2018, { text: '无年份正文', title: '长乐年鉴2019', kind: 'file' })).toBe(true)
      // 年份在正文里查不到、也不来自任何合法推断依据 → 无据（实测：正文无 2019 的文章被标成 2019 年）
      expect(
        isYearSupportedBySource(2019, {
          text: '预计今年9月开学',
          kind: 'url',
          publishedAt: '2023-03-07',
          title: '长乐新添一所普通高中！将于9月开学！'
        })
      ).toBe(false)
      expect(isYearSupportedBySource(2021, { text: '学校规划办学规模60个班3000人', kind: 'url', publishedAt: '2022-11-07' })).toBe(false)
    })
  })
}
