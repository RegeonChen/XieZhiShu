import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { setDb } from '../src/main/db/connection'
import { runMigrations } from '../src/main/db/migrate'
import {
  recallCandidateChunks,
  recallCompilationCandidates,
  parseCompilationOutput,
  parseKeywordExtraction,
  fallbackCoarseQuery,
  parseCardScanGroups,
  mergeContradictionGroups,
  mapOutputItemsToInputs,
  mergeCompilationOutputs,
  buildCompilationSourceRefs,
  pickRemainingWindows,
  nextContradictionBatch,
  splitCardScans,
  clusterCandidateCards,
  packCandidateCalls,
  reduceConcurrency,
  mapWindowGroupsThroughExtract
} from '../src/main/writing/compilation-service'

let db: Database.Database
beforeAll(() => {
  db = new Database(':memory:')
  setDb(db)
  runMigrations(db)
})
afterAll(() => db.close())

describe('compilation service (Phase 6.1)', () => {
  it('recallCandidateChunks keeps all chunks (宁多勿漏：无关资料也不淘汰)', () => {
    db.prepare(`INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s1', 'file', '教育发展报告', '2005年全县幼儿园89所。', 'ready')`).run()
    db.prepare(`INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s2', 'file', '天气记录', '今天天气晴。', 'ready')`).run()
    const chunks = recallCandidateChunks(['s1', 's2'], '园所设置')
    expect(chunks.some((c) => c.sourceId === 's1')).toBe(true)
    expect(chunks.some((c) => c.sourceId === 's2')).toBe(true)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  it('recallCompilationCandidates keeps all pieces of a paragraph if any piece has signal (整段级保留，Phase A/B)', () => {
    const longPara = '学前教育事业发展概述。' + '多年来，办园水平不断提升，教师队伍持续优化，城乡差距不断缩小，各项指标稳步向好。'.repeat(40)
    const filler = '与主题完全无关的历史沿革记载，内容不涉及本次撰写主题。'.repeat(600)
    db.prepare(`INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('wid', 'file', '某区综合史料汇编', ?, 'ready')`).run(longPara + '\n' + filler)
    const res = recallCompilationCandidates(['wid'], '学前教育')
    const para1 = res.chunks.filter((c) => c.position.startsWith('第1段'))
    expect(para1.length).toBeGreaterThan(1)
    expect(para1.every((c) => c.sourceId === 'wid')).toBe(true)
    expect(res.chunks.every((c) => c.position.startsWith('第1段'))).toBe(true)
  })

  it('parseCompilationOutput parses fenced JSON with items and contradictions', () => {
    const json = '{"items":[{"sourceRef":"#1","position":"第2段","excerpt":"2005年全县幼儿园89所。","ts":"2005 年"}],"contradictions":[{"topic":"2021年公办园数量","kind":"data","variants":[{"excerpt":"公办园76所","sourceRefs":["#1"]},{"excerpt":"公办园82所","sourceRefs":["#2"]}]}]}'
    const out = parseCompilationOutput(json)!
    expect(out.items).toHaveLength(1)
    expect(out.items[0].ts).toBe('2005 年')
    expect(out.contradictions).toHaveLength(1)
    expect(out.contradictions[0].variants).toHaveLength(2)
    expect(parseCompilationOutput('纯文本')).toBeNull()
  })

  it('mapOutputItemsToInputs resolves #N refs and drops unknown refs', () => {
    const refs = buildCompilationSourceRefs([
      { sourceId: 's1', sourceTitle: '教育发展报告', position: '第1段', text: '卡片一', score: 1 },
      { sourceId: 's2', sourceTitle: '统计表', position: '第2段', text: '卡片二', score: 1 }
    ])
    const items = mapOutputItemsToInputs(
      [
        { sourceRef: '#1', position: '第1段', excerpt: '卡片一', ts: '2005 年' },
        { sourceRef: '#99', position: '第1段', excerpt: '坏引用', ts: null }
      ],
      refs
    )
    expect(items).toHaveLength(1)
    expect(items[0].sourceId).toBe('s1')
  })

  it('mapOutputItemsToInputs carries the repair record with its card (2026-09-08 修正随卡片流转)', () => {
    const refs = buildCompilationSourceRefs([
      { sourceId: 's1', sourceTitle: '教育发展报告', position: '第1段', text: '卡片一', score: 1 }
    ])
    const items = mapOutputItemsToInputs(
      [
        {
          sourceRef: '#1',
          position: '第1段',
          excerpt: '预科班 30 人。',
          ts: '2005 年',
          repair: { originalText: '其中预科班 30 人。', revisedText: '预科班 30 人。', reason: '缺少主语' }
        },
        { sourceRef: '#99', position: '第1段', excerpt: '坏引用', ts: null }
      ],
      refs
    )
    expect(items).toHaveLength(1)
    expect(items[0].repair).toEqual({ originalText: '其中预科班 30 人。', revisedText: '预科班 30 人。', reason: '缺少主语' })
  })

  it('mapWindowGroupsThroughExtract rewrites window-level variant excerpts onto extracted paragraphs (Phase 7.2 整合提取)', () => {
    // 细读产出的两张整段卡片（整合提取前）
    const parents = [
      { sourceRef: '#1', position: '', excerpt: '【社会事业】财政支出 46.91 亿元。普通中学 30 所，独立高中 1 所。', ts: '2019 年' },
      { sourceRef: '#2', position: '', excerpt: '2020 年，全区普通中学 28 所，独立高中 1 所。', ts: '2020 年' }
    ]
    // 整合提取后：只保留与「高中」相关的内容（无关的民生支出已被裁掉）
    const paragraphs = [
      { ordinal: 0, text: '2019 年，全区普通中学 30 所，独立高中 1 所。', timeLabel: '2019 年', timeConfidence: 'exact' as const, sourceId: 's1', kind: 'paragraph' as const, revision: 1, origin: 'generate' as const, kept: true, parentIndex: 0 },
      { ordinal: 1, text: '2020 年，全区普通中学 28 所，独立高中 1 所。', timeLabel: '2020 年', timeConfidence: 'exact' as const, sourceId: 's2', kind: 'paragraph' as const, revision: 1, origin: 'generate' as const, kept: true, parentIndex: 1 }
    ]
    const groups = [
      {
        topic: '普通中学数量',
        kind: 'data',
        variants: [
          { excerpt: '【社会事业】财政支出 46.91 亿元。普通中学 30 所，独立高中 1 所。', sourceRefs: ['#1'] },
          { excerpt: '2020 年，全区普通中学 28 所，独立高中 1 所。', sourceRefs: ['#2'] }
        ]
      },
      {
        topic: '已被裁掉的事实',
        kind: 'data',
        variants: [
          { excerpt: '【社会事业】财政支出 46.91 亿元。普通中学 30 所，独立高中 1 所。', sourceRefs: ['#1'] },
          { excerpt: '民生支出逐年增长', sourceRefs: ['#2'] }
        ]
      }
    ]
    const out = mapWindowGroupsThroughExtract(groups, parents, paragraphs)
    // 第一组：两说法都被映射到提取后的段落文本（落库时才能匹配到段落）
    expect(out).toHaveLength(1)
    expect(out[0].topic).toBe('普通中学数量')
    expect(out[0].variants.map((v) => v.excerpt)).toEqual([
      '2019 年，全区普通中学 30 所，独立高中 1 所。',
      '2020 年，全区普通中学 28 所，独立高中 1 所。'
    ])
    // 第二组：其中一个说法与任何段落都不像（内容已被裁掉），剩余不足 2 条 → 整组丢弃
    expect(out.some((g) => g.topic === '已被裁掉的事实')).toBe(false)
  })

  it('recallCandidateChunks returns empty for empty query or scope', () => {    expect(recallCandidateChunks([], '园所设置')).toEqual([])
    expect(recallCandidateChunks(['s1'], '   ')).toEqual([])
  })

  it('mergeCompilationOutputs dedupes items by sourceRef+excerpt', () => {
    const merged = mergeCompilationOutputs([
      { items: [{ sourceRef: '#1', position: '第1段', excerpt: '同一句', ts: '2005 年' }], contradictions: [] },
      { items: [{ sourceRef: '#1', position: '第1段', excerpt: '同一句', ts: '2005 年' }], contradictions: [] }
    ])
    expect(merged.items).toHaveLength(1)
  })
})

describe('recallCompilationCandidates (Phase 6.1 优化：保守本地闸门)', () => {
  it('drops entirely unrelated sources and keeps related ones (来源级闸门)', () => {
    db.prepare(`INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s10', 'file', '学前教育发展报告', '2005年全县幼儿园89所。\n城乡公办园数量稳步增长。', 'ready')`).run()
    db.prepare(`INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s11', 'file', '天气预报', '今天天气晴朗。\n明天多云转阴。', 'ready')`).run()
    const recall = recallCompilationCandidates(['s10', 's11'], '学前教育 幼儿园 学前 园所')
    expect(recall.candidateSources).toBe(1)
    expect(recall.chunks.every((c) => c.sourceId === 's10')).toBe(true)
    expect(recall.chunks.length).toBeGreaterThanOrEqual(2)
  })

  it('dedicated source (title contains full query) keeps ALL chunks (篇内不漏)', () => {
    db.prepare(`INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s12', 'file', '学前教育园所设置规划', '学前教育园所设置规划说明。\n本段与主题无直接字面重叠，仅叙述经费报销流程。', 'ready')`).run()
    const recall = recallCompilationCandidates(['s12'], '学前教育园所设置 学前 幼儿园 园所 幼教')
    expect(recall.chunks.some((c) => c.text.includes('经费报销'))).toBe(true)
    expect(recall.chunks.length).toBe(2)
  })

  it('broad source (non-dedicated) keeps only signal chunks (宽口径来源截段)', () => {
    const filler = '全省未来三天将迎来一次大范围降水过程，气温小幅下降，出行请注意携带雨具。'.repeat(240)
    db.prepare(`INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s13', 'file', '某县综合工作文档', '${filler}\n2005年全县幼儿园89所。\n另一段无关内容，讲述农田水利建设。', 'ready')`).run()
    const recall = recallCompilationCandidates(['s13'], '学前教育 幼儿园 学前 园所 幼教')
    expect(recall.chunks.some((c) => c.text.includes('幼儿园'))).toBe(true)
    expect(recall.chunks.some((c) => c.text.includes('降水'))).toBe(false)
    expect(recall.chunks.some((c) => c.text.includes('农田水利'))).toBe(false)
  })

  it('returns empty for empty query or scope', () => {
    expect(recallCompilationCandidates([], '学前教育').chunks).toHaveLength(0)
    expect(recallCompilationCandidates(['s10'], '   ').chunks).toHaveLength(0)
  })
})

describe('keyword extraction & coarse query (Phase 6.1 大模型提取标题/关键词)', () => {
  it('parseKeywordExtraction parses title and keywords', () => {
    const out = parseKeywordExtraction('{"title":"学前教育园所设置","keywords":["学前教育","幼儿园","托儿所","招生人数","园所等级"]}')!
    expect(out.title).toBe('学前教育园所设置')
    expect(out.keywords).toContain('托儿所')
    expect(out.keywords).toContain('招生人数')
    expect(parseKeywordExtraction('纯文本')).toBeNull()
  })

  it('fallbackCoarseQuery extracts quoted title and expands domain hints', () => {
    const q = fallbackCoarseQuery('标题为“学前教育园所设置”，包含例如：招多少幼儿园/托儿所。')
    expect(q).toContain('学前教育园所设置')
    expect(q).toContain('幼儿园')
    expect(q).toContain('幼儿')
    expect(q.toLowerCase()).not.toContain('标题为')
    expect(q).not.toContain('招多少')
  })

  it('coarse gate keeps a 托儿所/招生 chunk when keywords are provided', () => {
    db.prepare(`INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s20', 'file', '某区托幼事业统计', '2005年全区托儿所共计82所。\n2008年全区幼儿园入园率达到98%。', 'ready')`).run()
    // 仅用本地核心词（不含 托儿所/招生）时，托儿所段无信号；
    // 用大模型扩展词后，托儿所/招生 段命中关键词而保留。
    const local = recallCompilationCandidates(['s20'], '学前教育园所设置 学前 幼儿园 幼儿 保育 托育 入园 幼教')
    const keyworded = recallCompilationCandidates(['s20'], '学前教育园所设置 学前 幼儿园 幼儿 保育 托育 入园 幼教 托儿所 招生 等级 占比')
    expect(keyworded.chunks.some((c) => c.text.includes('托儿所'))).toBe(true)
    expect(keyworded.chunks.some((c) => c.text.includes('入园'))).toBe(true)
  })
})

describe('card contradiction scan (Phase 6.1 优化)', () => {
  it('parseCardScanGroups parses card indices', () => {
    const out = parseCardScanGroups('{"contradictions":[{"topic":"2021 年公办园数量","kind":"data","cardIndices":[1,3]}]}')!
    expect(out).toHaveLength(1)
    expect(out[0].topic).toBe('2021 年公办园数量')
    expect(out[0].cardIndices).toEqual([1, 3])
    expect(parseCardScanGroups('纯文本')).toBeNull()
  })

  it('mergeContradictionGroups dedupes by topic+variant excerpts', () => {
    const a = [{ topic: '数量', kind: 'data', variants: [{ excerpt: '76 所', sourceRefs: ['#1'] }, { excerpt: '82 所', sourceRefs: ['#2'] }] }]
    const b = [{ topic: '数量', kind: 'data', variants: [{ excerpt: '82 所', sourceRefs: ['#2'] }, { excerpt: '76 所', sourceRefs: ['#1'] }] }]
    const merged = mergeContradictionGroups(a, b)
    expect(merged).toHaveLength(1)
  })

  it('pickRemainingWindows returns window indices not yet done (断点续传不重复读已完成窗口)', () => {
    const done = new Set([0, 1, 3])
    expect(pickRemainingWindows(done, 5)).toEqual([2, 4])
    expect(pickRemainingWindows(done, 4)).toEqual([2])
    expect(pickRemainingWindows(new Set([0, 1, 2, 3]), 4)).toEqual([])
    // 失败/未读的窗口不在 doneSet → 续跑时重新读（不丢任何窗口）
    expect(pickRemainingWindows(new Set([0, 2]), 4)).toEqual([1, 3])
  })

  it('nextContradictionBatch advances the scan offset and stops when done (断点续传从正确批次继续)', () => {
    expect(nextContradictionBatch(0, 2, 5)).toEqual({ start: 0, end: 2 })
    expect(nextContradictionBatch(2, 2, 5)).toEqual({ start: 2, end: 4 })
    expect(nextContradictionBatch(4, 2, 5)).toEqual({ start: 4, end: 5 })
    expect(nextContradictionBatch(5, 2, 5)).toBeNull()
    // 从断点（第 2 批之后）继续
    expect(nextContradictionBatch(4, 2, 6)).toEqual({ start: 4, end: 6 })
  })

  it('splitCardScans budgets both card count and cumulative chars (方案 C 卡片变长时避免单批过大)', () => {
    const mk = (len: number): { excerpt: string; sourceRef: string; position: string; ts: string | null } => ({
      excerpt: 'x'.repeat(len),
      sourceRef: '#1',
      position: '第1段',
      ts: null
    })
    // 字符预算 10：每 5 字符×2 个 = 10 字符一批（count 上限 3 不生效）
    const ranges = splitCardScans([mk(5), mk(5), mk(5), mk(5)], 0, 3, 10)
    expect(ranges).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }])
    // 单条超预算：至少纳入该条（避免死循环）
    const single = splitCardScans([mk(50), mk(5)], 0, 3, 10)
    expect(single).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }])
    // count 预算优先
    const byCount = splitCardScans([mk(1), mk(1), mk(1), mk(1)], 0, 2, 100)
    expect(byCount).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }])
  })

  it('clusterCandidateCards keeps only cards that plausibly describe the same fact (本地预筛/阻断法)', () => {
    const mk = (excerpt: string): { sourceRef: string; position: string; excerpt: string; ts: string | null } => ({
      sourceRef: '#1',
      position: '第1段',
      excerpt,
      ts: null
    })
    const items = [
      mk('2021年，全市普通高中录取 2599 人。'),
      mk('2021年，全市普通高中录取 2657 人。'),
      mk('全市幼儿园教职工总数 1.2 万人。'),
      mk('今天天气晴朗，适合出行。')
    ]
    const clusters = clusterCandidateCards(items)
    // 只有“同一事实的两种说法”进入候选簇；孤立卡片（不可能与其它卡片冲突）被跳过
    expect(clusters).toHaveLength(1)
    expect([...clusters[0]].sort((a, b) => a - b)).toEqual([0, 1])
  })

  it('packCandidateCalls keeps each cluster intact and respects count/char budgets (少调用)', () => {
    const mk = (excerpt: string): { sourceRef: string; position: string; excerpt: string; ts: string | null } => ({
      sourceRef: '#1',
      position: '第1段',
      excerpt,
      ts: null
    })
    const items = Array.from({ length: 6 }, () => mk('x'.repeat(100)))
    // 数量预算：每簇 2 张、上限 3 张 → 每簇单独一批（同簇不拆）
    expect(packCandidateCalls(items, [[0, 1], [2, 3], [4, 5]], 3, 100000)).toEqual([[0, 1], [2, 3], [4, 5]])
    // 字符预算：每张 100 字 → 每簇约 280 字，上限 300 → 每簇一批
    expect(packCandidateCalls(items, [[0, 1], [2, 3]], 100, 300)).toEqual([[0, 1], [2, 3]])
    // 预算充足 → 合并成一次调用（尽量减少调用次数）
    expect(packCandidateCalls(items, [[0, 1], [2, 3]], 100, 100000)).toEqual([[0, 1, 2, 3]])
  })

  it('reduceConcurrency halves (min 1) on rate limit (仅本次生成生效，不写回 Provider)', () => {
    expect(reduceConcurrency(8)).toBe(4)
    expect(reduceConcurrency(4)).toBe(2)
    expect(reduceConcurrency(3)).toBe(1)
    expect(reduceConcurrency(1)).toBe(1)
  })
})
