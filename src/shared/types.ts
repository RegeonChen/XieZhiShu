/** 共享领域类型 —— 独立于 UI 组件与具体服务实现 */

// ============================================================
// 资料（文件或信源网址的统一抽象）
// ============================================================
export interface Source {
  id: string
  kind: 'file' | 'url'
  title: string
  filePath?: string // kind=file，dataDir 相对路径（workspace 资料为工作区相对路径）
  url?: string // kind=url
  urlSnapshotAt?: string // 抓取时间 ISO
  /**
   * 文章自身标注/页面解析出的**发布时间**（ISO 或「2021-03-05」样式；仅网页来源会有）。
   * 用途：网页段落正文里没有年份时，作为**年份兜底**的依据（标为 inferred），
   * 见 `inferYearFromSource`（网页文件名的"年鉴惯例 −1"规则**不适用**于网页文章）。
   */
  publishedAt?: string
  cleanedText: string // 清洗后正文
  status: 'pending' | 'processing' | 'ready' | 'failed'
  errorCode?: string
  // Phase 2.2 工作区指纹（文件系统 ↔ 数据库映射锚点）
  contentHash?: string // 文件内容 sha256
  fileMtime?: string // 文件修改时间（ISO）
  fileSize?: number // 文件字节数
  workspace?: boolean // true=直接引用用户工作区文件（不转存副本）
  /** 任务绑定的网页缓存文章（2026-08-13）：非空 = 某任务生成初稿时抓取的网站文章（暂存、不属于长期资料库）；空 = 工作区文件/手动网址 */
  taskId?: string
  /** 网页正文来源（2026-09-12 A2）：extractor=结构化提取器；full-page=整页回退（含模板噪音） */
  textSource?: 'extractor' | 'full-page'
  /** true = 未取到正文（老文章失效、站点返回通用模板页），不参与检索（2026-09-12 A1） */
  bodyMissing?: boolean
  createdAt: string
  updatedAt: string
}

export type SourceStatus = Source['status']

/** 网页资料库站点（2026-08-11）：用户注册的站点，生成初稿时自动发现文章并用撰写要求粗筛、增量抓取正文 */
export interface WebSite {
  id: string
  rootUrl: string
  title: string
  createdAt: string
  updatedAt: string
  lastSyncedAt?: string // 上次同步（发现文章清单）时间
}

// ============================================================
// 标签
// ============================================================
export interface Tag {
  id: string
  name: string
  createdAt: string
}


// ============================================================
// 范本（已废弃，2026-08-13 由「规范 skills」替代；保留类型定义待清理）
// ============================================================
export interface TemplateBook {
  id: string
  name: string
  filePath: string
  outline: string
  styleProfile?: string
  createdAt: string
}

// ============================================================
// 撰写任务
// ============================================================
/** 文件范围：{ all: true } = 资料库（工作区）全部文件（Phase 3.5 起固定）；旧任务保留具体 sourceIds/tagIds */
export type WritingScope = { all: true } | { sourceIds: string[] } | { tagIds: string[] }

/** 撰写任务类型：生成汇编（compile） vs 撰写初稿（draft） */
export type TaskMode = 'compile' | 'draft'

export interface WritingTask {
  /** 任务类型：'compile' = 生成汇编功能区，'draft' = 撰写初稿功能区 */
  mode: TaskMode
  id: string
  /** 中栏列表显示的任务标题（默认"新建任务"，可右键重命名） */
  title: string
  scope: WritingScope
  templateBookId?: string // 已废弃（2026-08-13 由 skillIds 替代）
  /** 任务选定的部类细则规范 skill id 列表；空 = 未手动选定（生成时按标题自动匹配） */
  skillIds?: string[]
  /** 任务固定使用的大模型（未设置时回退全局当前 Provider） */
  llmProviderId?: string
  /** 大模型从用户要求中抓取的文章标题（生成初稿后由大模型返回） */
  articleTitle?: string
  /** 生成初稿时用户的最新要求（重新生成复用） */
  userInstruction?: string
  /** 第二步「添加范本」：用户提供的示例正文（可选，生成初稿时作为参考提交） */
  modelText?: string
  currentVersion: number
  createdAt: string
  updatedAt: string
  /**
   * Phase 10 P5：**该任务**的网页资料年份区间（按发布时间筛选）。
   * 新建任务时继承全局默认值（设置里的 `webYearFrom/webYearTo`）；为空表示"回退全局默认"。
   */
  webYearFrom?: number
  webYearTo?: number
}

