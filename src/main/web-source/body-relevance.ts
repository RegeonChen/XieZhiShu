/**
 * body-relevance.ts —— **正文相关性判定**（Phase 10 P5b，2026-10-04）。
 *
 * 这是"过滤口径"的正式落地：用户在设计阶段就要求"**根据这些文章的正文判断是否相关**"，
 * 而在此之前，抓取期与生成期用的都是**最宽**的口径（"正文出现任一检索词就算命中"）——
 * 真实库实测的后果是：`长乐区` 这种**范围限定词**在几乎每篇政务文章里都出现，
 * 于是 600 篇被采用的材料里 **84%（504/600）的正文不含任何"高中系"专指词**，而 479 篇含"长乐区"。
 *
 * 分层口径（**纯函数、不看标题**——用户裁定 ⑦：标题永不作为相关性判据）：
 * 1. **专指词命中 ≥1** → 相关（最强证据：`高中` / `中学` / `校区` / `一中` …）；
 * 2. 否则 **弱专指词命中 ≥2** → 相关（如同时出现 `学校` 与 `教育`）；
 * 3. 否则 **弱专指词 ≥1 且泛词 ≥2** → 相关（如"学校……新建……规模"）；
 * 4. 否则 **与要求的 bigram 重合率 ≥ `DICE_STRONG`** → 相关（兜底：完整词没命中但文本高度重合，
 *    例如别名/简称/标点差异——**这一条是为了不误杀切题材料**）；
 * 5. 否则 → **不相关**。**只命中范围词（长乐区/全区/乡镇…）一律不相关**——这就是噪声的主来源。
 *
 * 为什么兜底用"bigram 重合率"而不是"综合词法分"：综合分里含**整词命中的固定加分**，
 * 实测一篇"长乐区 + 学校"的无关文章（范围词 + 一个弱词）就能凑到 30 分以上而被误放行；
 * 重合率只看"要求里的主题字对是否真的在正文里成片出现"，无关文章通常只有 0.1 左右。
 *
 * 与排序分层（`site-crawler.ts` 的 `classifyTopicTerm`）共用同一套词表，避免两处口径漂移。
 * 判定结果带 `tier`，写进日志与账本的 `best_score`，便于事后审计"是谁放行的"。
 */
import { bigrams, chunkByParagraphs, scoreChunk } from '../rag/retrieval'
import { classifyTopicTerm, expandDomainHints, extractTopicTerms, findSchoolAbbrevHits, scanTopicLexicon, upgradeTopicClass, type TopicTermClass } from './site-crawler'

/** bigram 重合率阈值（Dice 系数）：低于此不再走词法兜底。实测无关政务文（范围词+弱词）≈0.10、切题但用词不同的文 ≈0.35，取 0.30 */
export const DICE_STRONG = 0.3

/** 字面命中判定的词长度上限：长于它的整句词不作为"必须原样出现"的依据（只进词法兜底） */
export const MAX_LITERAL_TERM_CHARS = 8

/**
 * 词法兜底的**比较粒度上限**（字符）。`chunkByParagraphs` 默认 1000 字/段，这里保持一致。
 *
 * 为什么要有这个常量：兜底档原先拿**整篇正文**与要求算 Dice（2026-10-05 实测发现它恒为 0）——
 * 年鉴正文 60 万字、与 60 字的要求求交集，重合率被稀释到 0.001 量级，**这一档从未生效过**。
 * 实测证据：真实库回放里年鉴 lexical 档 = 0 段 / 0 字，而年鉴里明明有「福州三中滨海校区篮球馆开幕」这类切题短段。
 * 改成"按段（窗口）比"以后，只要**任一段**与要求重合率达阈即算命中（只增不减）。
 */
export const LEXICAL_FALLBACK_WINDOW_CHARS = 1000

/**
 * 按段（窗口）算 Dice，取**最大值**：`max over chunks of diceBigrams(qBigrams, bigrams(chunk))`。
 * 纯函数、可测试。段数很多时（年鉴几千段）退化为"与要求最像的那一段有多像"，不再被整篇稀释。
 */
export function maxChunkDice(chunks: string[], queryBigrams: string[]): number {
  let best = 0
  for (const c of chunks) {
    const d = diceBigrams(queryBigrams, bigrams(c))
    if (d > best) best = d
  }
  return best
}

/** Dice 系数（纯函数）：2|A∩B| / (|A|+|B|)，集合语义 */
export function diceBigrams(a: string[], b: string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  return (2 * inter) / (sa.size + sb.size)
}

export type RelevanceTier = 'specific' | 'weak-pair' | 'lexical' | 'none'

