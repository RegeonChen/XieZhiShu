/**
 * fingerprint.ts —— 文件指纹（Phase 2.2 Task 2.2.1）。
 * 以 sha256 内容哈希 + mtime + size 作为"文件系统 ↔ 数据库"映射锚点：
 * 文件移动/重命名（内容不变）哈希不变，可保持资料 id/标签/摘要；
 * 内容变更哈希变化，可精确识别"变更"。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

export interface FileFingerprint {
  contentHash: string
  fileMtime: string
  fileSize: number
}

/** 计算文件内容 sha256（全量读取；工作区资料文件通常为文档，规模可控） */
export function computeFileHash(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/** 计算文件指纹（hash + mtime + size），文件不存在时返回 null */
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

/** 轻量指纹（仅 mtime/size，不读内容），用于兜底对账的快速比对 */
export function statFingerprint(filePath: string): { fileMtime: string; fileSize: number } | null {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return null
    return { fileMtime: stat.mtime.toISOString(), fileSize: stat.size }
  } catch {
    return null
  }
}
