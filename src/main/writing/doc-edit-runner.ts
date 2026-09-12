/**
 * doc-edit-runner.ts —— 把「与文档对话」跑通的主进程编排（Phase 7.5）。
 *
 * 流程：读取当前文档 → 构造 id 化提交物 → 调大模型 → 解析 `{reply, ops}` → 本地逐条校验 →
 * 应用 → **单事务落库（保留段 id）** → 记一个版本（origin='llm-edit'）→ 写对话记录 → 返回摘要。
 * 乐观锁：请求可带 `baseVersionNo`，与当前最新版本号不一致则拒绝（避免并发覆盖）。
 * 解析失败 / 无 Provider / 校验后一条都没应用 → **文档不变**，只回错误或说明。
 */
import { ErrorCodes } from '../../shared/types'
import { getSettings } from '../db/settings'
import { getProviderSecret } from '../llm/provider-store'
import { safeStorageCodec } from '../llm/secret'
import { chatCompletion } from '../llm/chat'
import { getSourceById } from '../db/sources'
import {
  getCompilationById,
  getLatestCompilationVersion,
  insertCompilationMessage,
  listCompilationSources,
  listCompilationMessages,
  snapshotCompilationVersion,
  upsertCompilationParagraphs
} from '../db/compilations'
import { logMain } from '../logger'
import { pushUndo } from './compilation-undo'
import {
  applyDocOps,
  buildDocEditMessages,
  collectDocEditChange,
  parseDocEditOutput,
  resolveTimeForEdit,
  validateDocOps,
  type DocEditParagraphRef
} from './doc-edit-service'

const DOC_EDIT_TIMEOUT_MS = 240000

export interface DocEditSummary {
  compilationId: string
  reply: string
  /** 实际应用的 op 数 */
  applied: number
  /** 被本地校验拒绝的 op 与原因（回给用户看） */
  rejected: { op: string; reason: string }[]
  versionNo?: number
  /** 本次改动的段 id（前端高亮 + 滚动到首个改动段） */
  changedIds: string[]
  changeSummary: { added: number; modified: number; removed: number }
}

export type DocEditResult =
  | { ok: true; summary: DocEditSummary }
  | { ok: false; error: { code: string; message: string } }

function resolveProvider(): { ok: true; provider: { apiBase: string; model: string; apiKey: string } } | { ok: false; error: { code: string; message: string } } {
  const settings = getSettings()
  const providerId = settings.compilationProviderId
  if (!providerId) return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '请先在设置中为「第 1 步」指定默认大模型' } }
  const provider = getProviderSecret(providerId, safeStorageCodec)
  if (!provider) return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '所选的 LLM Provider 不存在' } }
  if (!provider.apiKey) return { ok: false, error: { code: ErrorCodes.LLM_UNAUTHORIZED, message: '所选的 LLM Provider 未设置 API 密钥' } }
  return { ok: true, provider: { apiBase: provider.config.apiBase, model: provider.config.model, apiKey: provider.apiKey } }
}

/** 当前文档 → 提示词用的 id 化段落（`key` 为 p1、p2…；`id` 是数据库段 id） */
export function buildDocEditRefs(compilationId: string): DocEditParagraphRef[] {
  const comp = getCompilationById(compilationId)
  if (!comp) return []
  return comp.items
    .filter((it) => it.kept)
    .map((it, i) => ({
      key: 'p' + (i + 1),
      id: it.id,
      text: it.excerpt,
      timeLabel: it.ts,
      sourceOrdinal: it.sourceOrdinal,
      sourceTitle: it.sourceTitle
    }))
}

/** 来源编号 → 该来源原文（来源正文 + 该来源现有段落文本，用于"数字必须有据"的校验） */
export function buildSourceTextByOrdinal(compilationId: string, refs: DocEditParagraphRef[]): Map<number, string> {
  const map = new Map<number, string>()
  const sources = listCompilationSources(compilationId)
  for (const ref of sources) {
    if (!ref.sourceId) continue
    const source = getSourceById(ref.sourceId)
    const parts = [source?.cleanedText ?? '']
    for (const p of refs) if (p.sourceOrdinal === ref.ordinal) parts.push(p.text)
    map.set(ref.ordinal, parts.join('\n'))
  }
  return map
}

