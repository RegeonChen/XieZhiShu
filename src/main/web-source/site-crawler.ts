/**
 * site-crawler.ts —— 网页资料库：站点发现 / 标题粗筛 / 增量导入正文（2026-08-11）。
 *
 * 生成初稿流程中的角色：
 *   1. 对每个注册站点同步文章清单（抓栏目/列表页提取同域 .htm 文章链接，增量 upsert 到 web_site_articles）。
 *   2. 用撰写要求（query）对文章标题做粗筛（bigram 命中），得到"与本次撰写相关的文件"。
 *   3. 命中文章增量抓取正文落库为 kind='url' 的 sources（已抓过则跳过），并入生成 scope。
 * 与本地文件完全一致：后续 RAG 检索 / 矛盾扫描 / 来源溯源复用现有逻辑。
 * 抓取使用 Electron net（url-fetcher.fetchUrl），遵循 http/https 白名单。
 */
import type { Source } from '../../shared/types'
import { fetchUrl } from '../import/url-fetcher'
import { bigrams } from '../rag/retrieval'
import { getSourceByUrl, insertSource } from '../db/sources'
import {
  getWebSiteById,
  listSiteArticles,
  listWebSites,
  updateWebSiteLastSynced,
  upsertSiteArticles
} from '../db/web-sites'

/** 政务网站常见的静态文章后缀 */
const ARTICLE_SUFFIX_RE = /\.(?:htm|html|shtml|aspx?)\b/i

/** 单次站点同步最多抓取列表页数（首页 + 栏目/分页），控制耗时 */
const SYNC_MAX_PAGES = 20
/** 站点发现 BFS 最大深度（0=仅首页） */
const SYNC_MAX_DEPTH = 2
/** 增量导入正文的串行延迟（毫秒），降低对目标站点的压力 */
const IMPORT_DELAY_MS = 120

/** 简单 HTML → 纯文本（标签/实体/空白清理，供提取链接文本） */
export function stripTags(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
}

/**
 * 从 HTML 中提取全部超链接（绝对 URL + 链接文本），供发现文章清单用（纯函数、可测试）。
 */
export function extractLinks(html: string, baseUrl: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = []
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1].trim()
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue
    let abs: URL
    try {
      abs = new URL(href, baseUrl)
    } catch {
      continue
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue
    const text = stripTags(m[2])
    out.push({ href: abs.toString(), text })
  }
  return out
}

/** 是否为"文章页"链接（静态后缀判定；纯函数、可测试） */
export function isArticleUrl(url: string): boolean {
  return ARTICLE_SUFFIX_RE.test(url.split('?')[0].split('#')[0])
}

/**
 * 领域下位词兜底表（2026-08-13）：
 * 政务新闻标题是"下位概念"（如"配建幼儿园""新学年校历""学校拟招生"），
 * 与撰写章节标题"学前教育"几乎没有字面/字符对重叠，纯标题 bigram 永远对不上。
 * 当撰写关键词命中某领域的 key（如"教育"）时，把该领域的高区分度下位词一并纳入候选与精过滤。
 *
 * 收窄原则（2026-08-13 实测修正；2026-08-14 再次收窄）：
 * 1. 不含宽泛的 key 本身（"教育"），避免"政绩观学习教育""警示教育"政治学习文章误召回。
 * 2. 剔除"入学"——它作为子串会命中"深**入学**习贯彻"（"深入"+"学习"跨词拼接），
 *    导致大量"学习教育"类政治新闻被误判为教育相关（test1 实测 5 篇误召回的直接根因）。
 * 3. 剔除"教学/小学/中学/大学/义务/教师/学生/课程/普惠"等泛教育词——
 *    它们会召回"重庆中新大学""兰州教育信息化""厦门大学"等外地/高等教育新闻，与本地学前教育志书无关。
 * 4. 2026-08-14 再剔除"招生/校历/学位"：这三词过宽，会命中"中招计划""普高自主招生""义务教育招生"
 *    "小学剩余学位抽签"等大量中小学/高中新闻，正文精过滤仅因含"招生/学位"就落库，
 *    使网页召回的无关文章膨胀到 300+ 篇，矛盾扫描被噪音淹没（test2 漏检 test1 矛盾的主因之一）。
 *    学前教育真正的招生/学位类新闻，其正文必含"幼儿园/学前/幼儿/保育/入园"等核心词，仍会被保留。
 * 只保留学前教育高区分度核心词（学前/幼儿园/幼儿/保育/托育/入园/幼教），后续可按需扩展其他门类。
 */
