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

export interface SourceRemovalPending {
  sourceId: string
  title: string
  cardCount: number
  contradictionCount: number
  repairCount: number
  /** workspace = 检测到工作区文件被删除；manual = 用户在资料库中直接删除该资料 */
  origin: 'workspace' | 'manual'
}

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

/** 统计某来源在资料汇编中的引用情况（无副作用，不登记、不通知）。 */
export function getSourceRemovalStats(sourceId: string, title: string, origin: 'workspace' | 'manual'): SourceRemovalPending {
  const db = getDb()
  const cardCount = (db.prepare('SELECT COUNT(*) AS c FROM compilation_items WHERE source_id = ?').get(sourceId) as { c: number }).c
  const contradictionCount = (
    db
      .prepare(`SELECT COUNT(DISTINCT c.id) AS c FROM compilation_contradictions c
       INNER JOIN compilation_contradiction_variants v ON v.contradiction_id = c.id WHERE v.source_id = ?`)
      .get(sourceId) as { c: number }
  ).c
  const repairCount = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM compilation_repairs r
       INNER JOIN compilation_items i ON i.id = r.item_id WHERE i.source_id = ?`)
      .get(sourceId) as { c: number }
  ).c
  return { sourceId, title, cardCount, contradictionCount, repairCount, origin }
}

/** 该来源是否已被资料汇编引用（卡片/矛盾/二次改动任一非零即视为引用）。 */
export function isSourceUsedInCompilation(sourceId: string): boolean {
  const s = getSourceRemovalStats(sourceId, '', 'workspace')
  return s.cardCount > 0 || s.contradictionCount > 0 || s.repairCount > 0
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
  logMain('workspace', '登记来源移除确认 source=' + sourceId + ' origin=' + origin + ' 卡片=' + item.cardCount + ' 矛盾=' + item.contradictionCount + ' 修订=' + item.repairCount)
  notify?.(item)
  return item
}

/** 渲染层处理完来源移除确认：delete 删除卡片+来源；keep 仅删除来源（卡片保留）。 */
export function decideSourceRemoval(
  sourceId: string,
  action: 'delete' | 'keep'
): { deletedItems: number; deletedContradictions: number; deletedRepairs: number } {
  const p = pending.get(sourceId)
  if (!p) {
    logMain('workspace', '处理来源移除确认 source=' + sourceId + ' 不在待确认列表，跳过')
    return { deletedItems: 0, deletedContradictions: 0, deletedRepairs: 0 }
  }
  let result = { deletedItems: 0, deletedContradictions: 0, deletedRepairs: 0 }
  if (action === 'delete') {
    result = deleteCompilationItemsForSourceIds([sourceId])
  }
  // keep 或 delete 之后都删除来源（delete 时卡片已清空，delete 来源无副作用；keep 时卡片保留，来源删除后 source_id 置空）
  deleteSources([sourceId])
  pending.delete(sourceId)
  logMain('workspace', '处理来源移除确认 source=' + sourceId + ' action=' + action + ' 删除卡片=' + result.deletedItems + ' 矛盾=' + result.deletedContradictions + ' 修订=' + result.deletedRepairs)
  return result
}
