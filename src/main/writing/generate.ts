/**
 * generate.ts —— 初稿生成（第 0 稿）：检索 → 提示词 → LLM → JSON 解析校验 → 落库。
 * 只依据任务范围内的本地资料；输出按片段组织并标注来源（sourceId + position）。
 */
import type { Draft, RetrievedChunk } from '../../shared/types'
import { ErrorCodes } from '../../shared/types'
import { getTaskById, resolveScopeSourceIds } from '../db/tasks'
import { getDraftRowByVersion, createDraft, addSegment, addSegmentSource, getDraftById } from '../db/drafts'
import { getSettings } from '../db/settings'
import { getSourceIdsByTag } from '../db/tags'
import { getTemplateById } from '../db/templates'
import { getProviderSecret } from '../llm/provider-store'
import { safeStorageCodec } from '../llm/secret'
import { chatCompletion, type ChatMessage } from '../llm/chat'
import { retrieveChunks } from '../rag/retrieval'

export type GenerateResult = { ok: true; draft: Draft } | { ok: false; error: { code: string; message: string } }

function fail(code: string, message: string): GenerateResult {
  return { ok: false, error: { code, message } }
}

interface NormalizedSegment {
  heading?: string
  content: string
  sources: { sourceId: string; position: string; quote?: string }[]
}

/** 解析模型输出中的 JSON（容忍 ```json 围栏与前后缀文本） */
function parseJson(text: string): unknown | null {
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch {
    return null
  }
}

function normalizeSegments(
  data: unknown,
  scopeIds: Set<string>,
  chunkByKey: Map<string, string>,
  chunkBySource: Map<string, string>
): NormalizedSegment[] | null {
  if (!data || typeof data !== 'object') return null
  const segments = (data as { segments?: unknown }).segments
  if (!Array.isArray(segments) || segments.length === 0) return null

  const out: NormalizedSegment[] = []
  for (const raw of segments) {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as { heading?: unknown; content?: unknown; sources?: unknown }
    if (typeof r.content !== 'string' || !r.content.trim()) return null

    const sources: NormalizedSegment['sources'] = []
    if (Array.isArray(r.sources)) {
      for (const s of r.sources) {
        if (!s || typeof s !== 'object') continue
        const src = s as { sourceId?: unknown; position?: unknown }
        if (typeof src.sourceId !== 'string' || !scopeIds.has(src.sourceId)) continue
        const pos = typeof src.position === 'string' ? src.position : ''
        sources.push({
          sourceId: src.sourceId,
          position: pos,
          quote: chunkByKey.get(`${src.sourceId}|${pos}`) ?? chunkBySource.get(src.sourceId)
        })
      }
    }
    out.push({
      heading: typeof r.heading === 'string' ? r.heading.trim() : undefined,
      content: r.content.trim(),
      sources
    })
  }
  return out
}

/** 范本篇目层级结构 → 纯文本（供提示词参考体例） */
function flattenOutline(outline: unknown): string {
  const lines: string[] = []
  const walk = (items: unknown, depth: number): void => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const it = item as { level?: unknown; title?: unknown; children?: unknown }
      if (typeof it.title === 'string' && it.title.trim()) {
        lines.push('　'.repeat(depth) + it.title.trim())
      }
      walk(it.children, depth + 1)
    }
  }
  walk(outline, 0)
  return lines.join('\n')
}

function templateOutlineText(templateBookId: string): string | null {
  const tpl = getTemplateById(templateBookId)
  if (!tpl) return null
  try {
    return flattenOutline(JSON.parse(tpl.outline))
  } catch {
    return null
  }
}

function buildSystemPrompt(): string {
  return [
    '你是资深的地方志书撰稿专家，遵循"实事求是、述而不作、横排门类、纵述史实"的志书体例。',
    '你只能依据用户提供的参考材料撰写，严禁编造材料中没有的史实、数据、人名、机构或时间。',
    '输出必须是一个合法 JSON 对象，结构如下（不得输出任何 JSON 之外的文字）：',
    '{"segments":[{"heading":"片段小标题","content":"片段正文","sources":[{"sourceId":"材料中的 sourceId","position":"材料中的位置"}]}]}',
    '要求：',
    '1. segments 为至少 1 个片段的数组，每个 content 是完整独立的志书文段；',
    '2. 每个片段必须使用 materials 中提供的 sourceId 与 position 标注其依据的来源；',
    '3. 志书语言客观、平实，不使用第一人称，不出现"根据材料""以上资料"等表述；',
    '4. content 使用 Markdown 格式书写（可用 **粗体**、*斜体*、### 小标题、- 列表、表格等），便于在文档编辑器中直接编辑。'
  ].join('\n')
}

function buildUserPrompt(title: string, chunks: RetrievedChunk[], templateText: string | null): string {
  const materials = chunks
    .map((c, i) => {
      const text = c.text.length > 300 ? `${c.text.slice(0, 300)}…` : c.text
      return `[${i + 1}]（sourceId: ${c.sourceId}，标题：《${c.sourceTitle}》，位置：${c.position}）\n${text}`
    })
    .join('\n\n')

  const tpl = templateText ? `参考范本篇目层级：\n${templateText}` : '（未提供范本）'

  return [
    `撰写任务标题：${title}`,
    '',
    tpl,
    '',
    '以下是从本地资料中检索到的相关材料（仅限这些材料）：',
    '',
    materials,
    '',
    '请依据以上材料撰写志书初稿，按片段组织，并为每个片段标注其依据材料的 sourceId 与 position。'
  ].join('\n')
}

