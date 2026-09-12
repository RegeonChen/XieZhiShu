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
import { logMain } from '../logger'
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
    // 成功：清空失败原因（避免旧错误一直挂在界面上）
    db.prepare('UPDATE sources SET index_state = ?, indexed_at = ?, index_error = NULL, updated_at = ? WHERE id = ?')
      .run(state, indexedAt, now, sourceId)
  } else {
    db.prepare('UPDATE sources SET index_state = ?, updated_at = ? WHERE id = ?').run(state, now, sourceId)
  }
}

/** 记录索引失败原因（供设置页展示；截断避免超长堆栈进库） */
function setIndexError(sourceId: string, error: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare('UPDATE sources SET index_state = ?, index_error = ?, updated_at = ? WHERE id = ?')
    .run('failed', error.slice(0, 600), now, sourceId)
}

export interface IndexStatus {
  total: number
  ready: number
  pending: number
  indexing: number
  failed: number
  /** 最近一次失败原因（失败样本；没有失败时为 null） */
  lastError: string | null
  /** 失败原因里最近一条对应的时间，用于判断"是否本次会话尝试过" */
  lastErrorAt: string | null
}

/** 索引状态汇总（设置页展示：是否可用、失败原因、是否需要重建） */
export function getIndexStatus(): IndexStatus {
  const db = getDb()
  const rows = db
    .prepare('SELECT index_state, COUNT(*) AS c FROM sources GROUP BY index_state')
    .all() as { index_state: string; c: number }[]
  const count = (state: string): number => rows.find((r) => r.index_state === state)?.c ?? 0
  const last = db
    .prepare("SELECT index_error, updated_at FROM sources WHERE index_state = 'failed' AND index_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1")
    .get() as { index_error: string; updated_at: string } | undefined
  return {
    total: rows.reduce((n, r) => n + r.c, 0),
    ready: count('ready'),
    pending: count('pending'),
    indexing: count('indexing'),
    failed: count('failed'),
    lastError: last?.index_error ?? null,
    lastErrorAt: last?.updated_at ?? null
  }
}

/** 清掉失败标记，让这些资料可以被重新索引（"重建索引"前调用） */
export function resetFailedIndex(): number {
  const db = getDb()
  return db
    .prepare("UPDATE sources SET index_state = 'pending', index_error = NULL, updated_at = ? WHERE index_state = 'failed'")
    .run(new Date().toISOString()).changes
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
    // 分批嵌入：推理已在 Worker 线程执行（不阻塞主进程事件循环），仍保持小批次，
    // 避免单批过大占用内存/单次响应过久；批间让出事件循环，保持界面响应。
    const EMBED_BATCH = 5
    const vectors: number[][] = []
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const slice = chunks.slice(i, i + EMBED_BATCH)
      const vecs = await embedTexts(slice.map((c) => c.text))
      vectors.push(...vecs)
      await new Promise<void>((r) => setImmediate(() => r()))
    }
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
    // 失败原因落库（`index_error`）+ 日志：2026-09-12 之前只有 console.error，用户侧完全看不到
    // 为什么"语义检索没生效"（实测全库 index_state='failed' 而原因不可查）。
    const reason = err instanceof Error ? err.message : String(err)
    setIndexError(sourceId, reason)
    logMain('rag', '向量索引失败 source=' + sourceId + ' 原因=' + reason)
    return { ok: false, error: reason }
  }
}

/** 索引所有未就绪的资料（后台批量调用；失败原因写入 index_error） */
export async function indexAllPending(
  onProgress?: (done: number, total: number) => void
): Promise<{ indexed: number; failed: number; total: number; firstError?: string }> {
  const db = getDb()
  const rows = db.prepare("SELECT id FROM sources WHERE index_state != 'ready'").all() as { id: string }[]
  let indexed = 0
  let failed = 0
  let firstError: string | undefined
  for (const [i, r] of rows.entries()) {
    const res = await indexSource(r.id)
    if (res.ok) indexed += 1
    else {
      failed += 1
      firstError = firstError ?? res.error
    }
    onProgress?.(i + 1, rows.length)
  }
  return { indexed, failed, total: rows.length, firstError }
}

/**
 * 同步等待一批资料索引就绪（网页资料库用）：生成汇编前必须让本次抓取的网页文章进入向量索引，
 * 否则保守闸门里那些"字面不相关但语义相关"的网页段落会因为查不到向量而被整篇丢弃。
 * - 已 ready 的跳过；
 * - 串行索引（嵌入本身是 CPU 密集且内部已分批），总耗时受 `budgetMs` 约束，超预算即返回并记 `skipped`；
 * - 单篇失败不抛出（宁可少一些向量兜底，也不能让生成中断）。
 */
