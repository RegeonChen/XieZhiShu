/**
 * generate.ts —— 初稿生成（第 0 稿）：检索 → 提示词 → LLM → 整篇连贯正文落库。
 * 只依据任务范围内的本地资料；模型直接输出一篇连贯的志书小节正文（Markdown），
 * 篇幅由材料中实际可用的有效内容自然决定，不做人为的片段切分与字数限定。
 */
import type { Contradiction, ContradictionInput, ContradictionKind } from '../../shared/types'
import type { Draft, RetrievedChunk } from '../../shared/types'
import { ErrorCodes } from '../../shared/types'
import { getTaskById, resolveScopeSourceIds, getAllSourceIds, updateTaskArticleTitle, updateTaskInstruction } from '../db/tasks'
import { getDraftRowByVersion, createDraft, addSegment, getDraftById, deleteDraftByVersion } from '../db/drafts'
import { getContradictionsByDraft } from '../db/contradictions'
import { getCompilationById } from '../db/compilations'
import { saveDraftGenerationContext } from '../db/draft-context'
import { getDb } from '../db/connection'
import { addTaskMessage } from '../db/task-messages'
import { getSettings } from '../db/settings'
import { getSourceIdsByTag } from '../db/tags'
import { DEFAULT_STYLE_GUIDE } from '../../shared/style-guide'
import { getDefaultStyleGuide } from '../db/style-guides'
import { getProviderSecret } from '../llm/provider-store'
import { safeStorageCodec } from '../llm/secret'
import { chatCompletion, createJsonFieldStreamer, type ChatMessage } from '../llm/chat'
import { retrieveChunks, bigrams, dice } from '../rag/retrieval'
import { embedTexts } from '../rag/embed'
import { getSourceSummariesByIds, type SourceSummary } from '../rag/summarizer'
// 旧版检索链路已移除；网页资料库的 fetchRelatedSiteSources/extractTopicTerms/expandDomainHints 不再在此使用

/**
 * 初稿生成 LLM 调用超时（Task 3.4.8）：Task 3.4.7 取消材料供给限制后，提交的材料体量可能很大，
 * 模型生成一篇完整的志书小节正文可能耗时数分钟，远超出 chatCompletion 默认 60s，故单独放宽到 10 分钟。
 */
const DRAFT_GENERATE_TIMEOUT_MS = 600000

/** 自由对话超时（初稿生成后的问题3修复：对话携带初稿全文+历史，Deepseek 等模型响应较慢，60s 不够） */
const CHAT_TIMEOUT_MS = 300000


/** 生成初稿进度百分比锚点（2026-08-11：整理摘要 → 网页资料检索 → 检索 → 矛盾扫描 → 生成 → 定位矛盾） */
const GENERATE_PROGRESS = {
  summary: 5,
  webSync: 8,
  retrieve: 12,
  scanFrom: 15,
  scanTo: 55,
  generateFrom: 60,
  generateTo: 90,
  locate: 95,
  done: 100
} as const

/** 自由对话时注入的当前初稿正文上限（避免超出模型上下文） */
const CHAT_DRAFT_MAX_CHARS = 12000

export type GenerateResult =
  | { ok: true; draft: Draft; articleTitle: string | null; contradictions: Contradiction[] }
  | { ok: false; error: { code: string; message: string } }

function fail(code: string, message: string): GenerateResult {
  return { ok: false, error: { code, message } }
}

function buildSystemPrompt(contradictionBlock?: string, styleGuide: string = DEFAULT_STYLE_GUIDE): string {
  const lines = [
    '你是一名资深的地方志书撰稿专家，遵循"实事求是、述而不作、横排门类、纵述史实"的志书体例。',
    '现在用户需要生成一篇初稿，以下是用户的要求（应该包含标题和可能的其他要求）。',
    '你必须先从用户要求中抓取文章标题；若用户要求中缺少标题或其他必要信息，**不得生成正文**，而应返回详细的报错说明（说明缺少什么、应如何补充）。',
    '你只能依据下面【参考材料】中的本地资料撰写，严禁编造材料中没有的史实、数据、人名、机构或时间。',
    ''
  ]
  // Phase 6.4：默认行文规范（合并「志书文体文风」与「志书行文规则」）作为全局写作约束注入
  lines.push('【志书写作规范（必须遵守）】', styleGuide, '')
  lines.push(
    '输出要求：只输出一个 JSON 对象，不得输出 JSON 之外的任何文字、解释或代码块围栏。',
    '正常输出：{"title": "抓取的文章标题", "content": "完整连贯的志书小节正文（Markdown）", "error": null}',
    '缺少标题等必要信息时输出：{"title": null, "content": null, "error": "详细说明缺少什么、应如何补充"}',
    '',
    '正文要求：',
    '1. 必须是志书中一个完整小节的正文，一篇连贯成文的文章（可直接入志），而不是零散要点或若干独立片段；',
    '2. 段与段自然衔接，遵循志书"横排门类、纵述史实"的体例，层次清晰；',
    '3. 可根据内容需要自行使用小标题（如 ###）组织内部层次，但整体仍是一篇文章；',
    '4. 篇幅由材料中实际可用的有效内容自然决定：材料里有多少与本节相关的史实、数据、事实，就写多少；不注水、不重复、不硬凑篇幅，也不要刻意省略材料中已有的重要内容；',
    '5. 语言客观、平实，不使用第一人称，不出现"根据材料""以上资料"等表述。'
  )
  // 材料矛盾提示（Phase 3.7 Task 3.7.2）：有矛盾清单时注入"严禁合并/折中 + 分开列表述或只取一种 + 【矛盾#N】标注"约束
  if (contradictionBlock) {
    lines.push('', contradictionBlock)
  }
  return lines.join('\n')
}

function buildUserPrompt(instruction: string, chunks: RetrievedChunk[], styleGuide: string = DEFAULT_STYLE_GUIDE, modelText?: string, materialsOrigin?: string): string {
  // Task 3.4.7：材料不再截断、不设块数上限——把过滤后保留的全部有效段落完整提交，
  // 篇幅由资料中实际有多少有效、有关联的内容自然决定
  const materials = chunks
    .map((c, i) => `[${i + 1}]（sourceId: ${c.sourceId}，标题：《${c.sourceTitle}》，位置：${c.position}）\n${c.text}`)
    .join('\n\n')

  // Phase 6.4.2：有任务级范本时注入【参考范本】作为行文体例/风格参照
  const parts = [
    '【用户要求】',
    instruction,
    '',
    '【写作规范】',
    styleGuide,
    ''
  ]
  if (modelText && modelText.trim()) {
    parts.push('【参考范本】', modelText, '')
  }
  parts.push(materialsOrigin ?? '【参考材料】', materials, '')
  parts.push(
    modelText && modelText.trim()
      ? '请严格遵循上述【写作规范】，参考【参考范本】的体例与行文风格，仅依据【参考材料】撰写这一小节的连贯志书正文。'
      : '请严格遵循上述【写作规范】，仅依据【参考材料】撰写这一小节的连贯志书正文。'
  )
  return parts.join('\n')
}

