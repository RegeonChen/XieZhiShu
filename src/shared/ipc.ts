/**
 * IPC 通道清单 —— 独立于具体实现。
 * 命名：模块:动作。请求/响应均为 ApiResult<T> 包裹。
 */
import type {
  ApiResult,
  AppSettings,
  CacheBuildPlan,
  CacheBuildStartRes,
  CacheBuildStatus,
  Compilation,
  CompilationContradiction,
  CompilationInterrupt,
  CompilationReadiness,
  CompilationRecycleBinItem,
  CompilationVersionSummary,
  Contradiction,
  StyleGuide,
  Draft,
  LlmProviderConfig,
  RetrievedChunk,
  Segment,
  Source,
  Tag,
  WebArticleDateStats,
  WebSite,
  WritingTask,
  TaskMode
} from './types'

// ============================================================
// 通道名常量（供 preload / main 引用，避免硬编码字符串重复）
// ============================================================

export const IPC = {
  /* 资料 */
  SOURCES_LIST: 'sources:list',
  SOURCES_IMPORT_FILES: 'sources:importFiles',
  SOURCES_ADD_URL: 'sources:addUrl',
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

  /* 资料汇编（Phase 6：三段式撰写重构） */
  COMPILATION_LIST: 'compilation:list',
  COMPILATION_GET: 'compilation:get',
  COMPILATION_GENERATE: 'compilation:generate',
  COMPILATION_CONTINUE: 'compilation:continue',
  /**
   * 生成前的**材料规模预检**（只读，2026-10-05 用户要求 P1）：界面在真正开始生成之前弹一次确认，
   * 显示预计规模与耗时（只提示、不限制）。主进程侧只跑与生成同一条「候选召回 + 保守闸门」路径，
   * **不落库、不抓网页、不调大模型**——因此本轮将要抓取的网页资料不计入估算。
   */
  COMPILATION_ESTIMATE_MATERIALS: 'compilation:estimateMaterials',
  /**
   * 2026-10-06（Phase 11 E 用户需求 ②）：生成前的**就绪检查**——本次生成要用到的资料是否都已建立缓存/索引。
   * 只读、不花钱；界面据此决定"弹预检确认框"还是"弹阻断提示 + 去设置页建立"（严格阻断、无逃生门）。
   */
  COMPILATION_READINESS: 'compilation:readiness',
  COMPILATION_RESOLVE_CONTRADICTION: 'compilation:resolveContradiction',
  COMPILATION_CONFIRM: 'compilation:confirm',
  COMPILATION_REORDER: 'compilation:reorder',
  /* Phase 7.4：版本列表（对话编辑的乐观锁基线；两版差异 / 版本恢复通道已随 Phase 7.7 删除） */
  COMPILATION_VERSIONS: 'compilation:versions',
  /* Phase 7.5：与文档对话（大模型以 ops 修改汇编）与对话历史 */
  COMPILATION_DOC_EDIT: 'compilation:doc:edit',
  COMPILATION_MESSAGES: 'compilation:messages',
  COMPILATION_UNDO: 'compilation:undo',
  COMPILATION_REDO: 'compilation:redo',
  COMPILATION_UNDO_STATE: 'compilation:undoState',
  COMPILATION_RECYCLE_BIN_LIST: 'compilation:recycleBin:list',
  COMPILATION_RECYCLE_BIN_RESTORE: 'compilation:recycleBin:restore',
  COMPILATION_EXPORT_DOCX: 'compilation:exportDocx',
  COMPILATION_EXPORT_ARCHIVE: 'compilation:exportArchive',
  COMPILATION_IMPORT_ARCHIVE: 'compilation:importArchive',
  COMPILATION_IMPORT_FROM_TASK: 'compilation:importFromTask',
  COMPILATION_LIST_FINALIZED_FOR_IMPORT: 'compilation:listFinalizedForImport',

  /* 规范文档库（Phase 6.4.1：第二步「指定行文规范」） */
  STYLE_GUIDE_LIST: 'styleGuide:list',
  STYLE_GUIDE_SAVE: 'styleGuide:save',
  STYLE_GUIDE_SET_DEFAULT: 'styleGuide:setDefault',
  STYLE_GUIDE_DELETE: 'styleGuide:delete',

  /* 撰写与初稿 */
  WRITING_CREATE_TASK: 'writing:createTask',
  WRITING_LIST_TASKS: 'writing:listTasks',
  WRITING_DELETE_TASK: 'writing:deleteTask',
  WRITING_RENAME_TASK: 'writing:renameTask',
  WRITING_UPDATE_PROVIDER: 'writing:updateProvider',
  WRITING_GET_MODEL_TEXT: 'writing:getModelText',
  WRITING_SET_MODEL_TEXT: 'writing:setModelText',
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

  /* LLM */
  LLM_LIST_PROVIDERS: 'llm:listProviders',
  LLM_SAVE_PROVIDER: 'llm:saveProvider',
  LLM_DELETE_PROVIDER: 'llm:deleteProvider',
  LLM_TEST_CONNECTION: 'llm:testConnection',

  /* 设置 */
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',

  /* 本地向量索引（语义检索）状态与重建（2026-09-12：索引失败原因此前无处可查） */
  RAG_INDEX_STATUS: 'rag:indexStatus',
  RAG_REINDEX: 'rag:reindex',

  /* 来源本地快照（第三批 C：网页会改版/撤稿，溯源要看抓取当时存下来的正文） */
  SOURCES_GET_SNAPSHOT: 'sources:getSnapshot',
  /**
   * 来源块表（Phase 9 高亮补充，2026-10-03）：
   * 渲染层据此把"锚点块号"换算成**字符区间 / 页码**，从而在查看器里画一个短暂的高亮框
   * （只读、只在该来源已生成块表时有内容）。
   */
  SOURCES_BLOCKS: 'sources:blocks',

  /* 内嵌网页浏览器（Phase 8 / S4：网页来源直接看原网页，而不是本地快照） */
  /** 打开内嵌浏览器并加载某条网页来源；rect 为它在窗口内容区中的位置（DIP） */
  WEB_BROWSER_OPEN: 'web:browserOpen',
  /** 分栏尺寸/位置变化时更新浏览器视图的位置 */
  WEB_BROWSER_SET_BOUNDS: 'web:browserSetBounds',
  /** 关闭并销毁内嵌浏览器 */
  WEB_BROWSER_CLOSE: 'web:browserClose',
  /** 地址栏导航（只允许 http/https） */
  WEB_BROWSER_NAVIGATE: 'web:browserNavigate',
  /** 后退 / 前进 / 重新加载 */
  WEB_BROWSER_ACTION: 'web:browserAction',

  /* 2026-10-05 P6 已删除：`COMPILATION_WEB_MATERIALS`（旧的「本任务已锁定 N 篇网页材料」只读计数）。
     网页材料自 Phase 10 P5 起改为**任务级全量重抓重筛**（`task_web_fetch` 账本），表 `task_web_materials`
     的"锁定"语义已不再参与生成，连同该只读入口一并删除（表本身按项目约定保留不删）。 */
  // 来源位置（锚点）统计（只读，Phase 9 / S4 补）
  COMPILATION_ANCHOR_STATS: 'compilation:anchorStats',
  // 疑似超出范围的段落复核（Phase 9 补充：界面兜底）
  // 2026-10-05 用户裁定：这类提示无实际价值，**界面入口已整体关闭**（越界段落直接保留）；
  // 通道与主进程实现**保留不动**，避免影响导出导入与旧数据。
  COMPILATION_SCOPE_CHECK: 'compilation:scopeCheck',
  COMPILATION_EXCLUDE_ITEMS: 'compilation:excludeItems',

  /* 工作区（Phase 2.2） */
  WORKSPACE_STATUS: 'workspace:status',
  WORKSPACE_MIGRATE: 'workspace:migrate',
  WORKSPACE_NAV_SYNC: 'workspace:navSync',
  WORKSPACE_SOURCE_REMOVAL_LIST: 'workspace:sourceRemoval:list',
  WORKSPACE_SOURCE_REMOVAL_DECIDE: 'workspace:sourceRemoval:decide',

  /* 应用元数据（Task 1.1 已实现） */
  APP_GET_INFO: 'app:getInfo',
  // pdf.js cMaps 资源基址（渲染层预览中文/ CID 字体 PDF 需要）
  APP_GET_PDF_CMAPS_URL: 'app:getPdfCmapsUrl',

  /* 系统文件/目录选择对话框（安全：主进程打开，仅回传路径） */
  APP_OPEN_FILE_DIALOG: 'app:openFileDialog',
  APP_OPEN_DIRECTORY_DIALOG: 'app:openDirectoryDialog',

  /* 打开外部链接（预设模型注册页等） */
  APP_OPEN_EXTERNAL: 'app:openExternal',

  /* 剪贴板（2026-08-20：沙箱渲染进程经主进程读写系统剪贴板，用于自定义右键菜单的复制/粘贴） */
  CLIPBOARD_READ_TEXT: 'clipboard:readText',
  CLIPBOARD_WRITE_TEXT: 'clipboard:writeText',

  /* 网页资料库（2026-08-11：站点注册/列表/删除/同步文章清单） */
  WEB_SOURCE_LIST: 'webSource:list',
  WEB_SOURCE_ADD: 'webSource:add',
  WEB_SOURCE_REMOVE: 'webSource:remove',
  WEB_SOURCE_UPDATE: 'webSource:update',
  /** Phase 10 P3：目录的日期统计（年份区间预览：区间内 N 篇 / 占比 / 预计抓取时长；只读、不抓取）。
   *  2026-10-05（用户裁定 A）：入口从资料库面板移到**任务流程的年份控件**，此通道保留。 */
  WEB_SOURCE_DATE_STATS: 'webSource:dateStats',
  /* 2026-10-05 P6 已删除三个手动抓取通道：WEB_SOURCE_CRAWL / WEB_SOURCE_CRAWL_CANCEL /
     WEB_SOURCE_RESET_FETCH_STATE（抓取由生成管线按任务自动完成，见 `compilation-service`）。 */
  /** 2026-10-05（用户要求）：**暂停/继续抓取**——暂停期间不发新请求，账本与缓存都保留，点「继续」从原处接着跑 */
  WEB_SOURCE_SET_CRAWL_PAUSED: 'webSource:setCrawlPaused',
  /** 2026-10-05：正文缓存占用（多少篇 / 多少字节），资料库面板显示用 */
  WEB_SOURCE_CACHE_STATS: 'webSource:cacheStats',
  /** 2026-10-05：清空正文缓存（只删缓存；sources / 目录 / 账本都不动） */
  WEB_SOURCE_CLEAR_CACHE: 'webSource:clearCache',
  /**
   * 2026-10-06（用户需求）：「建立缓存与索引」的**只读规划**——区间内共几篇 / 已有几篇 /
   * 还要建几篇 / 几篇永远建不了（越权地址）+ 本地待索引几篇。**只读**：不写库、不抓网页、不调模型。
   */
  CACHE_BUILD_PLAN: 'cacheBuild:plan',
  /**
   * 2026-10-06（用户需求，Phase 11 C）：「建立缓存与索引」的**启动 / 停止 / 状态**。
   * - `start`：启动一次建立（网页正文缓存 + 本地索引并行）；已在建立中会被拒绝（不重复建立）；
   * - `stop`：只停止"抓新的"（已抓到的都已写入缓存）；
   * - `status`：界面轮询进度（`local` 部分实时取自 rag 队列）。
   */
  CACHE_BUILD_START: 'cacheBuild:start',
  CACHE_BUILD_STOP: 'cacheBuild:stop',
  CACHE_BUILD_STATUS: 'cacheBuild:status',
  /** Phase 10 P5：设置该任务的网页资料年份区间（按任务保存；新建任务继承全局默认） */
  WRITING_SET_WEB_YEARS: 'writing:setWebYears',

  /* 窗口 */
  WINDOW_FOCUS: 'window:focus',

  /* 诊断日志（2026-08-14：渲染进程上报 + 导出文件） */
  LOG_APPEND: 'log:append',
  LOG_EXPORT: 'log:export'
} as const

