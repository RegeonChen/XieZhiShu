/**
 * topic-lexicon.ts —— **从撰写要求现算词表 + 同义扩展**（第一组 ③，2026-10-05）。
 *
 * 用户的撰写要求是一整段自然语言（真实例子：「标题为"高中学校设置"，包括学校的新建、扩建、改建、合并、
 * 规模、招生人数、地理分布等等…」）。它同时是：① 网页材料筛选的判据；② 细读/整合提示词的首要依据。
 * 但筛选路径此前只能靠**静态词表**（`site-crawler.ts` 的 `scanTopicLexicon`）从要求里"抠"已知词——
 * 要求里没写在词表上的说法（某个校区名、某个做法）就完全没被用上。
 *
 * 本模块把要求解析成**三组词**并做同义扩展：
 *   - `topicTerms`（主题词）：标题/主题本身与其同义说法（如「高中学校设置」→「高中/普高/完全中学」）；
 *   - `keyPoints`（要点词）：要求里点名的动作/指标（新建、扩建、招生人数、学位…）及其同义扩展；
 *   - `scopeWords`（范围词）：地域/层级限定（长乐区、全区、乡镇…）。
 *
 * **成本口径（用户硬性要求）**：
 *   1. 一次**很便宜**的调用——提示词只有几十字 + 要求原文，输出限 400 token、要求 ≤24 个词；
 *   2. **同一要求只算一次**——按"规范化后的要求文本"的 sha256 缓存（见下「为什么用内存缓存」）；
 *   3. **无 Provider / 调用失败必须本地降级**（静态词表 + 内置同义表），**绝不允许阻断生成**；
 *   4. **回放（离线测量）绝不触发它**——`useLlm:false` 是默认，回放路径不会进入网络调用。
 *
 * 为什么用**内存缓存**而不是落库：
 *   - 落库要加迁移（新建表 + Migration 050），而这份词表的生命周期就是"这个任务这一次生成"，
 *     跨会话复用价值很低（要求文本几乎总在变）；真实库里 4 条要求各不相同，落库也省不下一次调用。
 *   - 落库还会把"用户写的撰写要求"以另一种形式再存一份，扩大数据面（本地优先原则下能少存就少存）。
 *   - 内存缓存已经满足"同一要求只算一次"（生成汇编 → 材料规模预估 → 细读/整合都复用同一份）。
 *   ⚠ 代价如实说明：**应用重启后同一要求会再算一次**（数百 token，可忽略）。
 */
import { createHash } from 'node:crypto'
import { expandDomainHints, extractTopicTerms, scanTopicLexicon, upgradeTopicClass, type TopicTermClass } from '../web-source/site-crawler'

/** 缓存键：规范化后的要求文本的 sha256（去掉首尾与重复空白，避免"同一要求多个副本"各算一次） */
export function lexiconCacheKey(instruction: string): string {
  return createHash('sha256').update(instruction.replace(/\s+/g, ' ').trim(), 'utf8').digest('hex')
}

export interface TopicLexiconAnalysis {
  /** 需求文本缓存键（sha256） */
  key: string
  /** 主题词（标题/主题及其同义说法） */
  topicTerms: string[]
  /** 要点词（动作/指标，含同义扩展） */
  keyPoints: string[]
  /** 范围词（地域/层级限定） */
  scopeWords: string[]
  /** 三组词拼成的粗筛查询串——**喂给同一套判定路径**（`judgeBodyRelevance` 的 `extraTerms`） */
  query: string
  /** 解析来源（诊断）：local = 纯本地；llm = 大模型补充了同义扩展；llm-failed = 调了但失败，已降级 */
  source: 'local' | 'llm' | 'llm-failed'
  /** 同义扩展补充进来的词（诊断：让用户能看出"多出来的词"是从哪来的） */
  expanded: string[]
}

/**
 * 内置同义表（本地降级路径；**只有同一组里任一说法出现在要求里，整组才展开**）。
 * 口径同静态词表：只增不减——扩展词只会把召回放宽，不会取消任何静态命中。
 */
export const KEY_POINT_SYNONYM_GROUPS: string[][] = [
  ['新建', '新办', '新设', '新增', '开办', '创办', '设立'],
  ['扩建', '扩容', '扩班', '增容', '增设'],
  ['改建', '改造', '提升', '迁建', '搬迁'],
  ['合并', '并入', '整合', '撤并'],
  ['更名', '改名', '易名'],
  ['竣工', '落成', '完工', '建成', '投用', '启用', '投入使用', '开学'],
  ['规模', '办学规模', '班数', '班级数', '学位', '学位数'],
  ['招生', '招生人数', '招生计划', '录取', '生源', '报考'],
  ['分布', '地理分布', '区域分布', '布局'],
  ['达标', '晋级', '评级', '评估', '等级'],
  ['集团化办学', '教育集团', '集团办学'],
  ['复办', '恢复办学', '恢复招生']
]

