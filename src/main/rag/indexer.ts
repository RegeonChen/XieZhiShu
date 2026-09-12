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
import { readSetting, writeSetting } from '../db/settings'
import { logMain } from '../logger'
import { chunkText } from './retrieval'
import { configureEmbedModel, embedTexts, EMBED_WORKER_POOL_SIZE, getEmbedModelId } from './embed'

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

// ================= 重建（rebuild）状态：跨页面切换与跨重启可见、可续跑 =================

/** 重建状态：running=正在跑；interrupted=上次被关软件打断（可「继续重建」）；done=已完成 */
export type RebuildStatus = 'running' | 'interrupted' | 'done'

interface RebuildRecord {
  status: RebuildStatus
  startedAt: string
  updatedAt: string
  /** 本次重建开始时的待索引篇数（算进度用：已完成 = totalQueued − 当前未就绪数） */
  totalQueued: number
}

const REBUILD_KEY = 'index_rebuild'
/** 进程内是否有重建在跑（持久化记录写 running、进程内无任务 = 上次被重启打断） */
let rebuildRunning = false

function readRebuildRecord(): RebuildRecord | null {
  const raw = readSetting(REBUILD_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RebuildRecord>
    if (parsed.status !== 'running' && parsed.status !== 'interrupted' && parsed.status !== 'done') return null
    return {
      status: parsed.status,
      startedAt: parsed.startedAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      totalQueued: Number(parsed.totalQueued ?? 0)
    }
  } catch {
    return null
  }
}

function writeRebuildRecord(status: RebuildStatus, totalQueued: number, startedAt?: string): void {
  const now = new Date().toISOString()
  writeSetting(REBUILD_KEY, JSON.stringify({ status, startedAt: startedAt ?? now, updatedAt: now, totalQueued } satisfies RebuildRecord))
}

/** 当前未就绪（仍需索引）的篇数 */
function countNotReady(): number {
  const db = getDb()
  return (db.prepare("SELECT COUNT(*) AS c FROM sources WHERE index_state != 'ready'").get() as { c: number }).c
}

/**
 * 启动时初始化索引状态（主进程 whenReady 调用）：
 * 1. 上次被强杀时停在 `indexing` 的资料**改回 pending**（否则它们永远不再被索引）；
 * 2. 持久化记录若仍是 `running`，说明上次是**被关软件打断**的 → 标 `interrupted`（界面显示「继续重建」）；
 * 3. 已无待索引资料时直接标 `done`，避免界面留下假的"可继续"。
 */
export function initIndexingState(): { resetIndexing: number; interrupted: boolean } {
  const db = getDb()
  const resetIndexing = db
    .prepare("UPDATE sources SET index_state = 'pending', updated_at = ? WHERE index_state = 'indexing'")
    .run(new Date().toISOString()).changes
  const rec = readRebuildRecord()
  let interrupted = false
  if (rec?.status === 'running') {
    const remaining = countNotReady()
    if (remaining > 0) {
      // 保留原来的 totalQueued/startedAt：进度继续按"整轮重建"算，界面上的百分比不会在续跑时跳回去
      writeRebuildRecord('interrupted', rec.totalQueued, rec.startedAt)
      interrupted = true
      logMain('rag', `上次重建被中断：剩余 ${remaining} 篇未索引（设置页可「继续重建」）`)
    } else {
      writeRebuildRecord('done', rec.totalQueued, rec.startedAt)
    }
  } else if (rec?.status === 'interrupted' && countNotReady() === 0) {
    writeRebuildRecord('done', rec.totalQueued, rec.startedAt)
  }
  if (resetIndexing > 0) logMain('rag', `启动清理：${resetIndexing} 篇停在 indexing 的资料改回 pending`)
  return { resetIndexing, interrupted }
}

/** 重建进度（跨重启可算：已完成 = 开始时待索引数 − 当前未就绪数） */
export interface RebuildProgress {
  status: RebuildStatus
  startedAt: string | null
  /** 本次重建开始时待索引篇数 */
  totalQueued: number
  /** 尚未索引篇数（pending + indexing + failed） */
  remaining: number
  /** 已处理篇数（含失败；失败的资料要等用户再次点重建才重试） */
  processed: number
  /** 0-100 */
  percent: number
  /** 进程内是否正在跑（区分"真在跑"与"记录说在跑但其实是上次被打断"） */
  active: boolean
}

