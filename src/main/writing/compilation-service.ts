/**
 * compilation-service.ts —— 资料汇编生成服务（Phase 6.1，2026-08-25）。
 * 三步：① 本地宽召回（宁多勿漏）→ ② AI 细读候选并产出卡片/矛盾 → ③ 落库为 compilations/items/contradictions。
 * 无 Provider / AI 调用失败时降级为「本地候选直接成卡片」，不阻断。
 */
import type { RetrievedChunk } from '../../shared/types'
import { ErrorCodes } from '../../shared/types'
import { getTaskById, resolveScopeSourceIds, getAllSourceIds, renameTask } from '../db/tasks'
import { getSourceIdsByTag } from '../db/tags'
import { getSourcesByIds } from '../db/sources'
import { bigrams, chunkParagraphs, scoreChunk } from '../rag/retrieval'
import { embedTexts } from '../rag/embed'
import { vectorSearch } from '../rag/vector-store'
import { getSettings } from '../db/settings'
import { getProviderSecret } from '../llm/provider-store'
import { safeStorageCodec } from '../llm/secret'
import { chatCompletion, type ChatMessage } from '../llm/chat'
import { fetchRelatedSiteSources, extractTopicTerms, expandDomainHints } from '../web-source/site-crawler'
import {
  createCompilation,
  insertCompilationItems,
  insertCompilationContradictions,
  type CompilationItemInput,
  type CompilationContradictionInput
} from '../db/compilations'

const COMPILATION_TIMEOUT_MS = 600000
const WINDOW_MAX_CHARS = 30000
const WINDOW_CONCURRENCY = 2
const TEMPERATURES = [0, 0.3]
const KEYWORD_EXTRACT_TIMEOUT_MS = 60000
const CARD_SCAN_TIMEOUT_MS = 120000
/** 卡片级矛盾扫描单次最多扫描的卡片数（卡片集通常远小于原始材料，一次扫描成本低） */
const CARD_SCAN_MAX = 200
/** 可复现种子：传给支持 seed 的 Provider，让关键帧提取/细读/矛盾扫描在相同输入下更确定 */
const REPRODUCIBILITY_SEED = 42
/** 卡片级矛盾扫描的温度阶梯（低温度 + 稍高温度各扫一次后按主题并集，提升召回且成本低） */
const CARD_SCAN_TEMPERATURES = [0, 0.3]
/** 关键帧提取结果按「撰写要求」缓存，保证同一指令的两轮任务用同一套粗筛关键词（B：消除第一层漂移） */
const keywordExtractionCache = new Map<string, KeywordExtraction>()

// 调用大模型前的保守本地闸门（2026-08-25 优化：显著减少提交窗口数，同时尽量不漏可能相关的段落）
// 词法相关：scoreChunk > 0（与标题/主题有任何字面或字符对关联）即保留；
// 向量语义：余弦 ≥ RECALL_VEC_MIN（低阈值，专门兜底"字面无关但语义相关"的段落，如含地点名的数据段）。
const RECALL_LEX_MIN = 1
const RECALL_VEC_MIN = 0.1
/** 专属来源的整篇字符上限：超过此长度且非标题专属，则只保留有信号的段（避免宽口径年鉴整本喂给模型）。 */
const RECALL_DEDICATED_MAX_LEN = 10000
/** 来源内词法最高分达此值且来源较小 → 视为专属，整篇保留（宁多勿漏）。 */
const RECALL_DEDICATED_MIN_LEX = 40

export interface CompilationProgress {
  stage: string
  percent: number
  etaSeconds?: number
  candidateChunks?: number
  candidateSources?: number
}

export type GenerateCompilationResult =
  | { ok: true; compilationId: string; candidateChunks: number; contradictions: number }
  | { ok: false; error: { code: string; message: string } }

interface ProviderInfo {
  apiBase: string
  model: string
  apiKey: string
}

function fail(code: string, message: string): GenerateCompilationResult {
  return { ok: false, error: { code, message } }
}

/** 第 1 步资料汇编使用的大模型（Phase 6.8）：一律以设置中的「步骤默认模型」第 1 步为准 */
function resolveProvider(): { ok: true; provider: ProviderInfo } | { ok: false; error: { code: string; message: string } } {
  const settings = getSettings()
  const providerId = settings.compilationProviderId
  if (!providerId) return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '请先在设置中为「第 1 步」指定默认大模型' } }
  const provider = getProviderSecret(providerId, safeStorageCodec)
  if (!provider) return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '所选的 LLM Provider 不存在' } }
  if (!provider.apiKey) return { ok: false, error: { code: ErrorCodes.LLM_UNAUTHORIZED, message: '所选的 LLM Provider 未设置 API 密钥' } }
  return { ok: true, provider: { apiBase: provider.config.apiBase, model: provider.config.model, apiKey: provider.apiKey } }
}

