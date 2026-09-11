/**
 * compilation-document.ts —— 资料汇编「连续文档」模型的纯函数（Phase 7.1，2026-09-10）。
 *
 * 资料汇编由「资料卡片列表」改为「一篇连续文档」：每段**段首注明时间（须含年份）**、**段尾带来源编号圆标**。
 * 本模块只放**无副作用、可单测**的规则与转换，供仓储层、生成管线与渲染层共用：
 * - 时间标签解析（结构化 year/month/day + 可信度）——排序不再靠正则现抽年份；
 * - 文档 markdown 渲染（**一段一行**，段内换行转空格，使"行级 diff ≈ 段落级 diff"）；
 * - 段落快照与版本变更统计（版本历史与差异高亮的共同基线）。
 *
 * 约定：段首时间**不写进段落正文**（正文里重复写时间会在编辑时被改坏），
 * 而是渲染时由 `timeLabel` 单独呈现；markdown 快照里为可读性把时间写在行首。
 */
import type {
  CompilationChangeSummary,
  CompilationItem,
  CompilationParagraph,
  CompilationParagraphKind,
  CompilationParagraphOrigin,
  CompilationSourceRef,
  CompilationTimeConfidence
} from '../../shared/types'

/** 时间标签解析结果 */
export interface ParsedTimeLabel {
  year?: number
  month?: number
  day?: number
  /** exact=含 4 位年份；unknown=没有年份（缺年份的时间不能用于排序，界面提示「时间待核」） */
  confidence: CompilationTimeConfidence
  /** 归一化后的显示文本（去多余空白）；无法确定时为「时间待核」 */
  label?: string
}

const YEAR_RE = /(?:18|19|20)\d{2}/
const MONTH_RE = /(\d{1,2})\s*月/
const DAY_RE = /(\d{1,2})\s*日/

/**
 * 解析时间标签（纯函数）：
 * - 含 4 位年份 → confidence='exact'，并抽出月/日（如「2018 年 5 月 19 日」）；
 * - **只有月日没有年份**（如「5 月 19 日」「7—9 日」）→ 仍抽出月/日但 confidence='unknown'
 *   （实测真实数据中存在 12 张此类卡片，不能当"有时间戳"放过）；
 * - 年份区间（如「2005—2010 年」）取**起始年**作为排序键；同理「7—9 日」是**日**区间，
 *   只从「…日」抽出 day（month 必须保持为空，否则会被误排到 7 月）；
 * - 无年份依据（如「十三五规划期间」）→ confidence='unknown'。
 */
export function parseTimeLabel(ts?: string | null): ParsedTimeLabel {
  const raw = (ts ?? '').trim()
  if (!raw) return { confidence: 'unknown' }
  const yearMatch = raw.match(YEAR_RE)
  const monthMatch = raw.match(MONTH_RE)
  const dayMatch = raw.match(DAY_RE)
  const parsed: ParsedTimeLabel = {
    confidence: yearMatch ? 'exact' : 'unknown',
    label: raw
  }
  if (yearMatch) parsed.year = Number(yearMatch[0])
  if (monthMatch) parsed.month = Number(monthMatch[1])
  if (dayMatch) parsed.day = Number(dayMatch[1])
  return parsed
}

/** 段首时间标签的显示文本（未确定时间时给出统一提示词，便于 UI 与统计共用） */
export const TIME_PENDING_LABEL = '时间待核'

