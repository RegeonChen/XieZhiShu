/**
 * article-segments.ts —— **第二组 ⑤：文章内取高信号段 ± 上下文**（2026-10-06，用户已批准）。
 *
 * 【为什么要有这一步】
 * 闸门（`recallCompilationCandidates`）决定的是"**哪些来源**进本轮"：网页来源整篇判一次分层口径，
 * 本地文件来源只按"段里有没有任何词法信号（score>0）"逐段放行——后者在年鉴这种综合文档上几乎
 * 等于整本放行（真实库 3 份年鉴 185 万字），于是细读窗口数、耗时与额度都被无关章节吃掉。
 * ⑤ 把粒度从"来源"下沉到"**段**"：一篇文章里**只有有信号的段**（以及它们紧邻的上下文）才进本轮细读。
 *
 * 【判据（只有信号决定，不设任何总量上限——用户硬裁定）】
 * 1. **有信号的段一律保留**：档位属于 `specific`（专指词）/ `weak-pair`（弱词组合）/ `lexical`（按段 Dice 兜底）。
 *    **不设"每篇最多 N 段 / 总字数不超过 X"** 这类人为截断：有信号就留，篇幅由材料自己决定。
 * 2. **紧邻上下文**：其余段若紧邻某个有信号的段（上下各 `ARTICLE_CONTEXT_RANGE` 段）则作为上下文保留——
 *    否则"某校新建……"这类段的年份/主语（往往落在上一段）会被切掉，细读模型反而容易读错。
 * 3. **整篇无信号 → 整篇不送**：这是正常结果、**不是错误**。材料**仍在库中**（`sources.cleaned_text`
 *    一字未动）、仍可打开查看、仍参与来源询问与定位；"不送"只发生在本轮细读窗口。
 *
 * 【判据只有一份实现】
 * 这里的 `judgeSegmentTier`（逐段档位）与 `selectArticleSegments`（取舍规则）是**产品代码与离线回放
 * 共用的同一函数**（`.dbg/backtest.test.ts` 直接 import 这两个），避免"回放一套、产品一套"的口径漂移。
 *
 * 【坐标】
 * 本模块只做"留 / 不留"的判断，**不碰** `charStart/charEnd`：段的字符区间仍由 `chunkByParagraphsFromBase`
 * 按 `stripStructureNoise` 给出的 `keptLineStarts` 基准算出，始终指向**来源正文**坐标系，定位不会错位。
 */
import { judgeBodyRelevance, type RelevanceTier } from '../web-source/body-relevance'

/**
 * ⑤ 认定的"**有信号**"档位。为什么不含 `scope-only`：只命中范围词（长乐区/全区/全省…）的段是噪声主来源
 * ——真实库实测 84% 的"已采用但跑题"正文都含 `长乐区`（见 `body-relevance.ts` 头注）。
 */
export const SIGNAL_TIERS: ReadonlySet<SegmentTier> = new Set<SegmentTier>(['specific', 'weak-pair', 'lexical'])

/**
 * 段级档位：`judgeBodyRelevance` 的四档 + 单独成档的 `scope-only`（"只命中范围词"）。
 * 为什么要把 `scope-only` 从 `none` 里分出来：它与"什么都没有"在诊断上必须区分（谁被范围词放行、谁真的没信号），
 * 但**两者都不进本轮细读**——这是 P5b-1 收紧口径的核心（范围词是噪声主来源）。
 */
export type SegmentTier = RelevanceTier | 'scope-only'

/** 上下文半径（单位：段）。1 = 有信号段上下各留 1 段；0 = 只留信号段本身。 */
export const ARTICLE_CONTEXT_RANGE = 1

/**
 * 逐段档位（**与离线回放同一口径**）：`judgeBodyRelevance` 的分层结果 + "只命中范围词"单独成档。
 * 为什么要补 `scope-only`：判定函数本身只回报 `specific / weak-pair / lexical / none`，
 * 而"只命中范围词"必须与"什么都没有"区分开（前者在日志与回放里要能看出来是谁放行的、谁没放行）。
 */
export function judgeSegmentTier(text: string, query: string, title = '', extraTerms: string[] = []): SegmentTier {
  const r = judgeBodyRelevance(text, query, title, extraTerms)
  if (r.tier !== 'none') return r.tier
  return r.scopeHits.length > 0 ? 'scope-only' : 'none'
}

