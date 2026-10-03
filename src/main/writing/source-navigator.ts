/**
 * source-navigator.ts —— 「大模型自主导航」找资料（2026-10-03 用户裁定：**完全依赖大模型决策**）。
 *
 * 用户原话（要点）：答案未必落在对应年份的年鉴里，可能在其它年份年鉴甚至网页资料库；
 * 希望由大模型自己决定"看哪些资料、看哪一节"，而不是靠本地的词法/向量相似度。
 *
 * 为什么必须配"目录"：真实任务里整库正文 **214.9 万字**（3 份年鉴 185 万字 + 300 篇网页 30 万字），
 * 任何上下文都装不下；而目录很小（来源清单 1.48 万字、全库小节标题 4.22 万字）。
 * 因此本模块**不做任何相似度/词法检索**，只做四件事：
 *   ① 把目录搬给模型；② 按模型的选择把**正文**搬给它；③ 严格解析它的选择（幻觉 id 一律忽略）；
 *   ④ 把选中的正文当成"候选原文"交给既有的逐字校验/落卡链路（幻觉防线不变）。
 *
 * 轮次（最多 4 轮，每轮输入都压在预算内）：
 *   R1 挑资料：全库来源清单 → 模型选 ≤`NAV_MAX_SOURCES` 个来源（附理由）
 *   R2/R3 挑章节：所选来源的小节标题清单（超预算就分两批）→ 模型选 ≤`NAV_MAX_SECTIONS` 个节
 *   R4 细读作答：被选中节的正文 → 由 `runDocEdit` 那次调用完成（回答 + 值得入编则落卡）
 * 所以本模块负责 R1–R3，产出的"选中正文"作为 `LeakCandidate[]` 进入原链路。
 */
import type { ChatMessage } from '../llm/chat'
import { logMain } from '../logger'
import { chatCompletion, type ChatProvider } from '../llm/chat'
import {
  buildSectionCatalog,
  buildSourceCatalog,
  resolveSection,
  sectionCatalogLines,
  sourceYearOf,
  splitByBudget,
  splitIntoSections,
  type CatalogSection,
  type CatalogSource
} from './catalog'
import { CANDIDATE_MAX_CHARS, type LeakCandidate } from './leak-candidates'

/** R1 输入上限：全库来源清单（实测 303 条 ≈ 1.5 万字）。超出则按"先文件后网页"截断并如实告知 */
export const NAV_SOURCE_CATALOG_MAX_CHARS = 24000
/**
 * R2/R3 每轮小节清单上限。实测（真实库 3 份年鉴，紧凑格式）合计约 6.26 万字 →
 * 按 3.3 万字/轮即 **2 批装下**，从而守住"最多 4 轮"（R1 挑资料 + R2/R3 挑章节 + R4 细读作答）。
 * 每轮输入约 3.3 万字（≈2.4 万 token），需要模型上下文 ≥32k；更小的模型会自动多分一批（多一次调用）。
 */
export const NAV_SECTION_CATALOG_MAX_CHARS = 38000
/** R4 读入正文上限（模型选中的节正文合计） */
export const NAV_READ_MAX_CHARS = 32000
/** 一轮最多选几个来源 / 几个节 */
export const NAV_MAX_SOURCES = 6
export const NAV_MAX_SECTIONS = 20
/** 导航调用超时（目录很小、输出也很小，给 120s 足够） */
const NAV_CALL_TIMEOUT_MS = 120_000

export interface NavRoundLog {
  round: 'R1' | 'R2' | 'R3'
  stage: string
  inputChars: number
  output: string
}

export interface NavOutcome {
  /** 选中的节正文（作为候选原文交给原来的落卡/校验链路） */
  candidates: LeakCandidate[]
  /** 逐轮如实记录（用于回复里显示"检索路径"与诊断日志） */
  rounds: NavRoundLog[]
  /** 选中的来源标题（去重，按选择顺序） */
  pickedSources: string[]
  /** 选中的节标题 */
  pickedSections: string[]
  /** 累计读入模型的正文量 */
  readChars: number
  state: 'ok' | 'empty' | 'failed'
  message?: string
}

