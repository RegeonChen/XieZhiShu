import { useState, useEffect, useCallback } from 'react'
import { zhCN } from '../i18n/zh-CN'

export interface WritingTaskItem {
  id: string
  title: string
  currentVersion: number
  createdAt: string
}

function WritingTaskList({ selectedId, onSelect, reloadKey }: {
  selectedId: string | null
  onSelect: (id: string | null) => void
  reloadKey: number
}) {
  const [tasks, setTasks] = useState<WritingTaskItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

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

  return (
    <div className="writing-task-list">
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
            >
              <span className="source-list__item-title">{t.title}</span>
              <span className="source-list__item-kind">
                {zhCN.writingTasks.version.replace('{version}', String(t.currentVersion))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default WritingTaskList