/** 主题词的本地同义表（只有同一组里任一说法命中要求，才展开） */
export const TOPIC_SYNONYM_GROUPS: string[][] = [
  ['高中', '普高', '普通高中', '高级中学', '完中', '完全中学', '独立高中'],
  ['初中', '初级中学'],
  ['中学', '中学校'],
  ['校区', '校部', '校区建设'],
  ['学校', '校'],
  ['职业教育', '职专', '职业中学', '职校'],
  ['高中部', '中学部'],
  ['达标高中', '省一级达标', '三级达标', '二级达标', '一级达标', '示范性高中']
]

/** 范围词后缀（与 `site-crawler.ts` 同口径）：用于把"X镇/X街道"这类词认出来 */
const SCOPE_SUFFIX_RE = /(省|市|区|县|镇|乡|街道|社区|新区|开发区|村)$/

/** 按组展开同义词（纯函数、可测试）：命中任一说法即整组并入；`rounds` 限制级联，避免互相触发无限扩张 */
export function expandSynonyms(text: string, groups: string[][], rounds = 2): string[] {
  const out = new Set<string>()
  let frontier = text
  for (let r = 0; r < rounds; r++) {
    const added: string[] = []
    for (const g of groups) {
      if (g.some((w) => frontier.includes(w))) {
        for (const w of g) if (!out.has(w)) added.push(w)
      }
    }
    if (added.length === 0) break
    for (const w of added) out.add(w)
    frontier = added.join(' ')
  }
  return [...out]
}

/** 词长上限（与 `body-relevance.ts` 的字面命中口径一致：过长的整句词不作字面依据） */
const MAX_TERM_CHARS = 12
/** 每组最多保留的词数（防"词表爆炸"把判定放宽到无意义） */
const MAX_TERMS_PER_GROUP = 40

/** 规范化词条：去空白、限长、去重、限量 */
function normalizeTerms(list: unknown, cap = MAX_TERMS_PER_GROUP): string[] {
  const out: string[] = []
  if (!Array.isArray(list)) return out
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const v = raw.replace(/\s+/g, '').trim()
    if (v.length < 2 || v.length > MAX_TERM_CHARS) continue
    if (!out.includes(v)) out.push(v)
    if (out.length >= cap) break
  }
  return out
}

/** 大模型回包解析（纯函数、可测试）：只认三个数组字段，其余一律忽略 */
export function parseLexiconPayload(text: string): { topic?: unknown; keyPoints?: unknown; scope?: unknown } | null {
  const s = (text ?? '').trim()
  if (!s) return null
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>
    return obj && typeof obj === 'object' ? obj : null
  } catch {
    return null
  }
}

/** 一次很便宜的调用：把要求解析成三组词（输出限 400 token，失败/无 Provider 一律本地降级） */
export interface AnalyzeOptions {
  /**
   * 是否允许调用大模型。**默认 false（纯本地、零成本、不触碰任何模型/网络代码）**——
   * 只有生成管线才会显式传 `useLlm: true`；**回放/离线测量/只读估算一律走默认值**，
   * 这样"回放调用栈里不存在 chatCompletion / 网络"是**默认保证**，而不是靠调用方记得传参。
   */
  useLlm?: boolean
  /** 调用超时（毫秒；默认 20 秒——它只是一个"便宜的补充"，不值得等） */
  timeoutMs?: number
  /** 注入式补全函数（便于单测；不传则懒加载真实 `chatCompletion`，避免测试环境强依赖 electron） */
  completer?: (system: string, user: string) => Promise<string | null>
  /** 诊断用：任务 id（只为日志/账本痕迹） */
  taskId?: string
}

/** 词表缓存（内存；key = sha256(规范化要求文本)） */
const lexiconCache = new Map<string, TopicLexiconAnalysis>()

/** 仅供单测：清空内存缓存 */
export function clearTopicLexiconCache(): void {
  lexiconCache.clear()
}

