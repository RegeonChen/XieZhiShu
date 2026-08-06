/**
 * retrieval.ts —— 本地资料检索（RAG）。
 * 向量检索方案决策（2026-08-05）：本轮不引入向量数据库/外部嵌入依赖，
 * 采用"字符 bigram 相似度 + 全文子串命中"的词法打分检索，纯本地、无网络、
 * 对中文无需分词即可工作；后续可按需扩展向量索引。
 * 检索范围严格限定在用户导入的资料（sourceIds 白名单）内，不引入外部信息。
 */
import Database from 'better-sqlite3'
import type { RetrievedChunk } from '../../shared/types'
import { setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { getSourcesByIds } from '../db/sources'

/** 单块最大字符数，超长段落按句切分 */
const CHUNK_MAX = 500
/** 每个资料最多贡献的块数 */
const MAX_PER_SOURCE = 3
/** 低于该分值视为不相关 */
const MIN_SCORE = 5

interface Chunk {
  text: string
  position: string
}

/** 按段落切分；超长段落按句读（。！？；）折分成 ≤ CHUNK_MAX 的块 */
export function chunkText(text: string): Chunk[] {
  const paras = text
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const chunks: Chunk[] = []
  paras.forEach((p, i) => {
    const pos = `第${i + 1}段`
    if (p.length <= CHUNK_MAX) {
      chunks.push({ text: p, position: pos })
      return
    }
    // 按句切分
    const sentences = p.split(/(?<=[。！？；;])/).map((s) => s.trim()).filter(Boolean)
    let buf = ''
    let sub = 1
    const flush = () => {
      if (buf) {
        chunks.push({ text: buf, position: `${pos}（片段${sub}）` })
        sub += 1
        buf = ''
      }
    }
    for (const s of sentences) {
      if (buf.length + s.length > CHUNK_MAX) flush()
      buf += s
    }
    flush()
  })
  return chunks
}

/** 字符 bigram（中文无需分词，用相邻字符对近似文本相似度） */
function bigrams(s: string): string[] {
  const chars = Array.from(s.replace(/\s+/g, ''))
  const out: string[] = []
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1])
  return out
}

function dice(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const common = a.filter((x) => b.includes(x)).length
  return (2 * common) / (a.length + b.length)
}

/** 块与查询的相似度打分 */
export function scoreChunk(query: string, chunk: string, sourceTitle: string): number {
  const q = query.trim().toLowerCase()
  const t = chunk.trim().toLowerCase()
  if (!q || !t) return 0

  let score = 0
  if (t.includes(q)) score += 100 + q.length // 完整查询命中
  // 查询含空格时按词分别命中
  for (const term of q.split(/\s+/).filter(Boolean)) {
    if (term.length > 1 && t.includes(term)) score += 20
  }
  score += dice(bigrams(q), bigrams(t)) * 60 // bigram 重叠
  if (sourceTitle.toLowerCase().includes(q)) score += 20 // 标题相关加成
  return Math.round(score)
}

export interface RetrieveParams {
  sourceIds: string[]
  query: string
  limit?: number
}

/** 在指定资料范围内检索与查询最相关的片段（含来源与位置） */
export function retrieveChunks(params: RetrieveParams): RetrievedChunk[] {
  const { sourceIds, query, limit = 12 } = params
  const q = query.trim()
  if (!q || sourceIds.length === 0) return []

  const sources = getSourcesByIds(sourceIds)
  const bySource = new Map<string, RetrievedChunk[]>()
  for (const s of sources) {
    for (const c of chunkText(s.cleanedText ?? '')) {
      const score = scoreChunk(q, c.text, s.title)
      if (score < MIN_SCORE) continue
      const item: RetrievedChunk = {
        sourceId: s.id,
        sourceTitle: s.title,
        position: c.position,
        text: c.text,
        score
      }
      const arr = bySource.get(s.id) ?? []
      arr.push(item)
      bySource.set(s.id, arr)
    }
  }

  // 每个来源取 Top3，再全局排序取 TopN，保证材料多样性
  const pooled: RetrievedChunk[] = []
  for (const arr of bySource.values()) {
    arr.sort((a, b) => b.score - a.score)
    pooled.push(...arr.slice(0, MAX_PER_SOURCE))
  }
  pooled.sort((a, b) => b.score - a.score)
  return pooled.slice(0, limit)
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
  })
  afterAll(() => db.close())

  function insertSource(id: string, title: string, cleanedText: string): void {
    db.prepare(
      `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', ?, ?, 'ready')`
    ).run(id, title, cleanedText)
  }

  describe('RAG retrieval (Task 3.2)', () => {
    it('chunks text by paragraphs', () => {
      const chunks = chunkText('第一段内容。\n\n第二段内容，这一段很长' + '。'.repeat(600))
      expect(chunks[0].text).toContain('第一段')
      expect(chunks[0].position).toBe('第1段')
      expect(chunks.length).toBeGreaterThanOrEqual(2)
    })

    it('retrieves relevant chunks with source and position', () => {
      insertSource(
        's1',
        '新区经济发展概况',
        '2019年，新区实现地区生产总值120亿元。\n招商引资项目落地，产业规模持续扩大。'
      )
      insertSource(
        's2',
        '某区教育发展报告',
        '小学教育适龄儿童入学率达到99%。\n教师队伍建设不断加强。'
      )

      const chunks = retrieveChunks({ sourceIds: ['s1', 's2'], query: '新区经济发展' })
      expect(chunks.length).toBeGreaterThan(0)
      const top = chunks[0]
      expect(top.sourceId).toBe('s1')
      expect(top.position).toBe('第1段')
      expect(top.sourceTitle).toBe('新区经济发展概况')
    })

    it('strictly limits to given sourceIds (no external info)', () => {
      const chunks = retrieveChunks({ sourceIds: ['s2'], query: '新区经济发展' })
      expect(chunks.every((c) => c.sourceId === 's2')).toBe(true)
      // 无关材料应得分过低而不返回
      expect(chunks).toHaveLength(0)
    })

    it('returns empty for empty query or empty scope', () => {
      expect(retrieveChunks({ sourceIds: ['s1'], query: '' })).toHaveLength(0)
      expect(retrieveChunks({ sourceIds: [], query: 'x' })).toHaveLength(0)
    })
  })
}
