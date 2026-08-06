/**
 * IPC 通道清单 —— 独立于具体实现。
 * 命名：模块:动作。请求/响应均为 ApiResult<T> 包裹。
 */
import type {
  ApiResult,
  AppSettings,
  Draft,
  LlmProviderConfig,
  RetrievedChunk,
  Segment,
  SegmentDiff,
  Source,
  Tag,
  TemplateBook,
  VersionListItem,
  WritingTask
} from './types'

// ============================================================
// 通道名常量（供 preload / main 引用，避免硬编码字符串重复）
// ============================================================

export const IPC = {
  /* 资料 */
  SOURCES_LIST: 'sources:list',
  SOURCES_IMPORT_FILES: 'sources:importFiles',
  SOURCES_ADD_URL: 'sources:addUrl',
  SOURCES_REFRESH: 'sources:refresh',
  SOURCES_GET: 'sources:get',
  SOURCES_RENDER_HTML: 'sources:renderHtml',
  SOURCES_GET_FILE_URL: 'sources:getFileUrl',
  SOURCES_DELETE: 'sources:delete',
  SOURCES_DELETE_MANY: 'sources:deleteMany',
  SOURCES_UPDATE_TITLE: 'sources:updateTitle',

  /* 标签 */
  TAGS_LIST: 'tags:list',
  TAGS_CREATE: 'tags:create',
  TAGS_UPDATE: 'tags:update',
  TAGS_DELETE: 'tags:delete',
  TAGS_ADD_TO_SOURCE: 'tags:addToSource',
  TAGS_REMOVE_FROM_SOURCE: 'tags:removeFromSource',
  TAGS_SEARCH: 'tags:search',
  TAGS_BATCH_ADD: 'tags:batchAdd',
  TAGS_SOURCES_BY_TAG: 'tags:sourcesByTag',

  /* 范本 */
  TEMPLATES_LIST: 'templates:list',
  TEMPLATES_IMPORT: 'templates:import',
  TEMPLATES_GET: 'templates:get',
  TEMPLATES_DELETE: 'templates:delete',

  /* 撰写与初稿 */
  WRITING_CREATE_TASK: 'writing:createTask',
  WRITING_LIST_TASKS: 'writing:listTasks',
  WRITING_DELETE_TASK: 'writing:deleteTask',
  WRITING_RETRIEVE: 'writing:retrieve',
  WRITING_GENERATE_DRAFT: 'writing:generateDraft',
  DRAFT_GET: 'draft:get',
  DRAFT_CONFIRM: 'draft:confirm',
  SEGMENT_UPDATE: 'segment:update',
  SEGMENT_RESOLVE_CONFLICT: 'segment:resolveConflict',
  SEGMENT_ADD_MANUAL: 'segment:addManual',
  SEGMENT_INSERT_GENERATED: 'segment:insertGenerated',

  /* 版本 */
  VERSION_LIST: 'version:list',
  VERSION_COMPARE: 'version:compare',
  VERSION_ROLLBACK: 'version:rollback',

  /* LLM */
  LLM_LIST_PROVIDERS: 'llm:listProviders',
  LLM_SAVE_PROVIDER: 'llm:saveProvider',
  LLM_DELETE_PROVIDER: 'llm:deleteProvider',
  LLM_TEST_CONNECTION: 'llm:testConnection',

  /* 设置 */
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',

  /* 应用元数据（Task 1.1 已实现） */
  APP_GET_INFO: 'app:getInfo'
} as const

// ============================================================
// 请求 / 响应类型
// ============================================================

// -- 资料 --
export interface SourceListReq {
  tagIds?: string[]
  search?: string
}
export type SourceListRes = { items: Source[] }

export interface SourceImportFilesReq {
  paths: string[]
}
export type SourceImportFilesRes = { results: { path: string; source?: Source; error?: string }[] }

export interface SourceAddUrlReq {
  url: string
}
export type SourceAddUrlRes = { source: Source }

export interface SourceRefreshReq {
  id: string
}
export type SourceDeleteReq = SourceRefreshReq
export interface SourceDeleteManyReq {
  ids: string[]
}
export type SourceGetReq = SourceRefreshReq
export type SourceRenderHtmlReq = SourceRefreshReq
export type SourceRenderHtmlRes = { html: string }
export type SourceGetFileUrlRes = { url: string }
export interface SourceUpdateTitleReq {
  id: string
  title: string
}

// -- 标签 --
export type TagListRes = { items: Tag[] }

