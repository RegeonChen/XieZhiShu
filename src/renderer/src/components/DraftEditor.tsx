import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import { Markdown } from 'tiptap-markdown'
import { zhCN } from '../i18n/zh-CN'

interface SegmentSourceItem {
  sourceId: string
  position: string
  quote?: string
  sourceTitle?: string
}
interface SegmentItem {
  id: string
  heading?: string
  content: string
  aiGenerated: boolean
  sources: SegmentSourceItem[]
}
interface DraftItem {
  id: string
  versionNumber: number
  segments: SegmentItem[]
}

/** 编辑器扩展（每个片段实例独立创建） */
function createExtensions() {
  return [
    StarterKit,
    Underline,
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    // Markdown 序列化/解析：内容以 Markdown 存储（下划线等无原生语法的格式以 HTML 形式往返）
    Markdown.configure({ html: true, tightLists: true })
  ]
}

function ToolbarButton({ title, onClick, active, disabled, children }: {
  title: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={`draft-editor__btn${active ? ' is-active' : ''}`}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

function EditorToolbar({ editor }: { editor: Editor | null }) {
  const run = (fn: (e: Editor) => void): void => {
    if (editor) fn(editor)
  }
  const headingLevel: number = editor?.isActive('heading') ? (editor.getAttributes('heading').level as number) : 0
  const t = zhCN.draftEditor.toolbar

  return (
    <div className="draft-editor__toolbar">
      <ToolbarButton title={t.bold} active={editor?.isActive('bold')} disabled={!editor} onClick={() => run((e) => e.chain().focus().toggleBold().run())}>
        <strong>B</strong>
      </ToolbarButton>
      <ToolbarButton title={t.italic} active={editor?.isActive('italic')} disabled={!editor} onClick={() => run((e) => e.chain().focus().toggleItalic().run())}>
        <em>I</em>
      </ToolbarButton>
      <ToolbarButton title={t.underline} active={editor?.isActive('underline')} disabled={!editor} onClick={() => run((e) => e.chain().focus().toggleUnderline().run())}>
        <u>U</u>
      </ToolbarButton>

      <span className="draft-editor__sep" />

      <select
        className="draft-editor__heading"
        value={headingLevel}
        disabled={!editor}
        title={t.heading}
        onChange={(e) => {
          const v = Number(e.target.value)
          run((ed) => {
            if (v === 0) ed.chain().focus().setParagraph().run()
            else ed.chain().focus().setHeading({ level: v as 1 | 2 | 3 }).run()
          })
        }}
      >
        <option value={0}>{t.paragraph}</option>
        <option value={1}>H1</option>
        <option value={2}>H2</option>
        <option value={3}>H3</option>
      </select>

      <span className="draft-editor__sep" />

      <ToolbarButton title={t.bulletList} active={editor?.isActive('bulletList')} disabled={!editor} onClick={() => run((e) => e.chain().focus().toggleBulletList().run())}>
        •≡
      </ToolbarButton>
      <ToolbarButton title={t.orderedList} active={editor?.isActive('orderedList')} disabled={!editor} onClick={() => run((e) => e.chain().focus().toggleOrderedList().run())}>
        1≡
      </ToolbarButton>

      <span className="draft-editor__sep" />

      <ToolbarButton title={t.insertTable} disabled={!editor} onClick={() => run((e) => e.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run())}>
        ☐
      </ToolbarButton>
      <ToolbarButton title={t.addRow} disabled={!editor} onClick={() => run((e) => e.chain().focus().addRowAfter().run())}>
        ⊞
      </ToolbarButton>
      <ToolbarButton title={t.deleteRow} disabled={!editor} onClick={() => run((e) => e.chain().focus().deleteRow().run())}>
        ⊟
      </ToolbarButton>
      <ToolbarButton title={t.addColumn} disabled={!editor} onClick={() => run((e) => e.chain().focus().addColumnAfter().run())}>
        ⊞
      </ToolbarButton>
      <ToolbarButton title={t.deleteColumn} disabled={!editor} onClick={() => run((e) => e.chain().focus().deleteColumn().run())}>
        ⊟
      </ToolbarButton>
      <ToolbarButton title={t.deleteTable} disabled={!editor} onClick={() => run((e) => e.chain().focus().deleteTable().run())}>
        ✕
      </ToolbarButton>

      <span className="draft-editor__sep" />

      <ToolbarButton title={t.undo} disabled={!editor} onClick={() => run((e) => e.chain().focus().undo().run())}>
        ↶
      </ToolbarButton>
      <ToolbarButton title={t.redo} disabled={!editor} onClick={() => run((e) => e.chain().focus().redo().run())}>
        ↷
      </ToolbarButton>
    </div>
  )
}

/** 单个片段的 TipTap 编辑器：Markdown 初始化 + 防抖自动保存 */
function SegmentEditor({ segment, onActive, onDirty }: {
  segment: SegmentItem
  onActive: (editor: Editor) => void
  onDirty: () => void
}) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [expanded, setExpanded] = useState(false)
  const timerRef = useRef<number | null>(null)

  const scheduleSave = useCallback((md: string) => {
    setStatus('saving')
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(async () => {
      const res = await window.api.updateSegment(segment.id, md)
      setStatus(res.ok ? 'saved' : 'error')
      timerRef.current = null
    }, 800)
  }, [segment.id])

  const editor = useEditor({
    extensions: createExtensions(),
    content: segment.content || '',
    onUpdate: ({ editor }) => scheduleSave(editor.storage.markdown.getMarkdown()),
    onFocus: ({ editor }) => onActive(editor),
    onSelectionUpdate: () => onDirty(),
    onTransaction: () => onDirty()
  })

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  const statusText =
    status === 'saving' ? zhCN.draftEditor.saving
    : status === 'saved' ? zhCN.draftEditor.saved
    : status === 'error' ? zhCN.draftEditor.saveFailed
    : ''

  return (
    <section className="draft-editor__segment">
      {segment.heading ? <h5 className="draft-editor__segment-heading">{segment.heading}</h5> : null}
      <EditorContent editor={editor} />
      <div className="draft-editor__segment-foot">
        {segment.sources.length > 0 ? (
          <div className="writing-workspace__segment-sources">
            <button type="button" className="writing-workspace__sources-toggle" onClick={() => setExpanded((v) => !v)}>
              {zhCN.writingWorkspace.segmentSources.replace('{count}', String(segment.sources.length))}
              <span className="writing-workspace__sources-arrow">{expanded ? '▾' : '▸'}</span>
            </button>
            {expanded ? (
              <ul className="writing-workspace__source-list">
                {segment.sources.map((src, i) => (
                  <li key={i} className="writing-workspace__source">
                    <span className="writing-workspace__source-line">
                      {zhCN.writingWorkspace.segmentSourceLine
                        .replace('{title}', src.sourceTitle ?? src.sourceId)
                        .replace('{position}', src.position || '未知位置')}
                    </span>
                    {src.quote ? (
                      <span className="writing-workspace__source-quote">
                        {zhCN.writingWorkspace.segmentQuote.replace('{quote}', src.quote)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {statusText ? <span className={`draft-editor__status is-${status}`}>{statusText}</span> : null}
      </div>
    </section>
  )
}

/** 初稿文档编辑器：共享工具栏 + 逐片段 TipTap 编辑器 + 来源标注 */
function DraftEditor({ draft }: { draft: DraftItem }) {
  const [active, setActive] = useState<Editor | null>(null)
  const [tick, setTick] = useState(0)
  const bump = useCallback(() => setTick((t) => t + 1), [])
  const handleActive = useCallback((editor: Editor) => setActive(editor), [])

  // 依赖 tick，让工具栏随选中/选区变化刷新激活态
  void tick

  return (
    <div className="draft-editor">
      <EditorToolbar editor={active} />
      <div className="draft-editor__segments">
        {draft.segments.length === 0 ? (
          <p className="source-list__status">{zhCN.writingWorkspace.noDraft}</p>
        ) : (
          draft.segments.map((seg) => (
            <SegmentEditor key={seg.id} segment={seg} onActive={handleActive} onDirty={bump} />
          ))
        )}
      </div>
    </div>
  )
}

export default DraftEditor
