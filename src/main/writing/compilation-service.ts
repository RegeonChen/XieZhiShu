/**
 * compilation-service.ts —— 资料汇编生成服务（Phase 6.1，2026-08-25）。
 * 五步：① 本地宽召回（宁多勿漏）→ ② AI 细读候选并产出卡片/矛盾 → ③ **提纯**
 * （大模型逐字摘录与主题相关的句段，舍弃无关内容）→ ④ **大模型修正**
 * （语义补全/补齐时间戳，默认直接应用、卡片上留标记）→ ⑤ 卡片矛盾扫描 → 落库。
 * 无 Provider / AI 调用失败时降级为「本地候选直接成卡片」，不阻断。
 *
 * 2026-09-08：① 大模型修正由“生成完成后独立扫描”改为管线内、矛盾扫描之前；
 * ② 新增「提纯」阶段并置于修正之前 —— 实测「整段成卡」会让卡片夹带大量与主题无关的内容
 * （真实数据：191 张卡 48,063 字中相关句仅约 31%），先提纯可显著降低噪声，
 * 且修正的输入从整篇降到约 1/3，净增成本有限。提纯为黑箱（不保留提纯前原文、不可单独回退，
 * 需要退回时用「重新生成汇编」），修正的「标记 + 回退」语义因此仍与最终卡片一对一。
 */
import type { RetrievedChunk } from '../../shared/types'
import { ErrorCodes } from '../../shared/types'
import { getTaskById, resolveScopeSourceIds, getAllSourceIds, renameTask } from '../db/tasks'
import { getSourceIdsByTag } from '../db/tags'
import { getSourcesByIds } from '../db/sources'
import { bigrams, chunkByParagraphs, scoreChunk } from '../rag/retrieval'
import { embedTexts } from '../rag/embed'
import { vectorSearch } from '../rag/vector-store'
import { getSettings } from '../db/settings'
import { getProviderSecret } from '../llm/provider-store'
import { safeStorageCodec } from '../llm/secret'
import { chatCompletion, type ChatMessage } from '../llm/chat'
import { logMain } from '../logger'
import { fetchRelatedSiteSources, extractTopicTerms, expandDomainHints } from '../web-source/site-crawler'
import {
  applyRepairOutcome,
  buildRepairCandidates,
  remapRepairedVariantExcerpts,
  REPAIR_ETA_PER_CALL_S,
  REPAIR_PHASE_BUDGET_MS,
  scanRepairBatch,
  splitRepairBatches,
  type RepairCandidate,
  type RepairFix
} from './repair-service'
import {
  applyPurifyOutcome,
  buildPurifyCandidates,
  emptyPurifyStats,
  logPurify,
  logPurifyBatchStats,
  mapVariantThroughPurify,
  passthroughSpans,
  PURIFY_ETA_PER_CALL_S,
  PURIFY_PHASE_BUDGET_MS,
  purifyBatch,
  splitPurifyBatches,
  type PurifiedSpan,
  type PurifyCandidate
} from './purify-service'
import {
  createCompilation,
  insertCompilationItems,
  insertCompilationContradictions,
  replaceCompilationItems,
  type CompilationItemInput,
  type CompilationContradictionInput
} from '../db/compilations'

const COMPILATION_TIMEOUT_MS = 600000
const WINDOW_MAX_CHARS = 30000
const TEMPERATURES = [0, 0.3]
const KEYWORD_EXTRACT_TIMEOUT_MS = 60000
// 卡片级矛盾扫描：实测（llm_call_logs）单次调用耗时主要来自“找矛盾”的推理本身，与输入量弱相关
// （3.4k 输入也要 34~132s，20k 约 214s，54k 会超时）。因此优化目标是「尽量少的调用次数」，而不是「更小的批次」。
/** 单次调用输入字符预算（历史上 ~20k 输入 ≈ 214s、54k 超时，故压在 15k 内） */
const CARD_SCAN_CHARS = 15000
/** 单次调用最多卡片数（配合字符预算，通常 1~2 次调用即可完成） */
const CARD_SCAN_MAX = 100
/** 单次调用超时（推理型任务，留足余量） */
const CARD_SCAN_TIMEOUT_MS = 300000
/** 扫描提示词中每条卡片的摘录上限（压缩输入；矛盾判定只需“同一事实的不同说法”这一小段） */
const CARD_SCAN_EXCERPT_CHARS = 150
/** 矛盾扫描整阶段时间预算：超时即停止并把结果标为“未完成”，不再让进度条长时间等待 */
const CARD_SCAN_BUDGET_MS = 360000
/** 本地预筛阈值：两张卡片 bigram 相似度 ≥ 该值即视为“可能描述同一事实”，进入候选簇 */
const CARD_PREFILTER_DICE = 0.28
/** 单次卡片矛盾扫描的预计耗时（秒，用于剩余时间展示；来自实测 ~150~250s） */
const CARD_SCAN_ETA_PER_CALL_S = 180
/** 可复现种子：传给支持 seed 的 Provider，让关键帧提取/细读/矛盾扫描在相同输入下更确定 */
const REPRODUCIBILITY_SEED = 42
/** 卡片级矛盾扫描温度（单次调用，避免双温度翻倍调用时间、更容易超时） */
const CARD_SCAN_TEMPERATURE = 0
/** Phase A/B：遇到限流（HTTP 429）自动续传——内部自动降并发并重试的轮数上限；降并发不写回 Provider 设置，仅本次生成生效 */
const RATE_LIMIT_RESUME_LIMIT = 2
/** 限流自动续传的退避延迟（毫秒，按轮次递增） */
const RATE_LIMIT_RESUME_BACKOFF_MS = [10000, 25000]
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** 预计剩余时间的各阶段先验（秒）——单次调用阶段无实时完成比例，先按先验估；窗口细读阶段改用实测均速外推（A+C） */
const PHASE_KEYWORD_ETA_S = 20
const PHASE_WEB_ETA_S = 30
const PHASE_RECALL_ETA_S = 60
const PHASE_GATE_ETA_S = 20
const PHASE_CONTRADICTION_ETA_S = 30
/** 大模型修正阶段的先验（秒）——单批约 REPAIR_ETA_PER_CALL_S，批数在卡片确定后才知，故先用保守先验 */
const PHASE_REPAIR_ETA_S = 90
/** 大模型提纯阶段的先验（秒）——同上，先按一批估算 */
const PHASE_PURIFY_ETA_S = 90
/** 窗口细读阶段每个窗口的默认先验（秒），随后用已完成窗口实测均速不断校正（A） */
const WINDOW_ETA_DEFAULT_S = 20
/** 均速 EMA 灵敏度（越低越平滑，避免单窗口抖动拉大误差） */
const WINDOW_ETA_ALPHA = 0.35
/** 用最近 N 个窗口的“每字符秒数”取中位数做平滑，压制个别快/慢窗口的抖动 */
const WINDOW_ETA_MEDIAN_N = 5
/** 预热窗口数：少于该数量时用“窗口数 × 默认先验”的较宽估计，不信任实测均速 */
const WINDOW_ETA_WARMUP = 2

