/**
 * repair-service.ts —— 资料卡片「大模型修正」阶段（生成管线内，2026-09-08 改版）。
 *
 * 位置（用户需求变更 2026-09-08）：**AI 分窗细读之后、卡片矛盾扫描之前**——先让卡片内容清晰完整，
 * 再交给大模型做矛盾检测；此前是“生成汇编完成后再单独扫一次”，顺序相反。
 *
 * 行为：
 * - 找出表意不明/疑似残缺的卡片，结合**来源相邻段落上下文**给出修正文本，**默认直接应用到卡片**（无需用户裁定）；
 * - 同时记录「修正前原文 + 修正理由」，落库后由卡片上的「经过大模型修正」标记承载，用户可点开查看并回退/再次应用；
 * - 缺少时间戳的卡片仍**静默补齐 ts**（用户确认：不算“修正”，不落修正记录、无标记、不可回退）。
 *
 * 失败：大模型异常（超时/网络/429）→ 返回 interrupted，交由生成管线的断点续传「尝试继续」，
 * 续跑只重跑本阶段（已完成批次结果保留，不重复烧钱）。
 * 无 Provider / 无法解析输出 → 视为「无修正」，不阻断（additive）。
 */
import type { RetrievedChunk } from '../../shared/types'
import { ErrorCodes } from '../../shared/types'
import { chatCompletion, type ChatMessage } from '../llm/chat'

/** 单次调用最多卡片数（配合字符预算，避免一次性提交上百张长卡片导致响应超时） */
export const REPAIR_BATCH_MAX = 30
/** 单次调用输入字符预算（含摘录 + 上下文） */
export const REPAIR_BATCH_CHARS = 12000
/** 单次调用超时（推理型任务，留足余量） */
const REPAIR_CALL_TIMEOUT_MS = 300000
/** 整阶段时间预算：超出即停止剩余批次并把结果标为“未完成”（不阻断后续矛盾扫描） */
export const REPAIR_PHASE_BUDGET_MS = 900000
/** 相邻段落上下文各截取的字数（卡片本身即整段，故上下文取“同来源前一段尾 + 后一段头”） */
const CONTEXT_NEIGHBOR_CHARS = 200
/** 单批修正的预计耗时（秒，用于剩余时间展示） */
export const REPAIR_ETA_PER_CALL_S = 90

/** 管线的来源编号表（与 compilation-service 的 SourceRefEntry 结构一致，避免循环依赖） */
export interface RepairSourceRef {
  index: number
  sourceId: string
  title: string
}

/** 待修正的卡片（管线内存态；不含任何数据库 id） */
export interface RepairCandidate {
  /** 该卡在合并后 items 数组中的下标（仅用于回填修正结果，不进入提示词） */
  index: number
  /** 提示词中的稳定标识（如 c12），用于把模型输出映射回卡片 */
  key: string
  sourceRef: string
  sourceTitle: string
  excerpt: string
  ts?: string
  /** 同来源相邻段落上下文（判断表意是否残缺的依据） */
  context: string
}

/** 一条修正结果（文本修正，可回退；ts 变更不属于修正） */
export interface RepairFix {
  index: number
  originalText: string
  revisedText: string
  reason: string
}

export interface RepairBatchOutcome {
  ok: boolean
  fixes: RepairFix[]
  /** 静默补齐的时间戳：index → ts（不算“修正”，不落修正记录） */
  tsFills: { index: number; ts: string }[]
  message?: string
  rateLimited?: boolean
}

/** 由 items 的 sourceRef 解析来源 id */
function sourceIdOfRef(refs: RepairSourceRef[], sourceRef: string): string | undefined {
  return refs.find((r) => '#' + r.index === sourceRef)?.sourceId
}

/**
 * 构造「同来源相邻段落」上下文（纯函数，可测试）：
 * 卡片本身就是整段原文，故上下文只能来自相邻段落——前一段的尾部 + 后一段的头部。
 */
