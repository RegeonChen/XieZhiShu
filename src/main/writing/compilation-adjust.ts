/**
 * compilation-adjust.ts —— 资料汇编调整服务（Phase 6.4.4，2026-08-28）。
 * 第一步「生成资料汇编」后续每条消息都是对汇编的调整（批量删除 / 增补 / 自定义编辑）：
 * 把【用户请求 + 当前汇编卡片 + 资料库候选来源】交给大模型，返回 editActions 并逐条落库。
 * 无 Provider / LLM 失败时返回 ok=false（不落库，前端提示）。
 */
import type { Compilation } from '../../shared/types'
import { ErrorCodes } from '../../shared/types'
import { getSettings } from '../db/settings'
import { getProviderSecret } from '../llm/provider-store'
import { safeStorageCodec } from '../llm/secret'
import { chatCompletion, type ChatMessage } from '../llm/chat'
import { getDb } from '../db/connection'
import { listSources } from '../db/sources'
import { getCompilationById, insertCompilationItems, updateCompilationItem, deleteCompilationItemsByIds } from '../db/compilations'

const ADJUST_TIMEOUT_MS = 180000

interface ProviderInfo { apiBase: string; model: string; apiKey: string }

export type AdjustCompilationResult =
  | { ok: true; compilation: Compilation; explain?: string; removedCards: number; addedCards: number; updatedCards: number }
  | { ok: false; error: { code: string; message: string } }

function fail(code: string, message: string): AdjustCompilationResult {
  return { ok: false, error: { code, message } }
}

/** 第 1 步资料汇编使用的大模型（Phase 6.8）：以设置「步骤默认模型」第 1 步为准 */
function resolveProvider(): { ok: true; provider: ProviderInfo } | { ok: false; error: { code: string; message: string } } {
  const settings = getSettings()
  const providerId = settings.compilationProviderId
  if (!providerId) return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '请先在设置中为「第 1 步」指定默认大模型' } }
  const provider = getProviderSecret(providerId, safeStorageCodec)
  if (!provider) return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '所选的 LLM Provider 不存在' } }
  if (!provider.apiKey) return { ok: false, error: { code: ErrorCodes.LLM_UNAUTHORIZED, message: '所选的 LLM Provider 未设置 API 密钥' } }
  return { ok: true, provider: { apiBase: provider.config.apiBase, model: provider.config.model, apiKey: provider.apiKey } }
}

/** 从当前汇编与资料库候选来源构造提交物，并请模型返回 editActions */
async function requestEditActions(instruction: string, compilation: Compilation): Promise<{ ok: true; actions: EditAction[]; explain?: string } | { ok: false; error: string }> {
  const prov = resolveProvider()
  if (!prov.ok) return { ok: false, error: prov.error.message }
  const scopeSources = listSources().filter((s) => s.kind === 'file' && s.workspace)
  const cards = compilation.items
    .filter((it) => it.kept)
    .map((it) => ({ id: it.id, excerpt: it.excerpt, ts: it.ts ?? '', source: it.sourceTitle ?? it.sourceId }))
  const candidateSources = scopeSources.slice(0, 200).map((s) => ({ id: s.id, title: s.title }))

  const system: ChatMessage = {
    role: 'system',
    content:
      '你是志书「资料汇编」调整助手。根据用户请求对当前资料汇编做增删改。' +
      '只能返回 JSON：{"editActions":[{"op":"delete","cardId":"..."}|{"op":"update","cardId":"...","excerpt":"...","ts?":"...","note?":"..."}|{"op":"add","sourceId":"...","excerpt":"...","ts?":"...","note?":"..."}],"explain":"..."}。' +
      'op=delete 请给出要删除的卡片 id（cardId 必须来自下面的卡片清单）；op=update 用新摘录覆盖；op=add 的 sourceId 必须来自候选来源清单（若不确定可省略 sourceId）。' +
      '不要删除用户未要求删除的卡片；不要编造不在卡片/候选来源里的内容。'
  }
  const user: ChatMessage = {
    role: 'user',
    content:
      '用户请求：' + instruction + '\n\n' +
      '当前资料汇编卡片（id|摘录|年份|来源）：\n' +
      (cards.length === 0 ? '（空）' : cards.map((c) => c.id + ' | ' + c.excerpt + ' | ' + c.ts + ' | ' + c.source).join('\n')) +
      '\n\n候选来源（id|标题）：\n' +
      (candidateSources.length === 0 ? '（无）' : candidateSources.map((s) => s.id + ' | ' + s.title).join('\n'))
  }
  const result = await chatCompletion(prov.provider, [system, user], ADJUST_TIMEOUT_MS, undefined, { temperature: 0 })
  if (!result.ok) return { ok: false, error: result.error?.message ?? '调用大模型失败' }
  const parsed = parseEditActions(result.text ?? '')
  if (!parsed) return { ok: false, error: '大模型返回的调整格式无法解析' }
  return { ok: true, actions: parsed.actions, explain: parsed.explain }
}