/**
 * ⑤ 的取舍规则（**纯函数、确定性**）：给一篇材料逐段的档位，返回"哪几段进本轮细读"。
 *
 * 输入 `tiers` 的顺序必须与材料正文里的段顺序一致（上下文是"紧邻的段"，顺序错了上下文就错了）。
 * 输出与输入等长；整篇无信号时返回全 false —— 调用方**不得**把它当成错误（见文件头第 3 条）。
 */
export function selectArticleSegments(tiers: SegmentTier[], contextRange: number = ARTICLE_CONTEXT_RANGE): boolean[] {
  const signal = tiers.map((t) => SIGNAL_TIERS.has(t))
  if (contextRange <= 0) return signal
  const kept = [...signal]
  for (let i = 0; i < signal.length; i++) {
    if (!signal[i]) continue
    for (let d = 1; d <= contextRange; d++) {
      if (i - d >= 0) kept[i - d] = true
      if (i + d < signal.length) kept[i + d] = true
    }
  }
  return kept
}

/** 一篇材料的取段结果（供日志/进度/预检如实汇报，不做任何截断） */
export interface ArticleSegmentPlan {
  /** 逐段档位（与入参段序一致） */
  tiers: SegmentTier[]
  /** 逐段"是否进本轮细读" */
  kept: boolean[]
  keptSegments: number
  keptChars: number
  /** 因无信号未送（仍在库中）的段数 / 字数 */
  droppedSegments: number
  droppedChars: number
}

/**
 * 对**一篇材料**跑完整判定：逐段分层判定 → ⑤ 取段。
 * 纯函数（同样的输入必然同样的输出），因此可以单测、也可以在离线回放里逐字复算。
 */
export function planArticleSegments(
  texts: string[],
  query: string,
  title: string,
  extraTerms: string[] = [],
  contextRange: number = ARTICLE_CONTEXT_RANGE
): ArticleSegmentPlan {
  const tiers = texts.map((t) => judgeSegmentTier(t, query, title, extraTerms))
  const kept = selectArticleSegments(tiers, contextRange)
  let keptSegments = 0
  let keptChars = 0
  let droppedSegments = 0
  let droppedChars = 0
  for (let i = 0; i < texts.length; i++) {
    const len = texts[i]?.length ?? 0
    if (kept[i]) {
      keptSegments += 1
      keptChars += len
    } else {
      droppedSegments += 1
      droppedChars += len
    }
  }
  return { tiers, kept, keptSegments, keptChars, droppedSegments, droppedChars }
}

/**
 * ⑤ 的汇总统计（随生成结果透出给界面，并写进日志）：口径全部**如实**，不四舍五入成"差不多"。
 * 其中 `gated*` 是"**不做收敛**（逃生门 / 今天的行为）"时的规模，`kept*` 是本次真正送细读的规模。
 */
export interface ArticleConvergenceStats {
  /** 上下文半径（如实记录本次用的是几） */
  contextRange: number
  /** 闸门后（= 逃生门"全量送入"口径）的段数 / 字数 */
  gatedSegments: number
  gatedChars: number
  /** 参与取段的来源数（= 闸门放行的来源里、确实有切段的那些） */
  sources: number
  /** 这些来源正文的**全部**切段与字数（用它算"因无信号未送"） */
  articleSegments: number
  articleChars: number
  /** ⑤ 收敛后（本轮真正送细读）的段数 / 字数 */
  keptSegments: number
  keptChars: number
  /** 因无信号未送（仍在库中、仍可打开）的段数 / 字数 */
  droppedSegments: number
  droppedChars: number
  /** 整篇无信号、本轮整篇不送的来源数 */
  noSignalSources: number
  /** ⑤ 从"闸门已丢弃的段"里按信号/上下文重新纳入的段数（用于如实说明"有信号就留"确实生效） */
  reIncludedSegments: number
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest
  const QUERY =
    '标题为"高中学校设置"，包括学校的新建、扩建、改建、合并、规模、招生人数、地理分布等等，只需要包含长乐区及以下层级的内容。'

