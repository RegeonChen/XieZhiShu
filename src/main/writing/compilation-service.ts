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
import Database from 'better-sqlite3'
import { setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { getTaskById, resolveScopeSourceIds, getAllSourceIds, renameTask } from '../db/tasks'
import { getSourceIdsByTag } from '../db/tags'
import { getSourcesByIds } from '../db/sources'
import { bigrams, chunkByParagraphsFromBase, scoreChunk, type ParagraphChunk } from '../rag/retrieval'
import { embedTexts } from '../rag/embed'
import { vectorSearch } from '../rag/vector-store'
import { ensureSourcesIndexed } from '../rag/indexer'
import { getSettings } from '../db/settings'
import { getProviderSecret } from '../llm/provider-store'
import { safeStorageCodec } from '../llm/secret'
import { chatCompletion, type ChatMessage } from '../llm/chat'
import { logMain } from '../logger'
import { extractTopicTerms, expandDomainHints, syncSite } from '../web-source/site-crawler'
import { sentenceRanges } from '../parse/anchors'
import {
  assembleDocument,
  formatSourceDate,
  locateVerbatim,
  parseTimeLabel,
  stripSpaces,
  textSimilarity,
  type AssembledParagraph
} from './compilation-document'
import {
  emptyExtractStats,
  extractBatch,
  EXTRACT_ETA_PER_CALL_S,
  EXTRACT_PHASE_BUDGET_MS,
  logExtractBatchStats,
  splitExtractBatches,
  type ExtractCandidate,
  type ExtractScanStats,
  type ExtractedDraft
} from './extract-service'
import {
  createCompilation,
  ensureCompilationSources,
  insertCompilationContradictions,
  replaceCompilationItems,
  setCompilationExtractScan,
  snapshotCompilationVersion,
  upsertCompilationParagraphs,
  type CompilationItemInput,
  type CompilationContradictionInput
} from '../db/compilations'
import { listWebSites } from '../db/web-sites'
import { listUrlSourceIdsByTask } from '../db/sources'
import { crawlAndScreenArticles } from '../web-source/article-crawl'
import { judgeBodyRelevance } from '../web-source/body-relevance'
import { stripStructureNoise } from '../parse/structure-noise'
import {
  analyzeWritingRequirement,
  analyzeWritingRequirementLocal,
  lexiconExtraTerms,
  type TopicLexiconAnalysis
} from './topic-lexicon'
/*
 * 2026-10-05（用户裁定"任何地方不得设总量上限"）：原 `material-budget.ts`（60 万字/轮总预算 + 分池）
 * 与 `db/material-queue.ts`（排队）**已整体删除**（用户明确指示"直接删掉即可"），本文件不再引用。
 */
import { attachAnchorsQuietly } from './source-anchors'
/*
 * 第二组 ⑤（2026-10-06）：**文章内取高信号段 ± 上下文**。
 * 判据与离线回放（`.dbg/backtest.test.ts`）**共用同一份实现**（`article-segments.ts`），
 * 产品侧只负责"按来源归组、把闸门放行的来源逐段判一遍、把保留的段按原顺序还原成候选块"。
 */
import {
  ARTICLE_CONTEXT_RANGE,
  planArticleSegments,
  type ArticleConvergenceStats
} from './article-segments'

/**
 * 网页资料抓取的汇总统计（Phase 10 P6：原定义在被删除的旧"标题粗筛"链路里，
 * 这里保留为**生成汇总的展示口径**——新链路（按年份全量抓取 + 正文筛选）填同样的字段）。
 */
export interface WebFetchStats {
  sites: number
  siteErrors: number
  /** 本轮**实际抓取**的篇数（2026-10-05 P6：口径统一为"抓取篇数"，不再含已删除的"标题命中"语义） */
  hits: number
  /** 通过正文相关性判定、落成该任务来源的篇数 */
  fetched: number
  chars: number
  /** Phase 10 P4/P5 追加：各类丢弃与失败计数（如实汇报） */
  /** **正文未通过相关性判定**而丢弃（= `crawl.dropped`）；与下面"没取到正文"是两回事 */
  relevanceDropped?: number
  /** A1 标题探针不过（老文章失效 → 站点返回通用模板页）而丢弃 */
  invalidBody?: number
  /** 空标题候选（sitemap）：正文过短 / 与同站别的 URL 正文逐字相同 */
  shortBody?: number
  templateRepeat?: number
  fetchFailed?: number
  /** 不在「http(s) + 同域白名单」内、**未发起请求**的篇数（安全过滤） */
  blocked?: number
  /** 2026-10-05：从正文缓存复用（零网络）的篇数 */
  cacheHits?: number
  /** 2026-10-05：本次运行触发的自适应降档次数 */
  downgrades?: number
}


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
/** 整合提取阶段的先验（秒）——单批约 EXTRACT_ETA_PER_CALL_S，批数在卡片确定后才知，故先用保守先验 */
const PHASE_EXTRACT_ETA_S = 120
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
  /**
   * 2026-10-05：网页抓取阶段的**运行态**（渲染层据此只在抓取进行中显示「暂停抓取 / 继续抓取」按钮）。
   * 抓取结束后后续阶段不再带该字段 → 按钮自动消失。
   */
  fetch?: { active: boolean; paused: boolean }
}

