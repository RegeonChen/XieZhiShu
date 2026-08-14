/**
 * contradiction-apply.ts —— 矛盾采纳 → 正文同步修订（本地替换版，2026-08-11 重构）。
 * 采纳某说法后，不再调用大模型：定位审查（生成阶段）已为每个说法预生成了"采纳替换文句"（replacement），
 * 主进程仅做本地字符串替换——from=该矛盾的正文原句 draft_quote（定位审查回填，即待修改语句的起止位置），
 * to=被采纳说法的 replacement；替换后移除该矛盾的【矛盾#N】标注并整稿落库，状态置 adopted。
 * 资料库（工作区文件）只读，绝不修改。
 */
import type { Contradiction, Draft } from '../../shared/types'
import { getDraftById, replaceDraftSegments } from '../db/drafts'
import { getContradictionById, updateContradictionStatus } from '../db/contradictions'

export type ApplyContradictionResult =
  | { ok: true; draft: Draft; contradiction: Contradiction }
  | { ok: false; error: { code: string; message: string } }

function fail(code: string, message: string): ApplyContradictionResult {
  return { ok: false, error: { code, message } }
}

/** 初稿片段 → 连续 Markdown（与渲染端 segmentsToMarkdown 一致） */
export function segmentsToMarkdown(segments: Draft['segments']): string {
  return segments
    .map((s) => {
      const head = s.heading ? `## ${s.heading}` : ''
      const body = s.content.trim()
      return [head, body].filter(Boolean).join('\n\n')
    })
    .join('\n\n')
}

/** 矛盾标注文本（与编辑器 contradiction-marker.ts 的 contradictionMarkerText 一致） */
export function contradictionMarkerText(seq: number): string {
  return `【矛盾#${seq}】`
}

/**
 * 把修订逐条应用到正文（纯函数、可测试）：每条 from 必须逐字存在于正文，替换首次出现；
 * 任一 from 未定位即返回失败（防止正文已被手动修改导致误改）。
 */
export function applyEditsToMarkdown(
  markdown: string,
  edits: { from: string; to: string }[]
): { ok: true; content: string } | { ok: false; error: string } {
  let content = markdown
  for (const e of edits) {
    const idx = content.indexOf(e.from)
    if (idx < 0) return { ok: false, error: `正文中未找到待替换原句「${e.from.slice(0, 30)}…」` }
    content = content.slice(0, idx) + e.to + content.slice(idx + e.from.length)
  }
  return { ok: true, content }
}

/** 移除正文中某个矛盾的标注（纯函数、可测试）：`【矛盾#N】` 全部删除 */
export function removeContradictionMarkers(markdown: string, seq: number): string {
  return markdown.split(contradictionMarkerText(seq)).join('')
}

/**
 * 采纳修订主入口（本地直接替换，无大模型调用）：
 * 用定位审查预生成的 from（draft_quote）与 to（被采纳说法的 replacement）修改正文并落库。
 */
export async function applyContradictionEdit(
  draftId: string,
  contradictionId: string,
  variantId: string
): Promise<ApplyContradictionResult> {
  const contradiction = getContradictionById(contradictionId)
  if (!contradiction || contradiction.draftId !== draftId) {
    return fail('INVALID_PARAM', '矛盾不存在或不属于该初稿')
  }
  if (contradiction.status !== 'pending') {
    return fail('INVALID_PARAM', '该矛盾已处理，无需再次修改正文')
  }
  const variant = contradiction.variants.find((v) => v.id === variantId)
  if (!variant) return fail('INVALID_PARAM', '被采纳的说法不属于该矛盾')

  // 定位锚点与替换文句必须齐全（均由生成阶段的定位审查预生成）
  const from = contradiction.draftQuote
  if (!from) return fail('EDIT_NO_QUOTE', '该矛盾未定位到正文语句，无法自动修订')
  const to = variant.replacement
  if (!to) return fail('EDIT_NO_REPLACEMENT', '该矛盾缺少大模型预生成的采纳结果，请重新生成初稿')

  const draft = getDraftById(draftId)
  if (!draft) return fail('DRAFT_NOT_FOUND', '志稿不存在')

  // 本地替换（from=draft_quote 起止定位 → to=被采纳说法），再移除标注
  const applied = applyEditsToMarkdown(segmentsToMarkdown(draft.segments), [{ from, to }])
  if (!applied.ok) {
    return fail('EDIT_ANCHOR_NOT_FOUND', '正文原句未能匹配（可能已被手动修改），请直接在正文中修改')
  }
  const newMarkdown = removeContradictionMarkers(applied.content, contradiction.seq)

  // 先置采纳（含说法归属校验），正文保存失败时回滚为待处理
  const adopted = updateContradictionStatus(contradictionId, 'adopted', variantId)
  if (!adopted) return fail('INVALID_PARAM', '更新矛盾状态失败')

  const savedDraft = replaceDraftSegments(draftId, newMarkdown)
  if (!savedDraft) {
    updateContradictionStatus(contradictionId, 'pending')
    return fail('INTERNAL_ERROR', '正文保存失败')
  }

  return { ok: true, draft: savedDraft, contradiction: getContradictionById(contradictionId) ?? adopted }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('contradiction apply utils (local edit, 2026-08-11)', () => {
    it('applies from->to edits at first occurrence', () => {
      const md = '据《A》载在校生3.2万人，而《B》则载3.6万人【矛盾#1】。'
      const res = applyEditsToMarkdown(md, [{ from: '在校生3.2万人，而《B》则载3.6万人', to: '在校生为3.2万人' }])
      expect(res).toEqual({ ok: true, content: '据《A》载在校生为3.2万人【矛盾#1】。' })
    })

    it('fails when from is not verbatim in the draft', () => {
      const res = applyEditsToMarkdown('正文内容。', [{ from: '不存在的原句', to: '替换' }])
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('未找到')
    })

    it('removes contradiction markers for the resolved seq only', () => {
      expect(removeContradictionMarkers('a【矛盾#1】b【矛盾#1】c【矛盾#2】d', 1)).toBe('abc【矛盾#2】d')
      expect(removeContradictionMarkers('无标注正文', 3)).toBe('无标注正文')
    })

    it('serializes segments back to the same markdown used by the editor', () => {
      const segments: Draft['segments'] = [
        { id: 's1', draftId: 'd1', ordering: 0, heading: '教育与保育', content: '正文一。', aiGenerated: true, createdAt: '', updatedAt: '', sources: [] },
        { id: 's2', draftId: 'd1', ordering: 1, content: '无标题正文。', aiGenerated: true, createdAt: '', updatedAt: '', sources: [] }
      ]
      expect(segmentsToMarkdown(segments)).toBe('## 教育与保育\n\n正文一。\n\n无标题正文。')
    })
  })
}
