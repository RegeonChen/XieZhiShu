import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'

// 通过 contextBridge 暴露的最小 API 面；Renderer 不得获得其他本地能力
const api = {
  getAppInfo(): Promise<{ version: string; platform: string }> {
    return ipcRenderer.invoke(IPC.APP_GET_INFO)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type AppApi = typeof api
