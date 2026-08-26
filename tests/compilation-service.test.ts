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
  buildCompilationSourceRefs
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

  it('recallCandidateChunks returns empty for empty query or scope', () => {
    expect(recallCandidateChunks([], '园所设置')).toEqual([])
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
})
