import { useEffect, useState, useCallback } from 'react'
import TopBar from './components/TopBar'
import SideNav, { type PageKey } from './components/SideNav'
import EmptyState from './components/EmptyState'
import SourceList from './components/SourceList'
import TagManager from './components/TagManager'
import SourceViewer from './components/SourceViewer'
import TemplateManager from './components/TemplateManager'
import Settings from './components/Settings'
import WritingTaskList from './components/WritingTaskList'
import WritingCreateForm from './components/WritingCreateForm'
import WritingWorkspace from './components/WritingWorkspace'
import ResizeHandle from './components/ResizeHandle'
import ErrorBoundary from './components/ErrorBoundary'
import { zhCN } from './i18n/zh-CN'

interface AppInfo { version: string; platform: string }

const NAV_ITEMS: { key: PageKey; label: string }[] = [
  { key: 'sources', label: zhCN.nav.sources },
  { key: 'writing', label: zhCN.nav.writing },
  { key: 'versions', label: zhCN.nav.versions },
  { key: 'templates', label: zhCN.nav.templates },
  { key: 'settings', label: zhCN.nav.settings }
]

const MIN_SIDEBAR = 140
const MIN_CENTER = 200
const DEFAULT_SIDEBAR = 180
const DEFAULT_CENTER = 300

// 三栏宽度持久化键（localStorage，重启后保持一致）
const LS_SIDEBAR_W = 'ui.sidebarWidth'
const LS_CENTER_W = 'ui.centerWidth'

function readLayout(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : fallback
  } catch {
    return fallback
  }
}

