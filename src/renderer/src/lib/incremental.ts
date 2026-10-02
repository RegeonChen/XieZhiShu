/**
 * incremental.ts —— 大文档"分批进 DOM"的纯逻辑（Phase 8 / S2）。
 *
 * 背景：docx 走 `sources:renderHtml` 拿到的是**整篇 HTML**，纯文本则是一整块字符串。
 * 原实现一次性把它们塞进 DOM（`dangerouslySetInnerHTML` / `<pre>{全部}</pre>`）——
 * 年鉴式的几百页 Word 或数十万字 TXT 会造成"打开即长时间卡住"。现在按块/按行分批追加，
 * 首屏只建少量节点，滚动到末尾再继续（用户看不到差别，但打开速度差一个量级）。
 *
 * 放在 .ts 而不是组件里：本项目的内联单测只覆盖 `src/**\/*.ts`。
 */

/** HTML 里的空元素（没有闭合标签，不参与深度计数） */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
])

function tagNameOf(raw: string): string {
  return raw.replace(/^<\/?/, '').replace(/\/?>$/, '').split(/[\s/>]/)[0]?.toLowerCase() ?? ''
}

/**
 * 把一段 HTML **按顶层元素切成块**（纯函数、可在 node 里单测）。
 *
 * 做法：扫描标签，维护"嵌套深度"；深度回到 0 时收一刀。
 * - 空元素（`<br>` `<img>` 等）不加深度；
 * - 注释 `<!-- -->`、`<script>/<style>` 内容整体跳过（其内部的 `<` 不参与计数）；
 * - 属性值里的 `>`（如 `title="a > b"`）不会误判（引号内跳过）；
 * - 前后游离的文本（无标签包裹）单独成块。
 * 解析不出来时**不会丢内容**：最坏情况是块数变少（退化为"一大块"），仍然完整。
 */
export function splitHtmlBlocks(html: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  const n = html.length
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break
    // 注释
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    // <script> / <style>：整段跳过（内部可能含 '<'）
    const special = /^<(script|style)\b/i.exec(html.slice(lt, lt + 8))
    if (special) {
      const close = html.toLowerCase().indexOf('</' + special[1].toLowerCase(), lt)
      i = close < 0 ? n : close + special[1].length + 3
      continue
    }
    // 找到标签结束的 '>'（跳过引号内的）
    let j = lt + 1
    let quote: string | null = null
    while (j < n) {
      const ch = html[j]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      j += 1
    }
    const tag = html.slice(lt, Math.min(j + 1, n))
    const name = tagNameOf(tag)
    const isClose = tag.startsWith('</')
    const selfClosing = /\/>$/.test(tag) || VOID_TAGS.has(name)
    if (isClose) {
      depth = Math.max(0, depth - 1)
      if (depth === 0) {
        out.push(html.slice(start, j + 1))
        start = j + 1
      }
    } else if (!selfClosing) {
      depth += 1
    } else if (depth === 0) {
      // 顶层自闭合元素（如顶层的 <img>）
      out.push(html.slice(start, j + 1))
      start = j + 1
    }
    i = j + 1
  }
  const rest = html.slice(start)
  if (rest.trim()) out.push(rest)
  return out.filter((b) => b.length > 0)
}

/**
 * 把纯文本**按行分批**（纯函数）。保留换行：每块自带结尾 `\n`，
 * 直接拼接所有块 === 原文（这一条有单测钉住，避免"分批"把内容改掉）。
 */
export function splitTextIntoChunks(text: string, linesPerChunk: number): string[] {
  const size = Math.max(1, Math.floor(linesPerChunk))
  const lines = (text ?? '').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i += size) {
    out.push(lines.slice(i, i + size).join('\n') + (i + size < lines.length ? '\n' : ''))
  }
  return out.length > 0 ? out : ['']
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('incremental rendering helpers (Phase 8 / S2)', () => {
    it('splits flat block markup into top-level blocks', () => {
      const html = '<h1>标题</h1><p>第一段</p><p>第二段</p>'
      expect(splitHtmlBlocks(html)).toEqual(['<h1>标题</h1>', '<p>第一段</p>', '<p>第二段</p>'])
    })

    it('keeps nested elements inside one block and handles void tags', () => {
      const html = '<div><p>a<br>b</p><img src="x.png"></div><p>下一块</p>'
      expect(splitHtmlBlocks(html)).toEqual(['<div><p>a<br>b</p><img src="x.png"></div>', '<p>下一块</p>'])
    })

    it('does not split on ">" inside attribute values or on comments / scripts', () => {
      const html = '<p title="a > b">x</p><!-- <p>注释</p> --><script>if (1 < 2) {}</script><p>尾</p>'
      const blocks = splitHtmlBlocks(html)
      // 注释与 script 是"非元素"内容，会被并入相邻块（不单独成块、更不丢内容）
      expect(blocks).toHaveLength(2)
      expect(blocks[0]).toBe('<p title="a > b">x</p>')
      expect(blocks[1]).toContain('<script>')
      expect(blocks[1].endsWith('<p>尾</p>')).toBe(true)
      // 最强断言：所有块拼回去 === 原文（分批渲染绝不能改动内容）
      expect(blocks.join('')).toBe(html)
    })

    it('treats loose leading/trailing text as its own block (never drops content)', () => {
      const html = '游离文本<p>段落</p>尾部文本'
      const blocks = splitHtmlBlocks(html)
      expect(blocks.join('')).toBe(html)
    })

    it('concatenating the text chunks reproduces the original text exactly', () => {
      const text = Array.from({ length: 25 }, (_, i) => `第 ${i + 1} 行`).join('\n')
      const chunks = splitTextIntoChunks(text, 10)
      expect(chunks).toHaveLength(3)
      expect(chunks.join('')).toBe(text)
      // 单行输入、空输入都不能丢
      expect(splitTextIntoChunks('只有一行', 10).join('')).toBe('只有一行')
      expect(splitTextIntoChunks('', 10).join('')).toBe('')
    })
  })
}
