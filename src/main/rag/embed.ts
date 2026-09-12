/**
 * embed.ts —— 本地向量嵌入（Phase 3.2 Task 3.2.1）。
 * 基于 @huggingface/transformers 加载本地 ONNX 模型（默认 BGE-small-zh-v1.5，中文语义检索）。
 * 严格本地：allowRemoteModels=false，模型文件缺失时抛出明确错误，不联网下载。
 *
 * 推理后端说明：本机 Windows System32 存在系统组件 onnxruntime.dll（Microsoft ONNX Runtime 1.17.1），
 * 其加载优先级高于应用目录，导致 onnxruntime-node 原生绑定任何版本都无法完成 DLL 初始化。
 * 因此通过 `vendor/onnxruntime-node-stub`（package.json 中 onnxruntime-node 指向该 file: 依赖）
 * 把 onnxruntime-node 转发为 onnxruntime-web 的 WASM 后端。详见 AGENTS.md。
 *
 * WASM 加载要点（在 Node/Electron 主进程下）：
 * 1. transformers.js 模块初始化时会把 ORT 原生 env 的 wasmPaths 默认设为 CDN URL，
 *    而 `env.backends.onnx` 只是其浅拷贝——必须直接改 onnxruntime-web 的 env.wasm。
 * 2. `env.useWasmCache=false` 跳过 transformers.js 预加载（该路径会把 mjs 转成 blob: URL，
 *    Node 的 import() 不支持 blob: scheme）。
 * 3. factory（mjs）须用 file: URL（Node import() 支持），wasm 二进制用纯文件系统路径
 *    （Emscripten fs.readFile 支持）。
 */
import type { FeatureExtractionPipeline } from '@huggingface/transformers'
import { createRequire } from 'node:module'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { embedPoolSize, embedThreadsPerWorker } from './embed-config'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'

export const DEFAULT_EMBED_MODEL_ID = 'bge-small-zh-v1.5'
const DEFAULT_MODEL_PATH = 'resources/models'

let modelId = DEFAULT_EMBED_MODEL_ID
let modelPath = DEFAULT_MODEL_PATH
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null
let ready = false

const nodeRequire = createRequire(__filename)

/** 配置模型（主进程启动时调用；模型目录为 <modelPath>/<modelId>/） */
export function configureEmbedModel(opts: { modelId?: string; modelPath: string }): void {
  if (opts.modelId) modelId = opts.modelId
  modelPath = opts.modelPath
}

export function getEmbedModelId(): string {
  return modelId
}

export function isEmbedReady(): boolean {
  return ready
}

/** 定位 onnxruntime-web 的 WASM 后端本地文件（mjs 用 file: URL，wasm 用文件路径） */
function resolveOrtWasmPaths(): { wasm: string; mjs: string } {
  let entry: string
  try {
    entry = nodeRequire.resolve('onnxruntime-web')
  } catch (err) {
    throw new Error(`本地嵌入引擎依赖缺失（onnxruntime-web 不可用）：${String(err)}`)
  }
  const dist = dirname(entry)
  return {
    wasm: join(dist, 'ort-wasm-simd-threaded.wasm'),
    mjs: pathToFileURL(join(dist, 'ort-wasm-simd-threaded.mjs')).href,
  }
}

/** 配置 ONNX Runtime WASM 后端（须直接改 ort.env.wasm，见文件头注释） */
function configureOrtWasm(): void {
  const ort = nodeRequire('onnxruntime-web') as {
    env: { wasm: { numThreads: number; wasmPaths?: unknown } }
  }
  const paths = resolveOrtWasmPaths()
  ort.env.wasm.numThreads = 1
  ort.env.wasm.wasmPaths = { wasm: paths.wasm, mjs: paths.mjs }
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      let mod: typeof import('@huggingface/transformers')
      try {
        mod = await import('@huggingface/transformers')
      } catch (err) {
        throw new Error(`本地嵌入引擎初始化失败（onnxruntime 后端不可用）：${String(err)}`)
      }
      const { env, pipeline } = mod
      configureOrtWasm()
      env.allowLocalModels = true
      env.allowRemoteModels = false
      env.localModelPath = modelPath
      env.useWasmCache = false
      const pipe = await pipeline('feature-extraction', modelId, { local_files_only: true })
      ready = true
      return pipe
    })().catch((err) => {
      extractorPromise = null
      /*
       * 报错要能区分两类原因（2026-09-12 实测踩过）：**模型文件缺失** 与 **引擎/依赖不可用**。
       * 原提示只让用户检查模型目录，而真实故障是 `onnxruntime-node` 这个 file: 依赖没被正确安装
       * （node_modules 里是空目录 → transformers 的 node 构建 import 失败），照提示查模型永远查不出来。
       */
      throw new Error(
        `本地嵌入不可用（模型目录 ${modelPath}/${modelId}/ 或嵌入引擎 onnxruntime 后端）。原始错误：${String(err)}`
      )
    })
  }
  return extractorPromise
}

