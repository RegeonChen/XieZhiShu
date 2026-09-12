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

/** 提交给大模型的段落视图（`key` = 提示词里的稳定短标识 p12；`id` = 数据库段 id） */
export interface DocEditParagraphRef {
  key: string
  id: string
  text: string
  timeLabel?: string
  sourceOrdinal?: number
  sourceTitle?: string
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
  /** replaceAll：整篇重写 */
  paragraphs?: { text: string; timeLabel?: string; sourceOrdinal?: number }[]
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
    if (Array.isArray(o.paragraphs)) {
      entry.paragraphs = o.paragraphs
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map((p) => ({
          text: typeof p.text === 'string' ? p.text : '',
          timeLabel: typeof p.timeLabel === 'string' ? p.timeLabel : undefined,
          sourceOrdinal: typeof p.sourceOrdinal === 'number' ? p.sourceOrdinal : undefined
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
  sourceTextByOrdinal: Map<number, string>
): DocEditValidation {
  const byKey = new Map(paragraphs.map((p) => [p.key, p]))
  const maxOrdinal = paragraphs.reduce((max, p) => Math.max(max, p.sourceOrdinal ?? 0), 0)
  const accepted: DocEditOp[] = []
  const rejected: { op: string; reason: string }[] = []
  const reject = (op: DocEditOp, reason: string): void => {
    rejected.push({ op: op.op, reason })
  }
  /** 文本里的数字是否都能在该来源原文中找到 */
  const numbersOk = (text: string, ordinal: number | undefined): boolean => {
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
        if (op.op !== 'setTime' && typeof op.text === 'string' && !numbersOk(op.text, target.sourceOrdinal)) {
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
        if (!ordinalOk(op.sourceOrdinal)) {
          reject(op, '来源编号超出范围')
          break
        }
        if (!numbersOk(op.text, op.sourceOrdinal)) {
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
        const badNumber = list.find((p) => !numbersOk(p.text, p.sourceOrdinal))
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
  const newRef = (text: string, timeLabel: string | undefined, sourceOrdinal: number | undefined): DocEditParagraphRef => {
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
      sourceTitle: template?.sourceTitle
    }
  }
  for (const op of ops) {
    switch (op.op) {
      case 'delete': {
        const ids = new Set(op.ids ?? [])
        list = list.filter((p) => !ids.has(p.key))
        break
      }
      case 'replace': {
        list = list.map((p) => (p.key === op.id && typeof op.text === 'string' ? { ...p, text: op.text, timeLabel: op.timeLabel ?? p.timeLabel } : p))
        break
      }
      case 'setTime': {
        list = list.map((p) => (p.key === op.id && op.timeLabel ? { ...p, timeLabel: op.timeLabel } : p))
        break
      }
      case 'insertAfter': {
        const at = list.findIndex((p) => p.key === op.afterId)
        if (at < 0 || !op.text) break
        list.splice(at + 1, 0, newRef(op.text, op.timeLabel, op.sourceOrdinal))
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
          timeLabel: targets[0].timeLabel
        }
        list = list.filter((p) => !ids.includes(p.key))
        const at = Math.min(first, list.length)
        list.splice(at, 0, merged)
        break
      }
      case 'split': {
        const idx = list.findIndex((p) => p.key === op.id)
        if (idx < 0 || !op.text || typeof op.at !== 'number') break
        const left: DocEditParagraphRef = { ...list[idx], text: op.text.slice(0, op.at) }
        const right: DocEditParagraphRef = { ...list[idx], key: 'p' + nextKeyNo++, text: op.text.slice(op.at) }
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
          sourceTitle: list[i]?.sourceTitle
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
  sources: { ordinal: number; title: string }[]
): ChatMessage[] {
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
    '【规则】',
    '1. 只输出一个 JSON 对象：{"reply":"给用户看的回答","ops":[…] }，不要输出解释性文字或代码块围栏。',
    '2. 修改必须通过 ops 表达，**用段号引用段落**（如 p12）：',
    '   · {"op":"delete","ids":["p3"]} 删除段落；',
    '   · {"op":"replace","id":"p3","text":"新正文","timeLabel":"2018 年"} 改写某段；',
    '   · {"op":"insertAfter","afterId":"p3","text":"新段正文","timeLabel":"2019 年","sourceOrdinal":2} 在某段后插入（**必须给 sourceOrdinal**）；',
    '   · {"op":"move","ids":["p5"],"afterId":"p9"} 移动段落；',
    '   · {"op":"merge","ids":["p5","p6"]} 合并（**仅限同一来源**）；',
    '   · {"op":"split","id":"p5","at":30,"text":"该段完整正文"} 按字符位置拆分；',
    '   · {"op":"setTime","id":"p5","timeLabel":"2019 年"} 只改段首时间。',
    '3. **不得编造事实**：正文里的数字、日期、人名、地名必须来自该段所属来源；不得凭空增加数据。',
    '4. 时间标签必须含 4 位年份（如「2018 年」「2018 年 5 月」）。',
    '5. 不要删除用户没有要求删除的内容；改动尽量小、贴合用户要求。',
    '6. 若用户的要求无法用上述 ops 表达，则不要输出任何 op，只在 reply 里说明原因。'
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

/** 段首时间兜底（供 handler 在应用后重算 year/confidence，与整合提取同口径） */export function resolveTimeForEdit(timeLabel: string | undefined, sourceTitle: string | undefined): {
  year?: number
  month?: number
  day?: number
  timeConfidence: 'exact' | 'inferred' | 'unknown'
} {
  const t = withFallbackYear(timeLabel, sourceTitle)
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
      expect(sys).toContain('必须给 sourceOrdinal')
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
  })
}
