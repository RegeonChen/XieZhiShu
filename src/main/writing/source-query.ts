/**
 * source-query.ts —— 文段来源询问（Phase 3.7 Task 3.7.5）。
 * 选中正文文段 → 本地精确匹配优先 → 过滤式检索（词法 + 向量）兜底 → LLM 兜底（注入文件编号清单）。
 * 回复中引用来源编号（#N），前端按返回的 refs 渲染为可点击链接（sources:openPath 打开原文）。
 * 询问与回复经 task_messages 持久化，前端"自动发送到对话面板"后统一 reloadMessages。
 */
import type { RetrievedChunk, Source } from '../../shared/types'
import { ErrorCodes } from '../../shared/types'
import { getTaskById, resolveScopeSourceIds, getAllSourceIds } from '../db/tasks'
import { getSourceIdsByTag } from '../db/tags'
import { getSourcesByIds } from '../db/sources'
import { addTaskMessage } from '../db/task-messages'
import { getSettings } from '../db/settings'
import { getProviderSecret } from '../llm/provider-store'
import { safeStorageCodec } from '../llm/secret'
import { chatCompletion, type ChatMessage } from '../llm/chat'
import { retrieveChunks, bigrams } from '../rag/retrieval'
import { embedTexts } from '../rag/embed'
import { getDraftGenerationContext, getLatestDraftIdByTask } from '../db/draft-context'

/** LLM 兜底超时（提示词很小，但模型响应可能较慢） */
const SOURCE_QUERY_TIMEOUT_MS = 120000

/** 生成上下文溯源：注入的候选材料块上限（Top-N 取与选中文段最重叠的） */
const CONTEXT_TRACE_TOP_N = 10

/**
 * 按"选中文段 bigram 在材料块中的命中数"排序取 Top-N（纯函数、可测试）。
 * 生成时材料块很多，全部注入会稀释模型注意力；只保留与文段最可能同源的前 N 块。
 */
