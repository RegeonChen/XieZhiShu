/**
 * contradiction-marker.ts —— 正文矛盾标注（Phase 3.7 Task 3.7.3）。
 * 生成初稿时大模型在正文中插入标记 `【矛盾#N】`（N 与 draft_contradictions.seq 对应）。
 * - 加载时：把存在于矛盾清单的标记转换为不可编辑的内联节点（⚠️ 芯片，点击打开矛盾对比）；
 * - 保存时：节点序列化为原标记文本（tiptap-markdown 经 storage.markdown.serialize 读取），保证 Markdown 往返一致；
 * - 未关联矛盾记录的残留标记保持为文本，由 decoration 弱化高亮（"降级为普通高亮文本"）。
 */
/// <reference types="vitest/importMeta" />
import { Node, Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Editor } from '@tiptap/react'

/** 正文矛盾标记：`【矛盾#N】` */
export const CONTRADICTION_MARKER_RE = /【矛盾#(\d+)】/g

/** 在文本中查找所有矛盾标记序号（纯函数，可测试） */
export function findContradictionMarkers(text: string): number[] {
  const seqs: number[] = []
  CONTRADICTION_MARKER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CONTRADICTION_MARKER_RE.exec(text)) !== null) {
    const seq = Number(m[1])
    if (Number.isInteger(seq) && seq > 0) seqs.push(seq)
  }
  return seqs
}

/** 生成标记文本（序列化输出与反向解析保持一致） */
export function contradictionMarkerText(seq: number): string {
  return `【矛盾#${seq}】`
}

export interface ContradictionMarkerStorage {
  /** 芯片点击回调（由编辑器组件注入） */
  onClick: ((seq: number) => void) | null
  /** 矛盾序号 → 主题（悬浮提示用，由编辑器组件注入） */
  topicBySeq: Map<number, string>
  /** Markdown 序列化规格（tiptap-markdown 经 storage.markdown.serialize 读取） */
  markdown: {
    serialize: (node: { attrs: { seq: number } }, state: { write: (text: string) => void }) => void
  }
}

/** 矛盾标注内联节点（atom，不可编辑） */
export const ContradictionMarker = Node.create<{ seq?: number }, ContradictionMarkerStorage>({
  name: 'contradictionMarker',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      seq: { default: 0 }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-contradiction-seq]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      { ...HTMLAttributes, class: 'contradiction-marker', 'data-contradiction-seq': HTMLAttributes.seq },
      '⚠'
    ]
  },

  addStorage() {
    return {
      onClick: null,
      topicBySeq: new Map<number, string>(),
      markdown: {
        serialize(node, state) {
          state.write(contradictionMarkerText(node.attrs.seq))
        }
      }
    }
  },

  addNodeView() {
    return ({ node, editor }) => {
      const seq = (node.attrs.seq as number) ?? 0
      const dom = document.createElement('span')
      dom.className = 'contradiction-marker'
      dom.setAttribute('data-contradiction-seq', String(seq))
      dom.textContent = `⚠#${seq}`
      const storage = (editor as Editor).storage.contradictionMarker as ContradictionMarkerStorage | undefined
      const topic = storage?.topicBySeq?.get(seq)
      if (topic) dom.title = topic
      // 点击打开矛盾对比弹窗（阻止默认的选中/拖拽行为）
      dom.addEventListener('mousedown', (e) => e.preventDefault())
      dom.addEventListener('click', (e) => {
        e.preventDefault()
        storage?.onClick?.(seq)
      })
      return { dom }
    }
  }
})

/** 未关联矛盾记录的残留标记弱化高亮（"降级为普通高亮文本"） */
export const invalidContradictionDecoration = (): Plugin => {
  return new Plugin({
    key: new PluginKey('contradictionMarkerInvalid'),
    props: {
      decorations(state) {
        const decorations: ReturnType<typeof Decoration.inline>[] = []
        const textType = state.schema.nodes.text
        state.doc.descendants((node, pos) => {
          if (node.type !== textType || !node.isText) return
          const text = node.text ?? ''
          CONTRADICTION_MARKER_RE.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = CONTRADICTION_MARKER_RE.exec(text)) !== null) {
            const from = pos + m.index
            decorations.push(Decoration.inline(from, from + m[0].length, { class: 'contradiction-marker--invalid' }))
          }
        })
        return DecorationSet.create(state.doc, decorations)
      }
    }
  })
}

/** 残留标记弱化高亮扩展（注册进编辑器 extensions） */
export const InvalidContradictionMarker = Extension.create({
  name: 'invalidContradictionMarker',
  addProseMirrorPlugins() {
    return [invalidContradictionDecoration()]
  }
})

/**
 * 把正文中的 `【矛盾#N】` 文本转换为标注节点（仅转换存在于矛盾清单的合法 seq；
 * 未关联的残留标记保持为文本、由 invalidContradictionDecoration 弱化高亮）。
 * addToHistory=false 时转换事务不进入 undo 历史（2026-08-11：采纳修订应用后紧随
 * setContent 执行，避免撤销采纳需要多按一次撤销）。
 */
export function convertMarkerTextToNodes(editor: Editor, validSeqs: ReadonlySet<number>, addToHistory = true): void {
  if (!editor || editor.isDestroyed || validSeqs.size === 0) return
  const { doc, schema, tr } = editor.state
  const markerType = schema.nodes.contradictionMarker
  if (!markerType) return
  const matches: { from: number; to: number; seq: number }[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const text = node.text ?? ''
    CONTRADICTION_MARKER_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CONTRADICTION_MARKER_RE.exec(text)) !== null) {
      const seq = Number(m[1])
      if (validSeqs.has(seq)) {
        const from = pos + m.index
        matches.push({ from, to: from + m[0].length, seq })
      }
    }
  })
  if (matches.length === 0) return
  // 从大到小应用，避免前面的位置因后面的替换而偏移
  matches.sort((a, b) => b.from - a.from)
  for (const match of matches) {
    tr.replaceWith(match.from, match.to, markerType.create({ seq: match.seq }))
  }
  if (!addToHistory) tr.setMeta('addToHistory', false)
  editor.view.dispatch(tr)
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('contradiction marker utils (Phase 3.7.3)', () => {
    it('finds contradiction marker seqs in text', () => {
      expect(findContradictionMarkers('据《A》载【矛盾#1】3.2 万人，而《B》则载【矛盾#1】3.6 万人。')).toEqual([1, 1])
      expect(findContradictionMarkers('【矛盾#3】与【矛盾#12】并存')).toEqual([3, 12])
    })

    it('ignores malformed or zero markers', () => {
      expect(findContradictionMarkers('正文没有标记')).toEqual([])
      expect(findContradictionMarkers('【矛盾#0】')).toEqual([])
      expect(findContradictionMarkers('【矛盾#x】')).toEqual([])
      expect(findContradictionMarkers('')).toEqual([])
    })

    it('serializes marker text round-trip consistent with regex', () => {
      const text = contradictionMarkerText(7)
      expect(text).toBe('【矛盾#7】')
      expect(findContradictionMarkers(text)).toEqual([7])
    })
  })
}