// ============================================================
// 志稿与片段
// ============================================================
export interface Draft {
  id: string
  taskId: string
  versionNumber: number // 0 = 初稿（删去版本管理后仅保留初稿）
  status: 'editing' | 'confirmed'
  confirmedAt?: string
  createdAt: string
  segments: Segment[]
}

export interface Segment {
  id: string
  draftId: string
  ordering: number
  heading?: string
  content: string
  aiGenerated: boolean
  createdAt: string
  updatedAt: string
  sources: SegmentSource[]
}

/** 片段-来源 关联（含原文位置标注） */
export interface SegmentSource {
  segmentId: string
  sourceId: string
  position: string // 文件：页码/段落序号；URL：段落序号
  quote?: string // 原文摘句
  sourceTitle?: string // 来源标题（服务端 JOIN 填充，供界面直接展示）
}

/** RAG 检索返回的相关资料片段 */
export interface RetrievedChunk {
  sourceId: string
  sourceTitle: string
  position: string
  text: string
  score: number
  /** 来源类型与发布时间（供段首时间的年份兜底：网页不能用「年鉴 −1」规则） */
  sourceKind?: 'file' | 'url'
  sourcePublishedAt?: string
  /**
   * 该块在来源正文（`sources.cleaned_text`）里的字符区间（左闭右开；2026-10-05 用户裁定 P0-2）。
   *
   * 用途：**生成期就记下"这段话来自哪个字符区间"**，落来源锚点时直接映射 `source_blocks` 得到块号与页码，
   * 不再依赖事后拿逐字证据去来源里 `indexOf` 回溯（那会因页眉噪声/改写而拿不到位置）。
   * 与 `source_blocks.char_start/char_end` 同一坐标系；历史向量块对不上当前切块时**如实缺省**，由 fallback 兜。
   */
  charStart?: number
  charEnd?: number
}

// ============================================================
// 审核记录
// ============================================================
export type ReviewAction = 'conflict' | 'missing' | 'edit' | 'insert'

export interface ReviewRecord {
  id: string
  draftId: string
  segmentId?: string
  action: ReviewAction
  beforeContent?: string
  afterContent?: string
  note?: string
  createdAt: string
}

// ============================================================
// 矛盾检测（Phase 3.7：初稿生成时发现的资料间矛盾）
// ============================================================
/** 矛盾类型：数据 / 时间 / 地点 / 事实经过 / 其他 */
export type ContradictionKind = 'data' | 'time' | 'place' | 'fact' | 'other'
/** 矛盾取舍状态：待处理 / 已采纳某说法 / 已忽略 */
export type ContradictionStatus = 'pending' | 'adopted' | 'ignored'

/** 一条相左"说法"的写入入参（预扫描产出） */
export interface ContradictionVariantInput {
  variantText: string // 该说法原文摘录（≤200 字）
  sourceIds: string[] // 该说法关联的来源文件 id（≥1，支持同主题 3+ 来源）
  position?: string // 原文位置（可选）
}

/** 一个矛盾分组的写入入参（预扫描产出，随初稿落库） */
export interface ContradictionInput {
  seq: number // 生成提示词中的序号 #N（与正文标记【矛盾#N】对应）
  topic: string // 事实主题一句话
  kind?: ContradictionKind
  variants: ContradictionVariantInput[] // ≥2 条相左说法
}

/** 矛盾"说法"（读模型，含来源标题供界面展示） */
export interface ContradictionVariant {
  id: string
  contradictionId: string
  variantText: string
  sourceIds: string[]
  position?: string
  sourceTitles: string[] // 来源标题（服务端 JOIN 填充，缺失时回退为 sourceId）
  /** 定位审查（生成阶段）预生成的"采纳该说法后正文应替换成的文句"；采纳时本地直接替换、不再调用大模型 */
  replacement?: string
}

/** 矛盾分组（读模型） */
export interface Contradiction {
  id: string
  draftId: string
  seq: number
  topic: string
  kind: ContradictionKind
  status: ContradictionStatus
  merged: boolean // 定位审查发现正文自然合并的兜底标记
  draftQuote?: string // 正文中涉及该矛盾的原文原句（定位审查回填，用于正文定位与采纳修订的 from）
  adoptedVariantId?: string // 用户采纳的说法 variant id（status=adopted）
  /** 定位审查是否在正文中发现该矛盾：true=在正文（矛盾）/ false=不在正文（警告）/ undefined=定位审查未执行（未知） */
  inDraft?: boolean
  createdAt: string
  variants: ContradictionVariant[]
}