function medianNumber(arr: number[]): number {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
/** 窗口块尚未计算出前，给前置阶段一个合理的占位总预算（秒），避免“预计还剩不到 1 分钟”明显失真 */
const WINDOWS_PRIOR_PLACEHOLDER_S = 120
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
  | {
      ok: true
      compilationId: string
      candidateChunks: number
      contradictions: number
      contradictionScan?: { ok: boolean; message?: string }
      /** 大模型修正阶段的情况：ok=false 表示因时间预算未跑完（可能存在未修正的卡片） */
      repairScan?: { ok: boolean; message?: string }
      /** 提纯阶段的情况与统计（供生成汇总展示：卡片数/保留字数变化、未被成功提纯的卡片数） */
      purifyScan?: {
        ok: boolean
        message?: string
        inputCards?: number
        outputCards?: number
        inputChars?: number
        outputChars?: number
        /** 提纯后仍按原样保留的卡片数（漏答/校验失败/超预算未跑） */
        passthroughCards?: number
      }
      interrupted?: CompilationInterrupt
    }
  | { ok: false; error: { code: string; message: string } };

/** 生成资料汇编时大模型异常中断的可视化信息（供前端展示「尝试继续」） */
export interface CompilationInterrupt {
  /** 中断时所在的阶段描述（如「正在由 AI 细读资料（3/6 个窗口）」） */
  stage: string
  /** 中断原因（来自大模型错误信息，如余额不足/网络问题） */
  message: string
  /** 中断时的进度百分比（0~100） */
  percent: number
  /** true = 因限流（HTTP 429）中断，可自动续传/自动降并发；false/缺省 = 其他异常，需人工「尝试继续」 */
  retryable?: boolean
}

/**
 * 会话级断点续传状态（内存，不落库）：
 * 记录窗口细读、大模型提纯、大模型修正与矛盾扫描到哪个环节，续跑时从该处继续。
 * 四个阶段（窗口细读 / 提纯 / 修正 / 卡片矛盾扫描）均支持中断续跑。
 */
interface CompilationResumeState {
  taskId: string
  compilationId: string
  title: string
  provider: ProviderInfo
  phase: 'window' | 'purify' | 'repair' | 'contradiction'
  chunks: RetrievedChunk[]
  refs: SourceRefEntry[]
  windows: RetrievedChunk[][]
  /** 已成功细读完成的窗口下标集合（失败/未读的不在其中，续跑时重读） */
  doneSet: Set<number>
  /** 各窗口的细读输出（按下标；null=该窗口无产出但已完成），合并顺序确定 */
  windowOutputsByIndex: (CompilationOutput | null)[]
  /** 大模型提纯：待提纯候选与分批方案（卡片确定后算一次，续跑复用） */
  purifyCandidates?: PurifyCandidate[]
  purifyBatches?: number[][]
  /** 已累积的提纯片段（跨批次累积；续跑不重复已完成批次） */
  purifySpans?: PurifiedSpan[]
  /** 已完成的提纯批次下标（并行执行，故用集合而非计数；断点续跑时跳过） */
  purifyDoneBatches?: Set<number>
  /** 提纯阶段开始时间（用于整阶段时间预算） */
  purifyStartedAt?: number
  /** 提纯未跑完/未生效的原因（超预算或调用失败时置位，随 purifyScan 透出） */
  purifyIncomplete?: { message: string }
  /** 提纯统计（落库前透出给前端汇总） */
  purifyStats?: { inputCards: number; outputCards: number; inputChars: number; outputChars: number }
  /** 提纯后仍按原样保留（未被成功提纯）的卡片数——含漏答、校验失败、超预算未跑的批次 */
  purifyPassthroughCards?: number
  /** 提纯后的卡片（修正阶段与矛盾扫描、落库都用它；未跑提纯时为空） */
  purifiedItems?: CompilationOutputItem[]
  /** 大模型修正：待修正候选与分批方案（卡片确定后算一次，续跑复用） */
  repairCandidates?: RepairCandidate[]
  repairBatches?: number[][]
  /** 已累积的修正结果与时间戳补齐（跨批次累积；续跑不重复已完成批次） */
  repairFixes?: RepairFix[]
  repairTsFills?: { index: number; ts: string }[]
  /** 已完成的修正批次数（断点续跑时跳过） */
  repairBatchDone?: number
  /** 修正阶段开始时间（用于整阶段时间预算） */
  repairStartedAt?: number
  /** 修正阶段未跑完的原因（超出时间预算时置位，随 repairScan 透出给前端提示） */
  repairIncomplete?: { message: string }
  /** 修正应用后的卡片（矛盾扫描与落库都用它；未跑修正阶段时为空） */
  repairedItems?: CompilationOutputItem[]
  /** 矛盾扫描已推进到的卡片偏移（在合并后 items 中的偏移） */
  scanOffset: number
  /** 已成功扫描批次的矛盾分组 */
  scanGroups: CompilationOutputGroup[]
  /** 已完成的矛盾扫描调用次数（断点续跑时跳过已完成的候选批次） */
  scanCallDone?: number
  /** 矛盾扫描未完成的原因（超出时间预算时置位，随 contradictionScan 透出给前端提示） */
  scanIncomplete?: { message: string }
  /** 各窗口的字符总量（用于“每字符秒数”外推剩余时间，避免大/小窗口平均失真） */
  windowChars: number[]
  /** 每字符秒数（EMA，越低越平滑；0=未预热） */
  avgSecPerChar: number
  /** 最近若干窗口的“每字符秒数”滚动样本（用于取中位数平滑，压制单窗口抖动） */
  secPerCharSamples: number[]
  /** 并发窗口数（窗口细读/矛盾扫描并行度，来自 Provider 配置） */
  concurrency: number
  interrupted?: CompilationInterrupt
}

/** 会话级断点续传存储（key = compilationId）。应用重启后清空（会话内续传）。 */
const resumeStore = new Map<string, CompilationResumeState>()

interface ProviderInfo {
  apiBase: string
  model: string
  apiKey: string
  /** 该 Provider 配置的并发窗口数（Phase B：AI 细读/矛盾扫描并行度；默认 4，范围 1–8） */
  concurrency: number
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
  const concurrency = Math.min(8, Math.max(1, Math.round(provider.config.concurrency ?? 4)))
  return { ok: true, provider: { apiBase: provider.config.apiBase, model: provider.config.model, apiKey: provider.apiKey, concurrency } }
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
    for (const c of chunkByParagraphs(s.cleanedText ?? '')) {
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
  const indexed: { sourceId: string; sourceTitle: string; position: string; text: string; score: number; vecHit: boolean; inlineRelevant: boolean; paragraphKey: string }[] = []
  const maxScoreBySource = new Map<string, number>()
  const totalLenBySource = new Map<string, number>()
  // 段级相关（Phase A/B：整段为一个保留/剔除单元——段内任一子块有信号 → 整段所有子块一起保留）
  const paragraphRelevant = new Set<string>() // key = sourceId|第N段

  for (const s of sources) {
    const chunks = chunkByParagraphs(s.cleanedText ?? '')
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
      const paragraphKey = c.position.match(/第(\d+)段/)?.[0] ?? c.position
      indexed.push({ sourceId: s.id, sourceTitle: s.title, position: c.position, text: c.text, score, vecHit, inlineRelevant, paragraphKey })
      if (inlineRelevant) {
        relevantSources.add(s.id)
        paragraphRelevant.add(s.id + '|' + paragraphKey)
      }
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
    // 整段级判定：专属来源整篇保留，否则仅保留“所在段”有任一子块信号的全部子块
    if (dedicatedSources.has(it.sourceId) || paragraphRelevant.has(it.sourceId + '|' + it.paragraphKey)) {
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
    '请以上述撰写主题与范围为准，判断哪些候选材料与主题相关；与主题无关或无法从材料中确认的内容不要输出。',
    '',
    '每条候选材料是一个【完整条目/整段】。请先判断它与本次主题是否相关；相关则把【该条目的完整原文】作为一张卡片输出，不要按时间/事实再做更细切分。仅当条目非常长（如超过 800 字）时，才可按事实拆成几张卡片，但每张必须自包含。',
    '',
    '对每个相关事实，输出一张卡片：',
    '1. excerpt 必须是该条目的【整段原文】，或一个自包含的完整事实（含主体/对象/时间等必要成分，能独立成句；不得只输出“其中…”这类缺少主语的从句部分，不得从句子中间截断，不得改写/补写/概括）；',
    '2. ts 为时间标签（如「2005 年」「2005—2010 年」），只写原文中能确定的时间，没有就填 null；',
    '3. sourceRef 用文件编号（如 #1）；',
    '4. 同一事实不同来源相左时，输出到 contradictions（仅实质性冲突：数据/时间/地点/主体/结果不同；措辞差异不算）。',
    '',
    '若遇到页码、页眉/页脚、目录点线、索引行、纯数据行等排版噪声，直接跳过，不要输出卡片。',
    '若多条候选材料是同一句子的延续，请合并成一张卡片后输出。',
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
  return ['【文件清单】', refText(refs), '本次撰写主题与范围：' + instruction, '', '【候选材料】', materials, '', '请按上述 JSON 格式输出资料汇编：每条候选材料是一个完整条目/整段，相关时直接将其完整原文作为一张卡片（整段原文）；仅当条目极长才可按事实拆成自包含卡片。只保留与主题直接相关的条目，并跳过页码/目录/索引等噪声。'].join('\n')
}

export interface CompilationOutputItem {
  sourceRef: string
  position: string
  excerpt: string
  ts: string | null
  /**
   * 管线内附加：该卡片被大模型修正过（由 repair 阶段写入；**不来自 LLM 输出的 JSON 解析**）。
   * 它随卡片对象一起流经合并/过滤/按时间排序，最终由 insertCompilationItems 与卡片同事务写入
   * compilation_repairs，从而保证「修正标记」与卡片的对应关系不错位。
   */
  repair?: { originalText: string; revisedText: string; reason: string }
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
  indices: number[],
  refs: SourceRefEntry[],
  taskId: string
): Promise<{ groups: CompilationOutputGroup[]; ok: boolean; message?: string; rateLimited?: boolean }> {
  if (indices.length === 0) return { groups: [], ok: true }
  const titleByRef = new Map(refs.map((r, idx) => ['#' + (idx + 1), r.title]))
  // 压缩输入：只给每条卡片的前 CARD_SCAN_EXCERPT_CHARS 字（矛盾判定只需“同一事实的不同说法”这一小段）
  const cardList = indices
    .map((itemIdx, i) => {
      const it = items[itemIdx]
      const raw = it.excerpt
      const excerpt = raw.length > CARD_SCAN_EXCERPT_CHARS ? raw.slice(0, CARD_SCAN_EXCERPT_CHARS) + '…' : raw
      return '[' + (i + 1) + '] 来源：#' + it.sourceRef + '《' + (titleByRef.get(it.sourceRef) ?? '') + '》，时间：' + (it.ts ?? '无') + '\n' + excerpt
    })
    .join('\n\n')
  const sys = [
    '你是一名地方志资料校对员。下面给出若干【资料卡片】（每条含编号、来源、时间、摘录），它们都已按“可能描述同一事实”预筛过。',
    '请只比较同一事实的不同说法：数据、时间、地点、主体或结果相互矛盾时，归为一组矛盾。',
    '多数卡片并不冲突；没有实质冲突时直接输出空数组。不要输出解释或其它文字。',
    '只输出一个 JSON 对象，不得输出其它文字或代码块围栏：',
    '"contradictions":[{"topic":"事实主题","kind":"data|time|place|fact|other","cardIndices":[1,3]}]'
  ].join('\n')
  const user = [
    '【资料卡片】',
    cardList,
    '请输出矛盾分组，cardIndices 填所涉及卡片的编号（1 起）；无矛盾输出 {"contradictions":[]}。'
  ].join('\n')
  const messages: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]
  // 单次调用（温度 0、不重试）：实测单次耗时主要来自推理本身，重试只会让总时长翻倍
  const result = await chatCompletion(provider, messages, CARD_SCAN_TIMEOUT_MS, { kind: 'compilation-contradiction-scan', taskId }, {
    maxRetries: 0,
    temperature: CARD_SCAN_TEMPERATURE,
    seed: REPRODUCIBILITY_SEED
  })
  if (!result.ok) {
    return {
      groups: [],
      ok: false,
      message: result.error?.message ?? '矛盾扫描失败',
      rateLimited: result.error?.code === ErrorCodes.LLM_RATE_LIMIT
    }
  }
  const groups = parseCardScanGroups(result.text) ?? []
  const out: CompilationOutputGroup[] = []
  for (const g of groups) {
    const variants: CompilationOutputVariant[] = []
    for (const ci of g.cardIndices) {
      const itemIdx = indices[ci - 1]
      if (itemIdx === undefined) continue
      const it = items[itemIdx]
      variants.push({ excerpt: it.excerpt, sourceRefs: [it.sourceRef] })
    }
    if (variants.length < 2) continue
    out.push({ topic: g.topic, kind: g.kind, variants })
  }
  return { groups: out, ok: true }
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
/** 把 #N 来源编号映射回 sourceId，丢弃无法解析的卡片；大模型修正记录随卡片一起带走 */
export function mapOutputItemsToInputs(
  items: CompilationOutputItem[],
  refs: SourceRefEntry[]
): CompilationItemInput[] {
  const byRef = new Map(refs.map((r) => ['#' + r.index, r.sourceId]))
  const out: CompilationItemInput[] = []
  for (const it of items) {
    const sourceId = byRef.get(it.sourceRef)
    if (!sourceId) continue
    out.push({ sourceId, excerpt: it.excerpt, ts: it.ts ?? undefined, note: it.position || undefined, repair: it.repair })
  }
  return out
}

/** 断点续传：返回仍需（重新）细读的窗口下标（升序；失败/未读的下标不在 doneSet，续跑时重新处理） */
/** 429 限流自动降并发：减半（最小 1），仅本次生成生效，不写回 Provider 设置 */
export function reduceConcurrency(concurrency: number): number {
  return Math.max(1, Math.floor(concurrency / 2))
}

export function pickRemainingWindows(doneSet: Set<number>, total: number): number[] {
  const out: number[] = []
  for (let i = 0; i < total; i++) if (!doneSet.has(i)) out.push(i)
  return out
}

/** 断点续传：返回下一个待扫描的矛盾卡片批范围；已扫完（scanOffset >= total）返回 null */
export function nextContradictionBatch(scanOffset: number, batchSize: number, total: number): { start: number; end: number } | null {
  if (scanOffset >= total) return null
  return { start: scanOffset, end: Math.min(total, scanOffset + batchSize) }
}

/** 按“卡片数 + 累计字符”双预算切批（方案 C 后卡片变长，避免长卡片把单批撑得过大导致响应超时）。 */
export function splitCardScans(items: CompilationOutputItem[], startIndex: number, maxCount: number, maxChars: number): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  let i = startIndex
  while (i < items.length) {
    const start = i
    let chars = 0
    let count = 0
    while (i < items.length && count < maxCount && (chars + items[i].excerpt.length <= maxChars || count === 0)) {
      chars += items[i].excerpt.length
      count += 1
      i += 1
    }
    ranges.push({ start, end: i })
  }
  return ranges
}

/** 扫描阶段用：去掉空白与标点，便于 bigram 相似度比较（保留数字与汉字） */
function normalizeCardText(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 集合版 bigram Dice 相似度（比数组版快，用于本地预筛的两两比较） */
function setDice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let common = 0
  for (const g of small) if (large.has(g)) common += 1
  return (2 * common) / (a.size + b.size)
}

/**
 * 本地预筛（阻断法 blocking）：只有“可能描述同一事实”的卡片才需要交给大模型比对矛盾。
 * 用 bigram Dice 相似度（去掉空白/标点后）做并查集聚类，只返回 ≥2 张的候选簇——
 * 孤立卡片不可能与其它卡片冲突，直接跳过，从而把待扫卡片数与调用次数大幅压下来。
 */
export function clusterCandidateCards(items: CompilationOutputItem[], threshold: number = CARD_PREFILTER_DICE): number[][] {
  const grams = items.map((it) => new Set(bigrams(normalizeCardText(it.excerpt))))
  const parent = items.map((_, i) => i)
  const find = (x: number): number => {
    let root = x
    while (parent[root] !== root) root = parent[root]
    while (parent[x] !== root) { const next = parent[x]; parent[x] = root; x = next }
    return root
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (setDice(grams[i], grams[j]) < threshold) continue
      const ra = find(i)
      const rb = find(j)
      if (ra !== rb) parent[rb] = ra
    }
  }
  const byRoot = new Map<number, number[]>()
  for (let i = 0; i < items.length; i++) {
    const r = find(i)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r)!.push(i)
  }
  return [...byRoot.values()].filter((c) => c.length >= 2)
}

/** 把候选簇装进若干次调用：同一簇的卡片不拆到两次调用（拆开就看不到彼此），并按字符/数量预算切分。 */
export function packCandidateCalls(
  items: CompilationOutputItem[],
  clusters: number[][],
  maxCount: number,
  maxChars: number
): number[][] {
  const calls: number[][] = []
  let cur: number[] = []
  let curChars = 0
  const cardChars = (idx: number): number =>
    Math.min(items[idx].excerpt.length, CARD_SCAN_EXCERPT_CHARS) + 40 // +40 ≈ 编号/来源/年份前缀
  for (const cluster of clusters) {
    const clusterChars = cluster.reduce((n, i) => n + cardChars(i), 0)
    if (cur.length > 0 && (cur.length + cluster.length > maxCount || curChars + clusterChars > maxChars)) {
      calls.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(...cluster)
    curChars += clusterChars
  }
  if (cur.length > 0) calls.push(cur)
  return calls
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
  onProgress?: (p: CompilationProgress) => void,
  onAdvice?: (message: string) => void
): Promise<GenerateCompilationResult> {
  const task = getTaskById(taskId)
  if (!task) return fail(ErrorCodes.TASK_NOT_FOUND, '撰写任务不存在')
  const t = title.trim()
  if (!t) return fail(ErrorCodes.INVALID_PARAM, '请填写本次撰写的标题')

  const prov = resolveProvider()
  // A+C：预计剩余时间——窗口细读用实测均速（EMA）外推；窗口块未算出前用占位预算，让前置阶段预估不至于明显失真
  let windowsBudgetSec = WINDOWS_PRIOR_PLACEHOLDER_S
  const preWindowEta = (remainingSinglePhaseSec: number): number =>
    remainingSinglePhaseSec + windowsBudgetSec + PHASE_PURIFY_ETA_S + PHASE_REPAIR_ETA_S + PHASE_CONTRADICTION_ETA_S

  let scopeIds = resolveScopeSourceIds(task, { getSourceIdsByTag, getAllSourceIds })
  if (scopeIds.length === 0) return fail(ErrorCodes.TASK_NO_SCOPE, '资料库中没有可用资料')

  // 用大模型（若可用、更懂方志语境）从完整撰写要求中提取“标题 + 粗筛关键词（含近义词/专业词）”，
  // 用于本地粗筛与网页检索；失败或无 Provider 时回退本地 extractTopicTerms + expandDomainHints。
  onProgress?.({ stage: '正在理解撰写任务并提取粗筛关键词…', percent: 6, etaSeconds: preWindowEta(PHASE_KEYWORD_ETA_S + PHASE_WEB_ETA_S + PHASE_RECALL_ETA_S + PHASE_GATE_ETA_S) })
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
    onProgress?.({ stage: '已提取标题：' + extracted.title + '；提取粗筛关键词 ' + extracted.keywords.length + ' 个', percent: 7, etaSeconds: preWindowEta(PHASE_WEB_ETA_S + PHASE_RECALL_ETA_S + PHASE_GATE_ETA_S) })
    // 首次由大模型提取出标题后，自动把任务标题从默认值改为该标题（用户仍可后续重命名）
    if (task.title === '新建任务' && extracted.title) {
      try { renameTask(taskId, extracted.title) } catch { /* 重命名失败不影响汇编生成 */ }
    }
  } else {
    coarseQuery = fallbackCoarseQuery(t)
    vecQuery = coarseQuery
  }

  onProgress?.({ stage: '正在检索网页资料库…', percent: 8, etaSeconds: preWindowEta(PHASE_RECALL_ETA_S + PHASE_GATE_ETA_S) })
  const webIds = await fetchRelatedSiteSources(coarseQuery, taskId).catch(() => [] as string[])
  if (webIds.length > 0) scopeIds = Array.from(new Set([...scopeIds, ...webIds]))

  onProgress?.({ stage: '正在本地召回资料（宁多勿漏）…', percent: 10, etaSeconds: preWindowEta(PHASE_GATE_ETA_S) })
  const allChunks = recallCandidateChunks(scopeIds, coarseQuery)
  if (allChunks.length === 0) return fail(ErrorCodes.LLM_NO_CANDIDATES, '资料库中没有可召回的资料')

  // 无 Provider → 本地降级（卡片 = 全部候选块，无矛盾；用全量集合避免降级丢失任何可能相关材料）
  if (!prov.ok) {
    return finalizeCompilationLocal(taskId, title, allChunks)
  }

  // 2026-08-25 优化：调用大模型前用保守本地闸门收窄提交物——把"任务范围内全部段落"收敛为
  // "与主题相关的来源及其相关段落"。完全无关的来源整篇舍弃，宽口径来源只保留有信号的段；
  // 用低阈值向量路径兜底"字面无关但语义相关"的段落，避免误删可能相关的内容。
  onProgress?.({ stage: '正在按主题收敛候选材料（保守闸门）…', percent: 11, etaSeconds: preWindowEta(0) })
  const vectors = await embedTexts([vecQuery]).catch(() => null)
  const queryVector = vectors ? vectors[0] : undefined
  const recall = recallCompilationCandidates(scopeIds, coarseQuery, queryVector)
  const chunks = recall.chunks.length > 0 ? recall.chunks : allChunks

  const refs = buildCompilationSourceRefs(chunks)

  // 分窗 AI 细读（可中断/可续跑）
  const windows = sliceChunks(chunks, WINDOW_MAX_CHARS)
  windowsBudgetSec = windows.length * WINDOW_ETA_DEFAULT_S
  // 清除该任务可能遗留的旧中断续传记录（「重新生成」语义：丢弃旧的断点）
  for (const k of resumeStore.keys()) {
    const st = resumeStore.get(k)
    if (st && st.taskId === taskId) resumeStore.delete(k)
  }
  // 生成一开始就创建 drafting 汇编，使中断时能把「已完成窗口」的部分卡片落库、供用户看到并可续跑
  const comp = createCompilation({ taskId, title })
  const state: CompilationResumeState = {
    taskId,
    compilationId: comp.id,
    title: t,
    provider: prov.provider,
    phase: 'window',
    chunks,
    refs,
    windows,
    windowChars: windows.map((w) => w.reduce((n, c) => n + c.text.length, 0)),
    doneSet: new Set<number>(),
    windowOutputsByIndex: new Array<CompilationOutput | null>(windows.length).fill(null),
    scanOffset: 0,
    scanGroups: [],
    avgSecPerChar: 0,
    secPerCharSamples: [],
    concurrency: prov.provider.concurrency
  }
  onProgress?.({
    stage: '正在由 AI 细读资料（0/' + windows.length + ' 个窗口）…',
    percent: 12,
    etaSeconds: preWindowEta(0),
    candidateChunks: chunks.length,
    candidateSources: refs.length
  })

  let phaseRes = await runWithRateLimitAutoResume(state, runWindowPhase, onProgress, onAdvice)
  if (phaseRes === 'interrupted') {
    await persistPartialCompilation(state)
    resumeStore.set(state.compilationId, state)
    return interruptedResult(state)
  }

  const merged = mergeCompilationOutputs(state.windowOutputsByIndex.filter((o): o is CompilationOutput => o !== null))
  if (merged.items.length === 0) {
    // AI 未产出有效卡片 → 本地降级（用全量集合，不丢材料）；复用已创建的汇编
    resumeStore.delete(state.compilationId)
    return finalizeCompilationLocalInto(state.compilationId, allChunks)
  }

  // 大模型提纯（2026-09-08 新增：置于修正之前——先摘出与主题相关的句段，得到更细粒度、更纯净的
  // 卡片集；修正的「标记 + 回退」因此仍与最终卡片一对一，无需迁移修正记录）
  state.phase = 'purify'
  phaseRes = await runWithRateLimitAutoResume(
    state,
    (s, p) => runPurifyPhase(s, merged.items, p),
    onProgress,
    onAdvice
  )
  if (phaseRes === 'interrupted') {
    await persistPartialCompilation(state)
    resumeStore.set(state.compilationId, state)
    return interruptedResult(state)
  }
  const purifiedItems = state.purifiedItems ?? merged.items

  // 大模型修正（作用于提纯后的片段：补全残缺表述、静默补齐缺失时间戳）
  state.phase = 'repair'
  phaseRes = await runWithRateLimitAutoResume(
    state,
    (s, p) => runRepairPhase(s, purifiedItems, p),
    onProgress,
    onAdvice
  )
  if (phaseRes === 'interrupted') {
    await persistPartialCompilation(state)
    resumeStore.set(state.compilationId, state)
    return interruptedResult(state)
  }
  const repairedItems = state.repairedItems ?? purifiedItems
  // 窗口级矛盾的说法先经提纯映射（整段 → 片段），再按修正结果改写，否则落库时按 excerpt 匹配不到卡片、整组会被丢弃
  const windowGroups = remapRepairedVariantExcerpts(
    mapWindowGroupsThroughPurify(merged.contradictions, merged.items, purifiedItems),
    state.repairFixes ?? []
  )

  state.phase = 'contradiction'
  phaseRes = await runWithRateLimitAutoResume(
    state,
    (s, p) => runContradictionPhase(s, repairedItems, p),
    onProgress,
    onAdvice
  )
  if (phaseRes === 'interrupted') {
    await persistPartialCompilation(state)
    resumeStore.set(state.compilationId, state)
    return interruptedResult(state)
  }

  // 全部完成：清除断点，落库（替换为最终卡片 + 矛盾 + 修正记录）
  resumeStore.delete(state.compilationId)
  return finalizeCompilationInto(
    state.compilationId,
    { items: repairedItems, contradictions: mergeContradictionGroups(windowGroups, state.scanGroups) },
    refs,
    chunks.length,
    state.scanIncomplete ? { ok: false, message: state.scanIncomplete.message } : { ok: true },
    state.repairIncomplete ? { ok: false, message: state.repairIncomplete.message } : { ok: true },
    {
      ok: !state.purifyIncomplete,
      message: state.purifyIncomplete?.message,
      inputCards: state.purifyStats?.inputCards,
      outputCards: state.purifyStats?.outputCards,
      inputChars: state.purifyStats?.inputChars,
      outputChars: state.purifyStats?.outputChars,
      passthroughCards: state.purifyPassthroughCards
    }
  )
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

interface ReadWindowResult {
  out: CompilationOutput | null
  /** true = 大模型调用异常（余额不足/网络/超时等），需要中断并允许「尝试继续」 */
  failed: boolean
  message?: string
  /** true = 失败原因是限流（HTTP 429），可自动续传/自动降并发 */
  rateLimited?: boolean
}

async function readWindow(
  provider: ProviderInfo,
  windowChunks: RetrievedChunk[],
  refs: SourceRefEntry[],
  taskId: string,
  instruction: string
): Promise<ReadWindowResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(instruction) },
    { role: 'user', content: buildUserPrompt(windowChunks, refs, instruction) }
  ]
  let failedMsg: string | undefined
  let rateLimited = false
  for (let attempt = 0; attempt < TEMPERATURES.length; attempt++) {
    const result = await chatCompletion(provider, messages, COMPILATION_TIMEOUT_MS, { kind: 'compilation-read', taskId }, {
      maxRetries: 1,
      temperature: TEMPERATURES[attempt],
      seed: REPRODUCIBILITY_SEED
    })
    if (!result.ok) {
      // 记录失败原因（最终若所有温度都失败则作为中断信息透出）；区分限流（429，可自动续传）
      failedMsg = failedMsg ?? result.error?.message ?? '大模型调用异常'
      if (result.error?.code === ErrorCodes.LLM_RATE_LIMIT) rateLimited = true
      continue
    }
    const parsed = parseCompilationOutput(result.text)
    if (parsed) return { out: parsed, failed: false }
  }
  // 全部温度要么调用失败、要么无可解析输出：调用失败视为「异常中断」，可继续；无可解析输出视为正常（无卡片）
  return failedMsg ? { out: null, failed: true, message: failedMsg, rateLimited } : { out: null, failed: false }
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

