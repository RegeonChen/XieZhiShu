import { contextBridge, ipcRenderer } from 'electron'
import { IPC, IPC_EVENTS } from '../shared/ipc'
import type { ApiResult } from '../shared/types'

interface ImportResults {
  results: { path: string; source?: unknown; error?: string }[]
}

const api = {
  getAppInfo(): Promise<ApiResult<{ version: string; platform: string }>> {
    return ipcRenderer.invoke(IPC.APP_GET_INFO)
  },
  /** 打开外部链接（预设模型注册页等，走系统默认浏览器） */
  openExternal(url: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.APP_OPEN_EXTERNAL, { url })
  },
  /** 读取系统剪贴板纯文本（自定义右键菜单「粘贴」用，经主进程访问 clipboard） */
  readClipboardText(): Promise<ApiResult<{ text: string }>> {
    return ipcRenderer.invoke(IPC.CLIPBOARD_READ_TEXT)
  },
  /** 写入系统剪贴板纯文本（自定义右键菜单「复制/剪切」用，经主进程访问 clipboard） */
  writeClipboardText(text: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.CLIPBOARD_WRITE_TEXT, { text })
  },
  /** 资料列表 */
  listSources(params?: { tagIds?: string[]; search?: string }): Promise<ApiResult<{ items: unknown[] }>> {
    return ipcRenderer.invoke(IPC.SOURCES_LIST, params)
  },
  /** 导入文件（路径数组，逐文件解析入库） */
  importFiles(paths: string[]): Promise<ApiResult<ImportResults>> {
    return ipcRenderer.invoke(IPC.SOURCES_IMPORT_FILES, { paths })
  },
  /** 打开系统文件选择对话框 */
  openFileDialog(): Promise<ApiResult<{ paths: string[] }>> {
    return ipcRenderer.invoke(IPC.APP_OPEN_FILE_DIALOG)
  },
  /** 打开系统目录选择对话框（工作区选择） */
  openDirectoryDialog(): Promise<ApiResult<{ path: string | null }>> {
    return ipcRenderer.invoke(IPC.APP_OPEN_DIRECTORY_DIALOG)
  },
  /** 标签列表 */
  listTags(): Promise<ApiResult<{ items: unknown[] }>> {
    return ipcRenderer.invoke(IPC.TAGS_LIST)
  },
  /** 创建标签 */
  createTag(name: string): Promise<ApiResult<{ tag: unknown }>> {
    return ipcRenderer.invoke(IPC.TAGS_CREATE, { name })
  },
  /** 添加信源网址 */
  addUrl(url: string): Promise<ApiResult<{ source: unknown }>> {
    return ipcRenderer.invoke(IPC.SOURCES_ADD_URL, { url })
  },

  // ---- 网页资料库（2026-08-11）----
  /** 网页资料库站点列表 */
  listWebSources(): Promise<ApiResult<{ sites: unknown[] }>> {
    return ipcRenderer.invoke(IPC.WEB_SOURCE_LIST, {})
  },
  /** 注册网页资料库站点（生成初稿时自动检索该站点相关文章） */
  addWebSource(rootUrl: string, title?: string): Promise<ApiResult<{ site: unknown }>> {
    return ipcRenderer.invoke(IPC.WEB_SOURCE_ADD, { rootUrl, title })
  },
  /** 删除网页资料库站点 */
  removeWebSource(id: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.WEB_SOURCE_REMOVE, { id })
  },
  /** 同步站点文章清单（发现新文章，返回新增数） */
  syncWebSource(id: string): Promise<ApiResult<{ articles: number }>> {
    return ipcRenderer.invoke(IPC.WEB_SOURCE_SYNC, { id })
  },
  /** 更新标签 */
  updateTag(id: string, name?: string): Promise<ApiResult<unknown>> {
    return ipcRenderer.invoke(IPC.TAGS_UPDATE, { id, name })
  },
  /** 删除标签 */
  deleteTag(id: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.TAGS_DELETE, { id })
  },
  /** 为资料打标签 */
  addTagToSource(sourceId: string, tagId: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.TAGS_ADD_TO_SOURCE, { sourceId, tagId })
  },
  /** 取消资料的标签 */
  removeTagFromSource(sourceId: string, tagId: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.TAGS_REMOVE_FROM_SOURCE, { sourceId, tagId })
  },
  /** 相似标签搜索（Top N） */
  searchTags(query: string, limit = 5): Promise<ApiResult<{ items: unknown[] }>> {
    return ipcRenderer.invoke(IPC.TAGS_SEARCH, { query, limit })
  },
  /** 批量打标 */
  batchAddTags(tagIds: string[], sourceIds: string[]): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.TAGS_BATCH_ADD, { tagIds, sourceIds })
  },
  /** 获取带有指定标签的所有资料 ID */
  getTagSourceIds(tagId: string): Promise<ApiResult<{ sourceIds: string[] }>> {
    return ipcRenderer.invoke(IPC.TAGS_SOURCES_BY_TAG, { tagId })
  },
  /** 获取资料详情 */
  getSource(id: string): Promise<ApiResult<{ source: unknown; tags: unknown[] }>> {
    return ipcRenderer.invoke(IPC.SOURCES_GET, { id })
  },
  /** 将 .docx 资料转换为 HTML（保留排版） */
  renderSourceHtml(id: string): Promise<ApiResult<{ html: string }>> {
    return ipcRenderer.invoke(IPC.SOURCES_RENDER_HTML, { id })
  },
  /** 获取资料文件的本地访问 URL（PDF/图片等通过 xie-file:// 协议渲染） */
  getSourceFileUrl(id: string): Promise<ApiResult<{ url: string }>> {
    return ipcRenderer.invoke(IPC.SOURCES_GET_FILE_URL, { id })
  },
  /** 删除单个资料 */
  deleteSource(id: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.SOURCES_DELETE, { id })
  },
  /** 批量删除资料 */
  deleteSources(ids: string[]): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.SOURCES_DELETE_MANY, { ids })
  },
  /** 修改资料标题（工作区文件同步重命名） */
  updateSourceTitle(id: string, title: string): Promise<ApiResult<unknown>> {
    return ipcRenderer.invoke(IPC.SOURCES_UPDATE_TITLE, { id, title })
  },
  /** 整理资料库：对尚无摘要的资料逐篇生成 LLM 摘要 */
  summarizeAll(): Promise<ApiResult<{ processed: number; ok: number; failed: number }>> {
    return ipcRenderer.invoke(IPC.SOURCES_SUMMARIZE_ALL)
  },
  /** 读取单篇资料摘要 */
  getSourceSummary(id: string): Promise<ApiResult<{ summary?: unknown }>> {
    return ipcRenderer.invoke(IPC.SOURCES_GET_SUMMARY, { id })
  },
  /** 写作规范 skills 列表 */
  listSkills(): Promise<ApiResult<{ items: unknown[] }>> {
    return ipcRenderer.invoke(IPC.SKILLS_LIST)
  },
  /** 新建规范 skill */
  createSkill(input: { name: string; category: 'general' | 'section'; tags: string[]; content: string }): Promise<ApiResult<{ skill: unknown }>> {
    return ipcRenderer.invoke(IPC.SKILLS_CREATE, input)
  },
  /** 修改规范 skill */
  updateSkill(id: string, input: { name: string; category: 'general' | 'section'; tags: string[]; content: string }): Promise<ApiResult<{ skill: unknown }>> {
    return ipcRenderer.invoke(IPC.SKILLS_UPDATE, { ...input, id })
  },
  /** 删除规范 skill */
  deleteSkill(id: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.SKILLS_DELETE, { id })
  },
  /** Provider 列表（只回 apiKeySet，不回密钥） */
  listProviders(): Promise<ApiResult<{ items: unknown[] }>> {
    return ipcRenderer.invoke(IPC.LLM_LIST_PROVIDERS)
  },
  /** 保存 Provider（新建/编辑；apiKey 可选，本地加密存储） */
  saveProvider(input: { id?: string; name: string; apiBase: string; model: string; apiKey?: string }): Promise<ApiResult<{ provider: unknown }>> {
    return ipcRenderer.invoke(IPC.LLM_SAVE_PROVIDER, input)
  },
  /** 删除 Provider */
  deleteProvider(id: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.LLM_DELETE_PROVIDER, { id })
  },
  /** 测试 Provider 连通性 */
  testProvider(id: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.LLM_TEST_CONNECTION, { id })
  },
  /** 读取本地设置 */
  getSettings(): Promise<ApiResult<unknown>> {
    return ipcRenderer.invoke(IPC.SETTINGS_GET)
  },
  /** 更新本地设置 */
  updateSettings(patch: { currentLlmProviderId?: string; dataDir?: string; workspaceDir?: string }): Promise<ApiResult<unknown>> {
    return ipcRenderer.invoke(IPC.SETTINGS_UPDATE, { patch })
  },
  /** 工作区状态（目录 + 资料统计） */
  getWorkspaceStatus(): Promise<ApiResult<unknown>> {
    return ipcRenderer.invoke(IPC.WORKSPACE_STATUS)
  },
  /** 手动触发工作区全量对账（扫描 + 解析 + 索引） */
  reconcileWorkspace(): Promise<ApiResult<unknown>> {
    return ipcRenderer.invoke(IPC.WORKSPACE_RECONCILE)
  },
  /** 进入"资料库"功能区时自动触发一次同步（Task 2.2.5，效果等同手动"同步工作区"） */
  workspaceNavSync(): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.WORKSPACE_NAV_SYNC)
  },
  /** 一次性迁移存量导入资料到工作区 */
  migrateLegacyWorkspace(): Promise<ApiResult<unknown>> {
    return ipcRenderer.invoke(IPC.WORKSPACE_MIGRATE)
  },
  /** 订阅工作区同步进度（返回取消订阅函数）；newFiles>0 表示本轮发现并处理新文件；finished 为对账完成事件（含计数，供列表自动刷新） */
  onWorkspaceProgress(cb: (p: { done: number; total: number; newFiles?: number; added?: number; changed?: number; removed?: number; moved?: number; errors?: number; finished?: boolean }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, p: { done: number; total: number; newFiles?: number; added?: number; changed?: number; removed?: number; moved?: number; errors?: number; finished?: boolean }): void => cb(p)
    ipcRenderer.on(IPC_EVENTS.WORKSPACE_PROGRESS, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.WORKSPACE_PROGRESS, listener)
  },
  /** 新建撰写任务（Phase 3.5：点击立即创建，标题默认"新建任务"、范围=全部文件；可传大模型） */
  createTask(input?: { title?: string; scope?: { all: true } | { sourceIds: string[] } | { tagIds: string[] }; llmProviderId?: string }): Promise<ApiResult<{ task: unknown }>> {
    return ipcRenderer.invoke(IPC.WRITING_CREATE_TASK, input ?? {})
  },
  /** 撰写任务列表 */
  listTasks(): Promise<ApiResult<{ items: unknown[] }>> {
    return ipcRenderer.invoke(IPC.WRITING_LIST_TASKS)
  },
  /** 删除撰写任务 */
  deleteTask(id: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.WRITING_DELETE_TASK, { id })
  },
  /** 右键重命名任务标题（Phase 3.5：仅中栏列表显示标题） */
  renameTask(taskId: string, title: string): Promise<ApiResult<{ task: unknown }>> {
    return ipcRenderer.invoke(IPC.WRITING_RENAME_TASK, { taskId, title })
  },
  /** 更新任务选定的部类细则规范 skill（2026-08-13；skillIds 传 null 表示未手动选定、自动匹配） */
  updateTaskSkills(taskId: string, skillIds: string[] | null): Promise<ApiResult<{ task: unknown }>> {
    return ipcRenderer.invoke(IPC.WRITING_UPDATE_SKILLS, { taskId, skillIds })
  },
  /** 智能匹配写作规范（2026-08-14；单独请求大模型，返回匹配的部类细则 skill id 列表） */
  suggestSkills(taskId: string, need: string): Promise<ApiResult<{ skillIds: string[] }>> {
    return ipcRenderer.invoke(IPC.WRITING_SUGGEST_SKILLS, { taskId, need })
  },
  /** 更新任务固定使用的大模型（Phase 3.5；llmProviderId 传 null 表示回退全局当前 Provider） */
  updateTaskProvider(taskId: string, llmProviderId: string | null): Promise<ApiResult<{ task: unknown }>> {
    return ipcRenderer.invoke(IPC.WRITING_UPDATE_PROVIDER, { taskId, llmProviderId })
  },
  /** 与大模型自由对话（Phase 3.5；history 为最近对话上下文） */
  chatWithTask(taskId: string, message: string, history?: { role: 'user' | 'assistant'; content: string }[]): Promise<ApiResult<{ reply: string }>> {
    return ipcRenderer.invoke(IPC.WRITING_CHAT, { taskId, message, history })
  },
  /** 读取任务对话消息（历史与痕迹，按时间升序） */
  listTaskMessages(taskId: string): Promise<ApiResult<{ items: { id: string; taskId: string; role: 'user' | 'assistant'; kind: 'chat' | 'instruction' | 'notice'; content: string; createdAt: string }[] }>> {
    return ipcRenderer.invoke(IPC.TASK_MESSAGES_LIST, { taskId })
  },
  /** 追加一条任务对话消息（生成/对话的记录由主进程自动写入，一般无需手动调用） */
  addTaskMessage(taskId: string, role: 'user' | 'assistant', content: string, kind: 'chat' | 'instruction' | 'notice'): Promise<ApiResult<{ message: unknown }>> {
    return ipcRenderer.invoke(IPC.TASK_MESSAGES_ADD, { taskId, role, kind, content })
  },
  /** 订阅生成初稿阶段进度（返回取消订阅函数）；stage 为中文阶段提示，percent 为进度百分比，etaSeconds 为预计剩余秒数（2026-08-11 新增，供进度条显示） */
  onDraftGenerateProgress(cb: (p: { taskId: string; stage: string; percent: number; etaSeconds?: number }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, p: { taskId: string; stage: string; percent: number; etaSeconds?: number }): void => cb(p)
    ipcRenderer.on(IPC_EVENTS.DRAFT_GENERATE_PROGRESS, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.DRAFT_GENERATE_PROGRESS, listener)
  },
  /** 订阅生成/对话的流式增量文本（2026-08-19：正文/回复逐字推送，供聊天面板实时显示） */
  onWritingStreamDelta(cb: (p: { taskId: string; text: string }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, p: { taskId: string; text: string }): void => cb(p)
    ipcRenderer.on(IPC_EVENTS.WRITING_STREAM_DELTA, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.WRITING_STREAM_DELTA, listener)
  },
  /** 任务范围内的资料检索（RAG 预览） */
  retrieveChunks(taskId: string): Promise<ApiResult<{ chunks: unknown[] }>> {
    return ipcRenderer.invoke(IPC.WRITING_RETRIEVE, { taskId })
  },
  /** 文段来源询问（Phase 3.7 Task 3.7.5：本地匹配优先 + LLM 兜底，返回回复与来源编号清单） */
  askSource(taskId: string, selection: string): Promise<ApiResult<{ reply: string; refs: { index: number; sourceId: string; title: string; position?: string }[] }>> {
    return ipcRenderer.invoke(IPC.WRITING_ASK_SOURCE, { taskId, selection })
  },
  /** 生成初稿（第 0 稿；instruction 为用户要求，应包含标题与可能的其他要求） */
  generateDraft(taskId: string, instruction: string): Promise<ApiResult<{ draft: unknown; articleTitle: string | null; contradictions: unknown[] }>> {
    return ipcRenderer.invoke(IPC.WRITING_GENERATE_DRAFT, { taskId, instruction })
  },
  /** 重新生成初稿（Task 3.4.5：覆盖现有第 0 稿；instruction 为用户要求） */
  regenerateDraft(taskId: string, instruction: string): Promise<ApiResult<{ draft: unknown; articleTitle: string | null; contradictions: unknown[] }>> {
    return ipcRenderer.invoke(IPC.DRAFT_REGENERATE, { taskId, instruction })
  },
  /** 读取志稿（含片段与来源） */
  getDraft(draftId: string): Promise<ApiResult<unknown>> {
    return ipcRenderer.invoke(IPC.DRAFT_GET, { draftId })
  },
  /** 整稿保存（Task 3.4.1：初稿连续显示，编辑后整稿保存并重建片段） */
  updateDraftContent(draftId: string, markdown: string): Promise<ApiResult<{ draft: unknown }>> {
    return ipcRenderer.invoke(IPC.DRAFT_UPDATE_CONTENT, { draftId, markdown })
  },
  /** 读取某稿的矛盾清单（Phase 3.7：矛盾弹窗 / 编辑器标注初始化） */
  getDraftContradictions(draftId: string): Promise<ApiResult<{ contradictions: unknown[] }>> {
    return ipcRenderer.invoke(IPC.DRAFT_GET_CONTRADICTIONS, { draftId })
  },
  /** 矛盾取舍（Phase 3.7：采纳某说法 / 忽略该矛盾；2026-08-11 新增 revert=撤销采纳回退为待处理） */
  resolveContradiction(contradictionId: string, action: 'adopt' | 'ignore' | 'revert', variantId?: string): Promise<ApiResult<{ contradiction: unknown }>> {
    return ipcRenderer.invoke(IPC.DRAFT_RESOLVE_CONTRADICTION, { contradictionId, action, variantId })
  },
  /** 矛盾采纳 → 正文同步修订（2026-08-11：采纳说法并更新正文、移除标注；返回更新后的稿与矛盾） */
  applyContradiction(draftId: string, contradictionId: string, variantId: string): Promise<ApiResult<{ draft: unknown; contradiction: unknown }>> {
    return ipcRenderer.invoke(IPC.DRAFT_APPLY_CONTRADICTION, { draftId, contradictionId, variantId })
  },
  /** 用系统默认软件打开资料源文件（Phase 3.7；URL 资料走浏览器） */
  openSourcePath(sourceId: string): Promise<ApiResult<{ opened: boolean }>> {
    return ipcRenderer.invoke(IPC.SOURCES_OPEN_PATH, { sourceId })
  },
  /** 更新片段内容（Markdown；自动记录审核留痕） */
  updateSegment(segmentId: string, content: string): Promise<ApiResult<{ segment: unknown }>> {
    return ipcRenderer.invoke(IPC.SEGMENT_UPDATE, { segmentId, content })
  },
  /** 读取任务最新一稿（2026-08-11 删去版本管理后仅保留初稿；替代原版本列表定位最新稿） */
  getLatestDraftByTask(taskId: string): Promise<ApiResult<{ draft: unknown }>> {
    return ipcRenderer.invoke(IPC.DRAFT_GET_LATEST, { taskId })
  },
  /** 请求主进程恢复窗口激活（窗口"可见但未激活"时输入无法聚焦） */
  focusWindow(): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.WINDOW_FOCUS)
  },
  /** 渲染进程上报一条诊断日志（按钮点击、页面切换等 UI 交互，2026-08-14） */
  appendLog(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', tag: string, message: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.LOG_APPEND, { level, tag, message })
  },
  /** 导出诊断日志文件（弹出保存对话框，返回保存路径；2026-08-14） */
  exportLog(): Promise<ApiResult<{ path: string; fileName: string }>> {
    return ipcRenderer.invoke(IPC.LOG_EXPORT)
  }
}

contextBridge.exposeInMainWorld('api', api)
export type AppApi = typeof api