export interface BodyRelevance {
  relevant: boolean
  tier: RelevanceTier
  /** 命中的词（按层分组；scope 只作诊断） */
  specificHits: string[]
  weakHits: string[]
  genericHits: string[]
  scopeHits: string[]
  /** 正文各块里的最高词法分 */
  bestScore: number
  /** 命中的块数 / 总块数（诊断用） */
  hitChunks: number
  chunks: number
  /**
   * 词法兜底实际用的重合率：**取各段 Dice 的最大值**（2026-10-05 起。
   * 旧口径是全篇 Dice，年鉴那种长文恒为 0，这一档等于不存在）。
   */
  bestChunkDice: number
  /** 同一时刻的**全篇** Dice——只作诊断对照，不再参与判定 */
  wholeDice: number
  /** 词表来源诊断：由 ③ 动态词表（撰写要求现算）补充进来的词 */
  lexiconHints: string[]
}

/**
 * 把**要求文本**解析成四层词（同一套词表，供判定与诊断共用）。
 * 两条来源合并：① **词表扫描**（整段撰写要求也稳定取词）；② `extractTopicTerms` 的分词结果按分层归位，
 * 但**长于 `MAX_LITERAL_TERM_CHARS` 的整句词不进字面命中表**（它几乎不可能原样出现在正文里，只会造成误杀）。
 *
 * `extraTerms`（2026-10-05，第一组 ③）：撰写要求**现算**出来的词（`topic-lexicon.ts`）在这里并入同一套分层。
 * 传进来时这些词按"**只升不降**"合并——模式命中同义词/校名简称的词会被升级（如 `三中` → specific），
 * 已判定的档位绝不会被降下来。
 */
export function layerQueryTerms(
  query: string,
  extraTerms: string[] = []
): {
  specific: string[]
  weak: string[]
  generic: string[]
  scope: string[]
} {
  const scanned = scanTopicLexicon(query)
  const base = extractTopicTerms(query)
  const terms = [...new Set([...base, ...expandDomainHints(base), ...extraTerms])].filter(
    (t) => t.length >= 2 && t.length <= MAX_LITERAL_TERM_CHARS
  )
  const out = {
    specific: [...scanned.specific],
    weak: [...scanned.weak],
    generic: [...scanned.generic],
    scope: [...scanned.scope]
  }
  for (const t of terms) {
    const cls = classifyTopicTerm(t)
    if (!out[cls].includes(t)) out[cls].push(t)
  }
  // 动态补充词里的校名简称（三中/六中…）单独再过一遍三件套：整句词被长度上限挡掉，但"X中"必须进专指层
  for (const t of findSchoolAbbrevHits(extraTerms.join(' '))) {
    if (!out.specific.includes(t)) out.specific.push(t)
  }
  return out
}

/** 把 `extraTerms` 里的每个词按"只升不降"归位（诊断用：哪些词是被动态词表顶上来的） */
export function classifyExtraTerms(extraTerms: string[]): { term: string; from: TopicTermClass; to: TopicTermClass }[] {
  const out: { term: string; from: TopicTermClass; to: TopicTermClass }[] = []
  for (const t of extraTerms) {
    const v = (t ?? '').trim()
    if (!v) continue
    const from = classifyTopicTerm(v)
    const to = findSchoolAbbrevHits(v).length > 0 ? upgradeTopicClass(from, 'specific') : from
    out.push({ term: v, from, to })
  }
  return out
}

/**
 * 判定**正文**是否与主题相关（纯函数、可测试）。
 * 标题**不参与判定**（调用方即使传了标题，也只用于词法打分里既有的那一项加权，不改变分层规则）。
 *
 * `extraTerms`（2026-10-05 第一组 ③）：撰写要求现算出来的动态词表，**只升不降**地并入同一套分层判定。
 */