interface NavCtx {
  provider: ChatProvider
  taskId: string
  question: string
  /** 用户撰写要求（判断"值得入编"的参照） */
  requirement?: string
  sources: CatalogSource[]
  /** 仅供单测/演练注入假的模型调用（复刻"模型选了哪些资料/哪些节"） */
  call?: NavCall
}

type NavCall = (
  provider: ChatProvider,
  messages: ChatMessage[],
  timeoutMs: number,
  meta: { kind: string; taskId: string },
  opts: { maxRetries: number; temperature: number }
) => Promise<{ ok: boolean; text: string; error?: { code?: string; message?: string } }>

function parseJsonObject(text: string): Record<string, unknown> | null {
  const raw = String(text ?? '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced ? fenced[1] : raw).trim()
  try {
    const v = JSON.parse(candidate)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    const s = candidate.indexOf('{')
    const e = candidate.lastIndexOf('}')
    if (s >= 0 && e > s) {
      try {
        const v = JSON.parse(candidate.slice(s, e + 1))
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
      } catch {
        return null
      }
    }
    return null
  }
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
  if (typeof v === 'string') return [v.trim()].filter(Boolean)
  return []
}

async function askJson(ctx: NavCtx, messages: ChatMessage[], stage: string): Promise<{ ok: boolean; raw: string; obj: Record<string, unknown> | null; message?: string }> {
  const call = ctx.call ?? chatCompletion
  const res = await call(ctx.provider, messages, NAV_CALL_TIMEOUT_MS, { kind: 'compilation-nav', taskId: ctx.taskId }, { maxRetries: 0, temperature: 0 })
  if (!res.ok) return { ok: false, raw: '', obj: null, message: res.error?.message ?? '大模型调用失败' }
  const obj = parseJsonObject(res.text)
  logMain('compilation', '资料导航 ' + stage + '：输出 ' + res.text.length + ' 字，可解析=' + (obj ? '是' : '否'))
  return { ok: true, raw: res.text, obj }
}

/** R1：挑资料 */
async function pickSources(ctx: NavCtx, rounds: NavRoundLog[]): Promise<{ refs: string[]; reason: string; truncated: boolean }> {
  const all = ctx.sources
  const lines = all.map((_, i) => ({ ref: 'S' + (i + 1), line: '' }))
  const catalogAll = buildSourceCatalog(all).split('\n')
  // 预算截断：文件类优先（年鉴这类"权威资料"），再按原顺序补网页
  let used = 0
  const keptIdx: number[] = []
  const order = all.map((_, i) => i).sort((a, b) => (all[a].kind === all[b].kind ? a - b : all[a].kind === 'file' ? -1 : 1))
  for (const i of order) {
    const len = catalogAll[i].length + 1
    if (used + len > NAV_SOURCE_CATALOG_MAX_CHARS) continue
    keptIdx.push(i)
    used += len
  }
  keptIdx.sort((a, b) => a - b)
  const catalog = keptIdx.map((i) => catalogAll[i]).join('\n')
  const truncated = keptIdx.length < all.length
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是志书资料检索助手。用户对已生成的资料汇编提问，需要你**先决定去看哪些资料**。',
        '',
        '【资料库来源清单】（`[S编号] 标题 类型 年份口径 体量`）',
        catalog,
        truncated ? '（清单过长，以上是部分来源；未列出的来源本轮不可选）' : '',
        '',
        ...(ctx.requirement ? ['【用户的撰写要求】', ctx.requirement, ''] : []),
        '【规则】',
        '1. 只输出一个 JSON 对象：{"sources":["S3","S5"],"reason":"一句话说明为什么看这几份"}。',
        '2. 最多选 ' + NAV_MAX_SOURCES + ' 个来源。宁可多选一两份，也不要漏掉可能含答案的年份或网页。',
        '3. **注意年份口径**：年鉴标题的年份通常是出版年，记述的是**上一年**（如《长乐年鉴2023》记述 2022 年）。',
        '   用户问某一年的事实时，相邻年份的年鉴、以及网页资料都可能记有该事实，允许多选。',
        '4. 只能选清单里出现过的编号，不要编造。'
      ]
        .filter(Boolean)
        .join('\n')
    },
    { role: 'user', content: ctx.question }
  ]
  const r = await askJson(ctx, messages, 'R1 挑资料')
  rounds.push({ round: 'R1', stage: '挑资料', inputChars: catalog.length, output: r.raw.slice(0, 400) })
  if (!r.ok) throw new Error(r.message ?? 'R1 失败')
  const picked = asStringArray(r.obj?.sources).filter((x) => /^S\d+$/.test(x))
  const refs = picked.filter((x) => keptIdx.some((i) => lines[i].ref === x)).slice(0, NAV_MAX_SOURCES)
  // 模型一个都没选出来（或全选错）→ 退回"文件类前 3 份"，宁多勿漏（仍不是相关性检索，只是保守兜底）
  if (refs.length === 0) {
    const files = keptIdx.filter((i) => all[i].kind === 'file').slice(0, 3).map((i) => lines[i].ref)
    const fallback = files.length > 0 ? files : keptIdx.slice(0, 2).map((i) => lines[i].ref)
    logMain('compilation', 'R1 未选出有效来源，保守退回：' + fallback.join(','))
    return { refs: fallback, reason: '（模型未给出有效选择，已按"宁多勿漏"保守取前几份资料）', truncated }
  }
  return { refs, reason: typeof r.obj?.reason === 'string' ? r.obj.reason : '', truncated }
}