/** 大模型提取的粗筛关键词集合（标题 + 近义词/上下位词/专业词） */
export interface KeywordExtraction {
  title: string
  keywords: string[]
}

/** 解析大模型输出的标题/关键词 JSON（纯函数，可测试） */
export function parseKeywordExtraction(text: string): KeywordExtraction | null {
  const raw = extractJson(text)
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { title?: unknown; keywords?: unknown }
  const title = typeof obj.title === 'string' ? obj.title.trim().slice(0, 30) : ''
  if (!title) return null
  const keywords: string[] = []
  if (Array.isArray(obj.keywords)) {
    for (const k of obj.keywords) {
      if (typeof k !== 'string') continue
      const v = k.trim()
      if (v.length >= 2 && v.length <= 12 && !keywords.includes(v)) keywords.push(v)
    }
  }
  if (keywords.length === 0) return null
  return { title, keywords }
}

/** 本地兜底：先用 extractTopicTerms 取引号/“标题为”后的核心词，再做领域下位词扩展 */
export function fallbackCoarseQuery(instruction: string): string {
  const terms = extractTopicTerms(instruction)
  const q = [...new Set([...terms, ...expandDomainHints(terms)])].filter(Boolean).join(' ')
  return q || instruction.trim()
}

/** 调用大模型从完整撰写要求中提取标题与粗筛关键词（含近义词/专业词，理解方志语境） */
async function extractKeywordSet(
  provider: ProviderInfo,
  instruction: string,
  taskId: string
): Promise<KeywordExtraction | null> {
  const sys = [
    '你是一名地方志资料整理专家，熟悉志书编纂的语境。',
    '用户给出了一条「撰写要求」。请从中：',
    '1) 提取本次撰写任务的标题/主题——最核心、最精炼的短语（不含“标题为”等前缀），不超过 20 字；',
    '2) 提取用于在本地资料库做粗筛的关键词列表——包含标题本身、标题的近义词/上下位词、领域相关专业词汇，并尽量覆盖要求里提到的具体内容（如幼儿园/托儿所、招生人数、等级、占比、新增撤销等），每个词 2~12 字。',
    '',
    '只输出一个 JSON 对象，不要输出其他文字或代码块围栏：',
    '{"title":"…","keywords":["…","…"]}'
  ].join('\n')
  const messages: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: '本次撰写要求：\n' + instruction }
  ]
  const result = await chatCompletion(provider, messages, KEYWORD_EXTRACT_TIMEOUT_MS, { kind: 'compilation-keywords', taskId }, {
    maxRetries: 1,
    temperature: 0,
    seed: REPRODUCIBILITY_SEED
  })
  if (!result.ok) return null
  return parseKeywordExtraction(result.text)
}

/**
 * 本地宽召回（宁多勿漏）：不改写、不淘汰，把任务范围内所有资料的有效分块全部返回；
 * 每条附带词法相关分（仅用于排序，不作为过滤依据）。
 * 导出以便单测。
 */
/** 确定性稳定排序（by sourceId + position），保证同一候选集两轮顺序一致（C：稳定窗口切分） */
function sortChunksStable(chunks: RetrievedChunk[]): RetrievedChunk[] {
  return [...chunks].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.position.localeCompare(b.position))
}

export function recallCandidateChunks(scopeIds: string[], query: string): RetrievedChunk[] {
  const q = query.trim()
  if (!q || scopeIds.length === 0) return []
  const sources = getSourcesByIds(scopeIds)
  const qBigrams = bigrams(q)
  const qTerms = q.split(/\s+/).filter(Boolean)
  const out: RetrievedChunk[] = []
  for (const s of sources) {
    for (const c of chunkParagraphs(s.cleanedText ?? '')) {
      out.push({
        sourceId: s.id,
        sourceTitle: s.title,
        position: c.position,
        text: c.text,
        score: scoreChunk(q, c.text, s.title, qBigrams, qTerms)
      })
    }
  }
  return sortChunksStable(out)
}

export interface CompilationRecallResult {
  chunks: RetrievedChunk[]
  candidateSources: number
}