// ============================================================
// 资料汇编（Phase 6：三段式撰写重构）
// ============================================================

export type CompilationStatus = 'drafting' | 'reviewing' | 'finalized'
export type CompilationContradictionStatus = 'pending' | 'resolved' | 'ignored'

/** 时间可信度（Phase 7.1）：exact=原文明确；inferred=由上下文推断；unknown=未能确定（界面显示「时间待核」） */
export type CompilationTimeConfidence = 'exact' | 'inferred' | 'unknown'
/** 段落的产生方式（用于版本记录的变更来源与审计） */
export type CompilationParagraphOrigin = 'generate' | 'llm-edit' | 'user-edit' | 'contradiction' | 'import'
/** 段落类型：正文段 / 分节标题（按年份分节渲染时使用） */
export type CompilationParagraphKind = 'paragraph' | 'heading'
/** 版本来源（与段落 origin 的差别：多出 restore=恢复到历史版本） */
export type CompilationVersionOrigin = 'generate' | 'llm-edit' | 'user-edit' | 'restore' | 'contradiction' | 'import'

/**
 * 资料卡片 / 段落（Phase 7：资料汇编已由「卡片列表」改为「连续文档」，本类型即文档中的一段）。
 * 兼容期说明：既有字段（excerpt/ts/position/kept…）语义不变，新增字段为**可选**，
 * 因此旧代码（卡片视图）与迁移后的旧数据都能继续工作。
 */
export interface CompilationItem {
  id: string
  compilationId: string
  /** 时间排序位次（= 文档内顺序） */
  position: number
  sourceId: string
  excerpt: string
  /** 时间标签（如「2005 年」/「2005—2010 年」），展示用 */
  ts?: string
  note?: string
  extraTags: string[]
  kept: boolean
  /** 来源标题（服务端 JOIN 填充） */
  sourceTitle?: string
  createdAt: string
  /* ---- Phase 7.1 新增：段落元数据 ---- */
  /** 结构化年份（稳定排序用；缺失表示未能解析出年份） */
  year?: number
  month?: number
  day?: number
  timeConfidence?: CompilationTimeConfidence
  /** 段尾来源圆标数字（指向 CompilationSourceRef.ordinal）；缺省 = 无来源段 */
  sourceOrdinal?: number
  /**
   * 并列来源编号（Phase 7.12「多来源标注」）：同一件事被多个来源分别收录、合并后只留一段时，
   * 记录"另一个来源也记载了这件事"。**升序排列且不含主编号** `sourceOrdinal`。
   * 主来源（= evidence 依据的那一个）仍是 `sourceId`/`sourceOrdinal`，因此
   * 「不得跨来源拼接」（Phase 7.2 裁定 D1）与矛盾归因口径都不变。
   */
  alsoSourceOrdinals?: number[]
  /** 与 `alsoSourceOrdinals` 一一对应的来源 id（文档层与落库回写用） */
  alsoSourceIds?: string[]
  /** 与 `alsoSourceOrdinals` 一一对应的来源标题（服务端 JOIN 填充，界面直接显示） */
  alsoSourceTitles?: string[]
  /** 该段的原文证据引文（逐字校验 + 「查看出处」） */
  evidence?: string
  /**
   * Phase 9 / S4：该段各来源的**定位锚点**（块号 + 页码），由主进程 JOIN `source_blocks` 填充。
   * 只读展示用；老汇编没有锚点（Q4 裁定：如实提示"未记录来源位置"，不做检索兜底）。
   */
  anchors?: CompilationItemAnchor[]
  origin?: CompilationParagraphOrigin
  /** 段级修订号（diff 的辅助键） */
  revision?: number
  kind?: CompilationParagraphKind
}

/**
 * 段落 → 来源位置（Phase 9）：**块号 → 页码**，全程不做文本匹配（卡片被改写也能定位）。
 * `page` 为 null 表示该来源没有页概念（Word/WPS/网页）或页表还没生成 → 界面报"第 N 段"。
 */
