import { useEffect, type ReactNode } from 'react'
import { zhCN } from '../i18n/zh-CN'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmText: string
  cancelText?: string
  danger?: boolean
  busy?: boolean
  busyText?: string
  error?: string
  /**
   * 可选附加区（消息与按钮之间）：例如「本轮不做收敛（全量送入）」复选框。
   * 做成插槽是为了让通用确认框不认识具体业务，同时不必把文案硬编码在组件里。
   */
  children?: ReactNode
  onConfirm: () => void
  onCancel: () => void
}

/** 通用二次确认对话框（替代原生 confirm，避免原生对话框打断窗口焦点） */
function ConfirmDialog({
  title,
  message,
  confirmText,
  cancelText,
  danger,
  busy,
  busyText,
  error,
  children,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  // Esc 取消（busy 时不允许取消，防止误操作中途关闭）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <div className="confirm-dialog__overlay" onMouseDown={(e) => e.stopPropagation()}>
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h4 className="confirm-dialog__title">{title}</h4>
        <p className="confirm-dialog__message">{message}</p>
        {children}
        {error ? <p className="confirm-dialog__error">{error}</p> : null}
        <div className="confirm-dialog__actions">
          <button type="button" className="source-list__btn" onClick={onCancel} disabled={busy} autoFocus>
            {cancelText ?? zhCN.common.cancel}
          </button>
          <button
            type="button"
            className={`source-list__btn${danger ? ' source-list__btn--danger' : ' source-list__btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (busyText ?? zhCN.common.deleting) : confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
