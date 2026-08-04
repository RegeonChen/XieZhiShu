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
  /** 标签列表 */
  listTags(): Promise<ApiResult<{ items: unknown[] }>> {
    return ipcRenderer.invoke(IPC.TAGS_LIST)
  },
  /** 创建标签 */
  createTag(name: string, color?: string): Promise<ApiResult<{ tag: unknown }>> {
    return ipcRenderer.invoke(IPC.TAGS_CREATE, { name, color })
  },
  /** 添加信源网址 */
  addUrl(url: string): Promise<ApiResult<{ source: unknown }>> {
    return ipcRenderer.invoke(IPC.SOURCES_ADD_URL, { url })
  },
  /** 更新标签 */
  updateTag(id: string, name?: string, color?: string): Promise<ApiResult<unknown>> {
    return ipcRenderer.invoke(IPC.TAGS_UPDATE, { id, name, color })
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
  }
}

contextBridge.exposeInMainWorld('api', api)
export type AppApi = typeof api