export function getRebuildProgress(): RebuildProgress {
  const rec = readRebuildRecord()
  const remaining = countNotReady()
  if (!rec) {
    return { status: 'done', startedAt: null, totalQueued: 0, remaining, processed: 0, percent: 100, active: false }
  }
  const processed = Math.max(0, rec.totalQueued - remaining)
  const percent =
    rec.totalQueued > 0 ? Math.min(100, Math.round((processed / rec.totalQueued) * 100)) : remaining === 0 ? 100 : 0
  return {
    status: rec.status,
    startedAt: rec.startedAt,
    totalQueued: rec.totalQueued,
    remaining,
    processed,
    percent,
    active: rebuildRunning && rec.status === 'running'
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
    /*
     * 一次性把整篇分块交给 embedTexts：由它按长度分组投喂（同批长度相近 → padding 浪费最小，
     * 2026-09-12 实测 23ms/条 vs 原样顺序 162ms/条），批间自行让出事件循环。
     */
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

/** 后台队列里尚未处理的资料数（设置页轮询"重建"进度用） */
export function getQueueSize(): number {
  return queuedIndexIds.size + rebuildPendingIds.size
}

/**
 * 重建并发度：与 Worker 池同量级（每篇资料的嵌入调用会真正占用一个 Worker），
 * 再高只会排队等 Worker，反而不利于进度可读性。
 */
const REBUILD_CONCURRENCY = Math.max(2, EMBED_WORKER_POOL_SIZE)

/** 重建中"已入队但还没处理完"的资料 id（用于进度与"是否还在跑"） */
const rebuildPendingIds = new Set<string>()

/**
 * 重建索引（可反复点、可中断续跑）：
 * - 只处理**未就绪**（pending / indexing / failed）的资料，**已 ready 的一律不动**（幂等，不重复索引）；
 * - 按 `REBUILD_CONCURRENCY` 并发跑（配合 embed 的 Worker 池把 CPU 用满）；
 * - 状态与进度写入 settings（`index_rebuild`），**跨页面切换与跨重启可见**；被关软件打断后
 *   启动时会被标成 `interrupted`，界面显示「继续重建」，再点即从剩余部分继续；
 * - 全部跑完写 `done`（失败篇数另计，失败资料要等用户再次点重建才重试）。
 */
export function requeuePendingIndexes(includeFailed = true): { queued: number; reset: number } {
  const reset = includeFailed ? resetFailedIndex() : 0
  const db = getDb()
  const rows = db.prepare("SELECT id FROM sources WHERE index_state != 'ready'").all() as { id: string }[]
  const ids = rows.map((r) => r.id)
  /*
   * 续跑（上次被打断，或用户在跑的过程中又点了一次）沿用同一轮的分母与开始时间，
   * 这样进度是单调前进的 21% → 60% → 100%，而不是每次续跑都从头算。
   */
  const prev = readRebuildRecord()
  const continuing = prev != null && prev.status !== 'done'
  const startedAt = continuing ? prev.startedAt : undefined
  const totalQueued = continuing ? Math.max(prev.totalQueued, ids.length) : ids.length
  writeRebuildRecord('running', totalQueued, startedAt)
  rebuildRunning = ids.length > 0
  if (ids.length === 0) {
    writeRebuildRecord('done', totalQueued, startedAt)
    return { queued: 0, reset }
  }
  for (const id of ids) rebuildPendingIds.add(id)
  void runRebuildQueue(ids, totalQueued, startedAt)
  return { queued: ids.length, reset }
}

/** 并发执行重建队列；全部结束后把持久化状态落到 done */
async function runRebuildQueue(ids: string[], totalQueued: number, startedAt?: string): Promise<void> {
  let cursor = 0
  let indexed = 0
  let failed = 0
  let firstError: string | undefined
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= ids.length) return
      const id = ids[i]
      try {
        const res = await indexSource(id)
        if (res.ok) indexed += 1
        else {
          failed += 1
          firstError = firstError ?? res.error
        }
      } catch (err) {
        failed += 1
        firstError = firstError ?? String(err)
      } finally {
        rebuildPendingIds.delete(id)
      }
    }
  }
  const started = Date.now()
  try {
    await Promise.all(Array.from({ length: Math.min(REBUILD_CONCURRENCY, ids.length) }, () => worker()))
  } finally {
    const secs = Math.round((Date.now() - started) / 1000)
    logMain('rag', `重建索引结束：成功 ${indexed} 篇 / 失败 ${failed} 篇 / 共 ${ids.length} 篇，耗时 ${secs}s${firstError ? '；首个失败原因：' + firstError : ''}`)
    rebuildRunning = false
    writeRebuildRecord('done', totalQueued, startedAt)
  }
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

    it('marks a persisted running rebuild as interrupted and requeues stale indexing rows (2026-09-12)', () => {
      // 模拟"上次被关软件打断"：持久化记录还是 running，且有资料停在 indexing
      writeSetting('index_rebuild', JSON.stringify({ status: 'running', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', totalQueued: 9 }))
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status, index_state) VALUES ('s-stale','file','被打断','正文','ready','indexing')`
      ).run()

      const res = initIndexingState()
      expect(res.resetIndexing).toBeGreaterThanOrEqual(1)
      expect(res.interrupted).toBe(true)
      // 停在 indexing 的资料必须回到 pending，否则永远不会再被索引
      expect(db.prepare("SELECT index_state FROM sources WHERE id = 's-stale'").get()).toEqual({ index_state: 'pending' })
      // 进度从持久化记录 + 当前未就绪数推导（重启后仍可见）
      const p = getRebuildProgress()
      expect(p.status).toBe('interrupted')
      expect(p.startedAt).toBe('2026-01-01T00:00:00.000Z')
      expect(p.totalQueued).toBe(9)
      expect(p.active).toBe(false)
      expect(p.remaining).toBeGreaterThan(0)
      expect(p.processed).toBe(Math.max(0, 9 - p.remaining))
    })

    it('reports 100% and done once everything is indexed', () => {
      writeSetting('index_rebuild', JSON.stringify({ status: 'interrupted', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', totalQueued: 10 }))
      db.prepare("UPDATE sources SET index_state = 'ready', index_error = NULL").run()
      const p = getRebuildProgress()
      expect(p.remaining).toBe(0)
      expect(p.processed).toBe(10)
      expect(p.percent).toBe(100)
      // 无记录时按"已完成"处理，界面不会留一个假的"继续重建"
      db.prepare("DELETE FROM settings WHERE key = 'index_rebuild'").run()
      expect(getRebuildProgress()).toMatchObject({ status: 'done', percent: 100, totalQueued: 0 })
    })
  })
}
