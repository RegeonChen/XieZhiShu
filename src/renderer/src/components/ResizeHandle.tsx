import { useCallback, useRef } from 'react'

interface ResizeHandleProps {
  onResize: (delta: number) => void
  direction?: 'horizontal' | 'vertical'
}

export default function ResizeHandle({ onResize, direction = 'horizontal' }: ResizeHandleProps) {
  const startRef = useRef(0)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
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
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [onResize, direction]
  )

  return (
    <div
      className={`resize-handle resize-handle--${direction}`}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation={direction}
      tabIndex={-1}
    />
  )
}
