import { join } from 'node:path'
import { createServer } from 'node:http'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  IPC,
  type AppInfoRes,
  type LlmSaveProviderReq,
  type WritingCreateTaskReq,
  type WritingRetrieveReq,
  type WritingGenerateDraftReq,
  type DraftGetReq,
  type SegmentUpdateReq,
  type SegmentUpdateRes,
  type VersionListReq,
  type VersionListRes
} from '../shared/ipc'
import type { ApiResult, Source, Tag, LlmProviderConfig, AppSettings, WritingTask, Draft, RetrievedChunk } from '../shared/types'
import { getDb } from './db/connection'
import { listSources, getSourceById, deleteSource, deleteSources } from './db/sources'
import { listTags, createTag, updateTag, deleteTag, addTagToSource, removeTagFromSource, getTagsBySource, batchAddTags, searchTags, getSourceIdsByTag } from './db/tags'
import { importFiles, importUrl } from './import'
import { parseTemplate as parseTemplateFile } from './import/template-parser'
import { basename } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { insertTemplate, listTemplates, getTemplateById, deleteTemplate } from './db/templates'
import { safeStorageCodec } from './llm/secret'
import { listProviders, saveProvider, deleteProvider } from './llm/provider-store'
import { testProviderConnection } from './llm/test'
import { getSettings, updateSettings } from './db/settings'
import { createTask as createWritingTask, listTasks as listWritingTasks, getTaskById, deleteTask as deleteWritingTask } from './db/tasks'
import { getDraftById, listVersions, updateSegmentContent } from './db/drafts'
import { generateDraft, retrieveForTask } from './writing/generate'
import { configureEmbedModel } from './rag/embed'
import { indexSource } from './rag/indexer'
import { summarizeAllPending, getSourceSummary } from './rag/summarizer'

const APP_PROTOCOL_WHITELIST = /^https?:\/\//i

// 内嵌 HTTP 文件服务：仅监听 127.0.0.1 随机端口，只提供 imports 目录下的文件
let fileServerUrl: string | null = null
let fileServer: ReturnType<typeof createServer> | null = null