/** 把「已完成阶段」的部分卡片落库（替换为当前部分结果），供中断时展示并可续跑 */
async function persistPartialCompilation(state: CompilationResumeState): Promise<void> {
  const merged = mergeCompilationOutputs(state.windowOutputsByIndex.filter((o): o is CompilationOutput => o !== null))
  // 已经跑过提纯/修正时，落库部分结果也用最新的卡片形态（提纯后的片段 / 已修正文本）
  const source = state.repairedItems ?? state.purifiedItems ?? merged.items
  const items = mapOutputItemsToInputs(source, state.refs)
  replaceCompilationItems(state.compilationId, sortItemsByTs(items))
}

/** 大模型异常中断时的结果（ok: true，含部分卡片与中断信息） */
function interruptedResult(state: CompilationResumeState): GenerateCompilationResult {
  return { ok: true, compilationId: state.compilationId, candidateChunks: state.chunks.length, contradictions: 0, interrupted: state.interrupted }
}

/** 窗口细读（可中断/可续跑）：只读未完成的窗口；任一窗口大模型异常 → 置中断标志，返回 'interrupted' */
type PhaseRunner = (state: CompilationResumeState, onProgress?: (p: CompilationProgress) => void) => Promise<'done' | 'interrupted'>

/**
 * 429 断点自动续传（Phase A/B）：遇到限流中断时，自动降低本次生成的并发数（不写回 Provider 设置），
 * 提示用户建议降低 Provider 并发数，并退避后从断点重试；达到 RATE_LIMIT_RESUME_LIMIT 仍限流才真正中断。
 * 由于 runWindowPhase/runContradictionPhase 是可续跑的（基于 doneSet/scanOffset），直接重跑即从断点继续。
 */