export type GenerateCompilationResult =
  | {
      ok: true
      compilationId: string
      candidateChunks: number
      contradictions: number
      contradictionScan?: { ok: boolean; message?: string }
      /** 整合提取阶段的情况与统计（供生成汇总展示：卡片/段落/字数变化与校验、降级、冲突保留等诊断） */
      extractScan?: {
        ok: boolean
        message?: string
        inputCards?: number
        outputParagraphs?: number
        inputChars?: number
        outputChars?: number
        accepted?: number
        degraded?: number
        droppedCards?: number
        omitted?: number
        passthrough?: number
        /** 因"段落只是复述来源标题"而丢弃的段落数（2026-09-12：绝不能只看文章标题） */
        titleOnlyDropped?: number
        /** 因"年份在来源里查不到、也推不出"而降级为「时间待核」的段落数 */
        timeUnsupported?: number
      }
      interrupted?: CompilationInterrupt
      /** 网页资料本轮的抓取情况（2026-09-12 第二批：达上限时如实告知，避免"以为用了几百篇"） */
      webScan?: WebFetchStats
      /**
       * 第二组 ⑤：本轮的「文章内取高信号段 ± 上下文」统计（含"闸门口径"与"本轮送入"两个数）。
       * 用户勾选「本轮不做收敛」时为 undefined；生成汇总气泡据此如实带一句。
       */
      convergence?: ArticleConvergenceStats
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
 * 记录窗口细读、整合提取与矛盾扫描到哪个环节，续跑时从该处继续。
 * 三个阶段（窗口细读 / 整合提取 / 卡片矛盾扫描）均支持中断续跑。
 */
interface CompilationResumeState {
  taskId: string
  compilationId: string
  /** 用户撰写要求**全文**（汇编标题存的就是它；也是各阶段提示词的首要依据） */
  title: string
  /** 从要求里提取出的短标题（仅用于提示词里《》里的"题目"）；缺省时退回 `title` */
  shortTitle?: string
  provider: ProviderInfo
  phase: 'window' | 'extract' | 'contradiction'
  chunks: RetrievedChunk[]
  refs: SourceRefEntry[]
  windows: RetrievedChunk[][]
  /** 已成功细读完成的窗口下标集合（失败/未读的不在其中，续跑时重读） */
  doneSet: Set<number>
  /** 各窗口的细读输出（按下标；null=该窗口无产出但已完成），合并顺序确定 */
  windowOutputsByIndex: (CompilationOutput | null)[]
  /** 整合提取：待提取候选与分批方案（卡片确定后算一次，续跑复用） */
  extractCandidates?: ExtractCandidate[]
  extractBatches?: number[][]
  /** 已累积的提取段落草稿（跨批次累积；续跑不重复已完成批次） */
  extractDrafts?: ExtractedDraft[]
  /** 已完成的提取批次下标（并行执行，故用集合而非计数；断点续跑时跳过） */
  extractDoneBatches?: Set<number>
  /** 整合提取阶段开始时间（用于整阶段时间预算） */
  extractStartedAt?: number
  /** 整合提取未跑完/降级的原因（超预算或调用失败时置位，随 purifyScan 透出） */
  extractIncomplete?: { message: string }
  /** 整合提取统计（落库前透出给前端汇总） */
  extractStats?: ExtractScanStats
  /** 整合提取后的段落（矛盾扫描与落库都用它；未跑提取时为空） */
  extractedParagraphs?: AssembledParagraph[]
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
  /** 第二组 ⑤ 的取段统计（随状态带着走，使中断/续跑时也能如实汇报"本轮送了多少"） */
  convergence?: ArticleConvergenceStats
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

/** 本地兜底：先用 extractTopicTerms 取引号/"标题为·主题为"后的核心词，再做领域下位词扩展 */
export function fallbackCoarseQuery(instruction: string): string {
  const terms = extractTopicTerms(instruction)
  const q = [...new Set([...terms, ...expandDomainHints(terms)])].filter(Boolean).join(' ')
  return q || instruction.trim()
}

/**
 * 把「撰写要求现算词表」（第一组 ③）并入粗筛查询串。
 *
 * 为什么用**追加**而不是替换：粗筛查询串是 `scoreChunk` 的字面依据，替换会改变既有排序与闸门；
 * 追加只是让"要求里出现过的说法"（如同义扩展出的 `普高/完全中学`）也参与字面命中——**只增不减**。
 * 长整句词（>12 字）不进查询串（它不可能原样出现在正文里，只会稀释 bigram）。
 */
export function buildCoarseQuery(baseQuery: string, lexicon: TopicLexiconAnalysis, maxTermChars = 12): string {
  const terms = [...lexicon.topicTerms, ...lexicon.keyPoints].filter((t) => t.length >= 2 && t.length <= maxTermChars)
  return [...new Set([baseQuery.trim(), ...terms])].filter(Boolean).join(' ')
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

export function recallCandidateChunks(scopeIds: string[], query: string, extraTerms: string[] = []): RetrievedChunk[] {
  const q = query.trim()
  if (!q || scopeIds.length === 0) return []
  const sources = getSourcesByIds(scopeIds)
  const qBigrams = bigrams(q)
  const qTerms = q.split(/\s+/).filter(Boolean)
  const out: RetrievedChunk[] = []
  for (const s of sources) {
    for (const c of chunksForSource(s)) {
      out.push({
        sourceId: s.id,
        sourceTitle: s.title,
        position: c.position,
        text: c.text,
        score: scoreChunk(q, c.text, s.title, qBigrams, qTerms),
        sourceKind: s.kind,
        sourcePublishedAt: s.publishedAt,
        charStart: c.charStart,
        charEnd: c.charEnd
      })
    }
  }
  // extraTerms 只影响分层判定（`judgeBodyRelevance`），这里保留参数是为了两处调用口径一致
  void extraTerms
  return sortChunksStable(out)
}

/**
 * 切段（**先剔结构性垃圾，再切段**；第一组 ④）。
 *
 * 为什么先剔再切：目录/版权页/导航尾部这些噪声会混进段落并参与词法打分与字数统计，
 * 剔掉它们同时改善"判定"与"喂给模型的材料"。**库里 `sources.cleaned_text` 一字不动**——
 * 剔除只发生在内存里，且 `charStart/charEnd` 用 `keptLineStarts` 基准保持在来源正文坐标系（见 `stripStructureNoise`）。
 */
export function chunksForSource(s: { kind?: string; cleanedText?: string }): ParagraphChunk[] {
  const text = s.cleanedText ?? ''
  const kind: 'file' | 'web' = s.kind === 'url' ? 'web' : 'file'
  const stripped = stripStructureNoise(text, kind)
  return chunkByParagraphsFromBase(stripped.text, stripped.keptLineStarts)
}

export interface CompilationRecallResult {
  /** 本轮**实际送细读**的候选块（默认已做 ⑤ 文章内取段；逃生门时 = 闸门结果） */
  chunks: RetrievedChunk[]
  candidateSources: number
  /**
   * 闸门后、⑤ 之前的候选块（= 用户勾选「本轮不做收敛」时的口径，也是今天的行为）。
   * 预检估算要同时报"收敛后 / 全量"两个数，靠它一次闸门跑完就都拿得到，不必把闸门跑两遍。
   */
  preConvergenceChunks: RetrievedChunk[]
  /** ⑤ 的收敛统计；`converge: false`（逃生门）时为 null */
  convergence: ArticleConvergenceStats | null
}

/** 闸门选项（第二组 ⑤ 的逃生门：`converge: false` = 本轮不做收敛，全量送入） */
export interface CompilationRecallOptions {
  /**
   * 是否做"文章内取高信号段 ± 上下文"（⑤）。**默认 true**（用户已同意默认收敛）。
   * 每次生成可由用户在预检确认框里单独选择，**不持久化**。
   */
  converge?: boolean
}

/**
 * 汇编候选的保守本地闸门（2026-08-25 优化：把交给大模型的材料从"任务范围内全部段落"收敛为"与主题相关的来源及其相关段落"）。
 * 规则：
 *  1) 来源级：仅保留"有相关信号"的来源（标题含查询词 / 任一段词法 score>0 / 任一段向量余弦 ≥ RECALL_VEC_MIN）；
 *     完全无关的来源整篇舍弃——这是大幅减少窗口数的关键（多数资料库里有大量与本次主题无关的文件）。
 *  2) 来源内：标题含任一查询词（如"学前/幼儿园/园所/幼教"），或来源总长 ≤ RECALL_DEDICATED_MAX_LEN 且来源内最高词法分 ≥ RECALL_DEDICATED_MIN_LEX → 整篇保留；
 *     宽口径来源（如综合年鉴，仅有部分段落相关）→ 只保留有信号的分块（词法 score>0 或向量 ≥ RECALL_VEC_MIN），
 *     从而删掉综合文档里与主题无关的章节。
 *  3) **闸门之后**（第二组 ⑤）：对放行的来源逐篇"文章内取高信号段 ± 上下文"，只把有信号的段（及其紧邻上下文）
 *     送本轮细读；`options.converge === false` 时跳过这一步（= 今天的行为）。
 * 保证：相关来源不会被整篇丢弃；宽口径来源里"字面无关但语义相关"的段落由低阈值向量路径兜底（不会因无词法命中被误删）。
 */
export function recallCompilationCandidates(
  scopeIds: string[],
  query: string,
  queryVector?: number[],
  extraTerms: string[] = [],
  options: CompilationRecallOptions = {}
): CompilationRecallResult {
  const q = query.trim()
  if (!q || scopeIds.length === 0) {
    return { chunks: [], candidateSources: 0, preConvergenceChunks: [], convergence: null }
  }
  const sources = getSourcesByIds(scopeIds)
  const qBigrams = bigrams(q)
  const qTerms = q.split(/\s+/).filter(Boolean)

  /*
   * Phase 10 P5b-2：**网页来源在生成期也按同一套分层口径判定**（`judgeBodyRelevance`，只看正文、不看标题）。
   * 抓取期已经把跑题正文丢弃了，这里再判一次是为了兜住两类情况：
   * ① 老任务（用旧的"标题取前 N"路径抓的 600 篇里 84% 是噪声）；② 抓取期与生成期的要求文本不一样时。
   * **本地文件来源不受此限**（年鉴/文档仍走原有闸门口径），避免改变既有的本地检索行为。
   */
  const urlRelevant = new Map<string, boolean>()
  for (const s of sources) {
    if (s.kind !== 'url') continue
    // 第一组 ①②③：判定用"剔掉结构噪声后的正文" + 撰写要求现算词表（extraTerms，只升不降地并入分层）
    const strippedBody = stripStructureNoise(s.cleanedText ?? '', 'web').text
    urlRelevant.set(s.id, judgeBodyRelevance(strippedBody, q, s.title ?? '', extraTerms).relevant)
  }
  const usableSources = sources.filter((s) => s.kind !== 'url' || urlRelevant.get(s.id) === true)
  const droppedUrlSources = sources.length - usableSources.length

  // 向量命中（position 级）：queryVector 缺省或无向量索引时为空
  const vecHitBySource = new Map<string, Set<string>>()
  if (queryVector && queryVector.length > 0) {
    for (const h of vectorSearch(queryVector, usableSources.map((s) => s.id), 0)) {
      if (h.score < RECALL_VEC_MIN) continue
      if (!vecHitBySource.has(h.sourceId)) vecHitBySource.set(h.sourceId, new Set())
      vecHitBySource.get(h.sourceId)!.add(h.position)
    }
  }

  const relevantSources = new Set<string>()
  const dedicatedSources = new Set<string>()
  const indexed: IndexedSegment[] = []
  const maxScoreBySource = new Map<string, number>()
  const totalLenBySource = new Map<string, number>()
  // 段级相关（Phase A/B：整段为一个保留/剔除单元——段内任一子块有信号 → 整段所有子块一起保留）
  const paragraphRelevant = new Set<string>() // key = sourceId|第N段

  for (const s of usableSources) {
    const chunks = chunksForSource(s)
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
      indexed.push({ sourceId: s.id, sourceTitle: s.title, position: c.position, text: c.text, score, vecHit, inlineRelevant, paragraphKey, sourceKind: s.kind, sourcePublishedAt: s.publishedAt, charStart: c.charStart, charEnd: c.charEnd })
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

  const gatedOut: RetrievedChunk[] = []
  for (const it of indexed) {
    if (!relevantSources.has(it.sourceId)) continue
    // 整段级判定：专属来源整篇保留，否则仅保留“所在段”有任一子块信号的全部子块
    if (dedicatedSources.has(it.sourceId) || paragraphRelevant.has(it.sourceId + '|' + it.paragraphKey)) {
      gatedOut.push(toRetrievedChunk(it))
    }
  }
  if (droppedUrlSources > 0) {
    logMain(
      'compilation',
      `生成期正文相关性：${droppedUrlSources} 个网页来源未通过分层口径（只看正文），已排除在候选之外（本地文件来源不受此限）`
    )
  }
  /*
   * 第二组 ⑤：**闸门之后**再做一次"文章内取段"（有信号段 ± 上下文），再进入 `sliceChunks` 切窗。
   * 逃生门（用户勾选「本轮不做收敛」）时 `converge: false` → 直接返回闸门结果，行为与今天完全一致。
   */
  const gatedChunks = sortChunksStable(gatedOut)
  if (options.converge === false) {
    return { chunks: gatedChunks, candidateSources: relevantSources.size, preConvergenceChunks: gatedChunks, convergence: null }
  }
  const converged = convergeArticleChunks(
    indexed,
    relevantSources,
    (it) => dedicatedSources.has(it.sourceId) || paragraphRelevant.has(it.sourceId + '|' + it.paragraphKey),
    q,
    extraTerms
  )
  logMain(
    'compilation',
    `文章内取段（⑤，上下文 ±${ARTICLE_CONTEXT_RANGE} 段）：${converged.stats.sources} 个来源逐段判定后，` +
      `本轮送 ${converged.stats.keptSegments} 段 / ${converged.stats.keptChars} 字（来自 ${converged.stats.sources - converged.stats.noSignalSources} 篇）；` +
      `另有 ${converged.stats.droppedSegments} 段因无信号未送（仍在库中，可打开查看；整篇无信号来源 ${converged.stats.noSignalSources} 篇）`
  )
  return { chunks: converged.chunks, candidateSources: relevantSources.size, preConvergenceChunks: gatedChunks, convergence: converged.stats }
}

/** 闸门阶段的"一段"（内部账目；`RetrievedChunk` 是它的对外投影） */
interface IndexedSegment {
  sourceId: string
  sourceTitle: string
  position: string
  text: string
  score: number
  vecHit: boolean
  inlineRelevant: boolean
  paragraphKey: string
  sourceKind?: 'file' | 'url'
  sourcePublishedAt?: string
  charStart: number
  charEnd: number
}

function toRetrievedChunk(it: IndexedSegment): RetrievedChunk {
  return {
    sourceId: it.sourceId,
    sourceTitle: it.sourceTitle,
    position: it.position,
    text: it.text,
    score: it.score,
    sourceKind: it.sourceKind,
    sourcePublishedAt: it.sourcePublishedAt,
    charStart: it.charStart,
    charEnd: it.charEnd
  }
}

/**
 * ⑤ 的落地：把闸门放行的**来源**逐篇取段（有信号段 ± 上下文），返回真正进本轮细读的候选块。
 *
 * 关键取舍与理由：
 * 1. **输入是"该来源正文的全部切段"**（不是闸门逐段筛过的那批）——因为"紧邻上下文"必须按正文的段序取，
 *    而闸门按 `score>0` 逐段筛过之后段序会出现空洞，±1 上下文就会取错段。且"有信号就留"要求以**信号**
 *    为准，而不是以闸门那套词法分阈值为准（两者在"专指词不在撰写要求里"这类 corner 上并不一致）。
 * 2. **只处理闸门放行的来源**（`relevantSources`）：来源级判据仍是闸门说了算，⑤ 只决定"来源里哪些段"。
 * 3. **坐标一律沿用切段结果**（`chunksForSource` 已用 `keptLineStarts` 把 `charStart/charEnd` 锚在
 *    来源正文坐标系），本函数只做"留 / 不留"，不重算任何偏移 → 来源定位不会错位。
 * 4. 逐篇算完即弃（只留档位与保留标记），不做跨篇缓存：材料量级是几千到几万段，内存与 CPU 都可控。
 */
function convergeArticleChunks(
  indexed: IndexedSegment[],
  relevantSources: Set<string>,
  isGated: (it: IndexedSegment) => boolean,
  query: string,
  extraTerms: string[]
): { chunks: RetrievedChunk[]; stats: ArticleConvergenceStats } {
  const bySource = new Map<string, IndexedSegment[]>()
  for (const it of indexed) {
    if (!relevantSources.has(it.sourceId)) continue
    const list = bySource.get(it.sourceId)
    if (list) list.push(it)
    else bySource.set(it.sourceId, [it])
  }
  const out: RetrievedChunk[] = []
  let gatedSegments = 0
  let gatedChars = 0
  let articleSegments = 0
  let articleChars = 0
  let keptSegments = 0
  let keptChars = 0
  let noSignalSources = 0
  let reIncludedSegments = 0
  for (const segs of bySource.values()) {
    const plan = planArticleSegments(
      segs.map((s) => s.text),
      query,
      segs[0]?.sourceTitle ?? '',
      extraTerms
    )
    articleSegments += segs.length
    let anyKept = false
    for (let i = 0; i < segs.length; i++) {
      const it = segs[i]
      articleChars += it.text.length
      // "闸门口径"= 今天（不做收敛）会送细读的那些段：专属来源整篇 + 段级有信号的段（与 `gatedOut` 同一判据）
      const gated = isGated(it)
      if (gated) {
        gatedSegments += 1
        gatedChars += it.text.length
      }
      if (!plan.kept[i]) continue
      anyKept = true
      keptSegments += 1
      keptChars += it.text.length
      // 闸门本来丢掉的段被 ⑤ 按"有信号 / 上下文"重新纳入 → 单独计数，便于事后审计口径差异
      if (!gated) reIncludedSegments += 1
      out.push(toRetrievedChunk(it))
    }
    if (segs.length > 0 && !anyKept) noSignalSources += 1
  }
  return {
    chunks: sortChunksStable(out),
    stats: {
      contextRange: ARTICLE_CONTEXT_RANGE,
      gatedSegments,
      gatedChars,
      sources: bySource.size,
      articleSegments,
      articleChars,
      keptSegments,
      keptChars,
      droppedSegments: articleSegments - keptSegments,
      droppedChars: articleChars - keptChars,
      noSignalSources,
      reIncludedSegments
    }
  }
}

export interface SourceRefEntry {
  index: number
  sourceId: string
  title: string
  /** 来源类型与发布时间：段首时间兜底要区分「年鉴惯例」与「网页发布时间」两种依据 */
  kind?: 'file' | 'url'
  publishedAt?: string
}

export function buildCompilationSourceRefs(chunks: RetrievedChunk[]): SourceRefEntry[] {
  const seen = new Set<string>()
  const list: SourceRefEntry[] = []
  for (const c of chunks) {
    if (!seen.has(c.sourceId)) {
      seen.add(c.sourceId)
      list.push({ index: list.length + 1, sourceId: c.sourceId, title: c.sourceTitle, kind: c.sourceKind, publishedAt: c.sourcePublishedAt })
    }
  }
  return list
}

/**
 * 文件清单的一行：`3. 《标题》（网页，发布时间 2021-05-06）`。
 *
 * 2026-10-05 用户裁定（P0-1）：**来源类型与发布时间必须作为证据进入提示词**。
 * 细读阶段此前只给「编号 + 《标题》」，模型看不到"这是网页、发布于某日"，于是正文写「近日」时它无处可依，
 * 只能凭标题年份硬推（并因此套上年鉴 −1 惯例，实测出整片错年）。
 * 页面没有发布时间就**如实不写**，绝不拿别的字段顶上。
 */
function refText(refs: SourceRefEntry[]): string {
  return refs
    .map((r) => {
      const meta = r.kind === 'url' ? '（网页' + (r.publishedAt ? '，发布时间 ' + formatSourceDate(r.publishedAt) : '') + '）' : ''
      return r.index + '. 《' + r.title + '》' + meta
    })
    .join('\n')
}

/** 窗口细读的系统提示词（导出供单测断言"用户要求全文必须完整入提示词"） */
export function buildSystemPrompt(instruction: string): string {
  return [
    '你是一名地方志资料整理专家。你将收到一批【候选材料】与【文件清单】，材料来自用户本地资料库，不能引入任何外部知识。',
    '你的任务是**筛选**：逐块阅读候选材料，挑出与撰写主题可能相关的条目，交给后续环节加工成志书素材。',
    '',
    /*
     * 2026-10-03（用户裁定）：用户那条撰写要求**原文**就是筛选的首要依据，必须完整给出，
     * 且其中的范围限定（地域/层级/时间跨度/对象）与「不必纳入」的排除项都是硬判据——
     * 实测只把要求当"主题名"用是挡不住省级/国家层面综述的（38 个来源里 9 个省级/国家层面全部进了汇编）。
     */
    '【用户的撰写要求（原文，必须逐条遵守，是本次筛选的首要依据）】',
    instruction,
    '',
    '【筛选口径】**这里只做筛选，不做裁剪**：只要某条材料可能含有与主题相关的内容（哪怕整段里只有一两句相关），就把它整段输出；',
    '真正的裁剪、合并、补全交给下一步的「整合提取」环节，由它把相关句段整理成可直接写进志稿的段落。',
    '因此：不在用户要求所限定范围内的条目，**直接跳过**——包括**地域/层级**（如要求只写某区，则全省、全国层面的政策解读、工作部署、其它市县的同类做法与统计数据）、**时间跨度**、**对象范围**不符的内容，以及要求里点明「不必纳入」的内容；',
    '只有明确与主题无关（例如讲的是其它行业、其它部门、其它工作）或纯属排版噪声时才跳过。**在范围之内**拿不准是否相关时，一律保留（宁多勿漏）。',
    '',
    '每条候选材料是一个【完整条目/整段】。相关时请把【该条目的完整原文】作为一张卡片输出，不要按时间/事实再做更细切分；',
    '也不要在这里删减条目中的无关内容（那是下一步的事）。若多条候选材料是同一句子的延续，请合并成一张卡片后输出。',
    '',
    '对每个相关条目，输出一张卡片：',
    '1. excerpt 必须是该条目的【整段原文】（不得改写/补写/概括、不得从句子中间截断）；',
    '2. ts 为时间标签（如「2005 年」「2005—2010 年」），只写原文中能确定的时间，没有就填 null；',
    '3. sourceRef 用文件编号（如 #1）；',
    '4. 同一事实不同来源相左时，输出到 contradictions（仅实质性冲突：数据/时间/地点/主体/结果不同；措辞差异不算）。',
    '',
    '若遇到页码、页眉/页脚、目录点线、索引行等排版噪声，直接跳过，不要输出卡片。',
    '',
    '输出要求：只输出一个 JSON 对象，不得输出 JSON 之外的任何文字、解释或代码块围栏。',
    '正常输出：{"items":[{"sourceRef":"#1","excerpt":"原文摘录","ts":"2005 年"}],"contradictions":[{"topic":"事实主题","kind":"data|time|place|fact|other","variants":[{"excerpt":"说法一原文","sourceRefs":["#1","#2"]}]}]}',
    '无矛盾输出：{"items":[...],"contradictions":[]}'
  ].join('\n')
}

/** 窗口细读的用户提示词（导出供单测断言"用户要求全文必须完整入提示词"） */
export function buildUserPrompt(chunks: RetrievedChunk[], refs: SourceRefEntry[], instruction: string): string {
  const bySource = new Map(refs.map((r) => [r.sourceId, r]))
  const materials = chunks
    .map((c, i) => {
      const ref = bySource.get(c.sourceId)?.index ?? 0
      return (
        '[' +
        (i + 1) +
        ']（来源编号: #' +
        ref +
        '，标题：《' +
        c.sourceTitle +
        '》' +
        // 逐条材料也带上来源类型/发布时间：模型是**整段照抄**成卡片的，
        // 卡片一旦离开这一行，交付给下一步的就只剩「编号 + 标题」（2026-10-05 用户裁定）
        (c.sourceKind === 'url' ? '，网页' + (c.sourcePublishedAt ? ' 发布时间 ' + formatSourceDate(c.sourcePublishedAt) : '') : '') +
        '）\n' +
        c.text
      )
    })
    .join('\n\n')
  return [
    '【文件清单】',
    refText(refs),
    '',
    '【用户的撰写要求（原文，必须逐条遵守）】',
    instruction,
    '',
    '【候选材料】',
    materials,
    '',
    '请按上述 JSON 格式输出：**在用户要求所限定的范围之内**，可能相关的条目一律整段保留（宁多勿漏，不要在这里裁剪）；',
    '范围之外的内容（地域/层级/时间跨度/对象不符、或要求里点明「不必纳入」的）直接跳过，另跳过页码/目录/索引等排版噪声。'
  ].join('\n')
}

export interface CompilationOutputItem {
  sourceRef: string
  position: string
  excerpt: string
  ts: string | null
  /**
   * 这张卡片在**来源正文**里的字符区间（左闭右开；2026-10-05 用户裁定 P0-2）。
   *
   * 细读输出的卡片是"整段照抄候选材料"，所以读窗口时就能把它对回**候选块**并在切块时算好的区间上取偏移，
   * 于是"卡片 → 段落 → 锚点"全程携带字符区间，落锚点时只做区间比较（不再拿文字去来源里回溯匹配）。
   * 对不上任何候选块时**如实缺省**，由落锚点的 fallback 处理。
   */
  charStart?: number
  charEnd?: number
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

/**
 * 把细读输出的一张卡片对回**候选块**，并把区间算成"来源正文里的绝对字符区间"（2026-10-05 P0-2）。
 *
 * 提示词要求模型**整段照抄**候选材料，所以这里先用逐字匹配（容忍空白差异）找出卡片落在哪个候选块里；
 * 命中就用"块起点 + 块内偏移"得到绝对区间——块的区间是**切块时**算好的，这一层不重新扫正文。
 * 三种情形如实降级（都不猜）：
 *  - 卡片与某个块的文字仅差空白 → 用该块的区间（最常见的形态：PDF 排版空白）；
 *  - 卡片跨了连续多个块（模型把相邻条目并成一张）→ 取这几块的**并集**；
 *  - 完全对不上任何块（模型改写了文字）→ **不给区间**，落锚点时走逐字 fallback。
 */
export function locateCardRange(
  excerpt: string,
  windowChunks: RetrievedChunk[]
): { charStart: number; charEnd: number } | undefined {
  const needle = (excerpt ?? '').trim()
  if (!needle) return undefined
  const exact: { charStart: number; charEnd: number }[] = []
  for (const c of windowChunks) {
    if (c.charStart == null || c.charEnd == null) continue
    const at = c.text.indexOf(needle)
    if (at >= 0) {
      exact.push({ charStart: c.charStart + at, charEnd: c.charStart + at + needle.length })
      continue
    }
    // 卡片包含整块（合并相邻条目）→ 先记下这块，下面按"被包含的块"处理
    if (needle.includes(c.text)) exact.push({ charStart: c.charStart, charEnd: c.charEnd })
  }
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    return {
      charStart: Math.min(...exact.map((r) => r.charStart)),
      charEnd: Math.max(...exact.map((r) => r.charEnd))
    }
  }
  // 退一步：容忍空白差异（`locateVerbatim` 与卡片校验同一套口径）
  for (const c of windowChunks) {
    if (c.charStart == null || c.charEnd == null) continue
    const r = locateVerbatim(c.text, needle)
    if (r) return { charStart: c.charStart + r.start, charEnd: c.charStart + r.end }
  }
  return undefined
}

/** 给一批细读卡片补齐生成期字符区间（原地写回；读窗口成功后调用一次） */
export function attachCardRanges(out: CompilationOutput | null, windowChunks: RetrievedChunk[]): void {
  if (!out) return
  for (const it of out.items) {
    if (it.charStart != null) continue
    const range = locateCardRange(it.excerpt, windowChunks)
    if (range) {
      it.charStart = range.charStart
      it.charEnd = range.charEnd
    }
  }
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
    /*
     * 2026-09-12（第三批 D）：真实数据里 5+ 组"矛盾"多数是**同一件事在不同阶段/口径下的正常差异**——
     * 规划班级数 vs 建成班级数、在建 vs 投用时间、预计投资 vs 实际投资、累计 vs 当年。
     * 这类差异是志书要如实分阶段记述的内容，不是需要用户裁定的冲突；在这里把它们排除，
     * 用户的裁定负担才落在真正的冲突上。
     */
    '**以下情形不算矛盾，不要归组**：',
    '① 同一事实在不同时点/阶段的表述（规划 vs 建成、在建 vs 投用、预计 vs 实际、一期 vs 二期、初稿 vs 定稿）；',
    '② 统计口径不同的并存数据（累计 vs 当年、全口径 vs 某一类别、含/不含某部分）；',
    '③ 仅措辞、详略、单位换算或四舍五入不同的表述；',
    '④ 一条比另一条信息更全，且更全的那条与另一条并不冲突。',
    '只有当**同一时点、同一口径**下，数据/时间/地点/主体/结果明确不同，才算矛盾（例：同一年的新增园所数两个来源给出不同数字）。',
    '判断时请利用每条卡片给出的「时间」字段：时间不同的两条通常属于情形 ①。',
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

/**
 * ⑤ 收敛的日志（**如实汇报**，用户明确要求）：本轮送多少段/字、来自多少篇、
 * 另有段因无信号未送（并说明材料仍在库中）。
 */
function logConvergence(stats: ArticleConvergenceStats, skipped: boolean): void {
  if (skipped) {
    logMain('compilation', '本轮不做收敛（用户勾选「本轮不做收敛（全量送入）」）：跳过文章内取段，闸门结果全部送入细读')
    return
  }
  logMain(
    'compilation',
    `文章内取段（⑤，上下文 ±${stats.contextRange} 段）：${stats.sources} 个来源逐段判定后，` +
      `本轮送 ${stats.keptSegments} 段 / ${stats.keptChars} 字（来自 ${stats.sources - stats.noSignalSources} 篇）；` +
      `另有 ${stats.droppedSegments} 段因无信号未送（仍在库中，可打开查看；整篇无信号来源 ${stats.noSignalSources} 篇）`
  )
  if (stats.reIncludedSegments > 0) {
    // 闸门按词法分筛过之后，⑤ 会按"信号 + 上下文"把其中少量段重新纳入——如实说清，便于事后审计口径差异
    logMain('compilation', `其中 ${stats.reIncludedSegments} 段是 ⑤ 按"有信号 / 紧邻上下文"从闸门之外重新纳入的（不设上限，有信号就留）`)
  }
}

/** 生成前「材料规模预检」的结果（只读估算：段数 / 字数 / 本地与网页段数 / 细读窗口数 / 预计分钟数） */
export interface MaterialEstimate {
  segments: number
  chars: number
  localSegments: number
  webSegments: number
  estimatedWindows: number
  estimatedMinutes: number
}

/**
 * 预检的**完整**口径（第二组 ⑤，2026-10-06）：主字段（`segments/chars/estimatedWindows/estimatedMinutes`）
 * 一律是「**收敛后**」的规模（否则确认框会虚高，用户正是为此提的 P1），同时再带一套「**全量**（不做收敛）」
 * 的数与"因无信号未送"的量——界面据此把两个数都摆出来，并让复选框切换时口径不打架。
 */
export interface MaterialEstimateWithConvergence extends MaterialEstimate {
  /** 不做收敛（= 用户勾选「本轮不做收敛」/ 今天的行为）时的段数 / 字数 / 窗口数 / 预计分钟 */
  fullSegments: number
  fullChars: number
  fullEstimatedWindows: number
  fullEstimatedMinutes: number
  /** 本轮因无信号未送（仍在库中、仍可打开）的段数 / 字数 */
  droppedSegments: number
  droppedChars: number
  /** 参与取段的来源数 / 其中整篇无信号（整篇不送）的来源数 */
  convergedSources: number
  noSignalSources: number
  /** 是否真的做了收敛（闸门一个都没留下、退回宽召回时为 false） */
  converged: boolean
  /** 上下文半径（段） */
  contextRange: number
  /** ⑤ 从闸门已丢弃的段里按信号/上下文重新纳入的段数 */
  reIncludedSegments: number
}

/**
 * 由候选材料算出规模（纯函数，供 IPC 与单测复用）。
 * 窗口数与耗时**复用生成管线的常量**（`WINDOW_MAX_CHARS` / `WINDOW_ETA_DEFAULT_S`），不另造一套口径。
 */
export function summarizeMaterialScale(chunks: RetrievedChunk[], webSourceIds: Iterable<string>): MaterialEstimate {
  const webIdSet = new Set(webSourceIds)
  const chars = chunks.reduce((n, c) => n + (c.text?.length ?? 0), 0)
  const webSegments = chunks.filter((c) => webIdSet.has(c.sourceId)).length
  const estimatedWindows = Math.max(1, Math.ceil(chars / Math.max(1, WINDOW_MAX_CHARS)))
  return {
    segments: chunks.length,
    chars,
    localSegments: chunks.length - webSegments,
    webSegments,
    estimatedWindows,
    estimatedMinutes: Math.max(1, Math.round((estimatedWindows * WINDOW_ETA_DEFAULT_S) / 60))
  }
}

/** 把「收敛后 / 全量」两次规模合成预检结果（纯函数，便于单测） */
export function buildMaterialEstimate(
  convergedChunks: RetrievedChunk[],
  fullChunks: RetrievedChunk[],
  webSourceIds: Iterable<string>,
  convergence: ArticleConvergenceStats | null
): MaterialEstimateWithConvergence {
  const after = summarizeMaterialScale(convergedChunks, webSourceIds)
  const full = summarizeMaterialScale(fullChunks, webSourceIds)
  return {
    ...after,
    fullSegments: full.segments,
    fullChars: full.chars,
    fullEstimatedWindows: full.estimatedWindows,
    fullEstimatedMinutes: full.estimatedMinutes,
    droppedSegments: convergence?.droppedSegments ?? 0,
    droppedChars: convergence?.droppedChars ?? 0,
    convergedSources: convergence?.sources ?? 0,
    noSignalSources: convergence?.noSignalSources ?? 0,
    converged: convergence !== null,
    contextRange: convergence?.contextRange ?? ARTICLE_CONTEXT_RANGE,
    reIncludedSegments: convergence?.reIncludedSegments ?? 0
  }
}

/**
 * 生成前的**材料规模预检**（2026-10-05 用户要求，P1）。
 * 动机（用户实测）：材料规模只有在主进程跑完「召回 + 闸门」之后才知道，上次**跑到一半**才发现要 20 多分钟；
 * 因此界面在真正开始生成之前弹一次确认，把「多少段 / 多少字 / 几个细读窗口 / 约多少分钟」如实告诉用户。
 *
 * 口径与 `generateCompilation` **完全一致**（同一个 `recallCandidateChunks` + `recallCompilationCandidates`、
 * 同一套「本地段 / 网页段」区分），但**只读**：
 *  - 不落库（不建汇编、不写段落、不写版本、不碰 `resumeStore`）；
 *  - 不抓网页（只算本任务**已纳入**的网页来源；生成时会先按年份区间抓取重筛，那部分量这里算不出来）；
 *  - **不调用任何大模型**——生成管线里那次"大模型提取关键词"刻意跳过，只用本地兜底或已缓存的关键词；
 *  - 仅用**本地**嵌入模型算查询向量（`allowRemoteModels=false`，不联网），失败即退回纯词法口径（与生成管线的降级一致）。
 */
export async function estimateCompilationMaterials(taskId: string, instruction: string): Promise<MaterialEstimateWithConvergence | null> {
  const task = getTaskById(taskId)
  if (!task) return null
  const t = instruction.trim()
  if (!t) return null

  const scopeIds = resolveScopeSourceIds(task, { getSourceIdsByTag, getAllSourceIds })
  // 本任务已纳入的网页来源（生成时会先抓一轮，那部分不计入只读估算）
  const webIds = listUrlSourceIdsByTask(taskId)
  const allScopeIds = Array.from(new Set([...scopeIds, ...webIds]))
  if (allScopeIds.length === 0) return buildMaterialEstimate([], [], [], null)

  // 粗筛关键词：与生成管线同口径（见 generateCompilation），但只用本地兜底 / 已缓存结果
  const cached = keywordExtractionCache.get(t) ?? null
  const baseQuery = cached
    ? [...new Set([cached.title, ...cached.keywords])].filter(Boolean).join(' ') || fallbackCoarseQuery(t)
    : fallbackCoarseQuery(t)
  // 第一组 ③：**只读估算绝不调用大模型**，词表用纯本地解析（零成本、确定性）
  const lexicon = analyzeWritingRequirementLocal(t)
  const coarseQuery = buildCoarseQuery(baseQuery, lexicon)
  const extraTerms = lexiconExtraTerms(lexicon)
  const vecQuery = cached?.title || coarseQuery

  const allChunks = recallCandidateChunks(allScopeIds, coarseQuery, extraTerms)
  const vectors = await embedTexts([vecQuery]).catch(() => null)
  const gated = recallCompilationCandidates(allScopeIds, coarseQuery, vectors ? vectors[0] : undefined, extraTerms)
  /*
   * 与生成管线一致：闸门一个都没留下时退回宽召回（否则会把规模低估成「0 段」）。
   * 退回宽召回时 ⑤ 也没有生效（`gated.chunks` 为空 → `convergence.converged=false`），
   * 于是"收敛后 / 全量"两个数会相同——这是**如实**的（那一轮确实没有收敛）。
   */
  const convergedChunks = gated.chunks.length > 0 ? gated.chunks : allChunks
  const fullChunks = gated.preConvergenceChunks.length > 0 ? gated.preConvergenceChunks : allChunks
  const convergence = gated.chunks.length > 0 ? gated.convergence : null
  return buildMaterialEstimate(convergedChunks, fullChunks, webIds, convergence)
}

/**
 * 生成选项（第二组 ⑤）：`skipConvergence = true` = 用户在本轮预检确认框里勾了「本轮不做收敛（全量送入）」，
 * 跳过"文章内取段"，行为回到今天。**每次生成单独选择、不持久化**。
 */
export interface GenerateCompilationOptions {
  skipConvergence?: boolean
}

export async function generateCompilation(
  taskId: string,
  title: string,
  onProgress?: (p: CompilationProgress) => void,
  onAdvice?: (message: string) => void,
  options: GenerateCompilationOptions = {}
): Promise<GenerateCompilationResult> {
  const task = getTaskById(taskId)
  if (!task) return fail(ErrorCodes.TASK_NOT_FOUND, '撰写任务不存在')
  const t = title.trim()
  if (!t) return fail(ErrorCodes.INVALID_PARAM, '请填写本次撰写的标题')

  const prov = resolveProvider()
  // A+C：预计剩余时间——窗口细读用实测均速（EMA）外推；窗口块未算出前用占位预算，让前置阶段预估不至于明显失真
  let windowsBudgetSec = WINDOWS_PRIOR_PLACEHOLDER_S
  const preWindowEta = (remainingSinglePhaseSec: number): number =>
    remainingSinglePhaseSec + windowsBudgetSec + PHASE_EXTRACT_ETA_S + PHASE_CONTRADICTION_ETA_S

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
  /*
   * 第一组 ③（2026-10-05）：撰写要求**现算词表 + 同义扩展**。
   * 一次很便宜的调用（几百 token、输出限 400 token、同一要求按 hash 只算一次）；
   * 无 Provider / 调用失败自动降级为本地词表，**绝不阻断生成**（见 topic-lexicon.ts）。
   */
  const lexicon = await analyzeWritingRequirement(t, { useLlm: prov.ok, taskId })
  const extraTerms = lexiconExtraTerms(lexicon)
  const baseQuery = extracted
    ? [...new Set([extracted.title, ...extracted.keywords])].filter(Boolean).join(' ') || fallbackCoarseQuery(t)
    : fallbackCoarseQuery(t)
  coarseQuery = buildCoarseQuery(baseQuery, lexicon)
  vecQuery = extracted?.title || coarseQuery
  if (extracted) {
    onProgress?.({ stage: '已提取标题：' + extracted.title + '；提取粗筛关键词 ' + extracted.keywords.length + ' 个', percent: 7, etaSeconds: preWindowEta(PHASE_WEB_ETA_S + PHASE_RECALL_ETA_S + PHASE_GATE_ETA_S) })
    // 首次由大模型提取出标题后，自动把任务标题从默认值改为该标题（用户仍可后续重命名）
    if (task.title === '新建任务' && extracted.title) {
      try { renameTask(taskId, extracted.title) } catch { /* 重命名不影响汇编生成 */ }
    }
  }
  onProgress?.({
    stage: `已理解撰写任务（词表：主题词 ${lexicon.topicTerms.length} / 要点词 ${lexicon.keyPoints.length} / 范围词 ${lexicon.scopeWords.length}${lexicon.source === 'llm' ? '，含大模型同义扩展' : '，本地词表'}）`,
    percent: 7
  })

  /*
   * 无 Provider → **跳过网页抓取**，直接用本地闸门收窄后的材料做降级汇编。
   * 此前是先抓网页、再把"宽召回的全部段落"（未过闸门）灌进汇编：477 篇网页 × 几千字会把降级产物撑到不可用，
   * 而且明知不会调用大模型还白等近 10 分钟抓取（2026-09-12 第二批）。
   * 注意查询向量由**本地嵌入模型**生成，与是否配置 LLM Provider 无关。
   */
  const webStats: WebFetchStats = { sites: 0, siteErrors: 0, hits: 0, fetched: 0, chars: 0 }
  if (!prov.ok) {
    logMain('compilation', '未配置大模型：跳过网页资料抓取，改用本地闸门材料生成降级汇编')
  } else {
    /*
     * Phase 10 P5（用户裁定 2026-10-04）：**年份区间 + 正文筛选**取代旧的"标题粗筛取前 300 篇"。
     * 口径：任务自己的年份区间（新建任务继承全局默认）→ **先刷新站点文章清单** → 按发布时间抓取区间内**全部**文章 →
     * **只看正文**粗筛（命中落成本任务来源，未命中只留哈希）→ 并入检索范围。
     * 账本是**任务级**的（`task_web_fetch`）：新建任务/新主题**默认重新抓取并重跑筛选**，用户零操作。
     * 没有年份区间时**不再回退标题路径**（该路径已删除），如实告知并只用本地资料。
     */
    const yearFrom = task.webYearFrom ?? getSettings().webYearFrom
    const yearTo = task.webYearTo ?? getSettings().webYearTo
    if (yearFrom && yearTo) {
      /*
       * Phase 10 P6 补齐：**抓取前先同步站点文章清单**（P5 的流水线只读库里的清单，漏了这一步——
       * 站点新发的文章永远不会被发现）。逐站 `syncSite`（sitemap/RSS/BFS 发现 + 增量写入 + 日期阶梯），
       * 单站失败只记日志、不阻断（其余站点照常）。
       */
      const sites = listWebSites()
      let syncedNew = 0
      for (const site of sites) {
        try {
          const added = await syncSite(site.id)
          syncedNew += added
        } catch (err) {
          webStats.siteErrors++
          logMain('compilation', `站点清单同步失败（继续）site=${site.rootUrl}：${String(err)}`)
        }
      }
      if (sites.length > 0) {
        logMain('compilation', `网页资料清单已刷新：${sites.length} 个站点，新增文章 ${syncedNew} 篇（区间 ${yearFrom}-${yearTo}）`)
      }
      const crawl = await crawlAndScreenArticles({
        fromYear: yearFrom,
        toYear: yearTo,
        query: coarseQuery,
        extraTerms,
        taskId,
        onProgress: (p) => {
          // 把抓取进度如实映射到生成进度（含实测速度、剩余时长、是否有缓存复用与降档）
          const etaText = p.etaSeconds > 0 ? `，剩余约 ${Math.max(1, Math.round(p.etaSeconds / 60))} 分钟` : ''
          const cacheText = p.cacheHits && p.cacheHits > 0 ? `、缓存复用 ${p.cacheHits} 篇（未联网）` : ''
          onProgress?.({
            stage:
              `正在抓取网页资料（${p.done}/${p.total} 篇：采用 ${p.hits}、筛除 ${p.dropped}` +
              (p.failed > 0 ? `、失败 ${p.failed}` : '') +
              `${cacheText}${etaText}）…` +
              (p.paused ? '　⏸ 已暂停' : ''),
            percent: 8,
            etaSeconds: p.etaSeconds,
            candidateSources: p.hits,
            fetch: { active: true, paused: p.paused === true }
          })
        }
      }).catch((err) => {
        logMain('compilation', `网页抓取失败（不阻断生成）：${String(err)}`)
        return null
      })
      // 抓取结束：清掉"抓取进行中"标记 → 界面上的「暂停抓取」按钮随之消失
      onProgress?.({ stage: '正在整理网页资料…', percent: 8, fetch: { active: false, paused: false } })
      // 该任务已采用的网页来源（含本次新抓的与之前抓的）并入检索范围
      const urlSourceIds = listUrlSourceIdsByTask(taskId)
      if (urlSourceIds.length > 0) scopeIds = Array.from(new Set([...scopeIds, ...urlSourceIds]))
      webStats.sites = crawl?.sites ?? 0
      webStats.fetched = crawl?.hits ?? 0
      webStats.chars = crawl?.chars ?? 0
      // 2026-10-05（P0 兜底回归）：三类"有效正文"判定与"相关性未命中"分开计数 —— 语义不同，文案也不同
      webStats.relevanceDropped = crawl?.dropped ?? 0
      webStats.invalidBody = crawl?.invalidBody ?? 0
      webStats.shortBody = crawl?.shortBody ?? 0
      webStats.templateRepeat = crawl?.templateRepeat ?? 0
      webStats.fetchFailed = crawl?.failed ?? 0
      webStats.blocked = crawl?.blocked ?? 0
      // 2026-10-05：缓存复用篇数与自适应降档次数（如实汇报"为什么这次这么快/为什么变慢了"）
      webStats.cacheHits = crawl?.cacheHits ?? 0
      webStats.downgrades = crawl?.downgrades ?? 0
      webStats.hits = (crawl?.hits ?? 0) + (crawl?.dropped ?? 0)
      logMain(
        'compilation',
        `网页资料（年份 ${yearFrom}-${yearTo}）：本次抓取 ${crawl?.done ?? 0}/${crawl?.total ?? 0} 篇，` +
          `采用 ${crawl?.hits ?? 0}、相关性未命中丢弃 ${crawl?.dropped ?? 0}、失败 ${crawl?.failed ?? 0}；` +
          `有效正文判定：标题探针不过 ${crawl?.invalidBody ?? 0}、空标题过短 ${crawl?.shortBody ?? 0}、同站重复 ${crawl?.templateRepeat ?? 0}；` +
          `安全过滤跳过 ${crawl?.blocked ?? 0} 篇；本任务网页来源合计 ${urlSourceIds.length} 篇`
      )
      if (urlSourceIds.length > 0) {
        // 网页文章必须先有向量索引，否则"字面无关但语义相关"的段落会被闸门整篇丢掉
        onProgress?.({ stage: '正在为网页资料建立检索索引…', percent: 9, etaSeconds: preWindowEta(PHASE_GATE_ETA_S) })
        const idx = await ensureSourcesIndexed(urlSourceIds).catch(() => ({ indexed: 0, failed: 0, skipped: 0 }))
        if (idx.failed > 0 || idx.skipped > 0) {
          logMain('compilation', `网页资料索引 就绪=${idx.indexed} 失败=${idx.failed} 超预算跳过=${idx.skipped}（这些文章本轮只能靠词法命中）`)
        }
      }
    } else {
      /*
       * Phase 10 P6（2026-10-04 用户裁定）：**删除旧的"标题粗筛取前 N 篇"路径**。
       * 理由：① 它按**标题**判断相关性，直接违反用户裁定 ⑦（标题永不作为相关性判据）；
       * ② 真实库取证显示它把 600 篇材料里的 84% 变成了噪声（"长乐区"这种范围词在标题里几乎人人都有）。
       * 现在没有年份区间时**不再猜**，如实告知并跳过网页资料（本地资料照常参与）。
       */
      logMain('compilation', '未指定网页资料年份区间：本次不使用网页资料（旧的标题粗筛路径已删除；请在资料库面板设定年份）')
      onProgress?.({
        stage: '未指定网页资料年份区间：本次只用本地资料（请到「资料库」设定年份后重新生成）…',
        percent: 8,
        etaSeconds: preWindowEta(0)
      })
      webStats.sites = 0
    }
  }

  onProgress?.({ stage: '正在本地召回资料（宁多勿漏）…', percent: 10, etaSeconds: preWindowEta(PHASE_GATE_ETA_S) })
  const allChunks = recallCandidateChunks(scopeIds, coarseQuery, extraTerms)
  if (allChunks.length === 0) return fail(ErrorCodes.LLM_NO_CANDIDATES, '资料库中没有可召回的资料')

  // 无 Provider → 本地降级：**用保守闸门收窄后的材料**（而不是宽召回全量），避免降级产物被无关内容淹没
  if (!prov.ok) {
    onProgress?.({ stage: '正在按主题收敛候选材料（保守闸门）…', percent: 11, etaSeconds: preWindowEta(0) })
    const localVectors = await embedTexts([vecQuery]).catch(() => null)
    const gated = recallCompilationCandidates(scopeIds, coarseQuery, localVectors ? localVectors[0] : undefined, extraTerms, {
      converge: !options.skipConvergence
    })
    const localChunks = gated.chunks.length > 0 ? gated.chunks : allChunks
    logMain('compilation', `本地降级材料：宽召回 ${allChunks.length} 段 → 闸门后 ${gated.chunks.length} 段（来源 ${gated.candidateSources} 个）`)
    if (gated.convergence) logConvergence(gated.convergence, options.skipConvergence === true)
    return finalizeCompilationLocal(taskId, title, localChunks, webStats, gated.convergence)
  }

  // 2026-08-25 优化：调用大模型前用保守本地闸门收窄提交物——把"任务范围内全部段落"收敛为
  // "与主题相关的来源及其相关段落"。完全无关的来源整篇舍弃，宽口径来源只保留有信号的段；
  // 用低阈值向量路径兜底"字面无关但语义相关"的段落，避免误删可能相关的内容。
  onProgress?.({ stage: '正在按主题收敛候选材料（保守闸门）…', percent: 11, etaSeconds: preWindowEta(0) })
  const vectors = await embedTexts([vecQuery]).catch(() => null)
  const queryVector = vectors ? vectors[0] : undefined
  /*
   * 第二组 ⑤（2026-10-06）：闸门之后、`sliceChunks` 切窗之前做「文章内取高信号段 ± 上下文」。
   * `skipConvergence` = 用户在预检确认框里勾了「本轮不做收敛（全量送入）」→ 跳过 ⑤，行为回到今天。
   * 判据与离线回放共用 `article-segments.ts`（同一函数），此处不重复实现任何判定逻辑。
   */
  const recall = recallCompilationCandidates(scopeIds, coarseQuery, queryVector, extraTerms, {
    converge: !options.skipConvergence
  })
  const gatedChunks = recall.chunks.length > 0 ? recall.chunks : allChunks

  /*
   * 2026-10-05（**用户裁定，取代 Phase 10 P5b-2 的"60 万字/轮上限 + 排队"**）：
   * **任何地方都不得设"总量上限"** —— 本地/网页资料库中**所有通过闸门的文段都必须被提取**；
   * 只有**单个窗口的大小**（细读窗口 `WINDOW_MAX_CHARS`、提取批次）可以指定，**总窗口规模绝不设限**。
   *
   * 因此这里不做任何取舍、也不排队：闸门给出的**全部**材料都进入本轮细读与提取。
   * 代价明确（用户已确认接受）：材料越多，细读窗口与提取批次按比例增加，耗时与额度消耗随之上升。
   * 原总预算模块（`material-budget.ts`）与排队模块（`material-queue.ts`）已按用户指示**整体删除**；
   * Migration 048 的 `compilation_material_queue` 表按项目惯例**保留不删**（历史数据留在库中，不再读写）。
   *
   * ⚠ 与 ⑤ 的关系（避免误读）：⑤ **只决定"本轮细读窗口里放哪些段"**，不是"总量上限"——
   * 取舍完全由信号决定（有信号就留，不设每篇段数/总字数上限），且被跳过的段**一字不动地留在库里**
   * （`sources.cleaned_text` 未被触碰），仍可打开查看、仍参与来源询问与定位。
   */
  const chunks = gatedChunks
  const allChars = chunks.reduce((n, c) => n + (c.text?.length ?? 0), 0)
  // 该任务的网页来源 id（查询很轻）：仅用于日志/进度里如实区分"本地段 / 网页段"，**不参与任何取舍**
  const webIdSet = new Set(listUrlSourceIdsByTask(taskId))
  const localSegs = chunks.filter((c) => !webIdSet.has(c.sourceId)).length
  const estimatedWindows = Math.max(1, Math.ceil(allChars / Math.max(1, WINDOW_MAX_CHARS)))
  const convergence = recall.convergence
  if (convergence) logConvergence(convergence, false)
  else {
    logMain(
      'compilation',
      options.skipConvergence
        ? `材料（无总量上限、本轮**不做收敛**）：闸门后全部 ${chunks.length} 段 / ${allChars} 字进入本轮（用户勾选了「本轮不做收敛（全量送入）」）` +
            `（本地 ${localSegs} 段 / 网页 ${chunks.length - localSegs} 段）；细读约 ${estimatedWindows} 个窗口`
        : `材料（无总量上限）：闸门后**全部** ${chunks.length} 段 / ${allChars} 字进入本轮` +
            `（本地 ${localSegs} 段 / 网页 ${chunks.length - localSegs} 段）；细读约 ${estimatedWindows} 个窗口`
    )
  }
  // 进度文案：如实写清「本轮送 X 段 / Y 字（来自 N 篇）；另有 Z 段因无信号未送（仍在库中，可打开查看）」
  const convergedNote = convergence
    ? `本轮送 ${convergence.keptSegments} 段 / ${convergence.keptChars} 字（来自 ${convergence.sources - convergence.noSignalSources} 篇）；` +
      `另有 ${convergence.droppedSegments} 段因无信号未送（仍在库中，可打开查看）`
    : `本轮不做收敛，闸门后全部 ${chunks.length} 段 / ${allChars} 字送入`
  onProgress?.({
    stage:
      `候选材料 ${Math.round(allChars / 10000)} 万字已就绪（${convergedNote}；` +
      `本地 ${localSegs} 段 + 网页 ${chunks.length - localSegs} 段，约 ${estimatedWindows} 个细读窗口）…`,
    percent: 11,
    etaSeconds: preWindowEta(0)
  })

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
    shortTitle: extracted?.title ?? t,
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
    concurrency: prov.provider.concurrency,
    // ⑤ 统计随状态走：中断续跑时 summary 仍能如实说"本轮送 X 段 / Y 字"
    ...(convergence ? { convergence } : {})
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
    return finalizeCompilationLocalInto(state.compilationId, allChunks, undefined, state.convergence ?? null)
  }

  // 整合提取（Phase 7.2：取代原「提纯 + 修正」，允许大模型裁剪/补全/整合，产出可直接写进志稿的段落）
  state.phase = 'extract'
  phaseRes = await runWithRateLimitAutoResume(
    state,
    (s, p) => runExtractPhase(s, merged.items, p),
    onProgress,
    onAdvice
  )
  if (phaseRes === 'interrupted') {
    await persistPartialCompilation(state)
    resumeStore.set(state.compilationId, state)
    return interruptedResult(state)
  }
  const paragraphs = state.extractedParagraphs ?? []
  // 窗口级矛盾的说法在细读阶段引用的是「提纯前整段原文」，提取后段落已改写，
  // 落库时按 excerpt 精确匹配会匹配不到 → 先映射到最终段落文本（内容被裁掉的整组丢弃）
  const windowGroups = mapWindowGroupsThroughExtract(merged.contradictions, merged.items, paragraphs)

  state.phase = 'contradiction'
  phaseRes = await runWithRateLimitAutoResume(
    state,
    (s, p) => runContradictionPhase(s, paragraphsToScanItems(paragraphs, state.refs), p),
    onProgress,
    onAdvice
  )
  if (phaseRes === 'interrupted') {
    await persistPartialCompilation(state)
    resumeStore.set(state.compilationId, state)
    return interruptedResult(state)
  }

  // 全部完成：清除断点，落库（段落 + 来源编号 + 矛盾 + v1 版本 + 来源锚点）
  resumeStore.delete(state.compilationId)
  return await finalizeCompilationInto(
    state.compilationId,
    { paragraphs, contradictions: mergeContradictionGroups(windowGroups, state.scanGroups) },
    refs,
    chunks.length,
    state.scanIncomplete ? { ok: false, message: state.scanIncomplete.message } : { ok: true },
    {
      ok: !state.extractIncomplete,
      message: state.extractIncomplete?.message,
      ...(state.extractStats ?? {})
    },
    onProgress,
    state.convergence ?? null
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
      // 子块必须带上**自己的**字符区间（P0-2）：按句边界推算，块起点加句内偏移；
      // 原块没有区间时如实不带（落锚点回退逐字匹配）
      const subRanges = c.charStart != null && c.charEnd != null ? sentenceRanges(c.text, c.charStart, c.charEnd) : []
      let buf = ''
      let subStart: number | undefined
      let subEnd: number | undefined
      const flushSub = (): void => {
        if (buf) {
          windows.push([{ ...c, text: buf, charStart: subStart, charEnd: subEnd }])
          buf = ''
        }
      }
      for (const s of subRanges) {
        if (buf.length + s.text.length > maxChars) flushSub()
        if (!buf) {
          subStart = s.start
        }
        buf += s.text
        subEnd = s.end
      }
      // 原块没有区间（或句子切分与切块口径不一致）时退回旧行为：按原块文字切，不带子区间
      if (subRanges.length === 0) {
        subStart = undefined
        subEnd = undefined
        const sentences = c.text.split(/(?<=[。！？；;])/).map((s) => s.trim()).filter(Boolean)
        for (const s of sentences) {
          if (buf.length + s.length > maxChars) flushSub()
          buf += s
        }
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
    if (parsed) {
      // 卡片落库前就把"来自哪个候选块"记下来（P0-2：生成期记录，不做事后回溯）
      attachCardRanges(parsed, windowChunks)
      return { out: parsed, failed: false }
    }
  }
  // 全部温度要么调用失败、要么无可解析输出：调用失败视为「异常中断」，可继续；无可解析输出视为正常（无卡片）
  return failedMsg ? { out: null, failed: true, message: failedMsg, rateLimited } : { out: null, failed: false }
}

function finalizeCompilationLocal(
  taskId: string,
  title: string,
  chunks: RetrievedChunk[],
  webScan?: WebFetchStats,
  convergence?: ArticleConvergenceStats | null
): GenerateCompilationResult {
  const compilation = createCompilation({ taskId, title })
  persistLocalFallback(compilation.id, localFallbackParagraphs(chunks))
  return {
    ok: true,
    compilationId: compilation.id,
    candidateChunks: chunks.length,
    contradictions: 0,
    webScan,
    convergence: convergence ?? undefined
  }
}

/**
 * 把文档段落转成「矛盾扫描」用的卡片视图（扫描逻辑沿用 Phase 6 的实现，按 sourceRef/excerpt 工作）。
 * 段落的 `sourceOrdinal` 即本汇编的来源编号，因此可以还原出扫描需要的 `#N` 引用。
 */
function paragraphsToScanItems(paragraphs: AssembledParagraph[], refs: SourceRefEntry[]): CompilationOutputItem[] {
  const refBySourceId = new Map(refs.map((r) => [r.sourceId, '#' + r.index]))
  return paragraphs.map((p) => ({
    sourceRef: p.sourceId ? (refBySourceId.get(p.sourceId) ?? '') : '',
    position: '',
    excerpt: p.text,
    ts: p.timeLabel ?? null
  }))
}

/**
 * 落库：段落 + 来源编号 + 矛盾 + v1 版本（Phase 7.2 起取代"卡片整体替换"）。
 * - 来源编号按**排序后首次引用顺序**分配 1..N（`ensureCompilationSources`，只增不回收）；
 * - 段落用 `upsertCompilationParagraphs` 写入（**保留段 id**，矛盾/证据/版本快照都依赖它）；
 * - 落库后生成 v1 版本（origin='generate'），使版本对比从生成完成起就有基线。
 */
function persistDocument(
  compilationId: string,
  paragraphs: AssembledParagraph[],
  refs: SourceRefEntry[]
): { itemIdByText: Map<string, string>; inserted: number; anchors: Promise<void> } {
  const titleBySourceId = new Map(refs.map((r) => [r.sourceId, r.title]))
  const sourceOrder: string[] = []
  for (const p of paragraphs) {
    // Phase 7.12：并列来源也要进编号表，否则被合并掉的出处拿不到编号、界面显示不出"两个出处"
    for (const sid of [p.sourceId, ...(p.alsoSourceIds ?? [])]) {
      if (sid && !sourceOrder.includes(sid)) sourceOrder.push(sid)
    }
  }
  const sourceRefs = ensureCompilationSources(
    compilationId,
    sourceOrder.map((sourceId) => ({ sourceId, title: titleBySourceId.get(sourceId) ?? sourceId }))
  )
  const ordinalBySourceId = new Map(sourceRefs.filter((s) => s.sourceId).map((s) => [s.sourceId as string, s.ordinal]))
  const items = upsertCompilationParagraphs(
    compilationId,
    paragraphs.map((p) => ({
      sourceId: p.sourceId ?? '',
      alsoSourceIds: p.alsoSourceIds,
      text: p.text,
      timeLabel: p.timeLabel,
      year: p.year,
      month: p.month,
      day: p.day,
      timeConfidence: p.timeConfidence,
      sourceOrdinal: p.sourceId ? ordinalBySourceId.get(p.sourceId) : undefined,
      evidence: p.evidence,
      origin: p.origin,
      revision: p.revision,
      kind: p.kind,
      kept: p.kept
    }))
  )
  const itemIdByText = new Map<string, string>()
  for (const it of items) {
    if (!itemIdByText.has(it.excerpt)) itemIdByText.set(it.excerpt, it.id)
  }
  // Phase 9 / S3 收尾：就地算来源锚点（块号 → 页码）。**唯一**能一次拿到全部刚写库段落的位置。
  //
  // ⚠ 2026-10-03 用户实测反馈的缺陷（PLAN 9.15）：这里原来是纯 fire-and-forget，于是**生成完成时
  // 前端立刻取到的汇编还没有锚点** → 刚生成完点小圆标一律"未记录来源位置"，切走再切回来（重新取数）
  // 才正常。现在改为**把 promise 交给调用方**：正常完成路径（`finalizeCompilationInto`）会 await 它，
  // 使"生成完成"这个信号发出时锚点已落库；中断/续跑的**部分落库**仍 fire-and-forget（那时还在生成中）。
  //
  // `upsertCompilationParagraphs` 返回的是按 `position`（= 入参下标）排序的段落，因此可与 `paragraphs`
  // 一一对应——这样并列来源的候选文字（`anchorCandidates`，只走内存）才能带到锚点阶段。
  const anchors = attachAnchorsQuietly(
    items.length === paragraphs.length
      ? items.map((it, i) => ({
          id: it.id,
          sourceId: it.sourceId,
          excerpt: it.excerpt,
          evidence: it.evidence,
          // 生成期记录的字符区间随候选一起带到锚点阶段（P0-2）：有它就直接映射块表，不做文本回溯
          charStart: paragraphs[i].charStart,
          charEnd: paragraphs[i].charEnd,
          candidates: paragraphs[i].anchorCandidates
        }))
      : items.map((it) => ({ id: it.id, sourceId: it.sourceId, excerpt: it.excerpt, evidence: it.evidence }))
  )
  return { itemIdByText, inserted: items.length, anchors }
}

/** 把「已完成阶段」的部分结果落库，供中断时展示并可续跑（已跑过整合提取就用提取后的段落） */
async function persistPartialCompilation(state: CompilationResumeState): Promise<void> {
  const merged = mergeCompilationOutputs(state.windowOutputsByIndex.filter((o): o is CompilationOutput => o !== null))
  const paragraphs = state.extractedParagraphs
  if (paragraphs && paragraphs.length > 0) {
    persistDocument(state.compilationId, paragraphs, state.refs)
    return
  }
  const items = mapOutputItemsToInputs(merged.items, state.refs)
  replaceCompilationItems(state.compilationId, sortItemsByTs(items))
}

/** 大模型异常中断时的结果（ok: true，含部分卡片与中断信息） */
function interruptedResult(state: CompilationResumeState): GenerateCompilationResult {
  return {
    ok: true,
    compilationId: state.compilationId,
    candidateChunks: state.chunks.length,
    contradictions: 0,
    interrupted: state.interrupted,
    convergence: state.convergence
  }
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
        // 后续单次调用阶段（整合提取）与矛盾扫描阶段的先验
        const postWindowEta = PHASE_EXTRACT_ETA_S
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
 * 整合提取阶段（Phase 7.2，取代原「提纯」+「修正」；可中断/可续跑）：
 * 对细读筛出的候选卡片做**裁剪 + 补全 + 整合**，产出可直接写进志稿的段落
 * （每段单一来源、段首含年份的时间、段尾来源编号）。约束与三道本地校验见 extract-service。
 * - **按 Provider 并发数并行批次**；
 * - 单段校验失败 → 降级保留该卡片原文整段（不丢材料）；漏答 / 解析失败 / 超预算 → 同样按原文整段保留；
 * - 大模型异常 → 置中断标志（429 可自动续传），续跑只重跑未完成的批次；
 * - 成文（去重、排序、编号顺序）由 compilation-document 的 assembleDocument 统一完成。
 */
async function runExtractPhase(
  state: CompilationResumeState,
  items: CompilationOutputItem[],
  onProgress?: (p: CompilationProgress) => void
): Promise<'done' | 'interrupted'> {
  if (items.length === 0) {
    state.extractedParagraphs = []
    return 'done'
  }
  if (!state.extractBatches) {
    const sourceTitleByRef = new Map(state.refs.map((r) => ['#' + r.index, r.title]))
    const sourceMetaByRef = new Map(state.refs.map((r) => ['#' + r.index, { kind: r.kind, publishedAt: r.publishedAt }]))
    state.extractCandidates = items.map((it, i) => ({
      index: i,
      key: 'c' + (i + 1),
      sourceRef: it.sourceRef,
      sourceTitle: sourceTitleByRef.get(it.sourceRef) ?? '',
      excerpt: it.excerpt,
      ts: it.ts ?? undefined,
      sourceKind: sourceMetaByRef.get(it.sourceRef)?.kind,
      sourcePublishedAt: sourceMetaByRef.get(it.sourceRef)?.publishedAt,
      // 卡片在来源正文里的字符区间（读窗口时对回候选块得到的，P0-2）
      charStart: it.charStart,
      charEnd: it.charEnd
    }))
    state.extractBatches = splitExtractBatches(state.extractCandidates)
    state.extractDrafts = state.extractDrafts ?? []
    state.extractDoneBatches = state.extractDoneBatches ?? new Set<number>()
    state.extractStartedAt = Date.now()
  }
  const batches = state.extractBatches
  const candidates = state.extractCandidates ?? []
  const drafts = state.extractDrafts ?? (state.extractDrafts = [])
  const done = state.extractDoneBatches ?? (state.extractDoneBatches = new Set<number>())
  const agg = emptyExtractStats()
  /**
   * 来源编号 → **该来源完整正文**（2026-10-03 用户裁定）：③ 的比对范围不该只是"本批卡片"，
   * 从同一来源未被成卡的部分引用的数字同样有据。一次读库、整阶段复用。
   */
  const sourceTextByRef = new Map<string, string>()
  for (const r of state.refs) {
    const text = getSourcesByIds([r.sourceId])[0]?.cleanedText ?? ''
    if (text) sourceTextByRef.set('#' + r.index, text)
  }
  /** 把累积的段落草稿按「去重 → 时间排序 → 来源编号顺序」成文；返回段落数与来源数 */
  const finish = (incomplete?: string): { paragraphs: number; sources: string[]; chars: number } => {
    const sourceIdByRef = new Map(state.refs.map((r) => ['#' + r.index, r.sourceId]))
    const titleByRef = new Map(state.refs.map((r) => ['#' + r.index, r.title]))
    const byIndex = new Map(candidates.map((c) => [c.index, c]))
    const assembled = assembleDocument(
      drafts.map((d) => {
        const candidate = byIndex.get(d.parentIndex)
        const ref = candidate?.sourceRef ?? ''
        return {
          text: d.text,
          timeLabel: d.timeLabel,
          timeConfidence: d.timeConfidence,
          sourceId: sourceIdByRef.get(ref) ?? '',
          sourceTitle: titleByRef.get(ref),
          evidence: d.evidence,
          origin: 'generate' as const,
          parentIndex: d.parentIndex,
          /*
           * 生成期记录的字符区间（P0-2）：优先用提取阶段算出的（`d.charStart`，这一段的区间最准），
           * 其次退到它所属卡片的区间（卡片是"整段照抄候选材料"，区间来自切块；模型改写时 `d.charStart` 会缺省）。
           * 两者都没有就如实缺省 → 落锚点时走逐字 fallback，**旧数据与降级路径都不受影响**。
           */
          charStart: d.charStart ?? candidate?.charStart,
          charEnd: d.charEnd ?? candidate?.charEnd
        }
      })
    )
    state.extractedParagraphs = assembled.paragraphs
    state.extractStats = {
      inputCards: items.length,
      outputParagraphs: assembled.paragraphs.length,
      inputChars: items.reduce((n, it) => n + it.excerpt.length, 0),
      outputChars: assembled.paragraphs.reduce((n, p) => n + p.text.length, 0),
      accepted: agg.accepted,
      degraded: agg.unverified,
      invalidNumbers: agg.invalidNumbers,
      invalidEvidence: agg.invalidEvidence,
      evidenceLoose: agg.evidenceLoose,
      degradedFromEvidence: agg.degradedFromEvidence,
      droppedUnverifiable: agg.droppedUnverifiable,
      droppedUnparseable: agg.droppedUnparseable,
      droppedCards: agg.droppedCards,
      omitted: agg.omitted,
      titleOnlyDropped: agg.titleOnlyDropped,
      timeUnsupported: agg.timeUnsupported,
      duplicatesDropped: assembled.duplicatesDropped,
      conflictsKept: assembled.conflictsKept,
      crossSourceMerged: assembled.crossSourceMerged,
      containmentMerged: assembled.containmentMerged,
      retried: agg.retried
    }
    if (incomplete) state.extractIncomplete = { message: incomplete }
    const chars = assembled.paragraphs.reduce((n, p) => n + p.text.length, 0)
    const scan = state.extractStats
    logMain(
      'extract',
      '整合提取完成 汇编=' +
        state.compilationId +
        ' 卡片 ' +
        items.length +
        ' → 段落 ' +
        assembled.paragraphs.length +
        '（' +
        (scan?.inputChars ?? 0) +
        ' → ' +
        chars +
        ' 字）通过校验 ' +
        agg.accepted +
        '、降级 ' +
        agg.unverified +
        '（数字 ' +
        agg.invalidNumbers +
        '／证据 ' +
        agg.invalidEvidence +
        '）、整卡丢弃 ' +
        agg.droppedCards +
        '、重复合并 ' +
        assembled.duplicatesDropped +
        '、保留冲突 ' +
        assembled.conflictsKept +
        '、来源 ' +
        assembled.sourceOrder.length +
        ' 篇' +
        (incomplete ? '；未完成：' + incomplete : '')
    )
    return { paragraphs: assembled.paragraphs.length, sources: assembled.sourceOrder, chars }
  }
  if (batches.length === 0) {
    onProgress?.({ stage: '无需整合提取的资料，已跳过该阶段', percent: 87, etaSeconds: 0 })
    finish()
    return 'done'
  }

  const startedAt = state.extractStartedAt ?? Date.now()
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
      if (Date.now() - startedAt > EXTRACT_PHASE_BUDGET_MS) {
        budgetHit = true
        halt = true
        return
      }
      const remaining = batches.length - done.size
      dispatched += 1
      onProgress?.({
        stage: '正在整合提取资料（第 ' + dispatched + '/' + batches.length + ' 批：裁剪无关内容、补全并整合为志稿段落）…',
        percent: 67 + Math.round((done.size / batches.length) * 20),
        etaSeconds: Math.max(1, Math.ceil(remaining / Math.max(1, state.concurrency))) * EXTRACT_ETA_PER_CALL_S
      })
      const batchCards = batches[bi].map((i) => candidates[i]).filter((c): c is ExtractCandidate => !!c)
      const res = await extractBatch(
        state.provider,
        batchCards,
        // 《题目》用短标题；用户撰写要求**全文**另作首要依据传下去（2026-10-03 用户裁定）
        state.shortTitle ?? state.title,
        state.taskId,
        state.title,
        // ③ 的比对范围 = **该来源完整正文**（2026-10-03 用户裁定：不只是本批卡片）
        sourceTextByRef
      ).catch((e) => ({
        ok: false,
        drafts: [] as ExtractedDraft[],
        stats: emptyExtractStats(batchCards.length, 0),
        message: e instanceof Error ? e.message : String(e),
        rateLimited: false
      }))
      if (!res.ok) {
        halt = true
        interrupted = true
        state.interrupted = {
          stage: '正在整合提取资料（第 ' + dispatched + '/' + batches.length + ' 批）',
          message: res.message ?? '大模型调用异常中断',
          percent: 67 + Math.round((done.size / batches.length) * 20),
          retryable: res.rateLimited === true
        }
        return
      }
      drafts.push(...res.drafts)
      logExtractBatchStats(bi + 1, batches.length, res.stats)
      agg.accepted += res.stats.accepted
      agg.unverified += res.stats.unverified
      agg.invalidNumbers += res.stats.invalidNumbers
      agg.invalidEvidence += res.stats.invalidEvidence
      agg.evidenceLoose += res.stats.evidenceLoose
      agg.emptyText += res.stats.emptyText
      agg.degradedFromEvidence += res.stats.degradedFromEvidence
      agg.droppedUnverifiable += res.stats.droppedUnverifiable
      agg.droppedUnparseable += res.stats.droppedUnparseable
      agg.droppedCards += res.stats.droppedCards
      agg.omitted += res.stats.omitted
      agg.droppedUnparseable += res.stats.droppedUnparseable
      agg.retainedChars += res.stats.retainedChars
      agg.retried += res.stats.retried
      agg.titleOnlyDropped += res.stats.titleOnlyDropped
      agg.timeUnsupported += res.stats.timeUnsupported
      done.add(bi)
    }
  })
  await Promise.all(workers)

  if (interrupted) return 'interrupted'

  const completed = done.size
  if (budgetHit) {
    // 超出时间预算：未处理的卡片**不再原样整段保留**（A1，2026-10-03 用户裁定）——
    // 卡片原文会把与主题无关的内容（年鉴概况段、项目表、其它领域数据）直接搬进汇编，实测就是这样出问题的。
    // 现在如实丢弃并由用户在汇总里看到，可重新生成或走对话里的"查漏补缺"。
    let droppedByBudget = 0
    for (let k = 0; k < batches.length; k++) {
      if (done.has(k)) continue
      droppedByBudget += batches[k].length
      done.add(k)
    }
    agg.droppedUnverifiable += droppedByBudget
    agg.droppedUnparseable += droppedByBudget
    finish(
      '整合提取超出时间预算，已完成 ' + completed + '/' + batches.length + ' 批；其余 ' + droppedByBudget + ' 张卡片已丢弃（不再原样搬运卡片原文）。'
    )
    onProgress?.({ stage: '整合提取超出时间预算，未处理的卡片已丢弃', percent: 87, etaSeconds: 0 })
    return 'done'
  }
  const result = finish()
  onProgress?.({
    stage: '资料整合提取完成（卡片 ' + items.length + ' 张 → 段落 ' + result.paragraphs + ' 段 / ' + result.sources.length + ' 篇来源）',
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
 * 窗口级矛盾的说法经「整合提取映射」（Phase 7.2 取代原提纯映射）：
 * 细读阶段的窗口级矛盾引用的是**提取前**的整段原文，提取后段落已被裁剪/改写，
 * 若不改写则落库时按 excerpt 匹配不到段落、整组矛盾会被静默丢弃。
 * 映射规则（保守，宁可丢说法也不张冠李戴）：
 * ① 找包含该说法的**候选卡片**（提取的来源）→ ② 在该来源派生出的段落里，取与说法文本相似度最高的一段；
 * ③ 找不到候选（说法在窗口合并时已被删）→ 退而求其次，直接在全部段落里找包含关系或最高相似度**且足够像**（≥0.5）的段；
 * ④ 都找不到（内容已被提取裁掉）→ 丢弃该说法（相关材料已不在汇编中）。
 */
export function mapWindowGroupsThroughExtract(
  groups: CompilationOutputGroup[],
  parents: CompilationOutputItem[],
  paragraphs: AssembledParagraph[]
): CompilationOutputGroup[] {
  if (groups.length === 0) return groups
  const paragraphTexts = paragraphs.map((p) => p.text)
  const byParentIndex = new Map<number, string[]>()
  paragraphs.forEach((p) => {
    const list = byParentIndex.get(p.parentIndex) ?? []
    list.push(p.text)
    byParentIndex.set(p.parentIndex, list)
  })
  const bestIn = (candidates: string[], needle: string): { text: string; score: number } | null => {
    let best: { text: string; score: number } | null = null
    for (const text of candidates) {
      if (stripSpaces(text).includes(stripSpaces(needle))) return { text, score: 1 }
      const score = textSimilarity(text, needle)
      if (!best || score > best.score) best = { text, score }
    }
    return best
  }
  const out: CompilationOutputGroup[] = []
  for (const g of groups) {
    const variants: CompilationOutputVariant[] = []
    const seen = new Set<string>()
    for (const v of g.variants) {
      let mapped: string | undefined
      // ① 说法落在哪张候选卡片里 → 该卡片派生出的段落
      const parentIndex = parents.findIndex((p) => stripSpaces(p.excerpt).includes(stripSpaces(v.excerpt)))
      if (parentIndex >= 0) {
        const best = bestIn(byParentIndex.get(parentIndex) ?? [], v.excerpt)
        if (best && best.score >= 0.5) mapped = best.text
      }
      // ② 退路：直接在全部段落里找（说法可能跨了候选边界，或父卡片被合并）
      if (!mapped) {
        const best = bestIn(paragraphTexts, v.excerpt)
        if (best && best.score >= 0.5) mapped = best.text
      }
      if (!mapped || seen.has(mapped)) continue
      seen.add(mapped)
      variants.push({ excerpt: mapped, sourceRefs: v.sourceRefs })
    }
    if (variants.length >= 2) out.push({ topic: g.topic, kind: g.kind, variants })
  }
  return out
}

/** 使用已创建的汇编写入最终段落 + 来源编号 + 矛盾 + v1 版本（供正常完成 / 续跑完成调用） */
export async function finalizeCompilationInto(
  compilationId: string,
  output: { paragraphs: AssembledParagraph[]; contradictions: CompilationOutputGroup[] },
  refs: SourceRefEntry[],
  candidateChunks: number,
  contradictionScan?: { ok: boolean; message?: string },
  extractScan?: {
    ok: boolean
    message?: string
    inputCards?: number
    outputParagraphs?: number
    inputChars?: number
    outputChars?: number
    accepted?: number
    degraded?: number
    invalidNumbers?: number
    invalidEvidence?: number
    degradedFromEvidence?: number
    degradedPruned?: number
    droppedUnverifiable?: number
    droppedCards?: number
    omitted?: number
    passthrough?: number
    duplicatesDropped?: number
    conflictsKept?: number
    /** 跨来源合并掉的段数（Phase 7.12：这些段的并列来源已同步标出） */
    crossSourceMerged?: number
    /** 由「包含关系」判定合并掉的段数（Phase 7.12 S1 新增规则） */
    containmentMerged?: number
  },
  /** 生成进度回调：锚点阶段会推一条「正在记录来源位置…」（用户实测反馈的修复，见 9.15） */
  onProgress?: (p: CompilationProgress) => void,
  /** 第二组 ⑤：本轮的取段统计（供生成汇总如实带一句）；未做收敛时为 null */
  convergence?: ArticleConvergenceStats | null
): Promise<GenerateCompilationResult> {
  const { itemIdByText, anchors } = persistDocument(compilationId, output.paragraphs, refs)

  // 矛盾分组：把 variant 的 excerpt 精确匹配到刚写入的段落（映射阶段已把说法改写成段落文本）
  const groups: CompilationContradictionInput[] = []
  for (const g of output.contradictions) {
    const variants: CompilationContradictionInput['variants'] = []
    const seen = new Set<string>()
    for (const v of g.variants) {
      const itemId = itemIdByText.get(v.excerpt)
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
  // v1 版本：生成完成即建立基线（后续每次编辑都会追加新版本）
  snapshotCompilationVersion(compilationId, 'generate')
  // 整合提取诊断落库（便于事后复盘：通过校验/降级原因/降级粒度各占多少）
  setCompilationExtractScan(compilationId, extractScan ?? null)

  /*
   * 等锚点落库（PLAN 9.15，用户实测反馈的修复）：
   * 生成完成的信号一旦发出，前端会立刻取一次汇编数据——若锚点还没写完，刚生成完点小圆标就是
   * "未记录来源位置"，必须切走再切回来（重新取数）才正常。这里同步等它（实测：冷启动解块表 4.6s、
   * 热路径 2.2s、整份汇编 1.9s），并推一条进度；超时保险丝只防"卡死"，超时也不再阻塞生成。
   */
  onProgress?.({ stage: '正在记录来源位置（点击来源圆标可直达页码）…', percent: 99, etaSeconds: 2 })
  await Promise.race([
    // 锚点只是"锦上添花"：任何异常都不能影响汇编生成（attachAnchorsQuietly 内已吞异常，这里再兜一层）
    anchors.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ANCHOR_ATTACH_TIMEOUT_MS))
  ])

  return {
    ok: true,
    compilationId,
    candidateChunks,
    contradictions: contradictions.length,
    contradictionScan,
    extractScan,
    convergence: convergence ?? undefined
  }
}

/** 收尾等锚点的时间上限（保险丝；实测冷启动 4.6s / 热路径 2.2s） */
const ANCHOR_ATTACH_TIMEOUT_MS = 120_000

/** 无 Provider / AI 无产出时的本地降级（替换到已创建的汇编） */
async function finalizeCompilationLocalInto(
  compilationId: string,
  chunks: RetrievedChunk[],
  onProgress?: (p: CompilationProgress) => void,
  convergence?: ArticleConvergenceStats | null
): Promise<GenerateCompilationResult> {
  const paragraphs = localFallbackParagraphs(chunks)
  onProgress?.({ stage: '正在记录来源位置（点击来源圆标可直达页码）…', percent: 99, etaSeconds: 2 })
  await persistLocalFallback(compilationId, paragraphs)
  return { ok: true, compilationId, candidateChunks: chunks.length, contradictions: 0, convergence: convergence ?? undefined }
}

/** 本地降级：来源块整段保留，年份直接从正文抓（无大模型可用，不做裁剪与整合） */
function localFallbackParagraphs(chunks: RetrievedChunk[]): AssembledParagraph[] {
  const dedup = new Set<string>()
  const paragraphs: AssembledParagraph[] = []
  for (const c of chunks) {
    const key = c.sourceId + '|' + c.position + '|' + c.text
    if (dedup.has(key)) continue
    dedup.add(key)
    // 年份正则：`\d{2}` 曾被误写为 `d{2}`（少一个反斜杠，等同于字面量「d」），
    // 导致本地降级产出的段落永远没有时间戳；此处修正为 4 位年份匹配。
    const m = c.text.match(/(18|19|20)\d{2}/)
    const time = parseTimeLabel(m ? m[0] + ' 年' : undefined)
    paragraphs.push({
      ordinal: paragraphs.length,
      sourceId: c.sourceId,
      text: c.text,
      timeLabel: time.label,
      year: time.year,
      month: time.month,
      day: time.day,
      timeConfidence: time.confidence,
      origin: 'generate',
      revision: 1,
      kind: 'paragraph',
      kept: true,
      parentIndex: paragraphs.length,
      // 本地降级的段落就是候选块**逐字原文**，因此它天然带着生成期字符区间（P0-2）：直接落锚点，零文本回溯
      charStart: c.charStart,
      charEnd: c.charEnd,
      anchorCandidates: [{ sourceId: c.sourceId, excerpt: c.text, charStart: c.charStart, charEnd: c.charEnd }]
    })
  }
  return paragraphs
}

/**
 * 本地降级落库：刻意走**与 AI 管线相同的段落模型**（来源编号 + 结构化时间 + v1 版本），
 * 否则降级生成出的汇编没有年份分节、没有来源圆标、也没有版本基线，界面看起来像功能坏了。
 */
function persistLocalFallback(compilationId: string, paragraphs: AssembledParagraph[]): Promise<void> {
  const sourceOrder: string[] = []
  for (const p of paragraphs) {
    for (const sid of [p.sourceId, ...(p.alsoSourceIds ?? [])]) {
      if (sid && !sourceOrder.includes(sid)) sourceOrder.push(sid)
    }
  }
  const sourceRefs = ensureCompilationSources(
    compilationId,
    sourceOrder.map((sourceId) => ({ sourceId, title: getSourcesByIds([sourceId])[0]?.title ?? sourceId }))
  )
  const ordinalBySourceId = new Map(sourceRefs.filter((s) => s.sourceId).map((s) => [s.sourceId as string, s.ordinal]))
  const items = upsertCompilationParagraphs(
    compilationId,
    paragraphs.map((p) => ({
      sourceId: p.sourceId ?? '',
      alsoSourceIds: p.alsoSourceIds,
      text: p.text,
      timeLabel: p.timeLabel,
      year: p.year,
      month: p.month,
      day: p.day,
      timeConfidence: p.timeConfidence,
      sourceOrdinal: p.sourceId ? ordinalBySourceId.get(p.sourceId) : undefined,
      origin: p.origin,
      revision: p.revision,
      kind: p.kind,
      kept: p.kept
    }))
  )
  snapshotCompilationVersion(compilationId, 'generate')
  // 本地降级路径同样记锚点（PLAN 9.15：否则"生成完成即可点到页"在无大模型时也不成立）
  return attachAnchorsQuietly(
    items.length === paragraphs.length
      ? items.map((it, i) => ({
          id: it.id,
          sourceId: it.sourceId,
          excerpt: it.excerpt,
          evidence: it.evidence,
          charStart: paragraphs[i].charStart,
          charEnd: paragraphs[i].charEnd,
          candidates: paragraphs[i].anchorCandidates
        }))
      : items.map((it) => ({ id: it.id, sourceId: it.sourceId, excerpt: it.excerpt, evidence: it.evidence }))
  )
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
    state.phase = 'extract'
    state.scanOffset = 0
  }

  const merged = mergeCompilationOutputs(state.windowOutputsByIndex.filter((o): o is CompilationOutput => o !== null))
  if (merged.items.length === 0) {
    // AI 无产出 → 本地降级（复用已创建的汇编）；清除断点
    resumeStore.delete(compilationId)
    return finalizeCompilationLocalInto(state.compilationId, state.chunks)
  }

  // 整合提取阶段：续跑未完成的批次（已完成批次的段落草稿保留在 state.extractDrafts 中）
  if (state.phase === 'extract') {
    const prExtract = await runWithRateLimitAutoResume(
      state,
      (s, p) => runExtractPhase(s, merged.items, p),
      onProgress,
      onAdvice
    )
    if (prExtract === 'interrupted') {
      await persistPartialCompilation(state)
      return interruptedResult(state)
    }
    state.phase = 'contradiction'
  }
  const paragraphs = state.extractedParagraphs ?? []
  // 窗口级矛盾的说法映射到最终段落文本（内容被裁掉的整组丢弃）
  const windowGroups = mapWindowGroupsThroughExtract(merged.contradictions, merged.items, paragraphs)

  const pr = await runWithRateLimitAutoResume(
    state,
    (s, p) => runContradictionPhase(s, paragraphsToScanItems(paragraphs, state.refs), p),
    onProgress,
    onAdvice
  )
  if (pr === 'interrupted') {
    await persistPartialCompilation(state)
    return interruptedResult(state)
  }
  resumeStore.delete(compilationId)
  return await finalizeCompilationInto(
    state.compilationId,
    { paragraphs, contradictions: mergeContradictionGroups(windowGroups, state.scanGroups) },
    state.refs,
    state.chunks.length,
    state.scanIncomplete ? { ok: false, message: state.scanIncomplete.message } : { ok: true },
    {
      ok: !state.extractIncomplete,
      message: state.extractIncomplete?.message,
      ...(state.extractStats ?? {})
    },
    onProgress,
    state.convergence ?? null
  )
}

/* ------------------------------ 单测 ------------------------------ */

if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  describe('compilation prompts carry the full user requirement (2026-10-03 用户裁定)', () => {
    const REQUIREMENT =
      '标题为“高中学校设置”，包括学校的新建、扩建、改建、合并、规模、招生人数、地理分布等等，注意，这只能包含长乐区的内容，哪些全省性的综述不必纳入资料汇编中'

    it('窗口细读：系统提示词与用户提示词都完整带上用户要求原文，并把它当硬判据', () => {
      const sys = buildSystemPrompt(REQUIREMENT)
      expect(sys).toContain(REQUIREMENT)
      expect(sys).toContain('【用户的撰写要求（原文，必须逐条遵守，是本次筛选的首要依据）】')
      // 范围外直接跳过（而不是"不确定一律保留"）
      expect(sys).toContain('不在用户要求所限定范围内的条目，**直接跳过**')
      expect(sys).toContain('全省、全国层面的政策解读')
      // 范围之内仍然宁多勿漏
      expect(sys).toContain('**在范围之内**拿不准是否相关时，一律保留')

      const user = buildUserPrompt(
        [{ sourceId: 's1', sourceTitle: '长乐年鉴2021', position: '', text: '甲段', score: 1 }],
        [{ index: 1, sourceId: 's1', title: '长乐年鉴2021' }],
        REQUIREMENT
      )
      expect(user).toContain(REQUIREMENT)
      expect(user).toContain('【用户的撰写要求（原文，必须逐条遵守）】')
      expect(user).toContain('范围之外的内容')
    })

    /*
     * 2026-10-05 用户裁定（P0-1）：**来源发布时间必须作为证据进入细读提示词**。
     * 旧提示词只给「编号 + 《标题》」，模型看不到"这是网页、发布于某日"，正文写「近日」时就无处可依。
     */
    it('窗口细读：文件清单与逐条材料都带上「网页 + 发布时间」，没有发布时间的如实不写', () => {
      const refs: SourceRefEntry[] = [
        { index: 1, sourceId: 's1', title: '长乐年鉴2019', kind: 'file' },
        { index: 2, sourceId: 's2', title: '全区教育工作会议召开', kind: 'url', publishedAt: '2021-05-06T00:00:00.000Z' },
        { index: 3, sourceId: 's3', title: '没有日期的网页', kind: 'url' }
      ]
      const chunks: RetrievedChunk[] = [
        { sourceId: 's2', sourceTitle: '全区教育工作会议召开', position: '第1段', text: '甲段', score: 1, sourceKind: 'url', sourcePublishedAt: '2021-05-06T00:00:00.000Z' },
        { sourceId: 's3', sourceTitle: '没有日期的网页', position: '第1段', text: '乙段', score: 1, sourceKind: 'url' }
      ]
      const user = buildUserPrompt(chunks, refs, REQUIREMENT)
      // 文件清单（来源级）
      expect(user).toContain('1. 《长乐年鉴2019》\n')
      expect(user).toContain('2. 《全区教育工作会议召开》（网页，发布时间 2021-05-06）')
      expect(user).toContain('3. 《没有日期的网页》（网页）')
      // 逐条材料（块级）：卡片是整段照抄的，所以元数据必须落在每一行上
      expect(user).toContain('标题：《全区教育工作会议召开》，网页 发布时间 2021-05-06')
      expect(user).toContain('标题：《没有日期的网页》，网页）')
      // 本地文件不写「网页/发布时间」（文件没有"发布时间"这个概念）
      expect(user).not.toContain('《长乐年鉴2019》（网页')
    })

    /*
     * P0-2：卡片 → 候选块的字符区间（生成期记录）。读窗口时把模型卡片对回候选块，
     * 拿"块起点 + 块内偏移"，**不重新扫正文**。
     */
    it('locateCardRange：整段照抄 → 块内偏移；空白差异也能对上；跨块取并集；对不上就不给区间', () => {
      const chunks: RetrievedChunk[] = [
        { sourceId: 's1', sourceTitle: '年鉴', position: '第1段', text: '前言与凡例。', score: 1, charStart: 0, charEnd: 6 },
        {
          sourceId: 's1',
          sourceTitle: '年鉴',
          position: '第2段',
          text: '2018 年，全区普通高中招生录取 4123 人。',
          score: 1,
          charStart: 100,
          charEnd: 125
        }
      ]
      // 卡片是第 2 段的头 9 个字（`2018 年，全区`）→ 区间 = 块起点 100 .. 100 + 9
      expect(locateCardRange('2018 年，全区', chunks)).toEqual({ charStart: 100, charEnd: 109 })
      // 卡片含排版空格差异 → 仍能命中：区间覆盖**原文**整块（块长 25 字，取回原文即整段原文）
      expect(locateCardRange('2018年，全区普通高中招生录取4123人。', chunks)).toEqual({ charStart: 100, charEnd: 125 })
      // 卡片合并了两个连续块 → 取并集（覆盖两块的完整区间）
      expect(locateCardRange('前言与凡例。2018 年，全区普通高中招生录取 4123 人。', chunks)).toEqual({
        charStart: 0,
        charEnd: 125
      })
      // 模型改写过的卡片对不上任何块 → **不给区间**（落锚点时回退逐字匹配）
      expect(locateCardRange('该区高中招生人数创下新高。', chunks)).toBeUndefined()
      // 没有区间的候选块也参与不了（老链路）→ 同样如实缺省
      expect(locateCardRange('甲段', [{ sourceId: 's1', sourceTitle: 'x', position: '第1段', text: '甲段', score: 1 }])).toBeUndefined()
    })
  })

  /*
   * PLAN 9.15（2026-10-03 用户实测反馈）：**「生成完成」返回时锚点必须已经落库**。
   * 缺陷原状：`persistDocument` 里是 `void attachAnchorsQuietly(...)`（纯 fire-and-forget），
   * 于是刚生成完前端立刻取到的汇编还没有锚点 → 点小圆标一律"未记录来源位置"，
   * 必须切走再切回来（重新取数）才正常。这条测试用内存库把"返回即查"钉住。
   */
  describe('anchors are persisted before generation completes (PLAN 9.15)', () => {
    let db: Database.Database
    beforeAll(() => {
      db = new Database(':memory:')
      setDb(db)
      runMigrations(db)
      db.prepare("INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t1','任务','{\"all\":true}')").run()
      db.prepare(
        "INSERT INTO compilations (id, task_id, title, status, created_at, updated_at) VALUES ('c1','t1','汇编','drafting','2026-10-03','2026-10-03')"
      ).run()
      db.prepare(
        "INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s1','file','长乐年鉴2023','2022 年，长乐区普通高中招生录取 4123 人。','ready')"
      ).run()
      // 块表：整段正文属于第 216 页
      db.prepare(
        "INSERT INTO source_blocks (source_id, block_index, char_start, char_end, page, label, created_at) VALUES ('s1',0,0,40,216,NULL,'2026-10-03')"
      ).run()
    })
    afterAll(() => db.close())

    it('finalizeCompilationInto 返回时，锚点行已存在且能说出页码', async () => {
      const paragraphs: AssembledParagraph[] = [
        {
          text: '2022 年，长乐区普通高中招生录取 4123 人。',
          sourceId: 's1',
          ordinal: 1,
          evidence: '长乐区普通高中招生录取 4123 人',
          timeLabel: '2022 年',
          timeConfidence: 'exact',
          origin: 'generate',
          revision: 0,
          kind: 'paragraph',
          kept: true,
          parentIndex: 0
        }
      ]
      const refs: SourceRefEntry[] = [{ index: 1, sourceId: 's1', title: '长乐年鉴2023' }]
      await finalizeCompilationInto('c1', { paragraphs, contradictions: [] }, refs, 0, { ok: true })

      const rows = db
        .prepare(
          `SELECT a.block_index AS blockIndex, b.page AS page
             FROM compilation_item_anchors a
             JOIN compilation_items i ON i.id = a.item_id
             LEFT JOIN source_blocks b ON b.source_id = a.source_id AND b.block_index = a.block_index
            WHERE i.compilation_id = 'c1'`
        )
        .all() as { blockIndex: number; page: number | null }[]
      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({ blockIndex: 0, page: 216 })
    })

    /*
     * 2026-10-05 用户裁定（P0-2 端到端）：段落带着**生成期记录的字符区间**一路走到落库，
     * 即使它的 `evidence` 无法在来源正文里逐字命中（真实故障形态：证据串混进页眉噪声），
     * 仍然必须给出页码——这正是用户实测"2/86 段未记录来源位置、要自己翻 PDF"要根治的那一条。
     */
    it('段落带生成期字符区间时，即使证据串命中不了也能说出页码', async () => {
      db.prepare(
        "INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s2','file','年鉴乙','2021 年，长乐区新增公办高中学位 800 个。','ready')"
      ).run()
      // 块表：整段属于第 88 页
      db.prepare(
        "INSERT INTO source_blocks (source_id, block_index, char_start, char_end, page, label, created_at) VALUES ('s2',0,0,25,88,NULL,'2026-10-05')"
      ).run()
      const paragraphs: AssembledParagraph[] = [
        {
          text: '2021 年，长乐区新增公办高中学位 800 个。',
          sourceId: 's2',
          ordinal: 1,
          // 证据串里插了页眉噪声字符 → 逐字与归一化都命中不了
          evidence: '长乐区新增公办高中学位 800 ★ 个',
          charStart: 5,
          charEnd: 20,
          timeLabel: '2021 年',
          timeConfidence: 'exact',
          origin: 'generate',
          revision: 0,
          kind: 'paragraph',
          kept: true,
          parentIndex: 0
        }
      ]
      await finalizeCompilationInto('c1', { paragraphs, contradictions: [] }, [{ index: 1, sourceId: 's2', title: '长乐年鉴乙' }], 0, {
        ok: true
      })
      const row = db
        .prepare(
          `SELECT a.confidence AS confidence, b.page AS page
             FROM compilation_item_anchors a
             JOIN compilation_items i ON i.id = a.item_id
             LEFT JOIN source_blocks b ON b.source_id = a.source_id AND b.block_index = a.block_index
            WHERE i.compilation_id = 'c1' AND i.source_id = 's2'`
        )
        .get() as { confidence: string; page: number | null } | undefined
      expect(row).toEqual({ confidence: 'exact', page: 88 })
    })
  })
}
