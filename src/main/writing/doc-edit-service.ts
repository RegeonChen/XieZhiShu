/**
 * doc-edit-service.ts —— 「与文档对话」的编辑协议（Phase 7.5，2026-09-10）。
 *
 * 用户裁定 D3：大模型**以 ops 引用段 id** 返回修改（而不是整篇重写），软件逐条校验后再应用。
 * 本文件只放**纯函数**：提交物构造、输出解析、逐条校验、按序应用。
 * 落库、版本记录、对话记录、乐观锁在 IPC handler 里做（见 main/index.ts）。
 *
 * 校验规则（任一不过 → 该条 op 被拒绝并记入 rejected，其它 op 照常应用）：
 * ① 段 id 必须存在；② `sourceOrdinal` 必须在 1..N；
 * ③ 新增/改写文本里的**数字必须能在该来源的原文中找到**（防幻觉，与整合提取同口径）；
 * ④ merge 仅限同一来源；⑤ 不得删空整篇文档；⑥ 不支持的 op 直接拒绝。
 */
import type { ChatMessage } from '../llm/chat'
import { numbersCoveredBy, parseTimeLabel, withFallbackYear } from './compilation-document'
import { buildCandidateSection, checkInsertEvidence, type LeakCandidate } from './leak-candidates'

/** 提交给大模型的段落视图（`key` = 提示词里的稳定短标识 p12；`id` = 数据库段 id） */
export interface DocEditParagraphRef {
  key: string
  id: string
  text: string
  timeLabel?: string
  sourceOrdinal?: number
  sourceTitle?: string
  /**
   * 该段的**逐字证据引文**（Phase 9 来源定位的首选依据）。
   * ⚠ 必须随对话编辑一起写回：落库函数 `upsertCompilationParagraphs` 写的是
   * `evidence = it.evidence ?? null`，2026-10-03 实测（真实库副本）发现**一次对话编辑会把全篇
   * evidence 从 121 段清成 0 段**——因为这条链路原本没带这个字段。正文被改写过的段落证据不再成立，
   * 这里按 `applyDocOps` 的规则清空（见该函数注释），未改动段落原样保留。
   */
  evidence?: string
  /**
   * 并列来源编号与 id（Phase 7.12）：同一件事的其它出处。
   * **不进提示词**（大模型只按主来源判断数字有据），只用于落库时把并列来源原样写回，
   * 否则任何一次对话修改都会把"另一个出处"抹掉。
   */
  alsoSourceOrdinals?: number[]
  alsoSourceIds?: string[]
}

/** 大模型返回的一条操作 */
export interface DocEditOp {
  op: 'delete' | 'replace' | 'insertAfter' | 'move' | 'merge' | 'split' | 'setTime' | 'replaceAll'
  /** delete / move / merge 用 */
  ids?: string[]
  /** replace / split / setTime 用 */
  id?: string
  /** insertAfter / move 的锚点 */
  afterId?: string
  text?: string
  timeLabel?: string
  /** insertAfter 必填：新段归属的来源编号 */
  sourceOrdinal?: number
  /** split：按字符偏移切分 */
  at?: number
  /**
   * 补漏（B 方案）：新增段落的**唯一依据**——资料库检索候选的编号（如 c3）。
   * 给了它就必须同时给 `evidence`，本地会校验 evidence 逐字出自该候选原文。
   */
  candidateKey?: string
  /** 给 insertAfter 的逐字原文（≥12 字）：来自候选原文，或来自当前文档/该来源原文 */
  evidence?: string
  /**
   * 用户**明确要求**修改某个数字/数值时置 true → 跳过"数字必须来自来源"的本地校验。
   * 用户裁定（2026-09-10）："如果用户明确要求修改某个数字，那么不应该再进行校验，大模型和软件都照做即可。"
   * 提示词要求仅在用户点名某个具体数值时才加此字段；软件完全信任它（不再二次判断）。
   */
  allowNewNumbers?: boolean
  /** replaceAll：整篇重写 */
  paragraphs?: { text: string; timeLabel?: string; sourceOrdinal?: number; allowNewNumbers?: boolean }[]
}

export interface DocEditParsed {
  reply: string
  ops: DocEditOp[]
}

