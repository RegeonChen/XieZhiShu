/**
 * extract-service.ts —— 资料「整合提取」阶段（Phase 7.2，2026-09-10）。
 *
 * 位置：`AI 分窗细读（筛选） → 整合提取 → 卡片矛盾扫描（→ 落库）`。
 * 本阶段**取代原「提纯」+「修正」两个阶段**（用户 2026-09-10 裁定 D1）：
 * 旧管线为了保住文本整体性而禁止模型裁剪/组织，导致每段掺入大量与主题无关的内容；
 * 现在放宽限制，允许模型主动**裁剪 + 补全 + 整合**，产出可直接写进志稿的段落。
 *
 * 自由度换来的是幻觉风险，因此本阶段配本地校验（见 compilation-document 与 PLAN 9.13）：
 * ① 正文非空；
 * ② **逐句事实核验**：每个"带数字或《引用》"的句子都要能在来源里找到依据（数字支持亿/万折算、
 *    中文数字、量级舍入容差；比对范围是**该来源完整正文**）。`evidence` 能逐字命中就带上，
 *    命中不了**不再判失败**（`evidenceLoose`）——这一步的任务就是压缩重写，证据只是充分度之一；
 * ③ 每段**单一来源**（禁止跨来源拼接）。
 *
 * 任一条不过 → **只保留逐字证据片段，没有就丢弃**（`degradeToEvidenceOnly`，2026-10-03 用户裁定 A1）：
 * 实测教训是"可核验 ≠ 相关"——按句保留卡片原文会把年鉴的概况段/项目表/其它领域数据搬进汇编
 * （一次生成里 69 段有 25 段是来源逐字原文、11 段含跑题词）。**绝不原样搬运卡片原文。**
 *
 * 模型输出异常时（2026-10-03 用户裁定 B）：换温度重试 → **对半递归重试** → 单卡仍失败才丢弃；
 * 并把模型可能写出的引用形式（`c12` / `12` / `来源3`）映射回 `#N`，避免"整批被判解析失败"。
 *
 * 另外两条硬约束（写进提示词 + 由结构保证）：
 * - **不得合并互相矛盾的说法**：冲突必须保留为不同段落，交给随后的矛盾扫描（否则"自由整合"会把矛盾抹平）；
 * - 每段必须给出含 4 位年份的 `timeLabel`；确实推断不出时照原文写法给出，由本地标为 `unknown`（界面「时间待核」）。
 */
import { ErrorCodes } from '../../shared/types'
import type { CompilationTimeConfidence } from '../../shared/types'
import { chatCompletion, type ChatMessage } from '../llm/chat'
import { logMain } from '../logger'
import {
  isTitleOnlyParagraph,
  isYearSupportedBySource,
  locateVerbatim,
  validateExtractedParagraph,
  withFallbackYear,
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
  /** 来源类型（file/url）与网页发布时间：段首时间兜底的依据选择（网页不能用年鉴 −1 规则） */
  sourceKind?: 'file' | 'url'
  sourcePublishedAt?: string
}

/** 一批的产出：已校验（或降级）的段落草稿 */
export interface ExtractedDraft {
  /** 来源卡片（回填 sourceId/sourceTitle 用） */
  parentIndex: number
  /** 段落正文（不含段首时间） */
  text: string
  timeLabel?: string
  /** 时间可信度：exact=原文明确；inferred=按来源标题兜底推断（年鉴年份 −1）；unknown=仍未确定 */
  timeConfidence?: CompilationTimeConfidence
  evidence?: string
  /** true = 校验未通过、已降级为原文（只保留**可核验**的内容，见 `degradeKeepingVerifiedContent`） */
  degraded?: boolean
  /** true = 降级时用的是 evidence 片段（粒度最细） */
  degradedFromEvidence?: boolean
  /** 降级时按句保留了 N 句（>0 表示走的是"按句修剪"这条路） */
  degradedKeptSentences?: number
  /** true = 按句修剪的是**模型自己写的那段**（而非卡片原文） */
  degradedPrunedFromModel?: boolean
}

export interface ExtractBatchStats {
  input: number
  inputChars: number
  /** 模型返回的段落条数 */
  returned: number
  /** 通过全部本地校验的段落数 */
  accepted: number
  /** 校验失败而降级的段落数 */
  unverified: number
  /** 其中因"数字在来源中找不到"降级（幻觉嫌疑） */
  invalidNumbers: number
  /** 其中因"证据引文不是原文"降级 */
  invalidEvidence: number
  /** 2026-10-03：evidence 不是逐字命中但**事实逐句核验通过**而接受的段数（证据已从门槛降为充分度） */
  evidenceLoose: number
  emptyText: number
  /** 兜底时只保留 evidence 片段（粒度最细）的段数 */
  degradedFromEvidence: number
  /** 因"没有可用的逐字证据"（含模型未作答、整批输出无法解析）而**丢弃**的卡片数 */
  droppedUnverifiable: number
  /** 因"输出无法解析/模型未作答且无法再拆分重试"而丢弃的卡片数（B：对半重试之后的残余） */
  droppedUnparseable: number
  /** 模型判定"该卡片与主题无关"而整体丢弃的卡片数 */
  droppedCards: number
  /** 模型始终未回答的卡片数（重问后仍未答） */
  omitted: number
  retainedChars: number
  retried: number
  /** 因"段落只是复述来源标题"而丢弃的段落数（2026-09-12：绝不能只看文章标题） */
  titleOnlyDropped: number
  /** 因"年份在该来源里查不到、也推不出"而降级为「时间待核」的段落数 */
  timeUnsupported: number
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
    evidenceLoose: 0,
    emptyText: 0,
    degradedFromEvidence: 0,
    droppedUnverifiable: 0,
    droppedUnparseable: 0,
    droppedCards: 0,
    omitted: 0,
    retainedChars: 0,
    retried: 0,
    titleOnlyDropped: 0,
    timeUnsupported: 0
  }
}

