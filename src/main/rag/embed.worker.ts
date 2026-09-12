/**
 * embed.worker.ts —— 向量嵌入 Worker 线程（避免大文件向量化阻塞主进程事件循环）。
 * 背景：onnxruntime-web WASM 推理是同步 CPU 密集计算，若在主进程执行，大文件（数百上千 chunk）
 * 会长时间占满事件循环，导致窗口切回/聚焦/重绘卡顿。此 Worker 把推理移出主线程。
 *
 * 推理逻辑与 embed.ts 保持一致（同一套 ORT WASM 配置与 mean-pooling + L2 归一化）。
 * worker_threads 消息协议：
 *   in:  { type: 'init', modelId, modelPath }        （首次调用前由主进程发送）
 *   in:  { type: 'embed', id, texts }
 *   out: { type: 'result', id, vectors } | { type: 'error', id, message }
 * 消息在 Worker 线程内串行处理（单线程事件循环），主进程侧负责超时与故障回退。
 */
import { parentPort } from 'node:worker_threads'
import { cpus } from 'node:os'
import { embedPoolSize, embedThreadsPerWorker } from './embed-config'
import type { FeatureExtractionPipeline } from '@huggingface/transformers'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const nodeRequire = createRequire(__filename)

let modelId = 'bge-small-zh-v1.5'
let modelPath = 'resources/models'
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

/** 定位 onnxruntime-web 的 WASM 后端本地文件（与 embed.ts 相同的加载策略） */
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

/** 配置 ONNX Runtime WASM 后端（须直接改 ort.env.wasm，见 embed.ts 文件头注释） */
function configureOrtWasm(threads: number): void {
  const ort = nodeRequire('onnxruntime-web') as {
    env: { wasm: { numThreads: number; wasmPaths?: unknown } }
  }
  const paths = resolveOrtWasmPaths()
  ort.env.wasm.numThreads = threads
  ort.env.wasm.wasmPaths = { wasm: paths.wasm, mjs: paths.mjs }
  lastThreads = threads
}

let lastThreads = 1

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
      env.allowLocalModels = true
      env.allowRemoteModels = false
      env.localModelPath = modelPath
      env.useWasmCache = false
      const cores = cpus()?.length ?? 2
      const wanted = embedThreadsPerWorker(cores, embedPoolSize(cores))
      try {
        configureOrtWasm(wanted)
        return await pipeline('feature-extraction', modelId, { local_files_only: true })
      } catch (err) {
        /*
         * 多线程不可用（少数机器上 SharedArrayBuffer/线程被禁用）时**回落单线程重试一次**：
         * 否则每一篇资料都会失败，用户只能看到一个"重建失败"而无从下手。
         */
        if (wanted > 1) {
          configureOrtWasm(1)
          const pipe = await pipeline('feature-extraction', modelId, { local_files_only: true })
          return pipe
        }
        throw err
      }
    })().catch((err) => {
      extractorPromise = null
      throw new Error(`本地嵌入不可用（模型目录 ${modelPath}/${modelId}/ 或嵌入引擎 onnxruntime 后端）。原始错误：${String(err)}`)
    })
  }
  return extractorPromise
}

/** 供主进程日志/诊断：Worker 实际使用的 WASM 线程数 */
export function workerThreads(): number {
  return lastThreads
}

/** 文本 → 向量列表（mean pooling + L2 归一化；推理逻辑与 embed.ts 的 embedTexts 一致） */
async function computeEmbeddings(texts: string[]): Promise<number[][]> {
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

const port = parentPort
if (port) {
  port.on('message', (msg: { type?: string; modelId?: string; modelPath?: string; id?: number; texts?: string[] }) => {
    void (async () => {
      try {
        if (msg.type === 'init') {
          if (msg.modelId) modelId = msg.modelId
          if (msg.modelPath) modelPath = msg.modelPath
          return
        }
        if (msg.type === 'embed' && typeof msg.id === 'number' && Array.isArray(msg.texts)) {
          const vectors = await computeEmbeddings(msg.texts)
          port.postMessage({ type: 'result', id: msg.id, vectors, threads: lastThreads })
          return
        }
        port.postMessage({ type: 'error', id: msg.id ?? 0, message: '未知的 Worker 消息' })
      } catch (err) {
        port.postMessage({ type: 'error', id: msg.id ?? 0, message: String(err) })
      }
    })()
  })
}