/**
 * 汇编候选的保守本地闸门（2026-08-25 优化：把交给大模型的材料从"任务范围内全部段落"收敛为"与主题相关的来源及其相关段落"）。
 * 规则：
 *  1) 来源级：仅保留"有相关信号"的来源（标题含查询词 / 任一段词法 score>0 / 任一段向量余弦 ≥ RECALL_VEC_MIN）；
 *     完全无关的来源整篇舍弃——这是大幅减少窗口数的关键（多数资料库里有大量与本次主题无关的文件）。
 *  2) 来源内：标题含任一查询词（如"学前/幼儿园/园所/幼教"），或来源总长 ≤ RECALL_DEDICATED_MAX_LEN 且来源内最高词法分 ≥ RECALL_DEDICATED_MIN_LEX → 整篇保留；
 *     宽口径来源（如综合年鉴，仅有部分段落相关）→ 只保留有信号的分块（词法 score>0 或向量 ≥ RECALL_VEC_MIN），
 *     从而删掉综合文档里与主题无关的章节。
 * 保证：相关来源不会被整篇丢弃；宽口径来源里"字面无关但语义相关"的段落由低阈值向量路径兜底（不会因无词法命中被误删）。
 */
export function recallCompilationCandidates(
  scopeIds: string[],
  query: string,
  queryVector?: number[]
): CompilationRecallResult {
  const q = query.trim()
  if (!q || scopeIds.length === 0) return { chunks: [], candidateSources: 0 }
  const sources = getSourcesByIds(scopeIds)
  const qBigrams = bigrams(q)
  const qTerms = q.split(/\s+/).filter(Boolean)

  // 向量命中（position 级）：queryVector 缺省或无向量索引时为空
  const vecHitBySource = new Map<string, Set<string>>()
  if (queryVector && queryVector.length > 0) {
    for (const h of vectorSearch(queryVector, scopeIds, 0)) {
      if (h.score < RECALL_VEC_MIN) continue
      if (!vecHitBySource.has(h.sourceId)) vecHitBySource.set(h.sourceId, new Set())
      vecHitBySource.get(h.sourceId)!.add(h.position)
    }
  }

  const relevantSources = new Set<string>()
  const dedicatedSources = new Set<string>()
  const indexed: { sourceId: string; sourceTitle: string; position: string; text: string; score: number; vecHit: boolean; inlineRelevant: boolean }[] = []
  const maxScoreBySource = new Map<string, number>()
  const totalLenBySource = new Map<string, number>()

  for (const s of sources) {
    const chunks = chunkParagraphs(s.cleanedText ?? '')
    let maxScore = 0
    let totalLen = 0
    for (const c of chunks) {
      totalLen += c.text.length
      const score = scoreChunk(q, c.text, s.title, qBigrams, qTerms)
      maxScore = Math.max(maxScore, score)
      const vecHit = vecHitBySource.get(s.id)?.has(c.position) ?? false
      // 词法相关（粗筛）：只要有任意词法信号（scoreChunk>0）或向量语义（≥RECALL_VEC_MIN）即视为
      // "可能相关"；只剔除与标题完全无任何信号（score==0 且无向量命中）的"肯定无关"段。
      const inlineRelevant = score > RECALL_LEX_MIN || vecHit
      indexed.push({ sourceId: s.id, sourceTitle: s.title, position: c.position, text: c.text, score, vecHit, inlineRelevant })
      if (inlineRelevant) relevantSources.add(s.id)
    }
    maxScoreBySource.set(s.id, maxScore)
    totalLenBySource.set(s.id, totalLen)
    // 标题含任意查询词（含领域下位词展开后的"幼儿园/园所/学前"等）→ 来源级相关
    if (qTerms.some((t) => t.length > 1 && s.title.includes(t))) relevantSources.add(s.id)
    // 标题含任一查询词（如"学前/幼儿园/园所/幼教"）→ 专属来源（整篇保留）
    if (qTerms.some((t) => t.length >= 2 && s.title.includes(t))) dedicatedSources.add(s.id)
  }

  // 词法信号强且来源较小 → 专属来源，整篇保留
  for (const [id, maxScore] of maxScoreBySource) {
    if (maxScore >= RECALL_DEDICATED_MIN_LEX && (totalLenBySource.get(id) ?? 0) <= RECALL_DEDICATED_MAX_LEN) dedicatedSources.add(id)
  }

  const out: RetrievedChunk[] = []
  for (const it of indexed) {
    if (!relevantSources.has(it.sourceId)) continue
    if (dedicatedSources.has(it.sourceId) || it.inlineRelevant) {
      out.push({ sourceId: it.sourceId, sourceTitle: it.sourceTitle, position: it.position, text: it.text, score: it.score })
    }
  }
  return { chunks: sortChunksStable(out), candidateSources: relevantSources.size }
}

export interface SourceRefEntry {
  index: number
  sourceId: string
  title: string
}

