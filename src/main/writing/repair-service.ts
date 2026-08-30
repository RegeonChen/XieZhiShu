/**
 * repair-service.ts —— 资料卡片二次加工（语义补全/修订）服务（Phase 6.4.3，2026-08-25）。
 * 在 Step-1 资料汇编生成后，读取汇编卡片，找出表意不明/疑似残缺的卡片，读取其来源原文上下文，
 * 由大模型提出语义补全/修订文本，落库为 pending 的 compilation_repairs。
 * 无 Provider / LLM 调用失败时返回空（additive，绝不阻断），且不修改卡片文本。
 */
import type { CompilationRepair, CompilationItem } from '../../shared/types'
import { ErrorCodes } from '../../shared/types'
import { getCompilationById, updateCompilationItem, reorderCompilationItemsByTs } from '../db/compilations'
import { insertRepairs, type InsertRepairInput } from '../db/compilation-repairs'
import { getSourceById } from '../db/sources'
import { getSettings } from '../db/settings'
import { getProviderSecret } from '../llm/provider-store'
import { safeStorageCodec } from '../llm/secret'
import { chatCompletion, type ChatMessage } from '../llm/chat'
import { logMain } from '../logger'

const REPAIR_TIMEOUT_MS = 300000
const CONTEXT_WINDOW_CHARS = 120

export type RepairScanResult =
  | { ok: true; repairs: CompilationRepair[] }
  | { ok: false; error: { code: string; message: string } }

interface ProviderInfo {
  apiBase: string
  model: string
  apiKey: string
}

function fail(code: string, message: string): RepairScanResult {
  return { ok: false, error: { code, message } }
}

/** 第 1 步资料汇编使用的大模型（Phase 6.8）：一律以设置中的「步骤默认模型」第 1 步为准 */
function resolveProvider(): { ok: true; provider: ProviderInfo } | { ok: false; error: { code: string; message: string } } {
  const settings = getSettings()
  const providerId = settings.compilationProviderId
  if (!providerId) return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '请先在设置中为「第 1 步」指定默认大模型' } }
  const provider = getProviderSecret(providerId, safeStorageCodec)
  if (!provider) return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '所选的 LLM Provider 不存在' } }
  if (!provider.apiKey) return { ok: false, error: { code: ErrorCodes.LLM_UNAUTHORIZED, message: '所选的 LLM Provider 未设置 API 密钥' } }
  return { ok: true, provider: { apiBase: provider.config.apiBase, model: provider.config.model, apiKey: provider.apiKey } }
}

/** 读取来源原文，返回以摘录为中心的上下文窗口（前/后各 ~120 字；找不到则仅摘录） */
function buildContextWindow(item: CompilationItem): string {
  const source = getSourceById(item.sourceId)
  if (!source || !source.cleanedText) return item.excerpt
  const clean = source.cleanedText
  const idx = clean.indexOf(item.excerpt)
  if (idx < 0) return item.excerpt
  const start = Math.max(0, idx - CONTEXT_WINDOW_CHARS)
  const end = Math.min(clean.length, idx + item.excerpt.length + CONTEXT_WINDOW_CHARS)
  let window = clean.slice(start, end)
  if (window === item.excerpt) return item.excerpt
  // 标注摘录在窗口中的位置，便于模型对照
  const rel = idx - start
  window = window.slice(0, rel) + '【摘录】' + item.excerpt + '【/摘录】' + window.slice(rel + item.excerpt.length)
  return window
}

/** 解析 AI 语义补全/修订输出（纯函数，可测试） */
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

function buildPrompt(items: CompilationItem[]): ChatMessage[] {
  const cardList = items
    .map((it, i) => '[' + (i + 1) + '] itemId=' + it.id + ' 来源：《' + (it.sourceTitle ?? it.sourceId) + '》\n摘录：' + it.excerpt + '\n原文上下文：' + buildContextWindow(it))
    .join('\n\n')
  const sys = [
    '你是一名地方志资料整理专家。下面给出一批已筛选出的【资料卡片】（每条含 itemId、来源、摘录、原文上下文）。',
    '请先通读所有卡片，然后：',
    '1. 对缺少时间戳（卡片无 ts 或 ts 为空）的卡片，结合【原文上下文】推断其年份/时间（如项目完工年份、资料所属年份），并给出 ts 字段（如 "2005 年"）；若上下文确无年份依据，则不给 ts。',
    '2. 对「表意不明」或「疑似残缺」的卡片（例如表格单元格被切片后丢失列名/行名含义、孤立的短语、缺少主谓宾的残缺句），结合【原文上下文】给出一个语义补全/修订后的完整文本（revised），并简要说明原因（reason）。',
    '同一张卡片可以同时给出 ts 和 revised（补齐时间戳 + 补充文本）。',
    '已经表意清晰、完整且已有时间戳的卡片不要输出。',
    '',
    '只输出一个 JSON 对象，不要输出其他文字或代码块围栏，且保持在一行：',
    '{"repairs":[{"itemId":"...","ts":"2005 年","revised":"...","reason":"..."}]}'
  ].join('\n')
  const user = '【资料卡片】\n' + cardList + '\n\n请按上述要求输出需要补齐时间戳或语义补全/修订的卡片；ts 字段仅在能依据原文推断出年份/时间时给出。'
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]
}

