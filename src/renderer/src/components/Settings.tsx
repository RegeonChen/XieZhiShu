import { useState, useEffect, useCallback } from 'react'
import { zhCN } from '../i18n/zh-CN'
import ConfirmDialog from './ConfirmDialog'
import PresetGuideDialog from './PresetGuideDialog'
import { LLM_PRESETS } from '../../../shared/llm-presets'
import type { LlmPreset } from '../../../shared/llm-presets'

interface ProviderItem {
  id: string
  name: string
  apiBase: string
  model: string
  apiKeySet: boolean
}

interface AppSettingsShape {
  currentLlmProviderId?: string
  workspaceDir?: string
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
  const [pendingDelete, setPendingDelete] = useState<ProviderItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Phase 3.6 预设大模型
  const [guidePreset, setGuidePreset] = useState<LlmPreset | null>(null)

  // Phase 2.2 工作区
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null)
  const [workspaceSaving, setWorkspaceSaving] = useState(false)
  const [workspaceMsg, setWorkspaceMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [legacySources, setLegacySources] = useState(0)
  const [migrating, setMigrating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadErr(null)
    try {
      const [pRes, sRes, wsRes] = await Promise.all([
        window.api.listProviders(),
        window.api.getSettings(),
        window.api.getWorkspaceStatus()
      ])
      if (pRes.ok && pRes.data) {
        setProviders(pRes.data.items as ProviderItem[])
      } else {
        setLoadErr(zhCN.settingsPage.provider.loadFailed.replace('{message}', pRes.error?.message ?? ''))
      }
      if (sRes.ok && sRes.data) {
        setCurrentId((sRes.data as AppSettingsShape).currentLlmProviderId ?? null)
        setWorkspaceDir((sRes.data as AppSettingsShape).workspaceDir ?? null)
      }
      if (wsRes.ok && wsRes.data) {
        setLegacySources((wsRes.data as { legacySources?: number }).legacySources ?? 0)
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

  const handleDelete = async () => {
    if (!pendingDelete) return
    const p = pendingDelete
    setDeleting(true)
    const res = await window.api.deleteProvider(p.id)
    if (res.ok) {
      setPendingDelete(null)
      if (currentId === p.id) setCurrentId(null)
      await load()
    } else {
      setActionErr(zhCN.settingsPage.provider.deleteFailed.replace('{message}', res.error?.message ?? ''))
    }
    setDeleting(false)
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

  // ---- Phase 2.2 工作区操作 ----
  const applyWorkspace = async (dir: string | null) => {
    setWorkspaceSaving(true)
    setWorkspaceMsg(null)
    try {
      const res = await window.api.updateSettings({ workspaceDir: dir ?? undefined })
      if (res.ok && res.data) {
        setWorkspaceDir((res.data as AppSettingsShape).workspaceDir ?? null)
        setWorkspaceMsg({ ok: true, text: zhCN.settingsPage.workspace.saved })
      } else {
        setWorkspaceMsg({ ok: false, text: zhCN.settingsPage.workspace.failed.replace('{message}', res.error?.message ?? '') })
      }
    } catch {
      setWorkspaceMsg({ ok: false, text: zhCN.settingsPage.workspace.failed.replace('{message}', '') })
    } finally {
      setWorkspaceSaving(false)
    }
  }

  const handleChooseWorkspace = async () => {
    const res = await window.api.openDirectoryDialog()
    if (res.ok && res.data?.path) {
      await applyWorkspace(res.data.path)
    }
  }

  const handleClearWorkspace = () => {
    void applyWorkspace(null)
  }

  // 一次性迁移存量导入资料到工作区
  const handleMigrate = async () => {
    setMigrating(true)
    setWorkspaceMsg(null)
    try {
      const res = await window.api.migrateLegacyWorkspace()
      if (res.ok && res.data) {
        const r = res.data as { migrated: number; failed: number; skipped: number }
        setWorkspaceMsg({
          ok: true,
          text: zhCN.settingsPage.workspace.migrateDone
            .replace('{migrated}', String(r.migrated))
            .replace('{failed}', String(r.failed))
            .replace('{skipped}', String(r.skipped))
        })
        setLegacySources(0)
      } else {
        setWorkspaceMsg({ ok: false, text: zhCN.settingsPage.workspace.migrateFailed.replace('{message}', res.error?.message ?? '') })
      }
    } catch {
      setWorkspaceMsg({ ok: false, text: zhCN.settingsPage.workspace.migrateFailed.replace('{message}', '') })
    } finally {
      setMigrating(false)
    }
  }

  const isEditingExisting = editing !== null && editing !== 'new'

  return (
    <div className="settings">
      <h3 className="settings__title">{zhCN.settingsPage.title}</h3>

      {/* Phase 2.2 工作区资料库 */}
      <section className="settings__section">
        <div className="settings__section-header">
          <h4 className="settings__section-title">{zhCN.settingsPage.workspace.title}</h4>
          {!workspaceSaving ? (
            <div className="settings__workspace-actions">
              {workspaceDir ? (
                <>
                  <button type="button" className="source-list__btn" onClick={handleClearWorkspace}>
                    {zhCN.settingsPage.workspace.clearBtn}
                  </button>
                  {legacySources > 0 ? (
                    <button type="button" className="source-list__btn" onClick={handleMigrate} disabled={migrating}>
                      {migrating ? zhCN.settingsPage.workspace.migrating : zhCN.settingsPage.workspace.migrateBtn}
                    </button>
                  ) : null}
                </>
              ) : null}
              <button type="button" className="source-list__btn source-list__btn--primary" onClick={handleChooseWorkspace}>
                {zhCN.settingsPage.workspace.chooseBtn}
              </button>
            </div>
          ) : (
            <span className="settings__hint">{zhCN.settingsPage.workspace.saving}</span>
          )}
        </div>
        <p className="settings__hint">{zhCN.settingsPage.workspace.hint}</p>
        {legacySources > 0 ? <p className="settings__hint">{zhCN.settingsPage.workspace.migrateHint}</p> : null}
        <p className="settings__workspace-path">
          <span className="settings__field-label">{zhCN.settingsPage.workspace.current}：</span>
          <code>{workspaceDir ?? zhCN.settingsPage.workspace.notSet}</code>
        </p>
        {workspaceMsg ? (
          <p className={`settings__hint ${workspaceMsg.ok ? 'settings__hint--ok' : 'settings__hint--err'}`}>{workspaceMsg.text}</p>
        ) : null}
      </section>

      <section className="settings__section">
        <div className="settings__section-header">
          <h4 className="settings__section-title">{zhCN.settingsPage.preset.title}</h4>
        </div>
        <p className="settings__hint">{zhCN.settingsPage.preset.hint}</p>
        <ul className="settings__preset-list">
          {LLM_PRESETS.map((preset) => {
            const isFree = preset.pricing.includes('免费')
            return (
              <li key={preset.id} className="settings__preset-item">
                <div className="settings__preset-info">
                  <span className="settings__preset-name">
                    {preset.name}
                    <span className={`settings__badge${isFree ? ' settings__badge--free' : ''}`}>{preset.pricing}</span>
                  </span>
                  <span className="settings__preset-meta">
                    {preset.model} · {preset.apiBase}
                  </span>
                </div>
                <div className="settings__preset-actions">
                  <button
                    type="button"
                    className="source-list__btn source-list__btn--primary"
                    onClick={() => {
                      setEditing('new')
                      setForm({ name: preset.name, apiBase: preset.apiBase, model: preset.model, apiKey: '' })
                      setFormErr(null)
                      setTestMsg(null)
                    }}
                  >
                    {zhCN.settingsPage.preset.useBtn}
                  </button>
                  <button type="button" className="source-list__btn" onClick={() => setGuidePreset(preset)}>
                    {zhCN.settingsPage.preset.getKeyBtn}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </section>

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
                  <button type="button" className="source-list__btn source-list__btn--danger" onClick={() => setPendingDelete(p)}>
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

      {pendingDelete ? (
        <ConfirmDialog
          title={zhCN.settingsPage.provider.deleteTitle}
          message={zhCN.settingsPage.provider.deleteConfirm.replace('{name}', pendingDelete.name)}
          confirmText={zhCN.settingsPage.provider.deleteBtn}
          danger
          busy={deleting}
          onConfirm={handleDelete}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}

      {guidePreset ? <PresetGuideDialog preset={guidePreset} onClose={() => setGuidePreset(null)} /> : null}
    </div>
  )
}

export default Settings
