import { useEffect, useState } from 'react'
import TopBar from './components/TopBar'
import SideNav, { type PageKey } from './components/SideNav'
import EmptyState from './components/EmptyState'
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

const PAGE_PANES: Record<PageKey, { listTitle: string; listEmpty: string; detailTitle: string; detailHint: string }> = {
  sources: zhCN.panes.sources,
  writing: zhCN.panes.writing,
  versions: zhCN.panes.versions,
  settings: zhCN.panes.settings
}

export default function App() {
  const [page, setPage] = useState<PageKey>('sources')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .getAppInfo()
      .then((info) => {
        if (!cancelled) setAppInfo(info)
      })
      .catch(() => {
        if (!cancelled) setAppInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const panes = PAGE_PANES[page]
  const pageTitle = NAV_ITEMS.find((item) => item.key === page)?.label ?? ''

  return (
    <div className="app-shell">
      <TopBar pageTitle={pageTitle} appInfo={appInfo} />
      <div className="app-body">
        <SideNav current={page} items={NAV_ITEMS} onSelect={setPage} />
        <section className="center-pane">
          <h3 className="center-pane__title">{panes.listTitle}</h3>
          {panes.listEmpty ? <p className="center-pane__empty">{panes.listEmpty}</p> : null}
        </section>
        <main className="work-pane">
          <EmptyState title={panes.detailTitle} hint={panes.detailHint} />
        </main>
      </div>
    </div>
  )
}