export interface CompilationItemAnchor {
  sourceId: string
  /** 该段取自来源正文的第几块（0 起） */
  blockIndex: number
  /** 该块所属页码（1 起）；null = 无页码 */
  page: number | null
  /** 该块在来源正文里的起始字符偏移（无页码时界面据此换算"第 N 段"） */
  charStart: number | null
  /** exact = 引文确实落在该块内；weak = 仅块号可用（位置存疑，界面如实标注） */
  confidence: 'exact' | 'weak'
}

/**
 * 文档中的一段（运行期/版本快照形状；由 CompilationItem 归一而来）
 */
export interface CompilationParagraph {
  id: string
  /** 文档内顺序（0 起） */
  ordinal: number
  text: string
  /** 段首显示时间（应含 4 位年份；未确定时为「时间待核」） */
  timeLabel?: string
  year?: number
  month?: number
  day?: number
  timeConfidence: CompilationTimeConfidence
  /** 段尾来源圆标数字 */
  sourceOrdinal?: number
  /** 主来源 id（= `evidence` 所依据的那一个来源；并列来源不改变它） */
  sourceId?: string
  /** 并列来源编号与 id（Phase 7.12；见 `CompilationItem.alsoSourceOrdinals`） */
  alsoSourceOrdinals?: number[]
  alsoSourceIds?: string[]
  sourceTitle?: string
  evidence?: string
  kind: CompilationParagraphKind
  revision: number
  origin: CompilationParagraphOrigin
  kept: boolean
}

/** 汇编内的来源编号（圆标数字 ↔ 来源） */
export interface CompilationSourceRef {
  id: string
  compilationId: string
  sourceId?: string
  /** 1..N，按文档首次引用顺序；只增不回收 */
  ordinal: number
  title: string
  citedCount: number
}

/** 一次版本变更的统计（供版本列表与差异高亮） */
export interface CompilationChangeSummary {
  added: number
  removed: number
  modified: number
  moved: number
  /** 本次变更涉及（新增或修改）的段落 id */
  paragraphIds: string[]
}

/** 版本摘要（版本下拉列表用，不含正文） */
export interface CompilationVersionSummary {
  id: string
  compilationId: string
  versionNo: number
  origin: CompilationVersionOrigin
  instruction?: string
  reply?: string
  changeSummary: CompilationChangeSummary
  baseVersionNo?: number
  createdAt: string
}

/** 完整版本（含段落快照与 markdown 快照） */
export interface CompilationVersion extends CompilationVersionSummary {
  paragraphs: CompilationParagraph[]
  markdown: string
}

/** 汇编级人机对话消息（悬浮对话框的历史记录） */
export interface CompilationMessage {
  id: string
  compilationId: string
  role: 'user' | 'assistant'
  content: string
  /** 该轮对话产生的版本号（assistant 消息） */
  versionNo?: number
  createdAt: string
}

/** 汇编文档视图（右栏查看器渲染所需的一切） */
export interface CompilationDocument {
  compilationId: string
  title: string
  status: CompilationStatus
  paragraphs: CompilationParagraph[]
  sources: CompilationSourceRef[]
  /** 当前版本号（无版本时为 0） */
  versionNo: number
}

/** 资料卡片（汇编中的一条资料摘录，可编辑/删除/取舍） */
export interface CompilationItem {
  id: string
  compilationId: string
  /** 时间排序位次 */
  position: number
  sourceId: string
  excerpt: string
  /** 时间标签（如「2005 年」/「2005—2010 年」） */
  ts?: string
  note?: string
  extraTags: string[]
  kept: boolean
  /** 来源标题（服务端 JOIN 填充） */
  sourceTitle?: string
  createdAt: string
}

/** 汇编阶段的一个矛盾「说法」（对应一张资料卡片/来源） */
export interface CompilationContradictionVariant {
  id: string
  contradictionId: string
  itemId: string
  variantText: string
  sourceId: string
  sourceTitle?: string
  createdAt: string
}

/** 汇编阶段的矛盾分组（用户需取舍后进入下一步） */
export interface CompilationContradiction {
  id: string
  compilationId: string
  topic: string
  kind: ContradictionKind
  status: CompilationContradictionStatus
  /** 用户采纳/保留的卡片 id（status=resolved 时） */
  chosenItemId?: string
  createdAt: string
  variants: CompilationContradictionVariant[]
}

export interface Compilation {
  id: string
  taskId: string
  title: string
  status: CompilationStatus
  createdAt: string
  updatedAt: string
  items: CompilationItem[]
  contradictions: CompilationContradiction[]
}