const DOMAIN_HINTS: { key: string; words: string[] }[] = [
  {
    key: '教育',
    words: ['学前', '幼儿园', '幼儿', '保育', '托育', '入园', '幼教']
  }
]

/** 从撰写指令中提取用于粗筛的短关键词（标题/子标题），避免整句长文本稀释 bigram（纯函数、可测试） */
export function extractTopicTerms(query: string): string[] {
  const out: string[] = []
  const add = (t: string): void => {
    const v = t.trim()
    if (v && v.length >= 2 && v.length <= 20 && !out.includes(v)) out.push(v)
  }
  // 1) 引号内短文本（标题/子标题）：'…' "…" 「…」 “…” 『…』
  for (const m of query.matchAll(/[「『“"']([^」』”"']{2,20})[」』”"']/g)) {
    add(m[1])
  }
  // 2) "标题为/标题是/标题：…" 后的短词（无引号时的兜底）。
  //    2026-08-14 容错：捕获组前允许一个可选的引号字符，兼容"标题为“学前教育“"这类
  //    引号不配对（结尾误用左引号）的输入——否则会因紧跟引号而提取失败、回退整句，
  //    导致矛盾扫描/网页检索的主题词不稳定（test3 漏检矛盾的直接根因）。
  const titled = query.match(/(?:标题|题目)[为是]?\s*[:：]?\s*[「『“"'」』”]?([^\s，。；、,.「『』」“”"']+)/)
  if (titled) add(titled[1])
  // 3) 提取不到任何短词时回退整句（兼容"无标题、纯要求"的指令）
  if (out.length === 0) {
    const fallback = query.replace(/\s+/g, '')
    if (fallback) out.push(fallback)
  }
  return out
}

/** 依据关键词命中领域 key，扩展出该领域的高区分度下位词（纯函数、可测试） */
export function expandDomainHints(terms: string[]): string[] {
  const out = new Set<string>()
  for (const t of terms) {
    for (const d of DOMAIN_HINTS) {
      if (t.includes(d.key)) for (const w of d.words) out.add(w)
    }
  }
  return [...out]
}

/**
 * 文本与关键词集合的匹配（纯函数、可测试）：任一关键词完整子串命中，或任一关键词的任一 bigram 命中。
 * 阈值从早期"≥2 个共同 bigram"放宽为"≥1"——标题/正文只要与关键词有一个双字重叠即视为相关，
 * 粗筛阶段宁多勿漏，交由后续正文级精过滤兜底。
 */
export function matchesAny(text: string, terms: string[]): boolean {
  const corpus = (text ?? '').replace(/\s+/g, '')
  if (!corpus) return false
  for (const term of terms) {
    if (!term) continue
    if (corpus.includes(term)) return true
  }
  const corpusBigrams = new Set(bigrams(corpus))
  for (const term of terms) {
    for (const b of bigrams(term)) {
      if (corpusBigrams.has(b)) return true
    }
  }
  return false
}

/**
 * 精确子串匹配（纯函数、可测试）：用于正文级精过滤。
 * 只做"完整关键词子串"命中，**不做 bigram 模糊**。原因：bigram 会把"学前教育"拆成"学前/前教/教育"，
 * 其中"教育"过于宽泛，会导致"政绩观学习教育""警示教育"这类政治学习文章仅因含"教育"二字就命中精过滤；
 * 完整子串匹配则要求正文出现"学前教育/学前/幼儿园/保育"等高区分度词，能真正把无关文章挡在库外。
 */
export function matchesExact(text: string, terms: string[]): boolean {
  const corpus = (text ?? '').replace(/\s+/g, '')
  if (!corpus) return false
  return terms.some((t) => t && corpus.includes(t))
}

/** 文章 URL 去重键（纯函数、可测试）：去掉协议与尾部斜杠，使 http/https 同文归并为同一篇 */
export function dedupeArticleKey(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

/**
 * 站点发现（BFS）：从 rootUrl 开始抓列表页，提取同域文章链接清单；
 * 栏目/分页链接入队继续（限深度与页数）。返回 { url, title }[]（URL 去重，按发现顺序）。
 */
export async function discoverSiteArticles(
  rootUrl: string,
  opts: { maxPages?: number; maxDepth?: number } = {}
): Promise<{ url: string; title: string }[]> {
  const { maxPages = SYNC_MAX_PAGES, maxDepth = SYNC_MAX_DEPTH } = opts
  let base: URL
  try {
    base = new URL(rootUrl)
  } catch {
    return []
  }
  const host = base.host
  const found = new Map<string, { url: string; title: string }>() // dedupeKey -> 文章
  const visited = new Set<string>()
  const queue: { url: string; depth: number }[] = [{ url: base.toString(), depth: 0 }]
  let pages = 0

  while (queue.length > 0 && pages < maxPages) {
    const { url, depth } = queue.shift()!
    if (visited.has(url) || depth > maxDepth) continue
    visited.add(url)
    let html: string
    try {
      html = (await fetchUrl(url)).rawHtml
    } catch {
      continue // 列表页抓取失败则跳过该页
    }
    pages++
    for (const { href, text } of extractLinks(html, url)) {
      let u: URL
      try {
        u = new URL(href)
      } catch {
        continue
      }
      if (u.host !== host) continue // 只在本站内
      const abs = u.toString()
      if (isArticleUrl(abs)) {
        const key = dedupeArticleKey(abs)
        if (!found.has(key)) found.set(key, { url: abs, title: text || abs })
      } else if (depth + 1 <= maxDepth) {
        queue.push({ url: abs, depth: depth + 1 })
      }
    }
  }
  return [...found.values()]
}

/**
 * 标题粗筛（纯函数、可测试）：把撰写要求 query 提取为标题/子标题短关键词，
 * 并扩展领域下位词兜底后，对站点文章标题做"宽召回"（任一关键词子串或任一 bigram 命中）。
 * 宁多勿漏：命中仅代表"候选"，最终是否落库由正文级精过滤判定。
 */
export function filterArticlesByQuery(
  articles: { url: string; title: string }[],
  query: string
): { url: string; title: string }[] {
  const terms = extractTopicTerms(query)
  if (terms.length === 0) return []
  const allTerms = [...new Set([...terms, ...expandDomainHints(terms)])]
  return articles.filter((a) => matchesAny(a.title ?? '', allTerms))
}

/**
 * 增量导入单篇文章正文（幂等）：sources 中 (url, taskId) 已存在则直接返回已有，不重复抓取。
 * 传入 terms（关键词 + 领域下位词）时做**正文级精过滤**：抓取正文后，仅当标题+正文与关键词相关才落库，
 * 无关文章直接丢弃（不入资料库）。taskId 非空时落库为"任务绑定的网页缓存文章"（不进资料库、删任务时清理）。
 */
export async function importSiteArticle(
  url: string,
  title: string,
  terms: string[] = [],
  taskId?: string
): Promise<Source | null> {
  const existing = getSourceByUrl(url, taskId)
  if (existing) return existing
  try {
    const { cleanedText, snapshotAt } = await fetchUrl(url)
    // 精过滤探测文本：标题 + 正文前 12000 字（足以判定主题，避免超长正文拖慢匹配）
    if (terms.length > 0 && !matchesExact(`${title}\n${cleanedText}`.slice(0, 12000), terms)) return null
    const source: Source = {
      id: crypto.randomUUID(),
      kind: 'url',
      title: title || url,
      url,
      urlSnapshotAt: snapshotAt,
      cleanedText,
      status: 'ready',
      taskId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    return insertSource(source)
  } catch {
    return null // 单篇抓取失败跳过，不阻断整体
  }
}

/**
 * 同步站点：发现文章清单 → 增量写入 web_site_articles → 更新 last_synced_at。
 * 返回本次**新增**文章数（首次同步为全量，之后仅新增）。
 */
export async function syncSite(siteId: string): Promise<number> {
  const site = getWebSiteById(siteId)
  if (!site) return 0
  const articles = await discoverSiteArticles(site.rootUrl)
  const added = upsertSiteArticles(siteId, articles)
  updateWebSiteLastSynced(siteId, new Date().toISOString())
  return added
}

/**
 * 生成初稿时的网页资料检索入口（全局绑定：遍历所有注册站点）：
 * 同步清单 → 标题粗筛(query) → 抓正文做正文级精过滤 → 返回命中的 sourceIds（并入生成 scope）。
 * 命中文章按 taskId 落库为"任务绑定的网页缓存文章"。任一站点失败不阻断其他站点。
 */
export async function fetchRelatedSiteSources(
  query: string,
  taskId: string,
  onSite?: (siteTitle: string) => void
): Promise<string[]> {
  const sites = listWebSites()
  if (sites.length === 0) return []
  const terms = extractTopicTerms(query)
  const allTerms = [...new Set([...terms, ...expandDomainHints(terms)])]
  if (allTerms.length === 0) return []
  const ids: string[] = []
  for (const site of sites) {
    onSite?.(site.title || site.rootUrl)
    try {
      await syncSite(site.id)
    } catch {
      continue
    }
    const articles = listSiteArticles(site.id)
    const hits = filterArticlesByQuery(articles, query)
    for (const h of hits) {
      const src = await importSiteArticle(h.url, h.title, allTerms, taskId)
      if (src) ids.push(src.id)
      if (IMPORT_DELAY_MS > 0) await new Promise((r) => setTimeout(r, IMPORT_DELAY_MS))
    }
  }
  return ids
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('site-crawler utils (web source library)', () => {
    it('extracts absolute links with anchor text', () => {
      const html = `
        <a href="/xxgk/ztzl/xqnj/202512/t20251203_5239523.htm">福州新区年鉴（2025）</a>
        <a href="https://example.com/other.htm">外部链接</a>
        <a href="#anchor">锚点</a>
        <a href="javascript:void(0)">脚本</a>
        <a href="../rel/202608/t20260811_5357559.htm">相对链接</a>
      `
      const links = extractLinks(html, 'https://fzxq.fuzhou.gov.cn/xxgk/ztzl/')
      expect(links).toHaveLength(3)
      expect(links[0].href).toBe('https://fzxq.fuzhou.gov.cn/xxgk/ztzl/xqnj/202512/t20251203_5239523.htm')
      expect(links[0].text).toBe('福州新区年鉴（2025）')
      expect(links[1].href).toBe('https://example.com/other.htm')
    })

    it('detects article urls by suffix', () => {
      expect(isArticleUrl('https://fzxq.fuzhou.gov.cn/a.htm')).toBe(true)
      expect(isArticleUrl('https://fzxq.fuzhou.gov.cn/a.htm?page=2')).toBe(true)
      expect(isArticleUrl('https://fzxq.fuzhou.gov.cn/xxgk/ztzl/xqnj/')).toBe(false)
      expect(isArticleUrl('https://fzxq.fuzhou.gov.cn/sitemap.xml')).toBe(false)
    })

    it('filters articles by query bigrams', () => {
      const articles = [
        { url: 'https://x.gov.cn/a.htm', title: '2021年全区教育工作总结' },
        { url: 'https://x.gov.cn/b.htm', title: '台湾事务交往工作动态' },
        { url: 'https://x.gov.cn/c.htm', title: '全区教育系统党建会议召开' }
      ]
      const hits = filterArticlesByQuery(articles, '2021年全区教育')
      expect(hits.map((h) => h.url)).toEqual(['https://x.gov.cn/a.htm', 'https://x.gov.cn/c.htm'])
    })

    it('returns empty when query or title is empty', () => {
      expect(filterArticlesByQuery([{ url: 'https://x.gov.cn/a.htm', title: '教育' }], '')).toEqual([])
      expect(filterArticlesByQuery([{ url: 'https://x.gov.cn/a.htm', title: '' }], '教育')).toEqual([])
    })

    it('extracts title/subtitle terms from instruction', () => {
      const query = '这次撰写任务的标题为“学前教育”，分为两个子标题“教育与保育”和“园所设置”。注意按照时间顺序展开'
      expect(extractTopicTerms(query)).toEqual(['学前教育', '教育与保育', '园所设置'])
      // 无引号无标题引导语 → 回退整句
      expect(extractTopicTerms('2021年全区教育')).toEqual(['2021年全区教育'])
    })

    it('tolerates unpaired quotes when extracting title (test3 regression, 2026-08-14)', () => {
      // 结尾误用左引号“而非右引号”，仍应提取出标题短词，而非回退整句
      expect(extractTopicTerms('这次撰写任务的标题为“学前教育“')).toEqual(['学前教育'])
      expect(extractTopicTerms('这次撰写任务的标题为“学前教育”')).toEqual(['学前教育'])
    })

    it('expands education domain hints from topic term', () => {
      const terms = extractTopicTerms('标题为“学前教育”')
      const hints = expandDomainHints(terms)
      expect(hints).toContain('幼儿园')
      expect(hints).toContain('保育')
      expect(hints).toContain('幼儿')
      // 宽泛的 key 本身（"教育"）不进兜底表，避免误召回"政绩观学习教育"
      expect(hints).not.toContain('教育')
      // 收窄后剔除跨词误匹配与泛教育词（2026-08-13 test1 误召回回归）
      expect(hints).not.toContain('入学') // "入学" 会命中"深**入学**习"
      expect(hints).not.toContain('大学') // 避免召回"重庆中新大学"等外地新闻
      expect(hints).not.toContain('教学')
      expect(hints).not.toContain('学生')
      // 2026-08-14 再收窄：剔除招生/校历/学位，避免召回中小学/高中招生新闻（test2 漏检矛盾主因）
      expect(hints).not.toContain('招生')
      expect(hints).not.toContain('校历')
      expect(hints).not.toContain('学位')
    })

    it('does not mis-match "入学" inside "深入学习" (test1 误召回回归)', () => {
      const query = '这次撰写任务的标题为“学前教育”'
      const terms = [...extractTopicTerms(query), ...expandDomainHints(extractTopicTerms(query))]
      expect(terms).not.toContain('入学')
      expect(matchesExact('要深入学习贯彻习近平总书记重要讲话精神', terms)).toBe(false)
      expect(matchesExact('长乐区幼儿园开展入学报名', terms)).toBe(true)
    })

    it('dedupes http/https article urls to the same key', () => {
      expect(dedupeArticleKey('https://fzxq.fuzhou.gov.cn/a.htm')).toBe('fzxq.fuzhou.gov.cn/a.htm')
      expect(dedupeArticleKey('http://fzxq.fuzhou.gov.cn/a.htm')).toBe('fzxq.fuzhou.gov.cn/a.htm')
      expect(dedupeArticleKey('https://fzxq.fuzhou.gov.cn/b.htm/')).toBe('fzxq.fuzhou.gov.cn/b.htm')
    })

    it('recalls kindergarten news and rejects politics-study news via exact prefilter (test1 regression)', () => {
      const query = '这次撰写任务的标题为“学前教育”，分为两个子标题“教育与保育”和“园所设置”。注意按照时间顺序展开'
      const articles = [
        { url: 'https://fzxq.fuzhou.gov.cn/a.htm', title: '长乐首占安置房配建幼儿园 共有1346套下月部分完工' },
        { url: 'https://fzxq.fuzhou.gov.cn/b.htm', title: '福州新区党工委（长乐区委）树立和践行正确政绩观学习教育专题党课暨全区警示教育会举行' }
      ]
      // 标题粗筛（宽召回）：两篇都进候选（幼儿园=领域词命中；政绩观学习=含"教育"bigram）
      const hits = filterArticlesByQuery(articles, query)
      expect(hits.map((h) => h.url)).toEqual(['https://fzxq.fuzhou.gov.cn/a.htm', 'https://fzxq.fuzhou.gov.cn/b.htm'])

      // 正文精过滤（精确子串）：幼儿园正文保留，政绩观学习正文挡掉
      const terms = [...extractTopicTerms(query), ...expandDomainHints(extractTopicTerms(query))]
      expect(matchesExact('长乐首占安置房配建幼儿园，共有1346套下月部分完工。', terms)).toBe(true)
      expect(matchesExact('树立和践行正确政绩观学习教育，开展全区警示教育。', terms)).toBe(false)
    })
  })
}