/**
 * 小节清单的**按行装箱**（2026-10-03 实测修正）：同一来源的小节清单可以跨批。
 * 若"按来源整份分批"，3 份年鉴（紧凑清单合计约 6.3 万字）会吃掉 3 批 → 超出"最多 4 轮"；
 * 按行装箱后 2 批即可装下。每批都重复来源头行，模型每批都能看到"这批里有哪几份资料"。
 */
export function packSectionCatalogs(
  items: { ref: string; src: CatalogSource; sections: CatalogSection[] }[],
  maxChars: number
): { text: string; refs: string[]; ids: string[] }[] {
  const batches: { text: string; refs: string[]; ids: string[] }[] = []
  let lines: string[] = []
  let refs: string[] = []
  let ids: string[] = []
  let used = 0
  let curRef = ''
  const flush = (): void => {
    if (lines.length > 0) batches.push({ text: lines.join('\n'), refs, ids })
    lines = []
    refs = []
    ids = []
    used = 0
    curRef = ''
  }
  for (const it of items) {
    const head = buildSectionCatalog(it.ref, it.src.title, [])
    const linesOf = sectionCatalogLines(it.ref, it.sections)
    for (const { line, id } of linesOf) {
      const headCost = curRef === it.ref ? 0 : head.length + 1
      if (lines.length > 0 && used + line.length + 1 + headCost > maxChars) flush()
      if (curRef !== it.ref) {
        lines.push(head)
        used += head.length + 1
        curRef = it.ref
        if (!refs.includes(it.ref)) refs.push(it.ref)
      }
      lines.push(line)
      ids.push(id)
      used += line.length + 1
    }
  }
  flush()
  return batches
}