export function rankChunksByOverlap(selection: string, chunks: RetrievedChunk[]): RetrievedChunk[] {
  const sel = selection.trim()
  if (!sel || chunks.length === 0) return []
  const selBigrams = new Set(bigrams(sel))
  return [...chunks]
    .map((c) => ({ c, hits: bigrams(c.text).filter((b) => selBigrams.has(b)).length }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, CONTEXT_TRACE_TOP_N)
    .map((x) => x.c)
}

/**
 * 组装"生成上下文溯源"提示词（纯函数、可测试）：
 * 注入文件编号清单 + 选中文段 + 生成初稿时实际使用的候选材料块，让大模型判断文段源自哪些文件。
 */
export function buildContextTracePrompt(selection: string, topChunks: RetrievedChunk[]): ChatMessage[] {
  const refs: SourceRef[] = []
  const indexBySource = new Map<string, number>()
  for (const c of topChunks) {
    if (!indexBySource.has(c.sourceId)) {
      indexBySource.set(c.sourceId, refs.length + 1)
      refs.push({ index: refs.length + 1, sourceId: c.sourceId, title: c.sourceTitle, position: c.position })
    }
  }
  const fileList = refs.map((r) => `${r.index}. 《${r.title}》`).join('\n')
  const materials = topChunks
    .map((c, i) => `[${i + 1}]（来源 #${indexBySource.get(c.sourceId)}：《${c.sourceTitle}》，位置：${c.position}）\n${c.text}`)
    .join('\n\n')
  return [
    {
      role: 'system',
      content: '你是地方志资料的溯源助手。用户会提供一份【文件清单】（编号 + 标题）、一段【正文文段】以及【候选材料】（生成初稿时实际使用的检索材料，每块标注来源编号 #N）。请判断这段正文文段最可能源自候选材料中的哪些文件（用文件编号 #N 回答，可多个），并简要说明理由；若候选材料中找不到对应来源，请如实说明"无法从生成材料中确定来源"。'
    },
    {
      role: 'user',
      content: [
        '【文件清单】',
        fileList,
        '',
        '【正文文段】',
        `「${selection}」`,
        '',
        '【候选材料】',
        materials,
        '',
        '请用文件编号（如 #1、#2）回答这段文段最可能源自哪些文件，并简要说明理由。'
      ].join('\n')
    }
  ]
}

/**
 * 生成上下文溯源（LLM）：用初稿生成时实际使用的材料块让大模型判断文段来源。
 * 返回 null 表示"无可用的生成上下文或调用失败"——由调用方回退到检索兜底，不阻断询问。
 */
async function traceByGenerationContext(
  taskId: string,
  task: { llmProviderId?: string },
  selection: string,
  contextChunks: RetrievedChunk[]
): Promise<AskSourceResult | null> {
  const top = rankChunksByOverlap(selection, contextChunks)
  if (top.length === 0) return null
  const prov = resolveTaskProvider(task)
  if (!prov.ok) return null

  const messages = buildContextTracePrompt(selection, top)
  const result = await chatCompletion(prov.provider, messages, SOURCE_QUERY_TIMEOUT_MS, { kind: 'source-query', taskId })
  if (!result.ok) return null
  const text = result.text.trim()
  const reply = text || '未能确定这段文字的来源文件。'

  // 与候选材料编号对齐的 refs（供前端 #N 渲染为可点击链接）
  const refs: SourceRef[] = []
  const seen = new Set<string>()
  for (const c of top) {
    if (!seen.has(c.sourceId)) {
      seen.add(c.sourceId)
      refs.push({ index: refs.length + 1, sourceId: c.sourceId, title: c.sourceTitle, position: c.position })
    }
  }

  addTaskMessage(taskId, 'user', buildAskSourceQuestion(selection), 'chat')
  addTaskMessage(taskId, 'assistant', reply, 'chat')
  return { ok: true, reply, refs }
}

/** 选中文段截断上限（避免提示词过长） */
const SELECTION_MAX_CHARS = 300

export interface SourceRef {
  index: number
  sourceId: string
  title: string
  position?: string
}

export type AskSourceResult =
  | { ok: true; reply: string; refs: SourceRef[] }
  | { ok: false; error: { code: string; message: string } }

/** 组装"文段来源询问"的用户消息文本（含标签；持久化与展示共用） */
export function buildAskSourceQuestion(selection: string): string {
  return `【文段来源询问】\n请说明以下正文文段来源于资料库中的哪些文件：\n「${selection}」`
}

/**
 * 本地精确匹配（纯函数、可测试）：在资料的清洗正文中查找文段逐字出现的位置。
 * 命中按资料顺序返回（含段落位置"第 N 段"）；未命中返回空数组。
 */
export function findExactSourceMatches(
  sources: Pick<Source, 'id' | 'title' | 'cleanedText'>[],
  selection: string
): { sourceId: string; title: string; position: string }[] {
  const sel = selection.trim()
  if (!sel || sources.length === 0) return []
  const hits: { sourceId: string; title: string; position: string }[] = []
  for (const s of sources) {
    const idx = s.cleanedText.indexOf(sel)
    if (idx >= 0) {
      // 命中前已完结的段落数 + 1（未完结片段不计段）
      const paragraph = (s.cleanedText.slice(0, idx).match(/\n{2,}/g) ?? []).length + 1
      hits.push({ sourceId: s.id, title: s.title, position: `第 ${paragraph} 段` })
    }
  }
  return hits
}

/** 组装"本地精确命中"回复（来源编号 #N 与 refs 对应） */
export function buildLocalHitReply(hits: { sourceId: string; title: string; position: string }[]): string {
  const lines = hits.map((h, i) => `- 来源 #${i + 1}：《${h.title}》（${h.position}）`)
  return `经本地检索，这段文字与以下资料直接匹配：\n${lines.join('\n')}`
}

/**
 * 组装"过滤式检索兜底"回复与 refs（按来源去重编号）。
 * 回复与 refs 对齐：同一来源多片段时 #N 指向首个出现的来源。
 */
export function buildChunkReply(chunks: RetrievedChunk[]): { reply: string; refs: SourceRef[] } {
  const refs: SourceRef[] = []
  const indexBySource = new Map<string, number>()
  const lines: string[] = []
  for (const c of chunks) {
    let index = indexBySource.get(c.sourceId)
    if (index === undefined) {
      index = refs.length + 1
      indexBySource.set(c.sourceId, index)
      refs.push({ index, sourceId: c.sourceId, title: c.sourceTitle, position: c.position })
    }
    lines.push(`- 来源 #${index}：《${c.sourceTitle}》（${c.position}）`)
  }
  return { reply: `未找到逐字匹配，以下为检索到的最相关片段：\n${lines.join('\n')}`, refs }
}

/** 任务使用的大模型（任务固定 provider 优先，回退全局当前） */
function resolveTaskProvider(task: { llmProviderId?: string }):
  | { ok: true; provider: { apiBase: string; model: string; apiKey: string } }
  | { ok: false; error: { code: string; message: string } } {
  const settings = getSettings()
  const providerId = task.llmProviderId ?? settings.currentLlmProviderId
  if (!providerId) return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '请先在设置中配置并选择 LLM Provider' } }
  const provider = getProviderSecret(providerId, safeStorageCodec)
  if (!provider) return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '所选的 LLM Provider 不存在' } }
  if (!provider.apiKey) return { ok: false, error: { code: ErrorCodes.LLM_UNAUTHORIZED, message: '所选的 LLM Provider 未设置 API 密钥' } }
  return { ok: true, provider: { apiBase: provider.config.apiBase, model: provider.config.model, apiKey: provider.apiKey } }
}