async function runWithRateLimitAutoResume(
  state: CompilationResumeState,
  runPhase: PhaseRunner,
  onProgress?: (p: CompilationProgress) => void,
  onAdvice?: (kind: string) => void
): Promise<'done' | 'interrupted'> {
  let resumes = 0
  let result = await runPhase(state, onProgress)
  while (result === 'interrupted' && state.interrupted?.retryable && resumes < RATE_LIMIT_RESUME_LIMIT) {
    resumes += 1
    // 仅本次生成自动降并发，不修改用户 Provider 设置
    if (state.concurrency > 1) state.concurrency = reduceConcurrency(state.concurrency)
    onAdvice?.('reduce-concurrency')
    await sleep(RATE_LIMIT_RESUME_BACKOFF_MS[Math.min(resumes - 1, RATE_LIMIT_RESUME_BACKOFF_MS.length - 1)])
    result = await runPhase(state, onProgress)
  }
  return result
}

async function runWindowPhase(state: CompilationResumeState, onProgress?: (p: CompilationProgress) => void): Promise<'done' | 'interrupted'> {
  const total = state.windows.length
  const remaining = pickRemainingWindows(state.doneSet, state.windows.length)
  let idx = 0
  let halt = false
  let interrupted = false
  const nextIdx = (): number | undefined => {
    while (!halt && idx < remaining.length) {
      const i = remaining[idx++]
      if (!state.doneSet.has(i)) return i
    }
    return undefined
  }
  const workers = Array.from({ length: Math.min(state.concurrency, remaining.length) }, async () => {
    while (!halt) {
      const i = nextIdx()
      if (i === undefined) return
      const wStart = Date.now()
      const r = await readWindow(state.provider, state.windows[i], state.refs, state.taskId, state.title)
      const wSec = (Date.now() - wStart) / 1000
      // A+C 字符加权：用“每字符秒数”而非“每窗口秒数”，并取最近若干窗口的中位数平滑，压制单窗口抖动
      const chars = state.windowChars[i] || 1
      const secPerChar = wSec / chars
      state.secPerCharSamples.push(secPerChar)
      if (state.secPerCharSamples.length > WINDOW_ETA_MEDIAN_N) state.secPerCharSamples.shift()
      if (state.avgSecPerChar === 0) state.avgSecPerChar = secPerChar
      else state.avgSecPerChar = WINDOW_ETA_ALPHA * secPerChar + (1 - WINDOW_ETA_ALPHA) * state.avgSecPerChar
      if (r.failed) {
        halt = true
        interrupted = true
        state.interrupted = {
          stage: '正在由 AI 细读资料（' + (state.doneSet.size + 1) + '/' + total + ' 个窗口）',
          message: r.message ?? '大模型调用异常中断',
          percent: Math.round(12 + (state.doneSet.size / total) * 54),
          retryable: r.rateLimited === true
        }
      } else {
        state.doneSet.add(i)
        state.windowOutputsByIndex[i] = r.out
        const done = state.doneSet.size
        // 剩余字符数（未完成窗口）
        const remainingChars = state.windowChars.reduce((acc, ch, wi) => acc + (state.doneSet.has(wi) ? 0 : ch), 0)
        // 预热期：实测样本不足时用“窗口数 × 默认先验”的较宽估计；否则用“每字符秒数的中位数 × 剩余字符数”
        const warm = state.secPerCharSamples.length < WINDOW_ETA_WARMUP
        const secPerChar = state.secPerCharSamples.length > 0 ? medianNumber(state.secPerCharSamples) : state.avgSecPerChar
        const windowEta = warm
          ? (total - done) * WINDOW_ETA_DEFAULT_S
          : Math.round((secPerChar > 0 ? secPerChar : state.avgSecPerChar) * remainingChars)
        // 后续单次调用阶段（提纯 + 修正）与矛盾扫描阶段的先验
        const postWindowEta = PHASE_PURIFY_ETA_S + PHASE_REPAIR_ETA_S
        const contradictionEta = warm ? PHASE_CONTRADICTION_ETA_S : Math.min(600, CARD_SCAN_ETA_PER_CALL_S * 2)
        onProgress?.({
          stage: '正在由 AI 细读资料（' + done + '/' + total + ' 个窗口）…',
          percent: Math.round(12 + (done / total) * 54),
          etaSeconds: Math.max(0, Math.round(windowEta + postWindowEta + contradictionEta)),
          candidateChunks: state.chunks.length,
          candidateSources: state.refs.length
        })
      }
    }
  })
  await Promise.all(workers)
  return interrupted ? 'interrupted' : 'done'
}

