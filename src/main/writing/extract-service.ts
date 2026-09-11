/**
 * extract-service.ts —— 资料「整合提取」阶段（Phase 7.2，2026-09-10）。
 *
 * 位置：`AI 分窗细读（筛选） → 整合提取 → 卡片矛盾扫描（→ 落库）`。
 * 本阶段**取代原「提纯」+「修正」两个阶段**（用户 2026-09-10 裁定 D1）：
 * 旧管线为了保住文本整体性而禁止模型裁剪/组织，导致每段掺入大量与主题无关的内容；
 * 现在放宽限制，允许模型主动**裁剪 + 补全 + 整合**，产出可直接写进志稿的段落。
 *
 * 自由度换来的是幻觉风险，因此本阶段配三道**本地硬校验**（见 compilation-document）：
 * ① `evidence` 必须是某张卡片原文中**逐字连续**的一段（证明段落确实出自该来源）；
 * ② 正文里的**数字必须都能在该来源的卡片原文中找到**（整 token 比较，不允许编造/推算）；
 * ③ 每段**单一来源**（evidence 落在同一张卡片内，禁止跨来源拼接）。
 * 任一条不过 → **降级保留该卡片原文整段**（不丢材料），并计入诊断。
 *
 * 另外两条硬约束（写进提示词 + 由结构保证）：
 * - **不得合并互相矛盾的说法**：冲突必须保留为不同段落，交给随后的矛盾扫描（否则"自由整合"会把矛盾抹平）；
 * - 每段必须给出含 4 位年份的 `timeLabel`；确实推断不出时照原文写法给出，由本地标为 `unknown`（界面「时间待核」）。
 */
import { ErrorCodes } from '../../shared/types'
import { chatCompletion, type ChatMessage } from '../llm/chat'
import { logMain } from '../logger'
import {
  locateVerbatim,
  validateExtractedParagraph,
  type ExtractedParagraphDraft,
  type ParagraphRejectReason
} from './compilation-document'

/** 单批最多卡片数（双预算之一：输出是重写过的段落，批太大易被截断） */
export const EXTRACT_BATCH_MAX = 30
/** 单批输入字符预算 */
export const EXTRACT_BATCH_CHARS = 12000
/** 单次调用超时（要重写 + 给证据，比提纯更重） */
const EXTRACT_CALL_TIMEOUT_MS = 300000
/** 整阶段时间预算：超出后剩余批次按"原文整段保留"处理，不丢材料、不阻断后续阶段 */
export const EXTRACT_PHASE_BUDGET_MS = 1200000
/** 单批预计耗时（秒，用于剩余时间展示） */
export const EXTRACT_ETA_PER_CALL_S = 120

/** 待整合提取的候选卡片（管线内存态） */
export interface ExtractCandidate {
  /** 在合并后 items 数组中的下标（回填用） */
  index: number
  /** 提示词中的稳定标识（如 c12） */
  key: string
  /** 来源编号（如 `#3`），与细读阶段的 SourceRefEntry.index 对应 */
  sourceRef: string
  sourceTitle: string
  excerpt: string
  ts?: string
}

/** 一批的产出：已校验（或降级）的段落草稿 */
export interface ExtractedDraft {
  /** 来源卡片（回填 sourceId/sourceTitle 用） */
  parentIndex: number
  /** 段落正文（不含段首时间） */
  text: string
  timeLabel?: string
  evidence?: string
  /** true = 校验未通过、已降级为原文整段 */
  degraded?: boolean
}

export interface ExtractBatchStats {
  input: number
  inputChars: number
  /** 模型返回的段落条数 */
  returned: number
  /** 通过全部本地校验的段落数 */
  accepted: number
  /** 校验失败而降级为原文整段的段落/卡片数 */
  unverified: number
  /** 其中因"数字在来源中找不到"降级（幻觉嫌疑） */
  invalidNumbers: number
  /** 其中因"证据引文不是原文"降级 */
  invalidEvidence: number
  emptyText: number
  /** 模型判定"该卡片与主题无关"而整体丢弃的卡片数 */
  droppedCards: number
  /** 模型始终未回答的卡片数（重问后仍未答） */
  omitted: number
  /** 最终按原文整段保留的卡片数（漏答 / 解析失败整批降级） */
  passthrough: number
  retainedChars: number
  retried: number
}