interface EditAction {
  op: 'delete' | 'update' | 'add'
  cardId?: string
  sourceId?: string
  excerpt?: string
  ts?: string
  note?: string
}

/** 解析模型返回的 editActions JSON */
function parseEditActions(text: string): { actions: EditAction[]; explain?: string } | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?s*([sS]*?)```/)
  const candidate = fenced ? fenced[1].trim() : trimmed
  let raw: unknown = null
  try {
    raw = JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try { raw = JSON.parse(candidate.slice(start, end + 1)) } catch { return null }
    } else return null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { editActions?: unknown; explain?: unknown }
  if (!Array.isArray(obj.editActions)) return null
  const actions: EditAction[] = []
  for (const a of obj.editActions) {
    if (!a || typeof a !== 'object') continue
    const o = a as { op?: unknown; cardId?: unknown; sourceId?: unknown; excerpt?: unknown; ts?: unknown; note?: unknown }
    const op = o.op
    if (op !== 'delete' && op !== 'update' && op !== 'add') continue
    const item: EditAction = { op }
    if (typeof o.cardId === 'string') item.cardId = o.cardId
    if (typeof o.sourceId === 'string') item.sourceId = o.sourceId
    if (typeof o.excerpt === 'string') item.excerpt = o.excerpt
    if (typeof o.ts === 'string' && o.ts.trim()) item.ts = o.ts
    if (typeof o.note === 'string' && o.note.trim()) item.note = o.note
    actions.push(item)
  }
  return { actions, explain: typeof obj.explain === 'string' ? obj.explain : undefined }
}

function applyActions(compilationId: string, actions: EditAction[]): { removedCards: number; addedCards: number; updatedCards: number } {
  let removedCards = 0
  let addedCards = 0
  let updatedCards = 0
  const toDelete: string[] = []
  const toAdd: { sourceId: string; excerpt: string; ts?: string; note?: string }[] = []
  for (const a of actions) {
    if (a.op === 'delete' && a.cardId) toDelete.push(a.cardId)
    else if (a.op === 'update' && a.cardId && a.excerpt) {
      const it = updateCompilationItem(a.cardId, { excerpt: a.excerpt, ts: a.ts ?? null, note: a.note ?? null })
      if (it) updatedCards += 1
    } else if (a.op === 'add' && a.excerpt) {
      toAdd.push({ sourceId: a.sourceId ?? '', excerpt: a.excerpt, ts: a.ts, note: a.note })
    }
  }
  if (toDelete.length > 0) {
    const res = deleteCompilationItemsByIds(toDelete)
    removedCards = res.deletedItems
  }
  if (toAdd.length > 0) {
    // 只接受候选来源存在的 sourceId；缺省 sourceId 的卡片以空来源插入（source_id 允许为空，便于溯源缺失时仍保留内容）
    const db = getDb()
    const valid = toAdd.filter((x) => !x.sourceId || db.prepare('SELECT 1 FROM sources WHERE id = ?').get(x.sourceId))
    insertCompilationItems(
      compilationId,
      valid.map((x) => ({ sourceId: x.sourceId || '', excerpt: x.excerpt, ts: x.ts, note: x.note }))
    )
    addedCards = valid.length
  }
  return { removedCards, addedCards, updatedCards }
}

/** 调整资料汇编：解析指令 → LLM 返回 editActions → 落库 → 返回最新汇编 */
export async function adjustCompilation(compilationId: string, instruction: string): Promise<AdjustCompilationResult> {
  const compilation = getCompilationById(compilationId)
  if (!compilation) return fail(ErrorCodes.TASK_NOT_FOUND, '资料汇编不存在')
  const req = await requestEditActions(instruction, compilation)
  if (!req.ok) return fail(ErrorCodes.LLM_UNAUTHORIZED, req.error)
  const { removedCards, addedCards, updatedCards } = applyActions(compilationId, req.actions)
  const latest = getCompilationById(compilationId)
  if (!latest) return fail(ErrorCodes.TASK_NOT_FOUND, '资料汇编不存在')
  return { ok: true, compilation: latest, explain: req.explain, removedCards, addedCards, updatedCards }
}