export function buildCompilationSourceRefs(chunks: RetrievedChunk[]): SourceRefEntry[] {
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

function refText(refs: SourceRefEntry[]): string {
  return refs.map((r) => r.index + '. 《' + r.title + '》').join('\n')
}

function buildSystemPrompt(instruction: string): string {
  return [
    '你是一名地方志资料整理专家。你将收到一批【候选材料】与【文件清单】，材料来自用户本地资料库，不能引入任何外部知识。',
    '你的任务：逐块阅读候选材料，为撰写志书整理一份「资料汇编」。',
    '',
    '【本次撰写主题与范围】',
    instruction,
    '',
    '请以上述撰写主题与范围为准，自行判断哪些事实与主题相关并提炼成卡片；与主题无关或无法从材料中确认的内容不要输出。',
    '',
    '每段候选材料可能是较长的整段文字；请先判断其中哪些内容与主题相关，再按时间、事实、条目等维度做更细的切分，为每个细粒度事实输出一张卡片。',
    '',
    '对每个相关事实，输出一张卡片：',
    '1. excerpt 必须是完整的一句话或一个完整事实（按原文逐字摘录，不得从句子中间截断、不得改写/补写/概括）；',
    '2. ts 为时间标签（如「2005 年」「2005—2010 年」），只写原文中能确定的时间，没有就填 null；',
    '3. sourceRef 用文件编号（如 #1）；',
    '4. 同一事实不同来源相左时，输出到 contradictions（仅实质性冲突：数据/时间/地点/主体/结果不同；措辞差异不算）。',
    '',
    '输出要求：只输出一个 JSON 对象，不得输出 JSON 之外的任何文字、解释或代码块围栏。',
    '正常输出：{"items":[{"sourceRef":"#1","excerpt":"原文摘录","ts":"2005 年"}],"contradictions":[{"topic":"事实主题","kind":"data|time|place|fact|other","variants":[{"excerpt":"说法一原文","sourceRefs":["#1","#2"]}]}]}',
    '无矛盾输出：{"items":[...],"contradictions":[]}'
  ].join('\n')
}

function buildUserPrompt(chunks: RetrievedChunk[], refs: SourceRefEntry[], instruction: string): string {
  const bySource = new Map(refs.map((r) => [r.sourceId, r.index]))
  const materials = chunks
    .map((c, i) => {
      const ref = bySource.get(c.sourceId) ?? 0
      return '[' + (i + 1) + ']（来源编号: #' + ref + '，标题：《' + c.sourceTitle + '》）\n' + c.text
    })
    .join('\n\n')
  return ['【文件清单】', refText(refs), '本次撰写主题与范围：' + instruction, '', '【候选材料】', materials, '', '请只提炼与主题直接相关的事实，按上述 JSON 格式输出资料汇编。'].join('\n')
}

export interface CompilationOutputItem {
  sourceRef: string
  position: string
  excerpt: string
  ts: string | null
}

export interface CompilationOutputVariant {
  excerpt: string
  sourceRefs: string[]
}

export interface CompilationOutputGroup {
  topic: string
  kind: string
  variants: CompilationOutputVariant[]
}

export interface CompilationOutput {
  items: CompilationOutputItem[]
  contradictions: CompilationOutputGroup[]
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1].trim() : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

/** 解析 AI 汇编输出（纯函数，可测试） */
export function parseCompilationOutput(text: string): CompilationOutput | null {
  const raw = extractJson(text)
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { items?: unknown; contradictions?: unknown }
  const items: CompilationOutputItem[] = []
  if (Array.isArray(obj.items)) {
    for (const it of obj.items) {
      if (!it || typeof it !== 'object') continue
      const o = it as { sourceRef?: unknown; position?: unknown; excerpt?: unknown; ts?: unknown }
      const excerpt = typeof o.excerpt === 'string' ? o.excerpt.trim() : ''
      if (!excerpt) continue
      items.push({
        sourceRef: typeof o.sourceRef === 'string' ? o.sourceRef.trim() : '#?',
        position: typeof o.position === 'string' ? o.position.trim() : '',
        excerpt,
        ts: typeof o.ts === 'string' && o.ts.trim() ? o.ts.trim() : null
      })
    }
  }
  const contradictions: CompilationOutputGroup[] = []
  if (Array.isArray(obj.contradictions)) {
    for (const g of obj.contradictions) {
      if (!g || typeof g !== 'object') continue
      const go = g as { topic?: unknown; kind?: unknown; variants?: unknown }
      const topic = typeof go.topic === 'string' ? go.topic.trim() : ''
      if (!topic || !Array.isArray(go.variants)) continue
      const variants: CompilationOutputVariant[] = []
      for (const v of go.variants) {
        if (!v || typeof v !== 'object') continue
        const vo = v as { excerpt?: unknown; sourceRefs?: unknown }
        const excerpt = typeof vo.excerpt === 'string' ? vo.excerpt.trim() : ''
        if (!excerpt) continue
        variants.push({
          excerpt,
          sourceRefs: Array.isArray(vo.sourceRefs) ? vo.sourceRefs.filter((x): x is string => typeof x === 'string') : []
        })
      }
      if (variants.length >= 2) {
        contradictions.push({ topic, kind: typeof go.kind === 'string' ? go.kind.trim() : '', variants })
      }
    }
  }
  if (items.length === 0 && contradictions.length === 0) return null
  return { items, contradictions }
}

/** 多窗口结果合并：items 按 excerpt+sourceRef 去重；contradictions 直接拼接 */
export function mergeCompilationOutputs(outputs: CompilationOutput[]): CompilationOutput {
  const seen = new Set<string>()
  const items: CompilationOutputItem[] = []
  const contradictions: CompilationOutputGroup[] = []
  for (const o of outputs) {
    for (const it of o.items) {
      const key = it.sourceRef + '|' + it.excerpt
      if (seen.has(key)) continue
      seen.add(key)
      items.push(it)
    }
    contradictions.push(...o.contradictions)
  }
  return { items, contradictions }
}

/** 跨窗口/跨来源矛盾：细读产出最终卡片后，对精简后的卡片集再做一次矛盾扫描（2026-08-25 优化）。
 * 逐窗细读时两个相左说法若落在不同窗口就不会一起看到（漏检主因），而卡片集是
 * 已经筛选、细粒度的事实，数量远小于原始材料，一次扫描成本很低。 */
async function scanCardContradictions(
  provider: ProviderInfo,
  items: CompilationOutputItem[],
  refs: SourceRefEntry[],
  taskId: string
): Promise<CompilationOutputGroup[]> {
  if (items.length === 0) return []
  const batch = items.slice(0, CARD_SCAN_MAX)
  const titleByRef = new Map(refs.map((r, idx) => ['#' + (idx + 1), r.title]))
  const cardList = batch
    .map((it, i) => '[' + (i + 1) + '] 来源：#' + it.sourceRef + '《' + (titleByRef.get(it.sourceRef) ?? '') + '》，时间：' + (it.ts ?? '无') + '\n' + it.excerpt)
    .join('\n\n')
  const sys = [
    '你是一名地方志资料整理专家。下面给出一批已经筛选出的【资料卡片】（每条含编号、来源、时间、摘录）。',
    '请找出其中描述同一事实、但数据/时间/地点/主体/结果相左的冲突说法，归为一组矛盾。',
    '只输出一个 JSON 对象，不得输出其他文字或代码块围栏：',
    '"contradictions":[{"topic":"事实主题","kind":"data|time|place|fact|other","cardIndices":[1,3]}]'
  ].join('\n')
  const user = [
    '【已筛选出的资料卡片】',
    cardList,
    '请找出矛盾，cardIndices 填所涉及卡片的编号（1 起）。'
  ].join('\n')
  const messages: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]
  // D（低成本提升召回）：对同一卡片集用 0 与 0.3 各扫一次，按「主题」并集去重（说法并集），
  // 一次低温度一次稍高温度，抵消单次采样的"该发现却没发现"；卡片集很小，2 次调用成本可忽略。
  const merged = new Map<string, CompilationOutputGroup>()
  for (const temperature of CARD_SCAN_TEMPERATURES) {
    const result = await chatCompletion(provider, messages, CARD_SCAN_TIMEOUT_MS, { kind: 'compilation-contradiction-scan', taskId }, {
      maxRetries: 1,
      temperature,
      seed: REPRODUCIBILITY_SEED
    })
    if (!result.ok) continue
    const groups = parseCardScanGroups(result.text)
    if (!groups) continue
    for (const g of groups) {
      const variants: CompilationOutputVariant[] = []
      for (const ci of g.cardIndices) {
        const it = batch[ci - 1]
        if (!it) continue
        variants.push({ excerpt: it.excerpt, sourceRefs: [it.sourceRef] })
      }
      if (variants.length < 2) continue
      const key = g.topic.trim()
      const existing = merged.get(key)
      if (!existing) {
        merged.set(key, { topic: g.topic, kind: g.kind, variants })
      } else {
        // 并集：补充本次扫出而上次未有的说法（按摘录去重）
        const seen = new Set(existing.variants.map((v) => v.excerpt))
        for (const v of variants) if (!seen.has(v.excerpt)) existing.variants.push(v)
      }
    }
  }
  return [...merged.values()]
}