/** 解析大模型输出：只接受一个 JSON 对象 `{reply, ops}`（容忍代码块围栏/前后夹带文字） */
export function parseDocEditOutput(text: string): DocEditParsed | null {
  const trimmed = (text ?? '').trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1].trim() : trimmed
  let raw: unknown = null
  try {
    raw = JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      raw = JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { reply?: unknown; ops?: unknown }
  if (!Array.isArray(obj.ops)) return null
  const ops: DocEditOp[] = []
  for (const item of obj.ops) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const op = o.op
    if (typeof op !== 'string') continue
    const entry: DocEditOp = { op: op as DocEditOp['op'] }
    if (Array.isArray(o.ids)) entry.ids = o.ids.filter((x): x is string => typeof x === 'string')
    if (typeof o.id === 'string') entry.id = o.id
    if (typeof o.afterId === 'string') entry.afterId = o.afterId
    if (typeof o.text === 'string') entry.text = o.text
    if (typeof o.timeLabel === 'string') entry.timeLabel = o.timeLabel
    if (typeof o.sourceOrdinal === 'number') entry.sourceOrdinal = o.sourceOrdinal
    if (typeof o.at === 'number') entry.at = o.at
    if (o.allowNewNumbers === true) entry.allowNewNumbers = true
    if (Array.isArray(o.paragraphs)) {
      entry.paragraphs = o.paragraphs
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map((p) => ({
          text: typeof p.text === 'string' ? p.text : '',
          timeLabel: typeof p.timeLabel === 'string' ? p.timeLabel : undefined,
          sourceOrdinal: typeof p.sourceOrdinal === 'number' ? p.sourceOrdinal : undefined,
          allowNewNumbers: p.allowNewNumbers === true ? true : undefined
        }))
    }
    ops.push(entry)
  }
  return { reply: typeof obj.reply === 'string' ? obj.reply : '', ops }
}

export interface DocEditValidation {
  accepted: DocEditOp[]
  rejected: { op: string; reason: string }[]
}

/**
 * 逐条校验 ops（纯函数，可测试）。`sourceTextByOrdinal` 用于数字校验（来源编号 → 该来源原文），
 * 由 IPC handler 从数据库取（来源正文 + 该来源当前段落文本拼成）。
 */
