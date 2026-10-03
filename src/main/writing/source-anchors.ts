/**
 * source-anchors.ts —— Phase 9 / S3 收尾：**段落落库时就地算出来源锚点**。
 *
 * 为什么在这里算：这一处（`compilation-service.ts` 的 `persistDocument` → `upsertCompilationParagraphs`）
 * 是唯一能一次拿到**刚写库的全部段落**（`{ id, sourceId, excerpt, evidence }`）的地方。
 * 拿到段 id 才能把锚点写进 `compilation_item_anchors`，拿到 `evidence`/`excerpt` 才能做本地定位。
 *
 * 算法（**全程不做全文检索兜底**，见 PLAN 9.6 / 用户裁定 Q4）：
 *   段落 `evidence`（逐字引文）→ `findVerbatimRange` 得字符区间（失败再用段落 `excerpt`）→
 *   `resolveAnchor` 把它落到 `source_blocks` 的某一块 → 块号 + 页码（页码由块表 LEFT JOIN 得出）。
 * 两条口径上的取舍：
 *   - **找不到就留空**（该段没有锚点行），界面如实显示"未记录来源位置"，绝不猜一个最近匹配；
 *   - **PDF 才给逐页文字**（`extractPdfPageTexts`），Word/WPS/网页没有页概念 → 块表无页码，
 *     界面按 Q3 显示"第 N 段"。
 *
 * ⚠ 依赖隔离：本模块被**同步**的 `persistDocument` 调用，而 Electron（`workspace/sync`）与
 * pdfjs（`parse/pdf-pages`）都会破坏内联单测的运行环境，因此这两者一律走**动态 `import()`**，
 * 只有真正解析 PDF 时才加载。
 */
import { readFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { getDb, setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { logMain } from '../logger'
import { ensureSourceBlocks, listSourceBlocks } from '../db/source-blocks'
import { listItemAnchorsWithPage, replaceItemAnchors } from '../db/compilation-item-anchors'
import { findVerbatimRange, resolveAnchor } from '../parse/anchors'
import { getSourceById } from '../db/sources'
import { getPdfCmapsDir } from '../import/file-parser'
import type { BlockRange } from '../parse/page-map'

/** 本模块只依赖这几个字段（`CompilationItem` 结构兼容），便于单测直接构造 */
export interface AnchorCandidate {
  id: string
  sourceId: string
  excerpt: string
  evidence?: string
}

export interface AnchorAttachStats {
  /** 写入了锚点的段数 */
  anchored: number
  /** 没有可用位置而留空的段数（界面如实显示"未记录来源位置"） */
  skipped: number
  /** 参与处理的来源数 */
  sources: number
}

/**
 * 给该来源取**逐页文字**（只有 PDF 有页；其余返回 null = "无页概念"，块表照旧生成但页码为空）。
 * 与 `file-parser` 用同一份 cmaps 目录——中文 CID 字体 PDF 没有 cmaps 会提不出文字，
 * 那样扫描件/年鉴会退化成"有页但无文字"，页级定位虽仍可用但会失去页区间对齐的校验依据。
 */
async function pageTextsForSource(sourceId: string, _text: string): Promise<string[] | null> {
  const source = getSourceById(sourceId)
  if (!source || source.kind !== 'file' || !source.filePath) return null
  if (!/\.pdf$/i.test(source.filePath)) return null
  const { resolveSourceFilePath } = await import('../workspace/sync')
  const abs = resolveSourceFilePath(source)
  if (!abs) return null
  const data = await readFile(abs)
  const { extractPdfPageTexts } = await import('../parse/pdf-pages')
  const result = await extractPdfPageTexts(new Uint8Array(data), getPdfCmapsDir())
  return result.pages
}

/**
 * 真正干活的部分（可 await，供单测直接调用）。逐来源串行：块表是懒生成的，
 * 串行可避免一次生成同时解析几十份 PDF 把主进程 CPU 打满。
 */
export async function attachAnchors(items: AnchorCandidate[]): Promise<AnchorAttachStats> {
  const stats: AnchorAttachStats = { anchored: 0, skipped: 0, sources: 0 }
  const db = getDb()
  const bySource = new Map<string, AnchorCandidate[]>()
  for (const it of items) {
    if (!it?.id || !it.sourceId) {
      stats.skipped += 1
      continue
    }
    const list = bySource.get(it.sourceId) ?? []
    list.push(it)
    bySource.set(it.sourceId, list)
  }

  for (const [sourceId, group] of bySource) {
    const source = getSourceById(sourceId)
    const text = source?.cleanedText ?? ''
    if (!source || !text.trim()) {
      stats.skipped += group.length
      continue
    }
    stats.sources += 1
    const ensured = await ensureSourceBlocks(sourceId, pageTextsForSource, db)
    if (!ensured.ok) {
      // 拿不到块表（来源已删 / 没有正文 / 页区间有洞）→ 整组留空，不猜
      stats.skipped += group.length
      continue
    }
    const blocks: BlockRange[] = listSourceBlocks(sourceId, db).map((b) => ({
      blockIndex: b.blockIndex,
      start: b.charStart,
      end: b.charEnd,
      page: b.page
    }))
    for (const it of group) {
      const evidence = it.evidence ? findVerbatimRange(text, it.evidence) : null
      const excerpt = it.excerpt ? findVerbatimRange(text, it.excerpt) : null
      const anchor = resolveAnchor(blocks, { evidence, excerpt })
      if (!anchor) {
        stats.skipped += 1
        continue
      }
      replaceItemAnchors(db, it.id, [
        { sourceId, blockIndex: anchor.blockIndex, confidence: anchor.confidence }
      ])
      stats.anchored += 1
    }
  }
  return stats
}

/**
 * 落库处的挂钩点用这个：**同步**函数里 `void attachAnchorsQuietly(items)`（fire-and-forget），
 * 因此它必须**吞掉一切异常**——锚点只是"锦上添花"，绝不能因为定位失败影响汇编生成本身。
 */
export async function attachAnchorsQuietly(items: AnchorCandidate[]): Promise<void> {
  try {
    const stats = await attachAnchors(items)
    logMain(
      'anchor',
      `来源锚点：处理 ${stats.sources} 个来源 / ${items.length} 段，写入 ${stats.anchored} 段，未定位 ${stats.skipped} 段`,
      'INFO'
    )
  } catch (err) {
    logMain('anchor', '来源锚点生成失败（不影响汇编）：' + (err instanceof Error ? err.message : String(err)), 'WARN')
  }
}

/* ------------------------------ 单测 ------------------------------ */
// 注：单测里的来源一律用**非 PDF**路径——PDF 会走动态 import（Electron/pdfjs），
// 这正是依赖隔离要保证的：本模块在 vitest 环境下可以被安全引入。

if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  const TEXT = '前言与凡例。2018 年，全区普通高中招生录取 4123 人，比上学年增加 120 人。后记。'

  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
    db.prepare("INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t1','任务','{\"all\":true}')").run()
    db.prepare(
      "INSERT INTO compilations (id, task_id, title, status, created_at, updated_at) VALUES ('c1','t1','汇编','drafting','2026-10-03','2026-10-03')"
    ).run()
    db.prepare(
      "INSERT INTO sources (id, kind, title, file_path, cleaned_text, status) VALUES ('s1','file','年鉴','年鉴.docx',?,'ready')"
    ).run(TEXT)
    db.prepare(
      "INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, created_at) VALUES ('i1','c1',1,'s1','甲','2026-10-03')"
    ).run()
    db.prepare(
      "INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, created_at) VALUES ('i2','c1',2,'s1','乙','2026-10-03')"
    ).run()
    db.prepare(
      "INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, created_at) VALUES ('i3','c1',3,'s1','丙','2026-10-03')"
    ).run()
  })
  afterAll(() => db.close())

  describe('source anchors attach (Phase 9 / S3 收尾)', () => {
    it('逐字引文落库后就地算出块号（无页码来源 confidence=exact）', async () => {
      const stats = await attachAnchors([
        { id: 'i1', sourceId: 's1', excerpt: '改写过的段落文字', evidence: '全区普通高中招生录取 4123 人' }
      ])
      expect(stats.anchored).toBe(1)
      const anchors = listItemAnchorsWithPage('i1', db)
      expect(anchors).toHaveLength(1)
      expect(anchors[0].sourceId).toBe('s1')
      expect(anchors[0].confidence).toBe('exact')
      // 非 PDF → 块表无页码（界面按 Q3 显示"第 N 段"）
      expect(anchors[0].page).toBeNull()
    })

    it('引文对不上时用段落原文兜底（confidence=weak）；都找不到就留空', async () => {
      const stats = await attachAnchors([
        { id: 'i2', sourceId: 's1', excerpt: '比上学年增加 120 人' },
        { id: 'i3', sourceId: 's1', excerpt: '这段文字来源里根本没有', evidence: '证据也根本没有' }
      ])
      expect(stats.anchored).toBe(1)
      expect(stats.skipped).toBe(1)
      expect(listItemAnchorsWithPage('i2', db)[0].confidence).toBe('weak')
      // 宁可留空，也不猜一个最近匹配（Q4）
      expect(listItemAnchorsWithPage('i3', db)).toHaveLength(0)
    })

    it('来源不存在 / 没有正文：整组留空而不抛错', async () => {
      db.prepare("INSERT INTO sources (id, kind, title, file_path, cleaned_text, status) VALUES ('s2','file','空','空.txt','','ready')").run()
      const stats = await attachAnchors([
        { id: 'i1', sourceId: 's2', excerpt: '任意' },
        { id: 'i1', sourceId: '不存在', excerpt: '任意' }
      ])
      expect(stats.anchored).toBe(0)
      expect(stats.skipped).toBe(2)
    })
  })
}
