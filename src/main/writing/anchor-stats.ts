/**
 * anchor-stats.ts —— Phase 9 / S4 补（2026-10-03）：**让来源位置可见**。
 *
 * 为什么需要：锚点是在段落落库后由 `attachAnchorsQuietly` **后台异步**算的，生成汇总里看不到，
 * 失败也只写一行诊断日志——这正是本项目反复踩的"静默失败"坑（用户只能靠一条条点圆标去发现
 * "怎么有的段没有位置"）。这里给界面一个只读统计：总共多少段、有多少段已记录位置、其中多少段
 * 能到页（PDF）、多少段未记录。
 *
 * D2（用户裁定）：引文在来源里出现**多处**时，锚点取的是第一处（消歧要等"卡片↔字符区间"那一步），
 * 这里**如实统计**这类段数，不假装唯一。
 */
import Database from 'better-sqlite3'
import { getDb, setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { listAnchorsForItems, replaceItemAnchors } from '../db/compilation-item-anchors'
import { getSourceById } from '../db/sources'

export interface AnchorStats {
  /** 段落总数 */
  total: number
  /** 有来源位置的段数 */
  anchored: number
  /** 其中有页码的段数（PDF 来源；其余来源没有页概念，界面报"第 N 段"） */
  withPage: number
  /** 其中引文/正文在来源里出现多处的段数（位置可能不是唯一那处，如实统计） */
  ambiguous: number
}

/** 归一化（去空白）后统计 substr 在 hay 里出现几次；只需要区分"1 次 / >1 次" */
function occursMoreThanOnce(hay: string, needle: string): boolean {
  const first = hay.indexOf(needle)
  if (first < 0) return false
  return hay.indexOf(needle, first + 1) >= 0
}

/**
 * 统计某汇编的来源位置覆盖情况。只读；`ambiguous` 只检查**主来源**（并列来源用的候选文字
 * 是生成期内存数据，落库后已不可得——这一点在界面上按"引文在来源里出现多处"表述，不做更强断言）。
 */
export function collectAnchorStats(compilationId: string, db: Database.Database = getDb()): AnchorStats {
  const items = db
    .prepare('SELECT id, source_id, excerpt, evidence FROM compilation_items WHERE compilation_id = ?')
    .all(compilationId) as { id: string; source_id: string; excerpt: string; evidence: string | null }[]
  const stats: AnchorStats = { total: items.length, anchored: 0, withPage: 0, ambiguous: 0 }
  if (items.length === 0) return stats

  const anchorsByItem = listAnchorsForItems(items.map((i) => i.id), db)
  /** 归一化正文缓存（年鉴单份 60 万字，逐段重复归一化会很浪费） */
  const normalized = new Map<string, string>()
  const sourceText = (sourceId: string): string => {
    const cached = normalized.get(sourceId)
    if (cached != null) return cached
    const text = (getSourceById(sourceId)?.cleanedText ?? '').replace(/\s+/g, '')
    normalized.set(sourceId, text)
    return text
  }

  for (const it of items) {
    const anchors = anchorsByItem.get(it.id)
    if (!anchors || anchors.length === 0) continue
    stats.anchored += 1
    if (anchors.some((a) => a.page != null)) stats.withPage += 1
    // 多命中检查：用锚点实际依据的那段文字（evidence 优先，与 attachAnchors 同口径）
    const evidence = (it.evidence ?? '').replace(/\s+/g, '')
    const hay = sourceText(it.source_id)
    const needle = evidence.length >= 4 && hay.includes(evidence) ? evidence : it.excerpt.replace(/\s+/g, '')
    if (needle.length >= 4 && occursMoreThanOnce(hay, needle)) stats.ambiguous += 1
  }
  return stats
}

/* ------------------------------ 单测 ------------------------------ */

if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database

  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
    db.prepare("INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t1','任务','{\"all\":true}')").run()
    db.prepare(
      "INSERT INTO compilations (id, task_id, title, status, created_at, updated_at) VALUES ('c1','t1','汇编','drafting','2026-10-03','2026-10-03')"
    ).run()
    // 同一句话在正文里出现两次 → 多命中
    db.prepare(
      "INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s1','file','年鉴','甲。全区新增高中一所。乙。全区新增高中一所。','ready')"
    ).run()
    db.prepare(
      "INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s2','file','Word','丙丁戊己庚辛。','ready')"
    ).run()
    // s1 有块表（页码 7 / 8），s2 无页概念
    const ins = db.prepare(
      "INSERT INTO source_blocks (source_id, block_index, char_start, char_end, page, label, created_at) VALUES (?,?,?,?,?,NULL,'2026-10-03')"
    )
    ins.run('s1', 0, 0, 10, 7)
    ins.run('s1', 1, 10, 24, 8)
    const it = db.prepare(
      "INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, evidence, created_at) VALUES (?,?,?,?,?,?,?)"
    )
    it.run('i1', 'c1', 0, 's1', '全区新增高中一所。', '全区新增高中一所。', '2026-10-03')
    it.run('i2', 'c1', 1, 's2', '丙丁戊己', null, '2026-10-03')
    it.run('i3', 'c1', 2, 's1', '这句来源里没有', null, '2026-10-03')
  })
  afterAll(() => db.close())

  describe('anchor stats (Phase 9 / S4 补)', () => {
    it('统计有位置/有页码/多命中/未记录', () => {
      replaceItemAnchors(db, 'i1', [{ sourceId: 's1', blockIndex: 1, confidence: 'exact' }])
      replaceItemAnchors(db, 'i2', [{ sourceId: 's2', blockIndex: 0, confidence: 'weak' }])
      const stats = collectAnchorStats('c1', db)
      expect(stats.total).toBe(3)
      expect(stats.anchored).toBe(2)
      expect(stats.withPage).toBe(1) // i1 有页码，i2 是无页概念的来源
      expect(stats.ambiguous).toBe(1) // i1 的引文在 s1 里出现两次
    })

    it('没有段落 / 没有锚点时不炸', () => {
      expect(collectAnchorStats('不存在', db)).toEqual({ total: 0, anchored: 0, withPage: 0, ambiguous: 0 })
      const empty = collectAnchorStats('c1', db)
      expect(empty.anchored).toBe(2)
    })
  })
}
