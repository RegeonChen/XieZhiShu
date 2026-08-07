/**
 * window-state.ts —— 主窗口状态保存与恢复。
 * 在 userData 下用 window-state.json 持久化窗口的尺寸/位置/最大化/全屏状态，
 * 关闭软件时保存，下次启动时恢复为与上次一致。
 * 最大化/全屏时保存"正常边界"（getNormalBounds），恢复时先按边界创建、再置最大/全屏，避免闪烁错位。
 */
import { app, BrowserWindow, screen } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WindowState {
  bounds: { x: number; y: number; width: number; height: number }
  isMaximized: boolean
  isFullScreen: boolean
}

const stateFile = (): string => join(app.getPath('userData'), 'window-state.json')

/** 校验边界至少与某个显示器的工作区部分相交（多显示器变动后避免窗口落在屏幕外） */
export function isValidBounds(b: { x: number; y: number; width: number; height: number }): boolean {
  if (typeof b.x !== 'number' || typeof b.y !== 'number' || b.width < 800 || b.height < 600) return false
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    return wa.x < b.x + b.width && wa.x + wa.width > b.x && wa.y < b.y + b.height && wa.y + wa.height > b.y
  })
}

/** 读取上次保存的窗口状态（无有效记录时返回 null） */
export function loadWindowState(): WindowState | null {
  try {
    const raw = readFileSync(stateFile(), 'utf8')
    const s = JSON.parse(raw) as WindowState
    if (s && typeof s.bounds === 'object' && isValidBounds(s.bounds)) return s
    return null
  } catch {
    return null
  }
}

/** 保存窗口状态（同步写文件；失败静默） */
function saveWindowState(win: BrowserWindow): void {
  try {
    const maximized = win.isMaximized()
    const fullScreen = win.isFullScreen()
    const state: WindowState = {
      bounds: maximized || fullScreen ? win.getNormalBounds() : win.getBounds(),
      isMaximized: maximized,
      isFullScreen: fullScreen
    }
    writeFileSync(stateFile(), JSON.stringify(state), 'utf8')
  } catch {
    // 忽略保存失败（磁盘异常等）
  }
}

let saveTimer: NodeJS.Timeout | null = null

/** 监听窗口事件，防抖保存状态；关闭时立即保存（保证最后一次状态落盘） */
export function trackWindowState(win: BrowserWindow): void {
  const schedule = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveWindowState(win)
    }, 300)
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('enter-full-screen', schedule)
  win.on('leave-full-screen', schedule)
  win.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    saveWindowState(win)
  })
}
