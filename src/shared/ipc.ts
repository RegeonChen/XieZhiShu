/**
 * IPC 通道清单 —— 独立于具体实现。
 * 命名：模块:动作。请求/响应均为 ApiResult<T> 包裹。
 */
import type {
  ApiResult,
  AppSettings,
  Contradiction,
  Draft,
  LlmProviderConfig,
  RetrievedChunk,
  Segment,
  Source,
  Tag,
  WebSite,
  WritingSkill,
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
  SOURCES_SUMMARIZE_ALL: 'sources:summarizeAll',
  SOURCES_GET_SUMMARY: 'sources:getSummary',

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

  /* 写作规范 skills */
  SKILLS_LIST: 'skills:list',
  SKILLS_CREATE: 'skills:create',
  SKILLS_UPDATE: 'skills:update',
  SKILLS_DELETE: 'skills:delete',

  /* 撰写与初稿 */
  WRITING_CREATE_TASK: 'writing:createTask',
  WRITING_LIST_TASKS: 'writing:listTasks',
  WRITING_DELETE_TASK: 'writing:deleteTask',
  WRITING_RENAME_TASK: 'writing:renameTask',
  WRITING_UPDATE_SKILLS: 'writing:updateSkills',
  WRITING_UPDATE_PROVIDER: 'writing:updateProvider',
  WRITING_CHAT: 'writing:chat',
  WRITING_RETRIEVE: 'writing:retrieve',
  WRITING_ASK_SOURCE: 'writing:askSource',
  TASK_MESSAGES_LIST: 'taskMessages:list',
  TASK_MESSAGES_ADD: 'taskMessages:add',
  WRITING_GENERATE_DRAFT: 'writing:generateDraft',
  DRAFT_GET: 'draft:get',
  DRAFT_UPDATE_CONTENT: 'draft:updateContent',
  DRAFT_REGENERATE: 'draft:regenerate',
  DRAFT_GET_CONTRADICTIONS: 'draft:getContradictions',
  DRAFT_RESOLVE_CONTRADICTION: 'draft:resolveContradiction',
  DRAFT_APPLY_CONTRADICTION: 'draft:applyContradiction',
  DRAFT_GET_LATEST: 'draft:getLatest',
  SOURCES_OPEN_PATH: 'sources:openPath',
  SEGMENT_UPDATE: 'segment:update',
  SEGMENT_RESOLVE_CONFLICT: 'segment:resolveConflict',
  SEGMENT_ADD_MANUAL: 'segment:addManual',
  SEGMENT_INSERT_GENERATED: 'segment:insertGenerated',

  /* LLM */
  LLM_LIST_PROVIDERS: 'llm:listProviders',
  LLM_SAVE_PROVIDER: 'llm:saveProvider',
  LLM_DELETE_PROVIDER: 'llm:deleteProvider',
  LLM_TEST_CONNECTION: 'llm:testConnection',

  /* 设置 */
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',

  /* 工作区（Phase 2.2） */
  WORKSPACE_STATUS: 'workspace:status',
  WORKSPACE_RECONCILE: 'workspace:reconcile',
  WORKSPACE_MIGRATE: 'workspace:migrate',
  WORKSPACE_NAV_SYNC: 'workspace:navSync',

  /* 应用元数据（Task 1.1 已实现） */
  APP_GET_INFO: 'app:getInfo',

  /* 打开外部链接（预设模型注册页等） */
  APP_OPEN_EXTERNAL: 'app:openExternal',

  /* 网页资料库（2026-08-11：站点注册/列表/删除/同步文章清单） */
  WEB_SOURCE_LIST: 'webSource:list',
  WEB_SOURCE_ADD: 'webSource:add',
  WEB_SOURCE_REMOVE: 'webSource:remove',
  WEB_SOURCE_SYNC: 'webSource:sync',

  /* 窗口 */
  WINDOW_FOCUS: 'window:focus'
} as const

