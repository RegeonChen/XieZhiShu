import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import TopBar from './components/TopBar'
import SideNav, { type PageKey } from './components/SideNav'
import EmptyState from './components/EmptyState'
import SourceList from './components/SourceList'
import TagManager from './components/TagManager'
import SourceViewer from './components/SourceViewer'
import Settings from './components/Settings'
import SectionNav, { type SectionNavItem } from './components/SectionNav'
import WritingTaskList from './components/WritingTaskList'
import WritingEmptyState from './components/WritingEmptyState'
import WritingWorkspace from './components/WritingWorkspace'
import ResizeHandle from './components/ResizeHandle'
import ErrorBoundary from './components/ErrorBoundary'
import OnboardingOverlay from './components/OnboardingOverlay/OnboardingOverlay'
import TextContextMenu from './components/TextContextMenu'
import ConfirmDialog from './components/ConfirmDialog'
import { DEMO_TASK_TITLE } from '../../shared/demo'
import { zhCN } from './i18n/zh-CN'

interface AppInfo { version: string; platform: string }

const NAV_ITEMS: { key: PageKey; label: string }[] = [
  { key: 'sources', label: zhCN.nav.sources },
  { key: 'writing', label: zhCN.nav.writing },
  { key: 'settings', label: zhCN.nav.settings }
]

/** 中栏区块导航的小图标 */
function navIcon(paths: string[]): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

const SETTINGS_SECTIONS: SectionNavItem[] = [
  {
    id: 'overview',
    label: zhCN.settingsPage.nav.overview,
    icon: navIcon(['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'])
  },
  { id: 'appearance', label: zhCN.settingsPage.nav.appearance, icon: navIcon(['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 3a9 9 0 0 1 0 18', 'M3 12h18']) },
  { id: 'workspace', label: zhCN.settingsPage.nav.workspace, icon: navIcon(['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z']) },
  { id: 'preset', label: zhCN.settingsPage.nav.preset, icon: navIcon(['M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8L12 2z']) },
  { id: 'stepModels', label: zhCN.settingsPage.nav.stepModels, icon: navIcon(['M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8L12 2z']) },
  { id: 'provider', label: zhCN.settingsPage.nav.provider, icon: navIcon(['M8 9l-4 4 4 4', 'M16 9l4 4-4 4', 'M13 5l-2 14']) }
]


const MIN_SIDEBAR = 64
const MIN_CENTER = 200
const DEFAULT_SIDEBAR = 76
const DEFAULT_CENTER = 300