export function buildNeighborContext(
  sourceId: string | undefined,
  excerpt: string,
  chunks: RetrievedChunk[]
): string {
  if (!sourceId) return ''
  const sameSource = chunks.filter((c) => c.sourceId === sourceId)
  if (sameSource.length === 0) return ''
  let at = sameSource.findIndex((c) => c.text === excerpt)
  if (at < 0) at = sameSource.findIndex((c) => c.text.includes(excerpt) || excerpt.includes(c.text))
  if (at < 0) return ''
  const prev = sameSource[at - 1]
  const next = sameSource[at + 1]
  const parts: string[] = []
  if (prev) parts.push('…' + prev.text.slice(-CONTEXT_NEIGHBOR_CHARS))
  parts.push('【摘录】' + excerpt + '【/摘录】')
  if (next) parts.push(next.text.slice(0, CONTEXT_NEIGHBOR_CHARS) + '…')
  return parts.join('\n')
}

/** 从合并后的卡片构造待修正候选（无上下文的卡片也保留，模型仍可依据摘录本身判断） */
export function buildRepairCandidates(
  items: { sourceRef: string; excerpt: string; ts: string | null }[],
  refs: RepairSourceRef[],
  chunks: RetrievedChunk[]
): RepairCandidate[] {
  const titleByRef = new Map(refs.map((r) => ['#' + r.index, r.title]))
  return items.map((it, i) => {
    const sourceId = sourceIdOfRef(refs, it.sourceRef)
    const context = buildNeighborContext(sourceId, it.excerpt, chunks)
    return {
      index: i,
      key: 'c' + (i + 1),
      sourceRef: it.sourceRef,
      sourceTitle: titleByRef.get(it.sourceRef) ?? '',
      excerpt: it.excerpt,
      ts: it.ts ?? undefined,
      context: context || it.excerpt
    }
  })
}

/**
 * 按「卡片数 + 累计字符」双预算切批（纯函数，可测试）。
 * 返回每批的候选下标（升序、不重不漏）。
 */
export function splitRepairBatches(
  candidates: RepairCandidate[],
  maxCount: number = REPAIR_BATCH_MAX,
  maxChars: number = REPAIR_BATCH_CHARS
): number[][] {
  const batches: number[][] = []
  let cur: number[] = []
  let chars = 0
  candidates.forEach((c, i) => {
    const size = c.excerpt.length + c.context.length + 60
    if (cur.length > 0 && (cur.length + 1 > maxCount || chars + size > maxChars)) {
      batches.push(cur)
      cur = []
      chars = 0
    }
    cur.push(i)
    chars += size
  })
  if (cur.length > 0) batches.push(cur)
  return batches
}

/**
 * 解析 AI 修正输出（纯函数，可测试）。返回 null 表示无有效输出。
 * 兼容代码块围栏 / 前后夹杂文字；itemId 与 ts 至少有一个非空才算有效条目。
 */
export function parseRepairScanOutput(text: string): { itemId: string; revised: string; reason: string; ts: string }[] | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1].trim() : trimmed
  let raw: unknown | null = null
  try {
    raw = JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        raw = JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return null
      }
    } else {
      return null
    }
  }
  if (!raw || typeof raw !== 'object') return null
  const arr = (raw as { repairs?: unknown }).repairs
  if (!Array.isArray(arr)) return null
  const out: { itemId: string; revised: string; reason: string; ts: string }[] = []
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue
    const o = r as { itemId?: unknown; revised?: unknown; reason?: unknown; ts?: unknown }
    const itemId = typeof o.itemId === 'string' ? o.itemId.trim() : ''
    const revised = typeof o.revised === 'string' ? o.revised.trim() : ''
    const ts = typeof o.ts === 'string' ? o.ts.trim() : ''
    if (!itemId) continue
    if (!revised && !ts) continue
    out.push({ itemId, revised, reason: typeof o.reason === 'string' ? o.reason.trim() : '', ts })
  }
  return out.length > 0 ? out : null
}

