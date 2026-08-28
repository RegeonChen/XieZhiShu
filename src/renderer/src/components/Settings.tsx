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
  workspaceDir?: string
  compilationProviderId?: string
  draftProviderId?: string
}

interface ProviderForm {
  name: string
  apiBase: string
  model: string
  apiKey: string
}

const EMPTY_FORM: ProviderForm = { name: '', apiBase: '', model: '', apiKey: '' }

interface SettingsProps {
  /** 重新打开新手引导（由 App 注入） */
  onOpenOnboarding?: () => void
  /** 滚动定位（scroll-spy）回调：当前视口内最靠上的设置区块 id（供中栏导航高亮） */
  onActiveChange?: (id: string) => void
  /** 当前主题（由 App 注入） */
  theme?: 'light' | 'dark' | 'classic'
  /** 切换主题回调（由 App 注入） */
  onThemeChange?: (theme: 'light' | 'dark' | 'classic') => void
}

/** 设置页区块顺序（与中栏导航一致；scroll-spy 观察对象） */
const SETTING_SECTIONS = ['overview', 'appearance', 'workspace', 'preset', 'stepModels', 'provider'] as const

function Settings({ onOpenOnboarding, onActiveChange, theme, onThemeChange }: SettingsProps) {
  const [providers, setProviders] = useState<ProviderItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)

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

  // Phase 6.8 步骤默认模型（第 1 步汇编 / 第 3 步初稿）
  const [step1Id, setStep1Id] = useState<string | null>(null)
  const [step3Id, setStep3Id] = useState<string | null>(null)
  const [stepModelsMsg, setStepModelsMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // 诊断日志导出（2026-08-14）
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null)

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
        setWorkspaceDir((sRes.data as AppSettingsShape).workspaceDir ?? null)
        setStep1Id((sRes.data as AppSettingsShape).compilationProviderId ?? null)
        setStep3Id((sRes.data as AppSettingsShape).draftProviderId ?? null)
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

  // scroll-spy：观察各设置区块，视口内最靠上的区块上报给中栏导航高亮（2026-08-19）
  useEffect(() => {
    if (!onActiveChange) return
    const els = SETTING_SECTIONS.map((id) => document.getElementById(`settings-${id}`)).filter(
      (el): el is HTMLElement => el !== null
    )
    if (els.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length === 0) return
        const top = visible.reduce((a, b) => (a.boundingClientRect.top <= b.boundingClientRect.top ? a : b))
        const id = (top.target as HTMLElement).id.replace(/^settings-/, '')
        onActiveChange(id)
      },
      { rootMargin: '-15% 0px -65% 0px', threshold: 0 }
    )
    els.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [onActiveChange])

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
    } catch (e) {
      setTestMsg({ id: p.id, ok: false, text: zhCN.settingsPage.provider.testFailed.replace('{message}', String(e)) })
    } finally {
      setTestingId(null)
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

  // 导出诊断日志（2026-08-14）：一键导出，供开发者复现 bug
  const handleExportLog = async () => {
    if (exporting) return
    setExporting(true)
    setExportMsg(null)
    try {
      const res = await window.api.exportLog()
      if (res.ok && res.data?.path) {
        setExportMsg({ ok: true, text: zhCN.settingsPage.exportLog.done.replace('{path}', res.data.path) })
      } else if (res.ok) {
        // 用户取消保存对话框，静默
        setExportMsg(null)
      } else {
        setExportMsg({ ok: false, text: zhCN.settingsPage.exportLog.failed.replace('{message}', res.error?.message ?? '') })
      }
    } catch {
      setExportMsg({ ok: false, text: zhCN.settingsPage.exportLog.failed.replace('{message}', '') })
    } finally {
      setExporting(false)
    }
  }

  // Phase 6.8：设置第 1/3 步默认大模型（从已配置 Provider 中选取；空 = 回退任务/全局）
  const handleStepModelChange = async (step: 1 | 3, id: string): Promise<void> => {
    const value = id ? id : null
    if (step === 1) setStep1Id(value)
    else setStep3Id(value)
    setStepModelsMsg(null)
    const res = await window.api.updateSettings(
      step === 1 ? { compilationProviderId: value ?? undefined } : { draftProviderId: value ?? undefined }
    )
    if (res.ok) {
      setStepModelsMsg({ ok: true, text: zhCN.settingsPage.stepModels.saved })
    } else {
      setStepModelsMsg({ ok: false, text: zhCN.settingsPage.stepModels.failed.replace('{message}', res.error?.message ?? '') })
    }
  }

  return (
    <div className="settings">
      <div className="settings__head">
        <h3 className="settings__title">{zhCN.settingsPage.title}</h3>
        <p className="settings__subtitle">{zhCN.settingsPage.subtitle}</p>
      </div>
      {exportMsg ? (
        <p className={`settings__hint ${exportMsg.ok ? 'settings__hint--ok' : 'settings__hint--err'}`}>{exportMsg.text}</p>
      ) : null}

      {/* 总览卡（2026-08-19）：当前配置状态速览 + 常用入口 */}
      <section className="settings__overview" id="settings-overview">
        <div>
          <h4 className="settings__overview-title">{zhCN.settingsPage.overview.title}</h4>
          <p className="settings__overview-hint">{zhCN.settingsPage.overview.hint}</p>
        </div>
        <div className="settings__overview-chips">
          <span className="settings__overview-chip">
            {zhCN.settingsPage.overview.workspaceLabel}：{workspaceDir ?? zhCN.settingsPage.overview.workspaceNone}
          </span>
        </div>
        <div className="settings__overview-actions">
          {onOpenOnboarding ? (
            <button type="button" className="source-list__btn" onClick={onOpenOnboarding}>
              {zhCN.settingsPage.onboardingBtn}
            </button>
          ) : null}
          <button type="button" className="source-list__btn" onClick={handleExportLog} disabled={exporting}>
            {exporting ? zhCN.settingsPage.exportLog.exporting : zhCN.settingsPage.exportLog.btn}
          </button>
        </div>
      </section>

      {/* Phase 6.5: 外观主题 */}
      <section className="settings__section" id="settings-appearance">
        <div className="settings__section-header">
          <span className="settings__section-icon settings__section-icon--appearance" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" />
              <path d="M12 6a6 6 0 0 0 0 12" />
            </svg>
          </span>
          <h4 className="settings__section-title">{zhCN.settingsPage.appearance.title}</h4>
        </div>
        <p className="settings__hint">{zhCN.settingsPage.appearance.hint}</p>
        <div className="settings__theme-row">
          {([['light', zhCN.settingsPage.appearance.light], ['dark', zhCN.settingsPage.appearance.dark], ['classic', zhCN.settingsPage.appearance.classic]] as const).map(([id, label]) => (
            <button key={id} type="button" className={'settings__theme-option' + (theme === id ? ' is-active' : '')} onClick={() => onThemeChange?.(id)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      {/* Phase 2.2 工作区资料库 */}
      <section className="settings__section" id="settings-workspace" data-onboarding="settings-workspace">
        <div className="settings__section-header">
          <span className="settings__section-icon settings__section-icon--workspace" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
            </svg>
          </span>
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
          <span className={`settings__status-chip${workspaceDir ? ' is-ok' : ''}`}>
            {workspaceDir ? zhCN.settingsPage.workspace.configured : zhCN.settingsPage.workspace.notConfigured}
          </span>
        </p>
        {workspaceMsg ? (
          <p className={`settings__hint ${workspaceMsg.ok ? 'settings__hint--ok' : 'settings__hint--err'}`}>{workspaceMsg.text}</p>
        ) : null}
      </section>

      <section className="settings__section" id="settings-preset" data-onboarding="settings-preset">
        <div className="settings__section-header">
          <span className="settings__section-icon settings__section-icon--preset" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8L12 2z" />
            </svg>
          </span>
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
                    <span className="settings__preset-avatar" aria-hidden="true">{preset.name.charAt(0)}</span>
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

      {/* Phase 6.8：步骤默认模型（第 1 步汇编 / 第 3 步初稿） */}
      <section className="settings__section" id="settings-step-models" data-onboarding="settings-step-models">
        <div className="settings__section-header">
          <span className="settings__section-icon settings__section-icon--stepmodels" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8L12 2z" />
            </svg>
          </span>
          <h4 className="settings__section-title">{zhCN.settingsPage.stepModels.title}</h4>
        </div>
        <p className="settings__hint">{zhCN.settingsPage.stepModels.hint}</p>
        <label className="settings__field">
          <span className="settings__field-label">{zhCN.settingsPage.stepModels.step1Label}</span>
          <select className="settings__input" value={step1Id ?? ''} onChange={(e) => void handleStepModelChange(1, e.target.value)}>
            <option value="">{zhCN.settingsPage.stepModels.none}</option>
            {(providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="settings__field">
          <span className="settings__field-label">{zhCN.settingsPage.stepModels.step3Label}</span>
          <select className="settings__input" value={step3Id ?? ''} onChange={(e) => void handleStepModelChange(3, e.target.value)}>
            <option value="">{zhCN.settingsPage.stepModels.none}</option>
            {(providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        {stepModelsMsg ? (
          <p className={`settings__hint ${stepModelsMsg.ok ? 'settings__hint--ok' : 'settings__hint--err'}`}>{stepModelsMsg.text}</p>
        ) : null}
      </section>

      <section className="settings__section" id="settings-provider" data-onboarding="settings-provider">
        <div className="settings__section-header">
          <span className="settings__section-icon settings__section-icon--provider" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 9l-4 4 4 4" />
              <path d="M16 9l4 4-4 4" />
              <path d="M13 5l-2 14" />
            </svg>
          </span>
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
          <p className="settings__hint settings__hint--loading">
            <span className="spinner" aria-hidden="true" />
            {zhCN.settingsPage.provider.loading}
          </p>
        ) : loadErr ? (
          <p className="settings__error">{loadErr}</p>
        ) : providers === null || providers.length === 0 ? (
          <p className="settings__hint">{zhCN.settingsPage.provider.empty}</p>
        ) : (
          <ul className="settings__provider-list">
            {providers.map((p) => (
              <li key={p.id} className="settings__provider-item">
                <div className="settings__provider-info">
                  <span className="settings__provider-name">
                    <span className="settings__provider-avatar" aria-hidden="true">{p.name.charAt(0)}</span>
                    {p.name}
                  </span>
                  <span className="settings__provider-meta">
                    <span className="settings__provider-model">{p.model}</span>
                    <span className="settings__provider-base">{p.apiBase}</span>
                  </span>
                  <span className={`settings__key-state${p.apiKeySet ? ' is-set' : ''}`}>
                    <i className="settings__key-dot" aria-hidden="true" />
                    {p.apiKeySet ? zhCN.settingsPage.provider.keySet : zhCN.settingsPage.provider.keyUnset}
                  </span>
                </div>
                <div className="settings__provider-actions">
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
