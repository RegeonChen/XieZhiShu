/**
 * retrieval.ts —— 本地资料检索（RAG）。
 * 向量检索方案决策（2026-08-05）：本轮不引入向量数据库/外部嵌入依赖，
 * 采用"字符 bigram 相似度 + 全文子串命中"的词法打分检索，纯本地、无网络、
 * 对中文无需分词即可工作；后续可按需扩展向量索引。
 * 检索范围严格限定在用户导入的资料（sourceIds 白名单）内，不引入外部信息。
 */
import Database from 'better-sqlite3'
import type { RetrievedChunk, Source } from '../../shared/types'
import { setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { getSourcesByIds } from '../db/sources'
import { vectorSearch } from './vector-store'
import { vectorToBuffer } from './indexer'

/** 单块最大字符数，超长段落按句切分 */
const CHUNK_MAX = 500

/**
 * 判定"标题行"（Task 3.4.4）：志书/年鉴正文中章节标题常独立成段（如"教育""学前教育""义务教育"），
 * 特征：短（≤12 字）、不以句末/句中标点结尾、不含数字。
 * 这类块只有标题、没有史实。检索查询词命中标题行会拿到极高词法分（短文本 bigram 重叠率满分），
 * 从而把实质正文段落全部挤出 TopN 配额，导致大模型拿到一堆标题、无米下锅（初稿只有寥寥几行）。
 * 分块与检索融合时均跳过，保证材料是真正有内容的正文。
 */
export function isTitleLikeLine(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/[。！？；：，,；]$/.test(t)) return false // 以标点结尾视为正文短句
  if (/[0-9０-９]/.test(t)) return false // 含数字可能是有效数据段
  // 纯标题/词组行：≤12 字的短语，或 ≤20 字且用空格分隔的标题词组（如"开放教育 成人教育 特殊教育"）
  if (t.length <= 12) return true
  if (t.length <= 20 && t.includes(' ')) return true
  return false
}

interface Chunk {
  text: string
  position: string
}

/**
 * chunkText 结果缓存（按 sourceId + contentHash 键控）：
 * 同一轮生成中 retrieveChunks 会被调用多次（正文检索 / 稳定主题词检索 / 检索预览），
 * 大资料（百万字 PDF）反复切分会造成不必要的 CPU 开销，这里按内容哈希缓存。
 * 无 contentHash 的存量资料不缓存（避免同长度不同内容的碰撞）。
 */
interface ChunkCacheEntry {
  hash: string
  chunks: Chunk[]
}

const chunkCache = new Map<string, ChunkCacheEntry>()

function chunkSourceText(source: Source): Chunk[] {
  if (!source.contentHash) return chunkText(source.cleanedText ?? '')
  const hit = chunkCache.get(source.id)
  if (hit && hit.hash === source.contentHash) return hit.chunks
  const chunks = chunkText(source.cleanedText ?? '')
  chunkCache.set(source.id, { hash: source.contentHash, chunks })
  return chunks
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
    // 跳过标题行：志书/年鉴中章节标题独立成段，无实质内容（Task 3.4.4）
    if (isTitleLikeLine(p)) return
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
export function bigrams(s: string): string[] {
  const chars = Array.from(s.replace(/\s+/g, ''))
  const out: string[] = []
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1])
  return out
}

export function dice(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const common = a.filter((x) => b.includes(x)).length
  return (2 * common) / (a.length + b.length)
}

/** 块与查询的相似度打分（queryBigrams/queryTerms 为预计算缓存，缺省时自行计算，保证纯函数可测） */
export function scoreChunk(
  query: string,
  chunk: string,
  sourceTitle: string,
  queryBigrams?: string[],
  queryTerms?: string[]
): number {
  const q = query.trim().toLowerCase()
  const t = chunk.trim().toLowerCase()
  if (!q || !t) return 0

  const qBigrams = queryBigrams ?? bigrams(q)
  const terms = queryTerms ?? q.split(/\s+/).filter(Boolean)

  let score = 0
  if (t.includes(q)) score += 100 + q.length // 完整查询命中
  // 查询含空格时按词分别命中
  for (const term of terms) {
    if (term.length > 1 && t.includes(term)) score += 20
  }
  score += dice(qBigrams, bigrams(t)) * 60 // bigram 重叠
  if (sourceTitle.toLowerCase().includes(q)) score += 20 // 标题相关加成
  return Math.round(score)
}