export default function App() {
  const [page, setPage] = useState<PageKey>('sources')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [showTagManager, setShowTagManager] = useState(false)
  const [bulkMode, setBulkMode] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sourcesVersion, setSourcesVersion] = useState(0)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [showWritingCreate, setShowWritingCreate] = useState(false)
  const [writingReload, setWritingReload] = useState(0)
  const [sidebarW, setSidebarW] = useState(() => readLayout(LS_SIDEBAR_W, DEFAULT_SIDEBAR))
  const [centerW, setCenterW] = useState(() => readLayout(LS_CENTER_W, DEFAULT_CENTER))

  // 三栏宽度变化时持久化（下次启动恢复）
  useEffect(() => {
    try { localStorage.setItem(LS_SIDEBAR_W, String(sidebarW)) } catch { /* 忽略 */ }
  }, [sidebarW])
  useEffect(() => {
    try { localStorage.setItem(LS_CENTER_W, String(centerW)) } catch { /* 忽略 */ }
  }, [centerW])

  useEffect(() => {
    let cancelled = false
    window.api.getAppInfo().then((res) => {
      if (!cancelled && res.ok && res.data) setAppInfo(res.data)
    }).catch(() => { if (!cancelled) setAppInfo(null) })
    return () => { cancelled = true }
  }, [])

  const pageTitle = NAV_ITEMS.find((item) => item.key === page)?.label ?? ''

  // 功能菜单：点击外部关闭
  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  // 资料被删除后清理选中状态
  const handleSourcesChanged = useCallback((deletedIds: string[]) => {
    setSelectedSourceId((cur) => (cur && deletedIds.includes(cur) ? null : cur))
  }, [])

  const handleResizeSidebar = useCallback((delta: number) => {
    setSidebarW((w) => Math.max(MIN_SIDEBAR, Math.min(w + delta, 400)))
  }, [])

  const handleResizeCenter = useCallback((delta: number) => {
    setCenterW((w) => Math.max(MIN_CENTER, Math.min(w + delta, 600)))
  }, [])

  const renderCenterPane = () => {
    switch (page) {
      case 'sources':
        return (
          <section className="center-pane" style={{ width: centerW, flexShrink: 0 }}>
            <div className="center-pane__header">
              <h3 className="center-pane__title">{zhCN.panes.sources.listTitle}</h3>
              <div className="center-pane__menu">
                <button
                  type="button"
                  className="center-pane__menu-btn"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o) }}
                  title={zhCN.sourceMenu.tooltip}
                >
                  &#8943;
                </button>
                {menuOpen ? (
                  <div className="center-pane__menu-dropdown" onMouseDown={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="center-pane__menu-item"
                      onClick={() => { setBulkMode(true); setMenuOpen(false) }}
                    >
                      {zhCN.sourceMenu.manage}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            <SourceList
              onSelect={(id) => { setSelectedSourceId(id); setShowTagManager(false) }}
              onTagManage={() => { setShowTagManager(true); setSelectedSourceId(null); setBulkMode(false) }}
              bulkMode={bulkMode}
              onExitBulk={() => setBulkMode(false)}
              onSourcesChanged={handleSourcesChanged}
              reloadKey={sourcesVersion}
            />
          </section>
        )
      case 'writing':
        return (
          <section className="center-pane" style={{ width: centerW, flexShrink: 0 }}>
            <div className="center-pane__header">
              <h3 className="center-pane__title">{zhCN.panes.writing.listTitle}</h3>
              <button
                type="button"
                className="source-list__btn source-list__btn--primary"
                onClick={() => { setSelectedTaskId(null); setShowWritingCreate(true) }}
              >
                {zhCN.writingTasks.newBtn}
              </button>
            </div>
            <WritingTaskList
              selectedId={selectedTaskId}
              onSelect={(id) => { setSelectedTaskId(id); setShowWritingCreate(false) }}
              reloadKey={writingReload}
            />
          </section>
        )
      default:
        return (
          <section className="center-pane" style={{ width: centerW, flexShrink: 0 }}>
            <h3 className="center-pane__title">{zhCN.panes[page].listTitle}</h3>
            <p className="center-pane__empty">{zhCN.panes[page].listEmpty}</p>
          </section>
        )
    }
  }

  const renderWorkPane = () => {
    switch (page) {
      case 'sources':
        return (
          <main className="work-pane">
            <ErrorBoundary>
              {showTagManager ? (
                <TagManager onTagsChanged={() => setSourcesVersion((v) => v + 1)} />
              ) : selectedSourceId ? (
                <SourceViewer
                  sourceId={selectedSourceId}
                  onBack={() => setSelectedSourceId(null)}
                />
              ) : (
                <EmptyState title="资料详情" hint="点击左侧资料浏览内容，或点击「标签管理」管理标签。" />
              )}
            </ErrorBoundary>
          </main>
        )
      case 'writing':
        return (
          <main className="work-pane">
            <ErrorBoundary>
              {showWritingCreate ? (
                <WritingCreateForm
                  onCreated={(taskId) => { setSelectedTaskId(taskId); setShowWritingCreate(false); setWritingReload((v) => v + 1) }}
                  onCancel={() => setShowWritingCreate(false)}
                />
              ) : selectedTaskId ? (
                <WritingWorkspace
                  taskId={selectedTaskId}
                  onChanged={() => setWritingReload((v) => v + 1)}
                />
              ) : (
                <EmptyState title={zhCN.panes.writing.detailTitle} hint={zhCN.panes.writing.detailHint} />
              )}
            </ErrorBoundary>
          </main>
        )
      case 'templates':
        return (
          <main className="work-pane">
            <TemplateManager />
          </main>
        )
      case 'settings':
        return (
          <main className="work-pane">
            <Settings />
          </main>
        )
      default:
        return (
          <main className="work-pane">
            <EmptyState title={zhCN.panes[page].detailTitle} hint={zhCN.panes[page].detailHint} />
          </main>
        )
    }
  }

  return (
    <div className="app-shell">
      <TopBar pageTitle={pageTitle} appInfo={appInfo} />
      <div className="app-body">
        <SideNav current={page} items={NAV_ITEMS} onSelect={setPage} style={{ width: sidebarW, flexShrink: 0 }} />
        <ResizeHandle onResize={handleResizeSidebar} />
        {renderCenterPane()}
        <ResizeHandle onResize={handleResizeCenter} />
        {renderWorkPane()}
      </div>
    </div>
  )
}
