/**
 * source-removal.ts —— 来源被移除后，是否清理其在资料汇编中的卡片（2026-08-28）。
 * 触发来源：
 *   - workspace：工作区对账检测到某来源（文件）被移除，且它已被用于资料汇编；
 *   - manual  ：用户在资料库中直接删除该资料，且该资料已被用于资料汇编。
 * 流程：检测到“被汇编引用”时先不立即删除来源本身，而是登记为 pending 并通知渲染层弹出确认框；渲染层决定：
 *   - delete：删除该来源在全部资料汇编中的卡片（含矛盾/二次改动，不入回收站），再删除来源；
 *   - keep  ：仅删除来源（卡片因外键 SET NULL 保留，成为无来源的孤儿卡片）。
 * 为避免重复提示，pending 的来源会在对账中被跳过（isPendingSourceRemoval）。
 */
import { getDb } from '../db/connection'
import { deleteSources } from '../db/sources'
import { deleteCompilationItemsForSourceIds } from '../db/compilations'
import { logMain } from '../logger'
import type { WorkspaceSourceRemovalPending } from '../../shared/ipc'

/**
 * 待确认的来源移除（与渲染层共享同一份类型，避免两处字段漂移）。
 * 字段含义见 `WorkspaceSourceRemovalPending`。
 */
export type SourceRemovalPending = WorkspaceSourceRemovalPending

const pending = new Map<string, SourceRemovalPending>()
let notify: ((item: SourceRemovalPending) => void) | null = null

/** 交由主进程设置：登记新的来源移除时回调（用于向渲染层推送事件） */
export function setSourceRemovalNotify(fn: ((item: SourceRemovalPending) => void) | null): void {
  notify = fn
}

export function isPendingSourceRemoval(sourceId: string): boolean {
  return pending.has(sourceId)
}

export function listPendingSourceRemovals(): SourceRemovalPending[] {
  return [...pending.values()]
}

/**
 * 统计某来源在资料汇编中的引用情况（无副作用，不登记、不通知）。
 *
 * Phase 7.12（多来源）：段数改按**并列来源关系表**统计（一个段只要提到该来源就计入，
 * 包括"它只是并列出处、主来源是别的"这种情形），并区分：
 * - `sharedCount`：该段**还有其它来源**共同记载 → 删掉本来源后段会保留，主来源改指剩下的那个；
 * - `cardCount - sharedCount`：**只由本来源**记载的段（孤本）→ 随「删除卡片」一起删，或「保留卡片」后成为来源待补。
 */
export function getSourceRemovalStats(sourceId: string, title: string, origin: 'workspace' | 'manual'): SourceRemovalPending {
  const db = getDb()
  const cardCount = (
    db.prepare('SELECT COUNT(*) AS c FROM compilation_item_sources WHERE source_id = ?').get(sourceId) as { c: number }
  ).c
  const sharedCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM compilation_item_sources r
          WHERE r.source_id = ?
            AND (SELECT COUNT(*) FROM compilation_item_sources r2 WHERE r2.item_id = r.item_id) > 1`
      )
      .get(sourceId) as { c: number }
  ).c
  const contradictionCount = (
    db
      .prepare(`SELECT COUNT(DISTINCT c.id) AS c FROM compilation_contradictions c
       INNER JOIN compilation_contradiction_variants v ON v.contradiction_id = c.id WHERE v.source_id = ?`)
      .get(sourceId) as { c: number }
  ).c
  return { sourceId, title, cardCount, sharedCount, contradictionCount, origin }
}

/**
 * 把"主来源是本来源、但还有其它来源共同记载"的段**改指剩余来源之一**（Phase 7.12）。
 *
 * 为什么必须做：`compilation_items.source_id` 的外键是 `ON DELETE SET NULL`，删来源会把主来源置空，
 * 这些段就会变成「来源待补」——可它们明明还有另一个出处。改指后段落仍可溯源，圆标改号到剩余来源。
 * 返回改指的段数（供日志与提示）。
 *
 * 说明：编号表（`compilation_sources`）里被删来源那一行**保留不清**（"编号只增不回收"，Phase 7.2 裁定 D2），
 * 因此改指只动 `compilation_items.source_id/source_ordinal`。
 */
export function repointSharedSourceItems(sourceId: string): number {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT i.id AS item_id, i.compilation_id AS compilation_id
         FROM compilation_items i
        WHERE i.source_id = ?
          AND (SELECT COUNT(*) FROM compilation_item_sources r WHERE r.item_id = i.id) > 1`
    )
    .all(sourceId) as { item_id: string; compilation_id: string }[]
  if (rows.length === 0) return 0
  const upd = db.prepare('UPDATE compilation_items SET source_id = ?, source_ordinal = ? WHERE id = ?')
  const tx = db.transaction(() => {
    let n = 0
    for (const r of rows) {
      /* 选剩余来源：优先按本汇编编号表里的 ordinal 升序（与"首次引用顺序"同口径），保证结果确定 */
      const next = db
        .prepare(
          `SELECT r.source_id AS source_id
             FROM compilation_item_sources r
             LEFT JOIN compilation_sources s ON s.compilation_id = ? AND s.source_id = r.source_id
            WHERE r.item_id = ? AND r.source_id <> ?
            ORDER BY COALESCE(s.ordinal, 2147483647) ASC, r.source_id ASC
            LIMIT 1`
        )
        .get(r.compilation_id, r.item_id, sourceId) as { source_id: string } | undefined
      if (!next?.source_id) continue
      const ord = db
        .prepare('SELECT ordinal FROM compilation_sources WHERE compilation_id = ? AND source_id = ?')
        .get(r.compilation_id, next.source_id) as { ordinal: number } | undefined
      upd.run(next.source_id, ord?.ordinal ?? null, r.item_id)
      n += 1
    }
    return n
  })
  return tx()
}

