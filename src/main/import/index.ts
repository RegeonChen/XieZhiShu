/**
 * import/index.ts —— 导入编排：解析文件、保留副本、写入数据库。
 * 性能要点（2026-08-06 优化）：文件复制与解析全部异步（fs/promises），
 * 批量导入时每批让出事件循环，避免阻塞主进程导致 UI 卡死。
 */
import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { insertSource } from '../db/sources'
import type { Source } from '../../shared/types'
import { isSupported, parseFile } from './file-parser'
import { fetchUrl, validateUrl } from './url-fetcher'

/** 每处理多少文件主动让出一次事件循环 */
const BATCH = 10

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(() => r()))

function getImportDir(): string {
  const dir = join(app.getPath('userData'), 'imports')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export interface ImportFileResult {
  path: string
  source?: Source
  error?: string
  errorCode?: string
}

export async function importFile(filePath: string): Promise<ImportFileResult> {
  if (!isSupported(filePath)) {
    return { path: filePath, error: '不支持的文件格式', errorCode: 'PARSE_UNSUPPORTED' }
  }

  try {
    // 1. 解析
    const { text } = await parseFile(filePath)

    // 2. 复制到本地 dataDir（保留原始副本）
    const importDir = getImportDir()
    const destName = `${Date.now()}-${basename(filePath)}`
    const destPath = join(importDir, destName)
    await copyFile(filePath, destPath)

    // 3. 写入数据库
    const id = crypto.randomUUID()
    const source: Source = {
      id,
      kind: 'file',
      title: basename(filePath),
      filePath: destName, // 只存相对文件名，dataDir 由应用上下文决定
      cleanedText: text,
      status: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    insertSource(source)

    return { path: filePath, source }
  } catch (err) {
    const e = err as Error & { code?: string }
    return {
      path: filePath,
      error: e.message,
      errorCode: e.code ?? 'PARSE_FAILED'
    }
  }
}

export async function importFiles(paths: string[]): Promise<ImportFileResult[]> {
  const results: ImportFileResult[] = []
  for (let i = 0; i < paths.length; i++) {
    // 分片让出事件循环，批量导入时保持主进程响应
    if (i % BATCH === 0) await yieldLoop()
    results.push(await importFile(paths[i]))
  }
  return results
}

export interface ImportUrlResult {
  url: string
  source?: Source
  error?: string
  errorCode?: string
}

export async function importUrl(rawUrl: string): Promise<ImportUrlResult> {
  try {
    const url = validateUrl(rawUrl)
    const { cleanedText, snapshotAt } = await fetchUrl(url)

    const id = crypto.randomUUID()
    const source: Source = {
      id,
      kind: 'url',
      title: url,
      url,
      urlSnapshotAt: snapshotAt,
      cleanedText,
      status: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    insertSource(source)

    return { url, source }
  } catch (err) {
    const e = err as Error & { code?: string }
    return {
      url: rawUrl,
      error: e.message,
      errorCode: e.code ?? 'FETCH_FAILED'
    }
  }
}
