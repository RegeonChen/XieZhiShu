/**
 * purify-service.ts —— 资料卡片「提纯」阶段（2026-09-08 新增；2026-09-10 收紧口径 + 句读吸附 + 并行化 + 去 reason）。
 *
 * 位置：AI 分窗细读之后、大模型修正之前（`细读 → 提纯 → 修正 → 卡片矛盾扫描`）。
 *
 * 背景（真实数据实测）：「整段成卡」策略下，只要段落里有一句与主题相关，整段都会成为一张卡片；
 * 以《长乐年鉴》这类宽口径来源为例，大量卡片夹带民生支出、扶贫、计生等无关内容，稀释矛盾检测与初稿材料。
 *
 * 本阶段职责：把细读产出的「整段卡片」交给大模型阅读理解，**摘录**出与撰写主题确有关系的句段，
 * 舍弃与主题无关的部分，得到更纯净、更细粒度的卡片集（随后由「修正」阶段补全语义 / 补齐时间戳）。
 *
 * 2026-09-10 实测复盘（任务「高中教育4」：253 张卡 / 48,213 字，相关字占比仅 40%）后的三项改造：
 * - **口径收紧为「写通测试」**（用户选定）：提示词从「只要有可能的联系就保留」改为
 *   「这段文字会不会写进题为《主题》的志稿正文」——把「与教育大领域有关但对象/学段/业务不是本主题」的内容删掉。
 *   旧口径下模型几乎不敢删（实测提纯只删掉约 1/4 材料，相关率只从 31% 升到 40%）。
 * - **本地句读吸附** `snapSpansToSentenceBounds`（用户选定）：模型给出的片段若起点在词中/半句中，
 *   向左扩到句读边界；若终点不是句子结尾，向右扩到句末标点。**只向外扩、绝不向内收缩**（只补全、不删字），
 *   修正实测中 43 张「起点不在句读边界」、11 张「结尾半句」的残缺卡片；残留的缺主语/指代不明交由修正阶段补全。
 * - **性能与可观测**：批次 30→50 张 / 12000→18000 字、整阶段预算 600s→900s、调用由串行改为按 Provider 并发
 *   （并行在 compilation-service），并新增逐批诊断（输入卡片/字数、返回条目、保留字数、漏答、校验失败、吸附次数）
 *   与漏答/解析失败重试；同时去掉纯开销的 `reason` 字段（提纯是黑箱，理由从不展示也不落库）。
 *
 * 两条硬约束（用户确认 2026-09-08）：
 * - **严格逐字摘录**：片段必须是父卡片原文中连续出现的一段；本地用「去空白归一化后子串匹配」校验，
 *   命中的片段一律回取**原文中的真实子串**（含原始排版空格），从而杜绝模型改写与幻觉；
 *   校验失败的片段丢弃，某卡片全部片段校验失败则**保留该原卡**（宁多勿漏，不丢材料）。
 * - **黑箱定位**：不加列/不加表、不展示提纯前原文、不支持单独回退；代码侧只统计不改写模型判定（不做内容拦截）。
 */
import { ErrorCodes } from '../../shared/types'
import { chatCompletion, type ChatMessage } from '../llm/chat'
import { logMain } from '../logger'

/** 单批最多卡片数（双预算之一；实测单次耗时与输入量弱相关，故宁可少次、批大一点） */
export const PURIFY_BATCH_MAX = 50
/** 单批输入字符预算 */
export const PURIFY_BATCH_CHARS = 18000
/** 单次调用超时（推理型任务，留足余量） */
const PURIFY_CALL_TIMEOUT_MS = 300000
/** 整阶段时间预算：超出后剩余批次按「保留原卡」处理，不丢材料、不阻断后续阶段 */
export const PURIFY_PHASE_BUDGET_MS = 900000
/** 单批提纯的预计耗时（秒，用于剩余时间展示） */
export const PURIFY_ETA_PER_CALL_S = 90
/** 同一卡片内相邻片段间隔小于该字符数时合并（避免把一句完整表述拆成碎片） */
export const PURIFY_MERGE_GAP_CHARS = 24
/** 单卡片段数上限：超出则合并为一段（防御碎片化，不丢内容） */
export const PURIFY_MAX_SPANS_PER_CARD = 8
/** 句读吸附的最大外扩距离（字符）：超出该距离仍找不到句读边界则保持原样，避免吞进大段无关内容 */
export const PURIFY_SNAP_MAX_CHARS = 200

/** 句末/分句标点：吸附时的合法边界（含分号——志书并列分句以分号收尾也是完整表述） */
const SENTENCE_END_CHARS = '。！？；!?;'
/** 紧跟在句末标点之后的收尾符号：断句点应落在这些符号之后 */
const TRAILING_CLOSERS = '”’」』）)】》〉'

