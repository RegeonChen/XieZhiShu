import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { splitHtmlBlocks, splitTextIntoChunks } from '../lib/incremental'
import { zhCN } from '../i18n/zh-CN'

/**
 * 大内容"分批进 DOM"组件（Phase 8 / S2）。
 *
 * 为什么需要：docx 的 HTML 与纯文本正文都是一整块字符串。一次性塞进 DOM 时，
 * 年鉴式的几百页 Word / 数十万字 TXT 会让界面长时间无响应（用户实测"打开和渲染极慢"）。
 * 这里首屏只渲染前若干块，滚到末尾附近再追加下一批；并提供「全部展开」按钮。
 *
 * ⚠ Phase 9 / S4 起**不再有"定位优先"**：句子级定位与高亮已删除（用户裁定只报"页/段"），
 * 位置由生成期锚点给出，Word/WPS 只报"第 N 段"、不在正文里搜索，因此本组件不需要
 * 提前把某一块渲染出来。
 */

/** 每批追加的块数（HTML） */
const HTML_BATCH = 200
/** 每批追加的行数（纯文本） */
const TEXT_BATCH = 800
/** 提前追加的触发距离 */
const LOAD_MARGIN = '800px 0px'

function useBatchReveal(
  total: number,
  batch: number,
  /** 必须**至少**渲染到第几块（"高亮块优先渲染"：否则高亮落在还没进 DOM 的文本上就看不见） */
  atLeast = 0
): {
  shown: number
  sentinelRef: React.MutableRefObject<HTMLDivElement | null>
  revealAll: () => void
} {
  const floor = Math.max(Math.min(total, batch), Math.min(total, atLeast))
  const [shown, setShown] = useState(() => floor)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setShown((n) => Math.max(n, floor))
  }, [floor])

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
export function IncrementalHtml({
  html,
  className
}: {
  html: string
  className?: string
}): React.JSX.Element {
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

/** 纯文本正文：按行分批追加；可对某段字符区间做一次性高亮（1.6 秒后自动消失） */
export function IncrementalText({
  text,
  className,
  flash
}: {
  text: string
  className?: string
  /**
   * 高亮区间（2026-10-03 用户裁定新增）：**来源正文**里的字符区间，必定包含目标。
   * 纯文本是我们自己渲染的，所以这里能精确到字符；PDF 走画布覆盖层（见 PdfViewer）。
   */
  flash?: { start: number; end: number; nonce: number } | null
}): React.JSX.Element {
  const chunks = useMemo(() => splitTextIntoChunks(text, TEXT_BATCH), [text])
  /** 高亮所在的分块（分批渲染时它必须先渲染出来，否则高亮"看不见"） */
  const flashChunk = useMemo(() => {
    if (!flash) return -1
    let offset = 0
    for (let i = 0; i < chunks.length; i++) {
      const next = offset + chunks[i].length
      if (flash.start < next) return i
      offset = next
    }
    return chunks.length - 1
  }, [chunks, flash])
  const { shown, sentinelRef, revealAll } = useBatchReveal(chunks.length, 4, flashChunk >= 0 ? flashChunk + 1 : 0)
  const flashRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!flash) return
    const el = flashRef.current
    if (el) el.scrollIntoView({ block: 'center' })
  }, [flash])

  const head = chunks.slice(0, shown).join('')
  // 只有高亮起点落在已渲染范围内才切分（否则整块照旧渲染，等高亮出现时再补）
  const marked =
    flash && flash.start < head.length
      ? {
          before: head.slice(0, flash.start),
          mid: head.slice(flash.start, Math.min(flash.end, head.length)),
          after: head.slice(Math.min(flash.end, head.length))
        }
      : null

  return (
    <>
      <pre className={className}>
        {marked ? (
          <>
            {marked.before}
            <span className="incremental__flash" key={flash!.nonce} ref={flashRef}>
              {marked.mid}
            </span>
            {marked.after}
          </>
        ) : (
          head
        )}
      </pre>
      <div ref={sentinelRef} className="incremental__sentinel" aria-hidden="true" />
      <LoadMoreBar remaining={chunks.length - shown} onRevealAll={revealAll} />
    </>
  )
}
