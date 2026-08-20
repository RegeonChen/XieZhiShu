import type { ReactNode } from 'react'

export interface SectionNavItem {
  id: string
  label: string
  icon: ReactNode
}

interface SectionNavProps {
  /** 导航顶部说明文字 */
  hint: string
  /** 导航条目（顺序即页面区块顺序） */
  items: SectionNavItem[]
  /** 当前激活（滚动定位到）的区块 id */
  activeId: string | null
  /** 点击条目：平滑滚动到对应区块并高亮 */
  onNavigate: (id: string) => void
}

/**
 * 通用「区块导航」（2026-08-19）：供设置页 / 规范页中栏使用——
 * 点击条目平滑滚动到右栏对应区块，滚动定位（scroll-spy）由页面组件上报 activeId。
 */
function SectionNav({ hint, items, activeId, onNavigate }: SectionNavProps) {
  return (
    <div className="section-nav">
      <p className="section-nav__hint">{hint}</p>
      <ul className="section-nav__list">
        {items.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={`section-nav__item${activeId === s.id ? ' is-active' : ''}`}
              onClick={() => onNavigate(s.id)}
            >
              <span className="section-nav__icon">{s.icon}</span>
              <span>{s.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default SectionNav
