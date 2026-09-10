/**
 * keep-awake.ts —— 长任务期间保持电脑唤醒且不自动熄屏（封装 electron powerSaveBlocker）。
 * 供主进程长任务 handler 调用；无 electron（单测）时由 keep-awake-core 降级为 no-op。
 * 覆盖范围：资料汇编生成（AI 细读 + 卡片矛盾检索与汇总）、中断续跑、二次修改（语义补全扫描）、
 * 初稿生成/重新生成、资料摘要整理——即“进度条全过程”。
 */
import { powerSaveBlocker } from 'electron'
import { createKeepAwakeController, type PowerSaveBlockerLike } from './keep-awake-core'

const electronImpl: PowerSaveBlockerLike = {
  start: (type) => powerSaveBlocker.start(type),
  stop: (id) => powerSaveBlocker.stop(id),
  isStarted: (id) => powerSaveBlocker.isStarted(id)
}

const controller = createKeepAwakeController(electronImpl)

/** 长任务开始：保持电脑唤醒且不熄屏（引用计数；使用 prevent-display-sleep，覆盖细读/矛盾扫描/二次修改全过程） */
export function startKeepAwake(): void {
  controller.start()
}

/** 长任务结束：释放保持唤醒（减到 0 才真正停止） */
export function stopKeepAwake(): void {
  controller.stop()
}

/** 当前是否仍保持唤醒 */
export function isKeepAwakeActive(): boolean {
  return controller.active()
}