export interface TagCreateReq {
  name: string
}
export type TagCreateRes = { tag: Tag }

export interface TagUpdateReq {
  id: string
  name?: string
}

export interface TagToSourceReq {
  sourceId: string
  tagId: string
}

export interface TagSearchReq {
  query: string
  limit?: number
}
export type TagSearchRes = { items: Tag[] }

export interface TagBatchAddReq {
  tagIds: string[]
  sourceIds: string[]
}

export interface TagSourcesByTagReq {
  tagId: string
}
export type TagSourcesByTagRes = { sourceIds: string[] }

// -- 范本 --
export type TemplateListRes = { items: TemplateBook[] }

export interface TemplateImportReq {
  path: string
}
export type TemplateImportRes = { template: TemplateBook }

// -- 撰写与初稿 --
export interface WritingCreateTaskReq {
  title: string
  scope: { sourceIds: string[] } | { tagIds: string[] }
  templateBookId?: string
}
export type WritingCreateTaskRes = { task: WritingTask }

export type WritingListTasksRes = { items: WritingTask[] }

export interface WritingDeleteTaskReq {
  id: string
}

export interface WritingRetrieveReq {
  taskId: string
}
export type WritingRetrieveRes = { chunks: RetrievedChunk[] }

export interface WritingGenerateDraftReq {
  taskId: string
}
export type WritingGenerateDraftRes = { draft: Draft }

export interface DraftGetReq {
  draftId: string
}

export interface DraftConfirmReq {
  draftId: string
}
export type DraftConfirmRes = { nextDraft: Draft }

export interface SegmentUpdateReq {
  segmentId: string
  content: string
}
export type SegmentUpdateRes = { segment: Segment }

export interface SegmentResolveConflictReq {
  segmentId: string
  chosenSourceId: string
  note?: string
}

export interface SegmentAddManualReq {
  draftId: string
  heading?: string
  content: string
  insertAfter?: number // ordering 位置，不传则追加到末尾
}

export interface SegmentInsertGeneratedReq {
  draftId: string
  heading?: string
  scope: { sourceIds: string[] } | { tagIds: string[] }
  insertAfter?: number
}

// -- 版本 --
export interface VersionListReq {
  taskId: string
}
export type VersionListRes = { versions: VersionListItem[] }

export interface VersionCompareReq {
  taskId: string
  a: number // versionNumber
  b: number
}
export type VersionCompareRes = { diff: SegmentDiff[] }

export interface VersionRollbackReq {
  taskId: string
  toVersion: number
}
export type VersionRollbackRes = { draft: Draft }

// -- LLM --
export type LlmListProvidersRes = { items: LlmProviderConfig[] }

export interface LlmSaveProviderReq {
  id?: string
  name: string
  apiBase: string
  model: string
  apiKey?: string
}
export type LlmSaveProviderRes = { provider: LlmProviderConfig }

// -- 设置 --
export type SettingsUpdateReq = { patch: Partial<AppSettings> }

// -- 应用元数据 --
export type AppInfoRes = { version: string; platform: string }

