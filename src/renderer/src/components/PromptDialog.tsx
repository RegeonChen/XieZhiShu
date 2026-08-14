import { useState, useEffect, useRef } from 'react'

interface PromptDialogProps {
  title: string
  label?: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
  cancelText?: string
  busy?: boolean
  error?: string | null
  onConfirm: (value: string) => void
  onCancel: () => void
}

/** 带文本输入的自定义模态对话框（避免原生 prompt 的窗口失焦问题） */
function PromptDialog({
  title,
  label,
  defaultValue = '',
  placeholder,
  confirmText = '确定',
  cancelText = '取消',
  busy = false,
  error = null,
  onConfirm,
  onCancel
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className="confirm-dialog__overlay" onMouseDown={onCancel}>
      <div className="confirm-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="confirm-dialog__title">{title}</h3>
        {label ? <p className="confirm-dialog__message">{label}</p> : null}
        <input
          ref={inputRef}
          className="writing-form__input"
          value={value}
          placeholder={placeholder}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy && value.trim()) onConfirm(value.trim())
            if (e.key === 'Escape') onCancel()
          }}
        />
        {error ? <p className="source-list__error">{error}</p> : null}
        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="source-list__btn source-list__btn--primary"
            disabled={busy || !value.trim()}
            onClick={() => onConfirm(value.trim())}
          >
            {confirmText}
          </button>
          <button type="button" className="source-list__btn" disabled={busy} onClick={onCancel}>
            {cancelText}
          </button>
        </div>
      </div>
    </div>
  )
}

export default PromptDialog