/**
 * 大模型提纯阶段（2026-09-08 新增，位于窗口细读之后、修正之前；可中断/可续跑）：
 * 把细读产出的「整段卡片」交给大模型逐字摘录与主题相关的句段，舍弃无关内容，得到更细粒度、
 * 更纯净的卡片集。约束见 purify-service（严格子串 + 本地校验 + 句读吸附；写通测试口径）。
 * - **按 Provider 并发数并行批次**（2026-09-10 优化：实测串行 8 批耗时 610s，而细读阶段 4 路并行墙钟只有其 1/3）；
 * - 无可解析输出 / 片段全部校验失败 / 未获结果的卡片 → 保留原卡（降级，绝不丢材料）；
 * - 大模型异常 → 置中断标志（429 可自动续传），续跑只重跑本阶段未完成的批次；
 * - 超出整阶段时间预算 → 剩余批次按「保留原卡」处理并标为未完成，不阻断后续阶段。
 */
async function runPurifyPhase(
  state: CompilationResumeState,
  items: CompilationOutputItem[],
  onProgress?: (p: CompilationProgress) => void
): Promise<'done' | 'interrupted'> {
  if (items.length === 0) {
    state.purifiedItems = items
    return 'done'
  }
  if (!state.purifyBatches) {
    state.purifyCandidates = buildPurifyCandidates(items, state.refs)
    state.purifyBatches = splitPurifyBatches(state.purifyCandidates)
    state.purifySpans = state.purifySpans ?? []
    state.purifyDoneBatches = state.purifyDoneBatches ?? new Set<number>()
    state.purifyStartedAt = Date.now()
  }
  const batches = state.purifyBatches
  const candidates = state.purifyCandidates ?? []
  const spans = state.purifySpans ?? (state.purifySpans = [])
  const done = state.purifyDoneBatches ?? (state.purifyDoneBatches = new Set<number>())
  const applied = new Set(spans.map((s) => s.parentIndex))
  const agg = emptyPurifyStats()
  const finish = (incomplete?: string): void => {
    const res = applyPurifyOutcome(items, spans)
    state.purifiedItems = res.items
    state.purifyStats = res.stats
    state.purifyPassthroughCards = agg.passthroughCards
    if (incomplete) state.purifyIncomplete = { message: incomplete }
    logPurify(
      '完成',
      '汇编=' +
        state.compilationId +
        ' 卡片 ' +
        res.stats.inputCards +
        ' → ' +
        res.stats.outputCards +
        '，字数 ' +
        res.stats.inputChars +
        ' → ' +
        res.stats.outputChars +
        '（' +
        Math.round((res.stats.outputChars / Math.max(1, res.stats.inputChars)) * 100) +
        '%）' +
        '，原样保留 ' +
        agg.passthroughCards +
        ' 张（漏答 ' +
        agg.omittedCards +
        '），校验失败片段 ' +
        agg.invalid +
        ' 条，句读吸附 ' +
        agg.snapExpanded +
        ' 处，重试 ' +
        agg.retried +
        ' 次' +
        (incomplete ? '；未完成：' + incomplete : '')
    )
  }
  if (batches.length === 0) {
    onProgress?.({ stage: '无需提纯的资料卡片，已跳过提纯阶段', percent: 77, etaSeconds: 0 })
    finish()
    return 'done'
  }

  const startedAt = state.purifyStartedAt ?? Date.now()
  const queue = batches.map((_, i) => i).filter((i) => !done.has(i))
  let cursor = 0
  let dispatched = 0
  let halt = false
  let interrupted = false
  let budgetHit = false
  const nextBatch = (): number | undefined => {
    while (!halt && cursor < queue.length) {
      const bi = queue[cursor++]
      if (!done.has(bi)) return bi
    }
    return undefined
  }
  const workers = Array.from({ length: Math.min(Math.max(1, state.concurrency), queue.length) }, async () => {
    while (!halt) {
      const bi = nextBatch()
      if (bi === undefined) return
      if (Date.now() - startedAt > PURIFY_PHASE_BUDGET_MS) {
        budgetHit = true
        halt = true
        return
      }
      const remaining = batches.length - done.size
      dispatched += 1
      onProgress?.({
        stage: '正在提纯资料（第 ' + dispatched + '/' + batches.length + ' 批：筛除与主题无关的句段）…',
        percent: 67 + Math.round((done.size / batches.length) * 10),
        etaSeconds: Math.max(1, Math.ceil(remaining / Math.max(1, state.concurrency))) * PURIFY_ETA_PER_CALL_S
      })
      const batchCards = batches[bi].map((i) => candidates[i]).filter((c): c is PurifyCandidate => !!c)
      const res = await purifyBatch(state.provider, batchCards, state.title, state.taskId).catch((e) => ({
        ok: false,
        spans: [] as PurifiedSpan[],
        stats: emptyPurifyStats(batchCards.length, 0),
        message: e instanceof Error ? e.message : String(e),
        rateLimited: false
      }))
      if (!res.ok) {
        halt = true
        interrupted = true
        state.interrupted = {
          stage: '正在提纯资料（第 ' + dispatched + '/' + batches.length + ' 批）',
          message: res.message ?? '大模型调用异常中断',
          percent: 67 + Math.round((done.size / batches.length) * 10),
          retryable: res.rateLimited === true
        }
        return
      }
      for (const s of res.spans) {
        if (!applied.has(s.parentIndex)) {
          spans.push(s)
          applied.add(s.parentIndex)
        }
      }
      logPurifyBatchStats(bi + 1, batches.length, res.stats)
      agg.passthroughCards += res.stats.passthroughCards
      agg.omittedCards += res.stats.omittedCards
      agg.invalid += res.stats.invalid
      agg.snapExpanded += res.stats.snapExpanded
      agg.retried += res.stats.retried
      agg.retainedCards += res.stats.retainedCards
      agg.retainedChars += res.stats.retainedChars
      done.add(bi)
    }
  })
  await Promise.all(workers)

  if (interrupted) return 'interrupted'

  const completed = done.size
  if (budgetHit) {
    // 剩余批次保留原卡（不丢材料），并标记为未完成
    for (let k = 0; k < batches.length; k++) {
      if (done.has(k)) continue
      for (const idx of batches[k]) {
        const c = candidates[idx]
        if (c && !applied.has(c.index)) {
          spans.push(...passthroughSpans([c]))
          applied.add(c.index)
        }
      }
      agg.passthroughCards += batches[k].length
      done.add(k)
    }
    finish('提纯超出时间预算，已完成 ' + completed + '/' + batches.length + ' 批；其余卡片按原样保留。')
    onProgress?.({ stage: '提纯超出时间预算，未提纯的卡片已按原样保留', percent: 77, etaSeconds: 0 })
    return 'done'
  }
  finish()
  onProgress?.({
    stage:
      '资料提纯完成（卡片 ' +
      (state.purifyStats?.inputCards ?? items.length) +
      ' → ' +
      (state.purifyStats?.outputCards ?? items.length) +
      ' 张）',
    percent: 77,
    etaSeconds: 0
  })
  return 'done'
}

