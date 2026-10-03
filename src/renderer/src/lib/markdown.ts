/**
 * markdown.ts —— 对话回复的**轻量 Markdown 解析**（2026-10-03 用户要求：模型回复有时是 Markdown，需渲染）。
 *
 * 为什么自己写而不是引依赖：
 *  - 项目里没有 markdown 依赖，而模型回复用到的语法就是标题/粗体/列表/代码/引用/表格这几样；
 *  - **安全性**：本解析器只产出**结构化数据**，由 `MarkdownText.tsx` 建成 React 元素，
 *    全程不拼 HTML 字符串、不用 `dangerouslySetInnerHTML`，所以模型回复里的 `<script>` 之类
 *    只会当作普通文字显示（外部内容一律视为不可信输入）；
 *  - 可单测（本项目内联测试只覆盖 `src/**\/*.ts`）。
 *
 * 容错口径：**认不出来的行按普通段落显示，绝不丢内容**。
 */

export type MdHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

export interface MdTable {
  header: string[]
  /** 分隔行里的对齐标记（`---` / `:--` / `--:` / `:-:`） */
  align: ('left' | 'center' | 'right')[]
  rows: string[][]
}

export type MdBlock =
  | { type: 'heading'; level: MdHeadingLevel; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'table'; table: MdTable }
  | { type: 'rule' }

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strike'; text: string }
  | { type: 'link'; text: string; href: string }

/** 列表项 / 引用块用：去掉行首缩进后的内容（缩进层级由调用方决定，当前只做单层） */
const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const FENCE_RE = /^\s*(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/
const QUOTE_RE = /^\s*>\s?(.*)$/
const RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
/** 表格分隔行：`| --- | :--: |` */
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((c) => c.trim())
}

function tableAlign(sep: string): ('left' | 'center' | 'right')[] {
  return splitTableRow(sep).map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/**
 * 把 Markdown 切成块。空行分块；代码围栏内**原样保留**（含空行与缩进）。
 * 相邻的列表行合并成一个列表；相邻的引用行合并成一个引用块。
 */
export function parseMarkdownBlocks(src: string): MdBlock[] {
  const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 代码围栏
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1]
      const lang = fence[2] ?? ''
      const body: string[] = []
      i += 1
      while (i < lines.length) {
        const close = FENCE_RE.exec(lines[i])
        if (close && close[1] === marker) {
          i += 1
          break
        }
        body.push(lines[i])
        i += 1
      }
      blocks.push({ type: 'code', lang, text: body.join('\n') })
      continue
    }

    // 空行
    if (!line.trim()) {
      i += 1
      continue
    }

    // 分隔线（必须在列表之前判断，否则 `---` 会被当成列表项）
    if (RULE_RE.test(line)) {
      blocks.push({ type: 'rule' })
      i += 1
      continue
    }

    // 标题
    const heading = HEADING_RE.exec(line)
    if (heading) {
      blocks.push({
        type: 'heading',
        level: Math.min(6, Math.max(1, heading[1].length)) as MdHeadingLevel,
        text: heading[2].trim()
      })
      i += 1
      continue
    }

    // 表格：当前行含 `|`、下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitTableRow(line)
      const align = tableAlign(lines[i + 1])
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]))
        i += 1
      }
      blocks.push({ type: 'table', table: { header, align, rows } })
      continue
    }

    // 引用（连续行合并）
    if (QUOTE_RE.test(line)) {
      const buf: string[] = []
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i])
        if (!m) break
        buf.push(m[1])
        i += 1
      }
      blocks.push({ type: 'quote', text: buf.join('\n').trim() })
      continue
    }

    // 列表（连续同类型行合并；有序号时记住起始编号）
    const list = LIST_RE.exec(line)
    if (list) {
      const ordered = /\d/.test(list[2])
      const start = ordered ? Number(list[2].replace(/[.)]$/, '')) || 1 : 1
      const items: string[] = []
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i])
        if (!m) {
          // 列表项的续行（缩进 2+ 空格且不是新的列表项）挂到上一项
          if (items.length > 0 && /^\s{2,}\S/.test(lines[i])) {
            items[items.length - 1] += '\n' + lines[i].trim()
            i += 1
            continue
          }
          break
        }
        if (/\d/.test(m[2]) !== ordered) break
        items.push(m[3])
        i += 1
      }
      blocks.push({ type: 'list', ordered, start, items })
      continue
    }

    // 普通段落（连续非空行合并为一段，保留换行为软换行）
    const buf: string[] = [line.trim()]
    i += 1
    while (i < lines.length) {
      const next = lines[i]
      if (!next.trim()) break
      if (
        FENCE_RE.test(next) ||
        HEADING_RE.test(next) ||
        RULE_RE.test(next) ||
        QUOTE_RE.test(next) ||
        LIST_RE.test(next) ||
        next.includes('|')
      ) {
        break
      }
      buf.push(next.trim())
      i += 1
    }
    blocks.push({ type: 'paragraph', text: buf.join('\n') })
  }
  return blocks
}

