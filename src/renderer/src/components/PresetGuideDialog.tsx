import { zhCN } from '../i18n/zh-CN'
import type { LlmPreset } from '../../../shared/llm-presets'

interface PresetGuideDialogProps {
  preset: LlmPreset
  onClose: () => void
}

/** 预设模型「获取 API key」教程悬浮窗：分步骤展示注册→获取→填入的指引，可一键打开官方注册页 */
function PresetGuideDialog({ preset, onClose }: PresetGuideDialogProps) {
  const t = zhCN.settingsPage.presetGuide

  const openSignup = (): void => {
    void window.api.openExternal(preset.signupUrl)
  }

  const isFree = preset.pricing.includes('免费')

  return (
    <div className="preset-guide__overlay" onMouseDown={(e) => e.stopPropagation()}>
      <div className="preset-guide" role="dialog" aria-modal="true" aria-label={t.title}>
        <div className="preset-guide__header">
          <div>
            <h4 className="preset-guide__title">{t.title}</h4>
            <p className="preset-guide__subtitle">
              {preset.name}
              <span className={`preset-guide__pricing${isFree ? ' is-free' : ''}`}>{preset.pricing}</span>
            </p>
          </div>
          <button type="button" className="preset-guide__close" aria-label={zhCN.common.cancel} onClick={onClose}>
            ×
          </button>
        </div>

        <ol className="preset-guide__steps">
          {preset.guide.map((step, i) => (
            <li key={i} className="preset-guide__step">
              <span className="preset-guide__step-num">{i + 1}</span>
              <div className="preset-guide__step-body">
                <span className="preset-guide__step-title">{step.title}</span>
                <span className="preset-guide__step-text">{step.text}</span>
              </div>
            </li>
          ))}
        </ol>

        <p className="preset-guide__hint">{t.hint}</p>

        <div className="preset-guide__actions">
          <button type="button" className="source-list__btn" onClick={onClose}>
            {t.closeBtn}
          </button>
          <button type="button" className="source-list__btn source-list__btn--primary" onClick={openSignup}>
            {t.openSignupBtn}
          </button>
        </div>
      </div>
    </div>
  )
}

export default PresetGuideDialog