/** 解析卡片级矛盾扫描输出（纯函数，可测试） */
export function parseCardScanGroups(text: string): { topic: string; kind: string; cardIndices: number[] }[] | null {
  const raw = extractJson(text)
  if (!raw || typeof raw !== 'object') return null
  const arr = (raw as { contradictions?: unknown }).contradictions
  if (!Array.isArray(arr) || arr.length === 0) return null
  const groups: { topic: string; kind: string; cardIndices: number[] }[] = []
  for (const g of arr) {
    if (!g || typeof g !== 'object') continue
    const o = g as { topic?: unknown; kind?: unknown; cardIndices?: unknown }
    const topic = typeof o.topic === 'string' ? o.topic.trim() : ''
    const kind = typeof o.kind === 'string' ? o.kind.trim() : ''
    const cardIndices = Array.isArray(o.cardIndices) ? o.cardIndices.filter((x): x is number => typeof x === 'number') : []
    if (topic && cardIndices.length >= 2) groups.push({ topic, kind, cardIndices })
  }
  return groups.length > 0 ? groups : null
}

/** 合并窗口级与卡片级矛盾，去重（topic + 变异摘录集合相同视为同一组） */
export function mergeContradictionGroups(
  windowGroups: CompilationOutputGroup[],
  cardGroups: CompilationOutputGroup[]
): CompilationOutputGroup[] {
  const key = (g: CompilationOutputGroup): string =>
    g.topic + '|' + g.variants.map((v) => v.excerpt).sort().join('|')
  const seen = new Set<string>()
  const out: CompilationOutputGroup[] = []
  for (const g of [...windowGroups, ...cardGroups]) {
    const k = key(g)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(g)
  }
  return out
}
/** 把 #N 来源编号映射回 sourceId，丢弃无法解析的卡片 */
export function mapOutputItemsToInputs(
  items: CompilationOutputItem[],
  refs: SourceRefEntry[]
): CompilationItemInput[] {
  const byRef = new Map(refs.map((r) => ['#' + r.index, r.sourceId]))
  const out: CompilationItemInput[] = []
  for (const it of items) {
    const sourceId = byRef.get(it.sourceRef)
    if (!sourceId) continue
    out.push({ sourceId, excerpt: it.excerpt, ts: it.ts ?? undefined, note: it.position || undefined })
  }
  return out
}