export function validateDocOps(
  ops: DocEditOp[],
  paragraphs: DocEditParagraphRef[],
  sourceTextByOrdinal: Map<number, string>,
  /** 补漏候选（B 方案）：带 `candidateKey` 的新增段落必须逐字出自候选原文 */
  candidates: LeakCandidate[] = []
): DocEditValidation {
  const byKey = new Map(paragraphs.map((p) => [p.key, p]))
  const maxOrdinal = paragraphs.reduce((max, p) => Math.max(max, p.sourceOrdinal ?? 0), 0)
  const accepted: DocEditOp[] = []
  const rejected: { op: string; reason: string }[] = []
  const reject = (op: DocEditOp, reason: string): void => {
    rejected.push({ op: op.op, reason })
  }
  /**
   * 文本里的数字是否都能在该来源原文中找到。
   * `allowNewNumbers`（用户明确要求改数字）为 true 时**直接放行**——用户裁定"大模型和软件都照做"。
   */
  const numbersOk = (text: string, ordinal: number | undefined, allowNewNumbers?: boolean): boolean => {
    if (allowNewNumbers === true) return true
    if (ordinal == null) return true
    const source = sourceTextByOrdinal.get(ordinal)
    if (!source) return true // 拿不到来源原文时不做数字校验（不误杀）
    return numbersCoveredBy(text, source)
  }
  const ordinalOk = (ordinal: number | undefined): boolean => ordinal == null || (ordinal >= 1 && ordinal <= Math.max(1, maxOrdinal))

  const deleting = new Set<string>()
  for (const op of ops) {
    const keysOf = (list: string[] | undefined): DocEditParagraphRef[] =>
      (list ?? []).map((k) => byKey.get(k)).filter((p): p is DocEditParagraphRef => !!p)
    switch (op.op) {
      case 'delete': {
        const targets = keysOf(op.ids)
        if (targets.length === 0) {
          reject(op, '没有找到要删除的段落')
          break
        }
        targets.forEach((t) => deleting.add(t.key))
        // 不得删空整篇文档
        if (paragraphs.length - deleting.size <= 0) {
          targets.forEach((t) => deleting.delete(t.key))
          reject(op, '不能删除全部段落')
          break
        }
        accepted.push(op)
        break
      }
      case 'replace':
      case 'setTime':
      case 'split': {
        const target = op.id ? byKey.get(op.id) : undefined
        if (!target) {
          reject(op, '段落不存在')
          break
        }
        if (op.op !== 'setTime' && typeof op.text === 'string' && !numbersOk(op.text, target.sourceOrdinal, op.allowNewNumbers)) {
          reject(op, '正文里的数字在来源原文中找不到（疑似编造）')
          break
        }
        if (op.op === 'split' && (typeof op.at !== 'number' || op.at <= 0 || !op.text || op.at >= op.text.length)) {
          reject(op, '拆分位置无效')
          break
        }
        if (!ordinalOk(op.sourceOrdinal)) {
          reject(op, '来源编号超出范围')
          break
        }
        accepted.push(op)
        break
      }
      case 'insertAfter': {
        const anchor = op.afterId ? byKey.get(op.afterId) : undefined
        if (!anchor) {
          reject(op, '插入位置（afterId）不存在')
          break
        }
        if (!op.text || !op.text.trim()) {
          reject(op, '新增内容为空')
          break
        }
        // 带候选编号时来源由候选决定（软件自动归属），无需模型给 sourceOrdinal
        if (!op.candidateKey && !ordinalOk(op.sourceOrdinal)) {
          reject(op, '来源编号超出范围')
          break
        }
        /*
         * B 方案（2026-10-03）：新增段落必须"有据"——
         * 依据要么是本地检索出的候选原文（带 candidateKey），要么是当前汇编段落／该来源原文；
         * evidence 必须逐字命中（≥12 字），数字也必须在依据原文里。凭空写的会被这条拦下。
         */
        const evidenceReason = checkInsertEvidence(
          op,
          candidates,
          paragraphs.map((p) => p.text),
          sourceTextByOrdinal
        )
        if (evidenceReason) {
          reject(op, evidenceReason)
          break
        }
        if (!numbersOk(op.text, op.sourceOrdinal, op.allowNewNumbers)) {
          reject(op, '正文里的数字在来源原文中找不到（疑似编造）')
          break
        }
        accepted.push(op)
        break
      }
      case 'move': {
        const targets = keysOf(op.ids)
        if (targets.length === 0 || !op.afterId || !byKey.get(op.afterId)) {
          reject(op, '移动目标或落点不存在')
          break
        }
        accepted.push(op)
        break
      }
      case 'merge': {
        const targets = keysOf(op.ids)
        if (targets.length < 2) {
          reject(op, '合并至少需要两段')
          break
        }
        const ordinals = new Set(targets.map((t) => t.sourceOrdinal ?? -1))
        if (ordinals.size > 1) {
          reject(op, '只能合并同一来源的段落')
          break
        }
        accepted.push(op)
        break
      }
      case 'replaceAll': {
        const list = op.paragraphs ?? []
        if (list.length === 0) {
          reject(op, '整篇重写内容为空')
          break
        }
        const badOrdinal = list.find((p) => !ordinalOk(p.sourceOrdinal))
        if (badOrdinal) {
          reject(op, '来源编号超出范围')
          break
        }
        const badNumber = list.find((p) => !numbersOk(p.text, p.sourceOrdinal, p.allowNewNumbers))
        if (badNumber) {
          reject(op, '正文里的数字在来源原文中找不到（疑似编造）')
          break
        }
        accepted.push(op)
        break
      }
      default:
        reject(op, '不支持的操作类型')
    }
  }
  return { accepted, rejected }
}

/**
 * 按序应用 ops（纯函数，可测试）。返回新的段落数组（key 保持稳定；新增段落获得新 key）。
 * 时间字段（year/month/timeConfidence）在应用后按 `timeLabel` 重算——与整合提取同口径（年鉴年份 −1 兜底）。
 */