export function emptyExtractStats(input = 0, inputChars = 0): ExtractBatchStats {
  return {
    input,
    inputChars,
    returned: 0,
    accepted: 0,
    unverified: 0,
    invalidNumbers: 0,
    invalidEvidence: 0,
    emptyText: 0,
    droppedCards: 0,
    omitted: 0,
    passthrough: 0,
    retainedChars: 0,
    retried: 0
  }
}

export interface ExtractBatchOutcome {
  ok: boolean
  drafts: ExtractedDraft[]
  stats: ExtractBatchStats
  message?: string
  rateLimited?: boolean
}

// ---------------------------------------------------------------- 解析与提交物

/** 解析整合提取输出（纯函数）；返回 null 表示无有效输出 */
export function parseExtractOutput(
  text: string
): { paragraphs: ExtractedParagraphDraft[]; dropped: { sourceRef: string; why: string }[] } | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1].trim() : trimmed
  let raw: unknown = null
  try {
    raw = JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        raw = JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return null
      }
    } else return null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { paragraphs?: unknown; items?: unknown; dropped?: unknown }
  // 只有 `dropped`（整批都与主题无关）也是合法输出，故缺 paragraphs/items 时按空数组处理
  const arr = Array.isArray(obj.paragraphs) ? obj.paragraphs : Array.isArray(obj.items) ? obj.items : []
  const paragraphs: ExtractedParagraphDraft[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as { sourceRef?: unknown; source?: unknown; text?: unknown; timeLabel?: unknown; confidence?: unknown; evidence?: unknown; reason?: unknown }
    const sourceRef =
      typeof o.sourceRef === 'string' ? o.sourceRef.trim() : typeof o.source === 'string' ? o.source.trim() : ''
    const text = typeof o.text === 'string' ? o.text : ''
    if (!sourceRef || !text.trim()) continue
    paragraphs.push({
      sourceRef,
      text,
      timeLabel: typeof o.timeLabel === 'string' ? o.timeLabel : undefined,
      confidence: typeof o.confidence === 'string' ? o.confidence : undefined,
      evidence: typeof o.evidence === 'string' ? o.evidence : undefined,
      reason: typeof o.reason === 'string' ? o.reason : undefined
    })
  }
  const dropped: { sourceRef: string; why: string }[] = []
  if (Array.isArray(obj.dropped)) {
    for (const d of obj.dropped) {
      if (!d || typeof d !== 'object') continue
      const o = d as { sourceRef?: unknown; source?: unknown; why?: unknown; reason?: unknown }
      const sourceRef =
        typeof o.sourceRef === 'string' ? o.sourceRef.trim() : typeof o.source === 'string' ? o.source.trim() : ''
      if (!sourceRef) continue
      const why = typeof o.why === 'string' ? o.why : typeof o.reason === 'string' ? o.reason : ''
      dropped.push({ sourceRef, why })
    }
  }
  return paragraphs.length > 0 || dropped.length > 0 ? { paragraphs, dropped } : null
}

