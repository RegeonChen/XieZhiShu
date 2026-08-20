import { useEffect, useState, useCallback, type ReactNode } from 'react'
import TopBar from './components/TopBar'
import SideNav, { type PageKey } from './components/SideNav'
import EmptyState from './components/EmptyState'
import SourceList from './components/SourceList'
import TagManager from './components/TagManager'
import SourceViewer from './components/SourceViewer'
import SkillsManager from './components/SkillsManager'
import Settings from './components/Settings'
import SectionNav, { type SectionNavItem } from './components/SectionNav'
import WritingTaskList from './components/WritingTaskList'
import WritingEmptyState from './components/WritingEmptyState'
import WritingWorkspace from './components/WritingWorkspace'
import ResizeHandle from './components/ResizeHandle'
import ErrorBoundary from './components/ErrorBoundary'
import OnboardingOverlay from './components/OnboardingOverlay/OnboardingOverlay'
import { zhCN } from './i18n/zh-CN'

interface AppInfo { version: string; platform: string }

const NAV_ITEMS: { key: PageKey; label: string }[] = [
  { key: 'sources', label: zhCN.nav.sources },
  { key: 'writing', label: zhCN.nav.writing },
  { key: 'templates', label: zhCN.nav.skills },
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
  { id: 'workspace', label: zhCN.settingsPage.nav.workspace, icon: navIcon(['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z']) },
  { id: 'preset', label: zhCN.settingsPage.nav.preset, icon: navIcon(['M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8L12 2z']) },
  { id: 'provider', label: zhCN.settingsPage.nav.provider, icon: navIcon(['M8 9l-4 4 4 4', 'M16 9l4 4-4 4', 'M13 5l-2 14']) }
]

const SKILLS_SECTIONS: SectionNavItem[] = [
  {
    id: 'overview',
    label: zhCN.skills.nav.overview,
    icon: navIcon(['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'])
  },
  { id: 'general', label: zhCN.skills.nav.general, icon: navIcon(['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z']) },
  { id: 'section', label: zhCN.skills.nav.section, icon: navIcon(['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01']) }
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
  const [writingReload, setWritingReload] = useState(0)
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
  /** 规范页中栏导航当前激活的区块（scroll-spy 由 SkillsManager 上报） */
  const [skillsActive, setSkillsActive] = useState<string | null>(null)

  /** 区块导航跳转：平滑滚动到对应区块并即时高亮 */
  const handleSettingsNavigate = useCallback((id: string) => {
    setSettingsActive(id)
    document.getElementById('settings-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])
  const handleSkillsNavigate = useCallback((id: string) => {
    setSkillsActive(id)
    document.getElementById('skills-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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

  // 新手引导：结束/跳过时写入完成标记并关闭
  const handleOnboardingDismiss = useCallback((_reason: 'completed' | 'skipped') => {
    setOnboardingOpen(false)
    try { localStorage.setItem(LS_ONBOARDING_DONE, '1') } catch { /* 忽略 */ }
  }, [])

  // 新手引导：步骤切换时联动切换功能区页面，使目标元素渲染出来
  const handleOnboardingStepChange = useCallback((page: string) => {
    setPage(page as PageKey)
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
      case 'templates':
        return (
          <section className="center-pane" style={{ width: centerW, flexShrink: 0 }}>
            <div className="center-pane__header">
              <h3 className="center-pane__title">{zhCN.skills.nav.title}</h3>
            </div>
            <SectionNav
              hint={zhCN.skills.nav.hint}
              items={SKILLS_SECTIONS}
              activeId={skillsActive}
              onNavigate={handleSkillsNavigate}
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
      case 'templates':
        return (
          <main className="work-pane">
            <SkillsManager onActiveChange={(id) => setSkillsActive(id)} />
          </main>
        )
      case 'settings':
        return (
          <main className="work-pane">
            <Settings onOpenOnboarding={() => setOnboardingOpen(true)} onActiveChange={(id) => setSettingsActive(id)} />
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
      {/* 新手引导聚光覆盖层（首次启动自动展示，可从设置页重新打开） */}
      <OnboardingOverlay
        open={onboardingOpen}
        onDismiss={handleOnboardingDismiss}
        onStepChange={handleOnboardingStepChange}
      />
    </div>
  )
}