// 三栏宽度持久化键（localStorage，重启后保持一致）
// V2：左栏改为图标导航后默认宽度收窄，换键以覆盖旧版存储的 180px 宽度
const LS_SIDEBAR_W = 'ui.sidebarWidthV2'
const LS_CENTER_W = 'ui.centerWidth'
// 中栏显隐持久化键
const LS_CENTER_VISIBLE = 'ui.centerVisible'
// 新手引导完成标记（首次启动无标记时自动展示，可从设置页重新打开）
const LS_ONBOARDING_DONE = 'ui.onboardingDone'
const LS_THEME = 'ui.theme'

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
  // 工作区来源移除确认（2026-08-28）：文件被删除且已被资料汇编引用时，弹框决定是否清理该来源的卡片
  const [sourceRemoval, setSourceRemoval] = useState<{ sourceId: string; title: string; cardCount: number; contradictionCount: number; repairCount: number; origin: 'workspace' | 'manual' } | null>(null)
  const sourceRemovalQueueRef = useRef<{ sourceId: string; title: string; cardCount: number; contradictionCount: number; repairCount: number; origin: 'workspace' | 'manual' }[]>([])
  // 已登记（排队或正在展示）的来源 id，避免同一来源被多次登记/对账重复弹框（2026-08-28）
  const enqueuedSourceRemovalIdsRef = useRef<Set<string>>(new Set())
  // 当前正在展示的确认框（同步镜像 sourceRemoval 状态）；当前项不放入队列，避免确认后又被 shift 回来重复弹框
  const sourceRemovalRef = useRef<{ sourceId: string; title: string; cardCount: number; contradictionCount: number; repairCount: number; origin: 'workspace' | 'manual' } | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [writingReload, setWritingReload] = useState(0)
  // 来源移除确认完毕后，让常驻的撰写工作台重新加载（否则已删除的来源卡片会以空白来源形式残留在界面状态里）
  const [sourceRemovalReloadKey, setSourceRemovalReloadKey] = useState(0)
  /** 撰写任务总数（用于右栏空状态判断；null = 尚未加载） */
  const [writingTaskCount, setWritingTaskCount] = useState<number | null>(null)
  const [sidebarW, setSidebarW] = useState(() => readLayout(LS_SIDEBAR_W, DEFAULT_SIDEBAR))
  const [centerW, setCenterW] = useState(() => readLayout(LS_CENTER_W, DEFAULT_CENTER))
  // 中栏显隐（默认显示；顶栏按钮切换，持久化）
  const [centerVisible, setCenterVisible] = useState(() => {
    try { return localStorage.getItem(LS_CENTER_VISIBLE) !== '0' } catch { return true }
  })
  // 新手引导（首次启动自动展示；完成后写入 localStorage，设置页可重新打开）
  const [onboardingOpen, setOnboardingOpen] = useState(() => {
    try { return localStorage.getItem(LS_ONBOARDING_DONE) !== '1' } catch { return true }
  })
  /** 设置页中栏导航当前激活的区块（scroll-spy 由 Settings 上报） */
  const [settingsActive, setSettingsActive] = useState<string | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark' | 'classic'>(() => {
    try {
      const v = localStorage.getItem(LS_THEME)
      return v === 'dark' || v === 'classic' ? v : 'light'
    } catch {
      return 'light'
    }
  })

  /** 区块导航跳转：平滑滚动到对应区块并即时高亮 */
  const handleSettingsNavigate = useCallback((id: string) => {
    setSettingsActive(id)
    document.getElementById('settings-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // 三栏宽度变化时持久化（下次启动恢复）
  useEffect(() => {
    try { localStorage.setItem(LS_SIDEBAR_W, String(sidebarW)) } catch { /* 忽略 */ }
  }, [sidebarW])
  useEffect(() => {
    try { localStorage.setItem(LS_CENTER_W, String(centerW)) } catch { /* 忽略 */ }
  }, [centerW])
  useEffect(() => {
    try { localStorage.setItem(LS_CENTER_VISIBLE, centerVisible ? '1' : '0') } catch { /* 忽略 */ }
  }, [centerVisible])
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem(LS_THEME, theme) } catch { /* ignore */ }
  }, [theme])

  useEffect(() => {
    let cancelled = false
    window.api.getAppInfo().then((res) => {
      if (!cancelled && res.ok && res.data) setAppInfo(res.data)
    }).catch(() => { if (!cancelled) setAppInfo(null) })
    return () => { cancelled = true }
  }, [])

  const pageTitle = NAV_ITEMS.find((item) => item.key === page)?.label ?? ''

  // 每次进入"资料库"功能区时自动触发一次工作区同步（Task 2.2.5，效果等同手动"同步工作区"）
  useEffect(() => {
    if (page === 'sources') {
      window.api.workspaceNavSync?.().catch(() => { /* 忽略失败，全量对账本身有兜底 */ })
    }
  }, [page])

  // 进入"撰写"功能区时加载任务数（用于右栏空状态判断；任务增删/改名后随 writingReload 刷新）
  useEffect(() => {
    if (page !== 'writing') return
    window.api.listTasks().then((res) => {
      setWritingTaskCount(res.ok && res.data ? (res.data.items as unknown[]).length : 0)
    }).catch(() => setWritingTaskCount(0))
  }, [page, writingReload])

  // Phase 3.5：点击"新建任务"立即创建（标题默认"新建任务"、范围=全部文件）并进入该任务工作台
  const handleCreateTask = async () => {
    const res = await window.api.createTask()
    if (res.ok && res.data) {
      setSelectedTaskId((res.data.task as { id: string }).id)
      setWritingReload((v) => v + 1)
    }
  }

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

  // 工作区来源移除确认（2026-08-28）：登记待确认、依次弹框；决定后刷新资料库列表
  const showSourceRemoval = useCallback((item: { sourceId: string; title: string; cardCount: number; contradictionCount: number; repairCount: number; origin: 'workspace' | 'manual' }) => {
    sourceRemovalRef.current = item
    setSourceRemoval(item)
  }, [])
  const handleDecideSourceRemoval = useCallback(async (sourceId: string, action: 'delete' | 'keep') => {
    sourceRemovalRef.current = null
    setSourceRemoval(null)
    try {
      await window.api.decideSourceRemoval(sourceId, action)
    } catch {
      /* 忽略：来源记录已由主进程清理，此处仅刷新列表 */
    }
    setSourcesVersion((v) => v + 1)
    setSourceRemovalReloadKey((v) => v + 1)
    enqueuedSourceRemovalIdsRef.current.delete(sourceId)
    const next = sourceRemovalQueueRef.current.shift()
    if (next) showSourceRemoval(next)
  }, [showSourceRemoval])
  const enqueueSourceRemoval = useCallback((item: { sourceId: string; title: string; cardCount: number; contradictionCount: number; repairCount: number; origin: 'workspace' | 'manual' }) => {
    // 对同一来源去重：主进程可能因手动删除 + 工作区对账等多条路径重复登记，避免弹出多个相同确认框
    if (enqueuedSourceRemovalIdsRef.current.has(item.sourceId)) return
    enqueuedSourceRemovalIdsRef.current.add(item.sourceId)
    // 当前无确认框则直接展示（不入队）；已有其它确认框则排队，避免当前项被 shift 回来重复弹框
    if (!sourceRemovalRef.current) {
      showSourceRemoval(item)
    } else {
      sourceRemovalQueueRef.current.push(item)
    }
  }, [showSourceRemoval])
  useEffect(() => {
    window.api.listSourceRemovals().then((res) => {
      if (res.ok && res.data) for (const it of res.data.items) enqueueSourceRemoval(it)
    }).catch(() => {})
    const off = window.api.onSourceRemoved((item) => enqueueSourceRemoval(item))
    return () => { off() }
  }, [enqueueSourceRemoval])

  // 新手引导：结束/跳过时写入完成标记并关闭
  const handleOnboardingDismiss = useCallback((_reason: 'completed' | 'skipped') => {
    setOnboardingOpen(false)
    try { localStorage.setItem(LS_ONBOARDING_DONE, '1') } catch { /* 忽略 */ }
  }, [])

  // 新手引导：步骤切换时联动切换功能区页面，使目标元素渲染出来
  const handleOnboardingStepChange = useCallback((page: string) => {
    setPage(page as PageKey)
    // 引导切到「撰写」页时自动打开演示任务，使三步工作台与顶部步骤条可见
    if (page === 'writing') {
      window.api.listTasks().then((res) => {
        if (!(res.ok && res.data)) return
        const items = (res.data.items as { id: string; title: string }[])
        const demo = items.find((t) => t.title === DEMO_TASK_TITLE)
        const target = demo ?? items[0]
        if (target) {
          setSelectedTaskId(target.id)
          setWritingReload((v) => v + 1)
        }
      }).catch(() => { /* 忽略 */ })
    }
  }, [])

  const renderCenterPane = () => {
    switch (page) {
      case 'sources':
        return (
          <section className="center-pane" data-onboarding="sources-library" style={{ width: centerW, flexShrink: 0 }}>
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
                      onClick={() => { setShowTagManager(true); setSelectedSourceId(null); setBulkMode(false); setMenuOpen(false) }}
                    >
                      {zhCN.sourceMenu.tagManage}
                    </button>
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
              activeId={selectedSourceId}
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
                data-onboarding="writing-new-task"
                onClick={() => void handleCreateTask()}
              >
                {zhCN.writingTasks.newBtn}
              </button>
            </div>
            <WritingTaskList
              selectedId={selectedTaskId}
              onSelect={setSelectedTaskId}
              reloadKey={writingReload}
            />
          </section>
        )
      case 'settings':
        return (
          <section className="center-pane" style={{ width: centerW, flexShrink: 0 }}>
            <div className="center-pane__header">
              <h3 className="center-pane__title">{zhCN.settingsPage.nav.title}</h3>
            </div>
            <SectionNav
              hint={zhCN.settingsPage.nav.hint}
              items={SETTINGS_SECTIONS}
              activeId={settingsActive}
              onNavigate={handleSettingsNavigate}
            />
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
                  key={selectedSourceId}
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
        // 撰写工作台改为常驻挂载（见 app-body 中的常驻容器），此处不渲染，避免切换页面时卸载丢失对话/进度状态
        return null
      case 'settings':
        return (
          <main className="work-pane">
            <Settings onOpenOnboarding={() => setOnboardingOpen(true)} onActiveChange={(id) => setSettingsActive(id)} theme={theme} onThemeChange={setTheme} />
          </main>
        )
    }
  }

  return (
    <div className="app-shell">
      <TopBar
        pageTitle={pageTitle}
        appInfo={appInfo}
        centerVisible={centerVisible}
        onToggleCenter={() => setCenterVisible((v) => !v)}
      />
      <div className="app-body">
        <SideNav current={page} items={NAV_ITEMS} onSelect={setPage} style={{ width: sidebarW, flexShrink: 0 }} />
        <ResizeHandle onResize={handleResizeSidebar} />
        {centerVisible ? (
          <>
            {renderCenterPane()}
            <ResizeHandle onResize={handleResizeCenter} />
          </>
        ) : null}
        {renderWorkPane()}
        {/* 撰写工作台常驻挂载：切换页面仅隐藏不卸载，保留进行中的对话记录与生成进度（2026-08-14） */}
        <main className="work-pane work-pane--writing" style={{ display: page === 'writing' ? undefined : 'none' }}>
          <ErrorBoundary>
            {selectedTaskId ? (
              <WritingWorkspace
                key={selectedTaskId}
                taskId={selectedTaskId}
                onChanged={() => setWritingReload((v) => v + 1)}
                reloadKey={sourceRemovalReloadKey}
              />
            ) : writingTaskCount === 0 ? (
              <WritingEmptyState
                onCreated={(id) => { setSelectedTaskId(id); setWritingReload((v) => v + 1) }}
              />
            ) : (
              <EmptyState title={zhCN.panes.writing.detailTitle} hint={zhCN.panes.writing.detailHint} />
            )}
          </ErrorBoundary>
        </main>
      </div>
      {sourceRemoval ? (
        <ConfirmDialog
          title={zhCN.sourceRemoval.title}
          message={
            (sourceRemoval.origin === 'manual' ? zhCN.sourceRemoval.messageManual : zhCN.sourceRemoval.messageWorkspace)
              .replace('{title}', sourceRemoval.title)
              .replace('{summary}', [
                `${sourceRemoval.cardCount} 张卡片`,
                sourceRemoval.contradictionCount > 0 ? `${sourceRemoval.contradictionCount} 组矛盾` : null,
                sourceRemoval.repairCount > 0 ? `${sourceRemoval.repairCount} 条二次改动` : null
              ].filter(Boolean).join('，'))
          }
          confirmText={zhCN.sourceRemoval.confirm}
          cancelText={zhCN.sourceRemoval.cancel}
          danger
          busy={false}
          onConfirm={() => void handleDecideSourceRemoval(sourceRemoval.sourceId, 'delete')}
          onCancel={() => void handleDecideSourceRemoval(sourceRemoval.sourceId, 'keep')}
        />
      ) : null}
      {/* 新手引导聚光覆盖层（首次启动自动展示，可从设置页重新打开） */}
      <OnboardingOverlay
        open={onboardingOpen}
        onDismiss={handleOnboardingDismiss}
        onStepChange={handleOnboardingStepChange}
      />
      {/* 全局文本右键菜单（2026-08-20）：input/textarea/contenteditable 的复制/剪切/粘贴/全选 */}
      <TextContextMenu />
    </div>
  )
}