/** 只放行 http(s) 链接；其它（javascript:、data:、file: 等）当作普通文字 */
export function safeHref(href: string): string | null {
  const h = (href ?? '').trim()
  if (!/^https?:\/\//i.test(h)) return null
  return h
}

/**
 * 行内解析：粗体 / 斜体 / 行内代码 / 删除线 / 链接。
 * 用**单趟扫描**按最先出现的标记切分，避免正则嵌套回溯；认不出的标记原样作文字。
 */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = []
  const src = text ?? ''
  let buf = ''
  const flush = (): void => {
    if (buf) {
      out.push({ type: 'text', text: buf })
      buf = ''
    }
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    // 行内代码（**最先判定**，其中的 `*` `_` 不当标记）
    if (ch === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ type: 'code', text: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    // 链接 [文字](地址)
    if (ch === '[') {
      const close = src.indexOf('](', i + 1)
      const end = close >= 0 ? src.indexOf(')', close + 2) : -1
      if (close > i && end > close + 2) {
        const label = src.slice(i + 1, close)
        const href = safeHref(src.slice(close + 2, end))
        if (href) {
          flush()
          out.push({ type: 'link', text: label, href })
          i = end + 1
          continue
        }
      }
    }
    // 粗体 / 斜体（`**` 优先）。只要求"标记内侧不是空白"：
    // `*斜体*`（中文里常在前面带空格）要能识别，而 `3 * 4 * 5` 这类会被内侧空白挡掉。
    if (ch === '*' || ch === '_') {
      const double = src.startsWith(ch + ch, i)
      const marker = double ? ch + ch : ch
      const end = src.indexOf(marker, i + marker.length)
      const inner = end > i ? src.slice(i + marker.length, end) : ''
      const valid = end > i && inner.length > 0 && inner.trim() === inner
      if (valid) {
        flush()
        out.push({ type: double ? 'bold' : 'italic', text: inner })
        i = end + marker.length
        continue
      }
    }
    // 删除线
    if (src.startsWith('~~', i)) {
      const end = src.indexOf('~~', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ type: 'strike', text: src.slice(i + 2, end) })
        i = end + 2
        continue
      }
    }
    buf += ch
    i += 1
  }
  flush()
  return out.length > 0 ? out : [{ type: 'text', text: src }]
}

