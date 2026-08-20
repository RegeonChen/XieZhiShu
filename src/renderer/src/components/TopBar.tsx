import { zhCN } from '../i18n/zh-CN'

interface TopBarProps {
  pageTitle: string
  appInfo: { version: string; platform: string } | null
  centerVisible: boolean
  onToggleCenter: () => void
}

export default function TopBar({ pageTitle, appInfo, centerVisible, onToggleCenter }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar__left">
        <span className="topbar__logo" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            <path d="M10 8l2.5 4L10 16" />
          </svg>
        </span>
        <span className="topbar__app-title">{zhCN.appTitle}</span>
        <span className="topbar__divider" />
        <span className="topbar__page-title">{pageTitle}</span>
      </div>
      <div className="topbar__right">
        <button
          type="button"
          className={`topbar__toggle-center${centerVisible ? ' is-visible' : ''}`}
          title={centerVisible ? zhCN.topbar.hideCenter : zhCN.topbar.showCenter}
          aria-label={centerVisible ? zhCN.topbar.hideCenter : zhCN.topbar.showCenter}
          onClick={onToggleCenter}
        >
          {/* 图标：左侧竖条 = 中栏，中间箭头指向右侧 = 展开/收起 */}
          {centerVisible ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="5" height="16" rx="1" />
              <path d="M14 9l3 3-3 3" />
              <path d="M21 9l-3 3 3 3" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="16" y="4" width="5" height="16" rx="1" />
              <path d="M10 9l-3 3 3 3" />
              <path d="M3 9l3 3-3 3" />
            </svg>
          )}
        </button>
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
