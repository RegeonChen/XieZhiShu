import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import type { Transaction } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import { Markdown } from 'tiptap-markdown'
import { zhCN } from '../i18n/zh-CN'
import { copyPlainText } from '../utils/clipboard'
import type { Contradiction } from '../../../shared/types'
import { ContradictionMarker, InvalidContradictionMarker, convertMarkerTextToNodes } from '../editor/contradiction-marker'

interface SegmentItem {
  id: string
  heading?: string
  content: string
  aiGenerated: boolean
  sources: { sourceId: string; position: string; quote?: string; sourceTitle?: string }[]
}
interface DraftItem {
  id: string
  versionNumber: number
  segments: SegmentItem[]
}

interface DraftEditorProps {
  draft: DraftItem
  /** 该稿的矛盾清单（生成响应或 draft:getContradictions 加载；含不在正文的"警告"） */
  contradictions?: Contradiction[]
  /** 点击正文矛盾标注 */
  onContradictionClick?: (seq: number) => void
  /** 工具栏"矛盾"按钮（矛盾总览） */
  onOpenContradictions?: () => void
  /** 工具栏"警告"按钮（不在正文的矛盾警告总览） */
  onOpenWarnings?: () => void
  /** 右键选中文段 → 询问文段来源（Phase 3.7 Task 3.7.5） */
  onAskSource?: (selection: string) => void
  /** 编辑器 undo/redo 引起正文变化时回调当前 Markdown（2026-08-11：撤销采纳后回退矛盾状态） */
  onHistoryChanged?: (markdown: string) => void
}

/**
 * 暴露给父组件的编辑器能力（2026-08-11）：
 * - applyDraftForAdoption：采纳矛盾后应用新整稿（整体替换进入 undo 历史，一次撤销即恢复采纳前正文）；
 * - getMarkdown：读取当前正文 Markdown（注册采纳前快照用）。
 */
export interface DraftEditorHandle {
  /** 应用新的整稿内容（可撤销）；返回应用后的 Markdown */
  applyDraftForAdoption: (nextDraft: DraftItem) => string
  /** 当前编辑器正文 Markdown（空串表示编辑器未就绪） */
  getMarkdown: () => string
}

/** 编辑器扩展（每个编辑器实例独立创建） */
function createExtensions() {
  return [
    StarterKit,
    Underline,
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    ContradictionMarker,
    InvalidContradictionMarker,
    // Markdown 序列化/解析：内容以 Markdown 存储（下划线等无原生语法的格式以 HTML 形式往返）
    Markdown.configure({ html: true, tightLists: true })
  ]
}