export interface ExtractBatchOutcome {
  ok: boolean
  drafts: ExtractedDraft[]
  stats: ExtractBatchStats
  message?: string
  rateLimited?: boolean
}

/** 整阶段汇总（落库前透出给前端生成汇总与诊断日志） */
export interface ExtractScanStats {
  inputCards: number
  outputParagraphs: number
  inputChars: number
  outputChars: number
  /** 通过本地校验的段落数 */
  accepted: number
  /** 校验失败而降级的段落数 */
  degraded: number
  /** 降级原因细分：数字在来源中找不到（幻觉嫌疑） */
  invalidNumbers: number
  /** 降级原因细分：证据引文不是原文（2026-10-03 起不再是失败原因，恒为 0；见 evidenceLoose） */
  invalidEvidence: number
  /** 2026-10-03：证据未逐字命中、但事实逐句核验通过而接受 */
  evidenceLoose?: number
  /** 兜底粒度细分：只保留 evidence 片段 */
  degradedFromEvidence?: number
  /** 因"没有可用的逐字证据"而丢弃的卡片数（不再灌卡片原文） */
  droppedUnverifiable?: number
  /** 因"输出无法解析/模型未作答且无法再拆分重试"而丢弃的卡片数 */
  droppedUnparseable?: number
  /** 模型判定与主题无关而整卡丢弃 */
  droppedCards: number
  /** 模型始终未回答的卡片数（重问后仍未答） */
  omitted: number
  /** 因"段落只是复述来源标题、没有正文信息"而丢弃的段落数（2026-09-12：绝不能只看文章标题） */
  titleOnlyDropped?: number
  /** 因"年份在来源里查不到、也推不出"而降级为「时间待核」的段落数 */
  timeUnsupported?: number
  /** 成文阶段被判定为重复而合并掉的段数 */
  duplicatesDropped: number
  /** 「疑似同一事实但数字不一致」而特意保留的段数（矛盾候选） */
  conflictsKept: number
  /** 其中**跨来源**合并掉的段数（Phase 7.12：这些段的并列来源已同步标出，圆标会显示两个编号） */
  crossSourceMerged?: number
  /** 其中由「包含关系」判定合并掉的段数（Phase 7.12 S1 新增规则） */
  containmentMerged?: number
  retried: number
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

/**
 * B2（2026-10-03 用户裁定）：**把模型写出的引用形式映射回 `#N`**。
 * 卡片在提示词里同时给了 `[#3]` 与 `（引用号 c12）`，模型经常写成 `c12`、`12`、`#12`、`来源3`。
 * 旧实现只认真实的 `#N`：一旦写成别的形式，整批就被判"解析失败"→ 全部卡片走兜底（实测一次丢了 30 张）。
 * 这里做纯文本归一：命中卡片 `key`（c12）或数字编号即改写为其 `sourceRef`；对不上的原样保留（后续按幻觉忽略）。
 */
export function normalizeExtractRefs<P extends { sourceRef: string }, D extends { sourceRef: string }>(
  parsed: { paragraphs: P[]; dropped: D[] },
  cards: ExtractCandidate[]
): void {
  const byKey = new Map(cards.map((c) => [c.key.toLowerCase(), c.sourceRef]))
  const byRefNumber = new Map(cards.map((c) => [c.sourceRef.replace(/^#/, ''), c.sourceRef]))
  const fix = (raw: string): string => {
    const s = (raw ?? '').trim().replace(/\s+/g, '')
    if (!s) return raw
    if (byKey.has(s.toLowerCase())) return byKey.get(s.toLowerCase())!
    const bare = s.replace(/^[#＃]/, '').replace(/^(来源|卡片|引用号?)/, '')
    if (byRefNumber.has(bare)) return byRefNumber.get(bare)!
    if (byKey.has('c' + bare)) return byKey.get('c' + bare)!
    return raw
  }
  for (const p of parsed.paragraphs) p.sourceRef = fix(p.sourceRef)
  for (const d of parsed.dropped) d.sourceRef = fix(d.sourceRef)
}
/**
 * B3：解析失败的**结构化诊断**（只记结构与编号，不记正文——遵守"日志不写资料正文"的约定）。
 * 用来区分"输出被截断"与"引用号写错"这两类完全不同的故障。
 */
export function describeExtractOutput(
  text: string,
  cards: ExtractCandidate[]
): { chars: number; hasJson: boolean; refsSeen: string[]; expected: string } {
  const raw = String(text ?? '')
  const refs = [...raw.matchAll(/["']?(?:sourceRef|source)["']?\s*:\s*["']([^"']{1,20})["']/g)].map((m) => m[1])
  return {
    chars: raw.length,
    hasJson: raw.includes('{'),
    refsSeen: [...new Set(refs)].slice(0, 12),
    expected: cards.length > 0 ? cards[0].sourceRef + '…' + cards[cards.length - 1].sourceRef + '（' + cards.length + ' 张）' : '（空批）'
  }
}

/**
 * 提示词：自由整合 + 三道校验对应的硬性要求。
 *
 * 2026-10-03（用户裁定）：用户那条撰写要求**原文**必须完整交给模型，并作为**细筛 / 整合 / 提取的关键依据**。
 * 此前只把它当《标题》用（`topic`），范围限定（地域 / 层级 / 时间跨度 / 对象）与"不必纳入"的排除项
 * 没成为硬判据——实测一份 38 个来源的汇编里 9 个省级/国家层面来源全部进了汇编。
 * 现在：`topic` 仍是短标题（用于《》），`requirement` 是用户要求全文（独立成块 + 单列一条判据）。
 */
export function buildExtractMessages(batch: ExtractCandidate[], topic: string, requirement?: string): ChatMessage[] {
  const req = (requirement ?? '').trim()
  const cardList = batch
    .map((c) => '[' + c.sourceRef + ']（引用号 ' + c.key + '） 来源：《' + (c.sourceTitle || c.sourceRef) + '》 时间：' + (c.ts ?? '无') + '\n原文：\n' + c.excerpt)
    .join('\n\n')
  const sys = [
    '你是一名地方志资料编辑，正在为一部题为《' + topic + '》的志稿整理素材。',
    '',
    ...(req
      ? [
          '【用户的撰写要求（原文，必须逐条遵守，是本次筛选与整合的首要依据）】',
          req,
          ''
        ]
      : []),
    '下面每张【资料卡片】都是从来源文献中整段摘出的，其中只有一部分内容与本次主题有关。',
    '请把它们**加工成可以直接写进志稿的段落**：删掉与主题无关的内容，把同一张卡片里相关的表述整合成通顺、完整、自包含的段落。',
    '',
    '【判定标准】设想这段文字要写进《' + topic + '》的志稿正文：',
    '- 保留：直接记述本主题下的对象、时间、地点、数量、事件、措施、结果等事实；',
    '- 删除：虽与主题同属一个大领域，但对象、学段或业务不是本次主题所要求的（例如主题限定某一学段时，卡片讲的却是同一领域下的其它学段、其它业务、其它对象）；',
    '- 删除：本地其它行业、其它部门、其它工作的内容。',
    /*
     * 用户要求是首要依据：范围限定（地域/层级/时间跨度/对象）与"不必纳入"的排除项都算硬判据。
     * 这条不能只写在《标题》里——实测那样挡不住省级/国家层面的综述。
     */
    '- **删除：超出用户撰写要求所限定范围的内容**——包括地域、层级、时间跨度、对象范围。例如用户写明「只能包含某区的内容、全省性的综述不必纳入」时，全省/全国层面的政策解读、工作部署、其它市县的同类做法与统计数据**一律删除**；用户点明「不必纳入」的内容同样删除。',
    '当「与主题同属一个大领域」和「用户要求」冲突时，**以用户要求为准**。',
    '判断依据是「志稿正文会不会用到它」，而不是「它与主题有没有一点点关系」。',
    '',
    '【硬性要求】',
    '0. **绝不能只复述文章标题**：段落正文必须来自卡片正文，并至少给出一个正文里的具体要素（机构/学校全称、数量或规模、金额、地点、时间、事件结果等）。只把标题换个说法写一遍（例如标题写「长乐新添一所普通高中！将于9月开学！」，段落就写「长乐新添一所普通高中，将于9月开学。」）**不合格**——这种情况要么从正文里写出关键信息，要么把这张卡片放进 `dropped`。',
    '1. **忠于原文事实**：数字、日期、人名、地名、机构名一律照抄原文，不得改写、不得推算、不得编造；不得改变原文的结论。',
    '2. **每段只能来自一张卡片**（即一个来源）：不得把不同卡片的文字拼成一段；不同来源的内容必须分成不同段落。',
    '3. 允许的加工：删掉无关内容；在同一张卡片内部调整语序、合并同一事实的多句表述、把省略的主语或指代补全（「他」「该校」→ 具体人名/校名）；去掉或改写「【概况】」这类栏目名。**允许压缩概括，但主体名称与规模/数量/金额/地点/时间等关键要素不得丢失**（例如「福州市福外高级中学…设计规模为高中3个年级60个班，可容纳3000名学生…总投资约6亿元，占地142亩」不能压缩成「长乐新添一所普通高中」）。',
    '4. **不得合并互相矛盾的说法**：若两张卡片（或同一卡片内两处）对同一事实给出不同数字、时间或说法，必须**分别保留为不同段落**，不要取其中一种，也不要折中。',
    '5. 每段必须给出 `timeLabel`（段首时间，**必须含 4 位年份**，如「2018 年」「2018 年 5 月」「2018 年 5 月 19 日」；不要写「5 月 19 日」这种缺年份的写法）：依据正文、卡片时间与来源文献年份推断（**年鉴惯例**：来源为《长乐年鉴2019》时，其正文通常记述 2018 年，即年鉴年份减 1）。确实推断不出年份时也必须给出一个含年份的时间（按上述惯例推定），不要留空。**年份必须有依据**：正文里没写、也推不出来的年份，本地校验会把它降级成「时间待核」，所以不要凭印象填年份。',
    '6. 每段必须给出 `evidence`：从该卡片原文中**逐字连续**摘出的一段（不得改写、不得拼接、不得跨卡片拼），作为这段的事实依据。',
    '   · `evidence` 只需覆盖本段的**关键事实**（机构名/数量/时间/地点那一句），**不必覆盖全文**，也不必等于整段正文；',
    '   · 「关键事实」指数字与《文件/文章名》：**每个数字都必须能在该来源原文里找到**（本地会逐句核验）；',
    '   · 与主题无关的数字（文号、电话、页码、字号、其它年份、其它单位的数据）**请直接删掉**——删掉不会导致校验失败；',
    '   · 数字允许**等价改写**：`5.09 亿元` 与 `50900 万元`、`1.2 万` 与 `12000`、`三十所` 与 `30 所` 视为一致，',
    '     四舍五入到更少位（如 `约 5.1 亿元`）也可接受；但不得改动数值本身、不得推算合计。',
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
      '），保留证据片段 ' +
      stats.degradedFromEvidence +
      ' 段，整卡丢弃 ' +
      stats.droppedCards +
      '，漏答 ' +
      stats.omitted +
      '，因无依据丢弃 ' +
      stats.droppedUnverifiable +
      ' 张（其中输出无法解析 ' +
      stats.droppedUnparseable +
      ' 张），重试 ' +
      stats.retried
  )
}

// ---------------------------------------------------------------- 批次处理（核心，可测试）

/**
 * 兜底（2026-09-10 收窄粒度 → 2026-10-03 用户裁定 A1）：
 *
 * **只保留"逐字证据片段"，没有就丢弃——绝不原样搬运卡片原文。**
 *
 * 为什么再改（真实数据）：某次生成有 **30 张卡（21%）** 因"整批输出无法解析 / 模型漏答"落入兜底，
 * 而当时的按句保留**只检查"句子里的数字能在来源里找到"、完全不看主题**，于是年鉴的
 * 「【概况】各类学校 217 所…」「项目表（含幼儿园/小学）」「【老区扶贫建设】…」被原样搬进汇编
 * （实测 69 段里 25 段是来源逐字原文、其中 11 段含跑题词）。**可核验 ≠ 相关**，这条路径必须收死。
 *
 * 现在的行为：
 *  ① `evidence` 能在**证据真正所属的那张卡**里逐字定位 → 只保留该片段（并写回 `evidence` 供来源定位）；
 *  ② 定位不到（含模型没给 evidence、或整批解析失败/漏答而无模型输出）→ **丢弃该卡**
 *     （计入 `droppedUnverifiable`），材料仍在库里，由"重新生成"或对话里的查漏补缺再取。
 * 保留的片段仍要过另外两道硬校验（标题型丢弃 / 年份无据标待核）。
 */
function degradeToEvidenceOnly(
  cards: ExtractCandidate[],
  evidence: string | undefined,
  stats: ExtractBatchStats
): ExtractedDraft | null {
  const ev = (evidence ?? '').trim()
  if (ev) {
    const owner = cards.find((c) => locateVerbatim(c.excerpt, ev) !== null)
    if (owner) {
      const located = locateVerbatim(owner.excerpt, ev)!
      const slice = owner.excerpt.slice(located.start, located.end)
      const d = degradedChecked(owner, slice, stats)
      if (d) {
        stats.degradedFromEvidence += 1
        // 证据片段本身就是逐字原文 → 顺手写回 evidence，让这段仍能拿到来源定位（Phase 9）
        return { ...d, degradedFromEvidence: true, evidence: slice }
      }
      return null // 标题型内容 → degradedChecked 已计 titleOnlyDropped
    }
  }
  stats.droppedUnverifiable += 1
  return null
}

/**
 * 降级保留（evidence 片段）**并做同样的两道硬校验**（纯函数）：
 * 标题型段落无新信息 → 直接丢弃；年份无据 → 标「时间待核」。返回 null 表示该卡片被丢掉。
 * 文本已由 `degradeKeepingVerifiedContent` 定位好，这里只负责组稿、段首时间兜底与这两道校验。
 */
function degradedChecked(candidate: ExtractCandidate, text: string, stats: ExtractBatchStats): ExtractedDraft | null {
  const time = withFallbackYear(candidate.ts, candidate.sourceTitle, {
    kind: candidate.sourceKind,
    publishedAt: candidate.sourcePublishedAt
  })
  const d: ExtractedDraft = {
    parentIndex: candidate.index,
    text,
    timeLabel: time.timeLabel,
    timeConfidence: time.timeConfidence,
    degraded: true
  }
  if (isTitleOnlyParagraph(d.text, candidate.sourceTitle)) {
    stats.titleOnlyDropped += 1
    return null
  }
  const matched = (d.timeLabel ?? '').match(/(?:18|19|20)\d{2}/)
  const supported = isYearSupportedBySource(matched ? Number(matched[0]) : undefined, {
    text: candidate.excerpt,
    title: candidate.sourceTitle,
    kind: candidate.sourceKind,
    publishedAt: candidate.sourcePublishedAt
  })
  if (!supported) {
    stats.timeUnsupported += 1
    return { ...d, timeConfidence: 'unknown' }
  }
  return d
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
  stats: ExtractBatchStats,
  /**
   * 来源编号 → **该来源的完整正文**（2026-10-03 用户裁定：③ 的比对范围不该只是"本批卡片"，
   * 从同一来源未被成卡的部分引用的数字同样有据）。缺省时回退为"该来源本批卡片拼接"。
   */
  fullSourceTextByRef?: Map<string, string>
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
    // ③ 的比对范围 = 该来源**完整正文**（有则用），否则回退为本批卡片拼接
    const sourceText = fullSourceTextByRef?.get(draft.sourceRef) || group.map((c) => c.excerpt).join('\n')
    const validation = validateExtractedParagraph(draft, sourceText)
    if (!validation.ok) {
      stats.unverified += 1
      const reason: ParagraphRejectReason = validation.reason
      if (reason === 'number-not-in-source') stats.invalidNumbers += 1
      else if (reason === 'evidence-not-found') stats.invalidEvidence += 1
      else stats.emptyText += 1
      // 兜底（2026-10-03 用户裁定 A1）：**只保留逐字证据片段，没有就丢弃**——
      // 绝不原样搬运卡片原文（"可核验 ≠ 相关"，实测正是这条把年鉴的概况/项目表/扶贫段搬进了汇编）。
      const fallback = degradeToEvidenceOnly(group, (draft.evidence ?? '').trim() || undefined, stats)
      if (fallback) drafts.push(fallback)
      continue
    }
    // 段落归属：优先归到 evidence 所在的那张卡片（用于矛盾说法映射与诊断），否则归该来源第一张
    const evidence = (draft.evidence ?? '').trim()
    const parent = (evidence ? group.find((c) => locateVerbatim(c.excerpt, evidence) !== null) : undefined) ?? group[0]
    /*
     * 硬校验一（2026-09-12 用户实测后新增）：**不得只复述文章标题**。
     * 真实案例：某段正文与来源标题几乎一致，正文里的校名/规模/投资/地点全被丢掉；
     * 这类段落不提供任何新信息（且常伴随编造年份），直接丢弃并计入诊断。
     */
    if (isTitleOnlyParagraph(validation.text, parent.sourceTitle)) {
      stats.titleOnlyDropped += 1
      continue
    }
    // 段首时间兜底：模型没给年份时按来源推断（年鉴类标题 −1；网页标题/发布时间按原样，标为 inferred）
    const time = withFallbackYear(validation.timeLabel, parent.sourceTitle, { kind: parent.sourceKind, publishedAt: parent.sourcePublishedAt })
    /*
     * 硬校验二：**时间必须有据**。模型给的年份若在该来源里查不到、也不等于来源推测年份
     * （年鉴 −1 / 标题年份 / 网页发布时间），说明是凭空写的年份，降级为「时间待核」而不是当作 exact。
     */
    const yearSupported = isYearSupportedBySource(time.year, {
      text: sourceText,
      title: parent.sourceTitle,
      kind: parent.sourceKind,
      publishedAt: parent.sourcePublishedAt
    })
    const timeConfidence: CompilationTimeConfidence = yearSupported ? time.timeConfidence : 'unknown'
    if (!yearSupported) stats.timeUnsupported += 1
    stats.accepted += 1
    // 2026-10-03：evidence 不是逐字命中但事实逐句核验通过 → 接受并计数（不再降级）
    if (validation.evidenceLoose) stats.evidenceLoose += 1
    stats.retainedChars += validation.text.length
    drafts.push({
      parentIndex: parent.index,
      text: validation.text,
      timeLabel: time.timeLabel,
      timeConfidence,
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
  temperature: number,
  requirement?: string
): Promise<{ ok: boolean; text: string; message?: string; rateLimited?: boolean }> {
  const result = await chatCompletion(
    provider,
    buildExtractMessages(batch, topic, requirement),
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

/** 单次调用的形状（可注入，供单测/演练模拟"解析失败""漏答"等故障） */
export type ExtractCall = typeof callExtract

/** 拆分重试：少于这么多张就不再拆（单卡仍失败就丢弃） */
const EXTRACT_SPLIT_MIN_CARDS = 4
/** 拆分重试：每个批次最多额外消耗多少次"拆分调用"（成本保险丝） */
const EXTRACT_SPLIT_MAX_CALLS = 4

interface ExtractCtx {
  provider: ExtractProvider
  topic: string
  taskId: string
  requirement?: string
  fullSourceTextByRef?: Map<string, string>
  stats: ExtractBatchStats
  call: ExtractCall
  /** 本批次已消耗的拆分调用数 */
  splitCalls: number
}

type ExtractStepResult = { ok: true; drafts: ExtractedDraft[] } | { ok: false; drafts: ExtractedDraft[]; message: string; rateLimited: boolean }

/**
 * 对一批候选执行整合提取。
 *
 * **B（2026-10-03 用户裁定）：解析失败/漏答时不再"整批兜底"，而是对半递归重试。**
 * 真实数据：某次生成有 30 张卡（21%）因"整批输出无法解析 / 模型漏答"落入兜底，
 * 而兜底会把**卡片原文**搬进汇编（跑题内容随之进入）——一次性丢 30 张的代价太大。
 * 现在的策略：
 * - 首次调用失败（异常/限流）→ `ok:false`（由管线中断并可续跑，语义不变）；
 * - 输出无法解析或引用号全对不上 → 换温度重试一次 → 仍不行则**对半切开分别重试**（递归，最多 4 次拆分调用）；
 * - 模型漏答的卡片 → 先整批重问一次 → 仍漏答则同样对半拆分重试；
 * - 单卡仍失败 → **丢弃该卡**（计入 `droppedUnparseable`），绝不把卡片原文搬进来；
 * - 单段校验失败（事实无据）→ 只保留逐字证据片段，没有则丢弃（见 `degradeToEvidenceOnly`）。
 */
export async function extractBatch(
  provider: ExtractProvider,
  batch: ExtractCandidate[],
  topic: string,
  taskId: string,
  /** 用户撰写要求全文（作为筛选与整合的首要依据，见 `buildExtractMessages`） */
  requirement?: string,
  /** 来源编号 → 该来源完整正文：③ 的比对范围（缺省回退为卡片拼接） */
  fullSourceTextByRef?: Map<string, string>,
  /** 仅供单测/演练注入假的调用实现 */
  deps?: { call?: ExtractCall }
): Promise<ExtractBatchOutcome> {
  const stats = emptyExtractStats(batch.length, batch.reduce((n, c) => n + c.excerpt.length, 0))
  if (batch.length === 0) return { ok: true, drafts: [], stats }
  const ctx: ExtractCtx = {
    provider,
    topic,
    taskId,
    requirement,
    fullSourceTextByRef,
    stats,
    call: deps?.call ?? callExtract,
    splitCalls: 0
  }
  const res = await extractCards(ctx, batch, 0)
  if (!res.ok) return { ok: false, drafts: [], stats, message: res.message, rateLimited: res.rateLimited }
  return { ok: true, drafts: res.drafts, stats }
}

/** 对半拆分（含预算与最小张数判定）；返回 null 表示不再拆 */
function splitHalf(ctx: ExtractCtx, cards: ExtractCandidate[]): [ExtractCandidate[], ExtractCandidate[]] | null {
  if (cards.length < EXTRACT_SPLIT_MIN_CARDS) return null
  if (ctx.splitCalls + 2 > EXTRACT_SPLIT_MAX_CALLS) return null
  ctx.splitCalls += 2
  const mid = Math.floor(cards.length / 2)
  return [cards.slice(0, mid), cards.slice(mid)]
}

async function extractCards(ctx: ExtractCtx, cards: ExtractCandidate[], attempt: 0 | 1): Promise<ExtractStepResult> {
  const knownRefs = new Set(cards.map((c) => c.sourceRef))
  const res = await ctx.call(ctx.provider, cards, ctx.topic, ctx.taskId, attempt === 0 ? 0 : 0.3, ctx.requirement)
  if (!res.ok) return { ok: false, drafts: [], message: res.message ?? '大模型调用异常中断', rateLimited: res.rateLimited === true }

  let parsed = parseExtractOutput(res.text)
  // B2：把模型可能写出的引用形式（c12 / 12 / 来源3）映射回 #N，避免"整批被判解析失败"
  if (parsed) normalizeExtractRefs(parsed, cards)
  const usable = !!parsed && [...parsed.paragraphs, ...parsed.dropped].some((e) => knownRefs.has(e.sourceRef))
  if (!usable) {
    if (attempt === 0) {
      ctx.stats.retried += 1
      const d = describeExtractOutput(res.text, cards)
      logMain('extract', '解析失败（换温度重试）：输出 ' + d.chars + ' 字，含 JSON=' + d.hasJson + '，检出编号 ' + JSON.stringify(d.refsSeen) + '，期望 ' + d.expected)
      return extractCards(ctx, cards, 1)
    }
    const halves = splitHalf(ctx, cards)
    if (halves) {
      logMain('extract', '重试仍无法解析，拆成 ' + halves[0].length + '+' + halves[1].length + ' 张分别重试')
      const a = await extractCards(ctx, halves[0], 1)
      if (!a.ok) return a
      const b = await extractCards(ctx, halves[1], 1)
      if (!b.ok) return b
      return { ok: true, drafts: [...a.drafts, ...b.drafts] }
    }
    ctx.stats.omitted += cards.length
    ctx.stats.droppedUnparseable += cards.length
    logMain('extract', '输出无法解析且无法再拆分，丢弃 ' + cards.length + ' 张卡片（不再把卡片原文搬进汇编）')
    return { ok: true, drafts: [] }
  }

  const { drafts, answered } = collectExtractResults(cards, parsed!, ctx.stats, ctx.fullSourceTextByRef)
  const missing = cards.filter((c) => !answered.has(c.sourceRef))
  if (missing.length === 0) return { ok: true, drafts }

  // 漏答 → 整批重问一次；仍漏答 → 对半拆分重试；单卡仍漏答 → 丢弃
  ctx.stats.retried += 1
  const retry = await ctx.call(ctx.provider, missing, ctx.topic, ctx.taskId, 0.3, ctx.requirement)
  if (!retry.ok) return { ok: false, drafts, message: retry.message ?? '大模型调用异常中断', rateLimited: retry.rateLimited === true }
  let retryParsed = parseExtractOutput(retry.text)
  if (retryParsed) normalizeExtractRefs(retryParsed, missing)
  if (retryParsed && [...retryParsed.paragraphs, ...retryParsed.dropped].some((e) => knownRefs.has(e.sourceRef))) {
    const again = collectExtractResults(missing, retryParsed, ctx.stats, ctx.fullSourceTextByRef)
    drafts.push(...again.drafts)
    for (const ref of again.answered) answered.add(ref)
  }
  const stillMissing = missing.filter((c) => !answered.has(c.sourceRef))
  if (stillMissing.length > 0) {
    const halves = splitHalf(ctx, stillMissing)
    if (halves) {
      logMain('extract', '重问后仍漏答 ' + stillMissing.length + ' 张，拆成 ' + halves[0].length + '+' + halves[1].length + ' 张分别重试')
      for (const half of halves) {
        const r = await extractCards(ctx, half, 1)
        if (!r.ok) return { ok: false, drafts, message: r.message, rateLimited: r.rateLimited }
        drafts.push(...r.drafts)
      }
    } else {
      ctx.stats.omitted += stillMissing.length
      ctx.stats.droppedUnparseable += stillMissing.length
      logMain('extract', '模型未作答且无法再拆分，丢弃 ' + stillMissing.length + ' 张卡片（不再把卡片原文搬进汇编）')
    }
  }
  return { ok: true, drafts }
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
      // 时间必须含年份，且给出年鉴惯例（用户裁定：时间只靠提示词规范，不再本地复核）
      expect(sys).toContain('必须含 4 位年份')
      expect(sys).toContain('年鉴惯例')
      expect(sys).toContain('年鉴年份减 1')
      // 输出格式
      expect(sys).toContain('"paragraphs"')
      expect(sys).toContain('"dropped"')
    })

    it('把用户的撰写要求**全文**作为首要依据给模型，并单列"超出范围"判据（2026-10-03 用户裁定）', () => {
      const requirement =
        '标题为“高中学校设置”，包括学校的新建、扩建、改建、合并、规模、招生人数、地理分布等等，注意，这只能包含长乐区的内容，哪些全省性的综述不必纳入资料汇编中'
      const sys = buildExtractMessages(batch, '高中学校设置', requirement)[0].content
      // 要求原文完整出现（不截断、不改写）
      expect(sys).toContain(requirement)
      expect(sys).toContain('【用户的撰写要求（原文，必须逐条遵守，是本次筛选与整合的首要依据）】')
      // 范围/层级被写进判定标准，且明确"以用户要求为准"
      expect(sys).toContain('超出用户撰写要求所限定范围的内容')
      expect(sys).toContain('以用户要求为准')
      // 《》里用短标题，不再塞整段要求
      expect(sys).toContain('《高中学校设置》')
      expect(sys).not.toContain('《' + requirement + '》')
      // 没传要求时保持旧行为（不出现该区块）
      const legacy = buildExtractMessages(batch, '高中教育')[0].content
      expect(legacy).not.toContain('【用户的撰写要求')
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

    it('证据不再当门槛（2026-10-03）：事实逐句有据就接受，无据才按句修剪', () => {
      const stats = emptyExtractStats(batch.length, 0)
      const { drafts } = collectExtractResults(
        batch,
        {
          paragraphs: [
            // 证据是改写过的（非逐字）→ **不再判失败**：事实逐句核验通过 → 接受并记 evidenceLoose
            { sourceRef: '#1', text: '2018 年，全区普通中学 30 所。', timeLabel: '2018 年', evidence: '全区共有普通中学 30 所' },
            // 编造数字（232 所，卡片里是 212）→ 判为无据；证据能逐字定位 → 只保留证据片段
            { sourceRef: '#2', text: '2020 年，全区幼儿园 232 所。', timeLabel: '2020 年', evidence: '全区幼儿园 212 所' }
          ],
          dropped: []
        },
        stats
      )
      expect(stats.accepted).toBe(1)
      expect(stats.evidenceLoose).toBe(1)
      expect(stats.invalidEvidence).toBe(0)
      expect(stats.unverified).toBe(1)
      expect(stats.invalidNumbers).toBe(1)
      expect(drafts).toHaveLength(2)
      // ① 接受的这段：evidence 被忽略（非逐字），正文原样保留
      expect(drafts[0].degraded).toBeFalsy()
      expect(drafts[0].text).toBe('2018 年，全区普通中学 30 所。')
      expect(drafts[0].evidence).toBeUndefined()
      // ② 无据的那段：证据能定位 → 只保留该片段（粒度最细）
      expect(drafts[1].degraded).toBe(true)
      expect(drafts[1].degradedFromEvidence).toBe(true)
      expect(drafts[1].text).toBe('全区幼儿园 212 所')
      expect(stats.degradedFromEvidence).toBe(1)
      expect(stats.droppedUnverifiable).toBe(0)
    })

    it('③ 的比对范围是**整个来源**，不只是本批卡片（未被成卡的数字同样有据）', () => {
      const stats = emptyExtractStats(batch.length, 0)
      const full = new Map<string, string>([
        ['#1', batch[0].excerpt + batch[1].excerpt + '另据台账，全区另有普通高中 4 所。']
      ])
      const { drafts } = collectExtractResults(
        batch,
        {
          paragraphs: [
            {
              sourceRef: '#1',
              text: '2018 年，全区普通高中 4 所（另见台账）。',
              timeLabel: '2018 年',
              evidence: '全区另有普通高中 4 所'
            }
          ],
          dropped: []
        },
        stats,
        full
      )
      expect(stats.accepted).toBe(1)
      expect(drafts[0].text).toContain('4 所')
      // 不给全来源正文（只有卡片）→ 该数字无据而被判失败
      const stats2 = emptyExtractStats(batch.length, 0)
      const res2 = collectExtractResults(
        batch,
        {
          paragraphs: [
            { sourceRef: '#1', text: '2018 年，全区普通高中 4 所（另见台账）。', timeLabel: '2018 年', evidence: '全区另有普通高中 4 所' }
          ],
          dropped: []
        },
        stats2
      )
      expect(stats2.accepted).toBe(0)
      expect(stats2.invalidNumbers).toBe(1)
      // A1（2026-10-03）：证据在卡片里定位不到 → **丢弃该卡**，不再把卡片原文搬进来
      expect(res2.drafts).toHaveLength(0)
      expect(stats2.droppedUnverifiable).toBe(1)
    })

    it('同一来源多张卡时，降级在**证据所属的那张卡**里定位（修掉写死 group[0] 的缺陷）', () => {
      const stats = emptyExtractStats(batch.length, 0)
      const { drafts } = collectExtractResults(
        batch,
        {
          paragraphs: [
            // 证据只出现在第 2 张卡（c2）里；旧实现会在 c1 里找 → 找不到 → 退回 c1 整段
            { sourceRef: '#1', text: '2018 年，全区教职工 901 人。', timeLabel: '2018 年', evidence: '全区教职工 900 人' }
          ],
          dropped: []
        },
        stats
      )
      expect(drafts).toHaveLength(1)
      expect(drafts[0].degradedFromEvidence).toBe(true)
      expect(drafts[0].text).toBe('全区教职工 900 人')
      expect(drafts[0].text).not.toContain('普通中学')
    })

    it('A1：兜底只保留逐字证据片段，没有就丢弃（绝不搬卡片原文）', () => {
      /*
       * 真实案例（2026-10-03）：某次生成 30 张卡（21%）因"整批输出无法解析 / 模型漏答"落入兜底，
       * 旧实现把卡片原文（年鉴概况段、项目表、扶贫段）搬进汇编 → 跑题内容成片进入。
       * 现在：没有可定位的逐字证据 → 丢弃该卡。
       */
      const page = Array.from({ length: 60 }, (_, i) => `第${i + 1}项工作要求，各地各校要认真落实到位。`).join('')
      const big: ExtractCandidate[] = [
        { index: 0, key: 'c1', sourceRef: '#9', sourceTitle: '福建省2020年普通中小学招生入学政策解读', excerpt: page, ts: '2020 年' }
      ]
      // 模型写的段落含来源里没有的数字（无据）且没给 evidence → 丢弃，不搬卡片原文
      const stats = emptyExtractStats(1, page.length)
      const { drafts } = collectExtractResults(
        big,
        { paragraphs: [{ sourceRef: '#9', text: '全省共 99999 名学生受益。', timeLabel: '2020 年', evidence: '' }], dropped: [] },
        stats
      )
      expect(drafts).toHaveLength(0)
      expect(stats.droppedUnverifiable).toBe(1)
      expect(drafts.every((d) => !d.text.includes('项工作要求'))).toBe(true)
    })

    it('B2：模型写出的引用形式（c12 / 12 / 来源3）会被映射回 #N', () => {
      const parsed = parseExtractOutput(
        '{"paragraphs":[{"sourceRef":"c2","text":"甲","evidence":"甲"},{"sourceRef":"2","text":"乙","evidence":"乙"},{"sourceRef":"#1","text":"丙","evidence":"丙"}],"dropped":[{"sourceRef":"来源3","why":"无关"}]}'
      )!
      normalizeExtractRefs(parsed, batch)
      // c2 → c2 所在卡片（#1）；裸数字 2 → 编号 #2；#1 原样；"来源3" → c3 所在卡片（#2）
      expect(parsed.paragraphs.map((p) => p.sourceRef)).toEqual(['#1', '#2', '#1'])
      expect(parsed.dropped[0].sourceRef).toBe('#2')
      // 对不上的原样保留（后续按幻觉忽略）
      const weird = parseExtractOutput('{"paragraphs":[{"sourceRef":"#99","text":"甲"}]}')!
      normalizeExtractRefs(weird, batch)
      expect(weird.paragraphs[0].sourceRef).toBe('#99')
    })

    it('B3：解析失败的诊断只记结构与编号（不记正文）', () => {
      const d = describeExtractOutput('模型的解释性文字…… {"paragraphs":[{"sourceRef":"c5","text":"x"}]}', batch)
      expect(d.chars).toBeGreaterThan(0)
      expect(d.hasJson).toBe(true)
      expect(d.refsSeen).toContain('c5')
      expect(d.expected).toContain('#1')
      expect(JSON.stringify(d)).not.toContain('模型的解释性文字')
    })

    it('B1：整批输出无法解析时对半重试，最终只丢弃仍失败的那几张卡（不再整批搬运）', async () => {
      const cards: ExtractCandidate[] = Array.from({ length: 8 }, (_, i) => ({
        index: i,
        key: 'c' + (i + 1),
        sourceRef: '#' + (i + 1),
        sourceTitle: '长乐年鉴2023',
        excerpt: '2022 年，长乐区第' + (i + 1) + '项工作完成，投资 ' + (i + 1) + ' 万元。',
        ts: '2022 年'
      }))
      // 假调用：整批（8 张）返回不可解析文本；拆到 4 张及以下正常作答
      const calls: number[] = []
      const fake = (async (_p: unknown, b: ExtractCandidate[]) => {
        calls.push(b.length)
        if (b.length >= 8) return { ok: true, text: '这不是 JSON' }
        return {
          ok: true,
          text:
            '{"paragraphs":[' +
            b
              .map(
                (c) =>
                  '{"sourceRef":"' + c.sourceRef + '","text":"' + c.excerpt + '","timeLabel":"2022 年","evidence":"' + c.excerpt + '"}'
              )
              .join(',') +
            ']}'
        }
      }) as unknown as ExtractCall
      const res = await extractBatch(
        { apiBase: 'x', model: 'm', apiKey: 'k' },
        cards,
        '高中学校设置',
        't1',
        '要求',
        undefined,
        { call: fake }
      )
      expect(res.ok).toBe(true)
      // 8 张 → 尝试整批(8) 失败 → 温度重试(8) 失败 → 拆成 4+4 各一次 → 全部找回
      expect(calls.slice(0, 4)).toEqual([8, 8, 4, 4])
      expect(res.drafts).toHaveLength(8)
      expect(res.stats.droppedUnparseable).toBe(0)
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
