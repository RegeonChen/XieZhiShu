import { join } from 'node:path'
import { createServer } from 'node:http'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  IPC,
  IPC_EVENTS,
  type AppInfoRes,
  type LlmSaveProviderReq,
  type WritingCreateTaskReq,
  type WritingRenameTaskReq,
  type WritingRenameTaskRes,
  type WritingUpdateSkillsReq,
  type WritingUpdateSkillsRes,
  type WritingSuggestSkillsReq,
  type WritingSuggestSkillsRes,
  type WritingUpdateProviderReq,
  type WritingUpdateProviderRes,
  type WritingChatReq,
  type WritingChatRes,
  type TaskMessagesListReq,
  type TaskMessagesListRes,
  type TaskMessagesAddReq,
  type TaskMessagesAddRes,
  type WritingRetrieveReq,
  type WritingGenerateDraftReq,
  type WritingGenerateDraftRes,
  type DraftGetReq,
  type DraftUpdateContentReq,
  type DraftUpdateContentRes,
  type DraftRegenerateReq,
  type DraftRegenerateRes,
  type SegmentUpdateReq,
  type SegmentUpdateRes
} from '../shared/ipc'
import type { ApiResult, Source, Tag, LlmProviderConfig, AppSettings, WritingTask, Draft, RetrievedChunk } from '../shared/types'
import { getDb } from './db/connection'
import { listSources, getSourceById, deleteSource, deleteSources, updateSourceTitle, updateSourceFingerprint } from './db/sources'
import { listTags, createTag, updateTag, deleteTag, addTagToSource, removeTagFromSource, getTagsBySource, batchAddTags, searchTags, getSourceIdsByTag } from './db/tags'
import { importFiles, importUrl } from './import'
import { addWebSite, listWebSites, removeWebSite } from './db/web-sites'
import { syncSite } from './web-source/site-crawler'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { listSkills, createSkill, updateSkill, deleteSkill, seedPresetSkills } from './db/writing-skills'
import { safeStorageCodec } from './llm/secret'
import { listProviders, saveProvider, deleteProvider } from './llm/provider-store'
import { testProviderConnection } from './llm/test'
import { getSettings, updateSettings } from './db/settings'
import { createTask as createWritingTask, listTasks as listWritingTasks, getTaskById, deleteTask as deleteWritingTask, updateTaskSkillIds, renameTask, updateTaskProvider } from './db/tasks'
import { getDraftById, getLatestDraftByTask, updateSegmentContent, replaceDraftSegments } from './db/drafts'
import { getContradictionsByDraft, updateContradictionStatus } from './db/contradictions'
import { listTaskMessages, addTaskMessage } from './db/task-messages'
import { generateDraft, regenerateDraft, retrieveForTask, chatWithTask, suggestSkillsForTask } from './writing/generate'
import { applyContradictionEdit } from './writing/contradiction-apply'
import { askSourceForTask } from './writing/source-query'
import { configureEmbedModel, stopEmbedWorker } from './rag/embed'
import { enqueueIndex } from './rag/indexer'
import { summarizeAllPending, getSourceSummary } from './rag/summarizer'
import { getWorkspaceDir, reconcileWorkspace, type ReconcileProgress } from './workspace/reconcile'
import { startWorkspaceWatcher, restartWorkspaceWatcher, stopWorkspaceWatcher } from './workspace/watcher'
import { requestWorkspaceSync, startAutoSyncTimer, stopAutoSyncTimer } from './workspace/auto-sync'
import { trashSourceFile, renameSourceFile, resolveSourceFilePath } from './workspace/sync'
import { migrateLegacyToWorkspace } from './workspace/migrate'
import { loadWindowState, trackWindowState } from './window-state'
import type { WorkspaceReconcileRes, WorkspaceStatusRes, WorkspaceMigrateRes, DraftGetContradictionsReq, DraftGetContradictionsRes, DraftResolveContradictionReq, DraftResolveContradictionRes, DraftApplyContradictionReq, DraftApplyContradictionRes, DraftGetLatestReq, DraftGetLatestRes, SourceOpenPathReq, SourceOpenPathRes, WritingAskSourceReq, WritingAskSourceRes, WebSourceAddReq, WebSourceAddRes, WebSourceListRes, WebSourceRemoveReq, WebSourceSyncReq, WebSourceSyncRes, SkillListRes, SkillSaveReq, SkillSaveRes, SkillDeleteReq, LogAppendReq, LogExportRes } from '../shared/ipc'
import { logMain, logIpc, logRenderer, exportLogsText } from './logger'

const APP_PROTOCOL_WHITELIST = /^https?:\/\//i