/**
 * 批内最大条数与总字符数：**同批长度越接近，padding 浪费越小**。
 * 2026-09-12 实测（72 条真实分块，长度 12~499 字，单 Worker）：
 *   原样顺序批 5 → 162ms/条；原样顺序批 24 → 481ms/条；**按长度排序批 16 → 23ms/条**。
 * 原因是 transformers.js 会把一批补齐到该批最长序列，混排时短句白算几十倍。
 */
const EMBED_SUB_BATCH_MAX = 16
const EMBED_SUB_BATCH_CHARS = 4000

/**
 * 把待嵌入文本按长度排序后切成小批（返回每批的**原始下标**）。
 * 排序只为分组，返回顺序由调用方按原始下标还原，因此对结果无影响。
 */
export function planEmbedBatches(texts: string[]): number[][] {
  const order = texts.map((t, i) => ({ i, len: t.length })).sort((a, b) => a.len - b.len)
  const batches: number[][] = []
  let cur: number[] = []
  let chars = 0
  for (const o of order) {
    if (cur.length > 0 && (cur.length >= EMBED_SUB_BATCH_MAX || chars + o.len > EMBED_SUB_BATCH_CHARS)) {
      batches.push(cur)
      cur = []
      chars = 0
    }
    cur.push(o.i)
    chars += o.len
  }
  if (cur.length > 0) batches.push(cur)
  return batches
}

/**
 * 文本 → 向量列表（mean pooling + L2 归一化）。
 * 内部按长度分小批投喂（见 `planEmbedBatches`），批间让出事件循环，返回顺序与入参一致。
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const out: number[][] = new Array(texts.length)
  const batches = planEmbedBatches(texts)
  for (const batch of batches) {
    const vectors = await embedBatch(batch.map((i) => texts[i]))
    batch.forEach((originalIndex, k) => {
      out[originalIndex] = vectors[k]
    })
    await new Promise<void>((r) => setImmediate(() => r()))
  }
  return out
}

/** 单批嵌入（走 Worker 池；池不可用时回退主进程直接推理） */
async function embedBatch(texts: string[]): Promise<number[][]> {
  const w = await acquireWorker()
  if (w) {
    try {
      engineStats.workerCalls += 1
      return await requestEmbedWorker(w, texts)
    } catch (err) {
      /*
       * Worker 超时/报错：降级为直接推理（directEmbed 内部同样会抛出明确的模型错误）。
       * **必须把原因记下来**——2026-09-12 实测踩过：Worker 每次都失败并静默回退，
       * 表面上"能索引"，实际所有计算都挤在单线程直接推理里，速度差 10 倍且完全看不出问题。
       */
      engineStats.workerErrors += 1
      engineStats.lastWorkerError = err instanceof Error ? err.message : String(err)
    } finally {
      releaseWorker(w)
    }
  }
  engineStats.directFallbacks += 1
  return directEmbed(texts)
}

/** 引擎自检信息（设置页/诊断日志用：是否真的在跑 Worker 池、是否一直在回退） */
const engineStats = { workerCalls: 0, workerErrors: 0, directFallbacks: 0, lastWorkerError: null as string | null, workerThreads: 0 }

export function getEmbedEngineStats(): {
  poolSize: number
  livePool: number
  workerFile: string | null
  workerCalls: number
  workerErrors: number
  directFallbacks: number
  lastWorkerError: string | null
  /** Worker 上报的 WASM 线程数（>1 说明多线程生效；1 说明回落单线程） */
  workerThreads: number
  modelId: string
  modelPath: string
} {
  return {
    poolSize: EMBED_WORKER_POOL_SIZE,
    livePool: pool.length,
    workerFile: embedWorkerFile(),
    workerCalls: engineStats.workerCalls,
    workerErrors: engineStats.workerErrors,
    directFallbacks: engineStats.directFallbacks,
    lastWorkerError: engineStats.lastWorkerError,
    workerThreads: engineStats.workerThreads,
    modelId,
    modelPath
  }
}

/** 主进程内直接推理（原 embedTexts 实现；Worker 不可用时的回退路径，测试亦走此路径） */
async function directEmbed(texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor()
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  const data = output.data as Float32Array
  const dim = output.dims[1]
  const out: number[][] = []
  for (let i = 0; i < texts.length; i++) {
    out.push(Array.from(data.subarray(i * dim, (i + 1) * dim)))
  }
  return out
}

