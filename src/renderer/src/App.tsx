import { useEffect, useState } from 'react'
import TopBar from './components/TopBar'
import SideNav, { type PageKey } from './components/SideNav'
import EmptyState from './components/EmptyState'
import SourceList from './components/SourceList'
import TagManager from './components/TagManager'
import TemplateManager from './components/TemplateManager'
import { zhCN } from './i18n/zh-CN'

interface AppInfo {
  version: string
  platform: string
}

const NAV_ITEMS: { key: PageKey; label: string }[] = [
  { key: 'sources', label: zhCN.nav.sources },
  { key: 'writing', label: zhCN.nav.writing },
  { key: 'versions', label: zhCN.nav.versions },
  { key: 'settings', label: zhCN.nav.settings }
]

export default function App() {
  const [page, setPage] = useState<PageKey>('sources')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .getAppInfo()
      .then((res) => {
        if (!cancelled && res.ok && res.data) setAppInfo(res.data)
      })
      .catch(() => {
        if (!cancelled) setAppInfo(null)
      })
    return () => { cancelled = true }
  }, [])

  const pageTitle = NAV_ITEMS.find((item) => item.key === page)?.label ?? ''

  const renderCenterPane = () => {
    switch (page) {
      case 'sources':
        return (
          <section className="center-pane">
            <h3 className="center-pane__title">{zhCN.panes.sources.listTitle}</h3>
            <SourceList onSelect={(id) => setSelectedSourceId(id)} />
          </section>
        )
      default:
        return (
          <section className="center-pane">
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
            {selectedSourceId ? (
              <TagManager sourceId={selectedSourceId} sourceTags={[]} onTagsChange={() => {}} />
            ) : (
              <EmptyState title="资料详情" hint="点击左侧资料可查看详情与标签管理。" />
            )}
          </main>
        )
      case 'settings':
        return (
          <main className="work-pane">
            <TemplateManager />
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
        <SideNav current={page} items={NAV_ITEMS} onSelect={setPage} />
        {renderCenterPane()}
        {renderWorkPane()}
      </div>
    </div>
  )
}