/** 提示词：自由整合 + 三道校验对应的硬性要求 */
export function buildExtractMessages(batch: ExtractCandidate[], topic: string): ChatMessage[] {
  const cardList = batch
    .map((c) => '[' + c.sourceRef + ']（引用号 ' + c.key + '） 来源：《' + (c.sourceTitle || c.sourceRef) + '》 时间：' + (c.ts ?? '无') + '\n原文：\n' + c.excerpt)
    .join('\n\n')
  const sys = [
    '你是一名地方志资料编辑，正在为一部题为《' + topic + '》的志稿整理素材。',
    '',
    '下面每张【资料卡片】都是从来源文献中整段摘出的，其中只有一部分内容与本次主题有关。',
    '请把它们**加工成可以直接写进志稿的段落**：删掉与主题无关的内容，把同一张卡片里相关的表述整合成通顺、完整、自包含的段落。',
    '',
    '【判定标准】设想这段文字要写进《' + topic + '》的志稿正文：',
    '- 保留：直接记述本主题下的对象、时间、地点、数量、事件、措施、结果等事实；',
    '- 删除：虽与主题同属一个大领域，但对象、学段或业务不是本次主题所要求的（例如主题限定某一学段时，卡片讲的却是同一领域下的其它学段、其它业务、其它对象）；',
    '- 删除：本地其它行业、其它部门、其它工作的内容。',
    '判断依据是「志稿正文会不会用到它」，而不是「它与主题有没有一点点关系」。',
    '',
    '【硬性要求】',
    '1. **忠于原文事实**：数字、日期、人名、地名、机构名一律照抄原文，不得改写、不得推算、不得编造；不得改变原文的结论。',
    '2. **每段只能来自一张卡片**（即一个来源）：不得把不同卡片的文字拼成一段；不同来源的内容必须分成不同段落。',
    '3. 允许的加工：删掉无关内容；在同一张卡片内部调整语序、合并同一事实的多句表述、把省略的主语或指代补全（「他」「该校」→ 具体人名/校名）；去掉或改写「【概况】」这类栏目名。',
    '4. **不得合并互相矛盾的说法**：若两张卡片（或同一卡片内两处）对同一事实给出不同数字、时间或说法，必须**分别保留为不同段落**，不要取其中一种，也不要折中。',
    '5. 每段必须给出 `timeLabel`（段首时间，**必须含 4 位年份**，如「2018 年」「2018 年 5 月」）：依据正文、卡片时间与来源文献年份推断（来源为《长乐年鉴2019》通常记述 2018 年）。确实推断不出年份时，照原文的时间写法给出（如「5 月 19 日」），**不要编造年份**。',
    '6. 每段必须给出 `evidence`：从该卡片原文中**逐字连续**摘出的一段（不得改写、不得拼接、不得跨卡片拼），作为这段的事实依据。',
    '7. 某张卡片里确实没有与主题相关的内容时，把它放进 `dropped` 并简述原因。',
    '8. 不要输出任何解释性文字或代码块围栏，只输出一个 JSON 对象。',
    '',
    '输出格式：',
    '{"paragraphs":[{"sourceRef":"#3","text":"段落正文（不含时间标签）","timeLabel":"2018 年 5 月","evidence":"卡片原文中逐字连续的一段","reason":"为何保留"}],"dropped":[{"sourceRef":"#4","why":"与主题无关"}]}'
  ].join('\n')
  const user = ['【资料卡片】', cardList, '', '请按上述要求输出各卡片整合后的段落；sourceRef 必须原样照抄（如 #3）。'].join('\n')
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]
}

export function logExtractBatchStats(batchNo: number, total: number, stats: ExtractBatchStats): void {
  logMain(
    'extract',
    '第 ' +
      batchNo +
      '/' +
      total +
      ' 批：输入 ' +
      stats.input +
      ' 张/' +
      stats.inputChars +
      ' 字，返回 ' +
      stats.returned +
      ' 段，通过校验 ' +
      stats.accepted +
      ' 段/' +
      stats.retainedChars +
      ' 字，降级 ' +
      stats.unverified +
      '（数字 ' +
      stats.invalidNumbers +
      '／证据 ' +
      stats.invalidEvidence +
      '），整卡丢弃 ' +
      stats.droppedCards +
      '，漏答 ' +
      stats.omitted +
      '，原样保留 ' +
      stats.passthrough +
      '，重试 ' +
      stats.retried
  )
}

// ---------------------------------------------------------------- 批次处理（核心，可测试）

/** 降级：保留该卡片原文整段（不丢材料），时间标签沿用卡片自身 */
function degraded(candidate: ExtractCandidate): ExtractedDraft {
  return {
    parentIndex: candidate.index,
    text: candidate.excerpt,
    timeLabel: candidate.ts ?? undefined,
    degraded: true
  }
}

/**
 * 把模型输出处理成"已校验/已降级"的段落草稿（纯函数，可测试）。
 * - sourceRef 找不到对应卡片 → 忽略（幻觉出来的引用号）；
 * - `evidence` 必须是该来源**卡片原文中逐字连续**的一段 → 这就是"每段单一来源"的本地保证
 *   （来源可能有多张卡片，故校验用该来源全部卡片拼成的文本；同一来源跨卡片整合是允许的）；
 * - 正文里的**数字**必须都能在该来源卡片原文中找到（整 token 比较）→ 拦住编造/推算；
 * - 校验失败 → 降级保留该卡片原文整段（不丢材料），并按原因计入诊断。
 * 返回 `answered`：模型明确回答过的来源编号（出现在 paragraphs 或 dropped 中），供调用方判断漏答。
 */
