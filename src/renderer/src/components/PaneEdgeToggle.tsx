import { useCallback, useRef } from 'react'
import { zhCN } from '../i18n/zh-CN'

interface PaneEdgeToggleProps {
  /** 中栏是否显示；true=按钮为左向小三角（点击隐藏），false=按钮为右向小三角（点击显示） */
  visible: boolean
  /** 切换中栏显示/隐藏 */
  onToggle: () => void
  /** 拖动边界调整中栏宽度（仅中栏可见时生效） */
  onResize: (delta: number) => void
}

/**
 * 中栏/右栏边界「切换手柄」（Phase 6.x UI 调整）：
 * 光标放到边界时边界线高亮，并出现一个圆角长方形按钮（内为小三角）。
 * 中栏可见 → 左向小三角，点击隐藏中栏；中栏隐藏 → 右向小三角，点击恢复中栏。
 * 同时保留拖动边界调整中栏宽度的能力（中栏可见时）。
 */
export default function PaneEdgeToggle({ visible, onToggle, onResize }: PaneEdgeToggleProps) {
  const startRef = useRef(0)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!visible) return
      e.preventDefault()
      startRef.current = e.clientX
      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startRef.current
        if (delta === 0) return
        startRef.current = ev.clientX
        onResize(delta)
      }
      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [visible, onResize]
  )

  return (
    <div
      className={`pane-edge pane-edge--toggle${visible ? '' : ' pane-edge--collapsed'}`}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      tabIndex={-1}
    >
      <button
        type="button"
        className="pane-edge__btn"
        onClick={(e) => {
          // 仅在按钮本身按下时触发，避免与拖动冲突
          e.stopPropagation()
          onToggle()
        }}
        title={visible ? zhCN.paneEdge.hideCenter : zhCN.paneEdge.showCenter}
        aria-label={visible ? zhCN.paneEdge.hideCenter : zhCN.paneEdge.showCenter}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          {visible ? <polygon points="14,6 14,18 8,12" /> : <polygon points="10,6 10,18 16,12" />}
        </svg>
      </button>
    </div>
  )
}