export async function ensureSourcesIndexed(
  sourceIds: string[],
  budgetMs = 120000
): Promise<{ indexed: number; failed: number; skipped: number }> {
  const db = getDb()
  const startedAt = Date.now()
  let indexed = 0
  let failed = 0
  let skipped = 0
  for (const id of Array.from(new Set(sourceIds))) {
    const row = db.prepare('SELECT index_state FROM sources WHERE id = ?').get(id) as { index_state: string } | undefined
    if (!row) continue
    if (row.index_state === 'ready') continue
    if (Date.now() - startedAt > budgetMs) {
      skipped += 1
      continue
    }
    try {
      const res = await indexSource(id)
      if (res.ok) indexed += 1
      else failed += 1
    } catch {
      failed += 1
    }
  }
  return { indexed, failed, skipped }
}

// ---- 后台串行索引队列 ----
// 工作区对账（reconcile）只负责"解析入库"，向量化改为异步提交到此队列后台执行：
// 新文件立刻出现在列表，向量索引在后台推进（推理在 Worker 线程），不阻塞主进程与 UI。

let indexQueue: Promise<void> = Promise.resolve()
const queuedIndexIds = new Set<string>()

/** 异步提交一个资料的向量索引任务（串行执行；同一资料同时仅允许一个在队/在跑任务） */
export function enqueueIndex(sourceId: string): void {
  if (queuedIndexIds.has(sourceId)) return
  queuedIndexIds.add(sourceId)
  indexQueue = indexQueue.then(async () => {
    try {
      await indexSource(sourceId)
    } catch (err) {
      console.error(`后台索引失败（${sourceId}）:`, err)
    } finally {
      queuedIndexIds.delete(sourceId)
    }
  })
}

/** 后台队列里尚未处理的资料数（设置页轮询"重建索引"进度用） */
export function getQueueSize(): number {
  return queuedIndexIds.size
}

/**
 * 重建索引：按需清掉失败标记，并把所有未就绪资料交给**后台串行队列**（不阻塞 IPC）。
 * 界面只需轮询 `getIndexStatus()` 看 ready 数上升；单篇失败不影响其余资料。
 */
export function requeuePendingIndexes(includeFailed = true): { queued: number; reset: number } {
  const reset = includeFailed ? resetFailedIndex() : 0
  const db = getDb()
  const rows = db.prepare("SELECT id FROM sources WHERE index_state != 'ready'").all() as { id: string }[]
  for (const r of rows) enqueueIndex(r.id)
  return { queued: rows.length, reset }
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
      const row = db.prepare("SELECT index_state, index_error FROM sources WHERE id = 's-model'").get() as { index_state: string; index_error: string | null }
      expect(row.index_state).toBe('failed')
      // 2026-09-12：失败原因必须落库（此前只有日志，用户侧看不到为什么语义检索没生效）
      expect(row.index_error).toContain('嵌入')
    })

    it('reports index status and can reset failures for a rebuild (2026-09-12)', async () => {
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status, index_state) VALUES ('s-ok', 'file', '已索引', '正文', 'ready', 'ready')`
      ).run()
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status, index_state, index_error) VALUES ('s-bad', 'file', '失败', '正文', 'ready', 'failed', '本地嵌入不可用：xxx')`
      ).run()
      const st = getIndexStatus()
      expect(st.ready).toBeGreaterThanOrEqual(1)
      expect(st.failed).toBeGreaterThanOrEqual(1)
      expect(st.total).toBeGreaterThanOrEqual(st.ready + st.failed)
      // 最近失败原因透出给设置页（取不到时应为 null，而不是抛错）
      expect(st.lastError).toBeTruthy()

      // 重建：失败标记被清掉，资料回到 pending 以便重新入队
      const reset = resetFailedIndex()
      expect(reset).toBeGreaterThanOrEqual(1)
      const after = db.prepare("SELECT index_state, index_error FROM sources WHERE id = 's-bad'").get() as { index_state: string; index_error: string | null }
      expect(after.index_state).toBe('pending')
      expect(after.index_error).toBeNull()
      expect(getIndexStatus().failed).toBe(0)
      // 队列计数在无排队任务时为 0（界面据此判断"重建是否结束"）
      expect(getQueueSize()).toBe(0)
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
