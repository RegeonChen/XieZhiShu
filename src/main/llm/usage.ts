/**
 * usage.ts —— **一次生成的大模型用量账本**（2026-11-02，第一项任务：性能基线）。
 *
 * 为什么需要它：`llm_call_logs` 只记了**字符数**与耗时，没有 token。于是"这次生成花了多少钱、哪一阶段最贵"
 * 完全无从回答——而这是给用户报成本、给性能基线做对比的前提。
 *
 * 口径：
 * - 每次 `chatCompletion` 成功后把 Provider 返回的 `usage` 记进来（**失败调用也计数**，但 token 记为 0/未知）；
 * - 按 `kind`（`detailed-read` / `extract` / `contradiction-scan` …）分组，直接得到"各阶段花了多少 token"；
 * - **会话式**：`beginUsageSession()` 在生成开始时清零，`getUsageTotals()` 随时可读；模块级单例，
 *   与 `fetch-control` 同理（同一时刻主线只有一次生成）。
 */
import type { ChatUsage } from './chat'

/** 单个阶段的用量 */
export interface UsageByKind {
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** 一次生成的用量总计（跨阶段） */
export interface UsageTotals {
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /**
   * **返回里没有 usage 的调用数**——OpenAI-compatible 的流式响应只有显式请求
   * `stream_options.include_usage` 才带 usage；某些兼容实现干脆不返回。
   * 这个数字如实告诉用户"有一部分调用没算进 token"。
   */
  callsWithoutUsage: number
  byKind: Record<string, UsageByKind>
}

let totals: UsageTotals = empty()

function empty(): UsageTotals {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, callsWithoutUsage: 0, byKind: {} }
}

/** 开始新一轮统计（生成开始时调用；也会清掉上一轮残留） */
export function beginUsageSession(): void {
  totals = empty()
}

/**
 * 记录一次调用。`usage` 缺失时只累计调用次数并计入 `callsWithoutUsage`——
 * **不猜** token（猜出来的数字比没有更糟：用户会拿它算钱）。
 */
export function recordUsage(kind: string, usage?: ChatUsage): void {
  const key = kind || 'misc'
  totals.calls += 1
  const bucket = (totals.byKind[key] ??= { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 })
  bucket.calls += 1
  if (!usage) {
    totals.callsWithoutUsage += 1
    return
  }
  totals.promptTokens += usage.promptTokens
  totals.completionTokens += usage.completionTokens
  totals.totalTokens += usage.totalTokens
  bucket.promptTokens += usage.promptTokens
  bucket.completionTokens += usage.completionTokens
  bucket.totalTokens += usage.totalTokens
}

/** 读取当前累计（返回副本，避免调用方改到内部状态） */
export function getUsageTotals(): UsageTotals {
  return {
    ...totals,
    byKind: Object.fromEntries(Object.entries(totals.byKind).map(([k, v]) => [k, { ...v }]))
  }
}

/** 给日志/汇总用的一句话（中文，纯文本；界面不做 Markdown 渲染） */
export function describeUsage(t: UsageTotals): string {
  if (t.calls === 0) return '本轮未调用大模型'
  const parts = [`本轮调用大模型 ${t.calls} 次`]
  if (t.callsWithoutUsage === t.calls) {
    parts.push('Provider 未返回 token 用量，无法统计 token')
  } else {
    parts.push(`输入 ${formatTokens(t.promptTokens)}、输出 ${formatTokens(t.completionTokens)} token`)
    if (t.callsWithoutUsage > 0) parts.push(`其中 ${t.callsWithoutUsage} 次未返回用量`)
  }
  return parts.join('，')
}

/**
 * 「本次追问」的一句话（2026-11-03）：对话追问是一次**独立会话**（导航 N 次 + 作答 1–2 次），
 * 措辞与"生成汇总"分开，避免用户把两次动作的用量混在一起。**没有调用就返回空串**（不写"调用 0 次"），
 * 部分调用没拿回 usage 时照实说明——**绝不猜 token**。
 */