/* ------------------------------ 单测 ------------------------------ */

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('chat markdown parsing (2026-10-03)', () => {
    it('按块解析：标题 / 段落 / 列表 / 引用 / 代码 / 分隔线', () => {
      const blocks = parseMarkdownBlocks(
        [
          '# 一级标题',
          '## 二级标题',
          '',
          '第一段',
          '换行仍在同一段',
          '',
          '- 甲',
          '- 乙',
          '',
          '1. 一',
          '2. 二',
          '',
          '> 引用第一行',
          '> 引用第二行',
          '',
          '```ts',
          'const a = 1',
          '',
          'const b = 2',
          '```',
          '',
          '---'
        ].join('\n')
      )
      expect(blocks.map((b) => b.type)).toEqual([
        'heading',
        'heading',
        'paragraph',
        'list',
        'list',
        'quote',
        'code',
        'rule'
      ])
      expect(blocks[0]).toEqual({ type: 'heading', level: 1, text: '一级标题' })
      expect(blocks[2]).toEqual({ type: 'paragraph', text: '第一段\n换行仍在同一段' })
      expect(blocks[3]).toEqual({ type: 'list', ordered: false, start: 1, items: ['甲', '乙'] })
      expect(blocks[4]).toEqual({ type: 'list', ordered: true, start: 1, items: ['一', '二'] })
      expect(blocks[5]).toEqual({ type: 'quote', text: '引用第一行\n引用第二行' })
      // 代码块内的空行与内容原样保留
      expect(blocks[6]).toEqual({ type: 'code', lang: 'ts', text: 'const a = 1\n\nconst b = 2' })
    })

    it('表格：表头 + 对齐 + 数据行', () => {
      const blocks = parseMarkdownBlocks('| 年份 | 数量 |\n| :--- | ---: |\n| 2022 | 2 |\n| 2024 | 2 |')
      expect(blocks).toHaveLength(1)
      const t = blocks[0]
      expect(t.type).toBe('table')
      if (t.type === 'table') {
        expect(t.table.header).toEqual(['年份', '数量'])
        expect(t.table.align).toEqual(['left', 'right'])
        expect(t.table.rows).toEqual([
          ['2022', '2'],
          ['2024', '2']
        ])
      }
    })

    it('列表项续行挂到上一项；未闭合围栏不丢内容', () => {
      const blocks = parseMarkdownBlocks('- 第一项\n  续行\n- 第二项\n\n普通段落')
      expect(blocks[0]).toEqual({ type: 'list', ordered: false, start: 1, items: ['第一项\n续行', '第二项'] })
      expect(blocks[1]).toEqual({ type: 'paragraph', text: '普通段落' })
      // 未闭合围栏 → 其余内容整体作为代码块（不丢内容）
      const open = parseMarkdownBlocks('```\n没闭合的代码\n还有一行')
      expect(open).toEqual([{ type: 'code', lang: '', text: '没闭合的代码\n还有一行' }])
    })

    it('行内解析：粗体 / 斜体 / 行内代码 / 删除线 / 链接（只放行 http(s)）', () => {
      expect(parseInline('这是 **粗体** 与 *斜体* 与 `代码` 与 ~~删除~~')).toEqual([
        { type: 'text', text: '这是 ' },
        { type: 'bold', text: '粗体' },
        { type: 'text', text: ' 与 ' },
        { type: 'italic', text: '斜体' },
        { type: 'text', text: ' 与 ' },
        { type: 'code', text: '代码' },
        { type: 'text', text: ' 与 ' },
        { type: 'strike', text: '删除' }
      ])
      expect(parseInline('[官网](https://example.com)')).toEqual([
        { type: 'link', text: '官网', href: 'https://example.com' }
      ])
      // 危险协议按普通文字（不生成链接）
      expect(parseInline('[点我](javascript:alert(1))')).toEqual([{ type: 'text', text: '[点我](javascript:alert(1))' }])
      // 行内代码里的星号不算标记
      expect(parseInline('`a * b`')).toEqual([{ type: 'code', text: 'a * b' }])
      // 未闭合的标记原样保留
      expect(parseInline('**没闭合')).toEqual([{ type: 'text', text: '**没闭合' }])
      // 乘法不该被当成斜体
      expect(parseInline('3 * 4 = 12')).toEqual([{ type: 'text', text: '3 * 4 = 12' }])
    })

    it('空输入与纯文本不产生块（不丢内容）', () => {
      expect(parseMarkdownBlocks('')).toEqual([])
      expect(parseMarkdownBlocks('就是一句普通话')).toEqual([{ type: 'paragraph', text: '就是一句普通话' }])
    })
  })
}
