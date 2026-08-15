import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
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

interface OnboardingOverlayProps {
  open: boolean
  onDismiss: (reason: 'completed' | 'skipped') => void
  /** 步骤切换时通知上层切换功能区页面，使目标元素渲染出来 */
  onStepChange?: (page: string) => void
}

export default function OnboardingOverlay({ open, onDismiss, onStepChange }: OnboardingOverlayProps) {
  const [stepIndex, setStepIndex] = useState(0)
  const [transitioning, setTransitioning] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    if (isLast) onDismiss('completed')
    else moveToStep(stepIndex + 1)
  }

  const targetRect = useTargetRect(open ? step.target : null, step.padding, advanceMissingTarget)

  const position = useMemo(
    () => getCoachmarkPosition(targetRect, window.innerWidth, window.innerHeight),
    [targetRect]
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
            {targetRect ? (
              <rect
                x={targetRect.left}
                y={targetRect.top}
                width={targetRect.width}
                height={targetRect.height}
                rx="7"
                fill="black"
              />
            ) : null}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(8, 11, 18, 0.72)" mask="url(#ob-spotlight-mask)" />
      </svg>
      {targetRect ? (
        <div
          className="onboarding-overlay__spotlight"
          style={{
            left: targetRect.left,
            top: targetRect.top,
            width: targetRect.width,
            height: targetRect.height
          }}
        />
      ) : null}
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
              {!targetRect ? <p className="onboarding-card__locating">{ONBOARDING_COPY.locating}</p> : null}
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
