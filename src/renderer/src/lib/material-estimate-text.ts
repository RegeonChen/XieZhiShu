/**
 * material-estimate-text.ts —— 「本次材料规模」预检框的**文案组装**（纯函数，可测试）。
 *
 * 为什么单独抽出来（2026-11-04）：网页侧的口径要分两种情况说，模板随之分叉——
 *  · 任务**已带网页来源**：报真实数字「本地 N 段 + 网页 M 段」；
 *  · 新任务（还没有任何网页来源）：预检的网页侧必然是 0，说成"网页 0 段"会被读成"没有网页材料"，
 *    应如实说「本地 N 段 + 网页：生成时按区间重筛（未计入本估算）」。
 *
 * 放在 .ts 而不是组件里：本项目的内联单测只覆盖 `src/**\/*.ts`（.tsx 的内联测试不会执行）。
 */
import { zhCN } from '../i18n/zh-CN'

export interface MaterialEstimateLike {
  segments: number
  chars: number
  localSegments: number
  webSegments: number
  estimatedWindows: number
  estimatedMinutes: number
  fullSegments?: number
  fullChars?: number
  fullEstimatedWindows?: number
  fullEstimatedMinutes?: number
  droppedSegments?: number
  converged?: boolean
}

/** 组装预检框正文；`skipConvergence` = 用户在框里勾了「本轮不做收敛」 */
export function buildMaterialEstimateMessage(est: MaterialEstimateLike, skipConvergence: boolean): string {
  const webDeferred = est.webSegments <= 0
  const scope = (webDeferred ? zhCN.compilation.materialEstimateScopeWebDeferred : zhCN.compilation.materialEstimateScopeIncluded)
    .replace('{local}', String(est.localSegments))
    .replace('{web}', String(est.webSegments))
  const text = zhCN.compilation.materialEstimateBody
    .replace('{segments}', String(est.segments))
    .replace('{wan}', (est.chars / 10000).toFixed(1))
    .replace('{scope}', scope)
    .replace('{webNote}', webDeferred ? '' : zhCN.compilation.materialEstimateWebNote)
    .replace('{windows}', String(est.estimatedWindows))
    .replace('{minutes}', String(est.estimatedMinutes))
    .replace('{dropped}', String(est.droppedSegments ?? 0))
    .replace('{fullSegments}', String(est.fullSegments ?? est.segments))
    .replace('{fullWan}', ((est.fullChars ?? est.chars) / 10000).toFixed(1))
    .replace('{fullWindows}', String(est.fullEstimatedWindows ?? est.estimatedWindows))
    .replace('{fullMinutes}', String(est.fullEstimatedMinutes ?? est.estimatedMinutes))
  return skipConvergence ? text + '\n' + zhCN.compilation.materialEstimateConvergeSkipNote : text
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  const base: MaterialEstimateLike = {
    segments: 3383,
    chars: 699_000,
    localSegments: 3383,
    webSegments: 0,
    estimatedWindows: 24,
    estimatedMinutes: 8,
    droppedSegments: 21261,
    fullSegments: 23828,
    fullChars: 2_997_000,
    fullEstimatedWindows: 100,
    fullEstimatedMinutes: 33,
    converged: true
  }

  describe('material estimate text', () => {
    it('新任务（网页来源为 0）：如实说"生成时重筛、未计入"，不写"网页 0 段"', () => {
      const text = buildMaterialEstimateMessage(base, false)
      expect(text).toContain('本地 3383 段 + 网页：生成时按区间重筛（未计入本估算）')
      expect(text).not.toContain('网页 0 段')
      expect(text).not.toContain('不在此估算内') // 已在 scope 里说了，不再重复
      expect(text).toContain('3383 段 / 69.9 万字')
      expect(text).toContain('24 个细读窗口')
    })

    it('任务已带网页来源：报真实数字，并保留"网页在生成时重筛"的说明', () => {
      const text = buildMaterialEstimateMessage({ ...base, localSegments: 200, webSegments: 22 }, false)
      expect(text).toContain('本地 200 段 + 网页 22 段')
      expect(text).toContain('不在此估算内')
    })

    it('勾了"不做收敛"：追加一句说明本轮按全量口径', () => {
      const text = buildMaterialEstimateMessage(base, true)
      expect(text).toContain('已勾选「本轮不做收敛（全量送入）」')
    })
  })
}
