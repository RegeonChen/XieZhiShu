import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './assets/main.css'

// #region diagnostic-logging
// 全局 UI 交互埋点（2026-08-14）：捕获按钮点击 / 页面切换并上报主进程日志，用于复现用户试用中的 bug。
// 使用捕获阶段，先于 React 处理；fire-and-forget，不影响交互主流程。
function elementLabel(el: HTMLElement): string {
  const explicit = el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('data-onboarding')
  if (explicit) return explicit.replace(/\s+/g, ' ').slice(0, 60)
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.slice(0, 60)
}

document.addEventListener(
  'click',
  (e) => {
    try {
      const target = e.target as HTMLElement | null
      if (!target) return
      const interactive = target.closest('button, a, [role="button"], .side-nav__item, .center-pane__menu-item') as HTMLElement | null
      if (!interactive) return
      // 忽略新手引导覆盖层自身的点击
      if (interactive.closest('.onboarding-overlay')) return

      const nav = interactive.closest('.side-nav__item') as HTMLElement | null
      if (nav) {
        const page = nav.querySelector('.side-nav__label')?.textContent?.trim()
        void window.api.appendLog('INFO', 'ui', `切换到页面「${page ?? ''}」`)
        return
      }

      const label = elementLabel(interactive)
      void window.api.appendLog('INFO', 'ui', `点击${label ? `「${label}」` : '（无文本）'}`)
    } catch {
      // 日志上报失败不影响交互
    }
  },
  true
)
// #endregion

// #region fix-window-focus
// 修复：窗口进入"可见但未激活"状态时，点击输入框无法聚焦（无 focusin）。
// 检测到用户点击本窗口但 document 未获焦点时，请求主进程恢复窗口激活，并把焦点补到被点击的可编辑元素。
document.addEventListener(
  'mousedown',
  (e) => {
    if (document.hasFocus()) return
    const target = e.target as HTMLElement | null
    void window.api
      .focusWindow()
      .then(() => {
        if (!target) return
        const editable = target.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]') as HTMLElement | null
        if (editable) {
          window.setTimeout(() => {
            try { editable.focus({ preventScroll: true }) } catch { /* ignore */ }
          }, 50)
        }
      })
      .catch(() => {})
  },
  true
)
// #endregion

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
