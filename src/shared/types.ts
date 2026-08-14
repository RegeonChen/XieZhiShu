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
// 写作规范 skills（2026-08-13：由「范本」重构而来）
// ============================================================
export interface WritingSkill {
  id: string
  name: string // 如「学前教育」「大事记」「志书文体文风与行文规则」
  category: 'general' | 'section' // general=通用规范（默认注入）；section=部类细则（按标题匹配）
  tags: string[] // 匹配关键词（如 ['学前教育','幼儿园','保育']）
  content: string // 蒸馏后的规范要点（Markdown）
  isPreset: boolean // 预设（内置）或用户自建
  createdAt: string
  updatedAt: string
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

export interface WritingTask {
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
  currentVersion: number
  createdAt: string
  updatedAt: string
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
// LLM Provider
// ============================================================
export interface LlmProviderConfig {
  id: string
  name: string
  apiBase: string
  model: string
  apiKeySet: boolean // 是否已设置密钥（密钥不回传）
}

// ============================================================
// 设置
// ============================================================
export interface AppSettings {
  dataDir?: string
  currentLlmProviderId?: string
  /** Phase 2.2 工作区根目录（用户指定；资料直接引用该文件夹内文件） */
  workspaceDir?: string
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

  // 通用
  INVALID_PARAM: 'INVALID_PARAM',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]
