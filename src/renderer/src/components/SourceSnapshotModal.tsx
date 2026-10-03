import { useEffect, useState, type ReactNode } from 'react'
import { zhCN } from '../i18n/zh-CN'

/** 快照抓取时间显示（YYYY-MM-DD HH:mm，本地时区；解析失败则原样返回） */
function formatSnapshotTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 快照正文渲染（第三批 C）：把该段的引文在正文里高亮。
 * 段落的 excerpt 与库里快照可能只差空白/换行（提取时做了归一化），所以用**去空白比对**定位，
 * 再映射回原文下标——这是"这段确实出自原文"的可视化证据，必须尽量命中而不是靠精确匹配。
 */
function renderSnapshotText(text: string, highlight: string): ReactNode[] {
  const body = text ?? ''
  const needle = (highlight ?? '').trim()
  if (!needle) return [body]
  const map: number[] = []
  let stripped = ''
  for (let i = 0; i < body.length; i++) {
    if (/\s/.test(body[i])) continue
    stripped += body[i]
    map.push(i)
  }
  const needleStripped = needle.replace(/\s+/g, '')
  if (!needleStripped) return [body]
  const at = stripped.indexOf(needleStripped)
  if (at < 0) return [body]
  const start = map[at]
  const end = map[Math.min(map.length - 1, at + needleStripped.length - 1)] + 1
  return [
    body.slice(0, start),
    <mark key="hl" className="compilation-snapshot__hit">{body.slice(start, end)}</mark>,
    body.slice(end)
  ]
}

interface Props {
  sourceId: string
  /** 要在此快照里高亮的引文（通常是该段的证据引文） */
  highlight?: string
  onClose: () => void
}

/**
 * 「查看本地快照」弹窗（Phase 9 / S1 从「来源小卡」迁出）：
 * 原先是"点段尾圆标 → 来源小卡 → 查看本地快照"三层里的最内层；
 * S1 让圆标**直接打开右栏来源文件**并删除了中间层，于是这个弹窗改由右栏查看器承载，
 * 能力本身一项没少（读库里抓取当时的正文，不联网）。
 */
export default function SourceSnapshotModal({ sourceId, highlight, onClose }: Props): React.JSX.Element {
  const t = zhCN.compilation
  const [data, setData] = useState<{
    kind: 'file' | 'url'
    text: string
    snapshotAt?: string
    totalChars: number
    truncated: boolean
    shortText: boolean
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await window.api.getSourceSnapshot(sourceId)
        if (!alive) return
        if (res.ok && res.data) setData(res.data)
        else setError(res.error?.message ?? zhCN.compilation.snapshotFailed)
      } catch (e) {
        if (alive) setError(String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [sourceId])

  return (
    <div className="skills-manager__modal-backdrop" onMouseDown={onClose}>
      <div className="skills-manager__modal compilation-snapshot" onMouseDown={(e) => e.stopPropagation()}>
        <h4 className="skills-manager__modal-title">{t.snapshotTitle}</h4>
        <p className="settings__hint">
          {data?.kind === 'url' ? t.snapshotUrlHint : t.snapshotFileHint}
          {data?.snapshotAt ? '　' + t.snapshotAt.replace('{time}', formatSnapshotTime(data.snapshotAt)) : ''}
          {data?.truncated ? '　' + t.snapshotTruncated.replace('{chars}', String(data.totalChars)) : ''}
        </p>
        {data?.shortText ? <p className="settings__hint settings__hint--err">{t.snapshotShort}</p> : null}
        {error ? <p className="settings__hint settings__hint--err">{error}</p> : null}
        <div className="compilation-snapshot__body">
          {loading ? t.snapshotLoading : data ? renderSnapshotText(data.text, highlight ?? '') : null}
        </div>
        <div className="skills-manager__modal-actions">
          <button type="button" className="source-list__btn" onClick={onClose}>{t.close}</button>
        </div>
      </div>
    </div>
  )
}
