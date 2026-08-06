/**
 * vector-store.ts —— 向量存储与余弦检索（Phase 3.2 Task 3.2.2）。
 * 读取 chunk_embeddings 中指定资料范围的向量块，用查询向量做余弦相似度排序。
 * 资料规模下（数千块）内存暴力检索即可，无需引入 ANN 索引。
 */
import { getDb } from '../db/connection'
import { bufferToVector } from './indexer'

export interface VectorHit {
  sourceId: string
  position: string
  text: string
  score: number
}

/** 余弦相似度 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 在指定资料范围内做向量相似度检索（按相似度降序，返回前 limit 条） */
export function vectorSearch(queryVec: number[], sourceIds: string[], limit = 200): VectorHit[] {
  if (sourceIds.length === 0) return []
  const db = getDb()
  const q = new Float32Array(queryVec)
  const placeholders = sourceIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT source_id, chunk_text, position, embedding
       FROM chunk_embeddings
       WHERE source_id IN (${placeholders})`
    )
    .all(...sourceIds) as { source_id: string; chunk_text: string; position: string; embedding: Buffer }[]
  const hits: VectorHit[] = []
  for (const r of rows) {
    hits.push({
      sourceId: r.source_id,
      position: r.position,
      text: r.chunk_text,
      score: cosine(q, bufferToVector(r.embedding))
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('vector store (Task 3.2.2)', () => {
    it('computes cosine similarity (identical = 1, orthogonal = 0)', () => {
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([1, 0, 0])
      const c = new Float32Array([0, 1, 0])
      expect(cosine(a, b)).toBeCloseTo(1, 5)
      expect(cosine(a, c)).toBeCloseTo(0, 5)
      expect(cosine(new Float32Array([0, 0, 0]), a)).toBe(0)
    })
  })
}