/** LLM 兜底：注入任务范围文件编号清单，让大模型判断文段最可能源自哪些文件 */
async function llmFallback(taskId: string, selection: string, refList: SourceRef[]): Promise<string> {
  const task = getTaskById(taskId)
  if (!task) throw new Error('撰写任务不存在')
  const prov = resolveTaskProvider(task)
  if (!prov.ok) throw new Error(prov.error.message)

  const fileList = refList.map((r) => `${r.index}. 《${r.title}》`).join('\n')
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: '你是地方志资料的溯源助手。用户会提供一份【文件清单】（编号 + 标题）与一段【正文文段】。请判断这段文段最可能源自清单中的哪些文件（可多个，用文件编号 #N 回答），并简要说明理由；若无法判断，请如实说明"无法判断来源"。'
    },
    {
      role: 'user',
      content: `【文件清单】\n${fileList}\n\n【正文文段】\n「${selection}」\n\n请用文件编号（如 #1、#2）回答这段文段最可能源自哪些文件。`
    }
  ]
  const result = await chatCompletion(prov.provider, messages, SOURCE_QUERY_TIMEOUT_MS, { kind: 'source-query', taskId })
  if (!result.ok) throw new Error(result.error.message)
  const text = result.text.trim()
  return text || '未能确定这段文字的来源文件。'
}

/**
 * 文段来源询问主入口：本地精确匹配 → 过滤式检索 → LLM 兜底。
 * 询问（用户消息，带"文段来源询问"标签）与回复（assistant 消息）均由主进程写入 task_messages。
 */