export function buildRepairMessages(batch: RepairCandidate[]): ChatMessage[] {
  const cardList = batch
    .map((c) => '[itemId=' + c.key + '] 来源：《' + (c.sourceTitle || c.sourceRef) + '》 时间：' + (c.ts ?? '无') + '\n摘录：' + c.excerpt + '\n原文上下文：\n' + c.context)
    .join('\n\n')
  const sys = [
    '你是一名地方志资料整理专家。下面给出一批已筛选出的【资料卡片】（每条含 itemId、来源、时间、摘录、原文上下文）。',
    '请先通读所有卡片，然后：',
    '1. 对缺少时间戳（时间显示为“无”）的卡片，结合【原文上下文】推断其年份/时间（如项目完工年份、资料所属年份），并给出 ts 字段（如 "2005 年"）；若上下文确无年份依据，则不给 ts。',
    '2. 对「表意不明」或「疑似残缺」的卡片（例如表格单元格被切片后丢失列名/行名含义、孤立的短语、缺少主谓宾的残缺句、脱离上下文不知所云的句子），结合【原文上下文】给出语义完整、可直接入库的修正文本（revised），并简要说明原因（reason）。',
    '3. revised 必须忠于原文事实：只能补全原文已有信息的表述，**不得添加原文中不存在的信息、不得推测或补充史实、不得改变数字与结论**。',
    '同一张卡片可以同时给出 ts 和 revised（补齐时间戳 + 修正文本）。',
    '已经表意清晰、完整且已有时间戳的卡片不要输出。',
    '',
    '只输出一个 JSON 对象，不要输出其他文字或代码块围栏，且保持在一行：',
    '{"repairs":[{"itemId":"c1","ts":"2005 年","revised":"...","reason":"..."}]}'
  ].join('\n')
  const user = '【资料卡片】\n' + cardList + '\n\n请按上述要求输出需要补齐时间戳或修正的卡片；ts 字段仅在能依据原文推断出年份/时间时给出。'
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]
}

interface RepairProvider {
  apiBase: string
  model: string
  apiKey: string
}

/**
 * 对一批卡片调用大模型求修正（单次调用，不重试；异常/限流以 ok:false 透出，由管线决定中断）。
 */
export async function scanRepairBatch(
  provider: RepairProvider,
  batch: RepairCandidate[],
  taskId: string
): Promise<RepairBatchOutcome> {
  if (batch.length === 0) return { ok: true, fixes: [], tsFills: [] }
  const result = await chatCompletion(
    provider,
    buildRepairMessages(batch),
    REPAIR_CALL_TIMEOUT_MS,
    { kind: 'compilation-repair-scan', taskId },
    { maxRetries: 0, temperature: 0, seed: 42 }
  )
  if (!result.ok) {
    return {
      ok: false,
      fixes: [],
      tsFills: [],
      message: result.error?.message ?? '大模型调用异常',
      rateLimited: result.error?.code === ErrorCodes.LLM_RATE_LIMIT
    }
  }
  const parsed = parseRepairScanOutput(result.text)
  if (!parsed) return { ok: true, fixes: [], tsFills: [] }
  const byKey = new Map(batch.map((c) => [c.key, c]))
  const fixes: RepairFix[] = []
  const tsFills: { index: number; ts: string }[] = []
  for (const p of parsed) {
    const card = byKey.get(p.itemId)
    if (!card) continue
    if (p.ts && !card.ts) tsFills.push({ index: card.index, ts: p.ts })
    if (p.revised && p.revised !== card.excerpt) {
      fixes.push({ index: card.index, originalText: card.excerpt, revisedText: p.revised, reason: p.reason })
    }
  }
  return { ok: true, fixes, tsFills }
}

