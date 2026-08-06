import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './assets/main.css'

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
