/** 共享领域类型 —— 独立于 UI 组件与具体服务实现 */

// ============================================================
// 资料（文件或信源网址的统一抽象）
// ============================================================
export interface Source {
  id: string
  kind: 'file' | 'url'
  title: string
  filePath?: string // kind=file，dataDir 相对路径
  url?: string // kind=url
  urlSnapshotAt?: string // 抓取时间 ISO
  cleanedText: string // 清洗后正文
  status: 'pending' | 'processing' | 'ready' | 'failed'
  errorCode?: string
  createdAt: string
  updatedAt: string
}

export type SourceStatus = Source['status']

// ============================================================
// 标签
// ============================================================
export interface Tag {
  id: string
  name: string
  color?: string
  createdAt: string
}

// ============================================================
// 范本
// ============================================================
export interface TemplateBook {
  id: string
  name: string
  filePath: string
  outline: string // 篇目层级结构（JSON 字符串）
  styleProfile?: string // 体例特征
  createdAt: string
}

// ============================================================
// 撰写任务
// ============================================================
export type WritingScope = { sourceIds: string[] } | { tagIds: string[] }

export interface WritingTask {
  id: string
  title: string
  scope: WritingScope
  templateBookId?: string
  currentVersion: number
  createdAt: string
  updatedAt: string
}

// ============================================================
// 志稿版本与片段
// ============================================================
export interface Draft {
  id: string
  taskId: string
  versionNumber: number // 0 = 初稿
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
// 版本相关
// ============================================================
export interface VersionListItem {
  draftId: string
  versionNumber: number
  status: string
  confirmedAt?: string
}

export interface SegmentDiff {
  ordering: number
  heading?: string
  kind: 'added' | 'removed' | 'modified'
  oldContent?: string
  newContent?: string
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