/**
 * 卡片文本被修正后，**窗口级矛盾**里引用原文本的说法也要同步改写（纯函数，可测试）。
 * 原因：落库时矛盾说法是按 excerpt 精确匹配卡片的（finalizeCompilationInto 的 byExcerpt），
 * 若不同步，涉及被修正卡片的整组窗口级矛盾会匹配不到卡片而被丢弃。
 */
export function remapRepairedVariantExcerpts<T extends { variants: { excerpt: string; sourceRefs: string[] }[] }>(
  groups: T[],
  fixes: RepairFix[]
): T[] {
  if (fixes.length === 0) return groups
  const byOriginal = new Map(fixes.map((f) => [f.originalText, f.revisedText]))
  return groups.map((g) => ({
    ...g,
    variants: g.variants.map((v) => {
      const revised = byOriginal.get(v.excerpt)
      return revised && revised !== v.excerpt ? { ...v, excerpt: revised } : v
    })
  }))
}

/** 把修正（文本）与时间戳补齐应用到卡片（纯函数，可测试；返回新数组，不修改入参） */export function applyRepairOutcome<T extends { excerpt: string; ts: string | null; repair?: { originalText: string; revisedText: string; reason: string } }>(
  items: T[],
  fixes: RepairFix[],
  tsFills: { index: number; ts: string }[]
): T[] {
  const out: T[] = items.map((it) => ({ ...it }))
  for (const f of fixes) {
    const it = out[f.index]
    if (!it) continue
    it.excerpt = f.revisedText
    it.repair = { originalText: f.originalText, revisedText: f.revisedText, reason: f.reason }
  }
  for (const t of tsFills) {
    const it = out[t.index]
    if (!it || it.ts) continue
    it.ts = t.ts
  }
  return out
}


// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  const refs: RepairSourceRef[] = [
    { index: 1, sourceId: 's1', title: '教育发展报告' },
    { index: 2, sourceId: 's2', title: '统计表' }
  ]
  const chunks: RetrievedChunk[] = [
    { sourceId: 's1', sourceTitle: '教育发展报告', position: '1', text: '前一段：全县教育事业稳步发展。', score: 1 },
    { sourceId: 's1', sourceTitle: '教育发展报告', position: '2', text: '其中预科班 30 人。', score: 1 },
    { sourceId: 's1', sourceTitle: '教育发展报告', position: '3', text: '后一段：高中阶段毛入学率达 95%。', score: 1 },
    { sourceId: 's2', sourceTitle: '统计表', position: '1', text: '公办园 76 所', score: 1 }
  ]

  describe('repair service (2026-09-08 管线内阶段)', () => {
    it('parses fenced/json repair output', () => {
      const out = parseRepairScanOutput('{"repairs":[{"itemId":"c1","revised":"修正后文本","reason":"表意不明"}]}')!
      expect(out).toHaveLength(1)
      expect(out[0].itemId).toBe('c1')
      expect(out[0].revised).toBe('修正后文本')
      expect(out[0].ts).toBe('')
    })
    it('parses a ts field for timestamp fill', () => {
      const out = parseRepairScanOutput('{"repairs":[{"itemId":"c2","ts":"2005 年","revised":"","reason":""}]}')!
      expect(out[0].ts).toBe('2005 年')
    })
    it('parses bare json with surrounding text', () => {
      const out = parseRepairScanOutput('好的：{"repairs":[{"itemId":"c1","revised":"文本","reason":"残缺"}]} 以上。')!
      expect(out[0].reason).toBe('残缺')
    })
    it('returns null for invalid or empty output', () => {
      expect(parseRepairScanOutput('纯文本')).toBeNull()
      expect(parseRepairScanOutput('{"repairs":[]}')).toBeNull()
    })

    it('builds neighbor context from the surrounding paragraphs of the same source', () => {
      const ctx = buildNeighborContext('s1', '其中预科班 30 人。', chunks)
      expect(ctx).toContain('前一段：全县教育事业稳步发展。')
      expect(ctx).toContain('【摘录】其中预科班 30 人。【/摘录】')
      expect(ctx).toContain('后一段：高中阶段毛入学率达 95%。')
    })
    it('falls back to the excerpt itself when the source or paragraph cannot be located', () => {
      expect(buildNeighborContext('sX', '随便', chunks)).toBe('')
      expect(buildNeighborContext(undefined, '随便', chunks)).toBe('')
    })

    it('builds candidates with stable keys and context', () => {
      const cands = buildRepairCandidates(
        [
          { sourceRef: '#1', excerpt: '其中预科班 30 人。', ts: null },
          { sourceRef: '#2', excerpt: '公办园 76 所', ts: '2021 年' }
        ],
        refs,
        chunks
      )
      expect(cands.map((c) => c.key)).toEqual(['c1', 'c2'])
      expect(cands[0].sourceTitle).toBe('教育发展报告')
      expect(cands[1].ts).toBe('2021 年')
      expect(cands[0].context).toContain('【摘录】')
    })

    it('splits batches by count and char budget without dropping cards', () => {
      const many = Array.from({ length: 70 }, (_, i) => ({
        index: i,
        key: 'c' + (i + 1),
        sourceRef: '#1',
        sourceTitle: 't',
        excerpt: 'x'.repeat(500),
        context: ''
      }))
      const batches = splitRepairBatches(many, 30, 12000)
      expect(batches.flat()).toHaveLength(70)
      expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(30)
      // 单卡超预算时也要单独成批（不丢卡）
      const huge = [{ index: 0, key: 'c1', sourceRef: '#1', sourceTitle: 't', excerpt: 'x'.repeat(50000), context: '' }]
      expect(splitRepairBatches(huge, 30, 12000)).toEqual([[0]])
    })

    it('applies text fixes and ts fills onto the item array (keeping order/indices)', () => {
      const items: {
        sourceRef: string
        excerpt: string
        ts: string | null
        repair?: { originalText: string; revisedText: string; reason: string }
      }[] = [
        { sourceRef: '#1', excerpt: '其中预科班 30 人。', ts: null },
        { sourceRef: '#2', excerpt: '公办园 76 所', ts: null }
      ]
      const out = applyRepairOutcome(
        items,
        [{ index: 0, originalText: '其中预科班 30 人。', revisedText: '预科班 30 人。', reason: '缺少主语' }],
        [{ index: 1, ts: '2021 年' }]
      )
      expect(out[0].excerpt).toBe('预科班 30 人。')
      expect(out[0].repair).toEqual({ originalText: '其中预科班 30 人。', revisedText: '预科班 30 人。', reason: '缺少主语' })
      expect(out[1].ts).toBe('2021 年')
      // ts 补齐不算修正记录
      expect(out[1].repair).toBeUndefined()
      // 入参未被修改
      expect(items[0].excerpt).toBe('其中预科班 30 人。')
    })

    it('does not overwrite an existing ts', () => {
      const out = applyRepairOutcome([{ sourceRef: '#1', excerpt: 'a', ts: '2005 年' }], [], [{ index: 0, ts: '2021 年' }])
      expect(out[0].ts).toBe('2005 年')
    })

    it('remaps window-level contradiction variants that quote a repaired card', () => {
      const groups = [
        {
          topic: '预科班人数',
          kind: 'data',
          variants: [
            { excerpt: '其中预科班 30 人。', sourceRefs: ['#1'] },
            { excerpt: '预科班 20 人。', sourceRefs: ['#2'] }
          ]
        }
      ]
      const out = remapRepairedVariantExcerpts(groups, [
        { index: 0, originalText: '其中预科班 30 人。', revisedText: '预科班 30 人。', reason: '缺少主语' }
      ])
      expect(out[0].variants[0].excerpt).toBe('预科班 30 人。')
      expect(out[0].variants[1].excerpt).toBe('预科班 20 人。')
      // 无修正时原样返回
      expect(remapRepairedVariantExcerpts(groups, [])).toBe(groups)
    })
  })
}