// 内嵌 HTTP 文件服务：仅监听 127.0.0.1 随机端口，按资料 id 提供本地原文件
let fileServerUrl: string | null = null
let fileServer: ReturnType<typeof createServer> | null = null

function startFileServer(): void {
  if (fileServer) return

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
      // 仅允许按资料 id 取文件（Phase 2.2 起统一服务工作区与旧 imports 文件，白名单化防路径穿越）
      const match = pathname.match(/^source\/([^/]+)$/)
      if (!match) {
        res.statusCode = 404
        res.end()
        return
      }
      const source = getSourceById(match[1])
      const filePath = source ? resolveSourceFilePath(source) : null
      if (!filePath || !existsSync(filePath)) {
        res.statusCode = 404
        res.end()
        return
      }

      const data = readFileSync(filePath)
      const ext = filePath.split('.').pop()?.toLowerCase()
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
  // 恢复上次关闭时的窗口尺寸/位置/最大化/全屏状态
  const saved = loadWindowState()
  const win = new BrowserWindow({
    ...(saved ? { x: saved.bounds.x, y: saved.bounds.y, width: saved.bounds.width, height: saved.bounds.height } : { width: 1280, height: 800 }),
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
    if (saved?.isFullScreen) win.setFullScreen(true)
    win.show()
    // 恢复最大化（先 show 再 maximize，避免恢复时位置/尺寸异常）
    if (saved?.isMaximized && !saved.isFullScreen) win.maximize()
    // 确保窗口获得 OS 输入焦点，避免"可见但未激活"导致点击输入框无光标/无法输入
    win.focus()
  })

  // 窗口重新聚焦到最顶层时自动触发一次工作区同步（Task 2.2.5，效果等同手动"同步工作区"）
  win.on('focus', () => requestWorkspaceSync(pushWorkspaceProgress))

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

  // 跟踪窗口状态（尺寸/位置/最大化/全屏），关闭时保存、下次启动恢复
  trackWindowState(win)
}

// ===== 诊断日志：自动记录所有 IPC 调用（通道 + 脱敏参数），用于复现用户试用中的 bug（2026-08-14） =====
const rawIpcHandle = ipcMain.handle.bind(ipcMain)
function handleLogged(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any
): void {
  rawIpcHandle(channel, async (event: Electron.IpcMainInvokeEvent, ...args: any[]) => {
    logIpc(channel, args)
    try {
      return await listener(event, ...args)
    } catch (err) {
      logMain('ipc', `${channel} 抛出未捕获异常: ${err instanceof Error ? err.message : String(err)}`, 'ERROR')
      throw err
    }
  })
}

// 渲染进程上报 UI 交互日志（绕过 handleLogged，避免日志里出现 log:append 自身的 ipc 记录）
rawIpcHandle(IPC.LOG_APPEND, (_event, params: LogAppendReq): ApiResult<void> => {
  logRenderer(params.tag, params.message, params.level ?? 'INFO')
  return { ok: true, data: undefined }
})