/** 待提纯的父卡片（管线内存态，不含数据库 id） */
export interface PurifyCandidate {
  /** 在合并后 items 数组中的下标（用于回填） */
  index: number
  /** 提示词中的稳定标识（如 c12） */
  key: string
  sourceRef: string
  sourceTitle: string
  excerpt: string
  ts?: string
}

/** 提纯产出的一个片段（text 必定是父卡片原文的真实子串） */
export interface PurifiedSpan {
  parentIndex: number
  text: string
}

/** 单批提纯的诊断统计（不落库，仅日志与生成汇总用） */
export interface PurifyBatchStats {
  inputCards: number
  inputChars: number
  /** 模型实际返回条目的卡片数 */
  returnedCards: number
  /** 模型始终漏答的卡片数（本地重问后仍未答） */
  omittedCards: number
  /** 最终按原样保留的卡片数（漏答、片段全部校验失败、解析失败整批降级） */
  passthroughCards: number
  /** 被模型判定为「无相关内容」而整体丢弃的卡片数 */
  droppedCards: number
  /** 最终保留过至少一个片段的卡片数 */
  retainedCards: number
  /** 最终保留的片段字符数 */
  retainedChars: number
  /** 校验失败（模型改写了原文）被丢弃的片段数 */
  invalid: number
  /** 因句读吸附而扩展了边界的片段数 */
  snapExpanded: number
  /** 本批额外调用次数（解析失败重试 / 漏答重问） */
  retried: number
}

export interface PurifyBatchOutcome {
  ok: boolean
  spans: PurifiedSpan[]
  stats: PurifyBatchStats
  message?: string
  rateLimited?: boolean
}

/** 空统计（导出供 compilation-service 聚合超预算未跑批次的卡片数） */
export function emptyPurifyStats(inputCards = 0, inputChars = 0): PurifyBatchStats {
  return {
    inputCards,
    inputChars,
    returnedCards: 0,
    omittedCards: 0,
    passthroughCards: 0,
    droppedCards: 0,
    retainedCards: 0,
    retainedChars: 0,
    invalid: 0,
    snapExpanded: 0,
    retried: 0
  }
}

// ---------------------------------------------------------------- 纯函数：校验、吸附与合并

/**
 * 去掉所有空白后的字符 → 原文下标映射（原文含 `普 通 中 学` 这类排版空格，需容忍空格差异）。
 * 返回 [归一化文本, 归一化下标 → 原文下标]。
 */
function normalizeWithMap(text: string): [string, number[]] {
  let norm = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) continue
    norm += ch
    map.push(i)
  }
  return [norm, map]
}

/** 单条片段在父卡片原文中的定位结果 */
export interface LocatedSpan {
  start: number
  end: number
  text: string
}

/**
 * 校验并定位一批片段：逐个在父卡片原文中做「去空白归一化」子串匹配，
 * 命中后回取**原文真实子串**（含原始空白），未命中计为 invalid。
 */
export function locateSpans(parentText: string, raws: string[]): { spans: LocatedSpan[]; invalid: number } {
  const [normParent, map] = normalizeWithMap(parentText)
  const spans: LocatedSpan[] = []
  let invalid = 0
  for (const raw of raws) {
    const [normFrag] = normalizeWithMap(raw ?? '')
    if (!normFrag) {
      invalid += 1
      continue
    }
    const at = normParent.indexOf(normFrag)
    if (at < 0) {
      // 模型改写了原文（或产生了幻觉）→ 丢弃该片段
      invalid += 1
      continue
    }
    const start = map[at]
    const end = map[at + normFrag.length - 1] + 1
    spans.push({ start, end, text: parentText.slice(start, end) })
  }
  return { spans, invalid }
}

/** 片段起点向左吸附到句读边界（在 PURIFY_SNAP_MAX_CHARS 内找不到边界则不动） */
function snapStartLeft(text: string, start: number): number {
  if (start <= 0) return start
  const min = Math.max(0, start - PURIFY_SNAP_MAX_CHARS)
  for (let i = start - 1; i >= min; i--) {
    if (SENTENCE_END_CHARS.includes(text[i])) {
      let s = i + 1
      // 跳过句末标点之后的收尾符号与空白（如 `。”` 后接内容）
      while (s < start && (TRAILING_CLOSERS.includes(text[s]) || /\s/.test(text[s]))) s++
      return s
    }
  }
  return start
}

