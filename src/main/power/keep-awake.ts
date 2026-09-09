/**
 * keep-awake.ts —— 长任务期间保持电脑唤醒（封装 electron powerSaveBlocker）。
 * 供主进程长任务 handler 调用；无 electron（单测）时由 keep-awake-core 降级为 no-op。
 */
import { powerSaveBlocker } from 'electron'
import { createKeepAwakeController, type PowerSaveBlockerLike } from './keep-awake-core'

const electronImpl: PowerSaveBlockerLike = {
  start: (type) => powerSaveBlocker.start(type),
  stop: (id) => powerSaveBlocker.stop(id),
  isStarted: (id) => powerSaveBlocker.isStarted(id)
}

const controller = createKeepAwakeController(electronImpl)

/** 长任务开始：保持电脑/应用唤醒（引用计数；默认 prevent-app-suspension，屏幕可关但防睡眠） */
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