/** 生成初稿（第 0 稿）；已存在则幂等返回 */
export async function generateDraft(taskId: string): Promise<GenerateResult> {
  const task = getTaskById(taskId)
  if (!task) return fail(ErrorCodes.TASK_NOT_FOUND, '撰写任务不存在')

  const settings = getSettings()
  if (!settings.currentLlmProviderId) return fail(ErrorCodes.TASK_NO_PROVIDER, '请先在设置中配置并选择 LLM Provider')
  const provider = getProviderSecret(settings.currentLlmProviderId, safeStorageCodec)
  if (!provider) return fail(ErrorCodes.TASK_NO_PROVIDER, '所选的 LLM Provider 不存在')
  if (!provider.apiKey) return fail(ErrorCodes.LLM_UNAUTHORIZED, '所选的 LLM Provider 未设置 API 密钥')

  const scopeIds = resolveScopeSourceIds(task, getSourceIdsByTag)
  if (scopeIds.length === 0) return fail(ErrorCodes.TASK_NO_SCOPE, '任务的文件范围内没有可用资料')

  const chunks = retrieveChunks({ sourceIds: scopeIds, query: task.title, limit: 12 })
  if (chunks.length === 0) return fail(ErrorCodes.LLM_NO_CANDIDATES, '未检索到与标题相关的资料，请调整标题或文件范围')

  // 幂等：第 0 稿已存在则直接返回
  const existing = getDraftRowByVersion(taskId, 0)
  if (existing) {
    const draft = getDraftById(existing.id)
    if (draft) return { ok: true, draft }
  }

  const templateText = task.templateBookId ? templateOutlineText(task.templateBookId) : null
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(task.title, chunks, templateText) }
  ]

  // 结构校验失败时带提示重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await chatCompletion(
      { apiBase: provider.config.apiBase, model: provider.config.model, apiKey: provider.apiKey },
      messages
    )
    if (!result.ok) return { ok: false, error: result.error }

    const chunkByKey = new Map(chunks.map((c) => [`${c.sourceId}|${c.position}`, c.text]))
    const chunkBySource = new Map(chunks.map((c) => [c.sourceId, c.text]))
    const normalized = normalizeSegments(parseJson(result.text), new Set(scopeIds), chunkByKey, chunkBySource)
    if (normalized) {
      const draft = createDraft(taskId, 0)
      normalized.forEach((seg, i) => {
        const row = addSegment({ draftId: draft.id, ordering: i, heading: seg.heading, content: seg.content, aiGenerated: true })
        seg.sources.forEach((src) => addSegmentSource(row.id, src.sourceId, src.position, src.quote))
      })
      const saved = getDraftById(draft.id)
      if (!saved) return fail(ErrorCodes.INTERNAL_ERROR, '初稿保存失败')
      return { ok: true, draft: saved }
    }

    messages.push({ role: 'assistant', content: result.text })
    messages.push({
      role: 'user',
      content: '你上次的输出不符合要求：segments 必须为非空数组、每段 content 非空、sources 的 sourceId 必须是材料中提供的 ID。请重新输出，仅输出合法 JSON。'
    })
  }

  return fail(ErrorCodes.LLM_FORMAT_INVALID, '模型输出无法解析为符合要求的志稿结构')
}

/** 任务范围内的检索预览（writing:retrieve，供界面展示与验收） */
export function retrieveForTask(taskId: string): RetrievedChunk[] | null {
  const task = getTaskById(taskId)
  if (!task) return null
  const scopeIds = resolveScopeSourceIds(task, getSourceIdsByTag)
  if (scopeIds.length === 0) return []
  return retrieveChunks({ sourceIds: scopeIds, query: task.title, limit: 12 })
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('draft generation parsing (Task 3.3)', () => {
    it('parses JSON with code fence and surrounding text', () => {
      const out = parseJson('```json\n{"segments":[{"content":"正文"}]}\n```')
      expect(out).toEqual({ segments: [{ content: '正文' }] })
    })

    it('normalizes segments, dropping sources outside scope', () => {
      const data = {
        segments: [
          {
            heading: '概述',
            content: '新区经济快速发展。',
            sources: [
              { sourceId: 's1', position: '第1段' },
              { sourceId: 's9', position: '第2段' } // 不在范围内，应剔除
            ]
          },
          { heading: '', content: '   ' } // 空内容，整体判为无效
        ]
      }
      const byKey = new Map([['s1|第1段', '原文一']])
      const bySource = new Map([['s1', '原文一']])
      const segs = normalizeSegments(data, new Set(['s1']), byKey, bySource)
      expect(segs).toBeNull() // 因存在空内容片段而整体无效
    })

    it('accepts valid segments and attaches quotes', () => {
      const data = {
        segments: [
          {
            heading: '概述',
            content: '新区经济快速发展。',
            sources: [{ sourceId: 's1', position: '第1段' }]
          }
        ]
      }
      const byKey = new Map([['s1|第1段', '原文摘句一']])
      const bySource = new Map([['s1', '原文摘句一']])
      const segs = normalizeSegments(data, new Set(['s1']), byKey, bySource)
      expect(segs).toHaveLength(1)
      expect(segs![0].sources[0]).toEqual({ sourceId: 's1', position: '第1段', quote: '原文摘句一' })
    })

    it('rejects non-object or empty segments', () => {
      expect(normalizeSegments(null, new Set(), new Map(), new Map())).toBeNull()
      expect(normalizeSegments({ segments: [] }, new Set(), new Map(), new Map())).toBeNull()
    })
  })
}