/**
 * 扫描某次资料汇编中表意不明的卡片，生成 pending 语义补全/修订。
 * - 无 Provider / LLM 调用失败 → { ok:true, repairs:[] }（additive，不阻断）。
 * - 仅插入有效的修订（itemId 属于该汇编、revised 非空），以卡片实际摘录为 original_text；
 *   不修改任何卡片文本。
 */
export async function scanCompilationRepairs(
  compilationId: string,
  onProgress?: (stage: string) => void
): Promise<RepairScanResult> {
  const compilation = getCompilationById(compilationId)
  if (!compilation) return fail(ErrorCodes.INVALID_PARAM, '资料汇编不存在')

  const items = compilation.items.filter((it) => it.kept !== false)
  if (items.length === 0) return { ok: true, repairs: [] }

  const prov = resolveProvider()
  if (!prov.ok) return { ok: true, repairs: [] }

  onProgress?.('正在扫描表意不明的资料卡片…')
  try {
    const result = await chatCompletion(prov.provider, buildPrompt(items), REPAIR_TIMEOUT_MS, { kind: 'compilation-repair-scan' }, {
      maxRetries: 1,
      temperature: 0
    })
    if (!result.ok) return { ok: true, repairs: [] }

    const parsed = parseRepairScanOutput(result.text)
    if (!parsed) return { ok: true, repairs: [] }

    const itemById = new Map(items.map((it) => [it.id, it]))
    const inputs: InsertRepairInput[] = []
    let tsFilled = 0
    for (const p of parsed) {
      const it = itemById.get(p.itemId)
      if (!it) continue
      // 仅对缺少时间戳的卡片自动补齐（无需用户采纳，直接修改卡片 ts 字段；已有 ts 的卡片不覆盖）
      if (p.ts && !it.ts) {
        updateCompilationItem(it.id, { ts: p.ts })
        tsFilled += 1
      }
      // 语义补全/修订仍为 pending，由用户采纳/不用
      if (!p.revised || p.revised === it.excerpt) continue
      inputs.push({ itemId: it.id, originalText: it.excerpt, revisedText: p.revised, reason: p.reason })
    }
    // 补齐时间戳后重排汇编卡片顺序（原先生成时缺失时间戳的卡片被排到末尾，需按新时间戳归位）
    if (tsFilled > 0) reorderCompilationItemsByTs(compilationId)
    if (inputs.length === 0 && tsFilled === 0) return { ok: true, repairs: [] }
    const repairs = inputs.length > 0 ? insertRepairs(compilationId, inputs) : []
    logMain('repair', '二次修改扫描：自动补齐时间戳 ' + tsFilled + ' 条，生成待采纳修订 ' + repairs.length + ' 条')
    return { ok: true, repairs }
  } catch {
    return { ok: true, repairs: [] }
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest
  describe('repair service parse (Phase 6.4.3)', () => {
    it('parses fenced/json repair output', () => {
      const out = parseRepairScanOutput('{"repairs":[{"itemId":"i1","revised":"补全后文本","reason":"表意不明"}]}')!
      expect(out).toHaveLength(1)
      expect(out[0].itemId).toBe('i1')
      expect(out[0].revised).toBe('补全后文本')
      expect(out[0].ts).toBe('')
    })
    it('parses a ts field for timestamp-fill repairs', () => {
      const out = parseRepairScanOutput('{"repairs":[{"itemId":"i2","ts":"2005 年","revised":"","reason":"缺少时间戳"}]}')!
      expect(out).toHaveLength(1)
      expect(out[0].itemId).toBe('i2')
      expect(out[0].ts).toBe('2005 年')
      expect(out[0].revised).toBe('')
    })
    it('keeps ts-only entries (no revised) when parsing', () => {
      const out = parseRepairScanOutput('{"repairs":[{"itemId":"i3","ts":"2008 年"}]}')!
      expect(out).toHaveLength(1)
      expect(out[0].ts).toBe('2008 年')
    })
    it('parses bare json with surrounding text', () => {
      const out = parseRepairScanOutput('好的，下面是结果：{"repairs":[{"itemId":"i1","revised":"补全文本","reason":"疑似残缺"}]} 以上。')!
      expect(out).toHaveLength(1)
      expect(out[0].reason).toBe('疑似残缺')
    })
    it('returns null for invalid / empty output', () => {
      expect(parseRepairScanOutput('纯文本')).toBeNull()
      expect(parseRepairScanOutput('{"repairs":[]}')).toBeNull()
    })
  })
}