export function applyDocOps(paragraphs: DocEditParagraphRef[], ops: DocEditOp[]): DocEditParagraphRef[] {
  let list = paragraphs.map((p) => ({ ...p }))
  let nextKeyNo = list.length + 1
  const newRef = (
    text: string,
    timeLabel: string | undefined,
    sourceOrdinal: number | undefined,
    evidence?: string
  ): DocEditParagraphRef => {
    const ordinal = sourceOrdinal ?? list[list.length - 1]?.sourceOrdinal
    const template = list.find((p) => p.sourceOrdinal === ordinal)
    const key = 'p' + nextKeyNo++
    nextKeyNo += 0
    return {
      key,
      id: '',
      text,
      timeLabel,
      sourceOrdinal: ordinal,
      sourceTitle: template?.sourceTitle,
      evidence
    }
  }
  /**
   * 证据引文的去留（2026-10-03 修）：它是来源定位的首选依据，只有**正文未被改动**时才继续成立。
   * - `setTime` / `move`：正文没变 → 原样保留（spread 天然保留）；
   * - `replace`：正文被改写 → 旧证据不再描述这段文字，清空（有 `evidence` 则用新的）；
   * - `merge` / `split`：文字被重新组合/切开 → 旧证据只覆盖其中一部分，清空；
   * - `insertAfter`：新段 → 用 op 给的 evidence（补漏时必须逐字来自候选原文，见 validateDocOps）。
   */
  for (const op of ops) {
    switch (op.op) {
      case 'delete': {
        const ids = new Set(op.ids ?? [])
        list = list.filter((p) => !ids.has(p.key))
        break
      }
      case 'replace': {
        list = list.map((p) =>
          p.key === op.id && typeof op.text === 'string'
            ? { ...p, text: op.text, timeLabel: op.timeLabel ?? p.timeLabel, evidence: op.evidence }
            : p
        )
        break
      }
      case 'setTime': {
        list = list.map((p) => (p.key === op.id && op.timeLabel ? { ...p, timeLabel: op.timeLabel } : p))
        break
      }
      case 'insertAfter': {
        const at = list.findIndex((p) => p.key === op.afterId)
        if (at < 0 || !op.text) break
        list.splice(at + 1, 0, newRef(op.text, op.timeLabel, op.sourceOrdinal, op.evidence))
        break
      }
      case 'move': {
        const moving = list.filter((p) => (op.ids ?? []).includes(p.key))
        if (moving.length === 0) break
        list = list.filter((p) => !(op.ids ?? []).includes(p.key))
        const at = list.findIndex((p) => p.key === op.afterId)
        list.splice(at < 0 ? list.length : at + 1, 0, ...moving)
        break
      }
      case 'merge': {
        const ids = op.ids ?? []
        const first = list.findIndex((p) => p.key === ids[0])
        const targets = list.filter((p) => ids.includes(p.key))
        if (first < 0 || targets.length < 2) break
        const merged: DocEditParagraphRef = {
          ...targets[0],
          text: targets.map((t) => t.text).join(''),
          timeLabel: targets[0].timeLabel,
          evidence: undefined
        }
        list = list.filter((p) => !ids.includes(p.key))
        const at = Math.min(first, list.length)
        list.splice(at, 0, merged)
        break
      }
      case 'split': {
        const idx = list.findIndex((p) => p.key === op.id)
        if (idx < 0 || !op.text || typeof op.at !== 'number') break
        const left: DocEditParagraphRef = { ...list[idx], text: op.text.slice(0, op.at), evidence: undefined }
        const right: DocEditParagraphRef = { ...list[idx], key: 'p' + nextKeyNo++, text: op.text.slice(op.at), evidence: undefined }
        list.splice(idx, 1, left, right)
        break
      }
      case 'replaceAll': {
        list = (op.paragraphs ?? []).map((p, i) => ({
          key: 'p' + (i + 1),
          id: list[i]?.id ?? '',
          text: p.text,
          timeLabel: p.timeLabel,
          sourceOrdinal: p.sourceOrdinal ?? list[i]?.sourceOrdinal,
          sourceTitle: list[i]?.sourceTitle,
          evidence: undefined
        }))
        break
      }
      default:
        break
    }
  }
  return list
}

