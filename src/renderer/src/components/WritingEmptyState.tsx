import { useState } from 'react'
import { zhCN } from '../i18n/zh-CN'

interface WritingEmptyStateProps {
  onCreated: (taskId: string) => void
}

/** 无撰写任务时的右栏空状态：插图 + 引导文案 + 「新建任务」按钮（点击立即创建） */
function WritingEmptyState({ onCreated }: WritingEmptyStateProps) {
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const handleCreate = async () => {
    if (creating) return
    setCreating(true)
    setErr(null)
    try {
      const res = await window.api.createTask()
      if (res.ok && res.data) {
        onCreated((res.data.task as { id: string }).id)
      } else {
        setErr(zhCN.writingEmpty.createFailed.replace('{message}', res.error?.message ?? ''))
      }
    } catch {
      setErr(zhCN.writingEmpty.createFailed.replace('{message}', ''))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="writing-empty">
      <svg
        className="writing-empty__art"
        width="120"
        height="120"
        viewBox="0 0 120 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect x="22" y="14" width="76" height="92" rx="6" fill="#e8effd" stroke="#2f6fed" strokeWidth="2" />
        <rect x="32" y="26" width="56" height="6" rx="3" fill="#2f6fed" opacity="0.55" />
        <rect x="32" y="40" width="48" height="5" rx="2.5" fill="#9db8ee" />
        <rect x="32" y="50" width="52" height="5" rx="2.5" fill="#9db8ee" />
        <rect x="32" y="60" width="44" height="5" rx="2.5" fill="#9db8ee" />
        <rect x="32" y="70" width="50" height="5" rx="2.5" fill="#9db8ee" />
        <path d="M60 88l6 6 10-12" stroke="#2f6fed" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="96" cy="96" r="16" fill="#dcfce7" stroke="#16a34a" strokeWidth="2" />
        <path d="M91 96l4 4 7-8" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <h2 className="writing-empty__title">{zhCN.writingEmpty.title}</h2>
      <p className="writing-empty__hint">{zhCN.writingEmpty.hint}</p>
      {err ? <p className="source-list__error">{err}</p> : null}
      <button
        type="button"
        className="source-list__btn source-list__btn--primary writing-empty__btn"
        onClick={() => void handleCreate()}
        disabled={creating}
      >
        {creating ? '...' : zhCN.writingEmpty.createBtn}
      </button>
    </div>
  )
}

export default WritingEmptyState
