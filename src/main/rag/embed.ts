/**
 * embed.ts —— 本地向量嵌入（Phase 3.2 Task 3.2.1）。
 * 基于 @huggingface/transformers 加载本地 ONNX 模型（默认 BGE-small-zh-v1.5，中文语义检索）。
 * 严格本地：allowRemoteModels=false，模型文件缺失时抛出明确错误，不联网下载。
 * 注意：transformers 依赖的 onnxruntime-node 为原生绑定，与过新的 Node 版本不兼容，
 * 因此采用动态 import —— 仅在真正推理时加载；加载失败时抛出明确错误，不阻塞其它功能。
 */
import type { FeatureExtractionPipeline } from '@huggingface/transformers'

export const DEFAULT_EMBED_MODEL_ID = 'bge-small-zh-v1.5'
const DEFAULT_MODEL_PATH = 'resources/models'

let modelId = DEFAULT_EMBED_MODEL_ID
let modelPath = DEFAULT_MODEL_PATH
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null
let ready = false

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

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      let mod: typeof import('@huggingface/transformers')
      try {
        mod = await import('@huggingface/transformers')
      } catch (err) {
        // 原生绑定加载失败（如 onnxruntime-node 与当前 Node 版本不兼容）
        throw new Error(`本地嵌入引擎初始化失败（onnxruntime 原生绑定不可用）：${String(err)}`)
      }
      const { env, pipeline } = mod
      env.allowLocalModels = true
      env.allowRemoteModels = false
      env.localModelPath = modelPath
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