export async function askSourceForTask(taskId: string, selection: string): Promise<AskSourceResult> {
  const task = getTaskById(taskId)
  if (!task) return { ok: false, error: { code: ErrorCodes.TASK_NOT_FOUND, message: '撰写任务不存在' } }
  const sel = selection.trim().slice(0, SELECTION_MAX_CHARS)
  if (!sel) return { ok: false, error: { code: ErrorCodes.INVALID_PARAM, message: '请先选中正文文段' } }

  const scopeIds = resolveScopeSourceIds(task, { getSourceIdsByTag, getAllSourceIds })
  if (scopeIds.length === 0) return { ok: false, error: { code: ErrorCodes.TASK_NO_SCOPE, message: '资料库中没有可用资料' } }
  const sources = getSourcesByIds(scopeIds)

  // 1. 本地精确匹配（整段逐字命中 → 秒回且来源必可点击）
  const exact = findExactSourceMatches(sources, sel)
  if (exact.length > 0) {
    const refs: SourceRef[] = exact.map((h, i) => ({ index: i + 1, sourceId: h.sourceId, title: h.title, position: h.position }))
    const reply = buildLocalHitReply(exact)
    addTaskMessage(taskId, 'user', buildAskSourceQuestion(sel), 'chat')
    addTaskMessage(taskId, 'assistant', reply, 'chat')
    return { ok: true, reply, refs }
  }

  // 2. 生成上下文溯源（2026-08-11）：未逐字命中时，用"生成初稿时实际使用的检索材料"让大模型判断
  //    文段源自哪些文件（正文可能经大模型改写，逐字匹配找不到，但同源材料仍可推断）。
  //    失败（无上下文 / LLM 异常）则回退到检索兜底，不阻断询问。
  const latestDraftId = getLatestDraftIdByTask(taskId)
  if (latestDraftId) {
    const contextChunks = getDraftGenerationContext(latestDraftId)
    if (contextChunks.length > 0) {
      const traced = await traceByGenerationContext(taskId, task, sel, contextChunks)
      if (traced && traced.ok) return traced
    }
  }

  // 3. 过滤式检索兜底（词法 + 向量，只保留相关片段）
  const vectors = await embedTexts([sel]).catch(() => null)
  const queryVector = vectors ? vectors[0] : undefined
  const chunks = retrieveChunks({ sourceIds: scopeIds, query: sel, queryVector })
  if (chunks.length > 0) {
    const { reply, refs } = buildChunkReply(chunks.slice(0, 5))
    addTaskMessage(taskId, 'user', buildAskSourceQuestion(sel), 'chat')
    addTaskMessage(taskId, 'assistant', reply, 'chat')
    return { ok: true, reply, refs }
  }

  // 4. LLM 兜底（注入文件编号清单）
  const refList: SourceRef[] = sources.map((s, i) => ({ index: i + 1, sourceId: s.id, title: s.title }))
  try {
    const reply = await llmFallback(taskId, sel, refList)
    addTaskMessage(taskId, 'user', buildAskSourceQuestion(sel), 'chat')
    addTaskMessage(taskId, 'assistant', reply, 'chat')
    return { ok: true, reply, refs: refList }
  } catch (err) {
    return { ok: false, error: { code: ErrorCodes.LLM_PROVIDER_ERROR, message: `来源查询失败：${(err as Error).message}` } }
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('source query utils (Phase 3.7.5)', () => {
    const sources = [
      { id: 's1', title: '年度报告A', cleanedText: '2022年全县小学在校生人数为3.2万人。\n\n次年略有增长。' },
      { id: 's2', title: '统计年鉴B', cleanedText: '全县适龄儿童入学率保持在百分之九十九以上。' }
    ]

    it('builds the ask-source question with a label tag', () => {
      const q = buildAskSourceQuestion('全县小学在校生人数为3.2万人')
      expect(q).toContain('【文段来源询问】')
      expect(q).toContain('全县小学在校生人数为3.2万人')
    })

    it('finds exact matches with paragraph position across multiple sources', () => {
      const hits = findExactSourceMatches(sources, '在校生人数为3.2万人')
      expect(hits).toHaveLength(1)
      expect(hits[0]).toEqual({ sourceId: 's1', title: '年度报告A', position: '第 1 段' })
      // 未命中 / 空文段 → 空数组
      expect(findExactSourceMatches(sources, '不存在的段落')).toEqual([])
      expect(findExactSourceMatches(sources, '  ')).toEqual([])
    })

    it('builds local hit reply with numbered refs', () => {
      const hits = findExactSourceMatches(sources, '入学率')
      const reply = buildLocalHitReply(hits)
      expect(reply).toContain('来源 #1')
      expect(reply).toContain('《统计年鉴B》')
    })

    it('builds chunk reply with deduped source refs aligned to #N', () => {
      const chunks: RetrievedChunk[] = [
        { sourceId: 's1', sourceTitle: '年度报告A', position: '第1段', text: 'a', score: 8 },
        { sourceId: 's1', sourceTitle: '年度报告A', position: '第2段', text: 'b', score: 6 },
        { sourceId: 's2', sourceTitle: '统计年鉴B', position: '第3段', text: 'c', score: 5 }
      ]
      const { reply, refs } = buildChunkReply(chunks)
      expect(refs).toEqual([
        { index: 1, sourceId: 's1', title: '年度报告A', position: '第1段' },
        { index: 2, sourceId: 's2', title: '统计年鉴B', position: '第3段' }
      ])
      // 同一来源多片段都指向同一编号
      expect(reply).toContain('来源 #1：《年度报告A》（第1段）')
      expect(reply).toContain('来源 #1：《年度报告A》（第2段）')
      expect(reply).toContain('来源 #2：《统计年鉴B》（第3段）')
    })

    it('ranks generation context chunks by overlap with the selection', () => {
      const chunks: RetrievedChunk[] = [
        { sourceId: 's1', sourceTitle: '报告A', position: '第1段', text: '2021年全区共有幼儿园28所。', score: 9 },
        { sourceId: 's2', sourceTitle: '年鉴B', position: '第2段', text: '民办园66所。', score: 7 },
        { sourceId: 's3', sourceTitle: '纪要C', position: '第3段', text: '台湾事务与两岸交流。', score: 6 }
      ]
      const top = rankChunksByOverlap('全区共有幼儿园28所，在园幼儿两万余人', chunks)
      expect(top.length).toBeGreaterThan(0)
      expect(top[0].sourceId).toBe('s1')
      // 无关材料（无重叠）被排在后面
      expect(top[top.length - 1].sourceId).toBe('s3')
      // 空文段 / 空列表 → 空
      expect(rankChunksByOverlap('  ', chunks)).toEqual([])
      expect(rankChunksByOverlap('有内容', [])).toEqual([])
    })

    it('builds context trace prompt with file list, selection and numbered materials', () => {
      const chunks: RetrievedChunk[] = [
        { sourceId: 's1', sourceTitle: '报告A', position: '第1段', text: '2021年全区共有幼儿园28所。', score: 9 },
        { sourceId: 's1', sourceTitle: '报告A', position: '第2段', text: '在园幼儿两万余人。', score: 8 },
        { sourceId: 's2', sourceTitle: '年鉴B', position: '第3段', text: '民办园66所。', score: 7 }
      ]
      const msgs = buildContextTracePrompt('全区共有幼儿园28所', chunks)
      expect(msgs[0].content).toContain('溯源助手')
      const user = msgs[1].content
      expect(user).toContain('【文件清单】')
      expect(user).toContain('1. 《报告A》')
      expect(user).toContain('2. 《年鉴B》')
      expect(user).toContain('【候选材料】')
      expect(user).toContain('（来源 #1：《报告A》，位置：第1段）')
      // 同一来源两块共享编号 #1
      expect(user).toContain('（来源 #1：《报告A》，位置：第2段）')
      expect(user).toContain('（来源 #2：《年鉴B》，位置：第3段）')
    })
  })
}
