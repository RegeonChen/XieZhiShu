import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { splitHtmlBlocks, splitTextIntoChunks } from '../lib/incremental'
import { zhCN } from '../i18n/zh-CN'

/**
 * 大内容"分批进 DOM"组件（Phase 8 / S2）。
 *
 * 为什么需要：docx 的 HTML 与纯文本正文都是一整块字符串。一次性塞进 DOM 时，
 * 年鉴式的几百页 Word / 数十万字 TXT 会让界面长时间无响应（用户实测"打开和渲染极慢"）。
 * 这里首屏只渲染前若干块，滚到末尾附近再追加下一批；并提供「全部展开」按钮（便于用户自己
 * 快速滚到底或做页面内查找）。
 */

/** 每批追加的块数（HTML） */
const HTML_BATCH = 200
/** 每批追加的行数（纯文本） */
const TEXT_BATCH = 800
/** 提前追加的触发距离 */
const LOAD_MARGIN = '800px 0px'

function useBatchReveal(total: number, batch: number): {
  shown: number
  sentinelRef: React.MutableRefObject<HTMLDivElement | null>
  revealAll: () => void
} {
  const [shown, setShown] = useState(batch)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setShown(batch)
  }, [total, batch])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || shown >= total) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((n) => Math.min(total, n + batch))
      },
      { root: null, rootMargin: LOAD_MARGIN, threshold: 0 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [shown, total, batch])

  const revealAll = useCallback(() => setShown(total), [total])
  return { shown, sentinelRef, revealAll }
}

function LoadMoreBar({
  remaining,
  onRevealAll
}: {
  remaining: number
  onRevealAll: () => void
}): React.JSX.Element | null {
  if (remaining <= 0) return null
  return (
    <div className="incremental__more">
      <span className="incremental__more-text">
        {zhCN.sourceViewer.moreRemaining.replace('{n}', String(remaining))}
      </span>
      <button type="button" className="incremental__more-btn" onClick={onRevealAll}>
        {zhCN.sourceViewer.revealAll}
      </button>
    </div>
  )
}

/** docx 转出的 HTML：按顶层块分批追加（只用 insertAdjacentHTML 追加新增块，不回写已渲染内容） */
export function IncrementalHtml({ html, className }: { html: string; className?: string }): React.JSX.Element {
  const blocks = useMemo(() => splitHtmlBlocks(html), [html])
  const hostRef = useRef<HTMLDivElement | null>(null)
  const appendedRef = useRef(0)
  const blocksRef = useRef<string[]>(blocks)
  const { shown, sentinelRef, revealAll } = useBatchReveal(blocks.length, HTML_BATCH)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (blocksRef.current !== blocks) {
      // 换文档：清空重来
      blocksRef.current = blocks
      appendedRef.current = 0
      host.innerHTML = ''
    }
    if (appendedRef.current >= shown) return
    const next = blocks.slice(appendedRef.current, shown).join('')
    host.insertAdjacentHTML('beforeend', next)
    appendedRef.current = shown
  }, [blocks, shown])

  return (
    <>
      <div className={className} ref={hostRef} />
      <div ref={sentinelRef} className="incremental__sentinel" aria-hidden="true" />
      <LoadMoreBar remaining={blocks.length - shown} onRevealAll={revealAll} />
    </>
  )
}

/** 纯文本正文：按行分批追加 */
export function IncrementalText({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const chunks = useMemo(() => splitTextIntoChunks(text, TEXT_BATCH), [text])
  const [shownChunks, setShownChunks] = useState(4)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setShownChunks(4)
  }, [text])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || shownChunks >= chunks.length) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShownChunks((n) => Math.min(chunks.length, n + 4))
        }
      },
      { root: null, rootMargin: LOAD_MARGIN, threshold: 0 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [shownChunks, chunks.length])

  return (
    <>
      <pre className={className}>{chunks.slice(0, shownChunks).join('')}</pre>
      <div ref={sentinelRef} className="incremental__sentinel" aria-hidden="true" />
      <LoadMoreBar remaining={chunks.length - shownChunks} onRevealAll={() => setShownChunks(chunks.length)} />
    </>
  )
}
