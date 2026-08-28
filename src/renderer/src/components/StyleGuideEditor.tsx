import { useState, useCallback, useEffect, useRef } from 'react'
import { zhCN } from '../i18n/zh-CN'
import ConfirmDialog from './ConfirmDialog'
import PromptDialog from './PromptDialog'

/** 规范文档库（Phase 6.4.1：第二步「指定行文规范」） */
interface StyleGuideItem { id: string; name: string; content: string; isDefault: boolean; createdAt: string; updatedAt: string }

function StyleGuideEditor({ startInList = false, taskId, onNext }: { startInList?: boolean; taskId?: string; onNext?: () => void }) {
  const t = zhCN.styleGuide
  const [mode, setMode] = useState<'list' | 'editor'>(startInList ? 'list' : 'editor')
  const [guides, setGuides] = useState<StyleGuideItem[] | null>(null)
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [showSave, setShowSave] = useState(false)
  const [confirmImport, setConfirmImport] = useState<StyleGuideItem | null>(null)
  const [saveTarget, setSaveTarget] = useState<StyleGuideItem | null>(null)
  const [pendingName, setPendingName] = useState<{ kind: 'new' | 'rename'; id?: string; name: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  // 当前编辑的规范 id 与其已保存内容（用于「有未保存修改」判定）
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [savedContent, setSavedContent] = useState('')
  const [showNextConfirm, setShowNextConfirm] = useState(false)

  // ---- 范本（Phase 6.4.2：第二步「添加范本」，任务级、可选，生成初稿时作为参考提交） ----
  const [fanbenOpen, setFanbenOpen] = useState(false)
  const [fanbenText, setFanbenText] = useState('')
  const fanbenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reload = useCallback(async () => {
    const res = await window.api.listStyleGuides()
    if (res.ok && res.data) {
      const list = res.data.items as StyleGuideItem[]
      setGuides(list)
      return list
    }
    setGuides([])
    return [] as StyleGuideItem[]
  }, [])

  useEffect(() => {
    void (async () => {
      const list = await reload()
      // 仅在没有明确选中某篇规范时（首次进入编辑器）自动载入默认规范；
      // 从列表点击 openGuide 会先设置 currentId，因此不会覆盖用户选中的那篇。
      if (mode === 'editor' && currentId === null) {
        const def = list.find((g) => g.isDefault) ?? list[0]
        if (def) { setName(def.name); setContent(def.content); setCurrentId(def.id); setSavedContent(def.content) }
      }
    })()
  }, [reload, mode])

  // 加载任务级范本；切换任务或首次挂载时重置并读取
  useEffect(() => {
    if (!taskId) { setFanbenOpen(false); setFanbenText(''); return }
    setFanbenOpen(false)
    if (fanbenTimer.current) clearTimeout(fanbenTimer.current)
    setFanbenText('')
    void window.api.getModelText(taskId).then((res) => {
      if (res.ok && res.data) setFanbenText(res.data.text)
    })
    return () => { if (fanbenTimer.current) clearTimeout(fanbenTimer.current) }
  }, [taskId])

  const handleFanbenChange = (text: string): void => {
    setFanbenText(text)
    if (!taskId) return
    if (fanbenTimer.current) clearTimeout(fanbenTimer.current)
    fanbenTimer.current = setTimeout(() => {
      void window.api.setModelText(taskId, text)
    }, 600)
  }

  const openGuide = (g: StyleGuideItem): void => {
    setName(g.name)
    setContent(g.content)
    setCurrentId(g.id)
    setSavedContent(g.content)
    setMode('editor')
  }


  const doSave = async (opts: { id?: string; n: string }) => {
    setSaving(true)
    setSaveErr(null)
    try {
      const res = await window.api.saveStyleGuide({ id: opts.id, name: opts.n, content })
      if (res.ok && res.data) {
        const saved = res.data.styleGuide as StyleGuideItem
        setName(saved.name)
        setCurrentId(saved.id)
        setSavedContent(saved.content)
        setSaveTarget(null)
        setShowSave(false); setPendingName(null)
        void reload()
      } else {
        setSaveErr(res.error?.message ?? '')
      }
    } finally { setSaving(false) }
  }

  const handleSetDefault = async (guide: StyleGuideItem) => {
    const res = await window.api.setDefaultStyleGuide(guide.id)
    if (res.ok) { void reload() }
  }

  const handleDelete = async (guide: StyleGuideItem) => {
    await window.api.deleteStyleGuide(guide.id)
    const list = await reload()
    const def = list.find((g) => g.isDefault) ?? list[0]
    if (def) { setName(def.name); setContent(def.content); setCurrentId(def.id); setSavedContent(def.content) }
  }

  /** 第二步「下一步」：有未保存修改时先二次确认，否则直接进入第三步 */
  const handleNext = (): void => {
    if (currentId !== null && content !== savedContent) setShowNextConfirm(true)
    else onNext?.()
  }

  if (mode === 'list') {
    return (
      <div className="style-guide-list">
        <div className="style-guide-list__header"><span>{t.listTitle}</span></div>
        <div className="style-guide-list__items">
          {(guides ?? []).map((g) => (
            <div key={g.id} className="style-guide-dialog__row">
              <button type="button" className="style-guide-dialog__main" onClick={() => openGuide(g)}>{g.name}</button>
              <span className="style-guide-dialog__badge">{g.isDefault ? t.defaultBadge : ''}</span>
              <button type="button" className="style-guide-dialog__action" onClick={() => setPendingName({ kind: 'rename', id: g.id, name: g.name })}>{t.renameBtn}</button>
              <button type="button" className="style-guide-dialog__action" onClick={() => void handleSetDefault(g)}>{t.setDefault}</button>
              <button type="button" className="style-guide-dialog__action is-danger" onClick={() => void handleDelete(g)}>{t.delete}</button>
            </div>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="style-guide-editor">
      <div className="style-guide-editor__toolbar">
        {startInList ? (
          <button type="button" className="source-list__btn" onClick={() => setMode('list')}>{t.backToList}</button>
        ) : null}
        <span className="style-guide-editor__title">{name || t.untitled}</span>
        <div className="style-guide-editor__actions">
          {taskId ? (
            <button type="button" className="source-list__btn" onClick={() => setFanbenOpen(true)}>{t.addFanben}</button>
          ) : null}
          <button type="button" className="source-list__btn" onClick={() => setShowImport(true)}>{t.importDraft}</button>
        </div>
      </div>
      {taskId ? (
        fanbenOpen ? (
          <div className="fanben-panel">
            <div className="fanben-panel__head">
              <span className="fanben-panel__title">{t.fanbenLabel}</span>
              <span className="fanben-panel__hint">{t.fanbenHint}</span>
            </div>
            <textarea
              className="fanben-panel__textarea"
              value={fanbenText}
              placeholder={t.fanbenPlaceholder}
              onChange={(e) => handleFanbenChange(e.target.value)}
              onBlur={() => {
                if (fanbenTimer.current) clearTimeout(fanbenTimer.current)
                if (taskId) void window.api.setModelText(taskId, fanbenText)
              }}
            />
            <div className="fanben-panel__footer">
              <button type="button" className="compilation-collapse-btn" title={zhCN.compilation.collapse} onClick={() => setFanbenOpen(false)}>
                <span aria-hidden="true">▲</span> {zhCN.compilation.collapse}
              </button>
            </div>
          </div>
        ) : fanbenText.trim() ? (
          <button
            type="button"
            className="compilation-collapse-btn compilation-collapse-btn--bar fanben-collapse-bar"
            onClick={() => setFanbenOpen(true)}
          >
            <span>📄 {t.fanbenLabel}</span>
            <span aria-hidden="true">▼</span>
          </button>
        ) : null
      ) : null}
      <textarea
        className="style-guide-editor__textarea"
        value={content}
        placeholder={t.contentPlaceholder}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="style-guide-editor__footer">
        <span className="style-guide-editor__count">{content.length} 字</span>
        <div className="style-guide-editor__footer-actions">
          <button type="button" className="source-list__btn source-list__btn--primary" onClick={() => setShowSave(true)}>{t.save}</button>
          {taskId && onNext ? (
            <button type="button" className="source-list__btn" onClick={() => handleNext()}>{zhCN.writingWorkspace.next}</button>
          ) : null}
        </div>
      </div>

      {showImport ? (
        <div className="skills-manager__modal-backdrop" onMouseDown={() => setShowImport(false)}>
          <div className="skills-manager__modal style-guide-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h4 className="skills-manager__modal-title">{t.importTitle}</h4>
            <div className="style-guide-dialog__list">
              {(guides ?? []).map((g) => (
                <div key={g.id} className="style-guide-dialog__row">
                  <button type="button" className="style-guide-dialog__main" onClick={() => { setConfirmImport(g); setShowImport(false) }}>{g.name}</button>
                  <span className="style-guide-dialog__badge">
                    {g.isDefault ? t.defaultBadge : ''}
                  </span>
                  <button type="button" className="style-guide-dialog__action" onClick={() => setPendingName({ kind: 'rename', id: g.id, name: g.name })}>{t.renameBtn}</button>
                  <button type="button" className="style-guide-dialog__action" onClick={() => void handleSetDefault(g)}>{t.setDefault}</button>
                  <button type="button" className="style-guide-dialog__action is-danger" onClick={() => void handleDelete(g)}>{t.delete}</button>
                </div>
              ))}
            </div>
            <div className="skills-manager__modal-actions">
              <button type="button" className="source-list__btn" onClick={() => setShowImport(false)}>{t.close}</button>
            </div>
          </div>
        </div>
      ) : null}

      {showSave ? (
        <div className="skills-manager__modal-backdrop" onMouseDown={() => setShowSave(false)}>
          <div className="skills-manager__modal style-guide-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h4 className="skills-manager__modal-title">{t.saveTitle}</h4>
            <p className="style-guide-dialog__hint">{t.saveHint}</p>
            <div className="style-guide-dialog__list">
              {(guides ?? []).map((g) => (
                <div key={g.id} className="style-guide-dialog__row">
                  <button type="button" className="style-guide-dialog__main" onClick={() => { setSaveTarget(g); setShowSave(false) }}>{g.name}</button>
                  <span className="style-guide-dialog__badge">{g.isDefault ? t.defaultBadge : ''}</span>
                </div>
              ))}
              <div className="style-guide-dialog__row">
                <button type="button" className="style-guide-dialog__main" onClick={() => { setShowSave(false); setPendingName({ kind: 'new', name: '' }) }}>{t.saveAsNew}</button>
                <span className="style-guide-dialog__badge">+</span>
              </div>
            </div>
            <div className="skills-manager__modal-actions">
              <button type="button" className="source-list__btn" onClick={() => setShowSave(false)}>{t.close}</button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmImport ? (
        <ConfirmDialog
          title={t.importConfirmTitle}
          message={t.importConfirmMessage.replace('{name}', confirmImport.name)}
          confirmText={t.importConfirmBtn}
          danger
          busy={false}
          onConfirm={() => { setName(confirmImport.name); setContent(confirmImport.content); setConfirmImport(null) }}
          onCancel={() => setConfirmImport(null)}
        />
      ) : null}

      {saveTarget ? (
        <ConfirmDialog
          title={t.overwriteTitle}
          message={t.overwriteMessage.replace('{name}', saveTarget.name)}
          confirmText={t.overwriteBtn}
          danger
          busy={saving}
          busyText={zhCN.common.saving}
          error={saveErr ?? undefined}
          onConfirm={() => void doSave({ id: saveTarget.id, n: saveTarget.name })}
          onCancel={() => { setSaveTarget(null); setSaveErr(null) }}
        />
      ) : null}

      {showNextConfirm ? (
        <ConfirmDialog
          title={t.nextUnsavedTitle}
          message={t.nextUnsavedMessage}
          confirmText={t.nextUnsavedConfirm}
          danger
          busy={false}
          onConfirm={() => { setShowNextConfirm(false); onNext?.() }}
          onCancel={() => setShowNextConfirm(false)}
        />
      ) : null}

      {pendingName ? (
        <PromptDialog
          title={pendingName.kind === 'new' ? t.newTitle : t.renameTitle}
          label={t.nameLabel}
          defaultValue={pendingName.name}
          confirmText={pendingName.kind === 'new' ? t.saveBtn : t.renameBtn}
          busy={saving}
          error={saveErr}
          onConfirm={(value) => {
            if (pendingName.kind === 'new') void doSave({ n: value })
            else void doSave({ id: pendingName.id, n: value })
          }}
          onCancel={() => { setPendingName(null); setSaveErr(null) }}
        />
      ) : null}
    </div>
  )
}

export default StyleGuideEditor
