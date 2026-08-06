import { zhCN } from '../i18n/zh-CN'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmText: string
  cancelText?: string
  danger?: boolean
  busy?: boolean
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
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  return (
    <div className="confirm-dialog__overlay" onMouseDown={(e) => e.stopPropagation()}>
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h4 className="confirm-dialog__title">{title}</h4>
        <p className="confirm-dialog__message">{message}</p>
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
            {busy ? zhCN.common.deleting : confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