/** 纯本地解析（不发任何请求；回放与"无 Provider"路径走这里） */
export function analyzeWritingRequirementLocal(instruction: string): TopicLexiconAnalysis {
  const text = (instruction ?? '').trim()
  const key = lexiconCacheKey(text)
  const scanned = scanTopicLexicon(text)
  const base = extractTopicTerms(text)
  const hints = expandDomainHints(base)
  // 主题词：① 静态词表扫到的**专指**词；② 从要求里提取到的标题/子标题；③ 领域下位词
  const topicTerms = uniq([...scanned.specific, ...base.filter((t) => t.length <= MAX_TERM_CHARS), ...hints])
  // 要点词：静态词表的泛词 + 同义扩展
  const keyPoints = uniq([...scanned.generic, ...expandSynonyms(text, KEY_POINT_SYNONYM_GROUPS)])
  // 范围词：静态范围词 + "X镇/X街道/X区"这类后缀词
  const scopeWords = uniq([
    ...scanned.scope,
    ...base.filter((t) => t.length <= MAX_TERM_CHARS && SCOPE_SUFFIX_RE.test(t)),
    ...expandSynonyms(text, [['全区', '全市', '全省', '全县']])
  ])
  // 主题词也做一次同义扩展（"高中"→"普高/完全中学"），但只补充进主题组
  for (const w of expandSynonyms(text, TOPIC_SYNONYM_GROUPS)) {
    if (!topicTerms.includes(w)) topicTerms.push(w)
  }
  const query = buildLexiconQuery({ topicTerms, keyPoints, scopeWords })
  return {
    key,
    topicTerms: topicTerms.slice(0, MAX_TERMS_PER_GROUP),
    keyPoints: keyPoints.slice(0, MAX_TERMS_PER_GROUP),
    scopeWords: scopeWords.slice(0, MAX_TERMS_PER_GROUP),
    query,
    source: 'local',
    expanded: []
  }
}

/**
 * 解析撰写要求为词表（**默认纯本地、零成本**；只有显式 `useLlm:true` 才可能发起一次很便宜的模型调用）。
 *
 * 口径保证：
 *   · `useLlm` 缺省 = false → 本函数**同步完成**，不 import/调用任何模型或网络代码；
 *   · `useLlm: true` 时无 Provider / 调用失败 / 回包不可解析 → 一律静默降级为本地词表（`source='llm-failed'`），
 *     **绝不抛错、绝不阻断生成**；
 *   · 同一要求按 hash 只算一次（命中的是缓存时，不会进入 LLM 分支）。
 */
export async function analyzeWritingRequirement(
  instruction: string,
  opts: AnalyzeOptions = {}
): Promise<TopicLexiconAnalysis> {
  const local = analyzeWritingRequirementLocal(instruction)
  if (opts.useLlm !== true || lexiconCache.has(local.key)) {
    const cached = lexiconCache.get(local.key)
    return cached ?? local
  }
  const completer = opts.completer ?? (await loadDefaultCompleter(opts))
  if (!completer) {
    lexiconCache.set(local.key, local)
    return local
  }
  const system = [
    '你是地方志资料整理助手。请把用户的「撰写要求」解析成三组中文词，用于在资料库里筛材料。',
    '1) topic: 主题词（主题/标题本身及其同义说法，如"高中/普高/完全中学"）；',
    '2) keyPoints: 要点词（要求里点名的动作与指标，如"新建/扩建/招生人数/学位"，并给出同义说法）；',
    '3) scope: 范围词（地域与层级限定，如"长乐区/全区/乡镇"）。',
    '每个词 2~12 字，每组不超过 24 个，只输出 JSON：{"topic":[],"keyPoints":[],"scope":[]}',
    '不要输出解释或代码块围栏。'
  ].join('\n')
  let raw: string | null = null
  try {
    raw = await completer(system, '本次撰写要求：\n' + instruction)
  } catch {
    raw = null
  }
  const parsed = raw ? parseLexiconPayload(raw) : null
  if (!parsed) {
    // 调用失败/回包不可解析 → 降级为本地词表（**不阻断生成**）
    const failed: TopicLexiconAnalysis = { ...local, source: 'llm-failed' }
    lexiconCache.set(local.key, failed)
    return failed
  }
  const topicFromLlm = normalizeTerms(parsed.topic)
  const keysFromLlm = normalizeTerms(parsed.keyPoints)
  const scopeFromLlm = normalizeTerms(parsed.scope)
  const topicTerms = uniq([...local.topicTerms, ...topicFromLlm])
  const keyPoints = uniq([...local.keyPoints, ...keysFromLlm])
  const scopeWords = uniq([...local.scopeWords, ...scopeFromLlm])
  const expanded = uniq([...topicFromLlm, ...keysFromLlm, ...scopeFromLlm]).filter((w) => !isCoveredLocally(w, local))
  const result: TopicLexiconAnalysis = {
    key: local.key,
    topicTerms,
    keyPoints,
    scopeWords,
    query: buildLexiconQuery({ topicTerms, keyPoints, scopeWords }),
    source: 'llm',
    expanded
  }
  lexiconCache.set(local.key, result)
  return result
}