/** 提交物：id 化的当前文档 + 允许的来源编号清单 */
export function buildDocEditMessages(
  paragraphs: DocEditParagraphRef[],
  instruction: string,
  sources: { ordinal: number; title: string }[],
  /**
   * 补漏（B 方案）上下文：
   * - `requirement`：用户那条撰写要求全文（判断取舍的参照，避免改稿时偏离主题）；
   * - `candidates`：本地检索出的候选原文（新增段落的唯一依据，见 `leak-candidates.ts`）。
   */
  context: { requirement?: string; candidates?: LeakCandidate[] } = {}
): ChatMessage[] {
  const requirement = (context.requirement ?? '').trim()
  const candidates = context.candidates ?? []
  const doc = paragraphs
    .map((p) => '[' + p.key + '] ' + (p.timeLabel ?? '（无时间）') + ' | 来源' + (p.sourceOrdinal ?? '?') + ' | ' + p.text)
    .join('\n')
  const sys = [
    '你是一名志书「资料汇编」编辑助手。用户会对当前资料汇编提出修改要求，你**修改文档**并回答用户。',
    '',
    '【当前资料汇编】（每段一行：`[段号] 时间 | 来源N | 正文`）',
    doc,
    '',
    '【可引用的来源编号】',
    sources.map((s) => '来源' + s.ordinal + '：《' + s.title + '》').join('\n') || '（无）',
    '',
    ...(requirement ? ['【用户的撰写要求（原文，改稿要与它一致）】', requirement, ''] : []),
    buildCandidateSection(candidates),
    '',
    '【规则】',
    '1. 只输出一个 JSON 对象：{"reply":"给用户看的回答","ops":[…] }，不要输出解释性文字或代码块围栏。',
    '2. 修改必须通过 ops 表达，**用段号引用段落**（如 p12）：',
    '   · {"op":"delete","ids":["p3"]} 删除段落；',
    '   · {"op":"replace","id":"p3","text":"新正文","timeLabel":"2018 年"} 改写某段；',
    '   · {"op":"insertAfter","afterId":"p3","text":"新段正文","timeLabel":"2019 年","sourceOrdinal":2,"evidence":"依据原文里逐字摘出的片段","candidateKey":"c3"} 在某段后插入（**必须给 evidence**；补漏时必须给 candidateKey，此时 sourceOrdinal 可省略，软件按候选自动归属来源）；',
    '   · {"op":"move","ids":["p5"],"afterId":"p9"} 移动段落；',
    '   · {"op":"merge","ids":["p5","p6"]} 合并（**仅限同一来源**）；',
    '   · {"op":"split","id":"p5","at":30,"text":"该段完整正文"} 按字符位置拆分；',
    '   · {"op":"setTime","id":"p5","timeLabel":"2019 年"} 只改段首时间。',
    '3. **不得编造事实**：正文里的数字、日期、人名、地名必须来自该段所属来源；不得凭空增加数据。',
    '   **唯一例外**：用户**明确要求**把某个数字/数值改成指定值时（如"把在校生数改成 5000 人"），',
    '   照做即可，不要因为来源里没有这个数字就拒绝或改成别的值；此时必须在该 op 上加 `"allowNewNumbers":true`，',
    '   软件会据此跳过数字校验。**只有用户点名具体数值时才能加这个字段**，其它任何情况一律不加，',
    '   绝不可用它给自己的推测、估算、补齐数据开口子。',
    '4. **新增段落必须"有据"**（本地会逐字校验，编造的一律被拒）：',
    '   · 用户的意思是"资料库里还有材料、你漏了"这类**补漏**时：只能从上面的候选原文里取，并给出 `candidateKey` 与逐字 `evidence`（≥12 字）；',
    '     **候选里没有需要的原文时不要新增**，只在 reply 里说明"资料库检索结果里没有相关内容"。',
    '   · 只是搬运/重排已有内容时：`evidence` 必须逐字出自当前汇编的某个段落或该段所属来源的原文。',
    '5. 时间标签必须含 4 位年份（如「2018 年」「2018 年 5 月」）。',
    '6. 不要删除用户没有要求删除的内容；改动尽量小、贴合用户要求。',
    '7. 若用户的要求无法用上述 ops 表达，则不要输出任何 op，只在 reply 里说明原因。'
  ].join('\n')
  return [
    { role: 'system', content: sys },
    { role: 'user', content: instruction }
  ]
}

/**
 * 统计"本次改动"（纯函数，供 handler 组装回给前端的摘要）。
 * 新增/改写按**文本比对**得出；只改时间/位置（文本不变，如 setTime / move / merge）按 op 目标补记，
 * 否则这些改动在前端不会高亮、也不会被滚动到。
 */
export function collectDocEditChange(
  before: DocEditParagraphRef[],
  after: DocEditParagraphRef[],
  accepted: DocEditOp[]
): { changedIds: string[]; added: number; modified: number; removed: number } {
  const prevById = new Map(before.map((r) => [r.id, r.text]))
  const afterIds = new Set(after.map((r) => r.id))
  const changedIds: string[] = []
  let added = 0
  let modified = 0
  for (const p of after) {
    const prev = prevById.get(p.id)
    if (prev === undefined) {
      added++
      if (p.id) changedIds.push(p.id)
    } else if (prev !== p.text) {
      modified++
      if (p.id) changedIds.push(p.id)
    }
  }
  const removed = before.filter((r) => !afterIds.has(r.id)).length
  const touched: string[] = []
  for (const op of accepted) {
    if (op.op === 'setTime' && op.id) touched.push(op.id)
    else if (op.op === 'move' || op.op === 'merge') touched.push(...(op.ids ?? []))
  }
  for (const key of touched) {
    const id = after.find((p) => p.key === key)?.id
    if (id && !changedIds.includes(id)) changedIds.push(id)
  }
  return { changedIds, added, modified, removed }
}