// ============================================================
// Phase 3.7 Task 3.7.2 —— 矛盾预扫描 / 生成注入 / 定位审查
// ============================================================

const CONTRADICTION_KIND_LABEL: Record<ContradictionKind, string> = {
  data: '数据',
  time: '时间',
  place: '地点',
  fact: '事实经过',
  other: '其他'
}

/** 来源编号清单条目：编号与"文件清单"中的 #N 对应 */
export interface SourceRefEntry {
  index: number
  sourceId: string
  title: string
}

/**
 * 构建任务范围材料的"来源编号清单"（预扫描 / 生成 / 定位审查共用）：
 * 按 chunks 中首次出现顺序去重编号，供大模型按 #N 引用来源文件。
 */
export function buildSourceRefList(chunks: RetrievedChunk[]): SourceRefEntry[] {
  const seen = new Set<string>()
  const list: SourceRefEntry[] = []
  for (const c of chunks) {
    if (!seen.has(c.sourceId)) {
      seen.add(c.sourceId)
      list.push({ index: list.length + 1, sourceId: c.sourceId, title: c.sourceTitle })
    }
  }
  return list
}

/** 矛盾预扫描输出：一个矛盾组（同一主题的若干相左说法） */
export interface ScanVariantOutput {
  text: string
  sourceRefs: string[]
}
export interface ScanGroupOutput {
  topic: string
  kind: string
  variants: ScanVariantOutput[]
}

export function parseScanOutput(text: string): ScanGroupOutput[] | null {
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
        raw = null
      }
    }
  }
  if (!raw || typeof raw !== 'object') return null
  const list = (raw as { contradictions?: unknown }).contradictions
  if (!Array.isArray(list)) return null

  const groups: ScanGroupOutput[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const g = item as { topic?: unknown; kind?: unknown; variants?: unknown }
    const topic = typeof g.topic === 'string' ? g.topic.trim() : ''
    if (!topic || !Array.isArray(g.variants)) continue
    const variants: ScanVariantOutput[] = []
    for (const v of g.variants) {
      if (!v || typeof v !== 'object') continue
      const vv = v as { text?: unknown; sourceRefs?: unknown }
      const text = typeof vv.text === 'string' ? vv.text.trim() : ''
      if (!text) continue
      const refs = Array.isArray(vv.sourceRefs) ? vv.sourceRefs.filter((r): r is string => typeof r === 'string') : []
      variants.push({ text, sourceRefs: refs })
    }
    if (variants.length >= 2) {
      groups.push({ topic, kind: typeof g.kind === 'string' ? g.kind.trim() : '', variants })
    }
  }
  return groups
}

/**
 * 把预扫描分组映射为可落库的矛盾入参：`#N` 来源编号解析回 sourceId，
 * 无法解析来源编号的说法丢弃；剩余说法 <2 的分组丢弃；`seq` 按 1..N 顺序编号。
 */
export function scanGroupsToInputs(groups: ScanGroupOutput[] | null, refList: SourceRefEntry[]): ContradictionInput[] {
  if (!groups) return []
  const byRef = new Map(refList.map((r) => [`#${r.index}`, r.sourceId]))
  const kindSet: ReadonlySet<string> = new Set(['data', 'time', 'place', 'fact', 'other'])
  const inputs: ContradictionInput[] = []
  for (const g of groups) {
    const variants = g.variants
      .map((v) => ({
        variantText: v.text,
        sourceIds: [...new Set(v.sourceRefs.map((ref) => byRef.get(ref)).filter((id): id is string => Boolean(id)))]
      }))
      .filter((v) => v.sourceIds.length > 0)
    if (variants.length < 2) continue
    // 矛盾必须是"不同来源对同一事实的相左说法"；同一来源内部的详略差异 / 总分关系（如"总数 vs 分项之和"）不算矛盾（2026-08-13）
    const distinctSources = new Set(variants.flatMap((v) => v.sourceIds))
    if (distinctSources.size < 2) continue
    inputs.push({
      seq: inputs.length + 1,
      topic: g.topic,
      kind: (kindSet.has(g.kind) ? g.kind : 'other') as ContradictionKind,
      variants
    })
  }
  return inputs
}

/**
 * 把一批分块按字符上限切成若干窗口（2026-08-11 防漏改进②）：
 * 顺序滑动，单块长度本身 ≤ 500 字符，保证每个窗口不超过上限、且不遗漏任何块。
 */
export function sliceChunkWindows(chunks: RetrievedChunk[], maxChars: number): RetrievedChunk[][] {
  const windows: RetrievedChunk[][] = []
  let cur: RetrievedChunk[] = []
  let len = 0
  for (const c of chunks) {
    if (cur.length > 0 && len + c.text.length > maxChars) {
      windows.push(cur)
      cur = []
      len = 0
    }
    cur.push(c)
    len += c.text.length
  }
  if (cur.length > 0) windows.push(cur)
  return windows
}

/**
 * 按"共同字符对重叠"把资料聚成主题簇（2026-08-11 防漏改进②）：
 * 矛盾只可能出现在"涉及同一对象/同一事件"的资料之间；主题完全不同的资料（字符对重叠 < minDice）跳过配对，
 * 从而把分治扫描的调用量控制在有意义的范围内。同一地区/同一年度的资料通常共享大量字符对，会落入同一簇。
 * 2026-08-14：minDice 由 0.05 提高到 0.12——0.05 会把大量"泛教育/政治学习"网页新闻与真正学前教育资料聚成超大簇，
 * 导致相关矛盾被拆散稀释（test2 漏检 test1 矛盾的主因之一）；提高后簇更聚焦、窗口更少（扫描更快），
 * 仅字符对重叠很低的弱相关文章不再聚入，属于可接受的降噪取舍。
 */