// 一键导出诊断日志文件（弹出保存对话框）
rawIpcHandle(IPC.LOG_EXPORT, async (): Promise<ApiResult<LogExportRes>> => {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const defaultName = `志书撰写工具-诊断日志-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.log`
  try {
    const res = await dialog.showSaveDialog({
      title: '导出诊断日志',
      defaultPath: defaultName,
      filters: [
        { name: '日志文件', extensions: ['log'] },
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return { ok: true, data: { path: '', fileName: defaultName } }
    writeFileSync(res.filePath, exportLogsText(), 'utf-8')
    return { ok: true, data: { path: res.filePath, fileName: defaultName } }
  } catch (err) {
    return { ok: false, error: { code: 'LOG_EXPORT_FAILED', message: err instanceof Error ? err.message : '导出失败' } }
  }
})

// ===== IPC handlers =====

handleLogged(IPC.APP_GET_INFO, (): ApiResult<AppInfoRes> => {
  return { ok: true, data: { version: app.getVersion(), platform: process.platform } }
})

// 打开外部链接（预设模型注册页等；仅允许 http/https，防滥用）
handleLogged(IPC.APP_OPEN_EXTERNAL, (_event, params: { url: string }): ApiResult<void> => {
  const url = (params.url ?? '').trim()
  if (!APP_PROTOCOL_WHITELIST.test(url)) {
    return { ok: false, error: { code: 'INVALID_PARAM', message: '仅支持打开 http/https 链接' } }
  }
  void shell.openExternal(url).catch((err) => console.error('openExternal failed:', err))
  return { ok: true, data: undefined }
})

// 窗口恢复激活：渲染层检测到"窗口可见但未激活"（用户点击本窗口但无法聚焦输入）时请求恢复。
// 仅用 win.focus() 在 Windows foreground lock 下可能无效，组合 show()+moveTop() 突破。
handleLogged(IPC.WINDOW_FOCUS, (event): ApiResult<void> => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed() && win.isVisible() && !win.isFocused()) {
    win.show()
    win.focus()
    win.moveTop()
  }
  return { ok: true, data: undefined }
})

// Task 2.1 文件导入
handleLogged(IPC.SOURCES_IMPORT_FILES, async (_event, params: { paths: string[] }): Promise<ApiResult<{ results: { path: string; source?: Source; error?: string }[] }>> => {
  try {
    const results = await importFiles(params.paths)
    // 导入成功后提交后台串行向量索引（不阻塞导入返回；推理在 Worker 线程执行）
    for (const r of results) {
      if (r.source) enqueueIndex(r.source.id)
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
handleLogged(IPC.SOURCES_ADD_URL, async (_event, params: { url: string }): Promise<ApiResult<{ source: Source }>> => {
  try {
    const result = await importUrl(params.url)
    if (result.source) {
      // 抓取成功后提交后台串行向量索引
      enqueueIndex(result.source.id)
      return { ok: true, data: { source: result.source } }
    }
    return { ok: false, error: { code: result.errorCode ?? 'FETCH_FAILED', message: result.error ?? '未知错误' } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// ---- 网页资料库（2026-08-11）----
handleLogged(IPC.WEB_SOURCE_LIST, (): ApiResult<WebSourceListRes> => {
  try {
    return { ok: true, data: { sites: listWebSites() } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.WEB_SOURCE_ADD, (_event, params: WebSourceAddReq): ApiResult<WebSourceAddRes> => {
  try {
    const site = addWebSite(params.rootUrl, params.title)
    if (!site) return { ok: false, error: { code: 'ALREADY_EXISTS', message: '该网址已注册为网页资料库' } }
    return { ok: true, data: { site } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.WEB_SOURCE_REMOVE, (_event, params: WebSourceRemoveReq): ApiResult<void> => {
  try {
    removeWebSite(params.id)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.WEB_SOURCE_SYNC, async (_event, params: WebSourceSyncReq): Promise<ApiResult<WebSourceSyncRes>> => {
  try {
    const added = await syncSite(params.id)
    return { ok: true, data: { articles: added } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Task 2.3 标签 CRUD
handleLogged(IPC.TAGS_CREATE, (_event, params: { name: string }): ApiResult<{ tag: Tag }> => {
  try {
    const tag = createTag(params.name)
    return { ok: true, data: { tag } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.TAGS_UPDATE, (_event, params: { id: string; name?: string }): ApiResult<Tag> => {
  try {
    const tag = updateTag(params.id, params.name)
    if (!tag) return { ok: false, error: { code: 'INVALID_PARAM', message: '标签不存在' } }
    return { ok: true, data: tag }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.TAGS_DELETE, (_event, params: { id: string }): ApiResult<void> => {
  try {
    deleteTag(params.id)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.TAGS_ADD_TO_SOURCE, (_event, params: { sourceId: string; tagId: string }): ApiResult<void> => {
  try {
    addTagToSource(params.sourceId, params.tagId)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.TAGS_REMOVE_FROM_SOURCE, (_event, params: { sourceId: string; tagId: string }): ApiResult<void> => {
  try {
    removeTagFromSource(params.sourceId, params.tagId)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 写作规范 skills 管理（2026-08-13 由「范本」重构）
handleLogged(IPC.SKILLS_LIST, (): ApiResult<SkillListRes> => {
  try {
    const items = listSkills()
    return { ok: true, data: { items } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.SKILLS_CREATE, (_event, params: SkillSaveReq): ApiResult<SkillSaveRes> => {
  try {
    const skill = createSkill({ name: params.name, category: params.category, tags: params.tags, content: params.content })
    return { ok: true, data: { skill } }
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_PARAM', message: String(err) } }
  }
})

handleLogged(IPC.SKILLS_UPDATE, (_event, params: SkillSaveReq): ApiResult<SkillSaveRes> => {
  try {
    if (!params.id) return { ok: false, error: { code: 'INVALID_PARAM', message: '缺少规范 id' } }
    const skill = updateSkill(params.id, { name: params.name, category: params.category, tags: params.tags, content: params.content })
    if (!skill) return { ok: false, error: { code: 'INVALID_PARAM', message: '规范不存在' } }
    return { ok: true, data: { skill } }
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_PARAM', message: String(err) } }
  }
})

handleLogged(IPC.SKILLS_DELETE, (_event, params: SkillDeleteReq): ApiResult<void> => {
  try {
    deleteSkill(params.id)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 文件选择对话框（安全：在 main 进程打开，仅返回路径给 renderer）
handleLogged('app:openFileDialog', async (): Promise<ApiResult<{ paths: string[] }>> => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'No focused window' } }
  }
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '支持的文档', extensions: ['pdf', 'docx', 'doc', 'wps', 'xls', 'xlsx', 'txt', 'md', 'png', 'jpg', 'jpeg', 'bmp'] }
    ]
  })
  return { ok: true, data: { paths: result.filePaths } }
})

// 目录选择对话框（Phase 2.2：选择工作区文件夹）
handleLogged('app:openDirectoryDialog', async (): Promise<ApiResult<{ path: string | null }>> => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'No focused window' } }
  }
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory']
  })
  return { ok: true, data: { path: result.filePaths[0] ?? null } }
})

// Task 1.3 端到端验证：sources:list 与 tags:list
handleLogged(IPC.SOURCES_LIST, (_event, params?: { tagIds?: string[]; search?: string }): ApiResult<{ items: Source[] }> => {
  try {
    const items = listSources(params)
    return { ok: true, data: { items } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Phase 2.1: 获取资料详情（含标签）
handleLogged(IPC.SOURCES_GET, (_event, params: { id: string }): ApiResult<{ source: Source; tags: Tag[] }> => {
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
handleLogged(IPC.SOURCES_RENDER_HTML, async (_event, params: { id: string }): Promise<ApiResult<{ html: string }>> => {
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

    const filePath = resolveSourceFilePath(source)
    if (!filePath || !existsSync(filePath)) {
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
handleLogged(IPC.SOURCES_GET_FILE_URL, (_event, params: { id: string }): ApiResult<{ url: string }> => {
  try {
    const source = getSourceById(params.id)
    if (!source) return { ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '资料不存在' } }
    if (source.kind !== 'file' || !source.filePath) {
      return { ok: false, error: { code: 'INVALID_PARAM', message: '仅支持文件类型资料' } }
    }
    if (!fileServerUrl) return { ok: false, error: { code: 'INTERNAL_ERROR', message: '文件服务未就绪' } }
    const url = `${fileServerUrl}/source/${encodeURIComponent(source.id)}`
    return { ok: true, data: { url } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 删除单个资料（Phase 2.2：工作区文件先移入回收站，再删库）
handleLogged(IPC.SOURCES_DELETE, async (_event, params: { id: string }): Promise<ApiResult<void>> => {
  try {
    const source = getSourceById(params.id)
    if (!source) return { ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '资料不存在' } }
    if (source.workspace) {
      await trashSourceFile(source) // 移入系统回收站；失败会抛错中止，保持库/文件一致
    }
    deleteSource(params.id)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 批量删除资料（Phase 2.2：逐个先移入回收站，再统一删库）
handleLogged(IPC.SOURCES_DELETE_MANY, async (_event, params: { ids: string[] }): Promise<ApiResult<void>> => {
  try {
    if (!Array.isArray(params.ids) || params.ids.length === 0) {
      return { ok: false, error: { code: 'INVALID_PARAM', message: '未指定要删除的资料' } }
    }
    for (const id of params.ids) {
      const source = getSourceById(id)
      if (source?.workspace) await trashSourceFile(source)
    }
    deleteSources(params.ids)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 修改资料标题（Phase 2.2：工作区文件同步重命名，保留扩展名；重名自动加后缀）
handleLogged(IPC.SOURCES_UPDATE_TITLE, (_event, params: { id: string; title: string }): ApiResult<Source> => {
  try {
    const source = getSourceById(params.id)
    if (!source) return { ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '资料不存在' } }
    const title = (params.title ?? '').trim()
    if (!title) return { ok: false, error: { code: 'INVALID_PARAM', message: '标题不能为空' } }

    if (source.workspace && source.kind === 'file' && source.filePath) {
      const newRel = renameSourceFile(source, title)
      if (newRel) {
        // 重命名文件成功后更新 DB（file_path 同步）
        const updated = updateSourceFingerprint(source.id, { title, filePath: newRel })
        return updated ? { ok: true, data: updated } : { ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '资料不存在' } }
      }
    }
    const updated = updateSourceTitle(source.id, title)
    return updated ? { ok: true, data: updated } : { ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '资料不存在' } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 整理资料库：对尚无摘要的资料逐篇调用 LLM 生成摘要（Task 3.2.3）
handleLogged(IPC.SOURCES_SUMMARIZE_ALL, async (): Promise<ApiResult<{ processed: number; ok: number; failed: number }>> => {
  try {
    const res = await summarizeAllPending()
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 读取单篇资料摘要
handleLogged(IPC.SOURCES_GET_SUMMARY, (_event, params: { id: string }): ApiResult<{ summary?: unknown }> => {
  try {
    const summary = getSourceSummary(params.id)
    return { ok: true, data: { summary: summary ?? undefined } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.TAGS_LIST, (): ApiResult<{ items: Tag[] }> => {
  try {
    const items = listTags()
    return { ok: true, data: { items } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Phase 2.1.2: 相似标签搜索（新建标签时的 Top5 建议）
handleLogged(IPC.TAGS_SEARCH, (_event, params: { query: string; limit?: number }): ApiResult<{ items: Tag[] }> => {
  try {
    const items = searchTags(params.query ?? '', params.limit ?? 5)
    return { ok: true, data: { items } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Phase 2.1.2: 批量打标（多标签 → 多资料）
handleLogged(IPC.TAGS_BATCH_ADD, (_event, params: { tagIds: string[]; sourceIds: string[] }): ApiResult<void> => {
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
handleLogged(IPC.TAGS_SOURCES_BY_TAG, (_event, params: { tagId: string }): ApiResult<{ sourceIds: string[] }> => {
  try {
    const sourceIds = getSourceIdsByTag(params.tagId)
    return { ok: true, data: { sourceIds } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// ===== Phase 3 Task 3.1: LLM Provider 配置 =====

handleLogged(IPC.LLM_LIST_PROVIDERS, (): ApiResult<{ items: LlmProviderConfig[] }> => {
  try {
    return { ok: true, data: { items: listProviders() } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.LLM_SAVE_PROVIDER, (_event, params: LlmSaveProviderReq): ApiResult<{ provider: LlmProviderConfig }> => {
  try {
    const provider = saveProvider(params, safeStorageCodec)
    return { ok: true, data: { provider } }
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_PARAM', message: String(err) } }
  }
})

handleLogged(IPC.LLM_DELETE_PROVIDER, (_event, params: { id: string }): ApiResult<void> => {
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

handleLogged(IPC.LLM_TEST_CONNECTION, async (_event, params: { id: string }): Promise<ApiResult<void>> => {
  const result = await testProviderConnection(params.id, safeStorageCodec)
  if (result.ok) return { ok: true, data: undefined }
  return { ok: false, error: result.error! }
})

// ===== Phase 3 Task 3.1: 本地设置 =====

handleLogged(IPC.SETTINGS_GET, (): ApiResult<AppSettings> => {
  try {
    return { ok: true, data: getSettings() }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.SETTINGS_UPDATE, (_event, params: { patch: Partial<AppSettings> }): ApiResult<AppSettings> => {
  try {
    const settings = updateSettings(params.patch)
    // 工作区路径变化时重启监听（并触发一次对账）
    if ('workspaceDir' in params.patch) {
      restartWorkspaceWatcher()
      if (getWorkspaceDir()) {
        void reconcileWorkspace().catch((err) => {
          console.error('workspace reconcile failed after settings change:', err)
        })
      }
    }
    return { ok: true, data: settings }
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_PARAM', message: String(err) } }
  }
})

// ===== Phase 2.2: 工作区 =====

handleLogged(IPC.WORKSPACE_STATUS, (): ApiResult<WorkspaceStatusRes> => {
  try {
    const workspaceDir = getWorkspaceDir()
    const all = listSources()
    const workspaceSources = all.filter((s) => s.workspace).length
    const legacySources = all.filter((s) => s.kind === 'file' && !s.workspace).length
    return {
      ok: true,
      data: { workspaceDir: workspaceDir ?? undefined, workspaceSources, legacySources, totalSources: all.length }
    }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

/** 工作区对账进度推送到所有渲染窗口（workspace:progress，供资料库页显示进度与"新文件预处理"提示） */
function pushWorkspaceProgress(p: ReconcileProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('workspace:progress', p)
  }
}

// 手动触发工作区全量对账（扫描 + 解析 + 索引），实时推送进度到渲染进程
handleLogged(IPC.WORKSPACE_RECONCILE, async (): Promise<ApiResult<WorkspaceReconcileRes>> => {
  try {
    const result = await reconcileWorkspace(pushWorkspaceProgress)
    return { ok: true, data: result }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 渲染层进入"资料库"功能区时自动触发一次同步（Task 2.2.5，效果等同手动"同步工作区"）
handleLogged(IPC.WORKSPACE_NAV_SYNC, (): ApiResult<void> => {
  requestWorkspaceSync(pushWorkspaceProgress)
  return { ok: true, data: undefined }
})

// 一次性迁移存量导入资料到工作区（Task 2.2.3）
handleLogged(IPC.WORKSPACE_MIGRATE, async (): Promise<ApiResult<WorkspaceMigrateRes>> => {
  try {
    const result = await migrateLegacyToWorkspace()
    return { ok: true, data: result }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// ===== Phase 3 Task 3.2/3.3: 撰写任务与初稿 =====

handleLogged(IPC.WRITING_CREATE_TASK, (_event, params: WritingCreateTaskReq): ApiResult<{ task: WritingTask }> => {
  try {
    // Phase 3.5：点击"新建任务"立即创建（标题默认"新建任务"、范围=全部文件），可选范本/大模型
    const task = createWritingTask(params ?? {})
    return { ok: true, data: { task } }
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_PARAM', message: String(err) } }
  }
})

handleLogged(IPC.WRITING_LIST_TASKS, (): ApiResult<{ items: WritingTask[] }> => {
  try {
    return { ok: true, data: { items: listWritingTasks() } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.WRITING_DELETE_TASK, (_event, params: { id: string }): ApiResult<void> => {
  try {
    deleteWritingTask(params.id)
    return { ok: true, data: undefined }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Phase 3.5：右键重命名任务标题（仅中栏列表显示标题；文章标题由大模型抓取）
handleLogged(IPC.WRITING_RENAME_TASK, (_event, params: WritingRenameTaskReq): ApiResult<WritingRenameTaskRes> => {
  try {
    const task = renameTask(params.taskId, params.title)
    if (!task) return { ok: false, error: { code: 'TASK_NOT_FOUND', message: '撰写任务不存在' } }
    return { ok: true, data: { task } }
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_PARAM', message: String(err) } }
  }
})

// 2026-08-13：更新任务选定的部类细则规范 skill（null = 未手动选定，生成时自动匹配）
handleLogged(IPC.WRITING_UPDATE_SKILLS, (_event, params: WritingUpdateSkillsReq): ApiResult<WritingUpdateSkillsRes> => {
  try {
    const task = updateTaskSkillIds(params.taskId, params.skillIds)
    if (!task) return { ok: false, error: { code: 'TASK_NOT_FOUND', message: '撰写任务不存在' } }
    return { ok: true, data: { task } }
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_PARAM', message: String(err) } }
  }
})

// 2026-08-14：智能匹配写作规范（单独请求大模型，依据用户需求挑选部类细则 skills）
handleLogged(IPC.WRITING_SUGGEST_SKILLS, async (_event, params: WritingSuggestSkillsReq): Promise<ApiResult<WritingSuggestSkillsRes>> => {
  const result = await suggestSkillsForTask(params.taskId, params.need)
  if (result.ok) return { ok: true, data: { skillIds: result.skillIds } }
  return { ok: false, error: result.error }
})

// Phase 3.5：更新任务固定使用的大模型（null = 回退全局当前 Provider）
handleLogged(IPC.WRITING_UPDATE_PROVIDER, (_event, params: WritingUpdateProviderReq): ApiResult<WritingUpdateProviderRes> => {
  try {
    const task = updateTaskProvider(params.taskId, params.llmProviderId)
    if (!task) return { ok: false, error: { code: 'TASK_NOT_FOUND', message: '撰写任务不存在' } }
    return { ok: true, data: { task } }
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_PARAM', message: String(err) } }
  }
})

// Phase 3.5：与大模型自由对话（用任务大模型，注入当前初稿作为上下文）
handleLogged(IPC.WRITING_CHAT, async (_event, params: WritingChatReq): Promise<ApiResult<WritingChatRes>> => {
  const result = await chatWithTask(params.taskId, params.message, params.history)
  if (result.ok) return { ok: true, data: { reply: result.reply } }
  return { ok: false, error: result.error }
})

// Phase 3.7 Task 3.7.5：文段来源询问（本地精确匹配 → 过滤式检索 → LLM 兜底；消息由主进程写入 task_messages）
handleLogged(IPC.WRITING_ASK_SOURCE, async (_event, params: WritingAskSourceReq): Promise<ApiResult<WritingAskSourceRes>> => {
  const result = await askSourceForTask(params.taskId, params.selection)
  if (result.ok) return { ok: true, data: { reply: result.reply, refs: result.refs } }
  return { ok: false, error: result.error }
})

// Phase 3.5 后续：任务对话消息（历史与痕迹）读取/追加
handleLogged(IPC.TASK_MESSAGES_LIST, (_event, params: TaskMessagesListReq): ApiResult<TaskMessagesListRes> => {
  try {
    if (!getTaskById(params.taskId)) {
      return { ok: false, error: { code: 'TASK_NOT_FOUND', message: '撰写任务不存在' } }
    }
    return { ok: true, data: { items: listTaskMessages(params.taskId) } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.TASK_MESSAGES_ADD, (_event, params: TaskMessagesAddReq): ApiResult<TaskMessagesAddRes> => {
  try {
    if (!getTaskById(params.taskId)) {
      return { ok: false, error: { code: 'TASK_NOT_FOUND', message: '撰写任务不存在' } }
    }
    return { ok: true, data: { message: addTaskMessage(params.taskId, params.role, params.content, params.kind) } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.WRITING_RETRIEVE, async (_event, params: WritingRetrieveReq): Promise<ApiResult<{ chunks: RetrievedChunk[] }>> => {
  try {
    if (!getTaskById(params.taskId)) {
      return { ok: false, error: { code: 'TASK_NOT_FOUND', message: '撰写任务不存在' } }
    }
    return { ok: true, data: { chunks: (await retrieveForTask(params.taskId)) ?? [] } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

handleLogged(IPC.WRITING_GENERATE_DRAFT, async (event, params: WritingGenerateDraftReq): Promise<ApiResult<WritingGenerateDraftRes>> => {
  // 生成初稿阶段进度推送（Phase 3.5 后续 / 2026-08-11：文字提示 + 进度百分比 + 预计剩余秒数）
  const onProgress = (stage: string, percent: number, etaSeconds?: number): void => {
    if (!event.sender.isDestroyed()) {
      event.sender.send(IPC_EVENTS.DRAFT_GENERATE_PROGRESS, { taskId: params.taskId, stage, percent, etaSeconds })
    }
  }
  const result = await generateDraft(params.taskId, params.instruction, onProgress)
  if (result.ok) return { ok: true, data: { draft: result.draft, articleTitle: result.articleTitle, contradictions: result.contradictions } }
  return { ok: false, error: result.error }
})

// 重新生成初稿（Task 3.4.5）：删除现有第 0 稿后重新生成（覆盖旧稿）
handleLogged(IPC.DRAFT_REGENERATE, async (event, params: DraftRegenerateReq): Promise<ApiResult<DraftRegenerateRes>> => {
  const onProgress = (stage: string, percent: number, etaSeconds?: number): void => {
    if (!event.sender.isDestroyed()) {
      event.sender.send(IPC_EVENTS.DRAFT_GENERATE_PROGRESS, { taskId: params.taskId, stage, percent, etaSeconds })
    }
  }
  const result = await regenerateDraft(params.taskId, params.instruction, onProgress)
  if (result.ok) return { ok: true, data: { draft: result.draft, articleTitle: result.articleTitle, contradictions: result.contradictions } }
  return { ok: false, error: result.error }
})

handleLogged(IPC.DRAFT_GET, (_event, params: DraftGetReq): ApiResult<Draft> => {
  try {
    const draft = getDraftById(params.draftId)
    if (!draft) return { ok: false, error: { code: 'DRAFT_NOT_FOUND', message: '志稿不存在' } }
    return { ok: true, data: draft }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 整稿保存（Task 3.4.1）：初稿连续显示为整体，编辑后按整稿 Markdown 保存并重建片段
handleLogged(IPC.DRAFT_UPDATE_CONTENT, (_event, params: DraftUpdateContentReq): ApiResult<DraftUpdateContentRes> => {
  try {
    const draft = replaceDraftSegments(params.draftId, params.markdown)
    if (!draft) return { ok: false, error: { code: 'DRAFT_NOT_FOUND', message: '志稿不存在' } }
    return { ok: true, data: { draft } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// 读取某稿的矛盾清单（Phase 3.7 Task 3.7.4：矛盾弹窗 / 编辑器标注初始化）
handleLogged(IPC.DRAFT_GET_CONTRADICTIONS, (_event, params: DraftGetContradictionsReq): ApiResult<DraftGetContradictionsRes> => {
  try {
    return { ok: true, data: { contradictions: getContradictionsByDraft(params.draftId) } }
  } catch {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: '读取矛盾清单失败' } }
  }
})

// 矛盾取舍（Phase 3.7 Task 3.7.4：采纳某说法 / 忽略该矛盾；adopt 须带属于该矛盾的说法 id）
// 2026-08-11：新增 revert=撤销采纳（采纳被编辑器"撤销"回退后，矛盾状态回置为待处理）
handleLogged(
  IPC.DRAFT_RESOLVE_CONTRADICTION,
  (_event, params: DraftResolveContradictionReq): ApiResult<DraftResolveContradictionRes> => {
    try {
      const statusMap = {
        adopt: 'adopted',
        ignore: 'ignored',
        revert: 'pending'
      } as const
      if (!(params.action in statusMap)) {
        return { ok: false, error: { code: 'INVALID_PARAM', message: '无效的取舍动作' } }
      }
      // IPC 动作 adopt → 状态 adopted；ignore → ignored；revert（撤销采纳）→ pending
      const contradiction = updateContradictionStatus(
        params.contradictionId,
        statusMap[params.action],
        params.variantId
      )
      if (!contradiction) {
        return { ok: false, error: { code: 'INVALID_PARAM', message: '矛盾不存在，或采纳的说法不属于该矛盾' } }
      }
      return { ok: true, data: { contradiction } }
    } catch {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '更新矛盾状态失败' } }
    }
  }
)

// 矛盾采纳 → 正文同步修订（2026-08-11：LLM 生成替换文句，主进程校验定位并落库，移除【矛盾#N】标注；资料库只读）
handleLogged(IPC.DRAFT_APPLY_CONTRADICTION, async (_event, params: DraftApplyContradictionReq): Promise<ApiResult<DraftApplyContradictionRes>> => {
  const result = await applyContradictionEdit(params.draftId, params.contradictionId, params.variantId)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, data: { draft: result.draft, contradiction: result.contradiction } }
})

// 用系统默认软件打开资料源文件（Phase 3.7 Task 3.7.6；URL 资料走浏览器）
handleLogged(IPC.SOURCES_OPEN_PATH, async (_event, params: SourceOpenPathReq): Promise<ApiResult<SourceOpenPathRes>> => {
  const source = getSourceById(params.sourceId)
  if (!source) return { ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '资料不存在' } }
  try {
    if (source.kind === 'url') {
      if (!source.url) return { ok: false, error: { code: 'INVALID_PARAM', message: '该资料没有可打开的网址' } }
      await shell.openExternal(source.url)
      return { ok: true, data: { opened: true } }
    }
    const filePath = resolveSourceFilePath(source)
    if (!filePath || !existsSync(filePath)) {
      return { ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '源文件已不存在（可能被移动或删除）' } }
    }
    const errMsg = await shell.openPath(filePath)
    if (errMsg) return { ok: false, error: { code: 'INTERNAL_ERROR', message: `打开文件失败：${errMsg}` } }
    return { ok: true, data: { opened: true } }
  } catch {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: '打开文件失败' } }
  }
})

handleLogged(IPC.SEGMENT_UPDATE, (_event, params: SegmentUpdateReq): ApiResult<SegmentUpdateRes> => {
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

// 读取任务最新一稿（2026-08-11 删去版本管理后仅保留初稿；替代原 version:list 定位最新稿）
handleLogged(IPC.DRAFT_GET_LATEST, (_event, params: DraftGetLatestReq): ApiResult<DraftGetLatestRes> => {
  try {
    const draft = getLatestDraftByTask(params.taskId)
    if (!draft) return { ok: false, error: { code: 'DRAFT_NOT_FOUND', message: '志稿不存在' } }
    return { ok: true, data: { draft } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// ===== 启动 =====

app.whenReady().then(() => {
  // 记录启动日志（诊断日志起点）
  logMain('app', `应用启动 (version=${app.getVersion()}, platform=${process.platform}, arch=${process.arch})`)

  // 初始化数据库（触发迁移）
  getDb()

  // 写入预设写作规范 skills（幂等：仅首次启动表为空时插入）
  seedPresetSkills()

  // 配置本地向量嵌入模型目录（<appPath>/resources/models/<modelId>/）
  configureEmbedModel({ modelPath: join(app.getAppPath(), 'resources', 'models') })

  // 启动内嵌文件服务（提供 PDF/图片等本地文件）
  startFileServer()

  // 已配置工作区时，启动即触发一次全量对账（扫描 + 解析 + 索引）并启动实时监听
  if (getWorkspaceDir()) {
    requestWorkspaceSync(pushWorkspaceProgress)
    startWorkspaceWatcher(pushWorkspaceProgress)
  }

  // 每分钟自动触发一次工作区全量对账（Task 2.2.5，兜底：即使 chokidar 漏事件也会自动收敛）
  startAutoSyncTimer(pushWorkspaceProgress)

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
  logMain('app', '应用退出')
  stopWorkspaceWatcher()
  stopAutoSyncTimer()
  stopEmbedWorker()
  fileServer?.close()
  fileServer = null
})
