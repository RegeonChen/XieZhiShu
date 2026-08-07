/**
 * fingerprint.ts —— 文件指纹（Phase 2.2 Task 2.2.1）。
 * 以 sha256 内容哈希 + mtime + size 作为"文件系统 ↔ 数据库"映射锚点：
 * 文件移动/重命名（内容不变）哈希不变，可保持资料 id/标签/摘要；
 * 内容变更哈希变化，可精确识别"变更"。
 * 提供同步/异步两套实现：批量扫描/对账一律用异步版本（fs/promises），
 * 避免大文件量下同步 IO 阻塞主进程事件循环导致 UI 卡死。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { readFile as readFileAsync, stat as statAsync } from 'node:fs/promises'

export interface FileFingerprint {
  contentHash: string
  fileMtime: string
  fileSize: number
}

/** 计算文件内容 sha256（全量读取） */
export function computeFileHash(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/** 同步计算文件指纹（小样本/测试用；批量场景请用 fingerprintFileAsync） */
export function fingerprintFile(filePath: string): FileFingerprint | null {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return null
    return {
      contentHash: computeFileHash(filePath),
      fileMtime: stat.mtime.toISOString(),
      fileSize: stat.size
    }
  } catch {
    return null
  }
}

/** 轻量同步指纹（仅 mtime/size，不读内容） */
export function statFingerprint(filePath: string): { fileMtime: string; fileSize: number } | null {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return null
    return { fileMtime: stat.mtime.toISOString(), fileSize: stat.size }
  } catch {
    return null
  }
}

/** 异步计算文件指纹（批量扫描/对账使用；不阻塞主进程） */
export async function fingerprintFileAsync(filePath: string): Promise<FileFingerprint | null> {
  try {
    const stat = await statAsync(filePath)
    if (!stat.isFile()) return null
    const buf = await readFileAsync(filePath)
    return {
      contentHash: createHash('sha256').update(buf).digest('hex'),
      fileMtime: stat.mtime.toISOString(),
      fileSize: stat.size
    }
  } catch {
    return null
  }
}

/** 异步轻量指纹（仅 mtime/size，用于对账快筛；不读内容） */
export async function statFingerprintAsync(filePath: string): Promise<{ fileMtime: string; fileSize: number } | null> {
  try {
    const stat = await statAsync(filePath)
    if (!stat.isFile()) return null
    return { fileMtime: stat.mtime.toISOString(), fileSize: stat.size }
  } catch {
    return null
  }
}