/** 初稿片段 → 连续 Markdown（Task 3.4.1：整稿连续显示为一个整体） */
function segmentsToMarkdown(segments: SegmentItem[]): string {
  return segments
    .map((s) => {
      const head = s.heading ? `## ${s.heading}` : ''
      const body = s.content.trim()
      return [head, body].filter(Boolean).join('\n\n')
    })
    .join('\n\n')
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

function EditorToolbar({
  editor,
  pendingContradictions = 0,
  pendingWarnings = 0,
  onOpenContradictions,
  onOpenWarnings
}: {
  editor: Editor | null
  pendingContradictions?: number
  pendingWarnings?: number
  onOpenContradictions?: () => void
  onOpenWarnings?: () => void
}) {
  const run = (fn: (e: Editor) => void): void => {
    if (editor) fn(editor)
  }
  const headingLevel: number = editor?.isActive('heading') ? (editor.getAttributes('heading').level as number) : 0
  const t = zhCN.draftEditor.toolbar
  const [copied, setCopied] = useState(false)

  /** 全文一键复制：把编辑器当前内容的纯文本写入剪贴板 */
  const handleCopyAll = async (): Promise<void> => {
    if (!editor) return
    const text = editor.getText() ?? ''
    const ok = await copyPlainText(text)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

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

      <span className="draft-editor__sep" />

      {/* 矛盾清单入口（Phase 3.7 Task 3.7.3）：显示待处理矛盾数，点击打开矛盾总览 */}
      <ToolbarButton
        title={zhCN.draftEditor.toolbar.contradictionsTitle.replace('{count}', String(pendingContradictions))}
        disabled={!editor}
        onClick={() => onOpenContradictions?.()}
      >
        <span className={`draft-editor__contradiction-btn${pendingContradictions > 0 ? ' has-pending' : ''}`}>
          ⚠ {pendingContradictions > 0 ? zhCN.draftEditor.toolbar.contradictions.replace('{count}', String(pendingContradictions)) : zhCN.draftEditor.toolbar.contradictionsNone}
        </span>
      </ToolbarButton>

      {/* 资料矛盾警告入口（2026-08-11）：不在正文的矛盾 → 警告，与"矛盾"并列，仅查看不落正文 */}
      <ToolbarButton
        title={zhCN.draftEditor.toolbar.warningsTitle.replace('{count}', String(pendingWarnings))}
        disabled={!editor}
        onClick={() => onOpenWarnings?.()}
      >
        <span className={`draft-editor__contradiction-btn is-warning${pendingWarnings > 0 ? ' has-pending' : ''}`}>
          ◉ {pendingWarnings > 0 ? zhCN.draftEditor.toolbar.warnings.replace('{count}', String(pendingWarnings)) : zhCN.draftEditor.toolbar.warningsNone}
        </span>
      </ToolbarButton>

      <span className="draft-editor__sep" />

      <ToolbarButton title={zhCN.draftEditor.copyAll} disabled={!editor} onClick={() => void handleCopyAll()}>
        <span className={`draft-editor__copy${copied ? ' is-copied' : ''}`}>
          {copied ? (
            <span className="draft-editor__copy-check">✓</span>
          ) : (
            <svg className="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          )}
          <span>{copied ? zhCN.draftEditor.copied : zhCN.draftEditor.copyAll}</span>
        </span>
      </ToolbarButton>
    </div>
  )
}

/**
 * 初稿文档编辑器（Task 3.4.1）：整个初稿连续显示为一个整体。
 * 单个 TipTap 编辑器渲染整稿；编辑防抖自动保存（整稿保存，主进程按标题重建片段）。
 * Phase 3.7 Task 3.7.3：正文中的 `【矛盾#N】` 标记加载时转为不可编辑的 ⚠️ 标注节点，
 * 保存时序列化回原标记文本；工具栏"矛盾"按钮显示待处理数并打开矛盾总览。
 */
function DraftEditor(
  {
    draft,
    contradictions = [],
    onContradictionClick,
    onOpenContradictions,
    onOpenWarnings,
    onAskSource,
    onHistoryChanged
  }: DraftEditorProps,
  ref: React.ForwardedRef<DraftEditorHandle>
) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [charCount, setCharCount] = useState(0)
  const timerRef = useRef<number | null>(null)
  // 加载时把标记转节点会产生一次事务（onUpdate 会触发），用该标志跳过首次保存
  const convertedRef = useRef(false)
  // 右键菜单（Phase 3.7 Task 3.7.5：询问文段来源）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; selection: string } | null>(null)

  const initialMarkdown = useRef(segmentsToMarkdown(draft.segments))
  const validSeqs = useMemo(() => new Set(contradictions.map((c) => c.seq)), [contradictions])
  const topicBySeq = useMemo(() => new Map(contradictions.map((c) => [c.seq, c.topic])), [contradictions])
  // 矛盾（在正文或定位未知）与警告（定位审查确认不在正文）分开计数，工具栏两个入口并列展示
  const pendingCount = contradictions.filter((c) => c.inDraft !== false && c.status === 'pending').length
  const pendingWarnings = contradictions.filter((c) => c.inDraft === false && c.status === 'pending').length

  const scheduleSave = useCallback((md: string) => {
    setStatus('saving')
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(async () => {
      const res = await window.api.updateDraftContent(draft.id, md)
      setStatus(res.ok ? 'saved' : 'error')
      timerRef.current = null
    }, 800)
  }, [draft.id])

  const editor = useEditor({
    extensions: createExtensions(),
    content: initialMarkdown.current || '',
    onCreate: ({ editor }) => {
      // 注册点击回调与主题映射 → 把合法标记文本转换为标注节点
      const storage = editor.storage.contradictionMarker as {
        onClick: ((seq: number) => void) | null
        topicBySeq: Map<number, string>
      }
      storage.onClick = onContradictionClick ?? null
      storage.topicBySeq = topicBySeq
      // 加载时标注文本 → 节点属于程序性初始化，不进 undo 历史（避免用户撤销普通编辑时误触发）
      convertMarkerTextToNodes(editor, validSeqs, false)
      convertedRef.current = true
      setCharCount(editor.getText().length)
    },
    onUpdate: ({ editor }) => {
      setCharCount(editor.getText().length)
      if (!convertedRef.current) return
      scheduleSave(editor.storage.markdown.getMarkdown())
    }
  })

  // 回调/主题映射变化时保持节点行为同步（组件按 draft.id 重挂载，正常只会变化一次）
  useEffect(() => {
    if (!editor) return
    const storage = editor.storage.contradictionMarker as {
      onClick: ((seq: number) => void) | null
      topicBySeq: Map<number, string>
    }
    storage.onClick = onContradictionClick ?? null
    storage.topicBySeq = topicBySeq
  }, [editor, onContradictionClick, topicBySeq])

  /**
   * 采纳矛盾后应用新整稿（2026-08-11，可撤销）：
   * 用 tiptap-markdown 重写过的 setContent（直接接受 Markdown）整体替换正文，
   * 替换事务进入 ProseMirror history——内置"撤销"一次即可恢复采纳前正文；
   * 随后的标注文本 → 节点转换不进 history（addToHistory:false），保证撤销不拆分。
   * 返回编辑器实际序列化的 Markdown（作为采纳后快照键，与撤销/重做回调格式一致）。
   */
  const applyDraftForAdoption = useCallback((nextDraft: DraftItem): string => {
    const md = segmentsToMarkdown(nextDraft.segments)
    if (editor) {
      editor.commands.setContent(md, true)
      convertMarkerTextToNodes(editor, validSeqs, false)
      return editor.storage.markdown.getMarkdown()
    }
    return md
  }, [editor, validSeqs])

  /** 读取当前正文 Markdown（采纳前快照 / 撤销回退比对用） */
  const getMarkdown = useCallback((): string => (editor ? editor.storage.markdown.getMarkdown() : ''), [editor])

  useImperativeHandle(ref, () => ({ applyDraftForAdoption, getMarkdown }), [applyDraftForAdoption, getMarkdown])

  // 监听 undo/redo：ProseMirror history 插件的撤销/重做事务带 'history' meta
  // （PluginKey('history')），正文变化后回调父组件，以按快照回退矛盾状态
  useEffect(() => {
    if (!editor) return
    const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
      if (transaction.getMeta('history')) {
        onHistoryChanged?.(editor.storage.markdown.getMarkdown())
      }
    }
    editor.on('transaction', onTransaction)
    return () => { editor.off('transaction', onTransaction) }
  }, [editor, onHistoryChanged])

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  const statusText =
    status === 'saving' ? zhCN.draftEditor.saving
    : status === 'saved' ? zhCN.draftEditor.saved
    : status === 'error' ? zhCN.draftEditor.saveFailed
    : ''

  /** 右键选中文段 → 弹出"询问文段来源"菜单（Phase 3.7 Task 3.7.5） */
  const handleContextMenu = (e: React.MouseEvent): void => {
    if (!editor) return
    const { from, to } = editor.state.selection
    if (from === to) return
    const selection = editor.state.doc.textBetween(from, to, ' ').trim()
    if (!selection) return
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, selection })
  }

  return (
    <div className="draft-editor">
      <EditorToolbar
        editor={editor}
        pendingContradictions={pendingCount}
        pendingWarnings={pendingWarnings}
        onOpenContradictions={onOpenContradictions}
        onOpenWarnings={onOpenWarnings}
      />
      <div className="draft-editor__doc" onContextMenu={handleContextMenu}>
        <EditorContent editor={editor} />
      </div>
      <div className="draft-editor__foot">
        <span className="draft-editor__char-count">{zhCN.draftEditor.charCount.replace('{count}', String(charCount))}</span>
        {statusText ? <span className={`draft-editor__status is-${status}`}>{statusText}</span> : null}
      </div>
      {ctxMenu ? (
        <>
          <div className="draft-editor__ctx-backdrop" onMouseDown={() => setCtxMenu(null)} />
          <div className="draft-editor__ctx" style={{ left: ctxMenu.x, top: ctxMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => {
                const selection = ctxMenu.selection
                setCtxMenu(null)
                onAskSource?.(selection)
              }}
            >
              {zhCN.draftEditor.askSource}
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

export default forwardRef<DraftEditorHandle, DraftEditorProps>(DraftEditor)
