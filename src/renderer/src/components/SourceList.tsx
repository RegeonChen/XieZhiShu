import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { zhCN } from '../i18n/zh-CN'
import ConfirmDialog from './ConfirmDialog'
import WebSourcePanel from './WebSourcePanel'

interface SourceItem { id: string; title: string; kind: string; status: string; createdAt: string }

interface SourceListProps {
  onSelect: (id: string | null) => void
  /** 批量管理模式（资料管理） */
  bulkMode: boolean
  onExitBulk: () => void
  /** 资料被删除后通知上层（用于清理当前选中） */
  onSourcesChanged?: (deletedIds: string[]) => void
  /** 外部数据变化（如标签变更）时递增，触发列表重新加载 */
  reloadKey?: number
}

interface ContextMenuState {
  x: number
  y: number
  sourceId: string
  title: string
}

function SourceList({ onSelect, bulkMode, onExitBulk, onSourcesChanged, reloadKey }: SourceListProps) {
  const [sources, setSources] = useState<SourceItem[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [urlAdding, setUrlAdding] = useState(false)
  const [tagFilters, setTagFilters] = useState<{ id: string; name: string }[]>([])
  const [activeTagId, setActiveTagId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'one'; id: string; title: string } | { kind: 'bulk'; ids: string[] } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  const [summarizeMsg, setSummarizeMsg] = useState<string | null>(null)

  // Phase 2.2 工作区状态
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState(false)
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null)
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number; newFiles?: number } | null>(null)
  /** 当前展开的说明（key + 触发按钮的屏幕坐标，用于 Portal 悬浮定位）；null 表示全部收起 */
  const [info, setInfo] = useState<{ key: string; left: number; bottom: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // 手动"同步工作区"进行中标记：其完成后的刷新/提示由按钮处理器负责，避免与自动同步的完成事件重复
  const manualReconcilingRef = useRef(false)
  // 实时同步完成事件触发列表刷新时使用最新的标签筛选（避免订阅闭包中 activeTagId 过期）
  const activeTagIdRef = useRef<string | null>(null)
  activeTagIdRef.current = activeTagId

  const loadSources = useCallback(async (tagId?: string | null) => {
    setLoading(true)
    try {
      const params = tagId ? { tagIds: [tagId] } : undefined
      const res = await window.api.listSources(params)
      if (res.ok && res.data) setSources(res.data.items as SourceItem[])
    } finally { setLoading(false) }
  }, [])

  const loadWorkspaceStatus = useCallback(async () => {
    const res = await window.api.getWorkspaceStatus()
    if (res.ok && res.data) {
      const data = res.data as { workspaceDir?: string }
      setWorkspaceDir(data.workspaceDir ?? null)
    }
  }, [])

  const loadTags = async () => {
    const res = await window.api.listTags()
    if (res.ok && res.data) setTagFilters(res.data.items as { id: string; name: string }[])
  }

  useEffect(() => { loadSources(activeTagId); loadTags(); loadWorkspaceStatus() }, [activeTagId, loadSources, reloadKey, loadWorkspaceStatus])

  // 订阅工作区同步进度（主进程推送）：进度展示 + 对账完成后自动刷新列表（真正的实时同步）
  useEffect(() => {
    const unsubscribe = window.api.onWorkspaceProgress?.((p) => {
      setSyncProgress(p)
      const isFinished = p.finished === true || (p.total > 0 && p.done >= p.total)
      if (isFinished) {
        // 完成后稍作停留再清除，避免进度条闪断
        setTimeout(() => setSyncProgress(null), 800)
        // 手动"同步工作区"的完成刷新/提示由按钮处理器负责，此处仅处理自动同步（watcher / 聚焦 / 定时）
        if (manualReconcilingRef.current) return
        const changed = (p.added ?? 0) + (p.changed ?? 0) + (p.removed ?? 0) + (p.moved ?? 0)
        if (changed > 0) {
          setReconcileMsg(
            zhCN.sourceList.reconcileDone
              .replace('{added}', String(p.added ?? 0))
              .replace('{changed}', String(p.changed ?? 0))
              .replace('{removed}', String(p.removed ?? 0))
              .replace('{moved}', String(p.moved ?? 0))
              .replace('{errors}', String(p.errors ?? 0))
          )
          void loadSources(activeTagIdRef.current)
        }
      }
    })
    return () => unsubscribe?.()
  }, [loadSources])

  // 说明气泡（Portal 悬浮在窗口顶层）：点击外部 / Esc / 滚动 / 窗口缩放时关闭
  useEffect(() => {
    if (!info) return
    const close = () => setInfo(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true) // 捕获阶段，覆盖内部滚动容器
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [info])

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

  const handleImport = async () => {
    const result = await window.api.openFileDialog()
    if (!result.ok || !result.data?.paths.length) return
    setImporting(true); setImportErr(null)
    try {
      const res = await window.api.importFiles(result.data.paths)
      if (res.ok && res.data) {
        const imported: SourceItem[] = []
        for (const r of res.data.results) {
          if (r.source) imported.push(r.source as SourceItem)
          else if (r.error) setImportErr((p) => (p ? `${p}; ${r.path}: ${r.error}` : `${r.path}: ${r.error}`))
        }
        if (imported.length > 0) setSources((prev) => [...imported, ...prev])
      }
    } finally { setImporting(false) }
  }

  const handleAddUrl = async () => {
    const trimmed = urlInput.trim()
    if (!trimmed) return
    setUrlAdding(true); setImportErr(null)
    try {
      const res = await window.api.addUrl(trimmed)
      if (res.ok && res.data) {
        const src = res.data.source as SourceItem
        setSources((prev) => [{ id: src.id, title: src.title, kind: 'url', status: 'ready', createdAt: new Date().toISOString() }, ...prev])
        setUrlInput('')
      } else setImportErr(res.error?.message ?? '添加失败')
    } catch { setImportErr('网络请求异常') }
    finally { setUrlAdding(false) }
  }

  // 整理资料库：对尚无摘要的资料逐篇调用 LLM 生成摘要
  const handleSummarize = async () => {
    setSummarizing(true)
    setSummarizeMsg(null)
    try {
      const res = await window.api.summarizeAll()
      if (res.ok && res.data) {
        setSummarizeMsg(
          res.data.processed === 0
            ? zhCN.sourceList.summarizeEmpty
            : zhCN.sourceList.summarizeDone.replace('{ok}', String(res.data.ok)).replace('{failed}', String(res.data.failed))
        )
      } else {
        setSummarizeMsg(zhCN.sourceList.summarizeFailed.replace('{message}', res.error?.message ?? ''))
      }
    } catch {
      setSummarizeMsg(zhCN.sourceList.summarizeFailed.replace('{message}', ''))
    } finally {
      setSummarizing(false)
    }
  }

  // Phase 2.2：手动触发工作区全量对账（扫描 + 解析 + 索引）
  const handleReconcile = async () => {
    manualReconcilingRef.current = true
    setReconciling(true)
    setReconcileMsg(null)
    setSyncProgress(null)
    try {
      const res = await window.api.reconcileWorkspace()
      if (res.ok && res.data) {
        const r = res.data as { added: number; changed: number; removed: number; moved: number; errors: number }
        setReconcileMsg(
          zhCN.sourceList.reconcileDone
            .replace('{added}', String(r.added))
            .replace('{changed}', String(r.changed))
            .replace('{removed}', String(r.removed))
            .replace('{moved}', String(r.moved))
            .replace('{errors}', String(r.errors))
        )
        await loadSources(activeTagId)
      } else {
        setReconcileMsg(zhCN.sourceList.reconcileFailed.replace('{message}', res.error?.message ?? ''))
      }
    } catch {
      setReconcileMsg(zhCN.sourceList.reconcileFailed.replace('{message}', ''))
    } finally {
      manualReconcilingRef.current = false
      setReconciling(false)
    }
  }

  // 删除单个资料（右键菜单）
  const handleDeleteOne = async () => {
    if (!pendingDelete || pendingDelete.kind !== 'one') return
    const { id } = pendingDelete
    setDeleting(true); setDeleteErr(null)
    try {
      const res = await window.api.deleteSource(id)
      if (res.ok) {
        setPendingDelete(null)
        setContextMenu(null)
        await loadSources(activeTagId)
        onSourcesChanged?.([id])
      } else {
        setDeleteErr(res.error?.message ?? zhCN.sourceDelete.failed.replace('{message}', ''))
      }
    } finally { setDeleting(false) }
  }

  // 批量删除选中资料
  const handleBulkDelete = async () => {
    if (!pendingDelete || pendingDelete.kind !== 'bulk') return
    const ids = pendingDelete.ids
    setDeleting(true); setDeleteErr(null)
    try {
      const res = await window.api.deleteSources(ids)
      if (res.ok) {
        setPendingDelete(null)
        setSelectedIds(new Set())
        await loadSources(activeTagId)
        onSourcesChanged?.(ids)
      } else {
        setDeleteErr(res.error?.message ?? zhCN.sourceDelete.failed.replace('{message}', ''))
      }
    } finally { setDeleting(false) }
  }

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = sources.length > 0 && sources.every((s) => selectedIds.has(s.id))
  const handleToggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(sources.map((s) => s.id)))
  }

  return (
    <div className="source-list" ref={rootRef}>
      <div className="source-list__toolbar">
        <div className="source-list__tool-btn">
          <button type="button" className="source-list__btn source-list__btn--primary" onClick={handleImport} disabled={importing}>{importing ? '导入中...' : '导入'}</button>
          <button
            type="button"
            className="source-list__info-tip"
            aria-label="导入说明"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setInfo(info?.key === 'import' ? null : { key: 'import', left: r.left + r.width / 2, bottom: r.bottom })
            }}
          >i</button>
        </div>
        <div className="source-list__tool-btn">
          <button type="button" className="source-list__btn" onClick={handleSummarize} disabled={summarizing}>
            {summarizing ? zhCN.sourceList.summarizing : zhCN.sourceList.summarizeBtn}
          </button>
          <button
            type="button"
            className="source-list__info-tip"
            aria-label="整理资料说明"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setInfo(info?.key === 'summarize' ? null : { key: 'summarize', left: r.left + r.width / 2, bottom: r.bottom })
            }}
          >i</button>
        </div>
        {workspaceDir ? (
          <div className="source-list__tool-btn">
            <button type="button" className="source-list__btn" onClick={handleReconcile} disabled={reconciling}>
              {reconciling ? zhCN.sourceList.reconciling : zhCN.sourceList.reconcileBtn}
            </button>
            <button
              type="button"
              className="source-list__info-tip"
              aria-label="同步说明"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                const r = e.currentTarget.getBoundingClientRect()
                setInfo(info?.key === 'reconcile' ? null : { key: 'reconcile', left: r.left + r.width / 2, bottom: r.bottom })
              }}
            >i</button>
          </div>
        ) : null}
      </div>

      {/* 说明气泡：Portal 到 body 顶层，fixed 定位悬浮在窗口最上方，避免被右栏/滚动容器遮挡 */}
      {info
        ? createPortal(
            <div className="source-list__info-popover" style={{ top: info.bottom + 6, left: info.left, transform: 'translateX(-50%)' }}>
              {info.key === 'import' ? zhCN.sourceList.infoImport : info.key === 'summarize' ? zhCN.sourceList.infoSummarize : zhCN.sourceList.infoReconcile}
            </div>,
            document.body
          )
        : null}
      {workspaceDir ? (
        <p className="source-list__workspace" title={workspaceDir}>{zhCN.sourceList.workspaceStatus.replace('{dir}', workspaceDir)}</p>
      ) : (
        <p className="source-list__workspace source-list__workspace--empty">{zhCN.sourceList.workspaceUnset}</p>
      )}
      {syncProgress && syncProgress.total > 0 ? (
        <div className="source-list__sync-progress">
          {(syncProgress.newFiles ?? 0) > 0 && syncProgress.done < syncProgress.total ? (
            <p className="source-list__preprocess-hint">{zhCN.sourceList.preprocessHint}</p>
          ) : null}
          <div className="source-list__sync-bar">
            <div className="source-list__sync-bar-fill" style={{ width: `${Math.round((syncProgress.done / syncProgress.total) * 100)}%` }} />
          </div>
          <span className="source-list__sync-text">
            {zhCN.sourceList.syncingProgress.replace('{done}', String(syncProgress.done)).replace('{total}', String(syncProgress.total))}
          </span>
        </div>
      ) : null}
      {reconcileMsg ? <p className="source-list__msg">{reconcileMsg}</p> : null}
      {summarizeMsg ? <p className="source-list__msg">{summarizeMsg}</p> : null}
      <div className="source-list__url-bar">
        <input type="url" className="source-list__url-input" placeholder="输入网页网址按回车添加..." value={urlInput} onChange={(e) => setUrlInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleAddUrl() }} />
        <button type="button" className="source-list__btn source-list__btn--primary" onClick={handleAddUrl} disabled={urlAdding || !urlInput.trim()}>{urlAdding ? '抓取中...' : '添加'}</button>
      </div>
      {/* 网页资料库（2026-08-11）：注册站点后生成初稿时自动检索相关文章 */}
      <WebSourcePanel />
      {importErr ? <p className="source-list__error">{importErr}</p> : null}
      {deleteErr ? <p className="source-list__error">{deleteErr}</p> : null}
      {tagFilters.length > 0 ? (
        <div className="source-list__tag-bar">
          <button type="button" className={`source-list__tag-chip ${!activeTagId ? 'source-list__tag-chip--active' : ''}`} onClick={() => setActiveTagId(null)}>全部</button>
          {tagFilters.map((t) => (
            <button key={t.id} type="button" className={`source-list__tag-chip ${activeTagId === t.id ? 'source-list__tag-chip--active' : ''}`}
              onClick={() => setActiveTagId(activeTagId === t.id ? null : t.id)}>{t.name}</button>
          ))}
        </div>
      ) : null}

      {bulkMode ? (
        <div className="source-list__bulk-bar">
          <button type="button" className="source-list__btn" onClick={handleToggleAll} disabled={sources.length === 0}>
            {allSelected ? zhCN.sourceBulk.deselectAll : zhCN.sourceBulk.selectAll}
          </button>
          <span className="source-list__bulk-count">{zhCN.sourceBulk.selectedCount.replace('{count}', String(selectedIds.size))}</span>
          <button type="button" className="source-list__btn source-list__btn--danger" onClick={() => { const ids = Array.from(selectedIds); if (ids.length > 0) setPendingDelete({ kind: 'bulk', ids }) }} disabled={selectedIds.size === 0}>
            {zhCN.sourceBulk.deleteSelected}
          </button>
          <button type="button" className="source-list__btn" onClick={() => { setSelectedIds(new Set()); onExitBulk() }}>{zhCN.sourceBulk.exit}</button>
        </div>
      ) : null}

      {loading ? <p className="source-list__status">加载中...</p> : sources.length === 0 ? (
        <div className="empty-state"><p className="empty-state__hint">{bulkMode ? zhCN.sourceBulk.empty : '暂无资料。导入文件或输入网址添加信源。'}</p></div>
      ) : (
        <ul className="source-list__items">
          {sources.map((s) => {
            const cleanTitle = s.title
            const isSelected = selectedIds.has(s.id)
            return (
              <li
                key={s.id}
                className={`source-list__item${bulkMode ? ' source-list__item--bulk' : ''}`}
                onClick={() => (bulkMode ? toggleSelect(s.id) : onSelect(s.id))}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (!bulkMode) setContextMenu({ x: e.clientX, y: e.clientY, sourceId: s.id, title: cleanTitle })
                }}
              >
                {bulkMode ? (
                  <span className={`source-list__checkbox${isSelected ? ' source-list__checkbox--checked' : ''}`} aria-hidden="true" />
                ) : null}
                <span className="source-list__item-title">{cleanTitle}</span>
                <span className={`source-list__item-badge source-list__item-badge--${s.status}`}>
                  {s.status === 'ready' ? '已就绪' : s.status === 'failed' ? '失败' : s.status === 'pending' ? '排队中' : '处理中'}
                </span>
                <span className="source-list__item-kind">{s.kind === 'file' ? '文件' : '网址'}</span>
              </li>
            )
          })}
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
            onClick={() => setPendingDelete({ kind: 'one', id: contextMenu.sourceId, title: contextMenu.title })}
          >
            {zhCN.sourceContext.delete}
          </button>
        </div>
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title={pendingDelete.kind === 'one' ? zhCN.sourceContext.deleteTitle : zhCN.sourceBulk.deleteTitle}
          message={
            pendingDelete.kind === 'one'
              ? zhCN.sourceContext.confirmDelete.replace('{title}', pendingDelete.title)
              : zhCN.sourceBulk.confirmDelete.replace('{count}', String(pendingDelete.ids.length))
          }
          confirmText={pendingDelete.kind === 'one' ? zhCN.sourceContext.delete : zhCN.sourceBulk.deleteSelected}
          danger
          busy={deleting}
          onConfirm={pendingDelete.kind === 'one' ? handleDeleteOne : handleBulkDelete}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  )
}

export default SourceList
