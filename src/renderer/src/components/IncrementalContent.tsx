import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { splitHtmlBlocks, splitTextIntoChunks } from '../lib/incremental'
import { locateInBlocks } from '../lib/locate'
import { zhCN } from '../i18n/zh-CN'

/**
 * 大内容"分批进 DOM"组件（Phase 8 / S2；S1 起支持"定位优先"）。
 *
 * 为什么需要：docx 的 HTML 与纯文本正文都是一整块字符串。一次性塞进 DOM 时，
 * 年鉴式的几百页 Word / 数十万字 TXT 会让界面长时间无响应（用户实测"打开和渲染极慢"）。
 * 这里首屏只渲染前若干块，滚到末尾附近再追加下一批；并提供「全部展开」按钮。
 *
 * S1 起的关键约束：**要定位某一段引文时，命中所在的那一块必须先渲染出来**，否则"在 DOM 里找"
 * 会找不到、界面会谎报"未找到"。所以传了 `needles` 时：
 *   - 先在字符串层定位（`locateInBlocks`）；
 *   - 命中 → 直接把首批渲染量放大到"命中块 + 余量"；
 *   - 未命中 → **展开全部**（这样"未找到"才是真的把全文都搜过了）。
 * 每次追加完成都会回调 `onReveal`，查看器据此重跑高亮（DOM 变了要重新标记）。
 */

/** 每批追加的块数（HTML） */
const HTML_BATCH = 200
/** 每批追加的行数（纯文本） */
const TEXT_BATCH = 800
/** 提前追加的触发距离 */
const LOAD_MARGIN = '800px 0px'
/** 定位命中后，命中块之后再多渲染这么多块（给出上下文，也够高亮标记） */
const REVEAL_MARGIN = 5

function useBatchReveal(
  total: number,
  batch: number,
  initial: number
): {
  shown: number
  sentinelRef: React.MutableRefObject<HTMLDivElement | null>
  revealAll: () => void
} {
  const [shown, setShown] = useState(() => Math.min(total, Math.max(batch, initial)))
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setShown(Math.min(total, Math.max(batch, initial)))
  }, [total, batch, initial])

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

interface IncrementalProps {
  /** 定位锚（已归一化的候选检索词）；给了就要保证命中块先渲染出来 */
  needles?: string[]
  /** 每次 DOM 追加完成后回调（查看器据此重跑高亮） */
  onReveal?: () => void
}

/** docx 转出的 HTML：按顶层块分批追加（只用 insertAdjacentHTML 追加新增块，不回写已渲染内容） */
export function IncrementalHtml({
  html,
  className,
  needles,
  onReveal
}: IncrementalProps & { html: string; className?: string }): React.JSX.Element {
  const blocks = useMemo(() => splitHtmlBlocks(html), [html])
  const hostRef = useRef<HTMLDivElement | null>(null)
  const appendedRef = useRef(0)
  const blocksRef = useRef<string[]>(blocks)
  const revealRef = useRef(onReveal)
  revealRef.current = onReveal

  const searching = !!needles && needles.length > 0
  const hit = useMemo(
    () => (searching ? locateInBlocks(blocks, needles as string[], { html: true }) : null),
    [blocks, needles, searching]
  )
  // 命中 → 渲染到命中块 + 余量；未命中 → 全部展开（保证"未找到"是真的搜过全文）
  const initial = !searching ? HTML_BATCH : hit ? Math.min(blocks.length, hit.blockIndex + 1 + REVEAL_MARGIN) : blocks.length
  const { shown, sentinelRef, revealAll } = useBatchReveal(blocks.length, HTML_BATCH, initial)

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
    revealRef.current?.()
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
export function IncrementalText({
  text,
  className,
  needles,
  onReveal
}: IncrementalProps & { text: string; className?: string }): React.JSX.Element {
  const chunks = useMemo(() => splitTextIntoChunks(text, TEXT_BATCH), [text])
  const revealRef = useRef(onReveal)
  revealRef.current = onReveal
  const shownRef = useRef(0)

  const searching = !!needles && needles.length > 0
  const hit = useMemo(
    () => (searching ? locateInBlocks(chunks, needles as string[]) : null),
    [chunks, needles, searching]
  )
  const initial = !searching ? 4 : hit ? Math.min(chunks.length, hit.blockIndex + 2) : chunks.length
  const { shown, sentinelRef, revealAll } = useBatchReveal(chunks.length, 4, initial)

  // 追加完成后回调（纯文本用 <pre>+字符串渲染，故只在 shown 变化时通知一次）
  useEffect(() => {
    if (shownRef.current === shown) return
    shownRef.current = shown
    revealRef.current?.()
  }, [shown])

  return (
    <>
      <pre className={className}>{chunks.slice(0, shown).join('')}</pre>
      <div ref={sentinelRef} className="incremental__sentinel" aria-hidden="true" />
      <LoadMoreBar remaining={chunks.length - shown} onRevealAll={revealAll} />
    </>
  )
}
