import { zhCN } from '../i18n/zh-CN'

interface TopBarProps {
  pageTitle: string
  appInfo: { version: string; platform: string } | null
}

export default function TopBar({ pageTitle, appInfo }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar__left">
        <span className="topbar__app-title">{zhCN.appTitle}</span>
        <span className="topbar__divider" />
        <span className="topbar__page-title">{pageTitle}</span>
      </div>
      <div className="topbar__right">
        {appInfo ? (
          <span className="topbar__meta">
            {zhCN.topbar.version} {appInfo.version} · {zhCN.topbar.platform} {appInfo.platform}
          </span>
        ) : (
          <span className="topbar__meta">--</span>
        )}
      </div>
    </header>
  )
}