/** 该来源是否已被资料汇编引用（卡片/矛盾任一非零即视为引用）。 */
export function isSourceUsedInCompilation(sourceId: string): boolean {
  const s = getSourceRemovalStats(sourceId, '', 'workspace')
  return s.cardCount > 0 || s.contradictionCount > 0
}

/** 登记一个待确认的来源移除，并返回统计（用于向渲染层推送确认框）。
 * 幂等：同一来源若已在等待确认，不再重复登记/通知，避免同一个来源被多次弹框。
 * （来源移除可能被多条路径触发：资料库直接删除 + 工作区文件回收触发的对账等。） */
export function registerSourceRemoval(sourceId: string, title: string, origin: 'workspace' | 'manual' = 'workspace'): SourceRemovalPending {
  const existing = pending.get(sourceId)
  if (existing) {
    logMain('workspace', '来源移除确认已存在（origin=' + existing.origin + '），跳过重复登记 origin=' + origin)
    return existing
  }
  const item = getSourceRemovalStats(sourceId, title, origin)
  pending.set(sourceId, item)
  logMain('workspace', '登记来源移除确认 source=' + sourceId + ' origin=' + origin + ' 卡片=' + item.cardCount + ' 矛盾=' + item.contradictionCount)
  notify?.(item)
  return item
}

/** 渲染层处理完来源移除确认：delete 删除孤本段+来源；keep 仅删除来源（段保留，孤本段成为来源待补）。 */
export function decideSourceRemoval(
  sourceId: string,
  action: 'delete' | 'keep'
): { deletedItems: number; deletedContradictions: number; repointedItems: number } {
  const p = pending.get(sourceId)
  if (!p) {
    logMain('workspace', '处理来源移除确认 source=' + sourceId + ' 不在待确认列表，跳过')
    return { deletedItems: 0, deletedContradictions: 0, repointedItems: 0 }
  }
  /*
   * Phase 7.12（多来源）：**先改指、再删**。
   * 还有其它来源共同记载的段先改指到剩余来源，随后 `deleteCompilationItemsForSourceIds` 只会命中
   * "只由本来源记载"的孤本段（它按 `source_id` 匹配，改指过的段已不在其中）。
   */
  const repointedItems = repointSharedSourceItems(sourceId)
  let result = { deletedItems: 0, deletedContradictions: 0 }
  if (action === 'delete') {
    result = deleteCompilationItemsForSourceIds([sourceId])
  }
  // keep 或 delete 之后都删除来源：并列来源关系行随外键级联清理，孤本段在 keep 时因外键 SET NULL 变成来源待补
  deleteSources([sourceId])
  pending.delete(sourceId)
  logMain(
    'workspace',
    '处理来源移除确认 source=' +
      sourceId +
      ' action=' +
      action +
      ' 删除孤本段=' +
      result.deletedItems +
      ' 改指并列来源段=' +
      repointedItems +
      ' 矛盾=' +
      result.deletedContradictions
  )
  return { ...result, repointedItems }
}