/**
 * 大模型修正阶段（2026-09-08 新增，位于提纯之后、卡片矛盾扫描之前；可中断/可续跑）：
 * 找出表意不明/疑似残缺的卡片并**默认应用**修正（同时静默补齐缺失时间戳），
 * 使随后交给矛盾检测的卡片内容更清晰完整。修正记录随卡片落库，供卡片上的标记展示与回退。
 * - 无 Provider / 无可解析输出 → 视为无修正，不阻断；
 * - 大模型异常 → 置中断标志（429 可自动续传），续跑只重跑本阶段未完成的批次；
 * - 超出整阶段时间预算 → 停止剩余批次，把结果标为未完成（不阻断后续矛盾扫描）。
 */
async function runRepairPhase(
  state: CompilationResumeState,
  items: CompilationOutputItem[],
  onProgress?: (p: CompilationProgress) => void
): Promise<'done' | 'interrupted'> {
  if (items.length === 0) {
    state.repairedItems = items
    return 'done'
  }
  // 候选与分批只算一次（续跑复用同一方案，保证断点稳定）
  if (!state.repairBatches) {
    const candidates = buildRepairCandidates(items, state.refs, state.chunks)
    state.repairCandidates = candidates
    state.repairBatches = splitRepairBatches(candidates)
    state.repairFixes = state.repairFixes ?? []
    state.repairTsFills = state.repairTsFills ?? []
    state.repairBatchDone = state.repairBatchDone ?? 0
    state.repairStartedAt = Date.now()
  }
  const batches = state.repairBatches
  const fixes = state.repairFixes ?? (state.repairFixes = [])
  const tsFills = state.repairTsFills ?? (state.repairTsFills = [])
  const candidates = state.repairCandidates ?? []
  /** 模型给出但不含年份、被本地拒绝的时间戳条数（诊断：用于确认「缺年份 ts」补全是否真的生效） */
  let tsRejected = 0
  const applyAll = (): void => {
    state.repairedItems = applyRepairOutcome(items, fixes, tsFills)
  }
  if (batches.length === 0) {
    onProgress?.({ stage: '无需修正的资料卡片，已跳过修正阶段', percent: 87, etaSeconds: 0 })
    applyAll()
    return 'done'
  }

  for (let bi = state.repairBatchDone ?? 0; bi < batches.length; bi++) {
    if (Date.now() - (state.repairStartedAt ?? Date.now()) > REPAIR_PHASE_BUDGET_MS) {
      state.repairIncomplete = {
        message: '大模型修正超出时间预算，已完成 ' + bi + '/' + batches.length + ' 批；部分卡片可能未做修正/补齐时间戳。'
      }
      break
    }
    onProgress?.({
      stage: '正在修正资料卡片（第 ' + (bi + 1) + '/' + batches.length + ' 批：补全语义、补齐时间戳）…',
      percent: 78 + Math.round((bi / batches.length) * 9),
      etaSeconds: (batches.length - bi) * REPAIR_ETA_PER_CALL_S
    })
    const batchCards = batches[bi].map((i) => candidates[i]).filter((c): c is RepairCandidate => !!c)
    const res = await scanRepairBatch(state.provider, batchCards, state.taskId).catch((e) => ({
      ok: false,
      fixes: [] as RepairFix[],
      tsFills: [] as { index: number; ts: string }[],
      tsRejected: 0,
      message: e instanceof Error ? e.message : String(e),
      rateLimited: false
    }))
    if (!res.ok) {
      state.interrupted = {
        stage: '正在修正资料卡片（第 ' + (bi + 1) + '/' + batches.length + ' 批）',
        message: res.message ?? '大模型调用异常中断',
        percent: 78 + Math.round((bi / batches.length) * 9),
        retryable: res.rateLimited === true
      }
      return 'interrupted'
    }
    fixes.push(...res.fixes)
    tsFills.push(...res.tsFills)
    tsRejected += res.tsRejected ?? 0
    state.repairBatchDone = bi + 1
  }
  applyAll()
  logMain(
    'repair',
    '修正阶段完成 汇编=' +
      state.compilationId +
      ' 卡片=' +
      items.length +
      ' 修正=' +
      fixes.length +
      ' 补时间戳=' +
      tsFills.length +
      (tsRejected > 0 ? ' 拒绝无年份时间戳=' + tsRejected : '')
  )
  onProgress?.({
    stage: '资料卡片修正完成（修正 ' + fixes.length + ' 张、补齐时间戳 ' + tsFills.length + ' 张）',
    percent: 87,
    etaSeconds: 0
  })
  return 'done'
}

