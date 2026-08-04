import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC, type AppInfoRes } from '../shared/ipc'
import type { ApiResult, Source, Tag } from '../shared/types'
import { getDb } from './db/connection'
import { listSources } from './db/sources'
import { listTags, createTag, updateTag, deleteTag, addTagToSource, removeTagFromSource } from './db/tags'
import { importFiles, importUrl } from './import'
import { parseTemplate as parseTemplateFile } from './import/template-parser'
import { basename } from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { insertTemplate, listTemplates, getTemplateById, deleteTemplate } from './db/templates'

const APP_PROTOCOL_WHITELIST = /^https?:\/\//i

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
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (APP_PROTOCOL_WHITELIST.test(url)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
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

// Task 2.1 文件导入
ipcMain.handle(IPC.SOURCES_IMPORT_FILES, async (_event, params: { paths: string[] }): Promise<ApiResult<{ results: { path: string; source?: Source; error?: string }[] }>> => {
  try {
    const results = await importFiles(params.paths)
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
      return { ok: true, data: { source: result.source } }
    }
    return { ok: false, error: { code: result.errorCode ?? 'FETCH_FAILED', message: result.error ?? '未知错误' } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// Task 2.3 标签 CRUD
ipcMain.handle(IPC.TAGS_CREATE, (_event, params: { name: string; color?: string }): ApiResult<{ tag: Tag }> => {
  try {
    const tag = createTag(params.name, params.color)
    return { ok: true, data: { tag } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

ipcMain.handle(IPC.TAGS_UPDATE, (_event, params: { id: string; name?: string; color?: string }): ApiResult<Tag> => {
  try {
    const tag = updateTag(params.id, params.name, params.color)
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

ipcMain.handle(IPC.TAGS_LIST, (): ApiResult<{ items: Tag[] }> => {
  try {
    const items = listTags()
    return { ok: true, data: { items } }
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err) } }
  }
})

// ===== 启动 =====

app.whenReady().then(() => {
  // 初始化数据库（触发迁移）
  getDb()

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
