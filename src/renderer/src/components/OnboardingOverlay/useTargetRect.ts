import { useLayoutEffect, useRef, useState } from 'react'

/**
 * 引导目标定位 hook（2026-08-14，借鉴聚合拾遗 useTargetRect）：
 * 通过一组 CSS 选择器定位界面元素，返回每个目标的矩形（用于挖洞高亮）与联合矩形（用于定位提示卡片）。
 * 支持一个步骤同时高亮多个模块（如第 1 步同时框选「LLM Provider」与「步骤默认模型」）。
 * 监听 DOM 变化 / 窗口缩放 / 滚动实时更新；全部目标缺失时延迟回调 onMissing，供引导自动跳到下一步。
 */
export interface TargetRect {
  top: number
  right: number
  bottom: number
  left: number
  width: number
  height: number
}

export interface TargetRects {
  /** 各目标的高亮矩形（已含 padding 留白、对视口钳制） */
  rects: TargetRect[]
  /** 所有目标的联合外接矩形（用于放置提示卡片） */
  union: TargetRect | null
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

function targetRectsEqual(a: TargetRects, b: TargetRects): boolean {
  if (a.rects.length !== b.rects.length) return false
  for (let i = 0; i < a.rects.length; i++) if (!rectsMatch(a.rects[i], b.rects[i])) return false
  return rectsMatch(a.union, b.union)
}

export function useTargetRect(
  selectors: string[] | null,
  padding: number,
  onMissing: () => void
): TargetRects {
  const [state, setState] = useState<TargetRects>({ rects: [], union: null })
  const stateRef = useRef<TargetRects>({ rects: [], union: null })
  const onMissingRef = useRef(onMissing)
  onMissingRef.current = onMissing

  useLayoutEffect(() => {
    if (!selectors || selectors.length === 0) {
      stateRef.current = { rects: [], union: null }
      setState({ rects: [], union: null })
      return
    }

    let frame = 0
    let missingTimer: ReturnType<typeof setTimeout> | null = null
    const observedElements = new Map<string, Element | null>()
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule())

    const compute = (): TargetRects => {
      const rects: TargetRect[] = []
      for (const sel of selectors) {
        const el = observedElements.get(sel)
        if (el) rects.push(readRect(el, padding))
      }
      let union: TargetRect | null = null
      if (rects.length > 0) {
        let top = Infinity
        let left = Infinity
        let right = -Infinity
        let bottom = -Infinity
        for (const r of rects) {
          top = Math.min(top, r.top)
          left = Math.min(left, r.left)
          right = Math.max(right, r.right)
          bottom = Math.max(bottom, r.bottom)
        }
        union = { top, right, bottom, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
      }
      return { rects, union }
    }

    const commit = (next: TargetRects): void => {
      if (targetRectsEqual(stateRef.current, next)) return
      stateRef.current = next
      setState(next)
    }

    const update = (): void => {
      frame = 0
      let anyFound = false
      let firstEl: Element | null = null
      let firstTop = Infinity
      for (const sel of selectors) {
        const el = document.querySelector(sel)
        const prev = observedElements.get(sel)
        if (el !== prev) {
          if (prev) resizeObserver?.unobserve(prev)
          observedElements.set(sel, el)
          if (el) resizeObserver?.observe(el)
        }
        if (el) {
          anyFound = true
          const top = el.getBoundingClientRect().top
          if (top < firstTop) {
            firstTop = top
            firstEl = el
          }
        }
      }
      // 只把最靠上的目标滚入视野（相邻目标会随之可见），避免多目标之间来回滚动
      if (firstEl) firstEl.scrollIntoView({ block: 'center', inline: 'nearest' })

      if (!anyFound) {
        commit({ rects: [], union: null })
        if (missingTimer === null) {
          missingTimer = setTimeout(() => {
            missingTimer = null
            if (!selectors.some((s) => document.querySelector(s))) onMissingRef.current()
          }, 1500)
        }
        return
      }
      if (missingTimer !== null) {
        clearTimeout(missingTimer)
        missingTimer = null
      }
      commit(compute())
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
  }, [padding, selectors])

  return state
}