/** 片段终点向右吸附到句末标点（已以标点收尾则只吸收收尾符号；超出外扩距离则不动） */
function snapEndRight(text: string, end: number): number {
  const capped = Math.min(end, text.length)
  if (capped <= 0) return capped
  if (SENTENCE_END_CHARS.includes(text[capped - 1])) {
    let e = capped
    while (e < text.length && TRAILING_CLOSERS.includes(text[e])) e++
    return e
  }
  const max = Math.min(text.length, capped + PURIFY_SNAP_MAX_CHARS)
  for (let i = capped; i < max; i++) {
    if (SENTENCE_END_CHARS.includes(text[i])) {
      let e = i + 1
      while (e < text.length && TRAILING_CLOSERS.includes(text[e])) e++
      return e
    }
  }
  return capped
}

/**
 * 句读吸附（纯函数，可测试）：把片段的起点/终点扩展到完整的句子边界。
 * **只向外扩、绝不向内收缩**（不会丢任何原文字符），用于修正「起点在词中/半句中」「结尾半句」的残缺卡片。
 * 落地顺序：locateSpans → snapSpansToSentenceBounds → coalesceSpans。
 */
export function snapSpansToSentenceBounds(parentText: string, spans: LocatedSpan[]): LocatedSpan[] {
  return spans.map((s) => {
    const start = snapStartLeft(parentText, s.start)
    const end = snapEndRight(parentText, s.end)
    if (start === s.start && end === s.end) return s
    return { start, end, text: parentText.slice(start, end) }
  })
}

/**
 * 合并与整理片段（纯函数）：
 * - 去掉完全被包含的重复片段（取并集区间）；
 * - 间隔 ≤ PURIFY_MERGE_GAP_CHARS 的相邻片段合并为一段（取原文区间，保持逐字可溯源）；
 * - 片段数超过 PURIFY_MAX_SPANS_PER_CARD 时合并为一段（防御碎片化，不丢内容）。
 */
export function coalesceSpans(parentText: string, spans: LocatedSpan[]): LocatedSpan[] {
  if (spans.length === 0) return []
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: LocatedSpan[] = []
  for (const s of sorted) {
    const last = merged[merged.length - 1]
    if (!last) {
      merged.push({ ...s })
      continue
    }
    const gap = s.start - last.end
    if (gap <= PURIFY_MERGE_GAP_CHARS) {
      if (s.end > last.end) {
        last.end = s.end
        last.text = parentText.slice(last.start, last.end)
      }
    } else {
      merged.push({ ...s })
    }
  }
  if (merged.length <= PURIFY_MAX_SPANS_PER_CARD) return merged
  const first = merged[0]
  const last = merged[merged.length - 1]
  return [{ start: first.start, end: last.end, text: parentText.slice(first.start, last.end) }]
}

/**
 * 把模型给出的片段解析为父卡片中可溯源的完整句片段（纯函数，可测试）：
 * 逐字校验（locateSpans）→ 句读吸附（snapSpansToSentenceBounds）→ 合并（coalesceSpans）。
 * 返回的 spans 为空表示该卡片的片段全部校验失败（调用方据此保留原卡）。
 */
export function resolvePurifiedSpans(
  parentText: string,
  fragments: string[]
): { spans: LocatedSpan[]; invalid: number; snapExpanded: number } {
  const located = locateSpans(parentText, fragments)
  const snapped = snapSpansToSentenceBounds(parentText, located.spans)
  let snapExpanded = 0
  snapped.forEach((s, i) => {
    const before = located.spans[i]
    if (before && (s.start !== before.start || s.end !== before.end)) snapExpanded += 1
  })
  return { spans: coalesceSpans(parentText, snapped), invalid: located.invalid, snapExpanded }
}

// ---------------------------------------------------------------- 纯函数：输入/输出/分批

/** 由合并后的卡片构造待提纯候选（无来源标题时回退显示来源编号） */
export function buildPurifyCandidates(
  items: { sourceRef: string; excerpt: string; ts: string | null }[],
  refs: { index: number; sourceId: string; title: string }[]
): PurifyCandidate[] {
  const titleByRef = new Map(refs.map((r) => ['#' + r.index, r.title]))
  return items.map((it, i) => ({
    index: i,
    key: 'c' + (i + 1),
    sourceRef: it.sourceRef,
    sourceTitle: titleByRef.get(it.sourceRef) ?? '',
    excerpt: it.excerpt,
    ts: it.ts ?? undefined
  }))
}

