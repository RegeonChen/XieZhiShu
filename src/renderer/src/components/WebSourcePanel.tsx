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
 * 网页资料库（2026-08-11 起）：注册站点后，**生成汇编时**按任务自己的年份区间自动检索该网站的文章
 * （发现清单 → 按发布时间抓取 → 只看正文判相关性），命中的落成该任务的网页来源参与检索/溯源。
 * 2026-10-05（用户裁定 A）：面板**只保留站点注册与列表** —— 年份区间与"区间内 N 篇 / 预计抓取时长"
 * 预览都在**任务流程里**（`ChatPanel` 的内联年份控件）；手动抓取入口连同其 IPC 一并删除。
 */
function WebSourcePanel() {
  const t = zhCN.webSource
  const [sites, setSites] = useState<WebSiteItem[]>([])
  const [urlInput, setUrlInput] = useState('')
  const [titleInput, setTitleInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<WebSiteItem | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editUrl, setEditUrl] = useState('')

  /*
   * 2026-10-05（用户裁定 A）：本面板原来的「抓取并筛选」**整块已删除** ——
   * ① 年份区间改到**任务流程里**设置（新建汇编任务、首次发送撰写要求时输入框上方的内联选择）；
   * ② 「区间内 N 篇 / 占比 / 预计抓取时长」预览也搬到同一处（选完年份即可见），面板不再重复展示；
   * ③ 手动抓取入口（绑定任务 / 主题关键词 / 开始抓取 / 重置抓取状态）删除：抓取由生成管线
   *    按任务自己的年份区间自动完成（Phase 10 P5，用户零操作），手动路径只会带来
   *    "两个口径谁为准"的歧义与误点几小时抓取的风险。
   * 因此本面板现在只负责**站点注册与列表**（站点发现与清单同步见 `main/web-source/site-crawler.ts`）。
   */

  /**
   * 2026-10-06（Phase 11 G，用户实测反馈）：清单同步状态（谁在同步、谁上次失败）。
   * 注册站点后主进程会**自动同步一次**，所以这里必须轮询——否则用户点完「注册」看不到任何反应。
   */
  const [syncState, setSyncState] = useState<{ syncing: string[]; errors: Record<string, string> }>({
    syncing: [],
    errors: {}
  })
  const [articleCounts, setArticleCounts] = useState<Record<string, number>>({})
  const [syncingId, setSyncingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await window.api.listWebSources()
    if (res.ok && res.data) {
      setSites(res.data.sites as WebSiteItem[])
      setArticleCounts(res.data.articleCounts ?? {})
    }
    if (typeof window.api.webSourceSyncStatus === 'function') {
      try {
        const st = await window.api.webSourceSyncStatus()
        if (st.ok && st.data) setSyncState(st.data)
      } catch {
        /* 桥不可用：不影响站点列表 */
      }
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** 有站点在同步时 2 秒轮询一次（同步完自动停，不打扰主进程） */
  const anySyncing = syncState.syncing.length > 0
  useEffect(() => {
    if (!anySyncing) return
    const timer = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(timer)
  }, [anySyncing, load])

  /** 手动同步（失败后的重试入口；注册后也会自动跑一次） */
  const handleSync = async (id: string) => {
    setSyncingId(id)
    setMsg(null)
    setErr(null)
    try {
      const res = await window.api.syncWebSource(id)
      if (res.ok && res.data) {
        setMsg(res.data.error ? t.syncFailed.replace('{message}', res.data.error) + t.syncRetryHint : t.syncDone.replace('{count}', String(res.data.added)))
      } else {
        setErr(t.operationFailed.replace('{message}', res.error?.message ?? ''))
      }
    } finally {
      setSyncingId(null)
      await load()
    }
  }

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
        // 注册后主进程会自动同步清单 → 如实告诉用户"正在同步"，别让人以为没反应
        setMsg(t.added + '：' + t.syncStarted)
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

  const formatTime = (iso?: string): string => {
    if (!iso) return t.neverSynced
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const startEdit = (site: WebSiteItem) => {
    setEditingId(site.id)
    setEditTitle(site.title || '')
    setEditUrl(site.rootUrl || '')
    setMsg(null)
    setErr(null)
  }
  const cancelEdit = () => {
    setEditingId(null)
    setEditTitle('')
    setEditUrl('')
  }
  const handleUpdate = async () => {
    if (!editingId || busy) return
    const rootUrl = editUrl.trim()
    if (!rootUrl) {
      setErr(t.operationFailed.replace('{message}', '网站网址不能为空'))
      return
    }
    setBusy(true)
    setMsg(null)
    setErr(null)
    try {
      const res = await window.api.updateWebSource(editingId, rootUrl, editTitle.trim())
      if (res.ok) {
        setMsg(t.updated)
        cancelEdit()
        await load()
      } else {
        setErr(t.operationFailed.replace('{message}', res.error?.message ?? ''))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="web-source" data-onboarding="web-source">
      <div className="web-source__head">
        <span className="web-source__hint">{t.hint}</span>
      </div>
      {/* 2026-10-05（用户裁定 A）：原「抓取并筛选」整块已删除 —— 年份与区间预览改到任务流程里，
          抓取由生成管线按任务自动完成（Phase 10 P5），面板只负责站点注册与列表。 */}
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
              {editingId === s.id ? (
                <div className="web-source__item-edit">
                  <input
                    type="text"
                    className="source-list__url-input"
                    placeholder={t.titlePlaceholder}
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                  />
                  <input
                    type="url"
                    className="source-list__url-input"
                    placeholder={t.urlPlaceholder}
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleUpdate() }}
                  />
                  <span className="web-source__item-synced">{t.syncedAt.replace('{time}', formatTime(s.lastSyncedAt))}</span>
                  <div className="web-source__item-actions">
                    <button type="button" className="source-list__btn source-list__btn--primary" onClick={() => void handleUpdate()} disabled={busy}>
                      {t.updateSave}
                    </button>
                    <button type="button" className="source-list__btn" onClick={cancelEdit} disabled={busy}>
                      {zhCN.common.cancel}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="web-source__item-info">
                    <span className="web-source__item-title">{s.title || s.rootUrl}</span>
                    {s.title ? <span className="web-source__item-url">{s.rootUrl}</span> : null}
                    {/*
                      Phase 11 G：把"清单条数 / 正在同步 / 上次失败"如实摆出来——用户实测的困惑正是
                      "注册了新站却看不到任何东西"，而根因就是清单没同步（0 条）。
                    */}
                    <span className="web-source__item-synced">
                      {syncState.syncing.includes(s.id)
                        ? t.syncing
                        : (articleCounts[s.id] ?? 0) > 0
                          ? `${t.articles.replace('{count}', String(articleCounts[s.id]))}　${t.syncedAt.replace('{time}', formatTime(s.lastSyncedAt))}`
                          : t.articlesEmpty}
                    </span>
                    {syncState.errors[s.id] ? (
                      <span className="web-source__item-synced web-source__item-synced--err">
                        {t.syncFailed.replace('{message}', syncState.errors[s.id])}
                        {t.syncRetryHint}
                      </span>
                    ) : null}
                  </div>
                  <div className="web-source__item-actions">
                    <button
                      type="button"
                      className="source-list__btn"
                      onClick={() => void handleSync(s.id)}
                      disabled={busy || syncingId === s.id || syncState.syncing.includes(s.id)}
                    >
                      {syncState.syncing.includes(s.id) || syncingId === s.id ? t.syncing : t.syncNow}
                    </button>
                    <button type="button" className="source-list__btn" onClick={() => startEdit(s)} disabled={busy}>
                      {t.edit}
                    </button>
                    <button type="button" className="source-list__btn source-list__btn--danger" onClick={() => setPendingRemove(s)} disabled={busy}>
                      {t.remove}
                    </button>
                  </div>
                </>
              )}
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
