import { useState, useEffect } from 'react'
import { zhCN } from '../i18n/zh-CN'

interface SourceItem { id: string; title: string }
interface TagItem { id: string; name: string }
interface TemplateItem { id: string; name: string }

function WritingCreateForm({ onCreated, onCancel }: {
  onCreated: (taskId: string) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [scopeType, setScopeType] = useState<'source' | 'tag'>('source')
  const [sources, setSources] = useState<SourceItem[] | null>(null)
  const [tags, setTags] = useState<TagItem[] | null>(null)
  const [templates, setTemplates] = useState<TemplateItem[] | null>(null)
  const [selSources, setSelSources] = useState<Set<string>>(new Set())
  const [selTags, setSelTags] = useState<Set<string>>(new Set())
  const [templateId, setTemplateId] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    window.api.listSources().then((res) => {
      if (res.ok && res.data) setSources(res.data.items as SourceItem[])
    })
    window.api.listTags().then((res) => {
      if (res.ok && res.data) setTags(res.data.items as TagItem[])
    })
    window.api.listTemplates().then((res) => {
      if (res.ok && res.data) setTemplates(res.data.items as TemplateItem[])
    })
  }, [])

  const toggleSource = (id: string) => {
    setSelSources((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleTag = (id: string) => {
    setSelTags((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSourcesSelected = (sources?.length ?? 0) > 0 && (sources ?? []).every((s) => selSources.has(s.id))
  const handleToggleAllSources = () => {
    if (!sources) return
    setSelSources(allSourcesSelected ? new Set() : new Set(sources.map((s) => s.id)))
  }

  const handleSubmit = async () => {
    if (busy) return
    const t = title.trim()
    if (!t) { setErr(zhCN.writingPage.createFailed.replace('{message}', '')); return }
    const hasScope = scopeType === 'source' ? selSources.size > 0 : selTags.size > 0
    if (!hasScope) { setErr(zhCN.writingPage.scopeRequired); return }

    setBusy(true)
    setErr(null)
    try {
      const scope = scopeType === 'source' ? { sourceIds: Array.from(selSources) } : { tagIds: Array.from(selTags) }
      const input: { title: string; scope: { sourceIds: string[] } | { tagIds: string[] }; templateBookId?: string } = { title: t, scope }
      if (templateId) input.templateBookId = templateId
      const res = await window.api.createTask(input)
      if (res.ok && res.data) {
        onCreated((res.data.task as { id: string }).id)
      } else {
        setErr(zhCN.writingPage.createFailed.replace('{message}', res.error?.message ?? ''))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="writing-form">
      <h3 className="writing-form__title">{zhCN.writingPage.createTitle}</h3>
      <p className="writing-form__hint">{zhCN.writingPage.createHint}</p>

      <label className="writing-form__field">
        <span className="writing-form__label">{zhCN.writingPage.fields.title}</span>
        <input
          className="writing-form__input"
          value={title}
          placeholder={zhCN.writingPage.fields.titlePlaceholder}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <div className="writing-form__field">
        <span className="writing-form__label">{zhCN.writingPage.fields.scope}</span>
        <div className="writing-form__scope-type">
          <button
            type="button"
            className={`writing-form__scope-btn${scopeType === 'source' ? ' is-active' : ''}`}
            onClick={() => setScopeType('source')}
          >
            {zhCN.writingPage.fields.scopeSource}
          </button>
          <button
            type="button"
            className={`writing-form__scope-btn${scopeType === 'tag' ? ' is-active' : ''}`}
            onClick={() => setScopeType('tag')}
          >
            {zhCN.writingPage.fields.scopeTag}
          </button>
        </div>

        {scopeType === 'source' ? (
          <div className="writing-form__picker">
            <div className="writing-form__picker-bar">
              <button type="button" className="source-list__btn" onClick={handleToggleAllSources} disabled={!sources || sources.length === 0}>
                {allSourcesSelected ? zhCN.writingPage.fields.deselectAll : zhCN.writingPage.fields.selectAll}
              </button>
              <span className="writing-form__picker-count">
                {zhCN.writingPage.fields.sourceSelected.replace('{count}', String(selSources.size))}
              </span>
            </div>
            {sources === null ? (
              <p className="writing-form__hint">{zhCN.writingTasks.loading}</p>
            ) : sources.length === 0 ? (
              <p className="writing-form__hint">{zhCN.writingPage.loadSourcesFailed.replace('{message}', '暂无资料')}</p>
            ) : (
              <ul className="writing-form__source-list">
                {sources.map((s) => (
                  <li
                    key={s.id}
                    className={`writing-form__source-item${selSources.has(s.id) ? ' is-checked' : ''}`}
                    onClick={() => toggleSource(s.id)}
                  >
                    <span className="writing-form__checkbox" aria-hidden="true" />
                    <span className="writing-form__source-title">{s.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="writing-form__picker">
            <div className="writing-form__picker-bar">
              <span className="writing-form__picker-count">
                {zhCN.writingPage.fields.tagSelected.replace('{count}', String(selTags.size))}
              </span>
            </div>
            {tags === null ? (
              <p className="writing-form__hint">{zhCN.writingTasks.loading}</p>
            ) : tags.length === 0 ? (
              <p className="writing-form__hint">{zhCN.writingPage.loadTagsFailed.replace('{message}', '暂无标签')}</p>
            ) : (
              <div className="writing-form__tag-list">
                {tags.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`writing-form__tag-chip${selTags.has(t.id) ? ' is-selected' : ''}`}
                    onClick={() => toggleTag(t.id)}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <label className="writing-form__field">
        <span className="writing-form__label">{zhCN.writingPage.fields.template}</span>
        <select
          className="writing-form__input writing-form__select"
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          <option value="">{zhCN.writingPage.fields.templateNone}</option>
          {(templates ?? []).map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </label>

      {err ? <p className="writing-form__error">{err}</p> : null}

      <div className="writing-form__actions">
        <button type="button" className="source-list__btn source-list__btn--primary" onClick={handleSubmit} disabled={busy}>
          {zhCN.writingPage.submitBtn}
        </button>
        <button type="button" className="source-list__btn" onClick={onCancel}>
          {zhCN.writingPage.cancelBtn}
        </button>
      </div>
    </div>
  )
}

export default WritingCreateForm