/** 段落正文哈希（版本对比与"是否被改动"判定；短哈希足够） */
export function paragraphTextHash(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = (h1 ^ c) * 0x01000193
    h2 = (h2 + c * (i + 1)) | 0
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

/** 单段落渲染为一行 markdown：`时间标签　正文`（无时间则只输出正文；段内 ASCII 空白归一为单个空格） */
export function renderParagraphLine(p: Pick<CompilationParagraph, 'timeLabel' | 'text'>): string {
  // 注意：只归一 ASCII 空白（空格/制表/换行），保留段首时间与正文之间的全角空格 U+3000 作为稳定分隔符。
  // 年鉴 PDF 抽出的正文里常有制表符（表格残留），归一后既能保证"一段一行"，也让 diff 不受空白噪声干扰。
  const text = (p.text ?? '').replace(/[ \t\r\n\f\v]+/g, ' ').trim()
  const label = (p.timeLabel ?? '').replace(/[ \t\r\n\f\v]+/g, ' ').trim()
  return label ? label + '　' + text : text
}

/** 整篇文档渲染为 markdown（**一段一行**，便于 diff 与并排对比） */
export function renderDocumentMarkdown(paragraphs: Pick<CompilationParagraph, 'timeLabel' | 'text' | 'kind'>[]): string {
  return paragraphs
    .map((p) => (p.kind === 'heading' ? '## ' + renderParagraphLine(p).replace(/^##\s*/, '') : renderParagraphLine(p)))
    .join('\n')
}

/**
 * 由汇编条目构造段落快照（纯函数）：把 DB 行归一为文档段落，缺失的元数据按规则补齐。
 * - 时间：优先用 `year`/`ts`，都没有则 `timeConfidence='unknown'`；
 * - 来源编号：用 `sourceOrdinal`，缺失时按 sourceId 在 refsBySourceId 中反查（迁移期兜底）。
 */
export function buildParagraphSnapshot(
  items: CompilationItem[],
  refsBySourceId?: Map<string, CompilationSourceRef>
): CompilationParagraph[] {
  return items.map((it, index) => {
    const parsed = it.year != null ? null : parseTimeLabel(it.ts)
    const ref = it.sourceOrdinal == null && it.sourceId ? refsBySourceId?.get(it.sourceId) : undefined
    const timeConfidence: CompilationTimeConfidence =
      it.timeConfidence ?? (it.year != null ? 'exact' : (parsed?.confidence ?? 'unknown'))
    const year = it.year ?? parsed?.year
    const timeLabel = it.ts ?? parsed?.label
    return {
      id: it.id,
      ordinal: index,
      text: it.excerpt,
      timeLabel: year != null && !timeLabel ? String(year) + ' 年' : timeLabel,
      year,
      month: it.month ?? parsed?.month,
      day: it.day ?? parsed?.day,
      timeConfidence,
      sourceOrdinal: it.sourceOrdinal ?? ref?.ordinal,
      sourceId: it.sourceId || undefined,
      sourceTitle: it.sourceTitle,
      evidence: it.evidence,
      kind: (it.kind ?? 'paragraph') as CompilationParagraphKind,
      revision: it.revision ?? 1,
      origin: (it.origin ?? 'generate') as CompilationParagraphOrigin,
      kept: it.kept
    }
  })
}

/** 变更统计（纯函数）：按段 id 比对两版段落，得出新增/删除/修改/移动与涉及段落 id */
export function summarizeParagraphChange(
  prev: CompilationParagraph[],
  next: CompilationParagraph[]
): CompilationChangeSummary {
  const prevById = new Map(prev.map((p) => [p.id, p]))
  const nextIds = new Set(next.map((p) => p.id))
  let added = 0
  let removed = 0
  let modified = 0
  let moved = 0
  const paragraphIds: string[] = []
  for (const p of next) {
    const q = prevById.get(p.id)
    if (!q) {
      added += 1
      paragraphIds.push(p.id)
      continue
    }
    if (q.text !== p.text) {
      modified += 1
      paragraphIds.push(p.id)
    }
    if (q.ordinal !== p.ordinal) moved += 1
  }
  for (const p of prev) if (!nextIds.has(p.id)) removed += 1
  return { added, removed, modified, moved, paragraphIds }
}

/** 按「年 → 月 → 来源编号 → 生成序」稳定排序（D4：排序确定性由本地保证，段序稳定可复现） */
export function sortParagraphsByTime(paragraphs: CompilationParagraph[]): CompilationParagraph[] {
  return paragraphs
    .map((p, index) => ({ p, index }))
    .sort((a, b) => {
      const ya = a.p.year
      const yb = b.p.year
      if (ya == null && yb != null) return 1
      if (ya != null && yb == null) return -1
      if (ya != null && yb != null && ya !== yb) return ya - yb
      const ma = a.p.month ?? 0
      const mb = b.p.month ?? 0
      if (ma !== mb) return ma - mb
      const oa = a.p.sourceOrdinal ?? Number.MAX_SAFE_INTEGER
      const ob = b.p.sourceOrdinal ?? Number.MAX_SAFE_INTEGER
      if (oa !== ob) return oa - ob
      return a.index - b.index
    })
    .map((x, index) => ({ ...x.p, ordinal: index }))
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('compilation document helpers (Phase 7.1 连续文档)', () => {
    it('parses a full date label with a year as exact', () => {
      expect(parseTimeLabel('2018 年 5 月 19 日')).toEqual({ year: 2018, month: 5, day: 19, confidence: 'exact', label: '2018 年 5 月 19 日' })
      expect(parseTimeLabel('2018年')).toMatchObject({ year: 2018, confidence: 'exact' })
      // 年份区间取起始年（排序键）
      expect(parseTimeLabel('2005—2010 年')).toMatchObject({ year: 2005, confidence: 'exact' })
    })

    it('keeps month/day but marks a label without a year as unknown', () => {
      expect(parseTimeLabel('5 月 19 日')).toMatchObject({ month: 5, day: 19, confidence: 'unknown' })
      expect(parseTimeLabel('7—9 日')).toMatchObject({ confidence: 'unknown' })
      expect(parseTimeLabel('十三五规划期间')).toMatchObject({ confidence: 'unknown' })
      expect(parseTimeLabel('')).toEqual({ confidence: 'unknown' })
      expect(parseTimeLabel(null)).toEqual({ confidence: 'unknown' })
    })

    it('renders one line per paragraph with the time label prefix', () => {
      expect(renderParagraphLine({ timeLabel: '2018 年', text: '全区普通中学 30 所。' })).toBe('2018 年　全区普通中学 30 所。')
      // 段内换行/制表符归一为单个空格（年鉴 PDF 抽出的正文常带表格残留），保证"一段一行"
      expect(renderParagraphLine({ text: '甲\n乙' })).toBe('甲 乙')
      expect(renderParagraphLine({ text: '【侨胞服务】 \t 2020 年，出具证明 12 份。' })).toBe('【侨胞服务】 2020 年，出具证明 12 份。')
      // 全角空格（时间与正文之间的分隔符）必须保留
      expect(renderParagraphLine({ timeLabel: '2018 年', text: '甲' })).toContain('　')
      const md = renderDocumentMarkdown([
        { timeLabel: '2018 年', text: '甲。', kind: 'paragraph' },
        { timeLabel: '2019 年', text: '乙。', kind: 'paragraph' }
      ])
      expect(md).toBe('2018 年　甲。\n2019 年　乙。')
      expect(md.split('\n')).toHaveLength(2)
    })

    it('summarizes added / removed / modified / moved paragraphs by id', () => {
      const mk = (id: string, ordinal: number, text: string): CompilationParagraph => ({
        id,
        ordinal,
        text,
        timeConfidence: 'exact',
        kind: 'paragraph',
        revision: 1,
        origin: 'generate',
        kept: true
      })
      const prev = [mk('p1', 0, '甲'), mk('p2', 1, '乙')]
      const next = [mk('p1', 0, '甲'), mk('p3', 1, '丙'), mk('p2', 0, '乙改')]
      const sum = summarizeParagraphChange(prev, next)
      expect(sum.added).toBe(1)
      expect(sum.removed).toBe(0)
      expect(sum.modified).toBe(1)
      expect(sum.moved).toBe(1)
      expect(sum.paragraphIds.sort()).toEqual(['p2', 'p3'])
      // 首版：全部计为新增
      expect(summarizeParagraphChange([], prev)).toMatchObject({ added: 2, removed: 0, modified: 0 })
    })

    it('sorts paragraphs by year → month → source ordinal → original order, unknown last', () => {
      const mk = (id: string, year: number | undefined, month: number | undefined, ordinal?: number): CompilationParagraph => ({
        id,
        ordinal: 0,
        text: id,
        year,
        month,
        timeConfidence: year == null ? 'unknown' : 'exact',
        sourceOrdinal: ordinal,
        kind: 'paragraph',
        revision: 1,
        origin: 'generate',
        kept: true
      })
      const sorted = sortParagraphsByTime([
        mk('b', 2019, 3),
        mk('unknown', undefined, undefined),
        mk('a', 2018, 5),
        mk('c', 2019, 1),
        mk('d', 2019, 3, 1)
      ])
      expect(sorted.map((p) => p.id)).toEqual(['a', 'c', 'd', 'b', 'unknown'])
      expect(sorted.map((p) => p.ordinal)).toEqual([0, 1, 2, 3, 4])
    })
  })
}
