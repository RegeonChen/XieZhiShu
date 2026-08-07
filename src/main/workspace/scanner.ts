/**
 * scanner.ts —— 工作区递归扫描与差异比对（Phase 2.2 Task 2.2.1，性能优化版）。
 * 递归遍历工作区（含多级子目录），仅识别支持格式，与数据库中的工作区资料
 * 按"相对路径 + 内容哈希"比对，产出三类差异：新增 / 变更 / 消失。
 *
 * 性能要点（2026-08-06 优化）：
 * 1. 全部使用 fs/promises 异步 IO，并按批（BATCH）主动让出事件循环，
 *    避免大文件量下同步扫描阻塞主进程导致 UI 卡死。
 * 2. 变更判定先用 mtime/size 快筛（不读内容），仅对 mtime/size 变化的文件
 *    才计算内容哈希，兜底对账不重复读全库。
 * 路径比较做归一化（Windows 大小写不敏感、分隔符统一为 '/'）。
 */
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { getDb } from '../db/connection'
import { isSupported } from '../import/file-parser'
import { fingerprintFileAsync, statFingerprintAsync } from './fingerprint'

export interface ScanDiff {
  /** 文件系统存在、库中无该路径记录（可能是真新增，也可能是移动/重命名） */
  added: string[]
  /** 文件系统存在、库有记录但内容哈希变化 */
  changed: string[]
  /** 库中有记录、文件系统已不存在 */
  removed: string[]
}

/** 扫描时跳过的目录（用户工作区中的常见无关目录） */
const SKIP_DIRS = new Set(['.git', '.idea', '.vscode', '.vs', 'node_modules', '__pycache__', '.DS_Store'])
const SKIP_SUFFIXES = ['~', '.tmp', '.bak', '.swp']

/** 每处理多少项主动让出一次事件循环 */
const BATCH = 50

function shouldSkip(name: string): boolean {
  return name.startsWith('.') || SKIP_SUFFIXES.some((s) => name.endsWith(s))
}

/** 判断路径是否应被监听/扫描忽略（供 watcher 复用） */
export function isIgnoredPath(absPath: string): boolean {
  const name = absPath.split(/[\\/]/).pop() ?? ''
  return shouldSkip(name) || SKIP_DIRS.has(name)
}

/** 让出事件循环（配合分片，避免长时间阻塞主进程） */
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(() => r()))

async function collectFilesAsync(root: string, dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // 目录不可读（权限/占用）时静默跳过
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || shouldSkip(e.name)) continue
      await collectFilesAsync(root, join(dir, e.name), out)
    } else if (e.isFile() && isSupported(e.name) && !shouldSkip(e.name)) {
      // 统一用正斜杠相对路径存储（跨平台一致）
      out.push(relative(root, join(dir, e.name)).split('\\').join('/'))
    }
  }
}

const norm = (p: string): string => p.split(/[\\/]/).join('/').toLowerCase()

interface DbRow {
  id: string
  file_path: string
  content_hash: string | null
  file_mtime: string | null
  file_size: number | null
}

/** 异步扫描工作区并产出差异（分片让出事件循环） */
export async function scanWorkspaceAsync(rootDir: string): Promise<ScanDiff> {
  const files: string[] = []
  await collectFilesAsync(rootDir, rootDir, files)

  const db = getDb()
  const rows = db
    .prepare(
      "SELECT id, file_path, content_hash, file_mtime, file_size FROM sources WHERE workspace = 1 AND kind = 'file' AND file_path IS NOT NULL"
    )
    .all() as DbRow[]

  const dbByNorm = new Map<string, DbRow>() // normPath -> row
  for (const r of rows) dbByNorm.set(norm(r.file_path), r)
  const fsSet = new Set(files.map(norm))

  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []

  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    // 分片让出事件循环，保持主进程响应
    if (i % BATCH === 0) await yieldLoop()

    const key = norm(f)
    const row = dbByNorm.get(key)
    if (!row) {
      added.push(f)
      continue
    }
    // mtime/size 快筛：无变化则跳过内容哈希计算
    const st = await statFingerprintAsync(join(rootDir, f))
    if (!st) continue
    if (st.fileMtime === row.file_mtime && st.fileSize === row.file_size) continue
    // mtime/size 变化 → 计算内容哈希确认是否真的变更
    const fp = await fingerprintFileAsync(join(rootDir, f))
    if (fp && fp.contentHash !== row.content_hash) changed.push(f)
  }

  for (const r of rows) {
    if (!fsSet.has(norm(r.file_path))) removed.push(r.file_path)
  }

  return { added, changed, removed }
}