/** R2/R3：挑章节（所选来源的小节清单，按行装箱后分批；每批一次调用） */
async function pickSections(
  ctx: NavCtx,
  refs: string[],
  rounds: NavRoundLog[]
): Promise<{ picks: { ref: string; sectionIndex: number; title: string }[]; batches: number }> {
  const refToSource = new Map<string, CatalogSource>()
  ctx.sources.forEach((s, i) => refToSource.set('S' + (i + 1), s))
  const sectionsBySource = new Map<string, CatalogSection[]>()
  for (const ref of refs) {
    const src = refToSource.get(ref)
    if (src) sectionsBySource.set(src.id, splitIntoSections(src.cleanedText))
  }
  const items = refs.map((ref) => {
    const src = refToSource.get(ref)!
    return { ref, src, sections: sectionsBySource.get(src.id) ?? [] }
  })
  const batches = packSectionCatalogs(items, NAV_SECTION_CATALOG_MAX_CHARS)
  const picks: { ref: string; sectionIndex: number; title: string }[] = []
  const pickedIds = new Set<string>()

  for (const [bi, batch] of batches.entries()) {
    const roundName: NavRoundLog['round'] = bi === 0 ? 'R2' : 'R3'
    const catalog = batch.text
    const valid = new Set(batch.ids)
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          '你是志书资料检索助手。已选定以下资料，现在需要你**从它们的小节清单里挑出最可能含答案的节**。',
          '',
          catalog,
          '',
          '【用户的撰写要求】',
          ctx.requirement ?? '（无）',
          '',
          '【规则】',
          '1. 只输出一个 JSON 对象：{"sections":["S3#12","S3#13"],"reason":"一句话说明"}。',
          '2. 节 id 写作 `S编号#节号`（来源头里给了 S 编号，节号取自清单每行开头的数字）。最多选 ' + NAV_MAX_SECTIONS + ' 个节。',
          '3. 清单按**原文顺序**排列，同一篇/章的条目是**连续**的；`概况`这类通用标题会重复很多次',
          '   （标了"正文特征"的就是重名条目），请结合**相邻条目标题**判断它属于哪一章，不要只看标题本身。',
          '4. 涉及名单、具体校名、具体数字的问题，优先选标题里带同类字样的节；',
          '   同时不要漏掉"概况""综述""大事记""普通高中教育"这类可能顺带写到答案的节。',
          '5. 不确定时宁可多选几节（上限内），不要少选。'
        ].join('\n')
      },
      { role: 'user', content: ctx.question }
    ]
    const r = await askJson(ctx, messages, roundName + ' 挑章节')
    rounds.push({ round: roundName, stage: '挑章节', inputChars: catalog.length, output: r.raw.slice(0, 400) })
    if (!r.ok) throw new Error(r.message ?? roundName + ' 失败')
    const picked = asStringArray(r.obj?.sections)
    for (const id of picked) {
      if (!valid.has(id) || pickedIds.has(id)) continue
      const [ref, idx] = id.split('#')
      const src = refToSource.get(ref)
      const section = src ? (sectionsBySource.get(src.id) ?? [])[Number(idx)] : undefined
      if (!src || !section) continue
      pickedIds.add(id)
      picks.push({ ref, sectionIndex: Number(idx), title: section.title })
    }
  }
  return { picks, batches: batches.length }
}

/**
 * 导航主流程：R1 挑资料 → R2/R3 挑章节 → 读出正文（作为候选原文）。
 * 全程只有"目录 + 模型选择 + 正文搬运"，不做任何本地相关性判断。
 */
