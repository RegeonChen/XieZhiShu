/**
 * indexer.ts —— 向量索引流水线（Phase 3.2 Task 3.2.1）。
 * 资料导入/更新后自动增量索引：分块 → 本地向量化 → 写入 chunk_embeddings。
 * 幂等：先删除该资料旧分块再插入；sources.index_state 标记进度。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { getDb, setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { chunkText } from './retrieval'
import { configureEmbedModel, embedTexts, getEmbedModelId } from './embed'

/** float32 数组 ↔ SQLite BLOB 互转 */
export function vectorToBuffer(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer)
}

export function bufferToVector(b: Buffer): Float32Array {
  return new Float32Array(new Uint8Array(b).buffer)
}

type IndexState = 'pending' | 'indexing' | 'ready' | 'failed'

function setState(sourceId: string, state: IndexState, indexedAt?: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  if (indexedAt) {
    db.prepare('UPDATE sources SET index_state = ?, indexed_at = ?, updated_at = ? WHERE id = ?').run(state, indexedAt, now, sourceId)
  } else {
    db.prepare('UPDATE sources SET index_state = ?, updated_at = ? WHERE id = ?').run(state, now, sourceId)
  }
}

/** 为单个资料建立向量索引（幂等：先清旧块再插入） */
export async function indexSource(sourceId: string): Promise<{ ok: boolean; error?: string; chunks?: number }> {
  const db = getDb()
  const row = db.prepare('SELECT id, cleaned_text FROM sources WHERE id = ?').get(sourceId) as
    | { id: string; cleaned_text: string }
    | undefined
  if (!row) return { ok: false, error: '资料不存在' }

  // 空资料无需向量化，直接标记就绪
  if (row.cleaned_text.trim().length === 0) {
    setState(sourceId, 'ready', new Date().toISOString())
    return { ok: true, chunks: 0 }
  }

  setState(sourceId, 'indexing')
  try {
    const chunks = chunkText(row.cleaned_text)
    const vectors = await embedTexts(chunks.map((c) => c.text))
    const modelId = getEmbedModelId()
    const now = new Date().toISOString()

    const tx = db.transaction(
      (rows: { id: string; text: string; position: string; vec: Buffer }[]) => {
        db.prepare('DELETE FROM chunk_embeddings WHERE source_id = ?').run(sourceId)
        const ins = db.prepare(
          'INSERT INTO chunk_embeddings (id, source_id, chunk_text, position, embedding, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        for (const r of rows) ins.run(r.id, sourceId, r.text, r.position, r.vec, modelId, now)
      }
    )
    tx(
      chunks.map((c, i) => ({
        id: randomUUID(),
        text: c.text,
        position: c.position,
        vec: vectorToBuffer(vectors[i])
      }))
    )

    setState(sourceId, 'ready', now)
    return { ok: true, chunks: chunks.length }
  } catch (err) {
    setState(sourceId, 'failed')
    return { ok: false, error: String(err) }
  }
}

/** 索引所有未就绪的资料（后台批量调用） */
export async function indexAllPending(): Promise<{ indexed: number; failed: number }> {
  const db = getDb()
  const rows = db.prepare("SELECT id FROM sources WHERE index_state != 'ready'").all() as { id: string }[]
  let indexed = 0
  let failed = 0
  for (const r of rows) {
    const res = await indexSource(r.id)
    if (res.ok) indexed += 1
    else failed += 1
  }
  return { indexed, failed }
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

  describe('vector indexer (Task 3.2.1)', () => {
    it('round-trips float32 vectors to/from blob', () => {
      const v = [0.1, -0.2, 0.3, 1, -1, 2.5]
      const got = Array.from(bufferToVector(vectorToBuffer(v)))
      // float32 存储存在舍入误差，用近似比较
      got.forEach((x, i) => expect(x).toBeCloseTo(v[i], 6))
    })

    it('marks empty sources as ready without embedding', async () => {
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s-empty', 'file', '空资料', '', 'ready')`
      ).run()
      const res = await indexSource('s-empty')
      expect(res.ok).toBe(true)
      expect(res.chunks).toBe(0)
      const row = db.prepare("SELECT index_state, indexed_at FROM sources WHERE id = 's-empty'").get() as { index_state: string; indexed_at: string | null }
      expect(row.index_state).toBe('ready')
      expect(row.indexed_at).not.toBeNull()
    })

    it('fails clearly when embed model is missing (keeps index_state failed)', async () => {
      // 将模型目录指向不存在的路径，确定性模拟"模型缺失"（本机已下载真实模型）
      configureEmbedModel({ modelPath: join(process.cwd(), 'resources', 'models-not-exist') })
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s-model', 'file', '有内容', '这里是一段需要向量化的正文内容。', 'ready')`
      ).run()
      const res = await indexSource('s-model')
      expect(res.ok).toBe(false)
      // 引擎后端不可用或模型文件缺失均应给出明确错误
      expect(res.error).toContain('嵌入')
      const row = db.prepare("SELECT index_state FROM sources WHERE id = 's-model'").get() as { index_state: string }
      expect(row.index_state).toBe('failed')
    })

    it('stores chunk rows after successful embedding (mock free via direct insert path)', () => {
      // 直接验证 chunk_embeddings 结构与级联删除（不依赖模型）
      const srcId = 's-vec'
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', '资料', '正文内容足够长。', 'ready')`
      ).run(srcId)
      db.prepare(
        `INSERT INTO chunk_embeddings (id, source_id, chunk_text, position, embedding, model_id, created_at) VALUES ('c1', ?, '正文内容足够长。', '第1段', ?, 'test-model', datetime('now'))`
      ).run(srcId, vectorToBuffer([1, 2, 3]))
      const row = db.prepare('SELECT * FROM chunk_embeddings WHERE id = ?').get('c1') as { source_id: string; embedding: Buffer }
      expect(row.source_id).toBe(srcId)
      expect(Array.from(bufferToVector(row.embedding))).toEqual([1, 2, 3])
      // 删除资料级联清理向量
      db.prepare('DELETE FROM sources WHERE id = ?').run(srcId)
      expect(db.prepare('SELECT COUNT(*) AS c FROM chunk_embeddings WHERE id = ?').get('c1') as { c: number }).toEqual({ c: 0 })
    })
  })
}
