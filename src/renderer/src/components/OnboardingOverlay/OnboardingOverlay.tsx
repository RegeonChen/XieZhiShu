import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ONBOARDING_COPY, ONBOARDING_STEPS } from './onboarding-copy'
import { useTargetRect, type TargetRect } from './useTargetRect'
import './OnboardingOverlay.css'

/**
 * 新手引导聚光覆盖层（2026-08-14，借鉴聚合拾遗 OnboardingOverlay）：
 * 全屏遮罩在目标元素处挖洞，配合提示卡片（coachmark）逐步讲解；支持上一步/下一步/跳过与键盘导航。
 * 目标缺失时自动跳到下一步（useTargetRect 的 onMissing 回调）。
 */
type Placement = 'left' | 'right' | 'top' | 'bottom' | 'center'

const STEP_TRANSITION_MS = 220

interface CoachmarkPosition {
  left: number
  top: number
  placement: Placement
}

function getCoachmarkPosition(
  target: TargetRect | null,
  viewportWidth: number,
  viewportHeight: number,
  cardWidth = 380,
  cardHeight = 270
): CoachmarkPosition {
  const gap = 18
  const margin = 16
  const clampLeft = (v: number): number => Math.max(margin, Math.min(v, viewportWidth - cardWidth - margin))
  const clampTop = (v: number): number => Math.max(margin, Math.min(v, viewportHeight - cardHeight - margin))

  if (!target || viewportWidth < 720) {
    return { left: clampLeft((viewportWidth - cardWidth) / 2), top: clampTop(viewportHeight - cardHeight - 22), placement: 'center' }
  }
  if (target.right + gap + cardWidth <= viewportWidth - margin) {
    return { left: target.right + gap, top: clampTop(target.top + (target.height - cardHeight) / 2), placement: 'right' }
  }
  if (target.left - gap - cardWidth >= margin) {
    return { left: target.left - gap - cardWidth, top: clampTop(target.top + (target.height - cardHeight) / 2), placement: 'left' }
  }
  if (target.bottom + gap + cardHeight <= viewportHeight - margin) {
    return { left: clampLeft(target.left + (target.width - cardWidth) / 2), top: target.bottom + gap, placement: 'bottom' }
  }
  return { left: clampLeft(target.left + (target.width - cardWidth) / 2), top: clampTop(target.top - gap - cardHeight), placement: 'top' }
}

/** 切换步骤时的过渡时长（与 CSS 动画一致） */
const STEP_LOCATE_TIMEOUT_MS = 3000
/** 连续这么多步都找不到目标 → 直接结束教程（避免遮罩长期占屏、界面被来回拉页） */
const MAX_SKIPPED_STEPS = 3

interface OnboardingOverlayProps {
  open: boolean
  onDismiss: (reason: 'completed' | 'skipped') => void
  /** 步骤切换时通知上层切换功能区页面，使目标元素渲染出来 */
  onStepChange?: (page: string) => void
}

