import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { IPC, type AppInfoRes } from '../shared/ipc'
import type { ApiResult, Source, Tag } from '../shared/types'
import { getDb } from './db/connection'
import { listSources } from './db/sources'
import { listTags } from './db/tags'

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
