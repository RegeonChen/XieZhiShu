import { useState, useEffect, useCallback } from 'react'
import { zhCN } from '../i18n/zh-CN'

interface ProviderItem {
  id: string
  name: string
  apiBase: string
  model: string
  apiKeySet: boolean
}

interface AppSettingsShape {
  currentLlmProviderId?: string
}

interface ProviderForm {
  name: string
  apiBase: string
  model: string
  apiKey: string
}

const EMPTY_FORM: ProviderForm = { name: '', apiBase: '', model: '', apiKey: '' }

function Settings() {
  const [providers, setProviders] = useState<ProviderItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [currentId, setCurrentId] = useState<string | null>(null)

  const [editing, setEditing] = useState<ProviderItem | 'new' | null>(null)
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)

  const [testingId, setTestingId] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadErr(null)
    try {
      const [pRes, sRes] = await Promise.all([window.api.listProviders(), window.api.getSettings()])
      if (pRes.ok && pRes.data) {
        setProviders(pRes.data.items as ProviderItem[])
      } else {
        setLoadErr(zhCN.settingsPage.provider.loadFailed.replace('{message}', pRes.error?.message ?? ''))
      }
      if (sRes.ok && sRes.data) {
        setCurrentId((sRes.data as AppSettingsShape).currentLlmProviderId ?? null)
      }
    } catch {
      setLoadErr(zhCN.settingsPage.provider.loadFailed.replace('{message}', ''))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const startCreate = () => {
    setEditing('new')
    setForm(EMPTY_FORM)
    setFormErr(null)
    setTestMsg(null)
  }

  const startEdit = (p: ProviderItem) => {
    setEditing(p)
    setForm({ name: p.name, apiBase: p.apiBase, model: p.model, apiKey: '' })
    setFormErr(null)
    setTestMsg(null)
  }

  const cancelEdit = () => {
    setEditing(null)
    setFormErr(null)
  }

  const handleSave = async () => {
    if (!editing || saving) return
    setSaving(true)
    setFormErr(null)
    try {
      const input: { id?: string; name: string; apiBase: string; model: string; apiKey?: string } = {
        name: form.name.trim(),
        apiBase: form.apiBase.trim(),
        model: form.model.trim()
      }
      if (editing !== 'new') input.id = editing.id
      if (form.apiKey.trim()) input.apiKey = form.apiKey.trim()

      const res = await window.api.saveProvider(input)
      if (res.ok && res.data) {
        setEditing(null)
        await load()
      } else {
        setFormErr(zhCN.settingsPage.provider.saveFailed.replace('{message}', res.error?.message ?? ''))
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (p: ProviderItem) => {
    if (!confirm(zhCN.settingsPage.provider.deleteConfirm.replace('{name}', p.name))) return
    const res = await window.api.deleteProvider(p.id)
    if (res.ok) {
      if (currentId === p.id) setCurrentId(null)
      await load()
    } else {
      setActionErr(zhCN.settingsPage.provider.deleteFailed.replace('{message}', res.error?.message ?? ''))
    }
  }

  const handleTest = async (p: ProviderItem) => {
    setTestingId(p.id)
    setTestMsg(null)
    setActionErr(null)
    try {
      const res = await window.api.testProvider(p.id)
      setTestMsg(
        res.ok
          ? { id: p.id, ok: true, text: zhCN.settingsPage.provider.testSuccess }
          : { id: p.id, ok: false, text: zhCN.settingsPage.provider.testFailed.replace('{message}', res.error?.message ?? '') }
      )
    } finally {
      setTestingId(null)
    }
  }

  const handleSetCurrent = async (p: ProviderItem) => {
    const res = await window.api.updateSettings({ currentLlmProviderId: p.id })
    if (res.ok && res.data) {
      setCurrentId(p.id)
      setActionErr(null)
    } else {
      setActionErr(zhCN.settingsPage.provider.setCurrentFailed.replace('{message}', res.error?.message ?? ''))
    }
  }

  const setFormField = (field: keyof ProviderForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const isEditingExisting = editing !== null && editing !== 'new'

  return (
    <div className="settings">
      <h3 className="settings__title">{zhCN.settingsPage.title}</h3>
      <section className="settings__section">
        <div className="settings__section-header">
          <h4 className="settings__section-title">{zhCN.settingsPage.provider.title}</h4>
          <button type="button" className="source-list__btn source-list__btn--primary" onClick={startCreate}>
            {zhCN.settingsPage.provider.addBtn}
          </button>
        </div>
        <p className="settings__hint">{zhCN.settingsPage.provider.hint}</p>

        {editing ? (
          <div className="settings__form">
            <h5 className="settings__form-title">
              {isEditingExisting ? zhCN.settingsPage.provider.editTitle : zhCN.settingsPage.provider.createTitle}
            </h5>
            <label className="settings__field">
              <span className="settings__field-label">{zhCN.settingsPage.provider.fields.name}</span>
              <input
                className="settings__input"
                value={form.name}
                placeholder={zhCN.settingsPage.provider.fields.namePlaceholder}
                onChange={(e) => setFormField('name', e.target.value)}
              />
            </label>
            <label className="settings__field">
              <span className="settings__field-label">{zhCN.settingsPage.provider.fields.apiBase}</span>
              <input
                className="settings__input"
                value={form.apiBase}
                placeholder={zhCN.settingsPage.provider.fields.apiBasePlaceholder}
                onChange={(e) => setFormField('apiBase', e.target.value)}
              />
            </label>
            <label className="settings__field">
              <span className="settings__field-label">{zhCN.settingsPage.provider.fields.model}</span>
              <input
                className="settings__input"
                value={form.model}
                placeholder={zhCN.settingsPage.provider.fields.modelPlaceholder}
                onChange={(e) => setFormField('model', e.target.value)}
              />
            </label>
            <label className="settings__field">
              <span className="settings__field-label">{zhCN.settingsPage.provider.fields.apiKey}</span>
              <input
                className="settings__input"
                type="password"
                autoComplete="off"
                value={form.apiKey}
                placeholder={isEditingExisting ? zhCN.settingsPage.provider.fields.apiKeyHint : zhCN.settingsPage.provider.fields.apiKeyPlaceholder}
                onChange={(e) => setFormField('apiKey', e.target.value)}
              />
            </label>
            {formErr ? <p className="settings__error">{formErr}</p> : null}
            <div className="settings__form-actions">
              <button type="button" className="source-list__btn source-list__btn--primary" onClick={handleSave} disabled={saving}>
                {zhCN.settingsPage.provider.saveBtn}
              </button>
              <button type="button" className="source-list__btn" onClick={cancelEdit}>
                {zhCN.settingsPage.provider.cancelBtn}
              </button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <p className="settings__hint">{zhCN.settingsPage.provider.loading}</p>
        ) : loadErr ? (
          <p className="settings__error">{loadErr}</p>
        ) : providers === null || providers.length === 0 ? (
          <p className="settings__hint">{zhCN.settingsPage.provider.empty}</p>
        ) : (
          <ul className="settings__provider-list">
            {providers.map((p) => (
              <li key={p.id} className={`settings__provider-item${currentId === p.id ? ' settings__provider-item--current' : ''}`}>
                <div className="settings__provider-info">
                  <span className="settings__provider-name">
                    {p.name}
                    {currentId === p.id ? <span className="settings__badge">{zhCN.settingsPage.provider.currentBadge}</span> : null}
                  </span>
                  <span className="settings__provider-meta">
                    {p.model} · {p.apiBase}
                  </span>
                  <span className={`settings__key-state${p.apiKeySet ? ' is-set' : ''}`}>
                    {p.apiKeySet ? zhCN.settingsPage.provider.keySet : zhCN.settingsPage.provider.keyUnset}
                  </span>
                </div>
                <div className="settings__provider-actions">
                  {currentId !== p.id ? (
                    <button type="button" className="source-list__btn" onClick={() => handleSetCurrent(p)}>
                      {zhCN.settingsPage.provider.currentAction}
                    </button>
                  ) : null}
                  <button type="button" className="source-list__btn" onClick={() => handleTest(p)} disabled={testingId === p.id}>
                    {testingId === p.id ? zhCN.settingsPage.provider.testing : zhCN.settingsPage.provider.testBtn}
                  </button>
                  <button type="button" className="source-list__btn" onClick={() => startEdit(p)}>
                    {zhCN.settingsPage.provider.editBtn}
                  </button>
                  <button type="button" className="source-list__btn source-list__btn--danger" onClick={() => handleDelete(p)}>
                    {zhCN.settingsPage.provider.deleteBtn}
                  </button>
                </div>
                {testMsg && testMsg.id === p.id ? (
                  <p className={`settings__test-msg${testMsg.ok ? ' is-ok' : ' is-err'}`}>{testMsg.text}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {actionErr ? <p className="settings__error">{actionErr}</p> : null}
      </section>
    </div>
  )
}

export default Settings
