import { useState, useEffect, useCallback } from 'react'
import { zhCN } from '../i18n/zh-CN'

export interface WritingTaskItem {
  id: string
  title: string
  currentVersion: number
  createdAt: string
}

interface ContextMenuState {
  x: number
  y: number
  taskId: string
  title: string
}

function WritingTaskList({ selectedId, onSelect, reloadKey }: {
  selectedId: string | null
  onSelect: (id: string | null) => void
  reloadKey: number
}) {
  const [tasks, setTasks] = useState<WritingTaskItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await window.api.listTasks()
      if (res.ok && res.data) setTasks(res.data.items as WritingTaskItem[])
      else setErr(zhCN.writingTasks.loadFailed.replace('{message}', res.error?.message ?? ''))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, reloadKey])

  // 右键菜单：点击外部 / Esc 关闭
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  const handleDelete = async (taskId: string, title: string) => {
    if (!confirm(zhCN.writingTasks.deleteConfirm.replace('{title}', title))) return
    setDeleting(true)
    setDeleteErr(null)
    try {
      const res = await window.api.deleteTask(taskId)
      if (res.ok) {
        setContextMenu(null)
        setTasks((prev) => (prev ? prev.filter((t) => t.id !== taskId) : prev))
        if (selectedId === taskId) onSelect(null)
      } else {
        setDeleteErr(zhCN.writingTasks.deleteFailed.replace('{message}', res.error?.message ?? ''))
      }
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="writing-task-list">
      {deleteErr ? <p className="source-list__error">{deleteErr}</p> : null}
      {err ? <p className="source-list__error">{err}</p> : null}
      {loading ? (
        <p className="source-list__status">{zhCN.writingTasks.loading}</p>
      ) : tasks === null || tasks.length === 0 ? (
        <p className="source-list__status">{zhCN.writingTasks.empty}</p>
      ) : (
        <ul className="source-list__items">
          {tasks.map((t) => (
            <li
              key={t.id}
              className={`source-list__item${selectedId === t.id ? ' source-list__item--active' : ''}`}
              onClick={() => onSelect(selectedId === t.id ? null : t.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setContextMenu({ x: e.clientX, y: e.clientY, taskId: t.id, title: t.title })
              }}
            >
              <span className="source-list__item-title">{t.title}</span>
              <span className="source-list__item-kind">
                {zhCN.writingTasks.version.replace('{version}', String(t.currentVersion))}
              </span>
            </li>
          ))}
        </ul>
      )}

      {contextMenu ? (
        <div
          className="source-list__context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="source-list__context-item source-list__context-item--danger"
            onClick={() => handleDelete(contextMenu.taskId, contextMenu.title)}
            disabled={deleting}
          >
            {zhCN.writingTasks.deleteBtn}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default WritingTaskList