export function clusterSourcesByTopics(chunkGroups: Map<string, RetrievedChunk[]>, minDice = 0.12): string[][] {
  const keys = [...chunkGroups.keys()]
  if (keys.length === 0) return []
  // 每份资料取"分块文本的字符对集合"（前 200 块足够代表主题，避免超大资料全量建集）
  const gramSets = new Map<string, Set<string>>()
  for (const k of keys) {
    const set = new Set<string>()
    for (const b of (chunkGroups.get(k) ?? []).slice(0, 200)) {
      for (const g of bigrams(b.text)) set.add(g)
    }
    gramSets.set(k, set)
  }
  // 并查集：dice ≥ minDice 的资料对连边，连通分量即主题簇
  const parent = new Map<string, string>(keys.map((k) => [k, k]))
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    let cur = x
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const A = gramSets.get(keys[i])!
      const B = gramSets.get(keys[j])!
      if (A.size === 0 || B.size === 0) continue
      const [small, large] = A.size <= B.size ? [A, B] : [B, A]
      const threshold = minDice * (A.size + B.size) / 2 // common 达到该值即 dice ≥ minDice，提前收束
      let common = 0
      for (const g of small) {
        if (large.has(g) && ++common >= threshold) break
      }
      if (common >= threshold) {
        const ra = find(keys[i])
        const rb = find(keys[j])
        if (ra !== rb) parent.set(rb, ra)
      }
    }
  }
  const clusters = new Map<string, string[]>()
  for (const k of keys) {
    const root = find(k)
    if (!clusters.has(root)) clusters.set(root, [])
    clusters.get(root)!.push(k)
  }
  return [...clusters.values()]
}

/** 两段主题文本的字符对相似度（合并去重用） */
function topicSimilarity(a: string, b: string): number {
  return dice(bigrams(a), bigrams(b))
}

/**
 * 合并多个窗口的扫描结果（2026-08-11 防漏改进②）：
 * topic 字符对相似度 ≥ 0.6 视为同一矛盾组 → 合并各说法（同文句去重、来源编号取并集）；否则保留为独立矛盾组。
 */
export function mergeScanGroups(groups: ScanGroupOutput[]): ScanGroupOutput[] {
  const merged: ScanGroupOutput[] = []
  for (const g of groups) {
    let hit = merged.find((m) => topicSimilarity(m.topic, g.topic) >= 0.6)
    if (!hit) {
      merged.push({ topic: g.topic, kind: g.kind, variants: g.variants.map((v) => ({ ...v })) })
      continue
    }
    hit.kind = hit.kind || g.kind
    for (const v of g.variants) {
      const existing = hit.variants.find((x) => x.text === v.text)
      if (existing) {
        existing.sourceRefs = [...new Set([...existing.sourceRefs, ...v.sourceRefs])]
      } else {
        hit.variants.push({ ...v })
      }
    }
  }
  return merged
}

/**
 * 单个窗口的矛盾扫描调用（2026-08-11，提速；2026-08-14 增强确认）：
 * 低温度 + 温度阶梯重试——解析失败（JSON 格式问题）值得全档重试；
 * 有发现立即返回；空结果则走完整温度阶梯（0 → 0.3 → 0.7）多确认，减少"该发现却没发现"的随机漏检
 * （test3 中"青少年心理援助中心/2021 幼儿园总数/鹤上云路小天使"来源都在却漏检的根因之一）。
 * 代价：确实无矛盾的窗口会多 1 次 LLM 调用，可接受。
 */
export function formatContradictionBlock(contradictions: ContradictionInput[], refList: SourceRefEntry[]): string {
  const bySource = new Map(refList.map((r) => [r.sourceId, r]))
  const lines = contradictions.map((c, i) => {
    const idx = i + 1
    const kindLabel = CONTRADICTION_KIND_LABEL[c.kind ?? 'other']
    const variantTexts = c.variants.map((v) => {
      const titles = v.sourceIds.map((id) => `《${bySource.get(id)?.title ?? id}》`).join('、')
      return `${v.variantText}（${titles}）`
    })
    return `- 矛盾 #${idx}（${kindLabel}）：${c.topic}——${variantTexts.join('；')}`
  })
  return [
    '【材料矛盾提示】',
    '生成过程中请注意，以下材料之间对同一史实的记述存在矛盾（矛盾编号与正文标注对应）：',
    ...lines,
    '',
    '若正文涉及上述矛盾史实，必须遵守以下规则：',
    '1. 严禁将不同说法自然合并、折中成材料中没有的表述（例如写成"约三万人""八十年代中期"这类两边都不挨着的折中说法）；',
    '2. 应当分开并列表述（如"据《某文件》记载……，而《另一文件》则载……"），或只采用其中一种表述（不强行调和，其余说法保留在矛盾清单中交由人工取舍）；',
    '3. 在正文相关位置插入标记【矛盾#N】（N 为上方矛盾编号），供人工审阅。'
  ].join('\n')
}

/** 矛盾定位审查输出：单条正文矛盾定位 */
export interface LocateItem {
  seq: number
  draftQuote: string | null
  merged: boolean
  replacements?: { variantIndex: number; text: string }[]
}

export function parseLocateOutput(text: string): LocateItem[] | null {
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
        raw = null
      }
    }
  }
  if (!raw || typeof raw !== 'object') return null
  const items = (raw as { items?: unknown }).items
  if (!Array.isArray(items)) return null
  const out: LocateItem[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const it = item as { seq?: unknown; draftQuote?: unknown; merged?: unknown; replacements?: unknown }
    if (typeof it.seq !== 'number') continue
    const quote = typeof it.draftQuote === 'string' ? it.draftQuote.trim() : null
    const replacements: { variantIndex: number; text: string }[] = []
    if (Array.isArray(it.replacements)) {
      for (const r of it.replacements) {
        if (!r || typeof r !== 'object') continue
        const rr = r as { variantIndex?: unknown; text?: unknown }
        if (typeof rr.variantIndex !== 'number' || typeof rr.text !== 'string') continue
        const text = rr.text.trim()
        if (Number.isInteger(rr.variantIndex) && rr.variantIndex >= 1 && text) {
          replacements.push({ variantIndex: rr.variantIndex, text })
        }
      }
    }
    out.push({
      seq: it.seq,
      draftQuote: quote,
      merged: it.merged === true,
      replacements: replacements.length > 0 ? replacements : undefined
    })
  }
  return out
}

/**
 * 矛盾定位审查调用（失败/解析失败/在正文矛盾缺 replacements 自动重试，2026-08-11）：
 * 低温度 + 温度阶梯重试；在正文的矛盾必须带完整"采纳替换文句"（否则采纳修订无法本地完成），缺失则重试。
 * 多次尝试仍失败返回 null，由调用方降级为"矛盾保留但无正文定位"。
 */