export default function OnboardingOverlay({ open, onDismiss, onStepChange }: OnboardingOverlayProps) {
  const [stepIndex, setStepIndex] = useState(0)
  const [transitioning, setTransitioning] = useState(false)
  const [cardSize, setCardSize] = useState({ w: 380, h: 270 })
  const cardRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 连续"找不到目标而跳步"的计数（找到目标即清零） */
  const skipStreakRef = useRef(0)
  /** 供定时器读取"当前是否已找到目标"（state 在闭包里会是旧值） */
  const unionRef = useRef<TargetRect | null>(null)
  /** 供定时器调用最新的 advanceMissingTarget（避免把函数放进依赖导致计时被重置） */
  const advanceMissingTargetRef = useRef<() => void>(() => {})

  // 用卡片的真实尺寸做定位与越界钳制：文案较长时卡片高度会超过默认 270px，
  // 按硬编码高度定位会导致说明框超出视口。
  useLayoutEffect(() => {
    if (!open) return
    const el = cardRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) setCardSize({ w: rect.width, h: rect.height })
  }, [open, stepIndex])

  const step = ONBOARDING_STEPS[stepIndex]
  const stepCopy = ONBOARDING_COPY.steps[step.id]
  const isLast = stepIndex === ONBOARDING_STEPS.length - 1

  useEffect(() => {
    if (!open) return
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setStepIndex(0)
    setTransitioning(false)
    onStepChange?.(ONBOARDING_STEPS[0].page)
    requestAnimationFrame(() => cardRef.current?.focus())
  }, [open, onStepChange])

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    []
  )

  const moveToStep = (nextIndex: number): void => {
    const clamped = Math.max(0, Math.min(nextIndex, ONBOARDING_STEPS.length - 1))
    setTransitioning(true)
    setStepIndex(clamped)
    onStepChange?.(ONBOARDING_STEPS[clamped].page)
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setTransitioning(false)
    }, STEP_TRANSITION_MS)
  }

  const advanceMissingTarget = (): void => {
    if (!open) return
    // 连续找不到目标的步数达到上限就直接结束教程：绝不允许"遮罩一直盖着、还把界面
    // 在不同功能区之间来回拉"这种把软件拖成不可用的状态（用户 2026-10-03 实测反馈）。
    skipStreakRef.current += 1
    if (isLast || skipStreakRef.current >= MAX_SKIPPED_STEPS) onDismiss('completed')
    else moveToStep(stepIndex + 1)
  }

  const { rects, union } = useTargetRect(open ? step.targets : null, step.padding, advanceMissingTarget)
  unionRef.current = union
  advanceMissingTargetRef.current = advanceMissingTarget

  /** 找到目标就把"连续跳步"计数清零 */
  useEffect(() => {
    if (union) skipStreakRef.current = 0
  }, [union])

  /**
   * 每一步都给一个**总时限**：到点仍没找到可见目标就跳过这一步。
   * 只靠 useTargetRect 内部"连续 1.5s 未找到"不够——目标时隐时现时那个计时会被反复重置，
   * 教程就会一直停在"正在定位界面…"。
   */
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      if (unionRef.current) return
      advanceMissingTargetRef.current()
    }, STEP_LOCATE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [open, stepIndex])

  const position = useMemo(
    () => getCoachmarkPosition(union, window.innerWidth, window.innerHeight, cardSize.w, cardSize.h),
    [union, cardSize]
  )

  if (!open) return null

  const goNext = (): void => {
    if (isLast) onDismiss('completed')
    else moveToStep(stepIndex + 1)
  }
  const goPrevious = (): void => moveToStep(stepIndex - 1)

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onDismiss('skipped')
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      goNext()
    } else if (event.key === 'ArrowLeft' && stepIndex > 0) {
      event.preventDefault()
      goPrevious()
    }
  }

  return (
    <div className="onboarding-overlay" data-ob-step={step.id} onKeyDown={handleKeyDown}>
      <svg className="onboarding-overlay__shade" aria-hidden="true">
        <defs>
          <mask id="ob-spotlight-mask">
            <rect width="100%" height="100%" fill="white" />
            {rects.map((r, i) => (
              <rect
                key={i}
                x={r.left}
                y={r.top}
                width={r.width}
                height={r.height}
                rx="7"
                fill="black"
              />
            ))}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(8, 11, 18, 0.72)" mask="url(#ob-spotlight-mask)" />
      </svg>
      {rects.map((r, i) => (
        <div
          key={i}
          className="onboarding-overlay__spotlight"
          style={{
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height
          }}
        />
      ))}
      <div
        className="onboarding-card-positioner"
        data-placement={position.placement}
        style={{ transform: `translate3d(${position.left}px, ${position.top}px, 0)` }}
      >
        <div
          ref={cardRef}
          className="onboarding-card"
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          data-placement={position.placement}
        >
          <header className="onboarding-card__header">
            <span className="onboarding-card__brand">{ONBOARDING_COPY.eyebrow}</span>
            <button type="button" className="onboarding-card__skip" onClick={() => onDismiss('skipped')}>
              {ONBOARDING_COPY.skip}
            </button>
          </header>

          <div className="onboarding-card__progress">
            <span>{ONBOARDING_COPY.progress(stepIndex + 1, ONBOARDING_STEPS.length)}</span>
            <div className="onboarding-card__progress-track">
              <span style={{ width: `${((stepIndex + 1) / ONBOARDING_STEPS.length) * 100}%` }} />
            </div>
          </div>

          <main key={step.id} className={`onboarding-card__body${transitioning ? ' is-transitioning' : ''}`}>
            <span className="onboarding-card__step-number">{String(stepIndex + 1).padStart(2, '0')}</span>
            <div>
              <h2 className="onboarding-card__title">{stepCopy.title}</h2>
              <p className="onboarding-card__description">{stepCopy.description}</p>
              {!union ? <p className="onboarding-card__locating">{ONBOARDING_COPY.locating}</p> : null}
            </div>
          </main>

          <footer className="onboarding-card__footer">
            <div>
              <p className="onboarding-card__hint">{stepCopy.hint}</p>
              <p className="onboarding-card__reopen-hint">{ONBOARDING_COPY.reopenHint}</p>
            </div>
            <div className="onboarding-card__actions">
              <button
                type="button"
                className="onboarding-card__button"
                onClick={goPrevious}
                disabled={stepIndex === 0}
              >
                {ONBOARDING_COPY.previous}
              </button>
              <button
                type="button"
                className="onboarding-card__button onboarding-card__button--primary"
                onClick={goNext}
              >
                {isLast ? ONBOARDING_COPY.finish : ONBOARDING_COPY.next}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </div>
  )
}