/** 卡片矛盾扫描（可中断/可续跑）：从 scanOffset 继续扫剩余批次；任一批大模型异常 → 置中断标志 */
async function runContradictionPhase(
  state: CompilationResumeState,
  items: CompilationOutputItem[],
  onProgress?: (p: CompilationProgress) => void
): Promise<'done' | 'interrupted'> {
  if (items.length === 0) {
    state.scanOffset = 0
    state.scanGroups = []
    state.scanCallDone = 0
    return 'done'
  }
  // ① 本地预筛（阻断法）：只有“可能描述同一事实”的卡片（bigram 聚类 ≥2 张）才需要交给模型比对；
  //    孤立卡片不可能冲突，直接跳过 —— 这是把调用次数压下来的关键。
  const clusters = clusterCandidateCards(items)
  // ② 把候选簇打包成尽量少的调用（同簇不拆；按字符预算 + 数量预算），实测单次耗时与输入量弱相关，故宁可少次大一点。
  const calls = packCandidateCalls(items, clusters, CARD_SCAN_MAX, CARD_SCAN_CHARS)
  if (calls.length === 0) {
    onProgress?.({ stage: '卡片间未发现可能冲突的同一事实，已跳过矛盾扫描', percent: 99, etaSeconds: 0 })
    state.scanGroups = []
    state.scanCallDone = 0
    return 'done'
  }
  const doneCalls = state.scanCallDone ?? 0
  if (doneCalls === 0) {
    onProgress?.({
      stage: '正在汇总卡片间的矛盾（共 ' + calls.length + ' 批，逐一串行扫描）…',
      percent: 88,
      etaSeconds: calls.length * CARD_SCAN_ETA_PER_CALL_S
    })
  }
  const startedAt = Date.now()
  // ③ 串行扫描 + 时间预算：到点即停止，保留已得结果并把本阶段标为“未完成”，不再让进度条长时间无反馈地等待。
  for (let ci = doneCalls; ci < calls.length; ci++) {
    if (Date.now() - startedAt > CARD_SCAN_BUDGET_MS) {
      state.scanIncomplete = {
        message: '矛盾扫描超出时间预算，已完成 ' + ci + '/' + calls.length + ' 批；可能存在遗漏，请酌情复核或稍后重新生成。'
      }
      return 'done'
    }
    onProgress?.({
      stage: '正在检索卡片矛盾（第 ' + (ci + 1) + '/' + calls.length + ' 批）…',
      percent: 88 + Math.round((ci / calls.length) * 11),
      etaSeconds: (calls.length - ci) * CARD_SCAN_ETA_PER_CALL_S
    })
    const res = await scanCardContradictions(state.provider, items, calls[ci], state.refs, state.taskId).catch((e) => ({
      groups: [] as CompilationOutputGroup[],
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      rateLimited: false
    }))
    if (!res.ok) {
      state.interrupted = {
        stage: '正在检索卡片矛盾（第 ' + (ci + 1) + '/' + calls.length + ' 批）',
        message: res.message ?? '大模型调用异常中断',
        percent: 88,
        retryable: res.rateLimited === true
      }
      return 'interrupted'
    }
    state.scanGroups.push(...res.groups)
    state.scanCallDone = ci + 1
    state.scanOffset = items.length
  }
  onProgress?.({ stage: '卡片矛盾扫描完成', percent: 99, etaSeconds: 0 })
  return 'done'
}
/**
 * 窗口级矛盾的说法经「提纯映射」：细读阶段的窗口级矛盾引用的是提纯前的整段原文，
 * 提纯后卡片已变成片段，若不改写则落库时按 excerpt 匹配不到卡片、整组矛盾会被丢弃。
 * 说法对应的内容已被提纯舍弃时（映射为 null），该说法一并丢弃（材料已不在汇编中）。
 */