/** 段首时间兜底（供 handler 在应用后重算 year/confidence，与整合提取同口径） */
export function resolveTimeForEdit(
  timeLabel: string | undefined,
  sourceTitle: string | undefined,
  source?: { kind?: 'file' | 'url'; publishedAt?: string | null }
): {
  year?: number
  month?: number
  day?: number
  timeConfidence: 'exact' | 'inferred' | 'unknown'
} {
  const t = withFallbackYear(timeLabel, sourceTitle, source)
  return { year: t.year, month: t.month, day: t.day, timeConfidence: t.timeConfidence }
}

/** 仅用于测试/调试：把段落文本按 `parseTimeLabel` 解析出的年份（无年份返回 undefined） */
export function yearOfLabel(timeLabel: string | undefined): number | undefined {
  return parseTimeLabel(timeLabel).year
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  const paras: DocEditParagraphRef[] = [
    { key: 'p1', id: 'id1', text: '2018 年，全区普通中学 30 所。', timeLabel: '2018 年', sourceOrdinal: 1, sourceTitle: '长乐年鉴2019' },
    { key: 'p2', id: 'id2', text: '2019 年，全区教职工 900 人。', timeLabel: '2019 年', sourceOrdinal: 2, sourceTitle: '长乐年鉴2020' },
    { key: 'p3', id: 'id3', text: '2020 年，全区幼儿园 212 所。', timeLabel: '2020 年', sourceOrdinal: 2, sourceTitle: '长乐年鉴2020' }
  ]
  const sourceText = new Map<number, string>([
    [1, '2018 年，全区普通中学 30 所，独立高中 1 所。'],
    [2, '2019 年，全区教职工 900 人。2020 年，全区幼儿园 212 所。']
  ])

  describe('doc edit service (Phase 7.5 人机协同编辑协议)', () => {
    it('parses the {reply, ops} protocol, tolerating fences and surrounding text', () => {
      const ok = parseDocEditOutput('{"reply":"已删除","ops":[{"op":"delete","ids":["p3"]}]}')!
      expect(ok.reply).toBe('已删除')
      expect(ok.ops).toHaveLength(1)
      expect(parseDocEditOutput('好的：{"reply":"x","ops":[]} 以上')!.reply).toBe('x')
      expect(parseDocEditOutput('```json\n{"reply":"y","ops":[{"op":"setTime","id":"p1","timeLabel":"2018 年"}]}\n```')!.ops).toHaveLength(1)
      expect(parseDocEditOutput('没有 JSON')).toBeNull()
      expect(parseDocEditOutput('{"reply":"缺 ops"}')).toBeNull()
    })

    it('rejects ops with unknown ids, out-of-range ordinals and invented numbers', () => {
      const { accepted, rejected } = validateDocOps(
        [
          { op: 'delete', ids: ['pX'] },
          { op: 'replace', id: 'p1', text: '2018 年，全区普通中学 32 所。' }, // 32 不在来源里
          { op: 'insertAfter', afterId: 'p1', text: '新增一段。', sourceOrdinal: 9 }, // 编号超范围
          { op: 'merge', ids: ['p1', 'p2'] }, // 跨来源
          { op: 'setTime', id: 'p2', timeLabel: '2019 年' }
        ],
        paras,
        sourceText
      )
      expect(accepted.map((o) => o.op)).toEqual(['setTime'])
      expect(rejected.map((r) => r.reason)).toEqual([
        '没有找到要删除的段落',
        '正文里的数字在来源原文中找不到（疑似编造）',
        '来源编号超出范围',
        '只能合并同一来源的段落'
      ])
    })

    it('skips the number check when the user explicitly asked for that number (allowNewNumbers)', () => {
      // 用户点名"把 30 所改成 32 所" → 模型照做并在 op 上标 allowNewNumbers，软件不再拦
      const asked = validateDocOps(
        [{ op: 'replace', id: 'p1', text: '2018 年，全区普通中学 32 所。', allowNewNumbers: true }],
        paras,
        sourceText
      )
      expect(asked.accepted).toHaveLength(1)
      expect(asked.rejected).toHaveLength(0)
      // 插入同样支持；整篇重写按段落各自判断（插入还要给 evidence，见下一条规则）
      expect(
        validateDocOps(
          [
            {
              op: 'insertAfter',
              afterId: 'p1',
              text: '2018 年，全区普通中学 32 所。',
              sourceOrdinal: 1,
              allowNewNumbers: true,
              evidence: '2018 年，全区普通中学 30 所'
            }
          ],
          paras,
          sourceText
        ).accepted
      ).toHaveLength(1)
      const all = validateDocOps(
        [{ op: 'replaceAll', paragraphs: [{ text: '全区 999 所。', sourceOrdinal: 1, allowNewNumbers: true }, { text: '甲。', sourceOrdinal: 1 }] }],
        paras,
        sourceText
      )
      expect(all.accepted).toHaveLength(1)
      // 未标豁免的段落仍然被拦（不会因为同批里有豁免就整体放行）
      const mixed = validateDocOps([{ op: 'replaceAll', paragraphs: [{ text: '全区 999 所。', sourceOrdinal: 1 }] }], paras, sourceText)
      expect(mixed.rejected[0].reason).toBe('正文里的数字在来源原文中找不到（疑似编造）')
      // 解析层要能读到这个字段（模型写 true 才生效，写别的值不算）
      expect(parseDocEditOutput('{"reply":"x","ops":[{"op":"replace","id":"p1","text":"2018 年 32 所。","allowNewNumbers":true}]}')!.ops[0].allowNewNumbers).toBe(true)
      expect(parseDocEditOutput('{"reply":"x","ops":[{"op":"replace","id":"p1","text":"a","allowNewNumbers":"yes"}]}')!.ops[0].allowNewNumbers).toBeUndefined()
    })

    it('never lets an op delete the whole document', () => {
      const { accepted, rejected } = validateDocOps([{ op: 'delete', ids: ['p1', 'p2', 'p3'] }], paras, sourceText)
      expect(accepted).toHaveLength(0)
      expect(rejected[0].reason).toBe('不能删除全部段落')
      // 保留至少一段的删除则通过
      expect(validateDocOps([{ op: 'delete', ids: ['p1', 'p2'] }], paras, sourceText).accepted).toHaveLength(1)
    })

    it('applies delete / replace / insertAfter / move / setTime / split / merge in order', () => {
      // 删除 + 改写
      const afterDelete = applyDocOps(paras, [{ op: 'delete', ids: ['p2'] }])
      expect(afterDelete.map((p) => p.key)).toEqual(['p1', 'p3'])
      const afterReplace = applyDocOps(paras, [{ op: 'replace', id: 'p1', text: '改后正文。', timeLabel: '2018 年' }])
      expect(afterReplace[0].text).toBe('改后正文。')
      // 插入：紧跟锚点之后，且继承来源
      const afterInsert = applyDocOps(paras, [{ op: 'insertAfter', afterId: 'p1', text: '新段。', timeLabel: '2018 年', sourceOrdinal: 1 }])
      expect(afterInsert.map((p) => p.text)).toEqual([paras[0].text, '新段。', paras[1].text, paras[2].text])
      expect(afterInsert[1].sourceOrdinal).toBe(1)
      // 移动：把 p3 移到 p1 之后
      expect(applyDocOps(paras, [{ op: 'move', ids: ['p3'], afterId: 'p1' }]).map((p) => p.key)).toEqual(['p1', 'p3', 'p2'])
      // 只改时间
      expect(applyDocOps(paras, [{ op: 'setTime', id: 'p3', timeLabel: '2021 年' }])[2].timeLabel).toBe('2021 年')
      // 拆分 / 合并
      const split = applyDocOps(paras, [{ op: 'split', id: 'p1', at: 6, text: paras[0].text }])
      expect(split).toHaveLength(4)
      expect(split[0].text + split[1].text).toBe(paras[0].text)
      const merged = applyDocOps(paras, [{ op: 'merge', ids: ['p2', 'p3'] }])
      expect(merged).toHaveLength(2)
      expect(merged[1].text).toBe(paras[1].text + paras[2].text)
      // 整篇重写
      const all = applyDocOps(paras, [{ op: 'replaceAll', paragraphs: [{ text: '甲。', timeLabel: '2018 年', sourceOrdinal: 1 }] }])
      expect(all).toHaveLength(1)
      expect(all[0].text).toBe('甲。')
    })

    it('states the protocol and the no-fabrication rule in the prompt', () => {
      const sys = buildDocEditMessages(paras, '删掉幼儿园那段', [{ ordinal: 1, title: '长乐年鉴2019' }])[0].content
      expect(sys).toContain('[p1]')
      expect(sys).toContain('"reply"')
      expect(sys).toContain('"op":"delete"')
      expect(sys).toContain('不得编造事实')
      expect(sys).toContain('allowNewNumbers')
      expect(sys).toContain('必须给 evidence')
      expect(buildDocEditMessages(paras, 'x', [])[1].content).toBe('x')
    })

    it('reports what changed for the UI (highlight + scroll): text diff plus setTime/move/merge targets', () => {
      // 删除 p2 + 改写 p1
      const delReplace = applyDocOps(paras, [
        { op: 'delete', ids: ['p2'] },
        { op: 'replace', id: 'p1', text: '2018 年，全区普通中学 30 所（含独立高中）。', timeLabel: '2018 年' }
      ])
      const r1 = collectDocEditChange(paras, delReplace, [
        { op: 'delete', ids: ['p2'] },
        { op: 'replace', id: 'p1', text: '2018 年，全区普通中学 30 所（含独立高中）。' }
      ])
      expect(r1.removed).toBe(1)
      expect(r1.modified).toBe(1)
      expect(r1.added).toBe(0)
      expect(r1.changedIds).toEqual(['id1'])
      // insertAfter：新段数据库 id 由仓储分配（此处为空），但仍计入"新增"
      const ins = applyDocOps(paras, [{ op: 'insertAfter', afterId: 'p1', text: '新段。', sourceOrdinal: 1 }])
      const r2 = collectDocEditChange(paras, ins, [{ op: 'insertAfter', afterId: 'p1', text: '新段。', sourceOrdinal: 1 }])
      expect(r2.added).toBe(1)
      expect(r2.removed).toBe(0)
      // setTime：文本没变，也必须高亮（否则用户看不出这次改了什么）
      const timed = applyDocOps(paras, [{ op: 'setTime', id: 'p3', timeLabel: '2021 年' }])
      const r3 = collectDocEditChange(paras, timed, [{ op: 'setTime', id: 'p3', timeLabel: '2021 年' }])
      expect(r3).toEqual({ changedIds: ['id3'], added: 0, modified: 0, removed: 0 })
      // move：移动的段落要高亮，落点锚点不算改动
      const moved = applyDocOps(paras, [{ op: 'move', ids: ['p3'], afterId: 'p1' }])
      const r4 = collectDocEditChange(paras, moved, [{ op: 'move', ids: ['p3'], afterId: 'p1' }])
      expect(r4.changedIds).toEqual(['id3'])
      expect(r4.removed).toBe(0)
    })

    it('keeps evidence only where the text is untouched (Phase 9 来源定位，2026-10-03 修)', () => {
      const withEvidence: DocEditParagraphRef[] = paras.map((p, i) => ({ ...p, evidence: '证据' + (i + 1) }))
      // setTime / move：正文没变 → 证据保留（否则一次改时间就把来源定位抹掉）
      const timed = applyDocOps(withEvidence, [{ op: 'setTime', id: 'p1', timeLabel: '2022 年' }])
      expect(timed.find((p) => p.key === 'p1')!.evidence).toBe('证据1')
      const moved = applyDocOps(withEvidence, [{ op: 'move', ids: ['p1'], afterId: 'p2' }])
      expect(moved.find((p) => p.key === 'p1')!.evidence).toBe('证据1')
      // replace：正文被改写 → 旧证据不再成立，清空；给了新证据则用新的
      const replaced = applyDocOps(withEvidence, [{ op: 'replace', id: 'p1', text: '改写后的正文' }])
      expect(replaced.find((p) => p.key === 'p1')!.evidence).toBeUndefined()
      const replacedWithEv = applyDocOps(withEvidence, [
        { op: 'replace', id: 'p1', text: '改写后的正文', evidence: '候选原文片段' }
      ])
      expect(replacedWithEv.find((p) => p.key === 'p1')!.evidence).toBe('候选原文片段')
      // merge / split：文字被重新组合或切开 → 清空（合并段沿用 targets[0] 的 key）
      const merged = applyDocOps(withEvidence, [{ op: 'merge', ids: ['p1', 'p2'] }])
      expect(merged.find((p) => p.key === 'p1')!.evidence).toBeUndefined()
      const split = applyDocOps(withEvidence, [{ op: 'split', id: 'p1', at: 3, text: '2018 年全区' }])
      expect(split.filter((p) => p.text.startsWith('2018')).every((p) => p.evidence === undefined)).toBe(true)
      // 未被任何 op 触及的段落，证据必须原样保留（这是"全篇被清空"那个缺陷的回归护栏）
      expect(replacedWithEv.find((p) => p.key === 'p3')!.evidence).toBe('证据3')
    })
  })
}