export interface RetrieveParams {
  sourceIds: string[]
  query: string
  /** 查询向量（由 embedding 模型生成）；提供时启用语义补充检索 */
  queryVector?: number[]
  /** 向量余弦保留阈值（Task 3.4.7）：低于视为"非常确定无关"；词法 score>0 的块不受此限制 */
  vecMinScore?: number
}

/**
 * 过滤式检索（Task 3.4.7）：不做 TopN 截断、不做每资料配额，只剔除"非常确定无关"的段落。
 * 保留规则：词法相关（scoreChunk > 0，即与标题有任何字面/字符对关联）或 向量相关（余弦 ≥ vecMinScore）的段落全部保留，
 * 标题行一律剔除。输出按来源、原文顺序组织（向量补充块追加在后）。
 * 目的：把粗筛后资料中尽可能多的有效内容完整供给大模型，篇幅由材料内容自然决定。
 */
export function retrieveChunks(params: RetrieveParams): RetrievedChunk[] {
  const { sourceIds, query, queryVector, vecMinScore = 0.3 } = params
  const q = query.trim()
  if (!q || sourceIds.length === 0) return []

  const sources = getSourcesByIds(sourceIds)
  const sourceById = new Map(sources.map((s) => [s.id, s]))
  const out: RetrievedChunk[] = []
  const seen = new Set<string>()
  // 查询侧 bigram/词条只算一次，供全部块复用（大资料量下显著省时）
  const qBigrams = bigrams(q)
  const qTerms = q.split(/\s+/).filter(Boolean)

  // 词法路：score > 0 保留（score === 0 = 与标题完全无字面/字符对关联 → 非常确定无关，剔除）
  for (const s of sources) {
    for (const c of chunkSourceText(s)) {
      const score = scoreChunk(q, c.text, s.title, qBigrams, qTerms)
      if (score <= 0) continue
      const key = `${s.id}|${c.position}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ sourceId: s.id, sourceTitle: s.title, position: c.position, text: c.text, score })
    }
  }

  // 向量路：全量余弦，≥ vecMinScore 的块并入（补充"字面无关但语义相关"的段落）
  if (queryVector && queryVector.length > 0) {
    const hits = vectorSearch(queryVector, sourceIds, 0)
    for (const h of hits) {
      if (h.score < vecMinScore) continue
      if (isTitleLikeLine(h.text)) continue
      const key = `${h.sourceId}|${h.position}`
      if (seen.has(key)) continue
      seen.add(key)
      const srcTitle = sourceById.get(h.sourceId)?.title ?? ''
      out.push({
        sourceId: h.sourceId,
        sourceTitle: srcTitle,
        position: h.position,
        text: h.text,
        score: Math.round(h.score * 100) // 向量补入块的展示分（0-100 量纲）
      })
    }
  }

  return out
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

    it('keeps all lexically related paragraphs and drops definitely-unrelated ones (Task 3.4.7)', () => {
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
      // s2 与"新区经济发展"无任何字面/字符对关联 → 非常确定无关，整份剔除
      expect(chunks.every((c) => c.sourceId === 's1')).toBe(true)
      // s1 的两段全部保留（score > 0），按原文顺序，不受 TopN 截断
      expect(chunks.map((c) => c.position)).toEqual(['第1段', '第2段'])
      expect(chunks[0].sourceTitle).toBe('新区经济发展概况')
    })

    it('returns nothing when no paragraph is related (no external info)', () => {
      const chunks = retrieveChunks({ sourceIds: ['s2'], query: '新区经济发展' })
      // 无关材料的所有段落都被过滤 → 无候选
      expect(chunks).toHaveLength(0)
    })

    it('returns empty for empty query or empty scope', () => {
      expect(retrieveChunks({ sourceIds: ['s1'], query: '' })).toHaveLength(0)
      expect(retrieveChunks({ sourceIds: [], query: 'x' })).toHaveLength(0)
    })

    it('vector path supplements semantically related paragraphs missed lexically (Task 3.4.7)', () => {
      insertSource('s3', '某年度报告', '适龄儿童入学率稳步提升，教师队伍不断壮大，教学设施持续改善。')
      // 预置向量索引（queryVector 与之高度相似）
      db.prepare(
        `INSERT INTO chunk_embeddings (id, source_id, chunk_text, position, embedding, model_id, created_at)
         VALUES ('c3', 's3', '适龄儿童入学率稳步提升，教师队伍不断壮大，教学设施持续改善。', '第1段', ?, 'test', datetime('now'))`
      ).run(vectorToBuffer([1, 0, 0, 0]))

      // 纯词法：标题与正文均无"教育"字样 → 词法分 0，无候选
      const lexOnly = retrieveChunks({ sourceIds: ['s3'], query: '教育事业发展' })
      expect(lexOnly).toHaveLength(0)
      // 向量路：余弦 1 ≥ vecMinScore → 语义相关的段落被补充保留
      const hybrid = retrieveChunks({ sourceIds: ['s3'], query: '教育事业发展', queryVector: [1, 0, 0, 0] })
      expect(hybrid).toHaveLength(1)
      expect(hybrid[0].sourceId).toBe('s3')
      expect(hybrid[0].text).toContain('入学率')
    })

    it('skips title-like lines in chunking so headings never fill material quota (Task 3.4.4)', () => {
      const chunks = chunkText('教育\n\n学前教育。\n\n义务教育\n\n开放教育 成人教育 特殊教育\n\n2021年，全区共有各级各类学校212所，在校生117679人。')
      const texts = chunks.map((c) => c.text)
      // 无句末标点的短标题行与空格分隔的标题词组行被过滤
      expect(texts).not.toContain('教育')
      expect(texts).not.toContain('义务教育')
      expect(texts).not.toContain('开放教育 成人教育 特殊教育')
      // 带句号的短句与有内容的正文保留
      expect(texts).toContain('学前教育。')
      expect(texts).toContain('2021年，全区共有各级各类学校212所，在校生117679人。')
    })

    it('excludes vector-only title-like hits in retrieval (Task 3.4.4)', () => {
      // 历史向量库中残留标题行块"教育"（词法路已无该块）
      insertSource('s4', '某教育报告', '2021年，全区共有各级各类学校212所。')
      db.prepare(
        `INSERT INTO chunk_embeddings (id, source_id, chunk_text, position, embedding, model_id, created_at)
         VALUES ('c4', 's4', '教育', '第1段', ?, 'test', datetime('now'))`
      ).run(vectorToBuffer([1, 0, 0, 0]))
      const hits = retrieveChunks({ sourceIds: ['s4'], query: '教育事业发展', queryVector: [1, 0, 0, 0] })
      expect(hits.some((c) => c.text === '教育')).toBe(false)
      expect(hits.every((c) => !isTitleLikeLine(c.text))).toBe(true)
    })

    it('keeps all related paragraphs without TopN cap (Task 3.4.7)', () => {
      // 一个资料内多个段落均与标题相关 → 全部保留，不设数量上限
      insertSource(
        's5',
        '教育事业发展综述',
        '第一段涉及教育工作概况。\n第二段继续安排教育工作。\n第三段落实教育经费。\n第四段推进教师队伍建设。\n第五段部署秋季开学工作。'
      )
      const chunks = retrieveChunks({ sourceIds: ['s5'], query: '教育' })
      expect(chunks).toHaveLength(5)
      expect(chunks.map((c) => c.position)).toEqual(['第1段', '第2段', '第3段', '第4段', '第5段'])
    })

    it('drops vector hits below vecMinScore (definitely unrelated, Task 3.4.7)', () => {
      insertSource('s6', '无关文档', '与主题完全无关的内容，讲的是天气变化。')
      db.prepare(
        `INSERT INTO chunk_embeddings (id, source_id, chunk_text, position, embedding, model_id, created_at)
         VALUES ('c6', 's6', '与主题完全无关的内容，讲的是天气变化。', '第1段', ?, 'test', datetime('now'))`
      ).run(vectorToBuffer([0, 1, 0, 0]))
      // 词法分 0（无"教育"字样），向量余弦 0 < 0.3 → 非常确定无关，剔除
      const hits = retrieveChunks({ sourceIds: ['s6'], query: '教育', queryVector: [1, 0, 0, 0] })
      expect(hits).toHaveLength(0)
    })
  })
}