/** 主进程 → 渲染进程 的推送事件名（非请求/响应通道） */
export const IPC_EVENTS = {
  /** 生成初稿阶段进度：{ taskId, stage } */
  DRAFT_GENERATE_PROGRESS: 'draft:generateProgress'
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

// -- 网页资料库（2026-08-11） --
export interface WebSourceListReq {}
export type WebSourceListRes = { sites: WebSite[] }

export interface WebSourceAddReq {
  rootUrl: string
  title?: string
}
export type WebSourceAddRes = { site: WebSite }

export interface WebSourceRemoveReq {
  id: string
}

export interface WebSourceSyncReq {
  id: string
}
/** 手动同步站点：发现文章清单（web_site_articles）；返回本次发现的文章数 */
export type WebSourceSyncRes = { articles: number }

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
export type SourceSummarizeAllRes = { processed: number; ok: number; failed: number }
export interface SourceGetSummaryReq {
  id: string
}
export type SourceGetSummaryRes = {
  summary?: {
    sourceId: string
    summary: string
    keywords: string[]
    entities: string[]
    llmModel?: string
    updatedAt: string
  }
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

// -- 写作规范 skills --
export type SkillListRes = { items: WritingSkill[] }

export interface SkillSaveReq {
  id?: string // 缺省 = 新建；提供 = 修改
  name: string
  category: 'general' | 'section'
  tags: string[]
  content: string
}
export type SkillSaveRes = { skill: WritingSkill }

export interface SkillDeleteReq {
  id: string
}

// -- 撰写与初稿 --
export interface WritingCreateTaskReq {
  /** 中栏显示的任务标题；缺省为"新建任务"（Phase 3.5 起点击"新建任务"立即创建） */
  title?: string
  /** 文件范围；缺省为 { all: true }（资料库全部文件，用户不可自定） */
  scope?: { all: true } | { sourceIds: string[] } | { tagIds: string[] }
  templateBookId?: string
  llmProviderId?: string
}
export type WritingCreateTaskRes = { task: WritingTask }

export type WritingListTasksRes = { items: WritingTask[] }

export interface WritingDeleteTaskReq {
  id: string
}

export interface WritingRenameTaskReq {
  taskId: string
  title: string
}
export type WritingRenameTaskRes = { task: WritingTask }

export interface WritingUpdateSkillsReq {
  taskId: string
  skillIds: string[] | null // null = 未手动选定（生成时按标题自动匹配）
}
export type WritingUpdateSkillsRes = { task: WritingTask }

export interface WritingUpdateProviderReq {
  taskId: string
  llmProviderId: string | null  // null = 回退全局当前 Provider
}
export type WritingUpdateProviderRes = { task: WritingTask }

/** 与大模型自由对话（Phase 3.5；history 为前端维护的最近对话上下文） */
export interface WritingChatReq {
  taskId: string
  message: string
  history?: { role: 'user' | 'assistant'; content: string }[]
}
export type WritingChatRes = { reply: string }

// -- 任务对话消息（Phase 3.5 后续：对话历史与痕迹持久化）--
export interface TaskMessageItem {
  id: string
  taskId: string
  role: 'user' | 'assistant'
  kind: 'chat' | 'instruction' | 'notice'
  content: string
  createdAt: string
}
export interface TaskMessagesListReq {
  taskId: string
}
export type TaskMessagesListRes = { items: TaskMessageItem[] }
export interface TaskMessagesAddReq {
  taskId: string
  role: 'user' | 'assistant'
  kind: 'chat' | 'instruction' | 'notice'
  content: string
}
export type TaskMessagesAddRes = { message: TaskMessageItem }

export interface WritingRetrieveReq {
  taskId: string
}
export type WritingRetrieveRes = { chunks: RetrievedChunk[] }

/** 文段来源询问（Phase 3.7 Task 3.7.5：选中正文文段 → 自动询问来源文件） */
export interface WritingAskSourceReq {
  taskId: string
  /** 选中的正文文段（≤300 字） */
  selection: string
}
/** 来源引用：编号与回复文本中的 #N 对应，前端按编号渲染为可点击链接（sources:openPath 打开原文） */
export interface SourceRef {
  index: number
  sourceId: string
  title: string
  position?: string
}
export type WritingAskSourceRes = { reply: string; refs: SourceRef[] }

export interface WritingGenerateDraftReq {
  taskId: string
  /** 用户要求（应包含标题与可能的其他要求）；大模型缺必要信息时返回详细报错 */
  instruction: string
}
export type WritingGenerateDraftRes = {
  draft: Draft
  articleTitle: string | null
  /** Phase 3.7：生成时发现的材料矛盾清单（含正文定位回填），供前端首次加载展示 */
  contradictions: Contradiction[]
}

export interface DraftGetReq {
  draftId: string
}

/** 读取任务最新一稿（2026-08-11 删去版本管理后仅保留初稿；替代原 version:list 定位最新稿） */
export interface DraftGetLatestReq {
  taskId: string
}
export type DraftGetLatestRes = { draft: Draft }

export interface SegmentUpdateReq {
  segmentId: string
  content: string
}
export type SegmentUpdateRes = { segment: Segment }

/** 整稿保存（Task 3.4.1：初稿连续显示为整体，编辑后按整稿 markdown 保存并重建片段） */
export interface DraftUpdateContentReq {
  draftId: string
  markdown: string
}
export type DraftUpdateContentRes = { draft: Draft }

/** 重新生成初稿（Task 3.4.5）：删除现有第 0 稿后按当前资料与范本重新生成（覆盖旧稿） */
export type DraftRegenerateReq = WritingGenerateDraftReq
export type DraftRegenerateRes = WritingGenerateDraftRes

/** 读取某稿的矛盾清单（Phase 3.7 Task 3.7.4：矛盾弹窗 / 编辑器标注初始化） */
export interface DraftGetContradictionsReq {
  draftId: string
}
export type DraftGetContradictionsRes = { contradictions: Contradiction[] }

/** 矛盾取舍（Phase 3.7 Task 3.7.4：采纳某说法 / 忽略该矛盾；2026-08-11 撤销采纳=revert 回退待处理） */
export interface DraftResolveContradictionReq {
  contradictionId: string
  /** 取舍动作：adopt=采纳某说法（须带 variantId）；ignore=忽略该矛盾；revert=撤销采纳（回退为待处理） */
  action: 'adopt' | 'ignore' | 'revert'
  /** action=adopt 时必填：被采纳的说法 id（须属于该矛盾） */
  variantId?: string
}
export type DraftResolveContradictionRes = { contradiction: Contradiction }

/** 矛盾采纳 → 正文同步修订（2026-08-11）：采纳某说法并让大模型把正文中相关语句改为该说法，移除【矛盾#N】标注 */
export interface DraftApplyContradictionReq {
  draftId: string
  contradictionId: string
  /** 被采纳的说法 id（须属于该矛盾） */
  variantId: string
}
export type DraftApplyContradictionRes = { draft: Draft; contradiction: Contradiction }

/** 用系统默认软件打开资料源文件（Phase 3.7 Task 3.7.6；URL 类型走浏览器） */
export interface SourceOpenPathReq {
  sourceId: string
}
export type SourceOpenPathRes = { opened: boolean }

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

// -- 工作区（Phase 2.2）--
export interface WorkspaceStatusRes {
  workspaceDir?: string // 未配置工作区时为 undefined
  workspaceSources: number // 工作区来源的资料数
  legacySources: number // 传统导入（尚未迁移到工作区）的文件资料数
  totalSources: number // 资料总数
}
export type WorkspaceReconcileRes = {
  workspaceDir: string | null
  added: number
  changed: number
  removed: number
  moved: number
  errors: number
  total: number
}
export type WorkspaceMigrateRes = {
  migrated: number
  failed: number
  skipped: number
}

// -- 应用元数据 --
export type AppInfoRes = { version: string; platform: string }

// -- 打开外部链接 --
export interface AppOpenExternalReq {
  url: string
}

// ============================================================
// 类型安全的 IPC 接口映射（供 preload 侧使用，确保返回值类型与通道绑定一致）
// ============================================================
export interface IpcMapping {
  // 应用元数据
  [IPC.APP_GET_INFO]: { _req: void; _res: ApiResult<AppInfoRes> }
  [IPC.APP_OPEN_EXTERNAL]: { _req: AppOpenExternalReq; _res: ApiResult<void> }

  // 窗口
  [IPC.WINDOW_FOCUS]: { _req: void; _res: ApiResult<void> }
  // 资料
  [IPC.SOURCES_LIST]: { _req: SourceListReq; _res: ApiResult<SourceListRes> }
  [IPC.SOURCES_IMPORT_FILES]: { _req: SourceImportFilesReq; _res: ApiResult<SourceImportFilesRes> }
  [IPC.SOURCES_ADD_URL]: { _req: SourceAddUrlReq; _res: ApiResult<SourceAddUrlRes> }
  [IPC.WEB_SOURCE_LIST]: { _req: WebSourceListReq; _res: ApiResult<WebSourceListRes> }
  [IPC.WEB_SOURCE_ADD]: { _req: WebSourceAddReq; _res: ApiResult<WebSourceAddRes> }
  [IPC.WEB_SOURCE_REMOVE]: { _req: WebSourceRemoveReq; _res: ApiResult<void> }
  [IPC.WEB_SOURCE_SYNC]: { _req: WebSourceSyncReq; _res: ApiResult<WebSourceSyncRes> }
  [IPC.SOURCES_REFRESH]: { _req: SourceRefreshReq; _res: ApiResult<Source> }
  [IPC.SOURCES_GET]: { _req: SourceGetReq; _res: ApiResult<Source> }
  [IPC.SOURCES_RENDER_HTML]: { _req: SourceRenderHtmlReq; _res: ApiResult<SourceRenderHtmlRes> }
  [IPC.SOURCES_GET_FILE_URL]: { _req: SourceGetReq; _res: ApiResult<SourceGetFileUrlRes> }
  [IPC.SOURCES_DELETE]: { _req: SourceDeleteReq; _res: ApiResult<void> }
  [IPC.SOURCES_DELETE_MANY]: { _req: SourceDeleteManyReq; _res: ApiResult<void> }
  [IPC.SOURCES_UPDATE_TITLE]: { _req: SourceUpdateTitleReq; _res: ApiResult<Source> }
  [IPC.SOURCES_SUMMARIZE_ALL]: { _req: void; _res: ApiResult<SourceSummarizeAllRes> }
  [IPC.SOURCES_GET_SUMMARY]: { _req: SourceGetSummaryReq; _res: ApiResult<SourceGetSummaryRes> }
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
  // 写作规范 skills
  [IPC.SKILLS_LIST]: { _req: void; _res: ApiResult<SkillListRes> }
  [IPC.SKILLS_CREATE]: { _req: SkillSaveReq; _res: ApiResult<SkillSaveRes> }
  [IPC.SKILLS_UPDATE]: { _req: SkillSaveReq; _res: ApiResult<SkillSaveRes> }
  [IPC.SKILLS_DELETE]: { _req: SkillDeleteReq; _res: ApiResult<void> }
  // 撰写
  [IPC.WRITING_CREATE_TASK]: { _req: WritingCreateTaskReq; _res: ApiResult<WritingCreateTaskRes> }
  [IPC.WRITING_LIST_TASKS]: { _req: void; _res: ApiResult<WritingListTasksRes> }
  [IPC.WRITING_DELETE_TASK]: { _req: WritingDeleteTaskReq; _res: ApiResult<void> }
  [IPC.WRITING_RENAME_TASK]: { _req: WritingRenameTaskReq; _res: ApiResult<WritingRenameTaskRes> }
  [IPC.WRITING_UPDATE_SKILLS]: { _req: WritingUpdateSkillsReq; _res: ApiResult<WritingUpdateSkillsRes> }
  [IPC.WRITING_UPDATE_PROVIDER]: { _req: WritingUpdateProviderReq; _res: ApiResult<WritingUpdateProviderRes> }
  [IPC.WRITING_CHAT]: { _req: WritingChatReq; _res: ApiResult<WritingChatRes> }
  [IPC.TASK_MESSAGES_LIST]: { _req: TaskMessagesListReq; _res: ApiResult<TaskMessagesListRes> }
  [IPC.TASK_MESSAGES_ADD]: { _req: TaskMessagesAddReq; _res: ApiResult<TaskMessagesAddRes> }
  [IPC.WRITING_RETRIEVE]: { _req: WritingRetrieveReq; _res: ApiResult<WritingRetrieveRes> }
  [IPC.WRITING_ASK_SOURCE]: { _req: WritingAskSourceReq; _res: ApiResult<WritingAskSourceRes> }
  [IPC.WRITING_GENERATE_DRAFT]: { _req: WritingGenerateDraftReq; _res: ApiResult<WritingGenerateDraftRes> }
  [IPC.DRAFT_GET]: { _req: DraftGetReq; _res: ApiResult<Draft> }
  [IPC.DRAFT_UPDATE_CONTENT]: { _req: DraftUpdateContentReq; _res: ApiResult<DraftUpdateContentRes> }
  [IPC.DRAFT_REGENERATE]: { _req: DraftRegenerateReq; _res: ApiResult<DraftRegenerateRes> }
  [IPC.DRAFT_GET_CONTRADICTIONS]: { _req: DraftGetContradictionsReq; _res: ApiResult<DraftGetContradictionsRes> }
  [IPC.DRAFT_RESOLVE_CONTRADICTION]: { _req: DraftResolveContradictionReq; _res: ApiResult<DraftResolveContradictionRes> }
  [IPC.DRAFT_APPLY_CONTRADICTION]: { _req: DraftApplyContradictionReq; _res: ApiResult<DraftApplyContradictionRes> }
  [IPC.DRAFT_GET_LATEST]: { _req: DraftGetLatestReq; _res: ApiResult<DraftGetLatestRes> }
  [IPC.SOURCES_OPEN_PATH]: { _req: SourceOpenPathReq; _res: ApiResult<SourceOpenPathRes> }
  [IPC.SEGMENT_UPDATE]: { _req: SegmentUpdateReq; _res: ApiResult<SegmentUpdateRes> }
  [IPC.SEGMENT_RESOLVE_CONFLICT]: { _req: SegmentResolveConflictReq; _res: ApiResult<Segment> }
  [IPC.SEGMENT_ADD_MANUAL]: { _req: SegmentAddManualReq; _res: ApiResult<Segment> }
  [IPC.SEGMENT_INSERT_GENERATED]: { _req: SegmentInsertGeneratedReq; _res: ApiResult<Segment> }
  // LLM
  [IPC.LLM_LIST_PROVIDERS]: { _req: void; _res: ApiResult<LlmListProvidersRes> }
  [IPC.LLM_SAVE_PROVIDER]: { _req: LlmSaveProviderReq; _res: ApiResult<LlmSaveProviderRes> }
  [IPC.LLM_DELETE_PROVIDER]: { _req: { id: string }; _res: ApiResult<void> }
  [IPC.LLM_TEST_CONNECTION]: { _req: { id: string }; _res: ApiResult<void> }
  // 设置
  [IPC.SETTINGS_GET]: { _req: void; _res: ApiResult<AppSettings> }
  [IPC.SETTINGS_UPDATE]: { _req: SettingsUpdateReq; _res: ApiResult<AppSettings> }
  // 工作区
  [IPC.WORKSPACE_STATUS]: { _req: void; _res: ApiResult<WorkspaceStatusRes> }
  [IPC.WORKSPACE_RECONCILE]: { _req: void; _res: ApiResult<WorkspaceReconcileRes> }
  [IPC.WORKSPACE_MIGRATE]: { _req: void; _res: ApiResult<WorkspaceMigrateRes> }
  [IPC.WORKSPACE_NAV_SYNC]: { _req: void; _res: ApiResult<void> }
}