export async function runDocEdit(compilationId: string, instruction: string, baseVersionNo?: number): Promise<DocEditResult> {
  const text = (instruction ?? '').trim()
  if (!text) return { ok: false, error: { code: ErrorCodes.INVALID_PARAM, message: '请输入修改要求' } }
  const comp = getCompilationById(compilationId)
  if (!comp) return { ok: false, error: { code: ErrorCodes.TASK_NOT_FOUND, message: '资料汇编不存在' } }

  // 乐观锁：文档在用户输入期间被别的操作改过 → 拒绝，让用户重试（避免覆盖）
  const latest = getLatestCompilationVersion(compilationId)
  if (baseVersionNo != null && latest && latest.versionNo !== baseVersionNo) {
    return { ok: false, error: { code: 'VERSION_CONFLICT', message: '文档已被其它操作修改，请重新查看后再提出修改要求' } }
  }

  const prov = resolveProvider()
  if (!prov.ok) return { ok: false, error: prov.error }

  const refs = buildDocEditRefs(compilationId)
  if (refs.length === 0) return { ok: false, error: { code: ErrorCodes.INVALID_PARAM, message: '当前汇编没有可修改的段落' } }
  const sources = listCompilationSources(compilationId).map((s) => ({ ordinal: s.ordinal, title: s.title }))

  // 用户消息先落库（无论成功失败都留痕）
  insertCompilationMessage({ compilationId, role: 'user', content: text })

  const result = await chatCompletion(
    prov.provider,
    buildDocEditMessages(refs, text, sources),
    DOC_EDIT_TIMEOUT_MS,
    { kind: 'compilation-doc-edit', taskId: comp.taskId },
    { maxRetries: 0, temperature: 0 }
  )
  if (!result.ok) {
    const message = result.error?.message ?? '调用大模型失败'
    insertCompilationMessage({ compilationId, role: 'assistant', content: '修改失败：' + message })
    return { ok: false, error: { code: result.error?.code ?? ErrorCodes.LLM_TIMEOUT, message } }
  }
  const parsed = parseDocEditOutput(result.text)
  if (!parsed) {
    insertCompilationMessage({ compilationId, role: 'assistant', content: '大模型返回的修改格式无法解析，文档未改动。' })
    return { ok: false, error: { code: ErrorCodes.LLM_FORMAT_INVALID, message: '大模型返回的修改格式无法解析（文档未改动）' } }
  }

  const { accepted, rejected } = validateDocOps(parsed.ops, refs, buildSourceTextByOrdinal(compilationId, refs))
  if (accepted.length === 0) {
    // 一条都没应用 → 文档不变，把原因如实回给用户
    const why = rejected.length > 0 ? '（' + rejected.map((r) => r.op + '：' + r.reason).join('；') + '）' : ''
    const reply = (parsed.reply || '没有需要修改的内容。') + (why ? '\n未做任何改动：' + why : '')
    insertCompilationMessage({ compilationId, role: 'assistant', content: reply, rejected })
    return {
      ok: true,
      summary: { compilationId, reply, applied: 0, rejected, changedIds: [], changeSummary: { added: 0, modified: 0, removed: 0 } }
    }
  }

  // 应用 → 落库（保留段 id：原段沿用 id，新段由仓储分配）
  // 注意：必须**一次性**把全部段落交给 upsert——该函数会删除"不在入参里"的段落，
  // 因此来源 id 要在落库前解析好，不能事后逐条补写。
  //
  // 落库前登记撤销栈：对话编辑与「手动编辑/删除/矛盾取舍」必须一样可被「撤销操作」回退，
  // 否则撤销会跳过这次改动、直接回退到上一个 pushUndo 时的状态（2026-09-10 用户实测）。
  pushUndo(compilationId)
  const ordinalToSourceId = new Map(
    listCompilationSources(compilationId)
      .filter((s) => s.sourceId)
      .map((s) => [s.ordinal, s.sourceId as string])
  )
  const nextRefs = applyDocOps(refs, accepted)
  const change = collectDocEditChange(refs, nextRefs, accepted)
  const changedIds = new Set(change.changedIds)
  /** 未被本次改动触及的段落要**保留原有 origin/revision**，否则一次对话会把全篇都标成"对话修改" */
  const metaById = new Map(comp.items.map((it) => [it.id, { origin: it.origin, revision: it.revision }]))
  upsertCompilationParagraphs(
    compilationId,
    nextRefs.map((p) => {
      const time = resolveTimeForEdit(p.timeLabel, p.sourceTitle)
      const prev = metaById.get(p.id)
      const touched = changedIds.has(p.id)
      return {
        id: p.id || undefined,
        sourceId: (p.sourceOrdinal != null ? ordinalToSourceId.get(p.sourceOrdinal) : undefined) ?? '',
        sourceOrdinal: p.sourceOrdinal,
        text: p.text,
        timeLabel: p.timeLabel,
        year: time.year,
        month: time.month,
        day: time.day,
        timeConfidence: time.timeConfidence,
        origin: touched ? ('llm-edit' as const) : (prev?.origin ?? ('generate' as const)),
        revision: touched ? (prev?.revision ?? 0) + 1 : (prev?.revision ?? 1),
        kept: true
      }
    })
  )

  const version = snapshotCompilationVersion(compilationId, 'llm-edit', {
    instruction: text,
    reply: parsed.reply,
    baseVersionNo: latest?.versionNo
  })
  const applied = accepted.length
  const replyText =
    (parsed.reply || '已按要求修改。') +
    '\n（已修改 ' +
    applied +
    ' 处：新增 ' +
    change.added +
    ' 段 / 改写 ' +
    change.modified +
    ' 段 / 删除 ' +
    change.removed +
    ' 段）' +
    (rejected.length > 0 ? '\n有 ' + rejected.length + ' 项未执行：' + rejected.map((r) => r.reason).join('；') : '')
  insertCompilationMessage({
    compilationId,
    role: 'assistant',
    content: replyText,
    versionNo: version?.versionNo,
    applied: accepted.map((o) => o.op),
    rejected
  })
  logMain('compilation', '对话编辑完成 汇编=' + compilationId + ' 应用=' + applied + ' 拒绝=' + rejected.length)
  return {
    ok: true,
    summary: { compilationId, reply: replyText, applied, rejected, versionNo: version?.versionNo, changedIds: change.changedIds, changeSummary: { added: change.added, modified: change.modified, removed: change.removed } }
  }
}

/** 对话历史（悬浮对话框用） */
export function listDocMessages(compilationId: string): ReturnType<typeof listCompilationMessages> {
  return listCompilationMessages(compilationId)
}
