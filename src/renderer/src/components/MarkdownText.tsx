import { useMemo } from 'react'
import { parseInline, parseMarkdownBlocks, type MdBlock, type MdInline } from '../lib/markdown'

/**
 * MarkdownText.tsx —— 对话回复的 Markdown 渲染（2026-10-03 用户要求）。
 *
 * 安全口径：**只把解析结果建成 React 元素**，不拼 HTML、不用 `dangerouslySetInnerHTML`，
 * 所以模型回复里的 HTML/脚本只会当普通文字显示（外部内容一律视为不可信输入）。
 *
 * 与来源引用的配合：行内**文字**节点交给 `renderText`（ChatPanel 在那里把 `#N` 变成可点链接），
 * 于是"Markdown 里的引用编号"照样能点开原文。
 *
 * 字号口径（用户明确要求"标题字体不要太大"）：标题只比正文略大（13.5–15px）且加粗，靠层次而非字号区分。
 */

interface MarkdownTextProps {
  text: string
  /** 渲染纯文字片段（用于 `#N` 来源引用）；缺省时直接输出文字 */
  renderText?: (text: string) => React.ReactNode
  /** 追加在末尾的节点（如流式光标） */
  trailing?: React.ReactNode
}

function inlineNodes(tokens: MdInline[], renderText?: (text: string) => React.ReactNode): React.ReactNode[] {
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'bold':
        return <strong key={i}>{t.text}</strong>
      case 'italic':
        return <em key={i}>{t.text}</em>
      case 'strike':
        return <s key={i}>{t.text}</s>
      case 'code':
        return (
          <code className="chat-panel__md-code" key={i}>
            {t.text}
          </code>
        )
      case 'link':
        return (
          <a
            className="chat-panel__md-link"
            key={i}
            href={t.href}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
          >
            {t.text}
          </a>
        )
      default:
        return <span key={i}>{renderText ? renderText(t.text) : t.text}</span>
    }
  })
}

function blockNode(block: MdBlock, key: number, renderText?: (text: string) => React.ReactNode): React.ReactNode {
  switch (block.type) {
    case 'heading':
      // 不生成 <h1..h6>：避免继承各处大标题样式，也避免用户说的"标题字太大"
      return (
        <div className={`chat-panel__md-heading chat-panel__md-heading--${block.level}`} key={key}>
          {inlineNodes(parseInline(block.text), renderText)}
        </div>
      )
    case 'code':
      return (
        <pre className="chat-panel__md-pre" key={key}>
          <code>{block.text}</code>
        </pre>
      )
    case 'quote':
      return (
        <blockquote className="chat-panel__md-quote" key={key}>
          {block.text.split('\n').map((line, i) => (
            <div key={i}>{inlineNodes(parseInline(line), renderText)}</div>
          ))}
        </blockquote>
      )
    case 'rule':
      return <hr className="chat-panel__md-rule" key={key} />
    case 'table':
      return (
        <div className="chat-panel__md-tablewrap" key={key}>
          <table className="chat-panel__md-table">
            <thead>
              <tr>
                {block.table.header.map((cell, i) => (
                  <th key={i} style={{ textAlign: block.table.align[i] ?? 'left' }}>
                    {inlineNodes(parseInline(cell), renderText)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.table.rows.map((row, r) => (
                <tr key={r}>
                  {block.table.header.map((_, c) => (
                    <td key={c} style={{ textAlign: block.table.align[c] ?? 'left' }}>
                      {inlineNodes(parseInline(row[c] ?? ''), renderText)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'list':
      return (
        <ul className={`chat-panel__md-list${block.ordered ? ' chat-panel__md-list--ordered' : ''}`} key={key}>
          {block.items.map((item, i) => (
            <li key={i}>
              {item.split('\n').map((line, j) => (
                <div key={j}>{inlineNodes(parseInline(line), renderText)}</div>
              ))}
            </li>
          ))}
        </ul>
      )
    default:
      return (
        <p className="chat-panel__md-p" key={key}>
          {block.text.split('\n').map((line, i) => (
            <span key={i}>
              {i > 0 ? <br /> : null}
              {inlineNodes(parseInline(line), renderText)}
            </span>
          ))}
        </p>
      )
  }
}

export default function MarkdownText({ text, renderText, trailing }: MarkdownTextProps): React.JSX.Element {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text])
  return (
    <div className="chat-panel__md">
      {blocks.map((b, i) => blockNode(b, i, renderText))}
      {trailing}
    </div>
  )
}