  describe('⑤ 文章内取高信号段 ± 上下文（article-segments）', () => {
    it('有信号的段保留、无信号的段跳过（不设每篇段数上限）', () => {
      /*
       * 构造：下标 0/3/7 是有信号段（含"高中/中学"，属专指词档），其余是明确无关的段（无主题词、无范围词）。
       * 期望：信号段全留 + 紧邻各 1 段作上下文 → 0,1,2,3,4,6,7 留；下标 5 既无信号也不紧邻信号 → 跳过。
       * ⚠ 这里刻意不传 extraTerms：只用**静态词表**就能判定的档位，避免把"③ 动态词表"的效果混进来。
       */
      const texts = [
        '长乐第六中学高中部2020年秋季开始招生。',
        '本季度降雨量较常年偏多。',
        '县城路灯亮化工程完成验收。',
        '长乐华侨中学高中部新增学位300个。',
        '全县林地面积保持稳定。',
        '本季度降雨量较常年偏多。',
        '县城路灯亮化工程完成验收。',
        '长乐第二中学高中部招生规模扩大。'
      ]
      const plan = planArticleSegments(texts, QUERY, '', [])
      expect(plan.tiers[0]).toBe('specific')
      expect(plan.tiers[5]).not.toBe('specific')
      expect(plan.kept).toEqual([true, true, true, true, true, false, true, true])
      expect(plan.keptSegments).toBe(7)
      expect(plan.droppedSegments).toBe(1)
      // 保留的段数与标记完全一致（不是"标记留了但没送"）
      expect(plan.keptSegments).toBe(plan.kept.filter(Boolean).length)
    })

    it('只命中范围词的段不算信号（长乐区/全区 这类噪声主来源）', () => {
      const kept = selectArticleSegments(['scope-only'], 1)
      expect(kept).toEqual([false])
      const plan = planArticleSegments(['长乐区召开2020年第四季度经济形势分析会，全区规上工业产值稳步增长。'], QUERY, '', [])
      expect(plan.tiers[0]).toBe('scope-only')
      expect(plan.keptSegments).toBe(0)
      expect(plan.droppedSegments).toBe(1)
    })

    it('紧邻被保留段的段作为上下文保留（上下各 1 段），更远的段不保留', () => {
      // 第 3 段（下标 2）是唯一有信号的段；±1 → 下标 1、3 作为上下文保留；下标 0、4 不保留
      const tiers: ('specific' | 'none')[] = ['none', 'none', 'specific', 'none', 'none']
      const kept = selectArticleSegments(tiers, 1)
      expect(kept).toEqual([false, true, true, true, false])
      // 半径 0 = 只留信号段本身（对照口径）
      expect(selectArticleSegments(tiers, 0)).toEqual([false, false, true, false, false])
      // 半径 2 → 整篇都进（上下文更宽）
      expect(selectArticleSegments(tiers, 2)).toEqual([true, true, true, true, true])
    })

    it('整篇无信号 → 整篇不送，但**不报错**（不是异常，材料仍在库中）', () => {
      const plan = planArticleSegments(
        ['沿海防护林体系建设情况说明。', '城乡公交线路优化调整方案。', '长乐区召开第四季度经济形势分析会。'],
        QUERY,
        '',
        []
      )
      expect(plan.kept).toEqual([false, false, false])
      expect(plan.keptSegments).toBe(0)
      expect(plan.keptChars).toBe(0)
      expect(plan.droppedSegments).toBe(3)
      // 空正文也不报错
      const empty = planArticleSegments([], QUERY, '', [])
      expect(empty).toEqual({ tiers: [], kept: [], keptSegments: 0, keptChars: 0, droppedSegments: 0, droppedChars: 0 })
    })

    it('确定性可复现：同一输入两次跑出的结果逐项相等', () => {
      const texts = ['长乐第六中学申报省三级达标高中。', '区域气象观测记录。', '长乐区加快推进公厕建设。']
      const a = planArticleSegments(texts, QUERY, '某标题', ['三中', '六中'])
      const b = planArticleSegments(texts, QUERY, '某标题', ['三中', '六中'])
      expect(b).toEqual(a)
      // 逐段档位也一样（judgeBodyRelevance 内部无随机、无时间依赖）
      expect(b.tiers).toEqual(a.tiers)
    })

    it('③ 动态词表进同一套判定：同义扩展词能把段落从 scope-only 抬成信号段', () => {
      const text = '福州三中滨海校区等一批优质学校相继建成。'
      const before = planArticleSegments([text], QUERY, '', []).kept[0]
      const after = planArticleSegments([text], QUERY, '', ['三中']).kept[0]
      expect(before).toBe(false)
      expect(after).toBe(true)
    })

    it('不设任何总量上限：全篇都是信号段时一段都不少', () => {
      const texts = Array.from({ length: 40 }, (_, i) => `长乐第${i + 1}中学高中部招生规模与校区分布情况说明。`)
      const plan = planArticleSegments(texts, QUERY, '', [])
      expect(plan.keptSegments).toBe(40)
      expect(plan.droppedSegments).toBe(0)
    })
  })
}
