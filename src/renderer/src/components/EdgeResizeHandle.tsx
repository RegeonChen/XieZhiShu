import { useCallback } from 'react'

interface EdgeResizeHandleProps {
  /**
   * 把手贴在哪条"边界"上（2026-10-04 用户要求："鼠标放到边界上，直接拖动边界来改变大小"）：
   * - `left`：竖直边界（拖左右改宽）
   * - `top`：水平边界（拖上下改高）
   * 语义统一为**边界跟着鼠标走**：往左拖左边 → 变宽；往上拖上边 → 变高。
   */
  edge: 'left' | 'top'
  /** 按下时回调：调用方在这里把"当前真实尺寸"读进状态（CSS 默认尺寸 → 显式尺寸的第一次切换） */
  onStart?: () => void
  /** 拖动增量：**正数 = 该边界向外移动**（left 边向左 / top 边向上 = 变大） */
  onDelta: (outward: number) => void
  /** 悬停提示 */
  title?: string
  /** 额外类名（如把把手往里收一点，避开圆角） */
  className?: string
}

/**
 * 边界缩放手柄：贴在容器的左/上边界上，拖动时把"边界向外移动的距离"交给调用方。
 *
 * 为什么不用 `<textarea>` 自带的右下角小三角：那个小三角改变的是 `height`，
 * 而本项目的输入框**底部被面板底部钉住**（flex 布局），于是"往下拖"时可见的**上边界往上跑**，
 * 方向与手相反（用户实测反馈"我向外拉，框变小"）。改成"拖上边界、上边界跟着鼠标走"就没有这个问题。
 */
export default function EdgeResizeHandle({ edge, onStart, onDelta, title, className }: EdgeResizeHandleProps) {
  const axis = edge === 'left' ? 'clientX' : 'clientY'

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation() // 别触发父级的"拖动面板"
      let last = e[axis]
      onStart?.()
      /**
       * 拖拽期间把监听挂在 **document** 上，而不是依赖 `setPointerCapture`：
       * 把手只有 7–8px 宽，指针一移开就收不到事件了（实测合成事件下 setPointerCapture 也不可靠，
       * 只收到第一次 move）。这与项目里既有的 `ResizeHandle` 是同一套做法。
       */
      const onMove = (ev: PointerEvent): void => {
        const now = axis === 'clientX' ? ev.clientX : ev.clientY
        // 鼠标向左/向上移动 → 边界"向外"移动（变大）
        const outward = last - now
        if (outward === 0) return
        last = now
        onDelta(outward)
      }
      const finish = (): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', finish)
        document.removeEventListener('pointercancel', finish)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', finish)
      document.addEventListener('pointercancel', finish)
      document.body.style.cursor = edge === 'left' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [axis, edge, onStart, onDelta]
  )

  return (
    <div
      className={`edge-resize edge-resize--${edge}${className ? ' ' + className : ''}`}
      role="separator"
      aria-orientation={edge === 'left' ? 'vertical' : 'horizontal'}
      tabIndex={-1}
      title={title}
      onPointerDown={onPointerDown}
    />
  )
}
