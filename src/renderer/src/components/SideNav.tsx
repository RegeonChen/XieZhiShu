import type { ReactNode } from 'react'

export type PageKey = 'sources' | 'compile' | 'draft' | 'templates' | 'settings'

/**
 * 导航项。`disabled` + `badge` 用于「尚未实现的功能区」（2026-10-09 用户裁定 A）：
 * 「撰写初稿」功能区当前不可用，界面上**置灰并标注「开发中」**，
 * 与 README 的功能边界声明（"目前仅实现到生成汇编功能区"）保持一致——
 * 界面能看到入口、但明确告知尚未实现，避免"文档说不存在、界面却能点进去"的自相矛盾。
 */
export interface SideNavItem {
  key: PageKey
  label: string
  disabled?: boolean
  /** 置灰项上的小徽标（如「开发中」） */
  badge?: string
  /** 置灰项的悬停说明（原生 title） */
  disabledHint?: string
}

interface SideNavProps {
  current: PageKey
  items: SideNavItem[]
  onSelect: (key: PageKey) => void
  /**
   * 顶部附加按钮（2026-10-04 用户要求）：
   * 在「资料库」上方插入一个**无文字**的「隐藏中栏」按钮，原来的三个功能区入口整体下移一格。
   */
  leading?: ReactNode
  /** 贴在导航栏**最下方**的入口（「设置」由用户要求移到这里） */
  bottomItems?: SideNavItem[]
  style?: React.CSSProperties
}

/** 各功能区的线性图标（stroke 风格，随文字颜色着色） */
const ICONS: Record<PageKey, ReactNode> = {
  sources: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  ),
  compile: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8L12 3z" />
    </svg>
  ),
  draft: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  ),
  templates: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  settings: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

export default function SideNav({ current, items, onSelect, leading, bottomItems, style }: SideNavProps) {
  const renderItem = (item: SideNavItem): ReactNode => (
    <button
      key={item.key}
      type="button"
      className={`side-nav__item${current === item.key ? ' side-nav__item--active' : ''}${item.disabled ? ' side-nav__item--disabled' : ''}`}
      onClick={() => {
        // 置灰项不可进入（同时也用原生 disabled 挡住点击，这里再兜一层）
        if (!item.disabled) onSelect(item.key)
      }}
      disabled={item.disabled === true}
      aria-disabled={item.disabled === true}
      title={item.disabled ? item.disabledHint : undefined}
      data-onboarding={item.disabled ? 'side-nav-disabled' : undefined}
    >
      <span className="side-nav__icon">{ICONS[item.key]}</span>
      <span className="side-nav__label">{item.label}</span>
      {item.badge ? <span className="side-nav__badge">{item.badge}</span> : null}
    </button>
  )

  return (
    <nav className="side-nav" style={style}>
      {leading}
      {items.map(renderItem)}
      {/* 弹性间隔：把 `bottomItems`（设置）压到导航栏最下方 */}
      <div className="side-nav__spacer" aria-hidden="true" />
      {bottomItems?.map(renderItem)}
    </nav>
  )
}