// ============================================================
// 类型安全的 IPC 接口映射（供 preload 侧使用，确保返回值类型与通道绑定一致）
// ============================================================
export interface IpcMapping {
  [IPC.APP_GET_INFO]: { _req: void; _res: ApiResult<AppInfoRes> }
  // 资料
  [IPC.SOURCES_LIST]: { _req: SourceListReq; _res: ApiResult<SourceListRes> }
  [IPC.SOURCES_IMPORT_FILES]: { _req: SourceImportFilesReq; _res: ApiResult<SourceImportFilesRes> }
  [IPC.SOURCES_ADD_URL]: { _req: SourceAddUrlReq; _res: ApiResult<SourceAddUrlRes> }
  [IPC.SOURCES_REFRESH]: { _req: SourceRefreshReq; _res: ApiResult<Source> }
  [IPC.SOURCES_GET]: { _req: SourceGetReq; _res: ApiResult<Source> }
  [IPC.SOURCES_RENDER_HTML]: { _req: SourceRenderHtmlReq; _res: ApiResult<SourceRenderHtmlRes> }
  [IPC.SOURCES_GET_FILE_URL]: { _req: SourceGetReq; _res: ApiResult<SourceGetFileUrlRes> }
  [IPC.SOURCES_DELETE]: { _req: SourceDeleteReq; _res: ApiResult<void> }
  [IPC.SOURCES_DELETE_MANY]: { _req: SourceDeleteManyReq; _res: ApiResult<void> }
  [IPC.SOURCES_UPDATE_TITLE]: { _req: SourceUpdateTitleReq; _res: ApiResult<Source> }
  // 标签
  [IPC.TAGS_LIST]: { _req: void; _res: ApiResult<TagListRes> }
  [IPC.TAGS_CREATE]: { _req: TagCreateReq; _res: ApiResult<TagCreateRes> }
  [IPC.TAGS_UPDATE]: { _req: TagUpdateReq; _res: ApiResult<Tag> }
  [IPC.TAGS_DELETE]: { _req: { id: string }; _res: ApiResult<void> }
  [IPC.TAGS_ADD_TO_SOURCE]: { _req: TagToSourceReq; _res: ApiResult<void> }
  [IPC.TAGS_REMOVE_FROM_SOURCE]: { _req: TagToSourceReq; _res: ApiResult<void> }
  [IPC.TAGS_SEARCH]: { _req: TagSearchReq; _res: ApiResult<TagSearchRes> }
  [IPC.TAGS_BATCH_ADD]: { _req: TagBatchAddReq; _res: ApiResult<void> }
  [IPC.TAGS_SOURCES_BY_TAG]: { _req: TagSourcesByTagReq; _res: ApiResult<TagSourcesByTagRes> }
  // 范本
  [IPC.TEMPLATES_LIST]: { _req: void; _res: ApiResult<TemplateListRes> }
  [IPC.TEMPLATES_IMPORT]: { _req: TemplateImportReq; _res: ApiResult<TemplateImportRes> }
  [IPC.TEMPLATES_GET]: { _req: { id: string }; _res: ApiResult<TemplateBook> }
  [IPC.TEMPLATES_DELETE]: { _req: { id: string }; _res: ApiResult<void> }
  // 撰写
  [IPC.WRITING_CREATE_TASK]: { _req: WritingCreateTaskReq; _res: ApiResult<WritingCreateTaskRes> }
  [IPC.WRITING_LIST_TASKS]: { _req: void; _res: ApiResult<WritingListTasksRes> }
  [IPC.WRITING_DELETE_TASK]: { _req: WritingDeleteTaskReq; _res: ApiResult<void> }
  [IPC.WRITING_RETRIEVE]: { _req: WritingRetrieveReq; _res: ApiResult<WritingRetrieveRes> }
  [IPC.WRITING_GENERATE_DRAFT]: { _req: WritingGenerateDraftReq; _res: ApiResult<WritingGenerateDraftRes> }
  [IPC.DRAFT_GET]: { _req: DraftGetReq; _res: ApiResult<Draft> }
  [IPC.DRAFT_CONFIRM]: { _req: DraftConfirmReq; _res: ApiResult<DraftConfirmRes> }
  [IPC.SEGMENT_UPDATE]: { _req: SegmentUpdateReq; _res: ApiResult<SegmentUpdateRes> }
  [IPC.SEGMENT_RESOLVE_CONFLICT]: { _req: SegmentResolveConflictReq; _res: ApiResult<Segment> }
  [IPC.SEGMENT_ADD_MANUAL]: { _req: SegmentAddManualReq; _res: ApiResult<Segment> }
  [IPC.SEGMENT_INSERT_GENERATED]: { _req: SegmentInsertGeneratedReq; _res: ApiResult<Segment> }
  // 版本
  [IPC.VERSION_LIST]: { _req: VersionListReq; _res: ApiResult<VersionListRes> }
  [IPC.VERSION_COMPARE]: { _req: VersionCompareReq; _res: ApiResult<VersionCompareRes> }
  [IPC.VERSION_ROLLBACK]: { _req: VersionRollbackReq; _res: ApiResult<VersionRollbackRes> }
  // LLM
  [IPC.LLM_LIST_PROVIDERS]: { _req: void; _res: ApiResult<LlmListProvidersRes> }
  [IPC.LLM_SAVE_PROVIDER]: { _req: LlmSaveProviderReq; _res: ApiResult<LlmSaveProviderRes> }
  [IPC.LLM_DELETE_PROVIDER]: { _req: { id: string }; _res: ApiResult<void> }
  [IPC.LLM_TEST_CONNECTION]: { _req: { id: string }; _res: ApiResult<void> }
  // 设置
  [IPC.SETTINGS_GET]: { _req: void; _res: ApiResult<AppSettings> }
  [IPC.SETTINGS_UPDATE]: { _req: SettingsUpdateReq; _res: ApiResult<AppSettings> }
}