export function parseGenerateOutput(text: string): { title: string; content: string } | { error: string } | null {
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
        raw = null
      }
    }
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { title?: unknown; content?: unknown; error?: unknown }
  const err = typeof obj.error === 'string' && obj.error.trim() ? obj.error.trim() : ''
  if (err) return { error: err }
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  const content = typeof obj.content === 'string' ? obj.content.trim() : ''
  if (title && content) return { title, content }
  return null
}

type ProviderInfo = { apiBase: string; model: string; apiKey: string }

/** 解析各步骤使用的大模型（Phase 6.8）：一律以设置中的「步骤默认模型」为准；第 1 步用 compilation、第 3 步/对话用 draft */
function resolveTaskProvider(step?: 'compilation' | 'draft' | 'chat'):
  | { ok: true; provider: ProviderInfo }
  | { ok: false; error: { code: string; message: string } } {
  const settings = getSettings()
  const providerId = step === 'compilation'
    ? settings.compilationProviderId
    : settings.draftProviderId
  if (!providerId) {
    return {
      ok: false,
      error: {
        code: ErrorCodes.TASK_NO_PROVIDER,
        message: step === 'compilation' ? '请先在设置中为「第 1 步」指定默认大模型' : '请先在设置中为「第 3 步」指定默认大模型'
      }
    }
  }
  const provider = getProviderSecret(providerId, safeStorageCodec)
  if (!provider) return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '所选的 LLM Provider 不存在' } }
  if (!provider.apiKey) return { ok: false, error: { code: ErrorCodes.LLM_UNAUTHORIZED, message: '所选的 LLM Provider 未设置 API 密钥' } }
  return { ok: true, provider: { apiBase: provider.config.apiBase, model: provider.config.model, apiKey: provider.apiKey } }
}

/**
 * 依据历史调用日志估算某类 LLM 调用的平均耗时（秒），用于生成进度"剩余时间"预估；
 * 无历史记录或读取失败时回退默认值。失败调用不计入平均。
 */
function estimateLlmSeconds(kind: string, fallbackSec: number): number {
  try {
    const rows = getDb()
      .prepare("SELECT elapsed_ms FROM llm_call_logs WHERE kind = ? AND status = 'ok' ORDER BY created_at DESC LIMIT 5")
      .all(kind) as { elapsed_ms: number }[]
    if (rows.length === 0) return fallbackSec
    const avg = rows.reduce((s, r) => s + r.elapsed_ms, 0) / rows.length
    return Math.max(5, Math.round(avg / 1000))
  } catch {
    return fallbackSec
  }
}

/** 生成初稿（第 0 稿）；已存在则幂等返回。instruction 为用户要求（应包含标题与可能的其他要求）。
 *  onProgress 可选：生成过程中推送阶段进度（stage 文字提示 + percent 进度百分比 + etaSeconds 预计剩余秒数），
 *  供界面展示文字提示与进度条。 */
export async function generateDraft(
  taskId: string,
  instruction: string,
  onProgress?: (stage: string, percent: number, etaSeconds?: number) => void,
  /** 流式输出：正文 content 的增量文本（2026-08-19，供前端实时显示） */
  onDelta?: (text: string) => void,
  /** Phase 6.3：使用已确认的资料汇编作为材料（缺省走旧检索链路） */
  compilationId?: string
): Promise<GenerateResult> {
  const task = getTaskById(taskId)
  if (!task) return fail(ErrorCodes.TASK_NOT_FOUND, '撰写任务不存在')

  const inst = instruction.trim()
  if (!inst) return fail(ErrorCodes.INVALID_PARAM, '请填写本次撰写的标题与要求')

  // 强制三步式（Phase A/B）：必须基于“已确认的资料汇编”生成初稿；缺失/未确认直接报错，不再走旧检索链路
  if (!compilationId) return fail(ErrorCodes.COMPILATION_NOT_FINALIZED, '请先确认资料汇编')
  const compilation = getCompilationById(compilationId)
  if (!compilation) return fail(ErrorCodes.COMPILATION_NOT_FINALIZED, '资料汇编不存在')
  if (compilation.status !== 'finalized') return fail(ErrorCodes.COMPILATION_NOT_FINALIZED, '资料汇编尚未确认，请先在第一步确认汇编')

  const prov = resolveTaskProvider('draft')
  if (!prov.ok) return prov

  // 幂等：第 0 稿已存在则直接返回（含既有矛盾清单）。
  // 检查前置到任何副作用之前：避免重复写入指令消息、重复整理摘要/抓取网页/检索/扫描等重开销工作。
  const existing = getDraftRowByVersion(taskId, 0)
  if (existing) {
    const draft = getDraftById(existing.id)
    if (draft) return { ok: true, draft, articleTitle: task.articleTitle ?? null, contradictions: getContradictionsByDraft(existing.id) }
  }


  updateTaskInstruction(taskId, inst)
  addTaskMessage(taskId, 'user', inst, 'instruction')

  const chunks: RetrievedChunk[] = compilation.items
    .filter((it) => it.kept)
    .map((it) => ({
      sourceId: it.sourceId,
      sourceTitle: it.sourceTitle ?? it.sourceId,
      position: it.note ?? '',
      text: it.excerpt,
      score: 0
    }))
  if (chunks.length === 0) return fail(ErrorCodes.LLM_NO_CANDIDATES, '资料汇编中没有可用的资料卡片')

  const styleGuide = getDefaultStyleGuide()?.content ?? DEFAULT_STYLE_GUIDE
  const materialsOrigin = '【参考材料】（来自你已确认的资料汇编，已剔除矛盾取舍中被排除的卡片）'
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(undefined, styleGuide) },
    { role: 'user', content: buildUserPrompt(inst, chunks, styleGuide, task.modelText, materialsOrigin) }
  ]

  onProgress?.('正在基于已确认汇编生成初稿…', GENERATE_PROGRESS.generateFrom, estimateLlmSeconds('generate', 180))
  const contentStreamer = onDelta ? createJsonFieldStreamer('content') : null
  const result = await chatCompletion(prov.provider, messages, DRAFT_GENERATE_TIMEOUT_MS, { kind: 'generate', taskId }, {
    maxRetries: 2,
    onDelta: contentStreamer ? (delta) => onDelta?.(contentStreamer.feed(delta)) : undefined
  })
  if (!result.ok) {
    addTaskMessage(taskId, 'assistant', '生成失败：' + result.error.message, 'notice')
    return { ok: false, error: result.error }
  }
  const parsed = parseGenerateOutput(result.text)
  if (!parsed) {
    addTaskMessage(taskId, 'assistant', '生成失败：模型输出无法解析为「标题 + 正文」结构，请重试', 'notice')
    return fail(ErrorCodes.LLM_FORMAT_INVALID, '模型输出无法解析为「标题 + 正文」结构，请重试')
  }
  if ('error' in parsed) {
    addTaskMessage(taskId, 'assistant', '生成失败：' + parsed.error, 'notice')
    return fail(ErrorCodes.LLM_FORMAT_INVALID, parsed.error)
  }
  const draft = createDraft(taskId, 0)
  // 记录生成上下文：本次实际使用的汇编卡片材料块，供'文段来源询问'按生成时的上下文溯源
  saveDraftGenerationContext(draft.id, chunks)
  addSegment({ draftId: draft.id, ordering: 0, content: parsed.content, aiGenerated: true })
  updateTaskArticleTitle(taskId, parsed.title)
  addTaskMessage(taskId, 'assistant', '初稿《' + parsed.title + '》已生成。', 'notice')
  const saved = getDraftById(draft.id)
  if (!saved) return fail(ErrorCodes.INTERNAL_ERROR, '初稿保存失败')
  onProgress?.('初稿生成完成', GENERATE_PROGRESS.done, 0)
  return { ok: true, draft: saved, articleTitle: parsed.title, contradictions: [] }
}

