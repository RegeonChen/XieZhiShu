import { useCallback, useEffect, useRef, useState } from 'react'
import { zhCN } from '../i18n/zh-CN'

/**
 * 内嵌网页浏览器分栏（Phase 8 / S4）。
 *
 * 用户诉求：点网页来源时**直接看原网页长什么样**，而不是软件里存的抓取快照。
 * 真正的网页由主进程用 `WebContentsView` 叠加在窗口上渲染（安全约束见主进程注释），
 * 这里只负责：
 *  ① 量出本容器在窗口里的矩形并上报（主进程据此摆放那个视图）；
 *  ② 地址栏与后退/前进/刷新；
 *  ③ 把容器高度压到"刚好填满可见区域"，避免所在分栏出现滚动条 ——
 *     因为那个视图是**窗口坐标系的浮层**，分栏一旦滚动它就会与容器错位。
 */
interface Props {
  sourceId: string
  url: string
}

/** 向上找最近的滚动容器（用于把浏览器高度顶到它的底边之上） */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement
  while (cur) {
    const style = window.getComputedStyle(cur)
    if (/(auto|scroll|overlay)/.test(style.overflowY)) return cur
    cur = cur.parentElement
  }
  return null
}

export default function WebBrowserPane({ sourceId, url }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [address, setAddress] = useState(url)
  const [state, setState] = useState<{ url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(true)

  /** 量出容器矩形；同时把高度设成"填满到滚动容器底边之上"，避免分栏滚动导致浮层错位 */
  const measure = useCallback((): { x: number; y: number; width: number; height: number } | null => {
    const el = hostRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const scroller = findScrollParent(el)
    const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight
    const height = Math.max(160, Math.floor(bottom - rect.top - 12))
    if (Math.abs(el.clientHeight - height) > 1) el.style.height = `${height}px`
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height
    }
  }, [])

  // 打开浏览器（url / 来源变化时重开）
  useEffect(() => {
    let alive = true
    setOpening(true)
    setError(null)
    setAddress(url)
    const rect = measure()
    if (!rect) return
    window.api
      .webBrowserOpen(sourceId, rect)
      .then((res) => {
        if (!alive) return
        if (res.ok && res.data) {
          setState(res.data)
          if (res.data.url) setAddress(res.data.url)
        } else {
          setError(res.error?.message ?? zhCN.webBrowser.openFailed)
        }
      })
      .catch(() => {
        if (alive) setError(zhCN.webBrowser.openFailed)
      })
      .finally(() => {
        if (alive) setOpening(false)
      })
    return () => {
      alive = false
      void window.api.webBrowserClose()
    }
  }, [sourceId, url, measure])

  // 位置同步：容器尺寸变化 / 窗口尺寸变化
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const sync = (): void => {
      const rect = measure()
      if (rect) void window.api.webBrowserSetBounds(rect)
    }
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    window.addEventListener('resize', sync)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [measure])

  const navigate = useCallback(
    async (raw: string) => {
      setError(null)
      const res = await window.api.webBrowserNavigate(raw)
      if (res.ok && res.data) setState(res.data)
      else setError(res.error?.message ?? zhCN.webBrowser.openFailed)
    },
    []
  )

  const action = useCallback(async (a: 'back' | 'forward' | 'reload') => {
    setError(null)
    const res = await window.api.webBrowserAction(a)
    if (res.ok && res.data) {
      setState(res.data)
      if (res.data.url) setAddress(res.data.url)
    } else setError(res.error?.message ?? zhCN.webBrowser.openFailed)
  }, [])

  return (
    <div className="web-browser">
      <div className="web-browser__bar">
        <button
          type="button"
          className="pdf-viewer__btn"
          disabled={!state?.canGoBack}
          onClick={() => void action('back')}
        >
          {zhCN.webBrowser.back}
        </button>
        <button
          type="button"
          className="pdf-viewer__btn"
          disabled={!state?.canGoForward}
          onClick={() => void action('forward')}
        >
          {zhCN.webBrowser.forward}
        </button>
        <button type="button" className="pdf-viewer__btn" onClick={() => void action('reload')}>
          {zhCN.webBrowser.reload}
        </button>
        <input
          className="web-browser__address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void navigate(address)
          }}
          spellCheck={false}
          title={zhCN.webBrowser.addressHint}
        />
        <button type="button" className="pdf-viewer__btn" onClick={() => void navigate(address)}>
          {zhCN.webBrowser.go}
        </button>
        {opening ? <span className="web-browser__status">{zhCN.webBrowser.opening}</span> : null}
        {error ? (
          <span className="web-browser__status web-browser__status--err">
            {error}（可用「{zhCN.sourceViewer.openExternal}」在系统浏览器中查看）
          </span>
        ) : null}
      </div>
      {/* 真正的网页在主进程的 WebContentsView 里（它是窗口坐标系的浮层，会盖住这块占位）；
          这里必须保持是**最后一个元素**，否则高度推算会把下面的内容顶出可见区、出现滚动条而错位。 */}
      <div className="web-browser__host" ref={hostRef} />
    </div>
  )
}
