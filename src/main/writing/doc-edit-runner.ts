/**
 * doc-edit-runner.ts —— 把「与文档对话」跑通的主进程编排（Phase 7.5）。
 *
 * 流程：读取当前文档 → 构造 id 化提交物 → 调大模型 → 解析 `{reply, ops}` → 本地逐条校验 →
 * 应用 → **单事务落库（保留段 id）** → 记一个版本（origin='llm-edit'）→ 写对话记录 → 返回摘要。
 * 乐观锁：请求可带 `baseVersionNo`，与当前最新版本号不一致则拒绝（避免并发覆盖）。
 * 解析失败 / 无 Provider / 校验后一条都没应用 → **文档不变**，只回错误或说明。
 */
import { ErrorCodes, type CompilationParagraph } from '../../shared/types'
import { getSettings } from '../db/settings'
import { getProviderSecret } from '../llm/provider-store'
import { safeStorageCodec } from '../llm/secret'
import { chatCompletion } from '../llm/chat'
import { getSourceById, getSourcesByIds } from '../db/sources'
import {
  dedupeSourceIds,
  ensureCompilationSources,
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
import { buildParagraphSnapshot, sortParagraphsByTime } from './compilation-document'
import { diffParagraphVersions, summarizeParagraphDiff, type ParagraphDiffSegment } from './compilation-diff'
import { getTaskById, resolveScopeSourceIds, getAllSourceIds } from '../db/tasks'
import { getSourceIdsByTag } from '../db/tags'
import { listPinnedWebMaterials } from '../db/web-materials'
import { attachAnchorsQuietly } from './source-anchors'
import type { CatalogSource } from './catalog'
import { navigateSources, type NavOutcome } from './source-navigator'
import { needsLibraryLookup, type LeakCandidate, type LeakSearchOutcome, type LeakSearchState } from './leak-candidates'
import {
  applyDocOps,
  buildDocEditMessages,
  collectDocEditChange,
  parseDocEditOutput,
  resolveTimeForEdit,
  validateDocOps,
  type DocEditParagraphRef,
  type DocEditParsed
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
  /** 本次改动的段 id（前端滚动到首个改动段） */
  changedIds: string[]
  changeSummary: { added: number; modified: number; removed: number }
  /** 本次修改前后的差异（前端据此自动进入对比模式，让用户「采纳 / 回退」） */
  diff: { segments: ParagraphDiffSegment[]; summary: { added: number; removed: number; modified: number; unchanged: number } }
  /** 补漏（B 方案）：本地检索到的候选原文条数 */
  candidates: number
  /** 补漏检索状态（skipped = 本条要求不需要检索） */
  leakState: LeakSearchState
  /** 本次新增段落里"逐字取自候选原文"的条数 */
  addedFromCandidates: number
}

export type DocEditResult =
  | { ok: true; summary: DocEditSummary }
  | { ok: false; error: { code: string; message: string } }

/**
 * 导航范围：**该任务能看到的全部资料**（2026-10-03 实测修正，仍是三者的并集）：
 *  ① 任务范围（`resolveScopeSourceIds` → 全部**长期资料**，`sources.task_id IS NULL`）；
 *  ② **本汇编已引用的来源**；
 *  ③ **本任务锁定的网页材料**——生成时锁定 300 篇、实际只用了 30 篇是常态。
 *
 * 注意：这里**不做任何相关性筛选**（2026-10-03 用户裁定：完全由大模型决策看哪里）——
 * 只是把范围里的来源连同标题/年份/正文交给 `navigateSources`，由模型自己挑。
 */
export function listNavigableSources(taskId: string, compilationId: string): CatalogSource[] {
  const task = getTaskById(taskId)
  if (!task) return []
  const scopeIds = resolveScopeSourceIds(task, { getSourceIdsByTag, getAllSourceIds })
  const compSourceIds = listCompilationSources(compilationId)
    .map((s) => s.sourceId)
    .filter((id): id is string => !!id)
  const pinnedIds = listPinnedWebMaterials(taskId).map((m) => m.sourceId)
  const ids = Array.from(new Set([...scopeIds, ...compSourceIds, ...pinnedIds]))
  if (ids.length === 0) return []
  const out: CatalogSource[] = []
  for (const s of getSourcesByIds(ids)) {
    // 正文缺失（老文章失效/模板页，Migration 041 已标记）→ 不进目录：它没有可用正文
    if (s.bodyMissing) continue
    if (!s.cleanedText || !s.cleanedText.trim()) continue
    out.push({ id: s.id, title: s.title, kind: s.kind, publishedAt: s.publishedAt, cleanedText: s.cleanedText })
  }
  // 文件类（年鉴等权威资料）排前，方便模型先看它们
  out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'file' ? -1 : 1))
  logMain('compilation', '资料导航范围：' + out.length + ' 个来源（长期=' + scopeIds.length + ' 汇编内=' + compSourceIds.length + ' 网页锁定=' + pinnedIds.length + '）')
  return out
}

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
      sourceTitle: it.sourceTitle,
      /* Phase 9 来源定位：证据引文必须随编辑写回（漏掉它会让全篇 evidence 变 NULL） */
      evidence: it.evidence,
      alsoSourceOrdinals: it.alsoSourceOrdinals,
      alsoSourceIds: it.alsoSourceIds
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