// ================= Worker 线程推理客户端（多 Worker 池） =================
// 目标：把 WASM 推理移出主线程，并**让每个 Worker 用满多核**——2026-09-12 实测（真实网页资料分块）：
// 单线程 130ms/分块，WASM 8 线程 24ms/分块，再叠加 3 个 Worker 并行处理不同资料 → 17ms/分块。
// 只加 Worker 不加线程是无效的（瓶颈是单线程推理本身）；只加线程也会因 padding 而浪费（见 planEmbedBatches）。
// Worker 文件由 electron-vite 单独打包为 out/main/embed.worker.js（见 electron.vite.config.ts
// main.rollupOptions.input）。文件缺失（如 vitest 环境）时回退直接推理。

/**
 * Worker 池大小：留一个核给主进程与界面，上限 3（每个 Worker 各加载一份 94MB 模型，
 * 池太大只是徒增内存；3 个已能把重建速度提升到实用区间）。
 */
export const EMBED_WORKER_POOL_SIZE = embedPoolSize(cpus()?.length ?? 2)

interface PoolSlot {
  worker: Worker
  busy: boolean
}

let pool: PoolSlot[] = []
let embedWorkerBroken = false
let embedWorkerSeq = 0
const embedWorkerPending = new Map<
  number,
  { resolve: (v: number[][]) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }
>()
/** 池满时排队的等待者（FIFO，保证公平） */
const poolWaiters: ((slot: PoolSlot | null) => void)[] = []

/** 定位打包产物 embed.worker.js（与主 bundle 同目录）；不存在则视为不可用 */
function embedWorkerFile(): string | null {
  const p = join(__dirname, 'embed.worker.js')
  return existsSync(p) ? p : null
}

function rejectAllPending(err: unknown): void {
  for (const [, p] of embedWorkerPending) {
    clearTimeout(p.timer)
    p.reject(err)
  }
  embedWorkerPending.clear()
}

function onWorkerMessage(msg: { type?: string; id?: number; vectors?: number[][]; message?: string; threads?: number }): void {
  if (typeof msg.threads === 'number') engineStats.workerThreads = msg.threads
  if (msg.type === 'result' && typeof msg.id === 'number') {
    const p = embedWorkerPending.get(msg.id)
    if (p) {
      clearTimeout(p.timer)
      embedWorkerPending.delete(msg.id)
      p.resolve(msg.vectors ?? [])
    }
    return
  }
  if (msg.type === 'error' && typeof msg.id === 'number') {
    const p = embedWorkerPending.get(msg.id)
    if (p) {
      clearTimeout(p.timer)
      embedWorkerPending.delete(msg.id)
      p.reject(new Error(msg.message ?? '嵌入 Worker 错误'))
    }
  }
}

/** 单个 Worker 崩溃：从池中移除它，并把等待者转给其它槽位（池空则全部回退直接推理） */
function dropSlot(slot: PoolSlot, err: unknown): void {
  slot.busy = false
  pool = pool.filter((s) => s !== slot)
  try {
    void slot.worker.terminate()
  } catch {
    /* 忽略 */
  }
  rejectAllPending(err instanceof Error ? err : new Error(String(err)))
  if (pool.length === 0) embedWorkerBroken = true
  const waiters = poolWaiters.splice(0, poolWaiters.length)
  for (const w of waiters) void dispatchToPool(w)
}

function createSlot(file: string): PoolSlot {
  const worker = new Worker(file)
  const slot: PoolSlot = { worker, busy: false }
  worker.on('message', onWorkerMessage)
  worker.on('error', (err) => dropSlot(slot, err))
  worker.on('exit', (code) => {
    if (code !== 0) dropSlot(slot, new Error(`嵌入 Worker 退出（code=${code}）`))
  })
  worker.postMessage({ type: 'init', modelId, modelPath })
  return slot
}

function dispatchToPool(resolve: (slot: PoolSlot | null) => void): void {
  const idle = pool.find((s) => !s.busy)
  if (idle) {
    idle.busy = true
    resolve(idle)
    return
  }
  if (embedWorkerBroken) {
    resolve(null)
    return
  }
  if (pool.length < EMBED_WORKER_POOL_SIZE) {
    const file = embedWorkerFile()
    if (!file) {
      embedWorkerBroken = true
      resolve(null)
      return
    }
    try {
      const slot = createSlot(file)
      slot.busy = true
      pool.push(slot)
      resolve(slot)
      return
    } catch {
      embedWorkerBroken = true
      resolve(null)
      return
    }
  }
  poolWaiters.push(resolve)
}

