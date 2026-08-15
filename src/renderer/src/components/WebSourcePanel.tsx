import { useState, useEffect, useCallback } from 'react'
import { zhCN } from '../i18n/zh-CN'
import ConfirmDialog from './ConfirmDialog'

interface WebSiteItem {
  id: string
  rootUrl: string
  title: string
  lastSyncedAt?: string
}

/**
 * 网页资料库（2026-08-11）：注册站点后，生成初稿时自动检索该网站中与撰写要求相关的文章并抓取正文，
 * 与本地文件同等参与资料粗筛、矛盾检测与来源溯源。此处提供站点的注册 / 列表 / 删除 / 手动同步。
 */
function WebSourcePanel() {
  const t = zhCN.webSource
  const [sites, setSites] = useState<WebSiteItem[]>([])
  const [urlInput, setUrlInput] = useState('')
  const [titleInput, setTitleInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<WebSiteItem | null>(null)

  const load = useCallback(async () => {
    const res = await window.api.listWebSources()
    if (res.ok && res.data) setSites(res.data.sites as WebSiteItem[])
  }, [])

  useEffect(() => { void load() }, [load])

  const handleAdd = async () => {
    const rootUrl = urlInput.trim()
    if (!rootUrl || busy) return
    setBusy(true)
    setMsg(null)
    setErr(null)
    try {
      const res = await window.api.addWebSource(rootUrl, titleInput.trim() || undefined)
      if (res.ok && res.data) {
        setUrlInput('')
        setTitleInput('')
        setMsg(t.added)
        await load()
      } else {
        setErr(t.operationFailed.replace('{message}', res.error?.message ?? ''))
      }
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async () => {
    if (!pendingRemove) return
    setBusy(true)
    setMsg(null)
    setErr(null)
    try {
      const res = await window.api.removeWebSource(pendingRemove.id)
      if (res.ok) {
        setPendingRemove(null)
        await load()
      } else {
        setErr(t.operationFailed.replace('{message}', res.error?.message ?? ''))
      }
    } finally {
      setBusy(false)
    }
  }

  const handleSync = async (id: string) => {
    setSyncingId(id)
    setMsg(null)
    setErr(null)
    try {
      const res = await window.api.syncWebSource(id)
      if (res.ok && res.data) {
        setMsg(t.syncDone.replace('{added}', String(res.data.articles)))
      } else {
        setErr(t.operationFailed.replace('{message}', res.error?.message ?? ''))
      }
      await load()
    } finally {
      setSyncingId(null)
    }
  }

  const formatTime = (iso?: string): string => {
    if (!iso) return t.neverSynced
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  return (
    <div className="web-source" data-onboarding="web-source">
      <div className="web-source__head">
        <span className="web-source__title">{t.title}</span>
        <span className="web-source__hint">{t.hint}</span>
      </div>
      <div className="web-source__add">
        <input
          type="url"
          className="source-list__url-input"
          placeholder={t.urlPlaceholder}
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd() }}
        />
        <input
          type="text"
          className="source-list__url-input source-list__url-input--small"
          placeholder={t.titlePlaceholder}
          value={titleInput}
          onChange={(e) => setTitleInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd() }}
        />
        <button type="button" className="source-list__btn source-list__btn--primary" onClick={() => void handleAdd()} disabled={busy || !urlInput.trim()}>
          {busy ? t.adding : t.add}
        </button>
      </div>
      {msg ? <p className="source-list__msg">{msg}</p> : null}
      {err ? <p className="source-list__error">{err}</p> : null}
      {sites.length === 0 ? (
        <p className="web-source__empty">{t.empty}</p>
      ) : (
        <ul className="web-source__list">
          {sites.map((s) => (
            <li key={s.id} className="web-source__item">
              <div className="web-source__item-info">
                <span className="web-source__item-title">{s.title || s.rootUrl}</span>
                {s.title ? <span className="web-source__item-url">{s.rootUrl}</span> : null}
                <span className="web-source__item-synced">{t.syncedAt.replace('{time}', formatTime(s.lastSyncedAt))}</span>
              </div>
              <div className="web-source__item-actions">
                <button type="button" className="source-list__btn" onClick={() => void handleSync(s.id)} disabled={syncingId !== null}>
                  {syncingId === s.id ? t.syncing : t.sync}
                </button>
                <button type="button" className="source-list__btn source-list__btn--danger" onClick={() => setPendingRemove(s)} disabled={syncingId !== null}>
                  {t.remove}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {pendingRemove ? (
        <ConfirmDialog
          title={zhCN.common.confirm}
          message={t.removeConfirm.replace('{title}', pendingRemove.title || pendingRemove.rootUrl)}
          confirmText={t.remove}
          danger
          busy={busy}
          onConfirm={() => void handleRemove()}
          onCancel={() => setPendingRemove(null)}
        />
      ) : null}
    </div>
  )
}

export default WebSourcePanel
