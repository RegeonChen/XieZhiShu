export type PageKey = 'sources' | 'writing' | 'versions' | 'templates' | 'settings'

interface SideNavProps {
  current: PageKey
  items: { key: PageKey; label: string }[]
  onSelect: (key: PageKey) => void
  style?: React.CSSProperties
}

export default function SideNav({ current, items, onSelect, style }: SideNavProps) {
  return (
    <nav className="side-nav" style={style}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`side-nav__item${current === item.key ? ' side-nav__item--active' : ''}`}
          onClick={() => onSelect(item.key)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}