/**
 * 重新生成初稿（Task 3.4.5）：删除现有第 0 稿后按当前要求/资料/范本重新生成（覆盖旧稿）。
 */
export async function regenerateDraft(
  taskId: string,
  instruction: string,
  onProgress?: (stage: string, percent: number, etaSeconds?: number) => void,
  onDelta?: (text: string) => void,
  /** Phase 6.3：使用已确认的资料汇编作为材料（缺省走旧检索链路） */
  compilationId?: string
): Promise<GenerateResult> {
  deleteDraftByVersion(taskId, 0)
  return generateDraft(taskId, instruction, onProgress, onDelta, compilationId)
}

/** 任务当前最新一稿的正文文本（用于对话上下文；无初稿返回空串） */
function getLatestDraftText(taskId: string): string {
  const db = getDb()
  const rows = db
    .prepare('SELECT id FROM drafts WHERE task_id = ? ORDER BY version_number DESC LIMIT 1')
    .all(taskId) as { id: string }[]
  if (rows.length === 0) return ''
  const draft = getDraftById(rows[0].id)
  if (!draft) return ''
  return draft.segments
    .map((s) => [s.heading, s.content].filter(Boolean).join('\n'))
    .join('\n\n')
    .slice(0, CHAT_DRAFT_MAX_CHARS)
}

/**
 * 与大模型自由对话（Phase 3.5）：用任务大模型，注入当前初稿作为上下文，返回回复文本。
 * history 为前端维护的最近对话（{role, content}）。
 */
export async function chatWithTask(
  taskId: string,
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
  /** 流式输出：回复文本增量（2026-08-19，供前端实时显示） */
  onDelta?: (text: string) => void
): Promise<{ ok: true; reply: string } | { ok: false; error: { code: string; message: string } }> {
  const task = getTaskById(taskId)
  if (!task) return { ok: false, error: { code: ErrorCodes.TASK_NOT_FOUND, message: '撰写任务不存在' } }
  if (!message.trim()) return { ok: false, error: { code: ErrorCodes.INVALID_PARAM, message: '消息不能为空' } }

  const prov = resolveTaskProvider('chat')
  if (!prov.ok) return prov

  const draftText = getLatestDraftText(taskId)
  const sys: ChatMessage = {
    role: 'system',
    content: [
      '你是资深的地方志书撰稿助手，遵循"实事求是、述而不作、横排门类、纵述史实"的志书体例，回答使用简体中文、客观平实。',
      draftText
        ? `当前任务的初稿正文如下（供你回答时参考；用户若要求修改初稿，请给出具体的修改建议或修改后的文本）：\n${draftText}`
        : '当前任务尚未生成初稿，你可以就撰写要求、体例、构思等与用户交流。'
    ].join('\n\n')
  }

  const safeHistory: ChatMessage[] = (history ?? [])
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
    .slice(-20)
    .map((h) => ({ role: h.role, content: h.content }))

  const messages: ChatMessage[] = [sys, ...safeHistory, { role: 'user', content: message }]
  // 持久化用户消息（痕迹）
  addTaskMessage(taskId, 'user', message, 'chat')
  // 对话超时放宽到 5 分钟（问题3修复：携带初稿+历史时 Deepseek 等模型响应较慢，默认 60s 不够）
  // 2026-08-19：流式增量 + 瞬时故障自动重试（429/5xx/网络错误 2 次指数退避）
  const result = await chatCompletion(prov.provider, messages, CHAT_TIMEOUT_MS, { kind: 'chat', taskId }, {
    maxRetries: 2,
    onDelta
  })
  if (!result.ok) {
    addTaskMessage(taskId, 'assistant', `对话失败：${result.error.message}`, 'notice')
    return { ok: false, error: result.error }
  }
  addTaskMessage(taskId, 'assistant', result.text.trim(), 'chat')
  return { ok: true, reply: result.text.trim() }
}

/** 任务范围内的检索预览（writing:retrieve，供界面展示与验收） */
export async function retrieveForTask(taskId: string): Promise<RetrievedChunk[] | null> {
  const task = getTaskById(taskId)
  if (!task) return null
  const scopeIds = resolveScopeSourceIds(task, { getSourceIdsByTag, getAllSourceIds })
  if (scopeIds.length === 0) return []
  return retrieveChunksHybrid(scopeIds, task.userInstruction ?? task.title)
}

/** 混合检索：摘要级粗筛（理解资料）→ 过滤式精检（只剔除确定无关段落，不设数量上限） */
async function retrieveChunksHybrid(scopeIds: string[], query: string): Promise<RetrievedChunk[]> {
  // 摘要粗筛：任务范围内有摘要索引时，先只保留与任务标题相关的资料（"理解资料后再检索"）
  const scoped = filterSourcesBySummary(scopeIds, query)
  if (scoped !== null && scoped.length === 0) return [] // 有摘要但都不相关 → 无候选
  const vectors = await embedTexts([query]).catch(() => null)
  const queryVector = vectors ? vectors[0] : undefined
  return retrieveChunks({ sourceIds: scoped ?? scopeIds, query, queryVector })
}

/**
 * 摘要级粗筛（Task 3.4.2）：用任务标题与各资料 LLM 摘要（summary/keywords/entities）的相关性打分，
 * 只保留相关资料再进入 chunk 精检。
 * 返回 null 表示"任务范围内没有任何资料有摘要"（用户未执行"整理资料库"）→ 调用方不过滤，走全量检索。
 * 无摘要的资料**保守保留**（不排除，避免误伤未整理的资料）。
 */