/** 取一个空闲 Worker（池满则排队等待）；全部不可用时返回 null（调用方回退直接推理） */
function acquireWorker(): Promise<PoolSlot | null> {
  return new Promise((resolve) => dispatchToPool(resolve))
}

function releaseWorker(slot: PoolSlot): void {
  if (!pool.includes(slot)) return
  slot.busy = false
  const next = poolWaiters.shift()
  if (next) void dispatchToPool(next)
}

/** 单次嵌入请求：发送给 Worker，带超时（Worker 卡死时降级，避免索引挂起） */
function requestEmbedWorker(slot: PoolSlot, texts: string[]): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const id = ++embedWorkerSeq
    const timer = setTimeout(() => {
      embedWorkerPending.delete(id)
      reject(new Error('嵌入 Worker 响应超时'))
    }, 120000)
    embedWorkerPending.set(id, { resolve, reject, timer })
    slot.worker.postMessage({ type: 'embed', id, texts })
  })
}

/** 关闭全部 Worker（应用退出时调用；未启动则空操作） */
export function stopEmbedWorker(): void {
  for (const slot of pool) {
    try {
      void slot.worker.terminate()
    } catch {
      /* 忽略 */
    }
  }
  pool = []
  embedWorkerBroken = false
  embedWorkerPending.clear()
  const waiters = poolWaiters.splice(0, poolWaiters.length)
  for (const w of waiters) w(null)
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('embed batching (2026-09-12 重建提速)', () => {
    it('groups similar lengths together to avoid padding waste', () => {
      /*
       * 关键指标不是"顺序"而是**补零成本**：transformers.js 会把一批补齐到该批最长序列，
       * 成本 ≈ Σ(批内最长 × 批内条数)。乱序时 1 字和 400 字同批 → 白算几十倍（实测 162 → 481ms/条）。
       */
      const lengths = [1, 5, 12, 30, 60, 120, 200, 400, 8, 45, 90, 150, 260, 320, 3, 20, 75, 180, 240, 380, 2, 9, 40, 100, 160, 220, 300, 350, 6, 25, 55, 130, 190, 250, 330, 395, 4, 15, 35, 80, 140, 210, 280, 360, 7, 18, 50, 110]
      const texts = lengths.map((n) => 'x'.repeat(n))
      const cost = (batches: number[][]): number =>
        batches.reduce((sum, b) => sum + Math.max(...b.map((i) => texts[i].length)) * b.length, 0)
      const naive: number[][] = []
      for (let i = 0; i < texts.length; i += 16) naive.push(Array.from({ length: Math.min(16, texts.length - i) }, (_, k) => i + k))

      const planned = planEmbedBatches(texts)
      expect(planned.flat().sort((x, y) => x - y)).toEqual(texts.map((_, i) => i)) // 不丢不重
      // 乱序基准 18800 单位、按长度分组 9560 单位（约 −49%）→ 断言至少省 40%
      expect(cost(planned)).toBeLessThan(cost(naive) * 0.6)
      for (const b of planned) {
        const lens = b.map((i) => texts[i].length)
        expect(Math.max(...lens) - Math.min(...lens)).toBeLessThanOrEqual(320) // 同批跨度受控
      }
    })

    it('respects the per-batch count and char budgets', () => {
      const many = Array.from({ length: 40 }, () => 'x'.repeat(5))
      const batches = planEmbedBatches(many)
      expect(batches.every((b) => b.length <= 16)).toBe(true)
      expect(batches.flat()).toHaveLength(40)
      const longOnes = Array.from({ length: 4 }, () => 'y'.repeat(3000))
      for (const b of planEmbedBatches(longOnes)) {
        const chars = b.reduce((n, i) => n + longOnes[i].length, 0)
        expect(chars <= 4000 || b.length === 1).toBe(true)
      }
    })

    it('returns one batch for a single text and nothing for none', () => {
      expect(planEmbedBatches(['只有一条'])).toEqual([[0]])
      expect(planEmbedBatches([])).toEqual([])
    })
  })

  describe('embed engine config (2026-09-12 提速参数)', () => {
    it('splits the core budget between pool workers and caps threads at 8', () => {
      expect(embedThreadsPerWorker(32, 3)).toBe(8) // 32 核：min(8, floor(31/3)=10) → 8
      expect(embedThreadsPerWorker(16, 3)).toBe(5) // 16 核：floor(15/3)=5
      expect(embedThreadsPerWorker(4, 3)).toBe(1) // 4 核：floor(3/3)=1（不超订）
      expect(embedThreadsPerWorker(2, 1)).toBe(1)
      expect(embedPoolSize(32)).toBe(3)
      expect(embedPoolSize(2)).toBe(1)
      expect(embedPoolSize(1)).toBe(1)
    })
  })
}
