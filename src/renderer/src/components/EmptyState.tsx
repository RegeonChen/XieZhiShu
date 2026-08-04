interface EmptyStateProps {
  title: string
  hint?: string
}

export default function EmptyState({ title, hint }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <h2 className="empty-state__title">{title}</h2>
      {hint ? <p className="empty-state__hint">{hint}</p> : null}
    </div>
  )
}
