import { useLayoutEffect, useRef, useState } from 'react'

/**
 * 引导目标定位 hook（2026-08-14，借鉴聚合拾遗 useTargetRect）：
 * 通过 CSS 选择器定位界面元素，返回其高亮区域（含 padding 留白），并监听 DOM 变化 / 窗口缩放 / 滚动实时更新。
 * 目标元素缺失时延迟回调 onMissing，供引导自动跳到下一步。
 */
export interface TargetRect {
  top: number
  right: number
  bottom: number
  left: number
  width: number
  height: number
}

function readRect(element: Element, padding: number): TargetRect {
  const rect = element.getBoundingClientRect()
  const left = Math.max(4, rect.left - padding)
  const top = Math.max(4, rect.top - padding)
  const right = Math.min(window.innerWidth - 4, rect.right + padding)
  const bottom = Math.min(window.innerHeight - 4, rect.bottom + padding)
  return {
    top,
    right,
    bottom,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  }
}

function rectsMatch(a: TargetRect | null, b: TargetRect | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    Math.abs(a.top - b.top) < 0.25 &&
    Math.abs(a.right - b.right) < 0.25 &&
    Math.abs(a.bottom - b.bottom) < 0.25 &&
    Math.abs(a.left - b.left) < 0.25 &&
    Math.abs(a.width - b.width) < 0.25 &&
    Math.abs(a.height - b.height) < 0.25
  )
}

export function useTargetRect(
  selector: string | null,
  padding: number,
  onMissing: () => void
): TargetRect | null {
  const [rect, setRect] = useState<TargetRect | null>(null)
  const rectRef = useRef<TargetRect | null>(null)
  const onMissingRef = useRef(onMissing)
  onMissingRef.current = onMissing

  useLayoutEffect(() => {
    if (!selector) {
      rectRef.current = null
      setRect(null)
      return
    }

    let frame = 0
    let missingTimer: ReturnType<typeof setTimeout> | null = null
    let observedElement: Element | null = null
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule())

    const commit = (next: TargetRect | null): void => {
      if (rectsMatch(rectRef.current, next)) return
      rectRef.current = next
      setRect(next)
    }

    const update = (): void => {
      frame = 0
      const element = document.querySelector(selector)
      if (element !== observedElement) {
        resizeObserver?.disconnect()
        observedElement = element
        if (element) resizeObserver?.observe(element)
      }
      if (!element) {
        commit(null)
        if (missingTimer === null) {
          missingTimer = setTimeout(() => {
            missingTimer = null
            if (!document.querySelector(selector)) onMissingRef.current()
          }, 1500)
        }
        return
      }
      if (missingTimer !== null) {
        clearTimeout(missingTimer)
        missingTimer = null
      }
      commit(readRect(element, padding))
    }

    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update)
    }

    const mutationObserver = new MutationObserver((records) => {
      const appChanged = records.some((record) => {
        const target = record.target
        const element = target instanceof Element ? target : target.parentElement
        return !element?.closest('.onboarding-overlay')
      })
      if (appChanged) schedule()
    })
    mutationObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
      childList: true,
      subtree: true
    })

    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    update()

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      if (missingTimer !== null) clearTimeout(missingTimer)
      mutationObserver.disconnect()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [padding, selector])

  return rect
}