/** 该词是否已由本地静态词表/同义表覆盖（只用于诊断 `expanded`）。 */
function isCoveredLocally(word: string, local: TopicLexiconAnalysis): boolean {
  return local.topicTerms.includes(word) || local.keyPoints.includes(word) || local.scopeWords.includes(word)
}

/** 把三组词拼成粗筛查询串（与 `judgeBodyRelevance`/`scoreChunk` 的空格分词口径一致） */
export function buildLexiconQuery(groups: { topicTerms: string[]; keyPoints: string[]; scopeWords: string[] }): string {
  return uniq([...groups.topicTerms, ...groups.keyPoints, ...groups.scopeWords]).join(' ')
}

/** 取词表用于**判定路径**的补充词（`judgeBodyRelevance(text, q, title, extraTerms)`） */
export function lexiconExtraTerms(a: TopicLexiconAnalysis): string[] {
  return uniq([...a.topicTerms, ...a.keyPoints])
}

/**
 * 词表里每个词的档位（诊断/测试用）：**只升不降**——三组词的组别会带来最小档位。
 * `topicTerms` 至少 weak（主题词不该被当范围词），`keyPoints` 至少 generic，`scopeWords` 保持 scope。
 */
export function lexiconTermClasses(a: TopicLexiconAnalysis): { term: string; group: 'topic' | 'keyPoint' | 'scope'; cls: TopicTermClass }[] {
  const out: { term: string; group: 'topic' | 'keyPoint' | 'scope'; cls: TopicTermClass }[] = []
  const scanned = scanTopicLexicon(lexiconExtraTerms(a).join(' '))
  const specificSet = new Set(scanned.specific)
  for (const t of a.topicTerms) {
    const base = specificSet.has(t) ? 'specific' : 'weak'
    out.push({ term: t, group: 'topic', cls: base })
  }
  for (const t of a.keyPoints) {
    out.push({ term: t, group: 'keyPoint', cls: upgradeTopicClass(specificSet.has(t) ? 'specific' : 'generic', 'generic') })
  }
  for (const t of a.scopeWords) out.push({ term: t, group: 'scope', cls: 'scope' })
  return out
}