/** 读取当前文档的段落快照（用于算"本次修改前后"的差异，与版本快照同形状） */
function readParagraphSnapshot(compilationId: string): CompilationParagraph[] {
  const comp = getCompilationById(compilationId)
  if (!comp) return []
  const refs = new Map(
    listCompilationSources(compilationId)
      .filter((s) => s.sourceId)
      .map((s) => [s.sourceId as string, s])
  )
  return buildParagraphSnapshot(
    comp.items.filter((it) => it.kept),
    refs
  )
}

/**
 * 把"这次去资料库做了什么"如实写进回复（**检索路径透明化**，2026-10-03 用户裁定）：
 * 用户看得到模型挑了哪几份资料、哪几节、读了多少原文，而不是只看到一句结论或"做不到"。
 */
function navNote(nav: NavOutcome, addedFromCandidates: number): string {
  if (nav.state === 'failed') return '\n（本轮资料库导航未完成：' + (nav.message ?? '未知原因') + '，未附资料库原文）'
  if (nav.candidates.length === 0) {
    return nav.pickedSources.length > 0
      ? '\n（资料库导航：模型选了 ' + nav.pickedSources.length + ' 份资料，但没有挑出可读的小节，因此未附原文）'
      : '\n（资料库导航：模型没有选出资料，因此未附原文）'
  }
  const srcList = nav.pickedSources.slice(0, 6).join('、') + (nav.pickedSources.length > 6 ? ' 等' : '')
  return (
    '\n（资料库导航：先看全部来源清单 → 选中 ' +
    nav.pickedSources.length +
    ' 份（' +
    srcList +
    '）；再按小节标题挑了 ' +
    nav.candidates.length +
    ' 节，读入原文 ' +
    nav.readChars +
    ' 字' +
    (addedFromCandidates > 0 ? '；新增 ' + addedFromCandidates + ' 段内容逐字取自这些原文' : '') +
    '）'
  )
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

  /*
   * 资料库导航（2026-10-03 用户裁定：**完全依赖大模型自主决策**）：
   * 旧链路只在"漏了/补充"这类措辞下检索，且用的是本地词法+向量块召回——实测那次 12 条候选里
   * **0 条**含答案句（用户实测反馈："只基于已生成的资料汇编回复"）。
   * 现在：闸门扩展到"问句/要求细化"，命中后走 `navigateSources`（R1 挑资料 → R2/R3 挑章节 → 读正文），
   * 全程由大模型决定看哪里，本地只搬目录与正文，不做任何相关性判断。
   */
  let nav: NavOutcome = needsLibraryLookup(text)
    ? await navigateSources({
        provider: prov.provider,
        taskId: comp.taskId,
        question: text,
        requirement: comp.title,
        sources: listNavigableSources(comp.taskId, compilationId)
      })
    : { candidates: [], rounds: [], pickedSources: [], pickedSections: [], readChars: 0, state: 'empty' }
  let leak: LeakSearchOutcome = {
    candidates: nav.candidates,
    state: nav.candidates.length > 0 ? 'ok' : nav.state === 'failed' ? 'failed' : 'empty',
    scanned: nav.readChars
  }

  // 用户消息先落库（无论成功失败都留痕）
  insertCompilationMessage({ compilationId, role: 'user', content: text })

  const askModel = async (candidates: LeakCandidate[]): Promise<{ ok: true; parsed: DocEditParsed } | { ok: false; message: string; code: string }> => {
    const r = await chatCompletion(
      prov.provider,
      buildDocEditMessages(refs, text, sources, { requirement: comp.title, candidates }),
      DOC_EDIT_TIMEOUT_MS,
      { kind: 'compilation-doc-edit', taskId: comp.taskId },
      { maxRetries: 0, temperature: 0 }
    )
    if (!r.ok) return { ok: false, message: r.error?.message ?? '调用大模型失败', code: r.error?.code ?? ErrorCodes.LLM_TIMEOUT }
    const p = parseDocEditOutput(r.text)
    if (!p) return { ok: false, message: '大模型返回的修改格式无法解析（文档未改动）', code: ErrorCodes.LLM_FORMAT_INVALID }
    return { ok: true, parsed: p }
  }

  let first = await askModel(leak.candidates)
  if (!first.ok) {
    insertCompilationMessage({ compilationId, role: 'assistant', content: '修改失败：' + first.message })
    return { ok: false, error: { code: first.code, message: first.message } }
  }

  /*
   * 模型**主动申请查资料库**（2026-10-03 新增）：闸门只按措辞猜（问句/细节词/漏了），
   * 纯名词短语（如"长乐一中省一级达标情况"）可能猜不到。这里给模型一条自陈通道：
   * 它判断"必须看资料库原文"时输出 `{"op":"needLibrary","query":"…"}`，软件据此跑一轮导航并**重问一次**。
   * 上限 1 次——只有第一次回答且本轮尚未导航过时才响应，避免来回烧调用。
   */
  let parsed = first.parsed
  const asked = parsed.ops.find((o) => o.op === 'needLibrary')
  if (asked && nav.candidates.length === 0) {
    nav = await navigateSources({
      provider: prov.provider,
      taskId: comp.taskId,
      question: (asked.query ?? '').trim() || text,
      requirement: comp.title,
      sources: listNavigableSources(comp.taskId, compilationId)
    })
    leak = {
      candidates: nav.candidates,
      state: nav.candidates.length > 0 ? 'ok' : nav.state === 'failed' ? 'failed' : 'empty',
      scanned: nav.readChars
    }
    const second = await askModel(leak.candidates)
    if (second.ok) parsed = second.parsed
    logMain('compilation', '模型申请查资料库 → 导航候选 ' + leak.candidates.length + ' 段，重问' + (second.ok ? '成功' : '失败'))
  }
  // needLibrary 由上面处理；留在 ops 里会让校验报"不支持的操作类型"
  const ops = parsed.ops.filter((o) => o.op !== 'needLibrary')

  const { accepted, rejected } = validateDocOps(ops, refs, buildSourceTextByOrdinal(compilationId, refs), leak.candidates)
  if (accepted.length === 0) {
    // 一条都没应用 → 文档不变，把原因如实回给用户
    const why = rejected.length > 0 ? '（' + rejected.map((r) => r.op + '：' + r.reason).join('；') + '）' : ''
    const reply = (parsed.reply || '没有需要修改的内容。') + navNote(nav, 0) + (why ? '\n未做任何改动：' + why : '')
    insertCompilationMessage({ compilationId, role: 'assistant', content: reply, rejected })
    return {
      ok: true,
      summary: {
        compilationId,
        reply,
        applied: 0,
        rejected,
        changedIds: [],
        changeSummary: { added: 0, modified: 0, removed: 0 },
        diff: { segments: [], summary: { added: 0, removed: 0, modified: 0, unchanged: 0 } },
        candidates: leak.candidates.length,
        leakState: leak.state,
        addedFromCandidates: 0
      }
    }
  }

  /*
   * 补漏候选的来源可能**还不在本汇编的编号表里**（这正是"漏了"的典型形态）：
   * 先登记拿到编号（编号表只增不回收），再让 applyDocOps 用这个编号落库。
   * 必须在 `ordinalToSourceId` 之前做，否则并列来源/圆标编号会对不上。
   */
  const candByKey = new Map(leak.candidates.map((c) => [c.key, c]))
  const usedCandidates = accepted
    .filter((o) => o.op === 'insertAfter' && !!o.candidateKey)
    .map((o) => candByKey.get(o.candidateKey as string))
    .filter((c): c is LeakCandidate => !!c)
  if (usedCandidates.length > 0) {
    const ordered: { sourceId: string; title: string }[] = []
    for (const c of usedCandidates) {
      if (!ordered.some((o) => o.sourceId === c.sourceId)) ordered.push({ sourceId: c.sourceId, title: c.sourceTitle })
    }
    const refsAfter = ensureCompilationSources(compilationId, ordered)
    const ordinalBySourceId = new Map(refsAfter.filter((s) => s.sourceId).map((s) => [s.sourceId as string, s.ordinal]))
    for (const op of accepted) {
      if (op.op !== 'insertAfter' || !op.candidateKey) continue
      const c = candByKey.get(op.candidateKey)
      const ordinal = c ? ordinalBySourceId.get(c.sourceId) : undefined
      if (ordinal != null) op.sourceOrdinal = ordinal
    }
  }

  // 应用 → 落库（保留段 id：原段沿用 id，新段由仓储分配）
  // 注意：必须**一次性**把全部段落交给 upsert——该函数会删除"不在入参里"的段落，
  // 因此来源 id 要在落库前解析好，不能事后逐条补写。
  //
  // 落库前登记撤销栈：对话编辑是**唯一**会动汇编内容的入口（人工修改模式已按用户新需求删除），
  // 因此撤销栈只由这里登记、也只回退这里产生的改动。
  const before = readParagraphSnapshot(compilationId)
  pushUndo(compilationId)
  const ordinalToSourceId = new Map(
    listCompilationSources(compilationId)
      .filter((s) => s.sourceId)
      .map((s) => [s.ordinal, s.sourceId as string])
  )
  /** 段首时间兜底要按来源区分依据（年鉴 −1 / 网页标题年份 / 网页发布时间） */
  const sourceMetaByOrdinal = new Map(
    listCompilationSources(compilationId)
      .filter((s) => s.sourceId)
      .map((s) => {
        const src = getSourceById(s.sourceId as string)
        return [s.ordinal, { kind: src?.kind, publishedAt: src?.publishedAt }] as const
      })
  )
  const metaOf = (ordinal?: number): { kind?: 'file' | 'url'; publishedAt?: string } =>
    (ordinal != null ? sourceMetaByOrdinal.get(ordinal) : undefined) ?? {}
  let nextRefs = applyDocOps(refs, accepted)
  /*
   * 时间被改动（或插入了新段）→ **同一次操作内**按时间重排，否则文档会静默违反"按时间排序"。
   * 人工修改模式删除后，对话是唯一能改时间的入口，所以这套排序必须挂在这里。
   * 只在"时间真的变了"时才排：纯 `move`（用户明确要求调序）不能被排序覆盖掉。
   */
  const prevTimeById = new Map(refs.map((r) => [r.id, r.timeLabel]))
  const timeTouched =
    nextRefs.some((p) => !prevTimeById.has(p.id)) || nextRefs.some((p) => prevTimeById.has(p.id) && prevTimeById.get(p.id) !== p.timeLabel)
  if (timeTouched) {
    nextRefs = sortParagraphsByTime(
      nextRefs.map((p, i) => {
        const t = resolveTimeForEdit(p.timeLabel, p.sourceTitle, metaOf(p.sourceOrdinal))
        return { p, ordinal: i, year: t.year, month: t.month, sourceOrdinal: p.sourceOrdinal }
      })
    ).map((x) => x.p)
  }
  const change = collectDocEditChange(refs, nextRefs, accepted)
  const changedIds = new Set(change.changedIds)
  /** 未被本次改动触及的段落要**保留原有 origin/revision**，否则一次对话会把全篇都标成"对话修改" */
  const metaById = new Map(comp.items.map((it) => [it.id, { origin: it.origin, revision: it.revision }]))
  const persisted = upsertCompilationParagraphs(
    compilationId,
    nextRefs.map((p) => {
      const time = resolveTimeForEdit(p.timeLabel, p.sourceTitle, metaOf(p.sourceOrdinal))
      const prev = metaById.get(p.id)
      const touched = changedIds.has(p.id)
      return {
        id: p.id || undefined,
        sourceId: (p.sourceOrdinal != null ? ordinalToSourceId.get(p.sourceOrdinal) : undefined) ?? '',
        /* Phase 7.12：并列来源要随对话编辑一起写回，否则**任何一次对话修改都会把"另一个出处"抹掉**。
           优先用编号反查（文档层以编号为准），拿不到再用快照里带的 id 兜底。 */
        alsoSourceIds: dedupeSourceIds([
          ...(p.alsoSourceOrdinals ?? []).map((n) => ordinalToSourceId.get(n)),
          ...(p.alsoSourceIds ?? [])
        ]),
        sourceOrdinal: p.sourceOrdinal,
        text: p.text,
        timeLabel: p.timeLabel,
        /* Phase 9：证据引文随编辑写回（`applyDocOps` 已按"正文是否改动"决定保留/清空） */
        evidence: p.evidence,
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
  /*
   * 来源锚点（Phase 9 / S3）在**生成期**算，对话编辑这里原来没有补——于是**对话新增的卡片没有页码锚点**，
   * 点圆标会提示"未记录来源位置"（与 9.15 那个"刚生成完点不到页"是同一类缺口）。
   * 这里等它完成（实测整份汇编约 2 秒；锚点失败绝不影响本次编辑，`attachAnchorsQuietly` 内吞异常）。
   */
  if (change.added > 0 || changedIds.size > 0) {
    await attachAnchorsQuietly(
      persisted.map((it) => ({
        id: it.id,
        sourceId: it.sourceId,
        excerpt: it.excerpt,
        evidence: it.evidence
      }))
    )
  }

  const version = snapshotCompilationVersion(compilationId, 'llm-edit', {
    instruction: text,
    reply: parsed.reply,
    baseVersionNo: latest?.versionNo
  })
  const applied = accepted.length
  const addedFromCandidates = accepted.filter((o) => o.op === 'insertAfter' && !!o.candidateKey).length
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
    navNote(nav, addedFromCandidates) +
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
  // 「本次修改前后」的差异：直接比对改前快照与改后快照（读库），供前端自动进入对比模式
  const after = readParagraphSnapshot(compilationId)
  const segments = diffParagraphVersions(before, after)
  return {
    ok: true,
    summary: {
      compilationId,
      reply: replyText,
      applied,
      rejected,
      versionNo: version?.versionNo,
      changedIds: change.changedIds,
      changeSummary: { added: change.added, modified: change.modified, removed: change.removed },
      diff: { segments, summary: summarizeParagraphDiff(segments) },
      candidates: leak.candidates.length,
      leakState: leak.state,
      addedFromCandidates
    }
  }
}

/** 对话历史（悬浮对话框用） */
export function listDocMessages(compilationId: string): ReturnType<typeof listCompilationMessages> {
  return listCompilationMessages(compilationId)
}

export interface ExcludeItemsResult {
  ok: boolean
  /** 实际移出的段数 */
  excluded: number
  /** 说明（界面直接显示） */
  message: string
  error?: { code: string; message: string }
}

/**
 * 「疑似超出范围」的**移出汇编**（Phase 9 补充，2026-10-03 用户裁定「界面兜底」）。
 *
 * 移出 = 把段落标记为 `kept = false`（**不删数据**）：文档视图、导出、版本快照、对话编辑的提交物
 * 全都按 `kept` 过滤，所以效果与删除一致，但
 * ① 可撤销（登记撤销栈，与对话编辑同一套）、② 有版本记录（origin='user-edit'）、
 * ③ **不会级联删掉矛盾说法**（`compilation_contradiction_variants.item_id` 是 ON DELETE CASCADE，
 * 真删段落会把"这个说法的出处"整行带走）。
 */
export function excludeCompilationItems(compilationId: string, itemIds: string[]): ExcludeItemsResult {
  const comp = getCompilationById(compilationId)
  if (!comp) return { ok: false, excluded: 0, message: '', error: { code: 'TASK_NOT_FOUND', message: '资料汇编不存在' } }
  const target = new Set(itemIds.filter(Boolean))
  if (target.size === 0) return { ok: false, excluded: 0, message: '', error: { code: ErrorCodes.INVALID_PARAM, message: '没有指定要移出的段落' } }
  const hit = comp.items.filter((it) => it.kept && target.has(it.id))
  if (hit.length === 0) {
    return { ok: false, excluded: 0, message: '', error: { code: ErrorCodes.INVALID_PARAM, message: '要移出的段落已不在汇编中' } }
  }

  // 与对话编辑同一套：先登记撤销栈，再整体覆盖写入（`upsertCompilationParagraphs` 会删掉"不在入参里"的段，
  // 因此必须把**全部**段落的现有字段原样带上，只改目标段的 kept）
  pushUndo(compilationId)
  upsertCompilationParagraphs(
    compilationId,
    comp.items.map((it) => ({
      id: it.id,
      sourceId: it.sourceId,
      alsoSourceIds: it.alsoSourceIds,
      text: it.excerpt,
      timeLabel: it.ts,
      year: it.year,
      month: it.month,
      day: it.day,
      timeConfidence: it.timeConfidence,
      sourceOrdinal: it.sourceOrdinal,
      evidence: it.evidence,
      origin: it.origin,
      revision: it.revision,
      kind: it.kind,
      kept: target.has(it.id) ? false : it.kept
    }))
  )
  const version = snapshotCompilationVersion(compilationId, 'user-edit', { instruction: '按范围复核移出 ' + hit.length + ' 段' })
  logMain('compilation', '关系复核移出 汇编=' + compilationId + ' 段数=' + hit.length + ' 版本=' + (version?.versionNo ?? '-'))
  return { ok: true, excluded: hit.length, message: '已移出 ' + hit.length + ' 段（可撤销）' }
}