export async function navigateSources(ctx: NavCtx): Promise<NavOutcome> {
  const rounds: NavRoundLog[] = []
  try {
    if (ctx.sources.length === 0) return { candidates: [], rounds, pickedSources: [], pickedSections: [], readChars: 0, state: 'empty' }
    const r1 = await pickSources(ctx, rounds)
    const refToSource = new Map<string, CatalogSource>()
    ctx.sources.forEach((s, i) => refToSource.set('S' + (i + 1), s))
    const pickedSources = r1.refs.map((r) => refToSource.get(r)?.title ?? r)

    const r2 = await pickSections(ctx, r1.refs, rounds)
    if (r2.picks.length === 0) {
      return { candidates: [], rounds, pickedSources, pickedSections: [], readChars: 0, state: 'empty', message: '模型没有从目录里选出任何小节' }
    }

    // 读出被选中的正文；按预算截断（模型给的顺序即优先级）
    const candidates: LeakCandidate[] = []
    const pickedSections: string[] = []
    let readChars = 0
    for (const p of r2.picks) {
      const src = refToSource.get(p.ref)
      if (!src) continue
      const section = (splitIntoSections(src.cleanedText) ?? [])[p.sectionIndex]
      if (!section) continue
      const text = section.text.length > CANDIDATE_MAX_CHARS ? section.text.slice(0, CANDIDATE_MAX_CHARS) + '…' : section.text
      if (readChars + text.length > NAV_READ_MAX_CHARS && candidates.length > 0) break
      readChars += text.length
      pickedSections.push('《' + src.title + '》【' + section.title + '】')
      candidates.push({
        key: 'c' + (candidates.length + 1),
        sourceId: src.id,
        sourceTitle: src.title,
        position: '【' + section.title + '】' + (sourceYearOf(src) ? '（' + sourceYearOf(src) + '年口径）' : ''),
        text,
        score: 0
      })
    }
    logMain(
      'compilation',
      '资料导航完成：来源 ' + pickedSources.length + ' 份（R1 输入 ' + (rounds[0]?.inputChars ?? 0) + ' 字）' +
        ' → 节 ' + candidates.length + ' 个（挑章节批次 ' + r2.batches + '）→ 正文 ' + readChars + ' 字'
    )
    return { candidates, rounds, pickedSources, pickedSections, readChars, state: candidates.length > 0 ? 'ok' : 'empty' }
  } catch (e) {
    logMain('compilation', '资料导航失败：' + String(e))
    return { candidates: [], rounds, pickedSources: [], pickedSections: [], readChars: 0, state: 'failed', message: e instanceof Error ? e.message : String(e) }
  }
}

/* ------------------------------ 单测 ------------------------------ */

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('source navigator (大模型自主导航：目录 → 选择 → 正文)', () => {
    it('来源清单按预算截断时文件类优先（年鉴这类权威资料不被网页挤掉）', () => {
      const sources: CatalogSource[] = [
        ...Array.from({ length: 200 }, (_, i) => ({ id: 'w' + i, title: '网页标题' + i, kind: 'url' as const, cleanedText: 'x'.repeat(500) })),
        { id: 'f1', title: '长乐年鉴2023（完整版）.pdf', kind: 'file', cleanedText: 'y'.repeat(600000) }
      ]
      const catalog = buildSourceCatalog(sources)
      expect(catalog.split('\n')).toHaveLength(201)
      // 截断逻辑在 pickSources 内部：这里只验证"文件类排在前面"的排序前提
      const order = sources.map((_, i) => i).sort((a, b) => (sources[a].kind === sources[b].kind ? a - b : sources[a].kind === 'file' ? -1 : 1))
      expect(sources[order[0]].id).toBe('f1')
    })

    it('批次切分把小节清单压到每轮预算内', () => {
      const items = Array.from({ length: 6 }, (_, i) => ({ title: '来源' + i, catalog: 'x'.repeat(9000) }))
      const batches = splitByBudget(items, (x) => x.catalog.length, NAV_SECTION_CATALOG_MAX_CHARS)
      expect(batches.length).toBeGreaterThan(1)
      expect(batches.every((b) => b.reduce((n, x) => n + x.catalog.length, 0) <= NAV_SECTION_CATALOG_MAX_CHARS)).toBe(true)
    })

    it('节 id 解析：只承认清单里存在的 id（幻觉 id 一律忽略）', () => {
      const refs = new Map([['S1', 'src-1']])
      const sections = new Map([['src-1', splitIntoSections('补充正文。'.repeat(200) + '\n【概况】甲。\n【普通高中教育】乙。')]])
      expect(resolveSection(refs, 'S1#2', sections)?.section.title).toBe('普通高中教育')
      expect(resolveSection(refs, 'S1#99', sections)).toBeNull()
      expect(resolveSection(refs, 'S7#0', sections)).toBeNull()
    })
  })
}
