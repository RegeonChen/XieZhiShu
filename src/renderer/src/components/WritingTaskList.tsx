import { useState, useEffect, useCallback } from 'react'
import { zhCN } from '../i18n/zh-CN'
import ConfirmDialog from './ConfirmDialog'
import PromptDialog from './PromptDialog'

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
  const [pendingDelete, setPendingDelete] = useState<{ taskId: string; title: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)
  const [pendingRename, setPendingRename] = useState<{ taskId: string; title: string } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameErr, setRenameErr] = useState<string | null>(null)

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

  const handleDelete = async () => {
    if (!pendingDelete) return
    const { taskId } = pendingDelete
    setDeleting(true)
    setDeleteErr(null)
    try {
      const res = await window.api.deleteTask(taskId)
      if (res.ok) {
        setPendingDelete(null)
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

  // Phase 3.5：右键重命名任务标题（仅中栏列表显示标题）
  const handleRename = async (value: string) => {
    if (!pendingRename) return
    setRenaming(true)
    setRenameErr(null)
    try {
      const res = await window.api.renameTask(pendingRename.taskId, value)
      if (res.ok && res.data) {
        const renamed = res.data.task as WritingTaskItem
        setTasks((prev) => (prev ? prev.map((t) => (t.id === renamed.id ? { ...t, title: renamed.title } : t)) : prev))
        setPendingRename(null)
      } else {
        setRenameErr(zhCN.writingTasks.renameFailed.replace('{message}', res.error?.message ?? ''))
      }
    } catch {
      setRenameErr(zhCN.writingTasks.renameFailed.replace('{message}', ''))
    } finally {
      setRenaming(false)
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
            className="source-list__context-item"
            onClick={() => { setPendingRename({ taskId: contextMenu.taskId, title: contextMenu.title }); setContextMenu(null) }}
          >
            {zhCN.writingTasks.renameBtn}
          </button>
          <button
            type="button"
            className="source-list__context-item source-list__context-item--danger"
            onClick={() => setPendingDelete({ taskId: contextMenu.taskId, title: contextMenu.title })}
          >
            {zhCN.writingTasks.deleteBtn}
          </button>
        </div>
      ) : null}

      {pendingRename ? (
        <PromptDialog
          title={zhCN.writingTasks.renameTitle}
          label={zhCN.writingTasks.renameLabel}
          defaultValue={pendingRename.title}
          confirmText={zhCN.writingTasks.renameBtn}
          busy={renaming}
          error={renameErr}
          onConfirm={(value) => void handleRename(value)}
          onCancel={() => { setPendingRename(null); setRenameErr(null) }}
        />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title={zhCN.writingTasks.deleteTitle}
          message={zhCN.writingTasks.deleteConfirm.replace('{title}', pendingDelete.title)}
          confirmText={zhCN.writingTasks.deleteBtn}
          danger
          busy={deleting}
          onConfirm={handleDelete}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  )
}

export default WritingTaskList
