import { useState, useEffect, useCallback } from 'react'
import { zhCN } from '../i18n/zh-CN'
import DraftEditor from './DraftEditor'

interface TaskItem {
  id: string
  title: string
  scope: { sourceIds: string[] } | { tagIds: string[] }
  currentVersion: number
}
interface SegmentSourceItem {
  sourceId: string
  position: string
  quote?: string
  sourceTitle?: string
}
interface SegmentItem {
  id: string
  heading?: string
  content: string
  aiGenerated: boolean
  sources: SegmentSourceItem[]
}
interface DraftItem {
  id: string
  versionNumber: number
  segments: SegmentItem[]
}
interface ChunkItem {
  sourceId: string
  sourceTitle: string
  position: string
  text: string
  score: number
}

function WritingWorkspace({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const [task, setTask] = useState<TaskItem | null>(null)
  const [draft, setDraft] = useState<DraftItem | null>(null)
  const [chunks, setChunks] = useState<ChunkItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [retrieving, setRetrieving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const tRes = await window.api.listTasks()
      const found = tRes.ok && tRes.data
        ? (tRes.data.items as TaskItem[]).find((t) => t.id === taskId) ?? null
        : null
      setTask(found)
      if (!found) return

      const vRes = await window.api.listVersions(taskId)
      if (vRes.ok && vRes.data) {
        const versions = (vRes.data.versions as { draftId: string; versionNumber: number }[])
          .sort((a, b) => b.versionNumber - a.versionNumber)
        const latest = versions[0]
        if (latest) {
          const dRes = await window.api.getDraft(latest.draftId)
          setDraft(dRes.ok && dRes.data ? (dRes.data as DraftItem) : null)
        } else {
          setDraft(null)
        }
      }
    } catch {
      setErr(zhCN.writingWorkspace.loadFailed.replace('{message}', ''))
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => { load() }, [load])

  const handleGenerate = async () => {
    setGenerating(true)
    setMsg(null)
    setErr(null)
    try {
      const res = await window.api.generateDraft(taskId)
      if (res.ok && res.data) {
        setDraft(res.data.draft as DraftItem)
        setMsg({ ok: true, text: zhCN.writingWorkspace.generateSuccess })
        onChanged()
      } else {
        setMsg({ ok: false, text: zhCN.writingWorkspace.generateFailed.replace('{message}', res.error?.message ?? '') })
      }
    } finally {
      setGenerating(false)
    }
  }

  const handleRetrieve = async () => {
    setRetrieving(true)
    setChunks(null)
    setMsg(null)
    try {
      const res = await window.api.retrieveChunks(taskId)
      if (res.ok && res.data) setChunks(res.data.chunks as ChunkItem[])
      else setMsg({ ok: false, text: zhCN.writingWorkspace.retrieveFailed.replace('{message}', res.error?.message ?? '') })
    } finally {
      setRetrieving(false)
    }
  }

  if (loading) return <p className="source-list__status">{zhCN.writingWorkspace.loading}</p>
  if (err) return <p className="source-list__error">{err}</p>
  if (!task) return <p className="source-list__error">{zhCN.writingWorkspace.loadFailed.replace('{message}', '任务不存在')}</p>

  const scopeCount = 'sourceIds' in task.scope ? task.scope.sourceIds.length : task.scope.tagIds.length
  const scopeText = 'sourceIds' in task.scope
    ? zhCN.writingWorkspace.scopeCount.replace('{count}', String(scopeCount))
    : zhCN.writingWorkspace.scopeTagCount.replace('{count}', String(scopeCount))

  return (
    <div className="writing-workspace">
      <h3 className="writing-workspace__title">{zhCN.writingWorkspace.taskTitle.replace('{title}', task.title)}</h3>
      <p className="writing-workspace__hint">{scopeText}</p>

      <div className="writing-workspace__toolbar">
        <button type="button" className="source-list__btn" onClick={handleRetrieve} disabled={retrieving}>
          {retrieving ? zhCN.writingWorkspace.retrieving : zhCN.writingWorkspace.retrieveBtn}
        </button>
        <button
          type="button"
          className="source-list__btn source-list__btn--primary"
          onClick={handleGenerate}
          disabled={generating || !!draft}
          title={draft ? zhCN.writingWorkspace.generateSuccess : undefined}
        >
          {generating ? zhCN.writingWorkspace.generating : zhCN.writingWorkspace.generateBtn}
        </button>
      </div>

      {msg ? <p className={`writing-workspace__msg${msg.ok ? ' is-ok' : ' is-err'}`}>{msg.text}</p> : null}

      {chunks !== null ? (
        <section className="writing-workspace__retrieval">
          <h4 className="writing-workspace__section-title">
            {chunks.length > 0
              ? zhCN.writingWorkspace.retrievalTitle.replace('{count}', String(chunks.length))
              : zhCN.writingWorkspace.retrieveEmpty}
          </h4>
          <ul className="writing-workspace__chunk-list">
            {chunks.map((c, i) => (
              <li key={i} className="writing-workspace__chunk">
                <span className="writing-workspace__chunk-meta">
                  《{c.sourceTitle}》 {c.position} · 相关度 {c.score}
                </span>
                <span className="writing-workspace__chunk-text">{c.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {draft ? (
        <section className="writing-workspace__draft">
          <h4 className="writing-workspace__section-title">
            {zhCN.writingWorkspace.draftTitle.replace('{version}', String(draft.versionNumber))}
          </h4>
          <DraftEditor draft={draft} />
        </section>
      ) : (
        <p className="writing-workspace__hint">{zhCN.writingWorkspace.noDraft}</p>
      )}
    </div>
  )
}

export default WritingWorkspace