function startFileServer(): void {
  if (fileServer) return
  const importsDir = join(app.getPath('userData'), 'imports')

  fileServer = createServer((req, res) => {
    // CORS：渲染进程（dev 的 http://localhost:5173 或生产 file://）跨源访问本地文件服务
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Range')

    // pdf.js 使用 Range 请求头，会触发 CORS 预检
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/^\//, '')
      const filePath = join(importsDir, pathname)

      // 路径穿越防护：确保仍在 imports 目录内
      if (!filePath.startsWith(importsDir)) {
        res.statusCode = 403
        res.end()
        return
      }
      if (!existsSync(filePath)) {
        res.statusCode = 404
        res.end()
        return
      }

      const data = readFileSync(filePath)
      const ext = pathname.split('.').pop()?.toLowerCase()
      const mimeMap: Record<string, string> = {
        pdf: 'application/pdf',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        bmp: 'image/bmp',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        txt: 'text/plain; charset=utf-8',
        md: 'text/markdown; charset=utf-8'
      }
      res.setHeader('content-type', mimeMap[ext ?? ''] ?? 'application/octet-stream')
      res.setHeader('cache-control', 'no-store')
      res.end(data)
    } catch {
      res.statusCode = 500
      res.end()
    }
  })

  fileServer.listen(0, '127.0.0.1', () => {
    const addr = fileServer?.address()
    if (addr && typeof addr === 'object') {
      fileServerUrl = `http://127.0.0.1:${addr.port}`
    }
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: '志书撰写工具',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
    // 确保窗口获得 OS 输入焦点，避免"可见但未激活"导致点击输入框无光标/无法输入
    win.focus()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (APP_PROTOCOL_WHITELIST.test(url)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // 渲染进程 console 消息转发到主进程终端（便于调试）
  win.webContents.on('console-message', (event) => {
    console.log(`[renderer] ${event.message}`)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ===== IPC handlers =====

ipcMain.handle(IPC.APP_GET_INFO, (): ApiResult<AppInfoRes> => {
  return { ok: true, data: { version: app.getVersion(), platform: process.platform } }
})

// 窗口恢复激活：渲染层检测到"窗口可见但未激活"（用户点击本窗口但无法聚焦输入）时请求恢复。
// 仅用 win.focus() 在 Windows foreground lock 下可能无效，组合 show()+moveTop() 突破。
ipcMain.handle(IPC.WINDOW_FOCUS, (event): ApiResult<void> => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed() && win.isVisible() && !win.isFocused()) {
    win.show()
    win.focus()
    win.moveTop()
  }
  return { ok: true, data: undefined }
})

// Task 2.1 文件导入
ipcMain.handle(IPC.SOURCES_IMPORT_FILES, async (_event, params: { paths: string[] }): Promise<ApiResult<{ results: { path: string; source?: Source; error?: string }[] }>> => {
  try {
    const results = await importFiles(params.paths)
    // 导入成功后异步触发向量索引（不阻塞导入返回；模型缺失时内部标记 failed）
    for (const r of results) {
      if (r.source) void indexSource(r.source.id).catch(() => {})
    }
    return {
      ok: true,
      data: {
        results: results.map((r) => ({
          path: r.path,
          source: r.source,
          error: r.error
        }))
      }
    }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Task 2.2 信源网址抓取
ipcMain.handle(IPC.SOURCES_ADD_URL, async (_event, params: { url: string }): Promise<ApiResult<{ source: Source }>> => {
  try {
    const result = await importUrl(params.url)
    if (result.source) {
      // 抓取成功后异步触发向量索引
      void indexSource(result.source.id).catch(() => {})
      return { ok: true, data: { source: result.source } }
    }
    return { ok: false, error: { code: result.errorCode ?? 'FETCH_FAILED', message: result.error ?? '未知错误' } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Task 2.3 标签 CRUD
ipcMain.handle(IPC.TAGS_CREATE, (_event, params: { name: string }): ApiResult<{ tag: Tag }> => {
  try {
    const tag = createTag(params.name)
    return { ok: true, data: { tag } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.TAGS_UPDATE, (_event, params: { id: string; name?: string }): ApiResult<Tag> => {
  try {
    const tag = updateTag(params.id, params.name)
    if (!tag) return { ok: false, error: { code: 'INVALID_PARAM', message: '标签不存在' } }
    return { ok: true, data: tag }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.TAGS_DELETE, (_event, params: { id: string }): ApiResult<void> => {
  try {
    deleteTag(params.id)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.TAGS_ADD_TO_SOURCE, (_event, params: { sourceId: string; tagId: string }): ApiResult<void> => {
  try {
    addTagToSource(params.sourceId, params.tagId)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.TAGS_REMOVE_FROM_SOURCE, (_event, params: { sourceId: string; tagId: string }): ApiResult<void> => {
  try {
    removeTagFromSource(params.sourceId, params.tagId)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Task 2.4 范本管理
ipcMain.handle(IPC.TEMPLATES_LIST, (): ApiResult<{ items: unknown[] }> => {
  try {
    const items = listTemplates()
    return { ok: true, data: { items } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.TEMPLATES_IMPORT, async (_event, params: { path: string }): Promise<ApiResult<{ template: unknown }>> => {
  try {
    const outline = await parseTemplateFile(params.path)
    const outlineJson = JSON.stringify(outline)

    const importDir = join(app.getPath('userData'), 'imports')
    if (!existsSync(importDir)) mkdirSync(importDir, { recursive: true })
    const destName = `template-${Date.now()}-${basename(params.path)}`
    copyFileSync(params.path, join(importDir, destName))

    const template = insertTemplate(basename(params.path), destName, outlineJson)
    return { ok: true, data: { template } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.TEMPLATES_GET, (_event, params: { id: string }): ApiResult<unknown> => {
  try {
    const t = getTemplateById(params.id)
    if (!t) return { ok: false, error: { code: 'INVALID_PARAM', message: '范本不存在' } }
    return { ok: true, data: t }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.TEMPLATES_DELETE, (_event, params: { id: string }): ApiResult<void> => {
  try {
    deleteTemplate(params.id)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 文件选择对话框（安全：在 main 进程打开，仅返回路径给 renderer）
ipcMain.handle('app:openFileDialog', async (): Promise<ApiResult<{ paths: string[] }>> => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'No focused window' } }
  }
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '支持的文档', extensions: ['pdf', 'docx', 'txt', 'md', 'png', 'jpg', 'jpeg', 'bmp'] }
    ]
  })
  return { ok: true, data: { paths: result.filePaths } }
})

// Task 1.3 端到端验证：sources:list 与 tags:list
ipcMain.handle(IPC.SOURCES_LIST, (_event, params?: { tagIds?: string[]; search?: string }): ApiResult<{ items: Source[] }> => {
  try {
    const items = listSources(params)
    return { ok: true, data: { items } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Phase 2.1: 获取资料详情（含标签）
ipcMain.handle(IPC.SOURCES_GET, (_event, params: { id: string }): ApiResult<{ source: Source; tags: Tag[] }> => {
  try {
    const source = getSourceById(params.id)
    if (!source) return { ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '资料不存在' } }
    const tags = getTagsBySource(params.id)
    return { ok: true, data: { source, tags } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Phase 2.x: 将 .docx 资料实时转换为 HTML 供前端渲染
ipcMain.handle(IPC.SOURCES_RENDER_HTML, async (_event, params: { id: string }): Promise<ApiResult<{ html: string }>> => {
  try {
    const source = getSourceById(params.id)
    if (!source) return { ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '资料不存在' } }
    if (source.kind !== 'file' || !source.filePath) {
      return { ok: false, error: { code: 'INVALID_PARAM', message: '仅支持文件类型资料' } }
    }
    const ext = source.filePath.toLowerCase()
    if (!ext.endsWith('.docx')) {
      return { ok: false, error: { code: 'PARSE_UNSUPPORTED', message: '仅支持 .docx 格式渲染' } }
    }

    const importDir = join(app.getPath('userData'), 'imports')
    const filePath = join(importDir, source.filePath)
    if (!existsSync(filePath)) {
      return { ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '原始文件不存在，可能已被移动或删除' } }
    }

    const buffer = readFileSync(filePath)
    const mammoth = await import('mammoth')
    const result = await mammoth.convertToHtml({ buffer })
    return { ok: true, data: { html: result.value } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 获取资料文件的本地访问 URL（通过内嵌 HTTP 文件服务提供，PDF 查看器不支持 data: URL）
ipcMain.handle(IPC.SOURCES_GET_FILE_URL, (_event, params: { id: string }): ApiResult<{ url: string }> => {
  try {
    const source = getSourceById(params.id)
    if (!source) return { ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '资料不存在' } }
    if (source.kind !== 'file' || !source.filePath) {
      return { ok: false, error: { code: 'INVALID_PARAM', message: '仅支持文件类型资料' } }
    }
    if (!fileServerUrl) return { ok: false, error: { code: 'INTERNAL_ERROR', message: '文件服务未就绪' } }
    const url = `${fileServerUrl}/${encodeURIComponent(source.filePath)}`
    return { ok: true, data: { url } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 删除单个资料（级联清理标签关联与 FTS 索引）
ipcMain.handle(IPC.SOURCES_DELETE, (_event, params: { id: string }): ApiResult<void> => {
  try {
    deleteSource(params.id)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 批量删除资料（事务包裹）
ipcMain.handle(IPC.SOURCES_DELETE_MANY, (_event, params: { ids: string[] }): ApiResult<void> => {
  try {
    if (!Array.isArray(params.ids) || params.ids.length === 0) {
      return { ok: false, error: { code: 'INVALID_PARAM', message: '未指定要删除的资料' } }
    }
    deleteSources(params.ids)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 整理资料库：对尚无摘要的资料逐篇调用 LLM 生成摘要（Task 3.2.3）
ipcMain.handle(IPC.SOURCES_SUMMARIZE_ALL, async (): Promise<ApiResult<{ processed: number; ok: number; failed: number }>> => {
  try {
    const res = await summarizeAllPending()
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 读取单篇资料摘要
ipcMain.handle(IPC.SOURCES_GET_SUMMARY, (_event, params: { id: string }): ApiResult<{ summary?: unknown }> => {
  try {
    const summary = getSourceSummary(params.id)
    return { ok: true, data: { summary: summary ?? undefined } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.TAGS_LIST, (): ApiResult<{ items: Tag[] }> => {
  try {
    const items = listTags()
    return { ok: true, data: { items } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Phase 2.1.2: 相似标签搜索（新建标签时的 Top5 建议）
ipcMain.handle(IPC.TAGS_SEARCH, (_event, params: { query: string; limit?: number }): ApiResult<{ items: Tag[] }> => {
  try {
    const items = searchTags(params.query ?? '', params.limit ?? 5)
    return { ok: true, data: { items } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Phase 2.1.2: 批量打标（多标签 → 多资料）
ipcMain.handle(IPC.TAGS_BATCH_ADD, (_event, params: { tagIds: string[]; sourceIds: string[] }): ApiResult<void> => {
  try {
    if (!Array.isArray(params.tagIds) || !Array.isArray(params.sourceIds) || params.sourceIds.length === 0 || params.tagIds.length === 0) {
      return { ok: false, error: { code: 'INVALID_PARAM', message: '缺少标签或资料' } }
    }
    batchAddTags(params.sourceIds, params.tagIds)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Phase 2.1.2: 获取带有指定标签的所有资料 ID
ipcMain.handle(IPC.TAGS_SOURCES_BY_TAG, (_event, params: { tagId: string }): ApiResult<{ sourceIds: string[] }> => {
  try {
    const sourceIds = getSourceIdsByTag(params.tagId)
    return { ok: true, data: { sourceIds } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// ===== Phase 3 Task 3.1: LLM Provider 配置 =====

ipcMain.handle(IPC.LLM_LIST_PROVIDERS, (): ApiResult<{ items: LlmProviderConfig[] }> => {
  try {
    return { ok: true, data: { items: listProviders() } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.LLM_SAVE_PROVIDER, (_event, params: LlmSaveProviderReq): ApiResult<{ provider: LlmProviderConfig }> => {
  try {
    const provider = saveProvider(params, safeStorageCodec)
    return { ok: true, data: { provider } }
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_PARAM', message: String(err) } }
  }
})

ipcMain.handle(IPC.LLM_DELETE_PROVIDER, (_event, params: { id: string }): ApiResult<void> => {
  try {
    deleteProvider(params.id)
    // 若删除的是当前 Provider，同步清除设置
    if (getSettings().currentLlmProviderId === params.id) {
      updateSettings({ currentLlmProviderId: undefined })
    }
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.LLM_TEST_CONNECTION, async (_event, params: { id: string }): Promise<ApiResult<void>> => {
  const result = await testProviderConnection(params.id, safeStorageCodec)
  if (result.ok) return { ok: true, data: undefined }
  return { ok: false, error: result.error! }
})

// ===== Phase 3 Task 3.1: 本地设置 =====

ipcMain.handle(IPC.SETTINGS_GET, (): ApiResult<AppSettings> => {
  try {
    return { ok: true, data: getSettings() }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.SETTINGS_UPDATE, (_event, params: { patch: Partial<AppSettings> }): ApiResult<AppSettings> => {
  try {
    return { ok: true, data: updateSettings(params.patch) }
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_PARAM', message: String(err) } }
  }
})

// ===== Phase 3 Task 3.2/3.3: 撰写任务与初稿 =====

ipcMain.handle(IPC.WRITING_CREATE_TASK, (_event, params: WritingCreateTaskReq): ApiResult<{ task: WritingTask }> => {
  try {
    const task = createWritingTask(params)
    return { ok: true, data: { task } }
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_PARAM', message: String(err) } }
  }
})

ipcMain.handle(IPC.WRITING_LIST_TASKS, (): ApiResult<{ items: WritingTask[] }> => {
  try {
    return { ok: true, data: { items: listWritingTasks() } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.WRITING_DELETE_TASK, (_event, params: { id: string }): ApiResult<void> => {
  try {
    deleteWritingTask(params.id)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.WRITING_RETRIEVE, async (_event, params: WritingRetrieveReq): Promise<ApiResult<{ chunks: RetrievedChunk[] }>> => {
  try {
    if (!getTaskById(params.taskId)) {
      return { ok: false, error: { code: 'TASK_NOT_FOUND', message: '撰写任务不存在' } }
    }
    return { ok: true, data: { chunks: (await retrieveForTask(params.taskId)) ?? [] } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.WRITING_GENERATE_DRAFT, async (_event, params: WritingGenerateDraftReq): Promise<ApiResult<{ draft: Draft }>> => {
  const result = await generateDraft(params.taskId)
  if (result.ok) return { ok: true, data: { draft: result.draft } }
  return { ok: false, error: result.error }
})

ipcMain.handle(IPC.DRAFT_GET, (_event, params: DraftGetReq): ApiResult<Draft> => {
  try {
    const draft = getDraftById(params.draftId)
    if (!draft) return { ok: false, error: { code: 'DRAFT_NOT_FOUND', message: '志稿不存在' } }
    return { ok: true, data: draft }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.SEGMENT_UPDATE, (_event, params: SegmentUpdateReq): ApiResult<SegmentUpdateRes> => {
  try {
    const content = params.content?.trim()
    if (!content) return { ok: false, error: { code: 'INVALID_PARAM', message: '片段内容不能为空' } }
    const segment = updateSegmentContent(params.segmentId, content)
    if (!segment) return { ok: false, error: { code: 'INVALID_PARAM', message: '片段不存在' } }
    return { ok: true, data: { segment } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.VERSION_LIST, (_event, params: VersionListReq): ApiResult<VersionListRes> => {
  try {
    return { ok: true, data: { versions: listVersions(params.taskId) } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// ===== 启动 =====

app.whenReady().then(() => {
  // 初始化数据库（触发迁移）
  getDb()

  // 配置本地向量嵌入模型目录（<appPath>/resources/models/<modelId>/）
  configureEmbedModel({ modelPath: join(app.getAppPath(), 'resources', 'models') })

  // 启动内嵌文件服务（提供 PDF/图片等本地文件）
  startFileServer()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  fileServer?.close()
  fileServer = null
})