export function filterSourcesBySummary(scopeIds: string[], query: string): string[] | null {
  const summaries = getSourceSummariesByIds(scopeIds)
  let anySummary = false
  const kept: string[] = []
  for (const id of scopeIds) {
    const s = summaries.get(id)
    if (!s) {
      kept.push(id)
      continue
    }
    anySummary = true
    if (summaryRelevance(query, s) > 0) kept.push(id)
  }
  return anySummary ? kept : null
}

/** 资料摘要与任务标题的相关性打分（纯函数、可测试）：主题词/实体命中 + 查询 bigram 在摘要文本中的命中数 */
export function summaryRelevance(query: string, s: Pick<SourceSummary, 'summary' | 'keywords' | 'entities'>): number {
  const q = query.replace(/\s+/g, '')
  let score = 0
  for (const k of s.keywords) {
    if (k && (q.includes(k) || k.includes(q))) score += 3
  }
  for (const e of s.entities) {
    if (e && q.includes(e)) score += 3
  }
  // 查询 bigram 在摘要文本中出现的个数（而非"整体相似度"）：用户指令是长句，
  // 整句 bigram 重叠率（dice*10）会被长文本稀释成 0，导致摘要里明明提到相关主题（如"学前教育"）
  // 的资料被摘要粗筛整份剔除（如 300教育（定）.docx 记述 2021 年全区教育情况却被跳过）。
  // 改为直接统计查询字符对在摘要里的命中数：只要存在实质主题重叠（≥1）就保留，交给 chunk 级精检兜底。
  const text = `${s.summary} ${s.keywords.join(' ')}`
  const textBigrams = new Set(bigrams(text))
  score += bigrams(q).filter((b) => textBigrams.has(b)).length
  return score
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('summary-based source prefilter (Task 3.4.2)', () => {
    it('scores high for keyword-matched summary', () => {
      const s = { summary: '介绍本县科技项目实施情况与主要成果。', keywords: ['科技', '项目', '成果'], entities: ['科技局'] }
      expect(summaryRelevance('科技项目与成果', s)).toBeGreaterThan(3)
    })

    it('scores zero for unrelated summary (excluded)', () => {
      const s = { summary: '介绍历代地方官宦人物生平事迹。', keywords: ['人物', '传记'], entities: ['某县官'] }
      expect(summaryRelevance('科技项目与成果', s)).toBe(0)
    })

    it('is conservative: keyword inclusion boosts score', () => {
      const s = { summary: '公共环境卫生管理制度与设施配备情况。', keywords: ['卫生'], entities: [] }
      expect(summaryRelevance('公共场所卫生', s)).toBeGreaterThan(0)
    })

    it('keeps a source whose summary mentions the topic even under a long instruction (2021 教育资料回归)', () => {
      // 回归：用户指令是长句，旧打分（整句 bigram 相似度 *10 取整）把重叠率稀释成 0，
      // 导致摘要明确提到"学前教育"的《300教育（定）.docx》（2021 年全区教育情况）被摘要粗筛整份剔除。
      const s = {
        summary: '2021年长乐区教育事业发展综述，涵盖各级各类学校概况、德育、体艺、督导等，并分述学前教育、义务教育及中考情况。',
        keywords: ['教育概况', '德育工作', '双减'],
        entities: ['长乐区']
      }
      const query = '这次撰写任务的标题为"学前教育"，分为两个子标题"教育与保育"和"园所设置"。注意按照时间顺序展开'
      expect(summaryRelevance(query, s)).toBeGreaterThan(0)
      // 无关资料（如台湾事务）仍应被打分为 0 而排除
      const unrelated = { summary: '1995至2005年长乐市与台湾地区的交往情况。', keywords: ['台胞台属'], entities: ['长乐市'] }
      expect(summaryRelevance(query, unrelated)).toBe(0)
    })
  })

  describe('default style guide injection (Phase 6.4 移除 skills 后)', () => {
    it('injects default style guide into system prompt', () => {
      const sys = buildSystemPrompt()
      expect(sys).toContain('【志书写作规范（必须遵守）】')
      expect(sys).toContain('文体')
      expect(sys).toContain('行文规则')
      expect(sys).toContain('述而不作')
    })

    it('injects default style guide into user prompt (no 部类细则)', () => {
      const chunks: RetrievedChunk[] = [{ sourceId: 's1', sourceTitle: '某报告', position: '第1段', text: '正文。', score: 1 }]
      const user = buildUserPrompt('标题为学前教育', chunks)
      expect(user).toContain('【写作规范】')
      expect(user).toContain('文体')
      expect(user).not.toContain('【参考范本】')
      expect(user).not.toContain('部类细则')
      expect(user).not.toContain('【学前教育】')
    })

    it('injects task-level 范本 into user prompt when modelText provided (Phase 6.4.2)', () => {
      const chunks: RetrievedChunk[] = [{ sourceId: 's1', sourceTitle: '某报告', position: '第1段', text: '正文。', score: 1 }]
      const user = buildUserPrompt('标题为学前教育', chunks, DEFAULT_STYLE_GUIDE, '这是一段范本示例正文。')
      expect(user).toContain('【参考范本】')
      expect(user).toContain('这是一段范本示例正文。')
      expect(user).toContain('参考【参考范本】的体例与行文风格')
    })

    it('marks materials as from the confirmed compilation (Step 3, materialsOrigin)', () => {
      const chunks: RetrievedChunk[] = [{ sourceId: 's1', sourceTitle: '某报告', position: '第1段', text: '正文。', score: 1 }]
      const origin = '【参考材料】（来自你已确认的资料汇编，已剔除矛盾取舍中被排除的卡片）'
      const user = buildUserPrompt('标题为学前教育', chunks, DEFAULT_STYLE_GUIDE, undefined, origin)
      expect(user).toContain('来自你已确认的资料汇编')
      expect(user).toContain('已剔除矛盾取舍中被排除的卡片')
      expect(user).not.toContain('【参考范本】')
    })
  })

  describe('draft generation prompts (Phase 3.5: 指令驱动 + JSON 输出契约)', () => {
    it('system prompt requires one coherent article and JSON output contract', () => {
      const sys = buildSystemPrompt()
      expect(sys).toContain('连贯成文')
      expect(sys).toContain('篇幅由材料中实际可用的有效内容自然决定')
      expect(sys).toContain('从用户要求中抓取文章标题')
      expect(sys).toContain('缺少标题等必要信息')
      expect(sys).toContain('"error"')
      expect(sys).not.toContain('segments')
      expect(sys).not.toContain('字数上限')
    })

    it('user prompt carries the user instruction (requirements with title)', () => {
      const chunks: RetrievedChunk[] = [
        { sourceId: 's1', sourceTitle: '某报告', position: '第1段', text: '正文内容。', score: 10 }
      ]
      const prompt = buildUserPrompt('这次撰写任务的标题为教育事业，要求突出近年发展', chunks)
      expect(prompt).toContain('【用户要求】')
      expect(prompt).toContain('这次撰写任务的标题为教育事业')
      expect(prompt).toContain('连贯志书正文')
      expect(prompt).not.toContain('按片段组织')
    })
  })

  describe('parseGenerateOutput (Phase 3.5: title/content/error)', () => {
    it('parses { title, content } success output', () => {
      const out = parseGenerateOutput('{"title":"教育事业","content":"全县教育事业稳步发展。","error":null}')
      expect(out).toEqual({ title: '教育事业', content: '全县教育事业稳步发展。' })
    })

    it('returns detailed error when required info missing', () => {
      const out = parseGenerateOutput('{"title":null,"content":null,"error":"用户要求中未提供标题，请补充本次撰写的标题。"}')
      expect(out).toEqual({ error: '用户要求中未提供标题，请补充本次撰写的标题。' })
    })

    it('handles fenced JSON output', () => {
      const out = parseGenerateOutput('```json\n{"title":"教育","content":"正文"}```')
      expect(out).toEqual({ title: '教育', content: '正文' })
    })

    it('returns null for unparseable output', () => {
      expect(parseGenerateOutput('纯文本没有 JSON')).toBeNull()
      expect(parseGenerateOutput('')).toBeNull()
    })
  })

  describe('contradiction scan & locate (Phase 3.7.2)', () => {
    const refChunks: RetrievedChunk[] = [
      { sourceId: 's1', sourceTitle: '年度报告A', position: '第1段', text: 'a', score: 1 },
      { sourceId: 's2', sourceTitle: '统计年鉴B', position: '第2段', text: 'b', score: 1 },
      { sourceId: 's1', sourceTitle: '年度报告A', position: '第3段', text: 'a2', score: 1 },
      { sourceId: 's3', sourceTitle: '工作纪要C', position: '第4段', text: 'c', score: 1 }
    ]

    it('builds source ref list with dedupe and first-appearance order', () => {
      const refs = buildSourceRefList(refChunks)
      expect(refs).toEqual([
        { index: 1, sourceId: 's1', title: '年度报告A' },
        { index: 2, sourceId: 's2', title: '统计年鉴B' },
        { index: 3, sourceId: 's3', title: '工作纪要C' }
      ])
    })

    it('parses scan output with multi-source groups and fenced JSON', () => {
      const out = parseScanOutput(
        '```json\n{"contradictions": [{"topic": "在校生人数", "kind": "data", "variants": [{"text": "3.2 万人", "sourceRefs": ["#1"]}, {"text": "3.6 万人", "sourceRefs": ["#2", "#3"]}]}]}\n```'
      )
      expect(out).toHaveLength(1)
      expect(out![0].topic).toBe('在校生人数')
      expect(out![0].kind).toBe('data')
      expect(out![0].variants[1].sourceRefs).toEqual(['#2', '#3'])
    })

    it('parses empty scan output and drops invalid groups', () => {
      expect(parseScanOutput('{"contradictions": []}')).toEqual([])
      // 少于 2 条有效说法、缺 topic、缺 text 的分组被丢弃
      const out = parseScanOutput(
        '{"contradictions": [{"topic": "仅一种说法", "variants": [{"text": "只有一种", "sourceRefs": ["#1"]}]}, {"variants": [{"text": "缺主题", "sourceRefs": ["#1"]}, {"text": "第二说法", "sourceRefs": ["#2"]}]}, {"topic": "有说法缺text", "variants": [{"text": "", "sourceRefs": ["#1"]}, {"text": "有效", "sourceRefs": ["#2"]}]}]}'
      )
      expect(out).toEqual([])
      expect(parseScanOutput('纯文本')).toBeNull()
      expect(parseScanOutput('{"nope": 1}')).toBeNull()
    })

    it('maps scan groups to inputs resolving #N refs and defaulting kind', () => {
      const refs = buildSourceRefList(refChunks)
      const groups = parseScanOutput(
        '{"contradictions": [{"topic": "在校生人数", "kind": "data", "variants": [{"text": "3.2 万人", "sourceRefs": ["#1"]}, {"text": "3.6 万人", "sourceRefs": ["#2", "#3"]}]}, {"topic": "成立时间", "kind": "weird", "variants": [{"text": "1984 年", "sourceRefs": ["#1"]}, {"text": "1986 年", "sourceRefs": ["#2"]}, {"text": "1987 年", "sourceRefs": ["#3"]}]}]}'
      )!
      const inputs = scanGroupsToInputs(groups, refs)
      expect(inputs).toHaveLength(2)
      expect(inputs[0].seq).toBe(1)
      expect(inputs[0].kind).toBe('data')
      expect(inputs[0].variants[0].sourceIds).toEqual(['s1'])
      expect(inputs[0].variants[1].sourceIds).toEqual(['s2', 's3'])
      // 非法 kind 回退为 other；3+ 说法同主题保留
      expect(inputs[1].kind).toBe('other')
      expect(inputs[1].variants).toHaveLength(3)
      // 无法解析的来源编号被丢弃，导致说法不足则整组丢弃
      const dropped = scanGroupsToInputs(
        [{ topic: 't', kind: '', variants: [{ text: 'a', sourceRefs: ['#1'] }, { text: 'b', sourceRefs: ['#99'] }] }],
        refs
      )
      expect(dropped).toEqual([])
      expect(scanGroupsToInputs(null, refs)).toEqual([])
      // 同一来源内部的详略/总分差异不算矛盾（2026-08-13：test1 中"报名536人 vs 上半年217+下半年219"误判回归）
      const sameSource = scanGroupsToInputs(
        [{ topic: '同源总分', kind: 'data', variants: [{ text: '报名536人', sourceRefs: ['#1'] }, { text: '上半年217下半年219', sourceRefs: ['#1'] }] }],
        refs
      )
      expect(sameSource).toEqual([])
    })

    it('formats contradiction block with markers and strict no-merge instruction', () => {
      const refs = buildSourceRefList(refChunks)
      const inputs = scanGroupsToInputs(
        [
          {
            topic: '在校生人数',
            kind: 'data',
            variants: [
              { text: '3.2 万人', sourceRefs: ['#1'] },
              { text: '3.6 万人', sourceRefs: ['#2', '#3'] }
            ]
          }
        ],
        refs
      )
      const block = formatContradictionBlock(inputs, refs)
      expect(block).toContain('【材料矛盾提示】')
      expect(block).toContain('矛盾 #1（数据）：在校生人数')
      expect(block).toContain('《年度报告A》')
      expect(block).toContain('《统计年鉴B》')
      expect(block).toContain('严禁将不同说法自然合并、折中成材料中没有的表述')
      expect(block).toContain('【矛盾#N】')

      // 注入到 system prompt：无矛盾时不出现；有矛盾时出现
      const sys = buildSystemPrompt(block)
      expect(sys).toContain('【材料矛盾提示】')
      expect(sys).toContain('严禁将不同说法自然合并')
      expect(sys).toContain('【矛盾#N】')
      expect(buildSystemPrompt()).not.toContain('【材料矛盾提示】')
    })

    it('parses locate output with quotes, null quotes and merged flags', () => {
      const out = parseLocateOutput(
        '{"items": [{"seq": 1, "draftQuote": "全县小学在校生人数为三万余人。", "merged": true}, {"seq": 2, "draftQuote": null, "merged": false}]}'
      )
      expect(out).toEqual([
        { seq: 1, draftQuote: '全县小学在校生人数为三万余人。', merged: true },
        { seq: 2, draftQuote: null, merged: false }
      ])
      // 缺 seq / 非数组 / 纯文本 → null
      expect(parseLocateOutput('{"items": [{"draftQuote": "x", "merged": false}]}')).toEqual([])
      expect(parseLocateOutput('{"nope": 1}')).toBeNull()
      expect(parseLocateOutput('纯文本')).toBeNull()
    })

    it('parses locate output with per-variant adoption replacements (2026-08-11)', () => {
      const out = parseLocateOutput(
        '{"items": [{"seq": 1, "draftQuote": "在校生三万余人。", "merged": false, "replacements": [{"variantIndex": 1, "text": "在校生为3.2万人。"}, {"variantIndex": 2, "text": "在校生为3.6万人。"}]}]}'
      )
      expect(out).toEqual([
        {
          seq: 1,
          draftQuote: '在校生三万余人。',
          merged: false,
          replacements: [
            { variantIndex: 1, text: '在校生为3.2万人。' },
            { variantIndex: 2, text: '在校生为3.6万人。' }
          ]
        }
      ])
      // 非法替换条目（非整数序号 / 空文句）被丢弃；空 replacements 省略
      const filtered = parseLocateOutput(
        '{"items": [{"seq": 1, "draftQuote": "x", "merged": false, "replacements": [{"variantIndex": 0, "text": "非法"}, {"variantIndex": 1.5, "text": "非法"}, {"variantIndex": 2, "text": ""}, {"variantIndex": 3, "text": "合法"}]}]}'
      )
      expect(filtered).toEqual([{ seq: 1, draftQuote: 'x', merged: false, replacements: [{ variantIndex: 3, text: '合法' }] }])
      expect(
        parseLocateOutput('{"items": [{"seq": 1, "draftQuote": "x", "merged": false, "replacements": []}]}')
      ).toEqual([{ seq: 1, draftQuote: 'x', merged: false }])
    })
  })

  describe('contradiction scan divide & conquer (2026-08-11 防漏改进)', () => {
    const mk = (sourceId: string, sourceTitle: string, position: string, text: string): RetrievedChunk => ({
      sourceId,
      sourceTitle,
      position,
      text,
      score: 0
    })

    it('slices chunk windows under char cap without dropping any block', () => {
      const chunks = [
        mk('s1', 'A', '第1段', 'x'.repeat(200)),
        mk('s1', 'A', '第2段', 'y'.repeat(200)),
        mk('s2', 'B', '第3段', 'z'.repeat(200))
      ]
      const windows = sliceChunkWindows(chunks, 500)
      expect(windows).toHaveLength(2)
      expect(windows[0]).toHaveLength(2)
      expect(windows[1]).toHaveLength(1)
      expect(windows.flat()).toHaveLength(3) // 不遗漏任何块
      expect(windows.every((w) => w.reduce((n, c) => n + c.text.length, 0) <= 500)).toBe(true)
    })

    it('clusters sources by shared bigrams: same-topic docs in one cluster, unrelated separated', () => {
      const groups = new Map<string, RetrievedChunk[]>([
        ['edu1', [mk('edu1', '2021年教育', '第1段', '2021年全区学前教育毛入园率达98%。')]],
        ['edu2', [mk('edu2', '2022年教育', '第1段', '2021年全区学前教育毛入园率达95%。')]],
        ['taiwan', [mk('taiwan', '台湾事务', '第1段', '两岸经贸合作日益密切，台胞台属增多。')]]
      ])
      const clusters = clusterSourcesByTopics(groups)
      expect(clusters).toHaveLength(2)
      const edu = clusters.find((c) => c.includes('edu1'))
      expect(edu).toContain('edu2')
      expect(edu).not.toContain('taiwan')
      const taiwan = clusters.find((c) => c.includes('taiwan'))
      expect(taiwan).not.toContain('edu1')
    })

    it('merges duplicate scan groups by topic similarity and unions source refs', () => {
      const g1 = { topic: '在校生人数', kind: 'data', variants: [{ text: '3.2万人', sourceRefs: ['#1'] }] }
      const g2 = {
        topic: '在校生人数',
        kind: 'data',
        variants: [
          { text: '3.6万人', sourceRefs: ['#2'] },
          { text: '3.2万人', sourceRefs: ['#1'] }
        ]
      }
      const g3 = {
        topic: '机构成立时间',
        kind: 'time',
        variants: [
          { text: '1984年', sourceRefs: ['#3'] },
          { text: '1986年', sourceRefs: ['#4'] }
        ]
      }
      const merged = mergeScanGroups([g1, g2, g3])
      expect(merged).toHaveLength(2)
      const group = merged.find((x) => x.topic === '在校生人数')!
      expect(group.variants).toHaveLength(2)
      expect(group.variants.find((v) => v.text === '3.2万人')!.sourceRefs).toEqual(['#1'])
      expect(group.variants.find((v) => v.text === '3.6万人')!.sourceRefs).toEqual(['#2'])
      // 不同主题不合并
      expect(merged.find((x) => x.topic === '机构成立时间')).toBeDefined()
    })
  })
}
