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
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
      throw new Error(`本地嵌入模型加载失败（请确认 ${modelPath}/${modelId}/ 目录包含模型文件）：${String(err)}`)
    })
  }
  return extractorPromise
}

/** 文本 → 向量列表（mean pooling + L2 归一化） */
export async function embedTexts(texts: string[]): Promise<number[][]> {
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
