import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { ApiResult } from '../shared/types'

interface ImportResults {
  results: { path: string; source?: unknown; error?: string }[]
}

const api = {
  getAppInfo(): Promise<ApiResult<{ version: string; platform: string }>> {
    return ipcRenderer.invoke(IPC.APP_GET_INFO)
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
    return ipcRenderer.invoke('app:openFileDialog')
  },
  /** 打开系统目录选择对话框（工作区选择） */
  openDirectoryDialog(): Promise<ApiResult<{ path: string | null }>> {
    return ipcRenderer.invoke('app:openDirectoryDialog')
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
  /** 范本列表 */
  listTemplates(): Promise<ApiResult<{ items: unknown[] }>> {
    return ipcRenderer.invoke(IPC.TEMPLATES_LIST)
  },
  /** 导入范本 */
  importTemplate(path: string): Promise<ApiResult<{ template: unknown }>> {
    return ipcRenderer.invoke(IPC.TEMPLATES_IMPORT, { path })
  },
  /** 删除范本 */
  deleteTemplate(id: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.TEMPLATES_DELETE, { id })
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
  /** 一次性迁移存量导入资料到工作区 */
  migrateLegacyWorkspace(): Promise<ApiResult<unknown>> {
    return ipcRenderer.invoke(IPC.WORKSPACE_MIGRATE)
  },
  /** 新建撰写任务 */
  createTask(input: { title: string; scope: { sourceIds: string[] } | { tagIds: string[] }; templateBookId?: string }): Promise<ApiResult<{ task: unknown }>> {
    return ipcRenderer.invoke(IPC.WRITING_CREATE_TASK, input)
  },
  /** 撰写任务列表 */
  listTasks(): Promise<ApiResult<{ items: unknown[] }>> {
    return ipcRenderer.invoke(IPC.WRITING_LIST_TASKS)
  },
  /** 删除撰写任务 */
  deleteTask(id: string): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.WRITING_DELETE_TASK, { id })
  },
  /** 任务范围内的资料检索（RAG 预览） */
  retrieveChunks(taskId: string): Promise<ApiResult<{ chunks: unknown[] }>> {
    return ipcRenderer.invoke(IPC.WRITING_RETRIEVE, { taskId })
  },
  /** 生成初稿（第 0 稿） */
  generateDraft(taskId: string): Promise<ApiResult<{ draft: unknown }>> {
    return ipcRenderer.invoke(IPC.WRITING_GENERATE_DRAFT, { taskId })
  },
  /** 读取志稿（含片段与来源） */
  getDraft(draftId: string): Promise<ApiResult<unknown>> {
    return ipcRenderer.invoke(IPC.DRAFT_GET, { draftId })
  },
  /** 更新片段内容（Markdown；自动记录审核留痕） */
  updateSegment(segmentId: string, content: string): Promise<ApiResult<{ segment: unknown }>> {
    return ipcRenderer.invoke(IPC.SEGMENT_UPDATE, { segmentId, content })
  },
  /** 任务版本列表 */
  listVersions(taskId: string): Promise<ApiResult<{ versions: unknown[] }>> {
    return ipcRenderer.invoke(IPC.VERSION_LIST, { taskId })
  },
  /** 请求主进程恢复窗口激活（窗口"可见但未激活"时输入无法聚焦） */
  focusWindow(): Promise<ApiResult<void>> {
    return ipcRenderer.invoke(IPC.WINDOW_FOCUS)
  }
}

contextBridge.exposeInMainWorld('api', api)
export type AppApi = typeof api