function uniq(list: string[]): string[] {
  const out: string[] = []
  for (const t of list) {
    const v = (t ?? '').trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** 懒加载真实补全函数（把 electron 依赖隔离在动态 import 里，单测/回放不需要它） */
async function loadDefaultCompleter(opts: AnalyzeOptions): Promise<((system: string, user: string) => Promise<string | null>) | null> {
  try {
    const { getSettings } = await import('../db/settings')
    const { getProviderSecret } = await import('../llm/provider-store')
    const { safeStorageCodec } = await import('../llm/secret')
    const { chatCompletion } = await import('../llm/chat')
    const settings = getSettings()
    const providerId = settings.compilationProviderId
    if (!providerId) return null
    const provider = getProviderSecret(providerId, safeStorageCodec)
    if (!provider?.apiKey) return null
    return async (system: string, user: string) => {
      const res = await chatCompletion(
        { apiBase: provider.config.apiBase, model: provider.config.model, apiKey: provider.apiKey },
        [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        opts.timeoutMs ?? 20000,
        { kind: 'compilation-lexicon', taskId: opts.taskId },
        { maxRetries: 0, temperature: 0 }
      )
      return res.ok ? res.text : null
    }
  } catch {
    return null
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeEach } = import.meta.vitest

  const REQ =
    '标题为“高中学校设置”，包括学校的新建、扩建、改建、合并、规模、招生人数、地理分布等等，注意，只需要包含长乐区及以下层级的内容即可，其他行政层级如全省性的内容不用加入其中。'

  describe('topic-lexicon 撰写要求现算词表（第一组 ③）', () => {
    beforeEach(() => clearTopicLexiconCache())

    it('纯本地解析出三组词，并把同义扩展补进要点词（不发任何请求）', () => {
      const a = analyzeWritingRequirementLocal(REQ)
      expect(a.source).toBe('local')
      expect(a.topicTerms).toContain('高中')
      expect(a.topicTerms).toContain('中学')
      expect(a.scopeWords).toContain('长乐区')
      // 同义扩展：要求里有"新建/扩建/改建"→ 补出"扩容/改造/搬迁"等同义说法
      expect(a.keyPoints).toContain('新建')
      expect(a.keyPoints).toContain('扩容')
      expect(a.keyPoints).toContain('搬迁')
      // 范围词绝不进主题词
      expect(a.topicTerms).not.toContain('长乐区')
      expect(a.query).toContain('高中')
    })

    it('无 Provider / 调用失败 → 本地降级且不阻断（source=llm-failed）', async () => {
      const a = await analyzeWritingRequirement(REQ, {
        useLlm: true,
        completer: async () => {
          throw new Error('network down')
        }
      })
      expect(a.source).toBe('llm-failed')
      expect(a.topicTerms).toContain('高中')
      // 回包不可解析也降级
      const b = await analyzeWritingRequirement(REQ, { useLlm: true, completer: async () => '抱歉，我无法回答' })
      expect(b.source).toBe('llm-failed')
    })

    it('同一要求**只算一次**（按 hash 缓存；第二次连 completer 都不再调用）', async () => {
      let calls = 0
      const completer = async (): Promise<string> => {
        calls += 1
        return '{"topic":["普高"],"keyPoints":["学位"],"scope":[]}'
      }
      const a = await analyzeWritingRequirement(REQ, { useLlm: true, completer })
      expect(a.source).toBe('llm')
      expect(a.topicTerms).toContain('普高') // 大模型补充的词并入了主题组
      expect(a.keyPoints).toContain('学位')
      // `expanded` 只列"本地词表/同义表里没有"的词——"普高"本地同义表已有，故不在其中
      expect(a.expanded).toEqual([])
      const b = await analyzeWritingRequirement(REQ, { useLlm: true, completer })
      expect(b).toBe(a)
      expect(calls).toBe(1)
      // 缓存键只看规范化后的文本：多余空白不影响命中
      expect(lexiconCacheKey(REQ)).toBe(lexiconCacheKey('  ' + REQ.replace(/，/g, '，') + '  '))
      // 回放口径：useLlm:false 时绝不调用
      let llmCalled = false
      const c = await analyzeWritingRequirement(REQ, {
        useLlm: false,
        completer: async () => {
          llmCalled = true
          return '{}'
        }
      })
      expect(c.source).toBe('llm') // 命中了上一步的缓存（同一要求）
      expect(llmCalled).toBe(false)
    })

    it('回放口径：另一条要求 + useLlm:false → 纯本地、零调用', async () => {
      let called = false
      const a = await analyzeWritingRequirement('本次撰写任务：撰写福州市学前教育事业发展概况。', {
        useLlm: false,
        completer: async () => {
          called = true
          return '{"topic":["幼儿园"]}'
        }
      })
      expect(called).toBe(false)
      expect(a.source).toBe('local')
    })

    it('词表档位只升不降：主题词组里的词至少 weak，校名简称仍升到 specific', () => {
      const a = analyzeWritingRequirementLocal('标题为“高中学校设置”，含长乐三中滨海校区的新建情况。')
      const classes = lexiconTermClasses(a)
      const sanzhong = classes.find((c) => c.term === '三中')
      expect(sanzhong?.cls).toBe('specific')
      const scope = classes.find((c) => c.group === 'scope')
      expect(scope?.cls).toBe('scope')
      // 要点词永远不会被判成 specific（只提高召回，不单独放行）
      for (const c of classes.filter((x) => x.group === 'keyPoint')) {
        expect(c.cls === 'specific' && !scanTopicLexicon(c.term).specific.includes(c.term)).toBe(false)
      }
    })

    it('parseLexiconPayload 容错（围栏/前后废话/坏 JSON）', () => {
      expect(parseLexiconPayload('```json\n{"topic":["高中"]}\n```')).toEqual({ topic: ['高中'] })
      expect(parseLexiconPayload('好的：{"topic":["高中"],"keyPoints":[]} 以上')).toEqual({ topic: ['高中'], keyPoints: [] })
      expect(parseLexiconPayload('没有 JSON')).toBeNull()
      expect(parseLexiconPayload('{坏 json}')).toBeNull()
    })

    it('同义扩展不会无限级联（rounds 限制）', () => {
      const g = [
        ['甲', '乙'],
        ['乙', '丙'],
        ['丙', '丁']
      ]
      const one = expandSynonyms('甲', g, 1)
      expect(one).toEqual(['甲', '乙'])
      const two = expandSynonyms('甲', g, 2)
      expect(two).toEqual(['甲', '乙', '丙'])
    })
  })
}