/** 回收站条目基类（按 created_at 倒序展示） */
export interface CompilationRecycleBinBase {
  id: string
  compilationId: string
  createdAt: string
}
/** 回收站中的一条被采纳/忽略的矛盾（可恢复后重新取舍） */
export interface CompilationRecycleBinContradiction extends CompilationRecycleBinBase {
  kind: 'contradiction'
  contradictionId: string
  topic: string
  status: 'resolved' | 'ignored'
  contradiction: CompilationContradiction
}
/**
 * 回收站条目（Phase 7.7 起仅一类）：已采纳/已忽略、可恢复后重新取舍的矛盾。
 * 卡片回收站与「大模型修正」均已移除。
 */
export type CompilationRecycleBinItem = CompilationRecycleBinContradiction

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

// ============================================================
// 规范文档库（Phase 6.4.1：第二步「指定行文规范」）
// ============================================================
export interface StyleGuide {
  id: string
  name: string
  content: string
  /** 全局唯一默认注入规范（1 = 是） */
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

// ============================================================
// LLM Provider
// ============================================================
export interface LlmProviderConfig {
  id: string
  name: string
  apiBase: string
  model: string
  apiKeySet: boolean // 是否已设置密钥（密钥不回传）
  /** Phase B：资料汇编 AI 细读/矛盾扫描的并发窗口数（默认 4，上限 8，用户可改） */
  concurrency?: number
}

// ============================================================
// 设置
// ============================================================
export interface AppSettings {
  dataDir?: string
  /** Phase 2.2 工作区根目录（用户指定；资料直接引用该文件夹内文件） */
  workspaceDir?: string
  /** Phase 6.8：第 1 步（资料汇编）默认使用的大模型 Provider id；未设置回退任务/全局 */
  compilationProviderId?: string
  /** Phase 6.8：第 3 步（生成初稿）默认使用的大模型 Provider id；未设置回退任务/全局 */
  draftProviderId?: string
  /** Phase A：长任务（生成汇编/初稿/整理）期间保持电脑唤醒；缺省/未设为 true 时开启，false 关闭 */
  keepAwake?: boolean
  /**
   * Phase 7.6：资料汇编查看器的字号档位（用户 2026-09-10 提出）。
   * `small` = 改造前的字号与文档宽度；`medium`（缺省）/`large` 依次放大字号并收窄两侧留白。
   */
  docScale?: DocScale
  /**
   * 新手引导是否已完成/已跳过（2026-10-03 新增）。
   * 为什么落库而不是只用 localStorage：渲染层在 dev（http://localhost:5173）与打包版（file://）
   * 属于**两个不同的源**，localStorage 各存一份 → 用户在一种运行方式里跳过，换另一种又会弹一次。
   * 落库后两种运行方式共用同一标记。localStorage 仍保留作为快速路径。
   */
  onboardingDone?: boolean
  /**
   * Phase 10 P3：网页资料库的**发布时间筛选区间**（年份，含端点）。
   * 这是新流程的第一步筛选条件——只有发布时间落在区间内的文章才进入后续的抓取与正文筛选。
   * 缺省（未设置）表示不按年份筛。非法/越界值一律当作缺省处理（见 `db/settings.ts`）。
   */
  webYearFrom?: number
  webYearTo?: number
  /**
   * 2026-10-05（用户裁定）：网页抓取**节奏档位**。默认 `standard`（间隔 60ms / 并发 4）。
   * `safe` = 120ms / 并发 2（Phase 10 P4 的原始礼貌口径）；`fast` = 40ms / 并发 6（对站点最激进）。
   * 抓取中若批量失败，会**自动降档**（间隔翻倍）并重抓本轮失败文章，但**不写回本设置**
   * （用户明确要求："下一次任务还是默认按照标准的抓取节奏来"）。
   */
  webCrawlTier?: WebCrawlTier
}

/** Phase 10 P4：按年份区间全量抓取时的进度（渲染层据此显示进度与剩余时长） */
export interface WebCrawlProgress {
  phase: 'fetching' | 'done' | 'cancelled'
  /** 本次待处理篇数（已剔除已完成/跳过项） */
  total: number
  done: number
  hits: number
  dropped: number
  failed: number
  chars: number
  /** 实测速度（篇/秒） */
  ratePerSec: number
  /** 预计剩余秒数（由 `EtaEstimator` 给出：中位数+截尾均值取大、含礼貌限速下限） */
  etaSeconds: number
  /** 是否仍为预热期的"初估"（样本不足 20 篇时用实测先验 75ms/篇） */
  provisional: boolean
  currentTitle?: string
  /** 2026-10-05：是否处于「暂停抓取」状态（界面据此把按钮切成「继续抓取」并显示提示） */
  paused?: boolean
  /** 2026-10-05：本次从**正文缓存**复用（未联网）的篇数 */
  cacheHits?: number
  /** 2026-10-05：当前生效的请求间隔（毫秒）——自适应降档后会变大 */
  intervalMs?: number
}

/** Phase 10 P4：一次抓取的结果汇总 */
export interface WebCrawlResult {
  total: number
  done: number
  hits: number
  dropped: number
  failed: number
  chars: number
  cancelled: boolean
  elapsedMs: number
  /** 本次命中的站点限速声明（毫秒；用于解释 ETA 的物理下限） */
  crawlDelayMs?: number
  /** 本次涉及的站点数 */
  sites?: number
  /**
   * 2026-10-05（P0 兜底回归）：三类"有效正文"判定的计数 —— 之前 P4 管线缺失这些兜底，
   * 界面上 `webScanInvalidBody` / `webScanShortBody` / `webScanTemplateRepeat` 三条提示恒为 0。
   * ① `invalidBody`：候选带标题但页面不含该文章（老文章失效 → 站点返回通用模板页）；
   * ② `shortBody`：空标题候选（sitemap）清洗后正文过短；③ `templateRepeat`：与同站别的 URL 正文逐字相同。
   */
  invalidBody?: number
  shortBody?: number
  templateRepeat?: number
  /** 2026-10-05（安全加固）：因不在「http(s) + 同域白名单」内而被跳过、**未发起请求**的篇数 */
  blocked?: number
  /** 2026-10-05：从**正文缓存**复用（零网络）的篇数 */
  cacheHits?: number
  /** 2026-10-05：本次运行触发的自适应降档次数（0 = 节奏合适） */
  downgrades?: number
  /** 2026-10-05：因为「暂停抓取」而额外耗费的等待毫秒数（诊断用） */
  pausedMs?: number
  /**
   * 2026-10-06（Phase 11 B 批）：本次**真的写进正文缓存**的篇数——只算 `mode: 'build'`（建立缓存）里
   * 抓取并判定的那几篇（`ok` 与 `no-body` 标记都算）；**命中缓存的不算**（没写），
   * **白名单拦截写下的 `blocked` 标记也不算**（那不走抓取路径，另由 `blocked` 计数）。
   * 建立缓存模式的日志用它回答"这次到底建了多少篇"。
   */
  cacheWritten?: number
}

/**
 * 2026-10-05（用户裁定）：网页抓取的**节奏档位**。
 * `safe` = 120ms / 并发 2（Phase 10 P4 的原始礼貌口径）；`standard` = 60ms / 并发 4（默认）；`fast` = 40ms / 并发 6。
 * 抓取中若出现批量失败会**自动降档**（只影响本次运行），下一次生成仍从设置档位开始。
 */
export type WebCrawlTier = 'safe' | 'standard' | 'fast'

/**
 * Phase 10 P3：网页资料库目录的日期统计（年份区间筛选的预览数据）。
 * 用于在界面上如实告诉用户"这个区间里有多少篇、其中多少篇日期未知、预计要抓多久"。
 */
export interface WebArticleDateStats {
  /** 目录总条数 */
  total: number
  /** 有发布日期（`published_date` 非空）的条数 */
  dated: number
  /** 日期未知（五级阶梯全部失败）的条数——**不丢弃**，界面如实显示 */
  unknown: number
  /** 发布时间落在所选区间内的条数 */
  inRange: number
  /** 全部有日期文章的按年分布（升序） */
  byYear: { year: string; count: number }[]
  /** 区间内文章的按年分布（升序） */
  inRangeByYear: { year: string; count: number }[]
  /** 按"同站并发 2 + 每请求 ≥120ms"的实测口径估算的抓取耗时（分钟） */
  estimatedMinutes: number
}

/** 资料汇编查看器字号档位 */
export type DocScale = 'small' | 'medium' | 'large'

/* ============================================================
 * 「建立缓存与索引」（2026-10-06 用户需求）
 * ============================================================
 * 需求口径（用户裁定）：
 *   ① 设置页那块「本地检索索引」改为「建立缓存与索引」，一次把**网页正文缓存**（按年份区间）
 *      与**本地资料库索引**建立起来，带进度与预计剩余时间；
 *   ② 生成汇编前若发现区间内有资料没建立 → **严格阻断**（不给"仍然生成"的逃生门），
 *      提示去设置页建立；
 *   ③ 已建立的不重复建立（幂等）；
 *   ④ 资料被删除时对应缓存/索引同步删除。
 * 本节类型是 `web-source/cache-build-plan.ts`（只读规划）与 Phase C 的建立引擎共用的契约。
 */

/** 「建立缓存与索引」按年份的建立情况 */
export interface BuildYearBucket {
  year: number
  /** 该年目录条数 */
  total: number
  /** 已有可用正文（`state='ok'`） */
  cached: number
  /** 已尝试但没取到可用正文（`state='no-body'`）——**不算缺口** */
  noBody: number
  /** URL 不在该站点同域白名单内（`state='blocked'` 或按白名单预判）——**永不可建、也不算缺口** */
  blocked: number
  /** 仍需联网建立 */
  pending: number
}

/** 网页正文缓存的建立计划（只读统计；`pending === 0` 才允许生成汇编） */
export interface WebBuildPlan {
  fromYear: number
  toYear: number
  /** 区间内目录条数 */
  total: number
  cached: number
  noBody: number
  blocked: number
  /** **唯一**决定闸门放不放行的数 */
  pending: number
  byYear: BuildYearBucket[]
  /** 按项目既有口径（`fetch-estimate.ts`，75ms/篇）估算的建立耗时 */
  estimatedMinutes: number
  /** 日期未知、因此不参与任何年份区间的目录条数（如实报，不静默） */
  undatedArticles: number
}

/** 本地资料库索引的建立情况 */
export interface LocalBuildPlan {
  total: number
  ready: number
  /** 待索引（**已排除**正文缺失的来源——那些永远建不了，不该卡住生成） */
  pending: number
  indexing: number
  /** 索引失败的来源数（引擎异常等；见 `ready` 判定策略） */
  failed: number
  /** 正文缺失（模板页/失效），既不参与检索也不参与建立 */
  bodyMissing: number
}

/** 生成前被拦住的原因（界面据此给出"缺什么"） */
export type BuildNotReadyReason = 'web-pending' | 'local-pending' | 'local-index-failed'

/** 「建立缓存与索引」的完整计划（只读预检 + 设置页面板共用） */
export interface CacheBuildPlan {
  web: WebBuildPlan
  local: LocalBuildPlan
  /** 是否已"建齐"（可以生成汇编） */
  ready: boolean
  reasons: BuildNotReadyReason[]
}

// ============================================================
// 统一错误返回
// ============================================================
export interface ApiError {
  code: string
  message: string
  details?: unknown
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError }

// ============================================================
// 错误码
// ============================================================
export const ErrorCodes = {
  // 资料
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',
  SOURCE_DUPLICATE: 'SOURCE_DUPLICATE',
  PARSE_UNSUPPORTED: 'PARSE_UNSUPPORTED',
  PARSE_FAILED: 'PARSE_FAILED',

  // 信源
  URL_INVALID: 'URL_INVALID',
  URL_BLOCKED: 'URL_BLOCKED',
  FETCH_FAILED: 'FETCH_FAILED',
  FETCH_TIMEOUT: 'FETCH_TIMEOUT',

  // LLM
  LLM_UNAUTHORIZED: 'LLM_UNAUTHORIZED',
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_RATE_LIMIT: 'LLM_RATE_LIMIT',
  LLM_NETWORK: 'LLM_NETWORK',
  LLM_PROVIDER_ERROR: 'LLM_PROVIDER_ERROR',
  LLM_EMPTY_RESPONSE: 'LLM_EMPTY_RESPONSE',
  LLM_FORMAT_INVALID: 'LLM_FORMAT_INVALID',
  LLM_NO_CANDIDATES: 'LLM_NO_CANDIDATES',

  // 撰写
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  DRAFT_NOT_FOUND: 'DRAFT_NOT_FOUND',
  TASK_NO_SCOPE: 'TASK_NO_SCOPE',
  TASK_NO_PROVIDER: 'TASK_NO_PROVIDER',
  COMPILATION_NOT_FINALIZED: 'COMPILATION_NOT_FINALIZED',

  // 通用
  INVALID_PARAM: 'INVALID_PARAM',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]