export function mapWindowGroupsThroughPurify(
  groups: CompilationOutputGroup[],
  parents: CompilationOutputItem[],
  purified: CompilationOutputItem[]
): CompilationOutputGroup[] {
  if (groups.length === 0) return groups
  const parentsText = parents.map((p) => p.excerpt)
  // 由「提纯后卡片」重建 父下标 → 片段文本 的映射：片段是父卡的子串，故可用包含关系定位其父卡
  const spansByParent = new Map<number, string[]>()
  for (const frag of purified) {
    let parentIndex = parents.findIndex((p) => p.excerpt.includes(frag.excerpt))
    if (parentIndex < 0) parentIndex = parents.findIndex((p) => frag.excerpt.includes(p.excerpt))
    if (parentIndex < 0) continue
    const list = spansByParent.get(parentIndex) ?? []
    list.push(frag.excerpt)
    spansByParent.set(parentIndex, list)
  }
  const out: CompilationOutputGroup[] = []
  for (const g of groups) {
    const variants: CompilationOutputVariant[] = []
    const seen = new Set<string>()
    for (const v of g.variants) {
      const mapped = mapVariantThroughPurify(v.excerpt, parentsText, spansByParent)
      if (!mapped || seen.has(mapped)) continue
      seen.add(mapped)
      variants.push({ excerpt: mapped, sourceRefs: v.sourceRefs })
    }
    if (variants.length >= 2) out.push({ topic: g.topic, kind: g.kind, variants })
  }
  return out
}

/** 使用已创建的汇编整体替换为最终卡片 + 矛盾（供正常完成 / 续跑完成调用） */
function finalizeCompilationInto(
  compilationId: string,
  output: CompilationOutput,
  refs: SourceRefEntry[],
  candidateChunks: number,
  contradictionScan?: { ok: boolean; message?: string },
  repairScan?: { ok: boolean; message?: string },
  purifyScan?: {
    ok: boolean
    message?: string
    inputCards?: number
    outputCards?: number
    inputChars?: number
    outputChars?: number
    passthroughCards?: number
  }
): GenerateCompilationResult {
  const items = sortItemsByTs(mapOutputItemsToInputs(output.items, refs))
  // 卡片携带的 repair 字段会与卡片同事务写入 compilation_repairs（status='applied'），故排序/过滤后仍严格对应
  const insertedItems = replaceCompilationItems(compilationId, items)

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
  const contradictions = insertCompilationContradictions(compilationId, groups)
  return {
    ok: true,
    compilationId,
    candidateChunks,
    contradictions: contradictions.length,
    contradictionScan,
    repairScan,
    purifyScan
  }
}

/** 无 Provider / AI 无产出时的本地降级（替换到已创建的汇编） */
function finalizeCompilationLocalInto(compilationId: string, chunks: RetrievedChunk[]): GenerateCompilationResult {
  const dedup = new Set<string>()
  const items: CompilationItemInput[] = []
  for (const c of chunks) {
    const key = c.sourceId + '|' + c.position + '|' + c.text
    if (dedup.has(key)) continue
    dedup.add(key)
    // 年份正则：`\d{2}` 曾被误写为 `d{2}`（少一个反斜杠，等同于字面量「d」），
    // 导致本地降级产出的卡片永远没有时间戳；此处修正为 4 位年份匹配。
    const m = c.text.match(/(18|19|20)\d{2}/)
    items.push({ sourceId: c.sourceId, excerpt: c.text, ts: m ? m[0] + ' 年' : undefined })
  }
  replaceCompilationItems(compilationId, sortItemsByTs(items))
  return { ok: true, compilationId, candidateChunks: chunks.length, contradictions: 0 }
}

/**
 * 中断续跑（Phase 6.x）：从断点继续生成资料汇编。
 * 仅会话内（内存 resumeStore，应用重启后清空）。复用已完成窗口/提纯批次/修正批次，重读失败或未完成的
 * 窗口、重跑未完成的提纯与修正批次，并继续扫描剩余矛盾批次；再次异常仍返回 interrupted（可再点「尝试继续」）。
 */
export async function continueCompilation(compilationId: string, onProgress?: (p: CompilationProgress) => void, onAdvice?: (message: string) => void): Promise<GenerateCompilationResult> {
  const state = resumeStore.get(compilationId)
  if (!state) return fail(ErrorCodes.INVALID_PARAM, '没有可继续的生成中断记录')

  // 窗口阶段：继续读未完成窗口
  if (state.phase === 'window') {
    const pr = await runWithRateLimitAutoResume(state, runWindowPhase, onProgress, onAdvice)
    if (pr === 'interrupted') {
      await persistPartialCompilation(state)
      return interruptedResult(state)
    }
    state.phase = 'purify'
    state.scanOffset = 0
  }

  const merged = mergeCompilationOutputs(state.windowOutputsByIndex.filter((o): o is CompilationOutput => o !== null))
  if (merged.items.length === 0) {
    // AI 无产出 → 本地降级（复用已创建的汇编）；清除断点
    resumeStore.delete(compilationId)
    return finalizeCompilationLocalInto(state.compilationId, state.chunks)
  }

  // 提纯阶段：续跑未完成的批次（已完成批次片段保留在 state.purifySpans 中）
  if (state.phase === 'purify') {
    const prPurify = await runWithRateLimitAutoResume(
      state,
      (s, p) => runPurifyPhase(s, merged.items, p),
      onProgress,
      onAdvice
    )
    if (prPurify === 'interrupted') {
      await persistPartialCompilation(state)
      return interruptedResult(state)
    }
    state.phase = 'repair'
  }
  const purifiedItems = state.purifiedItems ?? merged.items

  // 修正阶段：续跑未完成的批次（已完成批次结果保留在 state.repairFixes 中）
  if (state.phase === 'repair') {
    const prRepair = await runWithRateLimitAutoResume(
      state,
      (s, p) => runRepairPhase(s, purifiedItems, p),
      onProgress,
      onAdvice
    )
    if (prRepair === 'interrupted') {
      await persistPartialCompilation(state)
      return interruptedResult(state)
    }
    state.phase = 'contradiction'
  }
  const repairedItems = state.repairedItems ?? purifiedItems
  // 窗口级矛盾的说法先经提纯映射（整段 → 片段），再按修正结果改写
  const windowGroups = remapRepairedVariantExcerpts(
    mapWindowGroupsThroughPurify(merged.contradictions, merged.items, purifiedItems),
    state.repairFixes ?? []
  )

  const pr = await runWithRateLimitAutoResume(
    state,
    (s, p) => runContradictionPhase(s, repairedItems, p),
    onProgress,
    onAdvice
  )
  if (pr === 'interrupted') {
    await persistPartialCompilation(state)
    return interruptedResult(state)
  }
  resumeStore.delete(compilationId)
  return finalizeCompilationInto(
    state.compilationId,
    { items: repairedItems, contradictions: mergeContradictionGroups(windowGroups, state.scanGroups) },
    state.refs,
    state.chunks.length,
    state.scanIncomplete ? { ok: false, message: state.scanIncomplete.message } : { ok: true },
    state.repairIncomplete ? { ok: false, message: state.repairIncomplete.message } : { ok: true },
    {
      ok: !state.purifyIncomplete,
      message: state.purifyIncomplete?.message,
      inputCards: state.purifyStats?.inputCards,
      outputCards: state.purifyStats?.outputCards,
      inputChars: state.purifyStats?.inputChars,
      outputChars: state.purifyStats?.outputChars,
      passthroughCards: state.purifyPassthroughCards
    }
  )
}
