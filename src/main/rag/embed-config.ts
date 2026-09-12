/**
 * embed-config.ts —— 嵌入引擎的并发参数（主进程与 Worker 共用，避免两处公式漂移）。
 *
 * 2026-09-12 实测（本机 32 核，真实网页资料分块）：
 * - 单 Worker + WASM 单线程：130ms/分块；
 * - WASM 线程数 2/4/8：86.7 / 44.7 / **24.3** ms/分块（近线性）；
 * - 跨源并发（Worker 池）在单线程下没有收益（瓶颈是单线程推理本身），多线程后才有意义。
 * 因此策略是：**每个 Worker 用多线程（最多 8），再用少量 Worker 并行处理不同资料**，
 * 并让总线程数不超过 CPU 核数（留一个核给界面/主进程）。
 */

/** 覆盖线程数的环境变量（便于对比测试与极端机器救急） */
export const EMBED_THREADS_ENV = 'XZS_ORT_THREADS'

/** Worker 池大小：留一个核，最多 3 个（每个 Worker 各持一份 94MB 模型，过多只增内存） */
export function embedPoolSize(cores: number): number {
  return Math.min(3, Math.max(1, cores - 1))
}

/**
 * 每个 Worker 的 WASM 线程数：把"可用核数（核数 − 1）"平均分给池内各 Worker，上限 8。
 * 例：32 核 3 Worker → min(8, floor(31/3)=10) = 8（共 24 线程）；4 核 3 Worker → 1（共 3 线程）。
 */
export function embedThreadsPerWorker(cores: number, poolSize: number): number {
  const override = Number(process.env[EMBED_THREADS_ENV] ?? '')
  if (Number.isFinite(override) && override > 0) return Math.floor(override)
  const budget = Math.max(1, cores - 1)
  return Math.max(1, Math.min(8, Math.floor(budget / Math.max(1, poolSize))))
}