export function judgeBodyRelevance(
  text: string,
  query: string,
  title = '',
  extraTerms: string[] = []
): BodyRelevance {
  const body = text ?? ''
  const layers = layerQueryTerms(query, extraTerms)
  const chunks = chunkByParagraphs(body)
  const qBigrams = bigrams(query)
  const qTerms = query.split(/\s+/).filter(Boolean)
  let bestScore = 0
  let hitChunks = 0
  for (const c of chunks) {
    // 词法分里标题按既有口径参与（不改变"正文命中词"的判定）
    const s = scoreChunk(query, c.text, title, qBigrams, qTerms)
    if (s > 0) hitChunks++
    if (s > bestScore) bestScore = s
  }
  const inBody = (t: string): boolean => body.includes(t)
  const specificHits = layers.specific.filter(inBody)
  const weakHits = layers.weak.filter(inBody)
  const genericHits = layers.generic.filter(inBody)
  const scopeHits = layers.scope.filter(inBody)

  /*
   * 词法兜底的比较粒度（2026-10-05 修正，第一组 ②）：
   * 用**各段 Dice 的最大值**而不是整篇 Dice——旧口径在年鉴这种几十万字的长文上恒为 0（被稀释），
   * 等于这一档从未生效。这里只把"拿哪段去比"改小，**只增不减**：任何在旧口径下命中的文本，
   * 其所在段落在新口径下必然也 ≥ 同一阈值（整篇 Dice 是各段 Dice 的下界形态）。
   */
  const chunkTexts = chunks.map((c) => c.text)
  const bestChunkDice = maxChunkDice(chunkTexts.length > 0 ? chunkTexts : [body], qBigrams)
  const wholeDice = diceBigrams(qBigrams, bigrams(body))

  let tier: RelevanceTier = 'none'
  if (specificHits.length > 0) tier = 'specific'
  else if (weakHits.length >= 2) tier = 'weak-pair'
  else if (weakHits.length >= 1 && genericHits.length >= 2) tier = 'weak-pair'
  else if (bestChunkDice >= DICE_STRONG) tier = 'lexical'
  // 只命中范围词的段一律不相关（噪声主来源）；此处不处理，落到 none

  return {
    relevant: tier !== 'none',
    tier,
    specificHits,
    weakHits,
    genericHits,
    scopeHits,
    bestScore,
    hitChunks,
    chunks: chunks.length,
    bestChunkDice,
    wholeDice,
    lexiconHints: extraTerms.filter(Boolean)
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  const QUERY = '高中学校设置 高中 中学 学校 新建 扩建 改建 合并 规模 招生人数 分布 长乐区'

  describe('judgeBodyRelevance（Phase 10 P5b 正文相关性分层口径）', () => {
    it('layers the query terms with the shared classifier', () => {
      const l = layerQueryTerms(QUERY)
      expect(l.specific).toContain('高中')
      expect(l.specific).toContain('中学')
      expect(l.scope).toContain('长乐区')
      expect(l.generic).toContain('新建')
      // 范围词绝不进具体层
      expect(l.specific).not.toContain('长乐区')
    })

    it('keeps a genuinely on-topic body (专指词命中)', () => {
      const body =
        '长乐第六中学对照省三级达标高中评估标准进行自查自评，向福州市教育局提出申报省三级达标高中晋级评估的申请。' +
        '该校现有高中三个年级，设计规模60个班，2020年秋季开始招生。'
      const r = judgeBodyRelevance(body, QUERY, '刚刚发布！长乐这所学校申报三级达标高中')
      expect(r.relevant).toBe(true)
      expect(r.tier).toBe('specific')
      expect(r.specificHits).toContain('高中')
    })

    it('drops the noise that this phase exists to remove（只有范围词的文章不再放行）', () => {
      const body =
        '为提升城市品质，长乐区今年新建改建公厕234所，其中一类公厕12所，二类公厕80所，全部免费开放，并配备无障碍设施与第三卫生间。'
      const r = judgeBodyRelevance(body, QUERY, '长乐区加快推进厕所革命，两年新建改建公厕234所')
      expect(r.scopeHits).toContain('长乐区')
      expect(r.genericHits.length).toBeGreaterThan(0) // 命中"新建/改建"等泛词
      expect(r.relevant).toBe(false) // 但没有专指词、也不满足弱词组合 → 不相关
      expect(r.tier).toBe('none')
      // 兜底阈值与噪声之间的余量（噪声 ≈0.10，阈值 0.30）
      expect(diceBigrams(bigrams(QUERY), bigrams(body))).toBeLessThan(0.2)
    })

    it('requires a combination for weak terms, and never uses the title', () => {
      // 只命中"学校"一个弱词、泛词也不够 → 不相关
      const onlyWeak = '长乐区各学校要落实安全责任，加强校园周边环境整治工作，确保师生平安。'.repeat(3)
      const r1 = judgeBodyRelevance(onlyWeak, QUERY, '长乐区高中学校设置情况汇总')
      expect(r1.weakHits).toContain('学校')
      expect(r1.relevant).toBe(false) // 标题写了"高中学校设置"也没用
      // 弱词 + ≥2 泛词 → 放行
      const weakPlusGeneric = '长乐区多所学校完成新建与扩建，办学规模进一步扩大。'.repeat(3)
      const r2 = judgeBodyRelevance(weakPlusGeneric, QUERY, '')
      expect(r2.tier).toBe('weak-pair')
      expect(r2.relevant).toBe(true)
    })

    it('has a lexical fallback so on-topic-but-oddly-worded bodies are not killed', () => {
      // 不含任何完整检索词，但与要求高度重合（别名/简称场景）
      const text = ('高中学校设置情况：' + '长乐区高中学校设置与招生人数分布情况说明。'.repeat(40))
      const r = judgeBodyRelevance(text.replace(/高中|学校/g, (m) => (m === '高中' ? '高级中等' : '学府')), QUERY, '')
      expect(r.specificHits).toHaveLength(0)
      expect(r.relevant).toBe(true)
      expect(r.tier).toBe('lexical')
    })

    it('returns not-relevant for an empty body or empty query', () => {
      expect(judgeBodyRelevance('', QUERY).relevant).toBe(false)
      expect(judgeBodyRelevance('高中学校设置'.repeat(50), '').relevant).toBe(false)
    })

    /* ---- 2026-10-05 第一组 ②：bigram 兜底档改为"按段/按窗口"粒度 ---- */

    it('按段比 bigram：年鉴那种长文里，切题的那一段仍能被兜底档救回（旧口径被整篇稀释）', () => {
      // 切题的一段（与要求高度重合，但**不含任何专指词/弱词**，只有"设置/新建/扩建/合并/规模/招生/人数/分布"这些泛词）
      const onTopic = '设置与人数分布说明：新建扩建改建合并的情况说明，招生人数分布与规模设置的情况说明。'
      // 模拟"年鉴正文"：数万字的无关长文（真实年鉴 60 万字）。
      // 两个字表两两组合（彼此都刻意避开要求里的任何字），使长文的 bigram **种类**极多，
      // 因此"整篇 Dice"会被严重稀释——这正是旧口径下这一档从未生效的原因。
      const poolA = '山川河流草木虫鱼鸟兽风雨雷电霜雪云雾星辰石沙土田亩顷丈尺担斗升谷麦粟稻粱菽稷棉麻丝帛纸墨笔砚桌椅床柜门窗瓦砖泥灰铜铁锡铅锌银汞碳硫磷钾钠镁铝硅'
      const poolB = '岸滩涂碱洲屿礁岬湾港汊溪涧沟渠塘堰坝闸涵洞隧垭岭峰峦崖壁岩洞穴隙缝裂纹斑点瑕疵垢污渍茂盛枯萎凋零腐朽霉烂潮湿干燥寒暑春秋冬夏晨昏昼夜晦朔弦望盈亏'
      const noise = Array.from(
        { length: 24000 },
        (_, i) => poolA[(i * 7 + 3) % poolA.length] + poolB[(i * 11 + 5) % poolB.length]
      ).join('') + '。'
      const body = noise + '\n\n' + onTopic + '\n\n' + noise
      const r = judgeBodyRelevance(body, QUERY, '')
      // 全篇 Dice 远低于阈值（旧口径就是拿它比 0.3 → 这一档在任何长文上都等于不存在）
      expect(r.wholeDice).toBeLessThan(DICE_STRONG / 4)
      // 按段比之后，切题的那一段达到阈值 → 兜底档生效
      expect(r.bestChunkDice).toBeGreaterThanOrEqual(DICE_STRONG)
      expect(r.bestChunkDice).toBeGreaterThan(r.wholeDice)
      expect(r.tier).toBe('lexical')
      expect(r.relevant).toBe(true)
    })

    it('maxChunkDice 取各段最大值，且空输入为 0（纯函数）', () => {
      const q = bigrams(QUERY)
      expect(maxChunkDice([], q)).toBe(0)
      expect(maxChunkDice(['无关的一句话。'], q)).toBeLessThan(DICE_STRONG)
      // 有切题段 → 取到它
      expect(maxChunkDice(['无关的一句话。', '高中学校设置与招生人数分布情况说明'], q)).toBeGreaterThanOrEqual(
        maxChunkDice(['无关的一句话。'], q)
      )
    })

    it('③ 动态词表（extraTerms）只升不降地并入同一套分层判定', () => {
      // 正文写"福州三中滨海校区"——旧词表里没有"三中"，落 scope-only/none
      const body = '福州三中滨海校区等一批优质学校相继建成。' + '其它无关的技术内容。'.repeat(20)
      const before = judgeBodyRelevance(body, QUERY, '')
      expect(before.specificHits).not.toContain('三中')
      // 动态词表把"三中"作为同义扩展词传进来 → 升为 specific
      const after = judgeBodyRelevance(body, QUERY, '', ['三中'])
      expect(after.specificHits).toContain('三中')
      expect(after.tier).toBe('specific')
      expect(after.lexiconHints).toEqual(['三中'])
      // 只升不降：动态词表里放一个范围词，也不能把 specific 降下来
      const keep = judgeBodyRelevance('长乐区高中学校设置情况说明。', QUERY, '', ['长乐区'])
      expect(keep.tier).toBe('specific')
    })
  })
}