export function collectExtractResults(
  batch: ExtractCandidate[],
  parsed: { paragraphs: ExtractedParagraphDraft[]; dropped: { sourceRef: string; why: string }[] },
  stats: ExtractBatchStats
): { drafts: ExtractedDraft[]; answered: Set<string> } {
  const byRef = new Map<string, ExtractCandidate[]>()
  for (const c of batch) {
    const list = byRef.get(c.sourceRef) ?? []
    list.push(c)
    byRef.set(c.sourceRef, list)
  }
  const drafts: ExtractedDraft[] = []
  const answered = new Set<string>()
  stats.returned = parsed.paragraphs.length

  for (const draft of parsed.paragraphs) {
    const group = byRef.get(draft.sourceRef)
    if (!group || group.length === 0) continue // 幻觉出来的 sourceRef：忽略
    answered.add(draft.sourceRef)
    const sourceText = group.map((c) => c.excerpt).join('\n')
    const validation = validateExtractedParagraph(draft, sourceText)
    if (!validation.ok) {
      stats.unverified += 1
      const reason: ParagraphRejectReason = validation.reason
      if (reason === 'number-not-in-source') stats.invalidNumbers += 1
      else if (reason === 'evidence-not-found') stats.invalidEvidence += 1
      else stats.emptyText += 1
      drafts.push(degraded(group[0]))
      continue
    }
    // 段落归属：优先归到 evidence 所在的那张卡片（用于矛盾说法映射与诊断），否则归该来源第一张
    const evidence = (draft.evidence ?? '').trim()
    const parent = (evidence ? group.find((c) => locateVerbatim(c.excerpt, evidence) !== null) : undefined) ?? group[0]
    stats.accepted += 1
    stats.retainedChars += validation.text.length
    drafts.push({
      parentIndex: parent.index,
      text: validation.text,
      timeLabel: validation.timeLabel,
      evidence: validation.evidence
    })
  }

  for (const d of parsed.dropped) {
    if (!byRef.has(d.sourceRef)) continue
    answered.add(d.sourceRef)
    stats.droppedCards += 1
  }
  return { drafts, answered }
}

// ---------------------------------------------------------------- 分批与调用

/** 按「卡片数 + 累计字符」双预算切批（纯函数，可测试） */
export function splitExtractBatches(
  candidates: ExtractCandidate[],
  maxCount: number = EXTRACT_BATCH_MAX,
  maxChars: number = EXTRACT_BATCH_CHARS
): number[][] {
  const batches: number[][] = []
  let cur: number[] = []
  let chars = 0
  candidates.forEach((c, i) => {
    const size = c.excerpt.length + 40
    if (cur.length > 0 && (cur.length + 1 > maxCount || chars + size > maxChars)) {
      batches.push(cur)
      cur = []
      chars = 0
    }
    cur.push(i)
    chars += size
  })
  if (cur.length > 0) batches.push(cur)
  return batches
}

interface ExtractProvider {
  apiBase: string
  model: string
  apiKey: string
}

async function callExtract(
  provider: ExtractProvider,
  batch: ExtractCandidate[],
  topic: string,
  taskId: string,
  temperature: number
): Promise<{ ok: boolean; text: string; message?: string; rateLimited?: boolean }> {
  const result = await chatCompletion(
    provider,
    buildExtractMessages(batch, topic),
    EXTRACT_CALL_TIMEOUT_MS,
    { kind: 'compilation-extract', taskId },
    { maxRetries: 0, temperature, seed: temperature === 0 ? 42 : undefined }
  )
  if (!result.ok) {
    return {
      ok: false,
      text: '',
      message: result.error?.message ?? '大模型调用异常',
      rateLimited: result.error?.code === ErrorCodes.LLM_RATE_LIMIT
    }
  }
  return { ok: true, text: result.text }
}

/**
 * 对一批候选执行整合提取：
 * - 首次调用失败（异常/限流）→ ok:false（由管线中断并可续跑）；
 * - 输出无法解析 → 换温度重试一次；仍无法解析 → 整批按原文整段保留（降级，不丢材料）；
 * - 模型漏答的卡片 → 单独小批重问一次；仍漏答 → 按原文整段保留并计入诊断；
 * - 单段校验失败 → 降级为原文整段（不丢材料），并计入诊断。
 */