/** 按「卡片数 + 累计字符」双预算切批（纯函数，可测试） */
export function splitPurifyBatches(
  candidates: PurifyCandidate[],
  maxCount: number = PURIFY_BATCH_MAX,
  maxChars: number = PURIFY_BATCH_CHARS
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

/**
 * 解析提纯输出（纯函数，可测试）；返回 null 表示无有效输出。
 * 片段为标准字符串数组；兼容早期 `{text,reason}` 对象写法（历史数据/个别模型的自由发挥）。
 */
export function parsePurifyOutput(text: string): { cardKey: string; fragments: string[] }[] | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1].trim() : trimmed
  let raw: unknown | null = null
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
    } else {
      return null
    }
  }
  if (!raw || typeof raw !== 'object') return null
  const arr = (raw as { items?: unknown }).items
  if (!Array.isArray(arr)) return null
  const out: { cardKey: string; fragments: string[] }[] = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const o = it as { cardId?: unknown; cardKey?: unknown; fragments?: unknown }
    const key = typeof o.cardId === 'string' ? o.cardId.trim() : typeof o.cardKey === 'string' ? o.cardKey.trim() : ''
    if (!key) continue
    const fragments: string[] = []
    if (Array.isArray(o.fragments)) {
      for (const f of o.fragments) {
        if (typeof f === 'string') {
          if (f.trim()) fragments.push(f)
          continue
        }
        if (f && typeof f === 'object') {
          const t = (f as { text?: unknown }).text
          if (typeof t === 'string' && t.trim()) fragments.push(t)
        }
      }
    }
    out.push({ cardKey: key, fragments })
  }
  return out.length > 0 ? out : null
}

/**
 * 提示词（2026-09-10 收紧口径）：判定标准是「写通测试」——这段文字会不会写进题为《主题》的志稿正文；
 * 明确要求片段为完整句子、指代必须带指代对象；不再使用「宁多勿少、拿不准就保留」的旧口径。
 */
export function buildPurifyMessages(batch: PurifyCandidate[], topic: string): ChatMessage[] {
  const cardList = batch
    .map(
      (c) =>
        '[cardId=' + c.key + '] 来源：《' + (c.sourceTitle || c.sourceRef) + '》 时间：' + (c.ts ?? '无') + '\n原文：\n' + c.excerpt
    )
    .join('\n\n')
  const sys = [
    '你是一名地方志资料编辑，正在为一部题为《' + topic + '》的志稿整理资料卡片。',
    '',
    '下面每张【资料卡片】都是从来源文献中整段摘出的，其中往往只有一部分内容与本次撰写主题有关，其余与主题无关。',
    '请从每张卡片中摘出与主题相关的句段，与主题无关的部分舍弃。',
    '',
    '【判定标准】设想这段文字将被写进《' + topic + '》的志稿正文：',
    '- 保留：它直接记述本主题下的对象、时间、地点、数量、事件、措施、结果等事实。',
    '- 删除：它虽与主题属于同一大领域，但记述的对象、范围或业务不是本主题所要求的（例如主题限定某一学段、某一行业或某项工作时，卡片讲的却是同一领域下的其它学段、其它业务、其它对象）。',
    '- 删除：它讲的是本地其它行业、其它部门、其它工作的内容。',
    '判断依据是「志稿正文会不会用到它」，而不是「它与主题有没有一点点关系」。',
    '',
    '【硬性要求】',
    '1. 只能逐字摘录：每个片段必须是该卡片原文中**连续出现的一段原文**，不得改写、不得增删字词、不得调整标点、不得概括、不得把原文中不相邻的句子拼接在一起。',
    '2. 片段必须是**完整的句子**：从句子开头开始，到句末标点结束；不得从词中间或半句话开始，也不得以半句话结束。',
    '3. 若保留的句子出现「他/其/该校/该年/其中」这类代词或省略，必须同时把交代其指代对象的句子保留为另一个片段。',
    '4. 同一张卡片中互不相邻的相关内容，分别输出为多个片段，不要合并成一段。',
    '5. 某张卡片中确实没有任何与主题相关的内容时，该卡片的 fragments 输出空数组 []。',
    '6. 不要输出任何解释性文字或代码块围栏，只输出一个 JSON 对象，且保持在一行。',
    '',
    '输出格式：',
    '{"items":[{"cardId":"c1","fragments":["逐字摘录的原文片段","另一个片段"]}]}'
  ].join('\n')
  const user = ['【资料卡片】', cardList, '', '请按上述要求输出各卡片保留的片段；cardId 必须原样照抄。'].join('\n')
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]
}

/** 该批全部卡片原样保留（提纯未生效时的降级：宁可留着，不丢材料） */
export function passthroughSpans(candidates: PurifyCandidate[]): PurifiedSpan[] {
  return candidates.map((c) => ({ parentIndex: c.index, text: c.excerpt }))
}

// ---------------------------------------------------------------- 调用与批次

interface PurifyProvider {
  apiBase: string
  model: string
  apiKey: string
}

interface PurifyCallResult {
  ok: boolean
  text: string
  message?: string
  rateLimited?: boolean
}