/** 主进程 → 渲染进程 的推送事件名（非请求/响应通道） */
export const IPC_EVENTS = {
  /** 生成初稿阶段进度：{ taskId, stage } */
  DRAFT_GENERATE_PROGRESS: 'draft:generateProgress',
  /** 工作区对账进度（含完成事件 finished 与最终计数），主进程推送到所有渲染窗口 */
  WORKSPACE_PROGRESS: 'workspace:progress',
  /** 生成初稿/自由对话的流式增量文本：{ taskId, text }（2026-08-19，供聊天面板实时显示） */
  WRITING_STREAM_DELTA: 'writing:streamDelta',
  /** 资料汇编生成进度：{ taskId, stage, percent, etaSeconds?, candidateChunks?, candidateSources? }（Phase 6.1） */
  COMPILATION_PROGRESS: 'compilation:progress',
  /** 资料汇编生成/续传过程中的建议提示（如 429 限流后建议降低 Provider 并发数）：{ taskId, message }（Phase A/B） */
  COMPILATION_ADVICE: 'compilation:advice',
  /** 工作区文件被移除且已被资料汇编引用：需用户确认是否删除该来源的卡片（2026-08-28） */
  WORKSPACE_SOURCE_REMOVED: 'workspace:sourceRemoved'
  /* 2026-10-05 P6 已删除：WEB_CRAWL_PROGRESS（手动抓取进度事件，随手动抓取入口一起删除） */
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
export interface WebSourceUpdateReq {
  id: string
  rootUrl?: string
  title?: string
}
export type WebSourceUpdateRes = { site: WebSite }

/** Phase 10 P3：年份区间筛选预览（只读；只统计目录，不抓正文） */
export interface WebSourceDateStatsReq {
  fromYear: number
  toYear: number
}
export type WebSourceDateStatsRes = { stats: WebArticleDateStats }

/**
 * 2026-10-06（用户需求）：「建立缓存与索引」的**只读规划**。
 * 省略年份时按需求默认区间（2005–2025）计算；反向/非法年份返回错误而不是静默采用。
 */
export interface CacheBuildPlanReq {
  fromYear?: number
  toYear?: number
}

/** 启动一次「建立缓存与索引」（Phase 11 C） */
export interface CacheBuildStartReq {
  fromYear?: number
  toYear?: number
  /** 默认 `true`：同时把本地资料库未索引的排队（与网页抓取**并行**）；`false` = 只建网页正文缓存 */
  includeLocal?: boolean
}

/** Phase 10 P5：设置**该任务**的网页资料年份区间（null = 清除任务级设置、回退全局默认） */
export interface WritingSetWebYearsReq {
  taskId: string
  fromYear: number | null
  toYear: number | null
}
export type WritingSetWebYearsRes = { task: WritingTask }

export interface SourceGetReq {
  id: string
}
export interface SourceDeleteManyReq {
  ids: string[]
}
export type SourceRenderHtmlReq = SourceGetReq
export type SourceRenderHtmlRes = { html: string }
export type SourceGetFileUrlRes = { url: string }
/** 来源块表：供查看器把锚点块号换算成字符区间/页码（高亮用） */
export interface SourceBlocksRes {
  blocks: { blockIndex: number; charStart: number; charEnd: number; page: number | null }[]
}

/**
 * 内嵌网页浏览器（Phase 8 / S4）。
 * `rect` 用**窗口内容区坐标（DIP）**：渲染层用 `getBoundingClientRect()` 量出分栏位置后原样上报。
 */
export interface WebBrowserRect {
  x: number
  y: number
  width: number
  height: number
}
export interface WebBrowserOpenReq {
  sourceId: string
  rect: WebBrowserRect
}
export interface WebBrowserSetBoundsReq {
  rect: WebBrowserRect
}
export interface WebBrowserNavigateReq {
  url: string
}
/** 只暴露前进/后退/重新加载三种动作：不做通用脚本执行，避免界面层获得额外能力 */
export type WebBrowserAction = 'back' | 'forward' | 'reload'
export interface WebBrowserActionReq {
  action: WebBrowserAction
}
export type WebBrowserStateRes = {
  /** 当前实际地址（重定向后会变） */
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}
/** 删除单个资料的结果：pendingCascade=true 表示该来源被资料汇编引用，已进入级联清理确认流程（来源尚未删除） */
export type SourceDeleteRes = { pendingCascade: boolean }
/** 批量删除资料的结果：pendingCascade=true 表示至少一个来源被资料汇编引用，已进入级联清理确认流程（这些来源尚未删除） */
export type SourceDeleteManyRes = { pendingCascade: boolean }
export interface SourceUpdateTitleReq {
  id: string
  title: string
}
export type SourceSummarizeAllRes = { processed: number; ok: number; failed: number }

/**
 * 本地向量索引状态（2026-09-12）：语义检索依赖 onnxruntime 引擎与本地模型，任一不可用都会让
 * 全部资料的 `index_state` 变成 failed——此前失败原因只在日志里，界面看不到。此契约把
 * 计数 + 最近失败原因透出，并支持"重建索引"（后台串行队列，界面轮询本接口看进度）。
 */
export type RagIndexStatusRes = {
  total: number
  ready: number
  pending: number
  indexing: number
  failed: number
  lastError: string | null
  lastErrorAt: string | null
  /** 后台队列里尚未处理的资料数（>0 表示正在重建） */
  queued: number
  /**
   * 重建进度（持久化在 settings.index_rebuild，**跨页面/跨重启保留**）：
   * status=running 正在跑；interrupted=上次被关软件打断（可「继续重建」）；done=已完成。
   * percent = (totalQueued − remaining) / totalQueued，重启后仍可算。
   */
  rebuild: {
    status: 'running' | 'interrupted' | 'done'
    startedAt: string | null
    totalQueued: number
    remaining: number
    processed: number
    percent: number
    active: boolean
  }
  /** 引擎自检（2026-09-12）：确认到底在跑 Worker 池多线程，还是一直在静默回退单线程 */
  engine?: {
    poolSize: number
    livePool: number
    workerThreads: number
    workerErrors: number
    directFallbacks: number
    lastWorkerError: string | null
  }
}
export type RagReindexRes = { queued: number; reset: number }

/**
 * 来源本地快照（第三批 C）：返回库里已存的正文快照（不联网），供"查看本地快照"弹窗使用。
 * `truncated` 为 true 表示正文过长被截断；`shortText` 提示正文过短（疑似只抓到导航/页脚，E3）。
 */
export interface SourceSnapshotReq {
  id: string
}
export type SourceSnapshotRes = {
  id: string
  kind: 'file' | 'url'
  title: string
  url?: string
  /** 抓取时间（网页来源；ISO） */
  snapshotAt?: string
  /** 发布时间（网页来源，若解析到） */
  publishedAt?: string
  text: string
  totalChars: number
  truncated: boolean
  shortText: boolean
}

/**
 * 来源位置（锚点）的统计（只读，Phase 9 / S4 补：锚点是生成后台异步写的，此前完全看不见）。
 * `ambiguous` = 该段的证据/正文在来源里出现**多处**（主来源按此检查），说明位置可能不是唯一那处。
 */
/**
 * 「疑似超出范围」复核（Phase 9 补充，2026-10-03 用户裁定「界面兜底」）：
 * 只做确定性提示（命中"全省/省级/国家"标记且通篇不提要求里点名的本地地名），由用户决定移出。
 */
export interface CompilationScopeCheckReq {
  compilationId: string
}
export interface CompilationScopeFlagDto {
  id: string
  position: number
  text: string
  sourceTitle?: string
  /** 命中的上级/全省/国家标记词 */
  markers: string[]
}
export type CompilationScopeCheckRes = {
  flagged: CompilationScopeFlagDto[]
  /** 被检查的段落数 */
  checked: number
  /** false = 撰写要求里没有可依据的范围线索（没点名本地地名、也没写排除上级）→ 本次不做提示 */
  available: boolean
  /** 从要求里解析出的本地地名（界面如实说明"按什么在查"） */
  localities: string[]
}
/** 移出汇编 = 标记 `kept=false`（不删数据、可撤销、有版本记录） */
export interface CompilationExcludeItemsReq {
  compilationId: string
  itemIds: string[]
}
export type CompilationExcludeItemsRes = {
  compilation: Compilation
  excluded: number
  message: string
}
export interface CompilationAnchorStatsReq {
  compilationId: string
}
export type CompilationAnchorStatsRes = {
  /** 段落总数 */
  total: number
  /** 有来源位置的段数 */
  anchored: number
  /** 其中**有页码**的段数（PDF 来源；其余为无页概念的来源，界面报"第 N 段"） */
  withPage: number
  /** 其中引文在来源里出现多处的段数（如实统计，不做消歧） */
  ambiguous: number
}
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

// -- 资料汇编（Phase 6：三段式撰写重构） --
export interface CompilationListReq {
  taskId: string
}
export type CompilationListRes = { compilations: Compilation[] }

export interface CompilationGetReq {
  compilationId: string
}
export type CompilationGetRes = { compilation: Compilation }

export interface CompilationGenerateReq {
  taskId: string
  title: string
  /**
   * 第二组 ⑤ 的**逃生门**（2026-10-06 用户已同意）：`true` = 本轮**不做收敛**（全量送入），
   * 跳过"文章内取高信号段 ± 上下文"，行为回到今天。**每次生成单独选择、不持久化**。
   */
  skipConvergence?: boolean
}
/**
 * 生成前的「材料规模预检」（只读，2026-10-05 用户要求 P1）。
 * `instruction` 就是本次的撰写要求原文——估算要用它取粗筛关键词（与生成同口径），
 * 但**不用它调用大模型**（只用本地兜底关键词或已缓存结果）。
 */
export interface CompilationEstimateMaterialsReq {
  taskId: string
  instruction: string
}

/** 生成前就绪检查的请求（Phase 11 E） */
export interface CompilationReadinessReq {
  taskId: string
}
/**
 * 第二组 ⑤：**文章内取高信号段 ± 上下文**的统计（随生成结果/预检透出，用于如实汇报）。
 * 取舍只由信号决定（有信号就留），**不设每篇段数或总字数上限**；被跳过的段仍留在库里。
 */
export interface CompilationConvergence {
  /** 上下文半径（单位：段） */
  contextRange: number
  /** 闸门后（= 勾选「本轮不做收敛」时的口径）的段数 / 字数 */
  gatedSegments: number
  gatedChars: number
  /** 参与取段的来源数（= 闸门放行的来源里有切段的那些） */
  sources: number
  /** 这些来源正文的全部切段与字数 */
  articleSegments: number
  articleChars: number
  /** ⑤ 收敛后（**本轮真正送细读**）的段数 / 字数 */
  keptSegments: number
  keptChars: number
  /** 因无信号未送（**仍在库中、仍可打开**）的段数 / 字数 */
  droppedSegments: number
  droppedChars: number
  /** 整篇无信号、本轮整篇不送的来源数 */
  noSignalSources: number
  /** ⑤ 按"有信号 / 紧邻上下文"从闸门之外重新纳入的段数 */
  reIncludedSegments: number
}
export type CompilationEstimateMaterialsRes = {
  /** **收敛后**进入本轮细读的段落数（= 界面确认框默认展示的口径） */
  segments: number
  /** 这些段落的正文总字数 */
  chars: number
  /** 其中本地文件来源的段数 */
  localSegments: number
  /** 其中网页来源的段数（只含本任务**已纳入**的网页来源，不含本轮将要抓取的量） */
  webSegments: number
  /** 预计细读窗口数（= ceil(chars / WINDOW_MAX_CHARS)，与生成管线同一常量） */
  estimatedWindows: number
  /** 预计耗时（分钟，按单窗口 ETA 先验折算，仅用于提示） */
  estimatedMinutes: number
  /** 「本轮不做收敛（全量送入）」口径的段数 / 字数 / 窗口数 / 预计分钟 */
  fullSegments: number
  fullChars: number
  fullEstimatedWindows: number
  fullEstimatedMinutes: number
  /** 本轮因无信号未送（仍在库中）的段数 / 字数 */
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
 * 生成管线内各「后置阶段」的结果摘要（供渲染层在生成汇总里提示/统计）：
 * - extractScan：整合提取阶段（卡片 → 段落、字数变化，以及本地校验/降级/冲突保留等诊断；
 *   ok=false 表示超预算未跑完，其余卡片按原文整段保留）
 * - contradictionScan：卡片矛盾扫描（ok=false 表示超预算未扫完，可能存在遗漏）
 */
export type CompilationStageScan = { ok: boolean; message?: string }
export type CompilationExtractScan = CompilationStageScan & {
  inputCards?: number
  outputParagraphs?: number
  inputChars?: number
  outputChars?: number
  /** 通过本地校验（证据逐字 + 数字有据）的段落数 */
  accepted?: number
  /** 校验失败而降级的段落数 */
  degraded?: number
  /** 降级原因细分：正文里的数字在来源中找不到（幻觉嫌疑） */
  invalidNumbers?: number
  /** 降级原因细分：证据引文不是来源原文（2026-10-03 起不再是失败原因） */
  invalidEvidence?: number
  /** 2026-10-03：证据未逐字命中、但事实逐句核验通过而接受（证据从门槛降为充分度） */
  evidenceLoose?: number
  /** 兜底粒度细分：只保留了 evidence 片段（粒度最细） */
  degradedFromEvidence?: number
  /** 因"没有可用的逐字证据"（含模型未作答、整批输出无法解析）而丢弃的卡片数（A1，2026-10-03） */
  droppedUnverifiable?: number
  /** 其中因"输出无法解析/无法再拆分重试"而丢弃的卡片数（B：对半重试之后的残余） */
  droppedUnparseable?: number
  /** 模型判定与主题无关而整卡丢弃 */
  droppedCards?: number
  /** 模型始终未回答的卡片数（重问后仍未答，且已按 A1 丢弃） */
  omitted?: number
  /** 因"段落只是复述来源标题、没有正文信息"而丢弃的段落数（2026-09-12：绝不能只看文章标题） */
  titleOnlyDropped?: number
  /** 因"年份在来源里查不到、也推不出"而降级为「时间待核」的段落数 */
  timeUnsupported?: number
  /** 成文阶段被判为重复而合并掉的段数 */
  duplicatesDropped?: number
  /** 疑似同一事实但数字不一致、特意保留的段数（矛盾候选） */
  conflictsKept?: number
}
/**
 * 网页资料库本轮抓取情况（**2026-10-05 P6 对齐 Phase 10 P4/P5 口径**）：
 * 「按发布时间全量抓取 → 只看正文判相关性 → 未命中的正文丢弃」——**不再有篇数上限**，
 * 因此 `skippedByCap` / `reused` / `newCandidates`（旧的"锁定 300 篇 / 上限截断"语义）已删除。
 */
export type CompilationWebScan = {
  sites: number
  /** 同步失败的站点数（>0 = 本轮网页材料可能不完整） */
  siteErrors: number
  /** 本轮**实际抓取**的篇数（= 采用 + 未命中丢弃） */
  hits: number
  /** 通过正文相关性判定、落成该任务来源的篇数 */
  fetched: number
  /** 落库正文总字数 */
  chars: number
  /** 正文**未通过相关性判定**而丢弃的篇数（正文按裁定丢弃，只留哈希与字数） */
  relevanceDropped?: number
  /** A1 标题探针不过（老文章失效 → 站点返回通用模板页）而丢弃的篇数（2026-10-05 由 `article-crawl` 计数） */
  invalidBody?: number
  /** 空标题候选（sitemap）判为模板/失效页 / 与同站其它 URL 正文逐字相同的篇数 */
  shortBody?: number
  templateRepeat?: number
  /** 单篇抓取失败（网络/超时/非 2xx）的篇数 */
  fetchFailed?: number
  /** 不在「http(s) + 同域白名单」内、未发起请求的篇数（安全过滤，2026-10-05） */
  blocked?: number
}
export type CompilationGenerateRes = {
  compilation: Compilation
  contradictionScan?: CompilationStageScan
  extractScan?: CompilationExtractScan
  webScan?: CompilationWebScan
  /** 第二组 ⑤：本轮的取段统计（勾选「本轮不做收敛」时为 undefined） */
  convergence?: CompilationConvergence
  /** 本轮**真正送细读**的候选块数（勾选「本轮不做收敛」时 = 闸门后的全部段数） */
  candidateChunks?: number
  interrupted?: CompilationInterrupt
}
/** 中断续跑（Phase 6.x：会话内断点续传） */
export interface CompilationContinueReq {
  compilationId: string
}
export type CompilationContinueRes = {
  compilation: Compilation
  contradictionScan?: CompilationStageScan
  extractScan?: CompilationExtractScan
  webScan?: CompilationWebScan
  interrupted?: CompilationInterrupt
}
/** 资料汇编卡片重新按时间排序（2026-08-28）：asc = 正序（旧→新），desc = 反序（新→旧） */
export interface CompilationReorderReq {
  compilationId: string
  direction: 'asc' | 'desc'
}
export type CompilationReorderRes = { compilation: Compilation }
/* ---- Phase 7.4：版本管控（列表 / 两版差异 / 恢复到某版） ---- */
export interface CompilationVersionsReq {
  compilationId: string
}
export type CompilationVersionsRes = { versions: CompilationVersionSummary[] }
/** 差异段（主进程算好、渲染层只负责画）；供对话编辑返回的「本次改动前后」差异使用 */
export interface CompilationVersionDiffSegment {
  kind: 'added' | 'removed' | 'modified' | 'unchanged'
  id: string
  prevText?: string
  nextText?: string
  inline?: { type: 'same' | 'add' | 'del'; text: string }[]
  /** 仅 removed：渲染时插回"该段被删除前紧邻的下一段"之前（缺省 = 原本在最后） */
  beforeId?: string
}
/* ---- Phase 7.5：与文档对话（req 内联类型，避免为一个字段新增共享类型） ---- */

export interface CompilationDocEditReq {
  compilationId: string
  instruction: string
  /** 乐观锁：发起时看到的最新版本号；与当前不一致则拒绝（避免并发覆盖） */
  baseVersionNo?: number
}
export type CompilationDocEditRes = {
  compilation: Compilation
  reply: string
  applied: number
  rejected: { op: string; reason: string }[]
  versionNo?: number
  /** 本次改动的段 id（前端滚动到首个改动段） */
  changedIds: string[]
  changeSummary: { added: number; modified: number; removed: number }
  /**
   * **本次修改前后**的差异（主进程按"改前的段落快照 vs 改后的段落快照"直接算，而不是靠版本号推算）。
   * 用户 2026-09-10 裁定：对话修改完成后**自动进入对比模式**让用户「采纳 / 回退」，不需要用户再点按钮；
   * 因此基线就是这次的改前状态，与"上一版版本"无关（版本可能被回退、被裁剪，用它当基线会算错差异）。
   */
  diff: {
    segments: CompilationVersionDiffSegment[]
    summary: { added: number; removed: number; modified: number; unchanged: number }
  }
  /** 补漏（B 方案）：本地检索到的候选原文条数 */
  candidates: number
  /** 补漏检索状态：ok 有候选 · empty 没找到 · failed 检索不可用 · skipped 本条要求未触发检索 */
  leakState: 'ok' | 'empty' | 'failed' | 'skipped'
  /** 本次新增段落里"逐字取自候选原文"的条数 */
  addedFromCandidates: number
}
export interface CompilationMessagesReq {
  compilationId: string
}
export type CompilationMessagesRes = { messages: { role: 'user' | 'assistant'; content: string; versionNo?: number; createdAt: string }[] }
/** 资料汇编操作撤销/恢复（2026-08-28）：undo/redo 返回最新汇编与各自可用步数 */
export interface CompilationUndoReq {
  compilationId: string
}
export interface CompilationUndoRes {
  compilation: Compilation
  undoAvailable: number
  redoAvailable: number
}
export type CompilationUndoStateRes = { undoAvailable: number; redoAvailable: number }

export interface CompilationResolveContradictionReq {
  contradictionId: string
  action: 'resolve' | 'ignore'
  /** action=resolve 时必填：用户保留的卡片 id（须属于该矛盾） */
  chosenItemId?: string
}
export type CompilationResolveContradictionRes = { contradiction: CompilationContradiction }

export interface CompilationConfirmReq {
  compilationId: string
}
export type CompilationConfirmRes = { compilation: Compilation }

export interface CompilationRecycleBinListReq {
  compilationId: string
}
export type CompilationRecycleBinListRes = { items: CompilationRecycleBinItem[] }

export interface CompilationRecycleBinRestoreReq {
  binId: string
}
export type CompilationRecycleBinRestoreRes = { contradiction?: CompilationContradiction }


/** 导出资料汇编为 .docx（生成汇编功能区，2026-09） */
export interface CompilationExportDocxReq { compilationId: string }
export type CompilationExportDocxRes = { path: string }
/** 导出资料汇编为软件专用格式 .xzsc（可被「撰写初稿」导入） */
export interface CompilationExportArchiveReq { compilationId: string }
export type CompilationExportArchiveRes = { path: string }
/** 从外部 .xzsc 导入资料汇编到「撰写初稿」任务（当前为预留：未实现解析） */
export interface CompilationImportArchiveReq { taskId: string; filePath: string }
export type CompilationImportArchiveRes = { compilation: Compilation }
/** 从「生成汇编」功能区已完成任务导入其资料汇编到「撰写初稿」任务（深拷贝） */
export interface CompilationImportFromTaskReq { taskId: string; sourceCompilationId: string }
export type CompilationImportFromTaskRes = { compilation: Compilation }
/** 列出「生成汇编」功能区所有已完成（finalized）汇编任务，供「撰写初稿」导入选择 */
export interface CompilationListFinalizedForImportReq {}
export type CompilationListFinalizedForImportRes = { items: { taskId: string; taskTitle: string; compilation: Compilation }[] }

/** 工作区来源移除待确认（2026-08-28）：文件被删除且已被资料汇编引用 */
export interface WorkspaceSourceRemovalPending {
  sourceId: string
  title: string
  /** 该来源在汇编中涉及的段数（Phase 7.12 起按并列来源关系表统计） */
  cardCount: number
  /** 其中还有其它来源共同记载的段数：这些段不会被删，主来源会改指剩余来源（Phase 7.12） */
  sharedCount: number
  contradictionCount: number
  /** workspace = 检测到工作区文件被删除；manual = 用户在资料库中直接删除该资料 */
  origin: 'workspace' | 'manual'
}
export type WorkspaceSourceRemovalListRes = { items: WorkspaceSourceRemovalPending[] }
export interface WorkspaceSourceRemovalDecideReq {
  sourceId: string
  /** delete = 删除该来源在全部资料汇编中的卡片（含矛盾，不入回收站）；keep = 仅删来源、保留卡片 */
  action: 'delete' | 'keep'
}
export type WorkspaceSourceRemovalDecideRes = { deletedItems: number; deletedContradictions: number }

export interface StyleGuideListRes { items: StyleGuide[] }

export interface StyleGuideSaveReq {
  id?: string // 缺省 = 新建；提供 = 覆盖
  name: string
  content: string
}
export type StyleGuideSaveRes = { styleGuide: StyleGuide }

export interface StyleGuideSetDefaultReq {
  id: string
}
export type StyleGuideSetDefaultRes = { styleGuide: StyleGuide }

export interface StyleGuideDeleteReq {
  id: string
}

export type StyleGuideGetRes = { styleGuide: StyleGuide }

export interface StyleGuideGetReq {
  id: string
}

export interface StyleGuideDefaultRes { styleGuide: StyleGuide | null }

// -- 撰写与初稿 --
export interface WritingCreateTaskReq {
  /** 中栏显示的任务标题；缺省为"新建任务"（Phase 3.5 起点击"新建任务"立即创建） */
  title?: string
  /** 任务类型：generate-compile（生成汇编）或 write-draft（撰写初稿）；缺省 compile */
  mode?: TaskMode
  /** 文件范围；缺省为 { all: true }（资料库全部文件，用户不可自定） */
  scope?: { all: true } | { sourceIds: string[] } | { tagIds: string[] }
  templateBookId?: string
  llmProviderId?: string
}
export type WritingCreateTaskRes = { task: WritingTask }

export interface WritingListTasksReq { mode?: TaskMode }
export type WritingListTasksRes = { items: WritingTask[] }

export interface WritingDeleteTaskReq {
  id: string
}

export interface WritingRenameTaskReq {
  taskId: string
  title: string
}
export type WritingRenameTaskRes = { task: WritingTask }

export interface WritingUpdateProviderReq {
  taskId: string
  llmProviderId: string | null  // null = 回退全局当前 Provider
}
export type WritingUpdateProviderRes = { task: WritingTask }

export interface WritingGetModelTextReq {
  taskId: string
}
export type WritingGetModelTextRes = { text: string }

export interface WritingSetModelTextReq {
  taskId: string
  text: string
}
export type WritingSetModelTextRes = { text: string }

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
  /** 三步式（强制）：必须为已确认（finalized）的资料汇编 id；未提供/未确认返回 COMPILATION_NOT_FINALIZED */
  compilationId: string
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

// -- LLM --
export type LlmListProvidersRes = { items: LlmProviderConfig[] }

export interface LlmSaveProviderReq {
  id?: string
  name: string
  apiBase: string
  model: string
  apiKey?: string
  /** Phase B：并发窗口数（默认 4，范围 1–8） */
  concurrency?: number
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
export type WorkspaceMigrateRes = {
  migrated: number
  failed: number
  skipped: number
}

// -- 应用元数据 --
export type AppInfoRes = { version: string; platform: string }
export type AppGetPdfCmapsUrlRes = { url: string }

// -- 剪贴板（2026-08-20）--
export interface ClipboardWriteTextReq {
  text: string
}
export type ClipboardReadTextRes = { text: string }

// -- 打开外部链接 --
export interface AppOpenExternalReq {
  url: string
}

// -- 诊断日志（2026-08-14） --
export interface LogAppendReq {
  level?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'
  tag: string
  message: string
}
export type LogExportRes = { path: string; fileName: string }

// ============================================================
// 类型安全的 IPC 接口映射（供 preload 侧使用，确保返回值类型与通道绑定一致）
// ============================================================
export interface IpcMapping {
  // 应用元数据
  [IPC.APP_GET_INFO]: { _req: void; _res: ApiResult<AppInfoRes> }
  [IPC.APP_GET_PDF_CMAPS_URL]: { _req: void; _res: ApiResult<AppGetPdfCmapsUrlRes> }
  [IPC.APP_OPEN_EXTERNAL]: { _req: AppOpenExternalReq; _res: ApiResult<void> }
  [IPC.APP_OPEN_FILE_DIALOG]: { _req: void; _res: ApiResult<{ paths: string[] }> }
  [IPC.APP_OPEN_DIRECTORY_DIALOG]: { _req: void; _res: ApiResult<{ path: string | null }> }
  [IPC.CLIPBOARD_READ_TEXT]: { _req: void; _res: ApiResult<ClipboardReadTextRes> }
  [IPC.CLIPBOARD_WRITE_TEXT]: { _req: ClipboardWriteTextReq; _res: ApiResult<void> }

  // 窗口
  [IPC.WINDOW_FOCUS]: { _req: void; _res: ApiResult<void> }
  // 诊断日志（2026-08-14）
  [IPC.LOG_APPEND]: { _req: LogAppendReq; _res: ApiResult<void> }
  [IPC.LOG_EXPORT]: { _req: void; _res: ApiResult<LogExportRes> }
  // 资料
  [IPC.SOURCES_LIST]: { _req: SourceListReq; _res: ApiResult<SourceListRes> }
  [IPC.SOURCES_IMPORT_FILES]: { _req: SourceImportFilesReq; _res: ApiResult<SourceImportFilesRes> }
  [IPC.SOURCES_ADD_URL]: { _req: SourceAddUrlReq; _res: ApiResult<SourceAddUrlRes> }
  [IPC.WEB_SOURCE_LIST]: { _req: WebSourceListReq; _res: ApiResult<WebSourceListRes> }
  [IPC.WEB_SOURCE_ADD]: { _req: WebSourceAddReq; _res: ApiResult<WebSourceAddRes> }
  [IPC.WEB_SOURCE_REMOVE]: { _req: WebSourceRemoveReq; _res: ApiResult<void> }
  [IPC.WEB_SOURCE_UPDATE]: { _req: WebSourceUpdateReq; _res: ApiResult<WebSourceUpdateRes> }
  [IPC.WEB_SOURCE_DATE_STATS]: { _req: WebSourceDateStatsReq; _res: ApiResult<WebSourceDateStatsRes> }
  ,
  [IPC.WEB_SOURCE_SET_CRAWL_PAUSED]: { _req: { paused: boolean }; _res: ApiResult<{ paused: boolean }> },
  [IPC.WEB_SOURCE_CACHE_STATS]: {
    _req: Record<string, never>
    _res: ApiResult<{ entries: number; bytes: number; byState: { ok: number; 'no-body': number; blocked: number } }>
  },
  [IPC.WEB_SOURCE_CLEAR_CACHE]: { _req: Record<string, never>; _res: ApiResult<{ cleared: number }> },
  [IPC.CACHE_BUILD_PLAN]: { _req: CacheBuildPlanReq; _res: ApiResult<CacheBuildPlan> },
  [IPC.CACHE_BUILD_START]: { _req: CacheBuildStartReq; _res: ApiResult<CacheBuildStartRes> },
  [IPC.CACHE_BUILD_STOP]: { _req: Record<string, never>; _res: ApiResult<{ stopped: boolean }> },
  [IPC.CACHE_BUILD_STATUS]: { _req: Record<string, never>; _res: ApiResult<CacheBuildStatus> }
  [IPC.WRITING_SET_WEB_YEARS]: { _req: WritingSetWebYearsReq; _res: ApiResult<WritingSetWebYearsRes> }
  [IPC.SOURCES_GET]: { _req: SourceGetReq; _res: ApiResult<{ source: Source; tags: Tag[] }> }
  [IPC.SOURCES_RENDER_HTML]: { _req: SourceRenderHtmlReq; _res: ApiResult<SourceRenderHtmlRes> }
  [IPC.SOURCES_GET_FILE_URL]: { _req: SourceGetReq; _res: ApiResult<SourceGetFileUrlRes> }
  [IPC.SOURCES_DELETE]: { _req: SourceGetReq; _res: ApiResult<SourceDeleteRes> }
  [IPC.SOURCES_DELETE_MANY]: { _req: SourceDeleteManyReq; _res: ApiResult<SourceDeleteManyRes> }
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
  // 资料汇编（Phase 6）
  [IPC.COMPILATION_LIST]: { _req: CompilationListReq; _res: ApiResult<CompilationListRes> }
  [IPC.COMPILATION_GET]: { _req: CompilationGetReq; _res: ApiResult<CompilationGetRes> }
  [IPC.COMPILATION_GENERATE]: { _req: CompilationGenerateReq; _res: ApiResult<CompilationGenerateRes> }
  [IPC.COMPILATION_CONTINUE]: { _req: CompilationContinueReq; _res: ApiResult<CompilationContinueRes> }
  [IPC.COMPILATION_ESTIMATE_MATERIALS]: { _req: CompilationEstimateMaterialsReq; _res: ApiResult<CompilationEstimateMaterialsRes> },
  [IPC.COMPILATION_READINESS]: { _req: CompilationReadinessReq; _res: ApiResult<CompilationReadiness> }
  [IPC.COMPILATION_RESOLVE_CONTRADICTION]: { _req: CompilationResolveContradictionReq; _res: ApiResult<CompilationResolveContradictionRes> }
  [IPC.COMPILATION_CONFIRM]: { _req: CompilationConfirmReq; _res: ApiResult<CompilationConfirmRes> }
  [IPC.COMPILATION_REORDER]: { _req: CompilationReorderReq; _res: ApiResult<CompilationReorderRes> }
  [IPC.COMPILATION_VERSIONS]: { _req: CompilationVersionsReq; _res: ApiResult<CompilationVersionsRes> }
  [IPC.COMPILATION_DOC_EDIT]: { _req: CompilationDocEditReq; _res: ApiResult<CompilationDocEditRes> }
  [IPC.COMPILATION_MESSAGES]: { _req: CompilationMessagesReq; _res: ApiResult<CompilationMessagesRes> }
  [IPC.COMPILATION_UNDO]: { _req: CompilationUndoReq; _res: ApiResult<CompilationUndoRes> }
  [IPC.COMPILATION_REDO]: { _req: CompilationUndoReq; _res: ApiResult<CompilationUndoRes> }
  [IPC.COMPILATION_UNDO_STATE]: { _req: CompilationUndoReq; _res: ApiResult<CompilationUndoStateRes> }
  [IPC.COMPILATION_RECYCLE_BIN_LIST]: { _req: CompilationRecycleBinListReq; _res: ApiResult<CompilationRecycleBinListRes> }
  [IPC.COMPILATION_RECYCLE_BIN_RESTORE]: { _req: CompilationRecycleBinRestoreReq; _res: ApiResult<CompilationRecycleBinRestoreRes> }
  [IPC.STYLE_GUIDE_LIST]: { _req: void; _res: ApiResult<StyleGuideListRes> }
  [IPC.STYLE_GUIDE_SAVE]: { _req: StyleGuideSaveReq; _res: ApiResult<StyleGuideSaveRes> }
  [IPC.STYLE_GUIDE_SET_DEFAULT]: { _req: StyleGuideSetDefaultReq; _res: ApiResult<StyleGuideSetDefaultRes> }
  [IPC.STYLE_GUIDE_DELETE]: { _req: StyleGuideDeleteReq; _res: ApiResult<void> }
  // 撰写
  [IPC.WRITING_CREATE_TASK]: { _req: WritingCreateTaskReq; _res: ApiResult<WritingCreateTaskRes> }
  [IPC.WRITING_LIST_TASKS]: { _req: void; _res: ApiResult<WritingListTasksRes> }
  [IPC.WRITING_DELETE_TASK]: { _req: WritingDeleteTaskReq; _res: ApiResult<void> }
  [IPC.WRITING_RENAME_TASK]: { _req: WritingRenameTaskReq; _res: ApiResult<WritingRenameTaskRes> }
  [IPC.WRITING_UPDATE_PROVIDER]: { _req: WritingUpdateProviderReq; _res: ApiResult<WritingUpdateProviderRes> }
  [IPC.WRITING_GET_MODEL_TEXT]: { _req: WritingGetModelTextReq; _res: ApiResult<WritingGetModelTextRes> }
  [IPC.WRITING_SET_MODEL_TEXT]: { _req: WritingSetModelTextReq; _res: ApiResult<WritingSetModelTextRes> }
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
  // LLM
  [IPC.LLM_LIST_PROVIDERS]: { _req: void; _res: ApiResult<LlmListProvidersRes> }
  [IPC.LLM_SAVE_PROVIDER]: { _req: LlmSaveProviderReq; _res: ApiResult<LlmSaveProviderRes> }
  [IPC.LLM_DELETE_PROVIDER]: { _req: { id: string }; _res: ApiResult<void> }
  [IPC.LLM_TEST_CONNECTION]: { _req: { id: string }; _res: ApiResult<void> }
  // 设置
  [IPC.SETTINGS_GET]: { _req: void; _res: ApiResult<AppSettings> }
  [IPC.SETTINGS_UPDATE]: { _req: SettingsUpdateReq; _res: ApiResult<AppSettings> }
  // 本地向量索引状态与重建
  [IPC.RAG_INDEX_STATUS]: { _req: void; _res: ApiResult<RagIndexStatusRes> }
  [IPC.RAG_REINDEX]: { _req: void; _res: ApiResult<RagReindexRes> }
  // 来源本地快照
  [IPC.SOURCES_GET_SNAPSHOT]: { _req: SourceSnapshotReq; _res: ApiResult<SourceSnapshotRes> }
[IPC.SOURCES_BLOCKS]: { _req: SourceGetReq; _res: ApiResult<SourceBlocksRes> }
  // 内嵌网页浏览器（Phase 8 / S4）
  [IPC.WEB_BROWSER_OPEN]: { _req: WebBrowserOpenReq; _res: ApiResult<WebBrowserStateRes> }
  [IPC.WEB_BROWSER_SET_BOUNDS]: { _req: WebBrowserSetBoundsReq; _res: ApiResult<{ ok: true }> }
  [IPC.WEB_BROWSER_CLOSE]: { _req: void; _res: ApiResult<{ ok: true }> }
  [IPC.WEB_BROWSER_NAVIGATE]: { _req: WebBrowserNavigateReq; _res: ApiResult<WebBrowserStateRes> }
  [IPC.WEB_BROWSER_ACTION]: { _req: WebBrowserActionReq; _res: ApiResult<WebBrowserStateRes> }
  [IPC.COMPILATION_ANCHOR_STATS]: { _req: CompilationAnchorStatsReq; _res: ApiResult<CompilationAnchorStatsRes> }
  [IPC.COMPILATION_SCOPE_CHECK]: { _req: CompilationScopeCheckReq; _res: ApiResult<CompilationScopeCheckRes> }
  [IPC.COMPILATION_EXCLUDE_ITEMS]: { _req: CompilationExcludeItemsReq; _res: ApiResult<CompilationExcludeItemsRes> }
  // 工作区
  [IPC.WORKSPACE_STATUS]: { _req: void; _res: ApiResult<WorkspaceStatusRes> }
  [IPC.WORKSPACE_MIGRATE]: { _req: void; _res: ApiResult<WorkspaceMigrateRes> }
  [IPC.WORKSPACE_NAV_SYNC]: { _req: void; _res: ApiResult<void> }
  [IPC.WORKSPACE_SOURCE_REMOVAL_LIST]: { _req: void; _res: ApiResult<WorkspaceSourceRemovalListRes> }
  [IPC.WORKSPACE_SOURCE_REMOVAL_DECIDE]: { _req: WorkspaceSourceRemovalDecideReq; _res: ApiResult<WorkspaceSourceRemovalDecideRes> }
}
