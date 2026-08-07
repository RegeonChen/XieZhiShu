/**
 * scanner.ts —— 工作区递归扫描与差异比对（Phase 2.2 Task 2.2.1）。
 * 递归遍历工作区（含多级子目录），仅识别支持格式，与数据库中的工作区资料
 * 按"相对路径 + 内容哈希"比对，产出三类差异：新增 / 变更 / 消失。
 * 注意：路径比较做归一化（Windows 大小写不敏感、分隔符统一为 '/'），
 * 但"移动/重命名"由 reconcile 用内容哈希二次识别，不在此处处理。
 */
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { getDb } from '../db/connection'
import { isSupported } from '../import/file-parser'
import { fingerprintFile } from './fingerprint'

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

function shouldSkip(name: string): boolean {
  return name.startsWith('.') || SKIP_SUFFIXES.some((s) => name.endsWith(s))
}

/** 判断路径是否应被监听/扫描忽略（供 watcher 复用） */
export function isIgnoredPath(absPath: string): boolean {
  const name = absPath.split(/[\\/]/).pop() ?? ''
  return shouldSkip(name) || SKIP_DIRS.has(name)
}

function collectFiles(root: string, dir: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 目录不可读（权限/占用）时静默跳过
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || shouldSkip(e.name)) continue
      collectFiles(root, join(dir, e.name), out)
    } else if (e.isFile() && isSupported(e.name) && !shouldSkip(e.name)) {
      // 统一用正斜杠相对路径存储（跨平台一致）
      out.push(relative(root, join(dir, e.name)).split(sep).join('/'))
    }
  }
}

// 路径归一化：分隔符统一为 '/' 且忽略大小写（Windows）
const norm = (p: string): string => p.split(/[\\/]/).join('/').toLowerCase()

export function scanWorkspace(rootDir: string): ScanDiff {
  const files: string[] = []
  collectFiles(rootDir, rootDir, files)

  const db = getDb()
  const rows = db
    .prepare("SELECT id, file_path FROM sources WHERE workspace = 1 AND kind = 'file' AND file_path IS NOT NULL")
    .all() as { id: string; file_path: string }[]

  const dbByNorm = new Map<string, string>() // normPath -> id
  for (const r of rows) dbByNorm.set(norm(r.file_path), r.id)
  const fsSet = new Set(files.map(norm))

  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []

  for (const f of files) {
    const key = norm(f)
    const id = dbByNorm.get(key)
    if (!id) {
      added.push(f)
      continue
    }
    const fp = fingerprintFile(join(rootDir, f))
    if (!fp) continue
    const row = db.prepare('SELECT content_hash FROM sources WHERE id = ?').get(id) as { content_hash: string | null } | undefined
    if (row && fp.contentHash !== row.content_hash) changed.push(f)
  }

  for (const r of rows) {
    if (!fsSet.has(norm(r.file_path))) removed.push(r.file_path)
  }

  return { added, changed, removed }
}
