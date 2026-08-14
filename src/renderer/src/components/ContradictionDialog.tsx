import { useState } from 'react'
import { zhCN } from '../i18n/zh-CN'
import type { Contradiction, ContradictionStatus } from '../../../shared/types'

interface ContradictionDialogProps {
  contradictions: Contradiction[]
  /** 指定序号进入单条模式；不指定（undefined）进入总览模式 */
  initialSeq?: number
  /** 警告模式（2026-08-11）：展示"不在正文中的矛盾"警告清单——仅查看与忽略，不提供采纳修订 */
  warningMode?: boolean
  onClose: () => void
  /** 取舍成功回调（父组件用返回的矛盾替换列表） */
  onResolved: (contradiction: Contradiction) => void
  /** 采纳成功且正文已同步修订的回调（父组件刷新编辑器正文） */
  onApplied: (contradiction: Contradiction, draft: unknown) => void
  /** 打开来源文件（系统默认软件） */
  onOpenSource: (sourceId: string) => void
}

function ContradictionDialog({
  contradictions,
  initialSeq,
  warningMode = false,
  onClose,
  onResolved,
  onApplied,
  onOpenSource
}: ContradictionDialogProps) {
  const [activeSeq, setActiveSeq] = useState<number | null>(initialSeq ?? null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const active = activeSeq !== null ? contradictions.find((c) => c.seq === activeSeq) ?? null : null
  const t = zhCN.contradiction
  const statusText = (s: ContradictionStatus): string =>
    s === 'adopted' ? t.statusAdopted : s === 'ignored' ? t.statusIgnored : t.statusPending

  /** 采纳某说法：主进程本地替换正文原句（资料库只读，不调用大模型），成功后回调父组件刷新编辑器正文（可撤销） */
  const handleAdopt = async (contradictionId: string, variantId: string): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const res = await window.api.applyContradiction(active?.draftId ?? '', contradictionId, variantId)
      if (res.ok && res.data) {
        const updated = res.data.contradiction as unknown as Contradiction
        onResolved(updated)
        onApplied(updated, res.data.draft)
      } else {
        setMsg(res.error?.message ?? t.operationFailed)
      }
    } finally {
      setBusy(false)
    }
  }

  /** 忽略该矛盾 */
  const handleIgnore = async (contradictionId: string): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const res = await window.api.resolveContradiction(contradictionId, 'ignore')
      if (res.ok && res.data) {
        onResolved(res.data.contradiction as unknown as Contradiction)
      } else {
        setMsg(res.error?.message ?? t.operationFailed)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="confirm-dialog__overlay" onMouseDown={(e) => e.stopPropagation()}>
      <div className="contradiction-dialog" role="dialog" aria-modal="true" aria-label={warningMode ? t.warningsDialogTitle : t.dialogTitle}>
        <h4 className="confirm-dialog__title">
          {active
            ? (warningMode ? t.warningSingleTitle : t.singleTitle).replace('{seq}', String(active.seq))
            : (warningMode ? t.warningsDialogTitle : t.dialogTitle)}
        </h4>

        {contradictions.length === 0 ? (
          <p className="contradiction-dialog__empty">{warningMode ? t.emptyWarnings : t.empty}</p>
        ) : active ? (
          <ContradictionDetail
            contradiction={active}
            t={t}
            warningMode={warningMode}
            busy={busy}
            onAdopt={(variantId) => void handleAdopt(active.id, variantId)}
            onIgnore={() => void handleIgnore(active.id)}
            onOpenSource={onOpenSource}
          />
        ) : (
          <ul className="contradiction-dialog__list">
            {contradictions.map((c) => (
              <li key={c.id}>
                <button type="button" className="contradiction-dialog__item" onClick={() => setActiveSeq(c.seq)}>
                  <span className={`contradiction-dialog__item-seq${warningMode ? ' is-warning' : ''}`}>
                    {warningMode ? t.warningTag : '#'}{c.seq}
                  </span>
                  <span className="contradiction-dialog__item-topic">{c.topic}</span>
                  <span className={`contradiction-dialog__item-status is-${c.status}`}>{statusText(c.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {msg ? <p className="contradiction-dialog__msg">{msg}</p> : null}

        <div className="confirm-dialog__actions">
          {active ? (
            <button type="button" className="source-list__btn" onClick={() => setActiveSeq(null)} disabled={busy}>
              {t.back}
            </button>
          ) : null}
          <button type="button" className="source-list__btn" onClick={onClose} disabled={busy}>
            {zhCN.common.cancel}
          </button>
        </div>
      </div>
    </div>
  )
}

interface DetailProps {
  contradiction: Contradiction
  t: (typeof zhCN)['contradiction']
  warningMode?: boolean
  busy: boolean
  onAdopt: (variantId: string) => void
  onIgnore: () => void
  onOpenSource: (sourceId: string) => void
}

function ContradictionDetail({ contradiction: c, t, warningMode = false, busy, onAdopt, onIgnore, onOpenSource }: DetailProps) {
  const statusLabel = c.status === 'adopted' ? t.statusAdopted : c.status === 'ignored' ? t.statusIgnored : t.statusPending
  return (
    <div className="contradiction-dialog__detail">
      <p className="contradiction-dialog__topic">{c.topic}</p>
      <p className="contradiction-dialog__meta">
        {t.kindLabel}：{t.kinds[c.kind]} · {statusLabel}
      </p>
      {warningMode ? (
        <p className="contradiction-dialog__merged">{t.warningNotInDraft}</p>
      ) : (
        <>
          {c.merged ? <p className="contradiction-dialog__merged">{t.mergedHint}</p> : null}
          <p className="contradiction-dialog__quote-label">{t.draftQuoteLabel}</p>
          <p className="contradiction-dialog__quote">
            {c.draftQuote ? c.draftQuote : <em>{t.noQuote}</em>}
          </p>
        </>
      )}

      <p className="contradiction-dialog__variants-label">{t.variantsLabel}</p>
      <ul className="contradiction-dialog__variants">
        {c.variants.map((v, i) => {
          const adopted = c.status === 'adopted' && c.adoptedVariantId === v.id
          return (
            <li key={v.id} className={`contradiction-dialog__variant${adopted ? ' is-adopted' : ''}`}>
              <span className="contradiction-dialog__variant-index">{i + 1}.</span>
              <span className="contradiction-dialog__variant-text">{v.variantText}</span>
              <span className="contradiction-dialog__variant-sources">
                {t.sourceLabel}：
                {v.sourceTitles.map((title, idx) => (
                  <span key={`${v.id}-${idx}`} className="contradiction-dialog__source">
                    <button
                      type="button"
                      className="contradiction-dialog__source-link"
                      title={title}
                      onClick={() => onOpenSource(v.sourceIds[idx] ?? '')}
                    >
                      {title}
                    </button>
                    {idx < v.sourceTitles.length - 1 ? '、' : ''}
                  </span>
                ))}
              </span>
              {adopted ? <span className="contradiction-dialog__adopted-badge">{t.statusAdopted}</span> : null}
              {!warningMode && c.status === 'pending' ? (
                <button
                  type="button"
                  className="source-list__btn source-list__btn--primary contradiction-dialog__adopt"
                  disabled={busy}
                  onClick={() => onAdopt(v.id)}
                >
                  {busy ? t.applying : t.adopt}
                </button>
              ) : null}
            </li>
          )
        })}
      </ul>

      {c.status === 'pending' ? (
        <div className="contradiction-dialog__actions-inline">
          <button type="button" className="source-list__btn" disabled={busy} onClick={onIgnore}>
            {t.ignore}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default ContradictionDialog