/** 提取年份用于时间排序（无时间排最后） */
function yearOf(ts: string | undefined): number | null {
  if (!ts) return null
  const m = ts.match(/(18|19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

function sortItemsByTs(items: CompilationItemInput[]): CompilationItemInput[] {
  return [...items].sort((a, b) => {
    const ya = yearOf(a.ts)
    const yb = yearOf(b.ts)
    if (ya === null && yb === null) return 0
    if (ya === null) return 1
    if (yb === null) return -1
    return ya - yb
  })
}

export async function generateCompilation(
  taskId: string,
  title: string,
  onProgress?: (p: CompilationProgress) => void
): Promise<GenerateCompilationResult> {
  const task = getTaskById(taskId)
  if (!task) return fail(ErrorCodes.TASK_NOT_FOUND, '撰写任务不存在')
  const t = title.trim()
  if (!t) return fail(ErrorCodes.INVALID_PARAM, '请填写本次撰写的标题')

  const prov = resolveProvider()

  let scopeIds = resolveScopeSourceIds(task, { getSourceIdsByTag, getAllSourceIds })
  if (scopeIds.length === 0) return fail(ErrorCodes.TASK_NO_SCOPE, '资料库中没有可用资料')

  // 用大模型（若可用、更懂方志语境）从完整撰写要求中提取“标题 + 粗筛关键词（含近义词/专业词）”，
  // 用于本地粗筛与网页检索；失败或无 Provider 时回退本地 extractTopicTerms + expandDomainHints。
  onProgress?.({ stage: '正在理解撰写任务并提取粗筛关键词…', percent: 6, etaSeconds: 20 })
  let coarseQuery: string
  let vecQuery: string
  // B（稳定关键帧）：同一「撰写要求」复用已提取的关键词，避免两轮任务因 LLM 采样差异产生不同粗筛关键词
  let extracted: KeywordExtraction | null = keywordExtractionCache.get(t) ?? null
  if (!extracted && prov.ok) {
    extracted = await extractKeywordSet(prov.provider, t, taskId).catch(() => null)
    if (extracted) keywordExtractionCache.set(t, extracted)
  }
  if (extracted) {
    coarseQuery = [...new Set([extracted.title, ...extracted.keywords])].filter(Boolean).join(' ') || fallbackCoarseQuery(t)
    vecQuery = extracted.title || coarseQuery
    onProgress?.({ stage: '已提取标题：' + extracted.title + '；提取粗筛关键词 ' + extracted.keywords.length + ' 个', percent: 7, etaSeconds: 20 })
    // 首次由大模型提取出标题后，自动把任务标题从默认值改为该标题（用户仍可后续重命名）
    if (task.title === '新建任务' && extracted.title) {
      try { renameTask(taskId, extracted.title) } catch { /* 重命名失败不影响汇编生成 */ }
    }
  } else {
    coarseQuery = fallbackCoarseQuery(t)
    vecQuery = coarseQuery
  }

  onProgress?.({ stage: '正在检索网页资料库…', percent: 8, etaSeconds: 30 })
  const webIds = await fetchRelatedSiteSources(coarseQuery, taskId).catch(() => [] as string[])
  if (webIds.length > 0) scopeIds = Array.from(new Set([...scopeIds, ...webIds]))

  onProgress?.({ stage: '正在本地召回资料（宁多勿漏）…', percent: 10, etaSeconds: 60 })
  const allChunks = recallCandidateChunks(scopeIds, coarseQuery)
  if (allChunks.length === 0) return fail(ErrorCodes.LLM_NO_CANDIDATES, '资料库中没有可召回的资料')

  // 无 Provider → 本地降级（卡片 = 全部候选块，无矛盾；用全量集合避免降级丢失任何可能相关材料）
  if (!prov.ok) {
    return finalizeCompilationLocal(taskId, title, allChunks)
  }

  // 2026-08-25 优化：调用大模型前用保守本地闸门收窄提交物——把"任务范围内全部段落"收敛为
  // "与主题相关的来源及其相关段落"。完全无关的来源整篇舍弃，宽口径来源只保留有信号的段；
  // 用低阈值向量路径兜底"字面无关但语义相关"的段落，避免误删可能相关的内容。
  onProgress?.({ stage: '正在按主题收敛候选材料（保守闸门）…', percent: 11, etaSeconds: 20 })
  const vectors = await embedTexts([vecQuery]).catch(() => null)
  const queryVector = vectors ? vectors[0] : undefined
  const recall = recallCompilationCandidates(scopeIds, coarseQuery, queryVector)
  const chunks = recall.chunks.length > 0 ? recall.chunks : allChunks

  const refs = buildCompilationSourceRefs(chunks)

  // 分窗 AI 细读
  const windows = sliceChunks(chunks, WINDOW_MAX_CHARS)
  onProgress?.({
    stage: '正在由 AI 细读资料（0/' + windows.length + ' 个窗口）…',
    percent: 12,
    etaSeconds: windows.length * 20,
    candidateChunks: chunks.length,
    candidateSources: refs.length
  })

  const outputs: CompilationOutput[] = []
  let done = 0
  let idx = 0
  function nextWindow(): number {
    return idx++
  }
  const workers = Array.from({ length: Math.min(WINDOW_CONCURRENCY, windows.length) }, async () => {
    while (true) {
      const i = nextWindow()
      if (i >= windows.length) return
      const out = await readWindow(prov.provider, windows[i], refs, taskId, t)
      if (out) outputs.push(out)
      done += 1
      onProgress?.({
        stage: '正在由 AI 细读资料（' + done + '/' + windows.length + ' 个窗口）…',
        percent: Math.round(12 + (done / windows.length) * 68),
        etaSeconds: Math.max(0, Math.round((windows.length - done) * 20)),
        candidateChunks: chunks.length,
        candidateSources: refs.length
      })
    }
  })
  await Promise.all(workers)

  const merged = mergeCompilationOutputs(outputs.filter((o): o is CompilationOutput => o !== null))
  if (merged.items.length === 0) {
    // AI 未产出有效卡片 → 本地降级（用全量集合，不丢材料）
    return finalizeCompilationLocal(taskId, title, allChunks)
  }

  // 2026-08-25 优化：跨窗口/跨来源矛盾在逐窗细读时可能漏检（两个相左说法若落在不同窗口就不会一起看到）。
  // 细读产出最终卡片后，对精简后的卡片集再做一次矛盾扫描（输入量小、成本低），提升矛盾发现稳定性。
  onProgress?.({ stage: '正在汇总卡片间的矛盾…', percent: 88, etaSeconds: 30 })
  const cardGroups = await scanCardContradictions(prov.provider, merged.items, refs, taskId).catch(() => [] as CompilationOutputGroup[])
  const contradictions = mergeContradictionGroups(merged.contradictions, cardGroups)

  return finalizeCompilation(taskId, title, { items: merged.items, contradictions }, refs, chunks.length)
}

function sliceChunks(chunks: RetrievedChunk[], maxChars: number): RetrievedChunk[][] {
  const windows: RetrievedChunk[][] = []
  let cur: RetrievedChunk[] = []
  let len = 0
  const flush = (): void => {
    if (cur.length > 0) { windows.push(cur); cur = []; len = 0 }
  }
  for (const c of chunks) {
    // 单块超过窗口上限（极少见）：按句切成 ≤maxChars 的小块，避免上下文溢出；普通整段仍整块投喂。
    if (c.text.length > maxChars) {
      flush()
      const sentences = c.text.split(/(?<=[。！？；;])/).map((s) => s.trim()).filter(Boolean)
      let buf = ''
      const flushSub = (): void => {
        if (buf) { windows.push([{ ...c, text: buf }]); buf = '' }
      }
      for (const s of sentences) {
        if (buf.length + s.length > maxChars) flushSub()
        buf += s
      }
      flushSub()
      continue
    }
    if (cur.length > 0 && len + c.text.length > maxChars) flush()
    cur.push(c)
    len += c.text.length
  }
  flush()
  return windows
}

async function readWindow(
  provider: ProviderInfo,
  windowChunks: RetrievedChunk[],
  refs: SourceRefEntry[],
  taskId: string,
  instruction: string
): Promise<CompilationOutput | null> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(instruction) },
    { role: 'user', content: buildUserPrompt(windowChunks, refs, instruction) }
  ]
  for (let attempt = 0; attempt < TEMPERATURES.length; attempt++) {
    const result = await chatCompletion(provider, messages, COMPILATION_TIMEOUT_MS, { kind: 'compilation-read', taskId }, {
      maxRetries: 1,
      temperature: TEMPERATURES[attempt],
      seed: REPRODUCIBILITY_SEED
    })
    if (!result.ok) continue
    const parsed = parseCompilationOutput(result.text)
    if (parsed) return parsed
  }
  return null
}