/** 单次提纯调用（不重试；异常/限流以 ok:false 透出，由管线决定中断） */
async function callPurify(
  provider: PurifyProvider,
  batch: PurifyCandidate[],
  topic: string,
  taskId: string,
  temperature: number
): Promise<PurifyCallResult> {
  const result = await chatCompletion(
    provider,
    buildPurifyMessages(batch, topic),
    PURIFY_CALL_TIMEOUT_MS,
    { kind: 'compilation-purify', taskId },
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
 * 对一批候选执行提纯：
 * - 首次调用失败（异常/限流）→ ok:false（由管线中断并可续跑）；
 * - 输出无法解析 → 换温度重试一次；仍无法解析 → 整批按原样保留（降级，不丢材料）；
 * - 模型漏答的卡片 → 单独小批重问一次（漏答是「提纯没生效」的主要来源，旧实现静默保留且无日志）；
 * - 某卡片片段全部校验失败 → 保留该原卡。
 */
export async function purifyBatch(
  provider: PurifyProvider,
  batch: PurifyCandidate[],
  topic: string,
  taskId: string
): Promise<PurifyBatchOutcome> {
  const stats = emptyPurifyStats(batch.length, batch.reduce((n, c) => n + c.excerpt.length, 0))
  if (batch.length === 0) return { ok: true, spans: [], stats }

  const first = await callPurify(provider, batch, topic, taskId, 0)
  if (!first.ok) {
    return { ok: false, spans: [], stats, message: first.message, rateLimited: first.rateLimited }
  }
  const byKey = new Map(batch.map((c) => [c.key, c]))
  let parsed = parsePurifyOutput(first.text)
  if (!parsed || !parsed.some((e) => byKey.has(e.cardKey))) {
    stats.retried += 1
    const again = await callPurify(provider, batch, topic, taskId, 0.3)
    const reparsed = again.ok ? parsePurifyOutput(again.text) : null
    if (reparsed && reparsed.some((e) => byKey.has(e.cardKey))) {
      parsed = reparsed
      logPurify('重试', '解析失败后重试成功（' + batch.length + ' 张卡片）')
    } else {
      // 仍无可解析输出 → 整批按原样保留（降级，不丢材料）
      stats.passthroughCards = batch.length
      stats.omittedCards = batch.length
      logPurify('降级', '整批 ' + batch.length + ' 张卡片的输出无法解析，已按原样保留')
      return { ok: true, spans: passthroughSpans(batch), stats }
    }
  }

  const spans: PurifiedSpan[] = []
  const seen = new Set<string>()
  const collect = (entries: { cardKey: string; fragments: string[] }[]): void => {
    for (const entry of entries) {
      const card = byKey.get(entry.cardKey)
      if (!card || seen.has(entry.cardKey)) continue
      seen.add(entry.cardKey)
      stats.returnedCards += 1
      if (entry.fragments.length === 0) {
        stats.droppedCards += 1
        continue
      }
      const resolved = resolvePurifiedSpans(card.excerpt, entry.fragments)
      stats.invalid += resolved.invalid
      stats.snapExpanded += resolved.snapExpanded
      if (resolved.spans.length === 0) {
        // 全部片段校验失败 → 保留该原卡
        stats.passthroughCards += 1
        spans.push({ parentIndex: card.index, text: card.excerpt })
        continue
      }
      stats.retainedCards += 1
      for (const s of resolved.spans) {
        stats.retainedChars += s.text.length
        spans.push({ parentIndex: card.index, text: s.text })
      }
    }
  }
  collect(parsed)

  // 模型漏答的卡片：单独小批重问一次（仍漏答则按原样保留并计入诊断）
  const missing = batch.filter((c) => !seen.has(c.key))
  if (missing.length > 0) {
    stats.retried += 1
    const retry = await callPurify(provider, missing, topic, taskId, 0.3)
    const retryParsed = retry.ok ? parsePurifyOutput(retry.text) : null
    if (retryParsed) collect(retryParsed)
  }
  for (const c of batch) {
    if (seen.has(c.key)) continue
    stats.omittedCards += 1
    stats.passthroughCards += 1
    spans.push({ parentIndex: c.index, text: c.excerpt })
  }
  return { ok: true, spans, stats }
}

/** 把提纯片段落成新的卡片集（纯函数，可测试）：按父卡顺序输出，继承来源与时间戳 */
export function applyPurifyOutcome<T extends { sourceRef: string; excerpt: string; ts: string | null }>(
  parents: T[],
  spans: PurifiedSpan[]
): {
  items: T[]
  stats: { inputCards: number; outputCards: number; inputChars: number; outputChars: number }
} {
  const byParent = new Map<number, PurifiedSpan[]>()
  for (const s of spans) {
    const list = byParent.get(s.parentIndex) ?? []
    list.push(s)
    byParent.set(s.parentIndex, list)
  }
  const items: T[] = []
  parents.forEach((p, i) => {
    const list = byParent.get(i)
    if (!list || list.length === 0) return // 该卡与主题无关，整体舍弃
    for (const s of list) items.push({ ...p, excerpt: s.text })
  })
  return {
    items,
    stats: {
      inputCards: parents.length,
      outputCards: items.length,
      inputChars: parents.reduce((n, p) => n + p.excerpt.length, 0),
      outputChars: items.reduce((n, it) => n + it.excerpt.length, 0)
    }
  }
}

/**
 * 窗口级矛盾说法的改写映射（纯函数，可测试）：
 * 细读阶段的窗口级矛盾引用的是**提纯前的整段原文**，提纯后卡片已变成片段，
 * 落库时按 excerpt 精确匹配会匹配不到（整组矛盾丢失）。因此把每个说法映射到：
 * ① 完整包含该说法的片段；② 否则被该说法包含的最长片段；③ 都找不到则返回 null（内容已被提纯舍弃 → 丢弃该说法）。
 */
export function mapVariantThroughPurify(
  excerpt: string,
  parents: string[],
  spansByParent: Map<number, string[]>
): string | null {
  if (!excerpt) return null
  let parentIndex = parents.findIndex((p) => p.includes(excerpt))
  if (parentIndex < 0) parentIndex = parents.findIndex((p) => excerpt.includes(p) && p.length > 0)
  if (parentIndex >= 0) {
    const list = spansByParent.get(parentIndex) ?? []
    const containing = list.find((f) => f.includes(excerpt))
    if (containing) return containing
    const inside = list.filter((f) => excerpt.includes(f)).sort((a, b) => b.length - a.length)[0]
    if (inside) return inside
  }
  const all = [...spansByParent.values()].flat()
  const globalContaining = all.find((f) => f.includes(excerpt))
  if (globalContaining) return globalContaining
  const globalInside = all.filter((f) => excerpt.includes(f)).sort((a, b) => b.length - a.length)[0]
  return globalInside ?? null
}

export function logPurify(stage: string, message: string): void {
  logMain('purify', stage + ' ' + message)
}

/** 单批诊断日志（统一格式，便于用日志复盘提纯实际删了多少） */
export function logPurifyBatchStats(batchNo: number, total: number, stats: PurifyBatchStats): void {
  logPurify(
    '批次',
    '第 ' +
      batchNo +
      '/' +
      total +
      ' 批：输入 ' +
      stats.inputCards +
      ' 张/' +
      stats.inputChars +
      ' 字，返回 ' +
      stats.returnedCards +
      ' 张，保留 ' +
      stats.retainedCards +
      ' 张/' +
      stats.retainedChars +
      ' 字，整卡丢弃 ' +
      stats.droppedCards +
      ' 张，漏答 ' +
      stats.omittedCards +
      ' 张，原样保留 ' +
      stats.passthroughCards +
      ' 张，校验失败片段 ' +
      stats.invalid +
      ' 条，句读吸附 ' +
      stats.snapExpanded +
      ' 处，重试 ' +
      stats.retried +
      ' 次'
  )
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  const refs = [
    { index: 1, sourceId: 's1', title: '长乐年鉴2023' },
    { index: 2, sourceId: 's2', title: '长乐年鉴2024' }
  ]
  const parentText = '【社会事业】2019 年，长乐区财政用于民生领域支出 46.91 亿元。同年，普通中学 30 所，其中独立高中 1 所。推动城镇小区配套幼儿园治理。'

  describe('purify service (2026-09-08 提纯阶段 / 2026-09-10 收紧口径)', () => {
    it('parses string fragments, legacy object fragments, fenced json, and rejects invalid output', () => {
      const ok = parsePurifyOutput('{"items":[{"cardId":"c1","fragments":["甲","乙"]}]}')!
      expect(ok).toHaveLength(1)
      expect(ok[0].cardKey).toBe('c1')
      expect(ok[0].fragments).toEqual(['甲', '乙'])
      // 兼容旧的 {text,reason} 写法
      expect(parsePurifyOutput('{"items":[{"cardId":"c2","fragments":[{"text":"丙","reason":"相关"}]}]}')![0].fragments).toEqual(['丙'])
      expect(parsePurifyOutput('前言 {"items":[{"cardId":"c3","fragments":[]}]} 后记')).toHaveLength(1)
      expect(parsePurifyOutput('```json\n{"items":[{"cardId":"c4","fragments":["丁"]}]}\n```')).toHaveLength(1)
      expect(parsePurifyOutput('纯文本')).toBeNull()
      expect(parsePurifyOutput('{"items":[]}')).toBeNull()
    })

    it('locates verbatim substrings, tolerating whitespace differences, and rejects rewrites', () => {
      // 原文含排版空格
      const spaced = '其中，公 办 学 校 154 所，普通中学 28 所。'
      const ok = locateSpans(spaced, ['公办学校 154 所'])
      expect(ok.invalid).toBe(0)
      expect(ok.spans).toHaveLength(1)
      // 回取的是原文真实子串（含原始空格）
      expect(ok.spans[0].text).toBe('公 办 学 校 154 所')

      const rewritten = locateSpans(parentText, ['长乐区财政民生支出 46.91 亿元'])
      expect(rewritten.invalid).toBe(1)
      expect(rewritten.spans).toHaveLength(0)

      expect(locateSpans(parentText, ['   ']).invalid).toBe(1)
    })

    it('snaps a span start left to the sentence boundary (fixes mid-word/mid-sentence starts)', () => {
      // 起点落在「心扑在」中间 → 左吸附到上一句末标点之后（补齐被截掉的「一心」）
      const text = '前一句内容。林某某同志一心扑在学校发展事业上，团结带领全体教师。2020 年被评为优秀教育工作者。'
      const located = locateSpans(text, ['心扑在学校发展事业上，团结带领全体教师。'])
      expect(located.spans[0].start).toBe(text.indexOf('心扑在'))
      const snapped = snapSpansToSentenceBounds(text, located.spans)
      expect(snapped[0].text).toBe('林某某同志一心扑在学校发展事业上，团结带领全体教师。')

      // 已从句子开头开始 → 不变
      const exact = locateSpans(text, ['2020 年被评为优秀教育工作者。'])
      expect(snapSpansToSentenceBounds(text, exact.spans)[0].text).toBe('2020 年被评为优秀教育工作者。')

      // 找不到句读边界（超出外扩距离）→ 保持原样
      const long = '甲' + '乙'.repeat(400) + '丙丁'
      const mid = locateSpans(long, ['丙丁'])
      expect(snapSpansToSentenceBounds(long, mid.spans)[0].text).toBe('丙丁')
    })

    it('snaps a span end right to the sentence punctuation (fixes truncated tails)', () => {
      const text = '全区普通高中 8 所，在校生 1.2 万人，教职工 900 人。另有完中 2 所。'
      const located = locateSpans(text, ['在校生 1.2 万人'])
      const snapped = snapSpansToSentenceBounds(text, located.spans)
      expect(snapped[0].text).toBe('在校生 1.2 万人，教职工 900 人。')

      // 已以句末标点收尾 → 只吸收紧随的收尾符号
      const quoted = '他被评为“优秀教育工作者”。其余内容。'
      const withQuote = locateSpans(quoted, ['他被评为“优秀教育工作者”'])
      expect(snapSpansToSentenceBounds(quoted, withQuote.spans)[0].text).toBe('他被评为“优秀教育工作者”。')
    })

    it('resolves fragments through locate → snap → coalesce with diagnostics', () => {
      // 两段之间隔了 40 字（> PURIFY_MERGE_GAP_CHARS）→ 保持 2 段；首段终点被吸附到句末标点
      const text = '前句。一是推进普通高中建设，新增学位 2000 个。二是' + 'X'.repeat(40) + '。三是完中 2 所。'
      const r = resolvePurifiedSpans(text, ['推进普通高中建设，新增学位 2000 个', '三是完中 2 所。'])
      expect(r.invalid).toBe(0)
      expect(r.spans).toHaveLength(2)
      expect(r.spans[0].text).toBe('一是推进普通高中建设，新增学位 2000 个。')
      expect(r.snapExpanded).toBe(1)

      const bad = resolvePurifiedSpans(text, ['完全改写过的句子。'])
      expect(bad.invalid).toBe(1)
      expect(bad.spans).toHaveLength(0)
    })

    it('coalesces adjacent spans, keeps distant ones separate, and merges when too many', () => {
      // 相邻片段 → 合并为一段
      const t1 = 'AAAA。BBBB。'
      const s1 = locateSpans(t1, ['AAAA。', 'BBBB。']).spans
      expect(coalesceSpans(t1, s1)).toHaveLength(1)
      expect(coalesceSpans(t1, s1)[0].text).toBe('AAAA。BBBB。')

      // 间隔大于合并阈值 → 保持多段
      const t2 = 'AAAA。' + 'X'.repeat(30) + 'BBBB。'
      const s2 = locateSpans(t2, ['AAAA。', 'BBBB。']).spans
      expect(s2).toHaveLength(2)
      expect(coalesceSpans(t2, s2)).toHaveLength(2)

      // 段数超过单卡上限 → 合并为一段（不丢内容）
      let long = ''
      const items: string[] = []
      for (let i = 0; i < 10; i++) {
        items.push('S' + i + '。')
        long += 'S' + i + '。' + 'X'.repeat(40)
      }
      const manySpans = locateSpans(long, items).spans
      expect(manySpans).toHaveLength(10)
      const coalesced = coalesceSpans(long, manySpans)
      expect(coalesced).toHaveLength(1)
      expect(coalesced[0].text).toBe(long.slice(manySpans[0].start, manySpans[9].end))
    })

    it('builds candidates and splits batches by count and char budget without dropping cards', () => {
      const cands = buildPurifyCandidates(
        [
          { sourceRef: '#1', excerpt: '甲'.repeat(500), ts: '2020 年' },
          { sourceRef: '#2', excerpt: '乙'.repeat(500), ts: null }
        ],
        refs
      )
      expect(cands[0].key).toBe('c1')
      expect(cands[0].sourceTitle).toBe('长乐年鉴2023')
      expect(cands[0].ts).toBe('2020 年')

      const many = Array.from({ length: 120 }, (_, i) => ({
        index: i,
        key: 'c' + (i + 1),
        sourceRef: '#1',
        sourceTitle: 't',
        excerpt: 'x'.repeat(300)
      }))
      // 默认批次（50 张 / 18000 字）：120 张卡 → 不超过 50 张/批
      const batches = splitPurifyBatches(many)
      expect(batches.flat()).toHaveLength(120)
      expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(PURIFY_BATCH_MAX)
      expect(batches.length).toBe(3)
      // 单卡超预算时也要单独成批（不丢卡）
      expect(splitPurifyBatches([{ ...many[0], excerpt: 'x'.repeat(50000) }])).toEqual([[0]])
    })

    it('tightens the prompt to the write-through test and demands complete sentences', () => {
      const msgs = buildPurifyMessages(buildPurifyCandidates([{ sourceRef: '#1', excerpt: '原文', ts: null }], refs), '高中教育')
      const sys = msgs[0].content
      expect(sys).toContain('《高中教育》')
      expect(sys).toContain('志稿正文')
      // 旧的「宁多勿少」口径必须已被移除
      expect(sys).not.toContain('宁多勿少')
      expect(sys).toContain('完整的句子')
      expect(sys).toContain('指代对象')
      // 输出格式不再包含 reason
      expect(msgs[0].content).not.toContain('"reason"')
      expect(sys).toContain('"fragments":["逐字摘录的原文片段"')
    })

    it('applies purify outcome: fragments inherit source/ts, unrelated cards are dropped', () => {
      const parents = [
        { sourceRef: '#1', excerpt: '甲段(长)', ts: '2020 年' },
        { sourceRef: '#2', excerpt: '乙段(无关)', ts: null }
      ]
      const out = applyPurifyOutcome(parents, [
        { parentIndex: 0, text: '甲段' },
        { parentIndex: 0, text: '(长)' }
      ])
      expect(out.items.map((i) => i.excerpt)).toEqual(['甲段', '(长)'])
      expect(out.items[0].ts).toBe('2020 年')
      expect(out.items[0].sourceRef).toBe('#1')
      const inputChars = parents.reduce((n, p) => n + p.excerpt.length, 0)
      expect(out.stats).toEqual({ inputCards: 2, outputCards: 2, inputChars, outputChars: 5 })
    })

    it('maps window-level contradiction variants through purification', () => {
      const parents = ['【社会事业】财政支出 46.91 亿元。普通中学 30 所。', '另一段无关内容']
      const spansByParent = new Map<number, string[]>([[0, ['普通中学 30 所。']], [1, ['另一段无关内容']]])
      // 说法落在被保留的片段里（说法是片段的父文本）
      expect(mapVariantThroughPurify('普通中学 30 所。', parents, spansByParent)).toBe('普通中学 30 所。')
      // 说法包含多个片段 → 取最长片段
      expect(mapVariantThroughPurify('另一段无关内容', parents, spansByParent)).toBe('另一段无关内容')
      // 说法对应的内容已被提纯舍弃 → null
      expect(mapVariantThroughPurify('财政支出 46.91 亿元', parents, spansByParent)).toBeNull()
      expect(mapVariantThroughPurify('', parents, spansByParent)).toBeNull()
    })

    it('keeps the whole card when every fragment fails validation (never lose material)', () => {
      const cands = buildPurifyCandidates([{ sourceRef: '#1', excerpt: parentText, ts: null }], refs)
      expect(passthroughSpans(cands)).toEqual([{ parentIndex: 0, text: parentText }])
      const bad = locateSpans(parentText, ['完全改写过的句子。'])
      expect(bad.spans).toHaveLength(0)
      const fallback = applyPurifyOutcome(
        [{ sourceRef: '#1', excerpt: parentText, ts: null }],
        [{ parentIndex: 0, text: parentText }]
      )
      expect(fallback.items).toHaveLength(1)
      expect(fallback.items[0].excerpt).toBe(parentText)
    })
  })
}