export async function extractBatch(
  provider: ExtractProvider,
  batch: ExtractCandidate[],
  topic: string,
  taskId: string
): Promise<ExtractBatchOutcome> {
  const stats = emptyExtractStats(batch.length, batch.reduce((n, c) => n + c.excerpt.length, 0))
  if (batch.length === 0) return { ok: true, drafts: [], stats }

  const first = await callExtract(provider, batch, topic, taskId, 0)
  if (!first.ok) return { ok: false, drafts: [], stats, message: first.message, rateLimited: first.rateLimited }
  const knownRefs = new Set(batch.map((c) => c.sourceRef))
  let parsed = parseExtractOutput(first.text)
  if (!parsed || ![...parsed.paragraphs, ...parsed.dropped].some((e) => knownRefs.has(e.sourceRef))) {
    stats.retried += 1
    const again = await callExtract(provider, batch, topic, taskId, 0.3)
    const reparsed = again.ok ? parseExtractOutput(again.text) : null
    if (reparsed && [...reparsed.paragraphs, ...reparsed.dropped].some((e) => knownRefs.has(e.sourceRef))) {
      parsed = reparsed
      logMain('extract', '解析失败后重试成功（' + batch.length + ' 张卡片）')
    } else {
      stats.passthrough = batch.length
      stats.omitted = batch.length
      logMain('extract', '整批 ' + batch.length + ' 张卡片的输出无法解析，已按原文整段保留')
      return { ok: true, drafts: batch.map(degraded), stats }
    }
  }

  const { drafts, answered } = collectExtractResults(batch, parsed, stats)

  // 漏答的卡片：单独小批重问一次（仍漏答则按原文整段保留）
  const missing = batch.filter((c) => !answered.has(c.sourceRef))
  if (missing.length > 0) {
    stats.retried += 1
    const retry = await callExtract(provider, missing, topic, taskId, 0.3)
    const retryParsed = retry.ok ? parseExtractOutput(retry.text) : null
    if (retryParsed) {
      const again = collectExtractResults(missing, retryParsed, stats)
      drafts.push(...again.drafts)
      for (const ref of again.answered) answered.add(ref)
    }
  }
  for (const c of missing) {
    if (answered.has(c.sourceRef)) continue
    stats.omitted += 1
    stats.passthrough += 1
    drafts.push(degraded(c))
  }
  return { ok: true, drafts, stats }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  const batch: ExtractCandidate[] = [
    { index: 0, key: 'c1', sourceRef: '#1', sourceTitle: '长乐年鉴2019', excerpt: '2018 年，全区普通中学 30 所，其中独立高中 1 所。另有幼儿园 89 所。', ts: '2018 年' },
    { index: 1, key: 'c2', sourceRef: '#1', sourceTitle: '长乐年鉴2019', excerpt: '同年，全区教职工 900 人。', ts: '2018 年' },
    { index: 2, key: 'c3', sourceRef: '#2', sourceTitle: '长乐年鉴2020', excerpt: '2020 年，全区幼儿园 212 所。', ts: '2020 年' }
  ]

  describe('extract service (Phase 7.2 整合提取)', () => {
    it('parses fenced / bare json, the items alias, and rejects invalid output', () => {
      const ok = parseExtractOutput(
        '{"paragraphs":[{"sourceRef":"#1","text":"甲","timeLabel":"2018 年","evidence":"甲"}],"dropped":[{"sourceRef":"#2","why":"无关"}]}'
      )!
      expect(ok.paragraphs).toHaveLength(1)
      expect(ok.paragraphs[0].sourceRef).toBe('#1')
      expect(ok.dropped).toHaveLength(1)
      expect(parseExtractOutput('前言 {"items":[{"sourceRef":"#1","text":"乙"}]} 后记')!.paragraphs).toHaveLength(1)
      expect(parseExtractOutput('```json\n{"paragraphs":[{"sourceRef":"#1","text":"丙"}]}\n```')!.paragraphs).toHaveLength(1)
      // 只有 dropped 也算有效输出（整批都与主题无关）
      expect(parseExtractOutput('{"dropped":[{"sourceRef":"#1","why":"无关"}]}')!.paragraphs).toHaveLength(0)
      expect(parseExtractOutput('纯文本')).toBeNull()
      expect(parseExtractOutput('{"paragraphs":[]}')).toBeNull()
      // 缺 sourceRef / 空正文的条目被跳过
      expect(parseExtractOutput('{"paragraphs":[{"text":"甲"},{"sourceRef":"#1","text":"  "}]}')).toBeNull()
    })

    it('states the hard constraints the local validation enforces', () => {
      const sys = buildExtractMessages(batch, '高中教育')[0].content
      expect(sys).toContain('《高中教育》')
      // 单一来源
      expect(sys).toContain('每段只能来自一张卡片')
      // 不得改写事实 / 不得编造数字
      expect(sys).toContain('不得改写、不得推算、不得编造')
      // 不得合并矛盾说法（否则自由整合会把矛盾抹平）
      expect(sys).toContain('不得合并互相矛盾的说法')
      // evidence 必须逐字
      expect(sys).toContain('逐字连续')
      // 时间必须含年份，且不得编造年份
      expect(sys).toContain('必须含 4 位年份')
      expect(sys).toContain('不要编造年份')
      // 输出格式
      expect(sys).toContain('"paragraphs"')
      expect(sys).toContain('"dropped"')
    })

    it('accepts a valid rewrite, attributing it to the card holding the evidence', () => {
      const stats = emptyExtractStats(batch.length, 0)
      const parsed = {
        paragraphs: [
          // 补全主语 + 删掉幼儿园（无关）→ 数字都能在 #1 的卡片里找到
          { sourceRef: '#1', text: '2018 年，全区普通中学 30 所，其中独立高中 1 所。', timeLabel: '2018 年', evidence: '全区普通中学 30 所，其中独立高中 1 所' },
          // 跨卡片整合（同一来源）：证据在第 2 张卡片
          { sourceRef: '#1', text: '2018 年，全区教职工 900 人。', timeLabel: '2018 年', evidence: '全区教职工 900 人' }
        ],
        dropped: [{ sourceRef: '#2', why: '讲的是幼儿园，与高中教育无关' }]
      }
      const { drafts, answered } = collectExtractResults(batch, parsed, stats)
      expect(stats.accepted).toBe(2)
      expect(stats.unverified).toBe(0)
      expect(stats.droppedCards).toBe(1)
      expect(drafts.map((d) => d.parentIndex)).toEqual([0, 1])
      expect(drafts[0].evidence).toBe('全区普通中学 30 所，其中独立高中 1 所')
      expect(answered.has('#1')).toBe(true)
      expect(answered.has('#2')).toBe(true)
    })

    it('degrades to the original card when evidence is not verbatim or numbers are invented', () => {
      const stats = emptyExtractStats(batch.length, 0)
      const { drafts } = collectExtractResults(
        batch,
        {
          paragraphs: [
            // 证据是改写过的 → 判为 evidence-not-found → 降级保留原文整段
            { sourceRef: '#1', text: '2018 年，全区普通中学 30 所。', timeLabel: '2018 年', evidence: '全区共有普通中学 30 所' },
            // 编造数字（32 所） → 判为 number-not-in-source → 降级
            { sourceRef: '#2', text: '2020 年，全区幼儿园 232 所。', timeLabel: '2020 年', evidence: '全区幼儿园 212 所' }
          ],
          dropped: []
        },
        stats
      )
      expect(stats.accepted).toBe(0)
      expect(stats.unverified).toBe(2)
      expect(stats.invalidEvidence).toBe(1)
      expect(stats.invalidNumbers).toBe(1)
      expect(drafts).toHaveLength(2)
      expect(drafts.every((d) => d.degraded === true)).toBe(true)
      // 降级保留的是原文整段，而不是模型改写的文本
      expect(drafts[0].text).toBe(batch[0].excerpt)
      expect(drafts[0].timeLabel).toBe('2018 年')
      expect(drafts[1].text).toBe(batch[2].excerpt)
    })

    it('ignores hallucinated source refs and leaves unanswered cards for the caller', () => {
      const stats = emptyExtractStats(batch.length, 0)
      const { drafts, answered } = collectExtractResults(
        batch,
        { paragraphs: [{ sourceRef: '#99', text: '编出来的来源', timeLabel: '2018 年', evidence: 'x' }], dropped: [] },
        stats
      )
      expect(drafts).toHaveLength(0)
      expect(answered.size).toBe(0)
      expect(stats.returned).toBe(1)
    })

    it('splits batches by count and char budget without dropping cards', () => {
      const many: ExtractCandidate[] = Array.from({ length: 70 }, (_, i) => ({
        index: i,
        key: 'c' + (i + 1),
        sourceRef: '#1',
        sourceTitle: 't',
        excerpt: 'x'.repeat(300)
      }))
      const batches = splitExtractBatches(many, 30, 12000)
      expect(batches.flat()).toHaveLength(70)
      expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(30)
      // 单卡超预算也单独成批（不丢卡）
      expect(splitExtractBatches([{ ...many[0], excerpt: 'x'.repeat(50000) }], 30, 12000)).toEqual([[0]])
    })
  })
}
