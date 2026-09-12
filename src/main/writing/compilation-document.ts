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

/** 数字 token 归一（去千分位逗号；小数点保留，避免把 `1.2` 误当成 `12`） */
function normalizeNumberToken(token: string): string {
  return token.replace(/,/g, '')
}

/**
 * 正文里出现的每个数字是否都能在来源原文中找到。
 * 采用**整 token 相等**比较（不是子串包含）——否则 `2` 会被 `2018` 里的字符蒙混过关、
 * `30` 会被 `130` 蒙混过关，等于给"编造数字"留了后门。容忍 `1,234` 与 `1234` 这类千分位差异。
 * 这是"整合提取可以自由裁剪，但**不得改写事实、不得编造数字**"的本地硬校验。
 */
export function numbersCoveredBy(text: string, sourceText: string): boolean {
  const srcTokens = new Set(numbersIn(sourceText).map(normalizeNumberToken))
  for (const token of numbersIn(text)) {
    if (!srcTokens.has(normalizeNumberToken(token))) return false
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
 * 1. 年鉴/年报类标题 → 标题年份 − 1（`title-yearbook`，地方志行业惯例）；
 * 2. 其它标题里出现的年份 → **原样采用**（`title`；新闻标题《2021年全区教育工作总结》指的就是 2021 年）；
 * 3. 网页来源（kind='url'）且解析到发布时间 → 发布时间年份（`published`；网页正文常用「近日/今年」，
 *    标题里也没年份时这是唯一可靠依据）；
 * 4. 都推不出 → undefined（保持「时间待核」，**不编造**）。
 * 注：标题若本身就是 URL/域名则**跳过第 1、2 条**——`/202512/t20251203_xxx.htm` 这类数字不是内容年份。
 */
export function inferYearFromSource(source: {
  title?: string | null
  kind?: 'file' | 'url'
  publishedAt?: string | null
}): InferredYear | undefined {
  const titleUsable = !looksLikeUrl(source.title)
  if (titleUsable) {
    const yearbook = inferYearFromSourceTitle(source.title)
    if (yearbook != null) return { year: yearbook, basis: 'title-yearbook' }
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

/** 段落校验失败的原因（失败即降级保留原文整段，并计入诊断） */
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
    }
  | { ok: false; reason: ParagraphRejectReason }

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
 * 校验一段整合提取结果（纯函数）：
 * ① 正文非空；② `evidence` 必须是来源原文中逐字连续的一段；③ 正文里的数字必须都能在来源原文中找到。
 * **时间不再参与校验**（用户裁定：只靠提示词规范时间格式，不再本地复核），仅解析出结构化 year/month/day 供排序，
 * 并把模型自报的 confidence 原样透出。
 * 任一条不过 → 返回失败原因，调用方**降级保留可定位的原文**（见 extract-service，优先 evidence 片段）。
 */
export function validateExtractedParagraph(draft: ExtractedParagraphDraft, sourceText: string): ParagraphValidation {
  const text = (draft.text ?? '').trim()
  if (!text) return { ok: false, reason: 'empty-text' }
  const evidenceRaw = (draft.evidence ?? '').trim()
  if (!evidenceRaw || !locateVerbatim(sourceText, evidenceRaw)) return { ok: false, reason: 'evidence-not-found' }
  if (!numbersCoveredBy(text, sourceText)) return { ok: false, reason: 'number-not-in-source' }
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
    evidence: evidenceRaw
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
  evidence?: string
  origin?: CompilationParagraphOrigin
  /** 该段来自本批的第几个候选（用于窗口级矛盾说法的映射与诊断） */
  parentIndex: number
}

/** 成文输出的一段（尚无数据库 id：由仓储层 upsert 时分配/复用） */
export type AssembledParagraph = Omit<CompilationParagraph, 'id'> & { parentIndex: number }

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
}

/** 近似重复判定阈值（同来源、数字一致时才视为重复；略低以覆盖"改一两个字"的重复表述） */
export const NEAR_DUPLICATE_DICE = 0.85

/**
 * 跨来源近似重复阈值（更严）：不同来源措辞接近，比同一来源更容易是"两件不同的事"，
 * 因此只在非常接近、且**数字完全一致**时才合并（合并后只保留一个来源，见 assembleDocument 注释）。
 */
export const NEAR_DUPLICATE_DICE_CROSS = 0.92

/**
 * 把各批「整合提取」结果拼成一篇文档（纯函数）：
 * ① 完全重复（去空白标点后相同）→ 保留信息更全的一条（**跨来源也算重复**）；
 * ② 近似重复（Dice 相似）→ **数字一致**才算重复（保留更长的一条）；
 *    **数字不一致则两段都保留** —— 这是"疑似矛盾的说法"，绝不能在这里被合并掉，交给矛盾扫描处理；
 *    跨来源（网页转载、网站版与工作区同文档）用更严格的阈值 `NEAR_DUPLICATE_DICE_CROSS`：
 *    同一件事被两个来源分别收录时只留一处（2026-09-12 用户立项的第二批），但阈值更保守，
 *    因为"不同来源措辞接近"比"同一来源措辞接近"更容易是两件不同的事；
 * ③ 按 `年 → 月 → 生成序` 稳定排序，并重写 ordinal（无年份的段落沉底）。
 * 来源编号（sourceOrdinal）不在这里分配：由仓储层按 `sourceOrder` 统一编号后回填，保证"只增不回收"。
 * 注：合并后只保留**一个**来源（段落模型是单一来源）；"合并后标注多个来源"属 Phase 7.12，尚未设计。
 */
export function assembleDocument(inputs: AssembleInputParagraph[]): AssembleResult {
  const kept: AssembledParagraph[] = []
  let duplicatesDropped = 0
  let conflictsKept = 0
  /** 跨来源合并掉的段数（诊断用：说明"同一件事两个来源"确实发生了） */
  let crossSourceMerged = 0
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
      evidence: input.evidence,
      kind: 'paragraph',
      revision: 1,
      origin: input.origin ?? 'generate',
      kept: true,
      parentIndex: input.parentIndex
    }
    const norm = normalizeForCompare(text)
    const exactAt = kept.findIndex((p) => normalizeForCompare(p.text) === norm)
    if (exactAt >= 0) {
      // 归一化后完全相同（差异只在空白/标点）→ 保留先出现者
      duplicatesDropped += 1
      continue
    }
    // 先在同一来源里找近似重复（阈值较松），找不到再跨来源找（阈值更严）
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
          kept[nearAt] = { ...draft, ordinal: prev.ordinal }
        }
        duplicatesDropped += 1
        if (crossSourceAt >= 0) crossSourceMerged += 1
        continue
      }
      // 数字不一致 → 疑似矛盾，两段都留（下面照常 push）
      conflictsKept += 1
    }
    kept.push({ ...draft, ordinal: kept.length })
  }
  const sorted = sortParagraphsByTime(kept)
  const sourceOrder: string[] = []
  for (const p of sorted) {
    if (p.sourceId && !sourceOrder.includes(p.sourceId)) sourceOrder.push(p.sourceId)
  }
  return { paragraphs: sorted, sourceOrder, duplicatesDropped, conflictsKept, crossSourceMerged }
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
      expect(
        validateExtractedParagraph({ sourceRef: '#1', text: '普通中学 30 所。', evidence: '这段原文里没有' }, src)
      ).toEqual({ ok: false, reason: 'evidence-not-found' })
      expect(validateExtractedParagraph({ sourceRef: '#1', text: '普通中学 30 所。' }, src)).toEqual({
        ok: false,
        reason: 'evidence-not-found'
      })
      expect(
        validateExtractedParagraph({ sourceRef: '#1', text: '全区普通中学 32 所。', evidence: '全区普通中学 30 所' }, src)
      ).toEqual({ ok: false, reason: 'number-not-in-source' })
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
      expect(withFallbackYear('2018 年 5 月', '长乐年鉴2020')).toEqual({
        timeLabel: '2018 年 5 月',
        year: 2018,
        month: 5,
        day: undefined,
        timeConfidence: 'exact',
        basis: 'text'
      })
      // 缺年份 + 标题可推断 → inferred，并补出年份（带月份时保留月日）
      expect(withFallbackYear('5 月 19 日', '长乐年鉴2019')).toEqual({
        timeLabel: '2018 年 5 月 19 日',
        year: 2018,
        month: 5,
        day: 19,
        timeConfidence: 'inferred',
        basis: 'title-yearbook'
      })
      // 只有日（缺月份本身已无意义）→ 只写年份
      expect(withFallbackYear('29 日', '长乐年鉴2019')).toMatchObject({ timeLabel: '2018 年', timeConfidence: 'inferred' })
      expect(withFallbackYear(undefined, '长乐年鉴2019')).toMatchObject({ timeLabel: '2018 年', timeConfidence: 'inferred' })
      // 标题也推断不出 → 保持 unknown（不编造）
      expect(withFallbackYear('7—9 日', '教育发展报告')).toMatchObject({ timeConfidence: 'unknown' })
    })

    it('infers the year for web sources without applying the yearbook −1 rule (Phase 7.7 网页第一批)', () => {
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
      // ④ 网页年鉴页仍按年鉴惯例 −1（同一站点既发新闻也发年鉴）
      expect(inferYearFromSource({ title: '福州新区年鉴（2025）', kind: 'url' })).toEqual({ year: 2024, basis: 'title-yearbook' })
      // ⑤ 本地文件里出现年份也不再一律 −1（只有年鉴类才 −1）
      expect(inferYearFromSource({ title: '2019年教育统计表.xlsx', kind: 'file' })).toEqual({ year: 2019, basis: 'title' })
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
       * 跨来源阈值更严（0.92），且**数字必须完全一致**才合并——合并后只留一个来源。
       */
      const out = assembleDocument([
        { text: '2021 年，全区新增幼儿园 6 所，公办园占比 42%。', timeLabel: '2021 年', sourceId: 's1', parentIndex: 0 },
        { text: '2021 年，全区新增幼儿园 6 所，公办园占比达 42%。', timeLabel: '2021 年', sourceId: 's2', parentIndex: 1 }
      ])
      expect(out.paragraphs).toHaveLength(1)
      expect(out.duplicatesDropped).toBe(1)
      expect(out.crossSourceMerged).toBe(1)
      expect(out.paragraphs[0].sourceId).toBe('s1') // 保留先出现者（本段单一来源）
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