export function describeDocChatUsage(t: UsageTotals): string {
  if (t.calls === 0) return ''
  const parts = [`本次追问调用大模型 ${t.calls} 次`]
  if (t.callsWithoutUsage === t.calls) {
    parts.push('（Provider 未返回 token 用量）')
  } else {
    parts.push(`，输入 ${formatTokens(t.promptTokens)}、输出 ${formatTokens(t.completionTokens)} token`)
    if (t.callsWithoutUsage > 0) parts.push(`（其中 ${t.callsWithoutUsage} 次未返回用量）`)
  }
  return parts.join('')
}

/** token 数量的人类可读写法（万为界；面向普通用户，不用 M/k） */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 10000) return String(Math.round(n))
  return (n / 10000).toFixed(n >= 1000000 ? 0 : 1) + ' 万'
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeEach } = import.meta.vitest

  describe('usage（大模型用量账本）', () => {
    beforeEach(() => beginUsageSession())

    it('按阶段累计 token 与调用次数', () => {
      recordUsage('extract', { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 })
      recordUsage('extract', { promptTokens: 500, completionTokens: 100, totalTokens: 600 })
      recordUsage('contradiction-scan', { promptTokens: 300, completionTokens: 50, totalTokens: 350 })
      const t = getUsageTotals()
      expect(t.calls).toBe(3)
      expect(t.promptTokens).toBe(1800)
      expect(t.completionTokens).toBe(350)
      expect(t.totalTokens).toBe(2150)
      expect(t.byKind.extract).toEqual({ calls: 2, promptTokens: 1500, completionTokens: 300, totalTokens: 1800 })
      expect(t.byKind['contradiction-scan'].totalTokens).toBe(350)
    })

    it('没有 usage 的调用只计次数、并如实标注（绝不猜 token）', () => {
      recordUsage('detailed-read')
      recordUsage('detailed-read', { promptTokens: 10, completionTokens: 1, totalTokens: 11 })
      const t = getUsageTotals()
      expect(t.calls).toBe(2)
      expect(t.callsWithoutUsage).toBe(1)
      expect(t.totalTokens).toBe(11)
      expect(t.byKind['detailed-read'].calls).toBe(2)
    })

    it('beginUsageSession 清零；getUsageTotals 返回副本（改它不影响内部）', () => {
      recordUsage('misc', { promptTokens: 5, completionTokens: 5, totalTokens: 10 })
      const copy = getUsageTotals()
      copy.totalTokens = 999
      copy.byKind.misc.totalTokens = 999
      expect(getUsageTotals().totalTokens).toBe(10)
      expect(getUsageTotals().byKind.misc.totalTokens).toBe(10)
      beginUsageSession()
      expect(getUsageTotals().calls).toBe(0)
    })

    it('追问的一句话：0 次不写、缺 usage 只说次数、部分缺失照实标注', () => {
      expect(describeDocChatUsage(getUsageTotals())).toBe('')
      recordUsage('compilation-nav')
      expect(describeDocChatUsage(getUsageTotals())).toBe('本次追问调用大模型 1 次（Provider 未返回 token 用量）')
      recordUsage('compilation-doc-edit', { promptTokens: 120000, completionTokens: 800, totalTokens: 120800 })
      const s = describeDocChatUsage(getUsageTotals())
      expect(s).toContain('2 次')
      expect(s).toContain('输入 12.0 万')
      expect(s).toContain('其中 1 次未返回用量')
    })
    it('一句话汇总与 token 格式化', () => {
      expect(describeUsage(getUsageTotals())).toContain('未调用大模型')
      recordUsage('extract', { promptTokens: 123456, completionTokens: 7890, totalTokens: 131346 })
      const text = describeUsage(getUsageTotals())
      expect(text).toContain('1 次')
      expect(text).toContain('12.3 万')
      expect(text).toContain('7890')
      expect(formatTokens(0)).toBe('0')
      expect(formatTokens(999)).toBe('999')
      expect(formatTokens(10000)).toBe('1.0 万')
      expect(formatTokens(1234567)).toBe('123 万')
    })
  })
}