function finalizeCompilationLocal(taskId: string, title: string, chunks: RetrievedChunk[]): GenerateCompilationResult {
  const dedup = new Set<string>()
  const items: CompilationItemInput[] = []
  for (const c of chunks) {
    const key = c.sourceId + '|' + c.position + '|' + c.text
    if (dedup.has(key)) continue
    dedup.add(key)
    const m = c.text.match(/(18|19|20)\d{2}/)
    items.push({ sourceId: c.sourceId, excerpt: c.text, ts: m ? m[0] + ' 年' : undefined })
  }
  const compilation = createCompilation({ taskId, title })
  insertCompilationItems(compilation.id, sortItemsByTs(items))
  return { ok: true, compilationId: compilation.id, candidateChunks: chunks.length, contradictions: 0 }
}

function finalizeCompilation(
  taskId: string,
  title: string,
  output: CompilationOutput,
  refs: SourceRefEntry[],
  candidateChunks: number
): GenerateCompilationResult {
  const items = sortItemsByTs(mapOutputItemsToInputs(output.items, refs))
  const compilation = createCompilation({ taskId, title })
  const insertedItems = insertCompilationItems(compilation.id, items)

  // 矛盾分组：把 variant 的 excerpt 精确匹配到卡片
  const byExcerpt = new Map<string, string>()
  for (const it of insertedItems) {
    if (!byExcerpt.has(it.excerpt)) byExcerpt.set(it.excerpt, it.id)
  }
  const groups: CompilationContradictionInput[] = []
  for (const g of output.contradictions) {
    const variants: CompilationContradictionInput['variants'] = []
    const seen = new Set<string>()
    for (const v of g.variants) {
      const itemId = byExcerpt.get(v.excerpt)
      if (!itemId || seen.has(itemId)) continue
      const sourceId = refs.find((r) => '#' + r.index === v.sourceRefs[0])?.sourceId ?? ''
      if (sourceId) {
        seen.add(itemId)
        variants.push({ itemId, variantText: v.excerpt, sourceId })
      }
    }
    if (variants.length >= 2) {
      groups.push({ topic: g.topic, kind: (['data', 'time', 'place', 'fact', 'other'].includes(g.kind) ? g.kind : 'other') as CompilationContradictionInput['kind'], variants })
    }
  }
  const contradictions = insertCompilationContradictions(compilation.id, groups)
  return { ok: true, compilationId: compilation.id, candidateChunks, contradictions: contradictions.length }
}
