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
import { logMain } from '../logger'
import { bigrams } from '../rag/retrieval'
import { enqueueIndex } from '../rag/indexer'
import { getSourceByUrl, getAnySourceByUrl, insertSource, updateSourcePublishedAt } from '../db/sources'
import {
  getWebSiteById,
  getSiteArticle,
  listSiteArticles,
  listWebSites,
  updateWebSiteLastSynced,
  updateSiteArticleFetched,
  updateSiteArticlePublished,
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
/** 成熟正文提取（D8）：优先取 article/main/内容容器，去导航/页脚/广告噪音，并保留表格单元格（如志书数据表）。纯函数、可测试。 */
export function extractArticleText(html: string): string {
  let doc = html
  const article = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)
  const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)
  if (article) {
    doc = article[1]
  } else if (main) {
    doc = main[1]
  } else {
    const content = /<(?:div|section)[^>]*class=["'][^"']*(?:content|article|news|detail|body|text)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i.exec(html)
    if (content) doc = content[1]
  }
  // 表格保留：单元格→制表符，行→换行
  doc = doc.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, (_, c: string) => c.trim() + '\t')
  doc = doc.replace(/<tr[^>]*>/gi, '\n').replace(/<\/tr>/gi, '\n')
  doc = doc.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  doc = doc.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  doc = doc.replace(/<(?:nav|footer|aside)\b[^>]*>[\s\S]*?<\/(?:nav|footer|aside)>/gi, '')
  doc = doc.replace(/<[^>]+>/g, ' ')
  doc = doc
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n')
  return doc.trim()
}

/** 从 URL 生成可读的兜底标题（E2）：页面没有 <title> 时不再把整条 URL 当标题（导出附录/来源小卡里很难看，
 *  而且 URL 里的 `t20251203` 这类数字会被年份兜底误读成 2025）。 */
export function fallbackTitleFromUrl(url: string): string {
  let host = url
  try {
    host = new URL(url).host
  } catch {
    /* 非法 URL：原样返回 */
  }
  return host + '（页面无标题）'
}

/**
 * 从 HTML 提取发布日期（E10）：meta property/name 的 published_time/publishdate/pubdate，或 <time datetime>，或可见日期文本。纯函数、可测试。 */
export function extractPublishedDate(html: string): string | null {
  const metas = [
    /<meta[^>]+(?:property|name)=["'](?:article:published_time|publishdate|pubdate|date)["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:article:published_time|publishdate|pubdate|date)["']/i
  ]
  for (const re of metas) {
    const m = re.exec(html)
    if (m && m[1]) return m[1].trim().slice(0, 20) || null
  }
  const time = /<time[^>]*datetime=["']([^"']+)["']/i.exec(html)
  if (time && time[1]) return time[1].trim().slice(0, 20)
  /*
   * 可见日期文本。**日/月的候选必须长在前**（`3[01]|[12]\d|0?[1-9]`）：
   * 原写法把 `0?[1-9]` 放在最前，而结尾没有强制分隔符，于是 "2016-06-22" 只匹配到 "2016-06-2"，
   * 实测把库里 477 篇网页的发布时间全部截掉了最后一位（2026-09-12 真实数据核对）。
   */
  const text = /(20\d{2}\s*[年./-]\s*(?:1[0-2]|0?[1-9])\s*[月./-]\s*(?:3[01]|[12]\d|0?[1-9])\s*日?)/.exec(html)
  return text ? text[1].trim() : null
}

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

/** 常用"栏目/列表/频道页"的 basename（去掉扩展名后）——这些几乎不可能是单篇文章页。 */
const LIST_PAGE_BASENAMES = new Set(['list', 'index', 'default', 'channel', 'category', 'column', 'col', 'lm', 'more', 'news_list'])

/**
 * 是否为"栏目/列表页"链接（纯函数、可测试、强特征、低误伤）：
 * 只用 URL 的 basename 判断主流列表/栏目页命名（list/index/default/channel/category/column/col/lm/more/news_list）。
 * 真实文章页的 basename 通常是日期/文章 ID/数字字母串（如 t20250101_xxx.htm、20250101.htm、a.htm），不在名单内，不会被误伤。
 */
export function isListPageUrl(url: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const path = u.pathname.replace(/\/+$/, '')
  const seg = path.split('/').filter(Boolean)
  const last = seg.length > 0 ? seg[seg.length - 1] : ''
  const base = last.replace(/\.(?:htm|html|shtml|aspx?)$/i, '').toLowerCase()
  if (LIST_PAGE_BASENAMES.has(base)) return true
  // 路径段命中列表关键词（如 /more/<栏目ID>.shtml 这类"更多"列表页）且 basename 为纯数字 → 视为列表页。
  // 真实文章页的 basename 通常含日期/文章 ID（含字母）或不带列表关键词的路径段，不会被命中，避免误伤相关文章。
  if (/^\d+$/.test(base) && seg.some((s) => LIST_PAGE_BASENAMES.has(s.toLowerCase()))) return true
  return false
}

/** 是否为"文章页"链接（静态后缀判定；纯函数、可测试） */
export function isArticleUrl(url: string): boolean {
  // ① 排除常见栏目/列表页（如 .../list.shtml、.../index.html），避免列表页被当作单篇文章收录
  if (isListPageUrl(url)) return false
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
  // 2) "标题为/标题是/标题：…" 后的短词（无引号时的兜底）。`主题` 同样计入：
  //    预设提示词已改为「本次资料收集的主题为 ……」，用户若删掉引号，这一步才兜得住。
  //    2026-08-14 容错：捕获组前允许一个可选的引号字符，兼容"标题为“学前教育“"这类
  //    引号不配对（结尾误用左引号）的输入——否则会因紧跟引号而提取失败、回退整句，
  //    导致矛盾扫描/网页检索的主题词不稳定（test3 漏检矛盾的直接根因）。
  const titled = query.match(/(?:标题|题目|主题)[为是]?\s*[:：]?\s*[「『“"'」』”]?([^\s，。；、,.「『』」“”"']+)/)
  if (titled) add(titled[1])
  // 3) 引号/引导语都没取到时，若检索词本身就是**关键词列表**（生成管线把大模型提取的
  //    「标题 + 关键词」用空格拼成 coarseQuery），必须逐词当作检索词，不能抹掉词间空格拼成一整句——
  //    否则 `title.includes(整串)` 永远不成立。2026-09-12 实测：正是这一步把
  //    「高中学校设置 高中 新建 扩建 …」压成一个长串，导致抓取上限的"按相关度排序"全部 0 分、
  //    退化成按清单顺序截断（丢掉 478 篇里的切题材料，汇编网页段落 77 → 4 段）。
  if (out.length === 0) {
    const tokens = query.split(/\s+/).map((s) => s.trim()).filter(Boolean)
    if (tokens.length >= 2) for (const tk of tokens) add(tk)
  }
  // 4) 仍提取不到任何短词时回退整句（兼容"无标题、纯要求"的指令）
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

/** 常见跟踪参数（URL 规范化时移除，避免同一文章多入口重复抓取/入库） */
const TRACKING_QUERY_KEYS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'spm', 'from', 'ref', 'share', 'source', 'redirect'
])

/**
 * URL 规范化（纯函数、可测试）：小写主机、去默认端口、去 fragment、去跟踪参数、去尾部斜杠。
 * 用于文章去重（A3），使 `?utm_*`、`http/https`、尾斜杠等差异归并为同一篇。
 */
export function normalizeArticleUrl(raw: string, baseUrl?: string): string {
  let u: URL
  try { u = new URL(raw, baseUrl) } catch { return raw }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw
  u.host = u.host.toLowerCase()
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = ''
  u.hash = ''
  const keep = new URLSearchParams()
  for (const [k, v] of u.searchParams.entries()) {
    if (!TRACKING_QUERY_KEYS.has(k.toLowerCase())) keep.append(k, v)
  }
  u.search = keep.toString()
  u.pathname = u.pathname.replace(/\/+$/, '')
  return u.toString()
}

/** 文章 URL 去重键（纯函数、可测试）：基于规范化 URL，去掉协议与尾部斜杠，使 http/https/跟踪参数/尾斜杠归并为同一篇 */
export function dedupeArticleKey(url: string): string {
  const n = normalizeArticleUrl(url)
  const i = n.indexOf('://')
  return i >= 0 ? n.slice(i + 3) : n
}

/** 解析 sitemap（xml）为 { url, lastmod? } 列表（纯函数、可测试）：兼容 sitemap index（子 sitemap）与 urlset。 */
export function parseSiteMap(html: string, baseUrl: string): { url: string; lastmod?: string }[] {
  const out: { url: string; lastmod?: string }[] = []
  const locs = [...html.matchAll(/<loc>([^<]+)/gi)].map((m) => m[1].trim())
  const lastmodByLoc = new Map<string, string>()
  const blockRe = /<url>([\s\S]*?)<\/url>/gi
  let b: RegExpExecArray | null
  while ((b = blockRe.exec(html)) !== null) {
    const loc = /<loc>([^<]+)/i.exec(b[1])?.[1]?.trim()
    const lm = /<lastmod>([^<]+)/i.exec(b[1])?.[1]?.trim()
    if (loc) lastmodByLoc.set(loc, lm ?? '')
  }
  for (const loc of locs) {
    let abs: string
    try { abs = new URL(loc, baseUrl).toString() } catch { continue }
    out.push({ url: abs, lastmod: lastmodByLoc.get(loc) || undefined })
  }
  return out
}


/** 解析 RSS/Atom 订阅源为 { url, title, lastmod? } 列表（纯函数、可测试）：支持 RSS2 `<item>` 与 Atom `<entry>` */
export function parseFeed(xml: string, baseUrl: string): { url: string; title: string; lastmod?: string }[] {
  const out: { url: string; title: string; lastmod?: string }[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null) {
    const b = m[1]
    const loc = /<link>([^<]+)<\/link>/i.exec(b)?.[1]?.trim()
    if (!loc) continue
    let abs: string
    try { abs = new URL(loc, baseUrl).toString() } catch { continue }
    const title = /<title>([^<]+)<\/title>/i.exec(b)?.[1]?.trim() ?? ''
    const pub = /<pubDate>([^<]+)<\/pubDate>/i.exec(b)?.[1]?.trim()
    out.push({ url: abs, title, lastmod: pub || undefined })
  }
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi
  while ((m = entryRe.exec(xml)) !== null) {
    const b = m[1]
    const loc = /<link[^>]*href="([^"]+)"/i.exec(b)?.[1]?.trim()
    if (!loc) continue
    let abs: string
    try { abs = new URL(loc, baseUrl).toString() } catch { continue }
    const title = /<title[^>]*>([^<]+)<\/title>/i.exec(b)?.[1]?.trim() ?? ''
    const upd = /<updated>([^<]+)<\/updated>/i.exec(b)?.[1]?.trim()
    out.push({ url: abs, title, lastmod: upd || undefined })
  }
  return out
}

/** 从站点首页 HTML 检测 RSS/Atom 订阅源链接（纯函数、可测试）：`<link rel=alternate type=application/rss|atom+xml href=...>` */
export function detectFeedUrls(html: string, baseUrl: string): string[] {
  const out = new Set<string>()
  const re = /<link\b[^>]*type=["']application\/(rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    try { out.add(new URL(m[2], baseUrl).toString()) } catch { /* ignore */ }
  }
  return [...out]
}

/** 尝试抓取并解析 RSS/Atom 订阅源（A2）：先检测首页 `<link>`，再尝试常见 feed 路径；无结果返回空（由 sitemap/BFS 兜底）。 */
async function fetchFeedArticles(rootUrl: string): Promise<{ url: string; title: string }[]> {
  const base = new URL(rootUrl)
  const origin = base.origin
  const feedUrls = new Set<string>()
  try {
    const home = (await fetchUrl(base.toString())).rawHtml
    for (const u of detectFeedUrls(home, origin)) feedUrls.add(u)
  } catch { /* ignore */ }
  for (const p of ['/rss.xml', '/atom.xml', '/feed.xml', '/index.xml', '/rss', '/feed', '/rss/', '/feed/']) feedUrls.add(origin + p)
  const found = new Map<string, { url: string; title: string; lastmod?: string }>()
  for (const f of feedUrls) {
    let xml: string
    try { xml = (await fetchUrl(f)).rawHtml } catch { continue }
    const items = parseFeed(xml, origin)
    if (items.length === 0) continue
    for (const it of items) if (isArticleUrl(it.url) && !found.has(dedupeArticleKey(it.url))) found.set(dedupeArticleKey(it.url), it)
    if (found.size > 0) break
  }
  return [...found.values()].map(({ url, title }) => ({ url, title }))
}
/** 解析 robots.txt（User-agent: * 段落，简单尽力解析）：返回 crawl-delay 与 disallow 路径（纯函数、可测试） */
export function parseRobotsTxt(text: string): { crawlDelay?: number; disallow: string[] } {
  let agentStar = false
  let crawlDelay: number | undefined
  const disallow: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(user-agent|disallow|allow|crawl-delay)\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'user-agent') agentStar = val.toLowerCase() === '*'
    else if (key === 'crawl-delay') { const d = parseFloat(val); if (!isNaN(d) && d > 0) crawlDelay = d }
    else if (key === 'disallow' && agentStar && val !== '') disallow.push(val)
  }
  return { crawlDelay, disallow }
}

/** 抓取站点 robots.txt（失败视为未限制）。 */
export async function fetchRobotsTxt(rootUrl: string): Promise<{ crawlDelay?: number; disallow: string[] }> {
  try {
    const base = new URL(rootUrl)
    const robots = new URL('/robots.txt', base.origin).toString()
    const res = await fetchUrl(robots)
    return parseRobotsTxt(res.rawHtml)
  } catch {
    return { crawlDelay: undefined, disallow: [] }
  }
}

/** 判断 URL 的 path 是否命中 robots 的 Disallow 规则（纯函数、可测试）。 */
export function isPathDisallowed(url: string, disallow: string[]): boolean {
  if (disallow.length === 0) return false
  let u: URL
  try { u = new URL(url) } catch { return false }
  const p = u.pathname
  return disallow.some((d) => d && (p === d || p.startsWith(d)))
}

/** 从 HTML 提取 <title>（纯函数、可测试）：sitemap 发现的文章没有标题，导入正文时用页面标题补齐。 */
export function extractPageTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m ? stripTags(m[1]) : ''
}

/** 正文哈希（djb2，十六进制字符串）——用于正文级去重（A3 辅助）。 */
function hashText(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(16)
}

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

/**
 * 站点点对点礼貌限速：按站点 host 维护最近一次请求时间，保证相邻请求间隔 >= crawlDelay（或默认最小间隔）。
 */
const lastRequestByHost = new Map<string, number>()
async function politeDelay(host: string, crawlDelayMs?: number): Promise<void> {
  const minMs = Math.max(IMPORT_DELAY_MS, crawlDelayMs ?? 0)
  const last = lastRequestByHost.get(host) ?? 0
  const wait = last + minMs - Date.now()
  if (wait > 0) await delay(wait)
  lastRequestByHost.set(host, Date.now())
}

/** 尝试用站点 sitemap 发现文章清单 (sitemap-first, A1)：无可用 sitemap 时返回空数组（由 BFS 兜底）。 */
async function fetchSiteMapArticles(rootUrl: string): Promise<{ url: string; title: string }[]> {
  const base = new URL(rootUrl)
  const origin = base.origin
  const candidates = ['/sitemap_index.xml', '/sitemap.xml']
  const found = new Map<string, { url: string; lastmod?: string }>()
  for (const path of candidates) {
    const sitemapUrl = new URL(path, origin).toString()
    let html: string
    try { html = (await fetchUrl(sitemapUrl)).rawHtml } catch { continue }
    const entries = parseSiteMap(html, origin)
    if (entries.length === 0) continue
    const childSitemaps = entries.filter((e) => /[a-z0-9_].*\.xml$/i.test(new URL(e.url).pathname) || /sitemap/i.test(new URL(e.url).pathname))
    if (childSitemaps.length > 0) {
      for (const cs of childSitemaps) {
        let r: string
        try { r = (await fetchUrl(cs.url)).rawHtml } catch { continue }
        for (const e of parseSiteMap(r, cs.url)) {
          if (isArticleUrl(e.url) && !found.has(dedupeArticleKey(e.url))) found.set(dedupeArticleKey(e.url), { url: e.url, lastmod: e.lastmod })
        }
      }
    } else {
      for (const e of entries) {
        if (isArticleUrl(e.url) && !found.has(dedupeArticleKey(e.url))) found.set(dedupeArticleKey(e.url), { url: e.url, lastmod: e.lastmod })
      }
    }
    if (found.size > 0) break
  }
  return [...found.values()].map((v) => ({ url: v.url, title: '' }))
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
  const robots = await fetchRobotsTxt(rootUrl).catch(() => ({ crawlDelay: undefined, disallow: [] }))
  const found = new Map<string, { url: string; title: string }>() // dedupeKey -> 文章

  // A2: RSS/Atom 订阅源优先（最稳、带标题/日期）；无订阅源则回退 sitemap/BFS
  const feedArticles = await fetchFeedArticles(rootUrl).catch(() => [])
  for (const a of feedArticles) {
    if (!found.has(dedupeArticleKey(a.url))) found.set(dedupeArticleKey(a.url), { url: a.url, title: a.title })
  }
  if (found.size > 0) {
    logMain('web', `站点发现 host=${host} 方式=feed 文章=${found.size}`)
    return [...found.values()]
  }

  // A1: sitemap 优先发现（更全、省翻页；标题需在导入正文时从页面 <title> 补齐）
  const sitemapArticles = await fetchSiteMapArticles(rootUrl).catch(() => [])
  for (const a of sitemapArticles) {
    if (!found.has(dedupeArticleKey(a.url))) found.set(dedupeArticleKey(a.url), { url: a.url, title: a.title })
  }
  if (found.size > 0) {
    logMain('web', `站点发现 host=${host} 方式=sitemap 文章=${found.size}`)
    return [...found.values()]
  }

  // 无 RSS/sitemap → 回退 BFS（限深度与页数；遵守 robots + 礼貌延迟）
  const visited = new Set<string>()
  const queue: { url: string; depth: number }[] = [{ url: base.toString(), depth: 0 }]
  let pages = 0

  while (queue.length > 0 && pages < maxPages) {
    const { url, depth } = queue.shift()!
    if (visited.has(url) || depth > maxDepth) continue
    if (isPathDisallowed(url, robots.disallow)) continue
    visited.add(url)
    await politeDelay(host, robots.crawlDelay)
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
  logMain('web', `站点发现 host=${host} 方式=bfs 文章=${found.size}`)
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
  return articles.filter((a) => {
    const title = (a.title ?? '').trim()
    // 无标题（如 sitemap 发现）→ 保守保留为候选，交由正文级精过滤决定是否落库
    if (!title) return true
    return matchesAny(title, allTerms)
  })
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
  taskId?: string,
  siteId?: string
): Promise<Source | null> {
  // ② 列表页兜底：栏目/列表页（URL 强模式）绝不当作单篇文章正文落库，避免"打开来源跳到列表页"
  if (isListPageUrl(url)) {
    logMain('web', '列表页误判，丢弃 url=' + url)
    return null
  }
  const existing = getSourceByUrl(url, taskId)
  const existingMeta = siteId ? getSiteArticle(siteId, url) : null
  if (existing) {
    // 老库升级后（Migration 037 之前抓的）该行没有发布时间：顺手从 web_site_articles 补齐，
    // 否则同一任务重新生成时，这些网页段落仍然拿不到年份兜底的依据。
    if (!existing.publishedAt && existingMeta?.publishedAt) {
      updateSourcePublishedAt(existing.id, existingMeta.publishedAt)
      return { ...existing, publishedAt: existingMeta.publishedAt }
    }
    return existing
  }
  try {
    // B4: 条件请求——带上上次抓取该页面时的 ETag / Last-Modified，内容未变则 304 复用已有正文
    const meta = existingMeta
    const result = await fetchUrl(url, {
      ifNoneMatch: meta?.etag,
      ifModifiedSince: meta?.lastModified
    })
    let cleanedText = result.cleanedText
    let snapshotAt = result.snapshotAt
    let pageTitle = title || ''
    /** 文章发布时间（E10 解析）：落库到 sources 供段首年份兜底使用（网页不能用年鉴 −1 规则） */
    let publishedAt: string | undefined = meta?.publishedAt
    if (result.notModified) {
      // 304：内容未变——若同一 URL 已抓过正文（任意任务）则复用，否则放弃该篇
      const reused = getAnySourceByUrl(url)
      if (!reused?.cleanedText) {
        logMain('web', '304 但无已有正文可复用，放弃 url=' + url)
        return null
      }
      cleanedText = reused.cleanedText
      snapshotAt = reused.urlSnapshotAt ?? new Date().toISOString()
      pageTitle = title || reused.title || fallbackTitleFromUrl(url)
      publishedAt = reused.publishedAt ?? publishedAt
      logMain('web', '条件请求 304 复用正文 url=' + url + ' 标题=' + pageTitle + ' 正文字数=' + cleanedText.length)
    } else {
      pageTitle = title || extractPageTitle(result.rawHtml) || fallbackTitleFromUrl(url)
      // D8：用成熟正文提取器提升中文正文/表格质量；提取过短时回退浏览器净化的 cleanedText
      const richText = extractArticleText(result.rawHtml) || result.cleanedText
      // 正文级精过滤：标题 + 正文前 12000 字（足以判定主题，避免超长正文拖慢匹配）
      if (terms.length > 0 && !matchesExact((pageTitle + '\n' + richText).slice(0, 12000), terms)) {
        logMain('web', '正文精过滤未命中，丢弃 url=' + url + ' 标题=' + pageTitle)
        return null
      }
      cleanedText = richText
      // E10：从正文/元数据解析发布时间并记录（供文章清单按时间排序 + 段落年份兜底）
      publishedAt = extractPublishedDate(result.rawHtml) ?? publishedAt
      // 记录抓取元数据（ETag / Last-Modified / 正文哈希），供条件请求与正文去重用
      if (siteId) {
        updateSiteArticleFetched(siteId, url, {
          etag: result.etag,
          lastModified: result.lastModified,
          bodyHash: hashText(cleanedText),
          fetchedAt: new Date().toISOString()
        })
        if (publishedAt) updateSiteArticlePublished(siteId, url, publishedAt)
      }
      logMain('web', '抓取并落库 url=' + url + ' 标题=' + pageTitle + ' 正文字数=' + cleanedText.length + (publishedAt ? ' 发布时间=' + publishedAt : '') + (richText !== result.cleanedText ? ' 提取器=extractArticleText' : ' 提取器=stripHtml'))
    }
    const source: Source = {
      id: crypto.randomUUID(),
      kind: 'url',
      title: pageTitle,
      url,
      urlSnapshotAt: snapshotAt,
      publishedAt,
      cleanedText,
      status: 'ready',
      taskId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    const inserted = insertSource(source)
    /*
     * 向量索引：手工添加网址与文件导入都会 enqueue（index.ts），网页资料库此前漏了这一步，
     * 导致网页文章 index_state 一直是 pending、chunk_embeddings 为空——保守闸门里
     * "字面无关但语义相关"的向量兜底对网页完全失效。这里补上，并在生成前等待就绪。
     */
    enqueueIndex(inserted.id)
    return inserted
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
 * 单次生成最多抓取多少篇网页文章（2026-09-12 第二批，实测教训）：
 * 真实库里一次生成曾抓 **477 篇**、耗时 **9 分 43 秒**（占整次生成 26.9 分钟的 36%），
 * 而且每篇都要解析+入向量索引。上限按"标题相关度"优先保留，超出部分记入 `skippedByCap` 并在生成汇总里告知。
 */
/**
 * 单次生成抓取的文章篇数上限（成本保险丝，**不承担相关性取舍**）。
 * 2026-09-12 实测：从 80 提到 300。80 篇时切题网页正文只剩 9.4 万字（无上限那次为 94.1 万字），
 * 汇编网页段落 77 → 4 段、69 段网页内容整段消失。**注意**：只要上限小于标题粗筛后的候选数
 * （真实站点同一主题实测 495–3,293 篇），按标题排序总归会丢掉"标题不含主题词、正文却切题"的文章
 * （如《融侨国际双语学校奠基仪式举行》《福州长乐多所名校合力助滨海新城办学》）——
 * 相关性取舍最终靠**正文**：抓取时的正文精过滤 + 保守闸门 + 细读窗口。上限只保证成本可控。
 * A1 材料集合锁定让这笔抓取代价**每个任务只付一次**（重新生成复用），故可以放宽。
 */
export const WEB_FETCH_MAX_ARTICLES = 300
/** 单次生成所有站点合计的正文抓取量上限（防止个别站点命中过多） */
export const WEB_FETCH_MAX_CHARS = 1500000

/** 完整检索词命中标题的额外加权（远强于零星 bigram 重叠） */
const FULL_TERM_BONUS = 10

/**
 * 按"标题与主题词的匹配度"给候选文章排序（纯函数）：命中越多越靠前，同分保持原顺序（清单本身按发布时间倒序）。
 * 用于抓取上限下优先保留最相关的文章——原来只按清单顺序取前 N 篇，等于按时间新旧决定取舍。
 *
 * **打分口径必须与 `matchesAny` 一致（bigram 重叠）**，否则会出现"筛进来了、却全部 0 分"：
 * 2026-09-12 实测真实站点的 477 篇候选、以及上限截断后的 80 篇，标题打分**全部为 0**
 * （旧实现用 `title.includes(term)`，而检索词是长词/整串），排序完全失效、退化成按清单顺序截断——
 * 正是本函数要修掉的那个问题。改为 bigram 重叠计数后，「高中」「中学」「学校」「新建」等
 * 与主题直接相关的标题才会排到前面。
 *
 * 领域下位词（`expandDomainHints`）**不参与排序**：它服务召回（宁多勿漏），用于排序会把
 * 同为教育、却不是本主题的下位领域（如"教育"带出的幼儿园词）顶到前面。
 */
export function rankArticlesByQuery<T extends { url: string; title: string }>(
  articles: T[],
  query: string
): (T & { matchScore: number })[] {
  const terms = extractTopicTerms(query)
  const termBigrams = new Set<string>()
  for (const t of terms) for (const g of bigrams(t)) termBigrams.add(g)
  const scored = articles.map((a, i) => {
    const title = (a.title ?? '').trim()
    // 无标题（sitemap 发现）给 0 分：保守保留为候选，但排序靠后
    let matchScore = 0
    if (title && termBigrams.size > 0) {
      const seen = new Set<string>()
      for (const g of bigrams(title)) {
        if (termBigrams.has(g) && !seen.has(g)) {
          seen.add(g)
          matchScore += 1
        }
      }
      for (const t of terms) if (t.length >= 2 && title.includes(t)) matchScore += FULL_TERM_BONUS
    }
    return { article: a, matchScore, originalIndex: i }
  })
  scored.sort((a, b) => b.matchScore - a.matchScore || a.originalIndex - b.originalIndex)
  return scored.map((s) => ({ ...s.article, matchScore: s.matchScore }))
}

export interface WebFetchStats {
  /** 注册站点数 */
  sites: number
  /** 同步（发现文章清单）失败的站点数：>0 说明本轮网页材料可能不完整（此前只在日志里） */
  siteErrors: number
  /** 标题级命中的候选文章数（所有站点合计） */
  hits: number
  /** 实际落库成功的文章数 */
  fetched: number
  /** 因上限而跳过的候选数 */
  skippedByCap: number
  /** 落库正文总字数 */
  chars: number
  /** 本轮**复用**已锁定网页材料的篇数（>0 说明本次是重新生成，材料集合沿用首次落定） */
  reused?: number
  /** 站点里检测到、但未纳入的新命中文章数（由用户点「纳入新材料」决定是否抓取） */
  newCandidates?: number
}

export interface WebCandidate {
  url: string
  title: string
  siteId: string
  siteTitle: string
}

/**
 * 只做"发现 + 标题命中 + 排序"，**不抓正文**（第三批 A1）：
 * - 用于「本次将采用哪些网页文章」的判断与"检测到 N 篇新文章"的提示；
 * - 把这些网络动作与正文抓取分开，复用同一条路径，避免两处各写一遍 robots/限速/上限逻辑。
 */
export async function collectSiteCandidates(
  query: string,
  excludeUrls: Set<string> = new Set()
): Promise<{ candidates: WebCandidate[]; stats: WebFetchStats }> {
  const sites = listWebSites()
  const stats: WebFetchStats = { sites: sites.length, siteErrors: 0, hits: 0, fetched: 0, skippedByCap: 0, chars: 0 }
  const candidates: WebCandidate[] = []
  if (sites.length === 0) return { candidates, stats }
  const terms = extractTopicTerms(query)
  const allTerms = [...new Set([...terms, ...expandDomainHints(terms)])]
  if (allTerms.length === 0) return { candidates, stats }
  for (const site of sites) {
    try {
      await syncSite(site.id)
    } catch (err) {
      // E1：站点同步失败会让本轮网页材料不完整，必须计数并在汇总里如实告知（此前只有日志）
      stats.siteErrors += 1
      logMain('web', `网页资料检索 站点同步失败 站点=${site.title || site.rootUrl}：${String(err)}`)
      continue
    }
    const articles = listSiteArticles(site.id)
    const hits = rankArticlesByQuery(filterArticlesByQuery(articles, query), query)
    stats.hits += hits.length
    for (const h of hits) {
      if (excludeUrls.has(h.url)) continue
      candidates.push({ url: h.url, title: h.title, siteId: site.id, siteTitle: site.title ?? site.rootUrl })
    }
    logMain('web', `网页资料检索 站点=${site.title || site.rootUrl} 文章清单=${articles.length} 标题命中=${hits.length}`)
  }
  return { candidates, stats }
}

/**
 * 抓取并落库一批候选文章（受篇数/字数上限约束 + robots 礼貌限速）。
 * 落库为"任务绑定的网页缓存文章"（`sources.task_id`）。
 */
export async function importSiteCandidates(
  candidates: WebCandidate[],
  query: string,
  taskId: string
): Promise<{ ids: string[]; stats: WebFetchStats }> {
  const terms = [...new Set([...extractTopicTerms(query), ...expandDomainHints(extractTopicTerms(query))])]
  const stats: WebFetchStats = { sites: 0, siteErrors: 0, hits: candidates.length, fetched: 0, skippedByCap: 0, chars: 0 }
  const ids: string[] = []
  let budgetChars = WEB_FETCH_MAX_CHARS
  const siteMeta = new Map<string, { host: string; crawlDelay?: number; disallow: string[] }>()
  for (const c of candidates) {
    let meta = siteMeta.get(c.siteId)
    if (!meta) {
      const site = getWebSiteById(c.siteId)
      const rootUrl = site?.rootUrl ?? c.url
      let host = rootUrl
      try { host = new URL(rootUrl).host } catch { /* 非法 URL：原样使用 */ }
      const robots = await fetchRobotsTxt(rootUrl).catch(() => ({ crawlDelay: undefined, disallow: [] }))
      meta = { host, crawlDelay: robots.crawlDelay, disallow: robots.disallow }
      siteMeta.set(c.siteId, meta)
    }
    if (isPathDisallowed(c.url, meta.disallow)) continue
    // 上限（篇数 / 字数）：命中太多时按相关度优先保留（候选已排序），其余记入 skippedByCap
    if (stats.fetched >= WEB_FETCH_MAX_ARTICLES || budgetChars <= 0) {
      stats.skippedByCap += 1
      continue
    }
    await politeDelay(meta.host, meta.crawlDelay)
    const src = await importSiteArticle(c.url, c.title, terms, taskId, c.siteId)
    if (src) {
      ids.push(src.id)
      stats.fetched += 1
      stats.chars += src.cleanedText?.length ?? 0
      budgetChars -= src.cleanedText?.length ?? 0
    }
  }
  if (stats.skippedByCap > 0) {
    logMain('web', `网页资料抓取达上限：落库 ${stats.fetched} 篇 / ${stats.chars} 字，跳过 ${stats.skippedByCap} 篇（上限 ${WEB_FETCH_MAX_ARTICLES} 篇 / ${WEB_FETCH_MAX_CHARS} 字）`)
  }
  return { ids, stats }
}

/**
 * 生成时的网页资料检索入口（首次生成走这里）：
 * 发现 → 排序 → 抓取落库（含上限），返回命中的 sourceIds 与统计。
 * 重新生成时不再走这里，而是复用 `task_web_materials` 里锁定的材料（见第三批 A1）。
 */
export async function fetchRelatedSiteSources(
  query: string,
  taskId: string,
  onSite?: (siteTitle: string) => void
): Promise<{ ids: string[]; stats: WebFetchStats }> {
  const collected = await collectSiteCandidates(query)
  if (collected.candidates.length > 0) onSite?.(collected.candidates[0].siteTitle)
  const imported = await importSiteCandidates(collected.candidates, query, taskId)
  const stats: WebFetchStats = {
    ...imported.stats,
    sites: collected.stats.sites,
    siteErrors: collected.stats.siteErrors,
    hits: collected.stats.hits
  }
  if (stats.siteErrors > 0) {
    logMain('web', `网页资料检索：${stats.siteErrors}/${stats.sites} 个站点同步失败，本轮网页材料可能不完整`)
  }
  return { ids: imported.ids, stats }
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
      expect(isArticleUrl('https://www.clnews.com.cn/html/22/list.shtml')).toBe(false)
      expect(isArticleUrl('https://www.clnews.com.cn/index.html')).toBe(false)
      expect(isArticleUrl('https://www.clnews.com.cn/more/22.shtml')).toBe(false)
    })

    it('detects list/channel pages but never real article pages', () => {
      expect(isListPageUrl('https://www.clnews.com.cn/html/22/list.shtml')).toBe(true)
      expect(isListPageUrl('https://www.clnews.com.cn/index.html')).toBe(true)
      expect(isListPageUrl('https://x.gov.cn/channel/index.shtml')).toBe(true)
      expect(isListPageUrl('https://www.clnews.com.cn/more/22.shtml')).toBe(true)
      expect(isListPageUrl('http://www.clnews.com.cn/html/428/2019-01-28/083810141991.shtml')).toBe(false)
      expect(isListPageUrl('https://fzxq.fuzhou.gov.cn/a.htm')).toBe(false)
      expect(isListPageUrl('https://fzxq.fuzhou.gov.cn/a.htm?page=2')).toBe(false)
      expect(isListPageUrl('https://fzxq.fuzhou.gov.cn/xxgk/ztzl/xqnj/202512/t20251203_5239523.htm')).toBe(false)
      expect(isListPageUrl('https://x.gov.cn/news/123.html')).toBe(false)
      expect(isListPageUrl('https://x.gov.cn/html/2025/t20250101_abc.htm')).toBe(false)
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

    it('returns empty when query is empty; keeps empty-title as candidate (sitemap-first, 2026-08-28)', () => {
      expect(filterArticlesByQuery([{ url: 'https://x.gov.cn/a.htm', title: '教育' }], '')).toEqual([])
      // 无标题文章（sitemap 发现）保守保留为候选，交由正文精过滤决定
      expect(filterArticlesByQuery([{ url: 'https://x.gov.cn/a.htm', title: '' }], '教育')).toEqual([{ url: 'https://x.gov.cn/a.htm', title: '' }])
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

    it('extracts the term after 主题为 as well (preset wording, 2026-09-10)', () => {
      // 预设提示词已改为「本次资料收集的主题为 ……」——用户删掉引号后，本地兜底要认得「主题为」
      expect(extractTopicTerms('本次资料收集的主题为 高中教育')).toEqual(['高中教育'])
      expect(extractTopicTerms('本次资料收集的主题是：高中教育')).toEqual(['高中教育'])
      // 带引号的预设原样（占位符未替换）与替换后都应取到内容
      expect(extractTopicTerms('本次资料收集的主题为「高中教育」，具体包括「课程与升学」')).toEqual(['高中教育', '课程与升学'])
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

    it('treats a space-joined keyword list as separate terms (2026-09-12 修正)', () => {
      // 生成管线的 coarseQuery = 大模型提取的「标题 + 关键词」用空格拼接，此前会被压成一个长串
      expect(extractTopicTerms('高中学校设置 高中 新建 扩建 合并 规模 招生人数')).toEqual([
        '高中学校设置',
        '高中',
        '新建',
        '扩建',
        '合并',
        '规模',
        '招生人数'
      ])
      // 单条长句（无空格）仍回退整句，保持既有行为
      expect(extractTopicTerms('请把学校建设情况整理成汇编')).toEqual(['请把学校建设情况整理成汇编'])
    })

    it('ranks candidate articles by title relevance for the fetch cap (2026-09-12 第二批；同日修正打分口径)', () => {
      const articles = [
        { url: 'https://x.gov.cn/a.htm', title: '关于组织学习的通知' },
        { url: 'https://x.gov.cn/b.htm', title: '福州新区年鉴（2025）' },
        { url: 'https://x.gov.cn/c.htm', title: '' }, // sitemap 发现的无标题候选：保留但排最后
        { url: 'https://x.gov.cn/d.htm', title: '高中学校设置与达标高中建设情况' }
      ]
      const ranked = rankArticlesByQuery(articles, '本次资料收集的主题为「高中学校设置」')
      // 标题命中主题词的排前面；无标题/无关的排后面；同分保持原顺序（清单本身按发布时间倒序）
      expect(ranked[0].title).toBe('高中学校设置与达标高中建设情况')
      expect(ranked[ranked.length - 1].title).toBe('')
      expect(ranked[0].matchScore).toBeGreaterThan(0)
      expect(ranked[0].matchScore).toBeGreaterThan(ranked[ranked.length - 1].matchScore)
      // 不丢项
      expect(ranked.map((a) => a.url).sort()).toEqual(articles.map((a) => a.url).sort())
    })

    it('still separates relevant titles when the query is a long keyword list (真实站点 477 篇全 0 分回归)', () => {
      // 回归根因：旧打分用 title.includes(term)，而 coarseQuery 是一个长关键词串 → 所有标题 0 分、排序失效
      const ranked = rankArticlesByQuery(
        [
          { url: 'a', title: '长乐将新增幼儿学位4500个' },
          { url: 'b', title: '融侨国际双语学校奠基仪式举行' },
          { url: 'c', title: '福建将扩大普通高中教育资源 试点中职和普高互融互通' }
        ],
        '高中学校设置 高中 新建 扩建 合并 规模 招生人数 地理分布'
      )
      // 与主题直接相关（含「高中」「学校」）的排前面；同分的（均为 1 个 bigram 命中）保持原清单顺序
      expect(ranked[0].title).toContain('普通高中')
      expect(ranked[1].title).toContain('融侨国际双语学校')
      expect(ranked[2].title).toContain('幼儿学位')
      expect(ranked[0].matchScore).toBeGreaterThan(ranked[2].matchScore)
    })

    it('dedupes http/https article urls to the same key', () => {
      expect(dedupeArticleKey('https://fzxq.fuzhou.gov.cn/a.htm')).toBe('fzxq.fuzhou.gov.cn/a.htm')
      expect(dedupeArticleKey('http://fzxq.fuzhou.gov.cn/a.htm')).toBe('fzxq.fuzhou.gov.cn/a.htm')
      expect(dedupeArticleKey('https://fzxq.fuzhou.gov.cn/b.htm/')).toBe('fzxq.fuzhou.gov.cn/b.htm')
    })

    it('keeps both digits of the publish day (2026-09-12 实测截断回归)', () => {
      // 真实数据里 477 篇网页的发布时间全被截掉最后一位（"2016-06-2" / "2017-08-3"），
      // 根因是日/月候选把单位数放在最前且结尾无强制分隔符 → 前缀即算匹配
      expect(extractPublishedDate('<span>2016-06-22</span>')).toBe('2016-06-22')
      expect(extractPublishedDate('<div>2017-08-30 10:32</div>')).toBe('2017-08-30')
      expect(extractPublishedDate('发布时间：2022-09-30')).toBe('2022-09-30')
      expect(extractPublishedDate('2015年3月8日')).toBe('2015年3月8日')
      expect(extractPublishedDate('2015 年 12 月 25 日')).toBe('2015 年 12 月 25 日')
      // 单位数日期不受影响
      expect(extractPublishedDate('2014-03-1 发布')).toBe('2014-03-1')
      // 优先 meta 与 <time>，且都不是日期文本时才回退
      expect(extractPublishedDate('<meta property="article:published_time" content="2021-03-05T08:00:00+08:00">')).toBe('2021-03-05T08:00:00+')
      expect(extractPublishedDate('<time datetime="2020-11-09"></time>')).toBe('2020-11-09')
      expect(extractPublishedDate('<p>没有日期</p>')).toBeNull()
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
    it('normalizes article urls: host lowercase, strips http/https, tracking params, trailing slash (A3, 2026-08-28)', () => {
      expect(normalizeArticleUrl('https://FZXQ.fuzhou.gov.cn/a.htm?utm_source=x&b=1#sec')).toBe('https://fzxq.fuzhou.gov.cn/a.htm?b=1')
      expect(normalizeArticleUrl('http://fzxq.fuzhou.gov.cn/a.htm/')).toBe('http://fzxq.fuzhou.gov.cn/a.htm')
      expect(dedupeArticleKey('https://fzxq.fuzhou.gov.cn/a.htm?utm_medium=x')).toBe('fzxq.fuzhou.gov.cn/a.htm')
    })

    it('parses sitemap xml (sitemap index + urlset) (A1, 2026-08-28)', () => {
      const index = '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://x.gov.cn/news.xml</loc></sitemap><sitemap><loc>https://x.gov.cn/zs.xml</loc></sitemap></sitemapindex>'
      const i = parseSiteMap(index, 'https://x.gov.cn')
      expect(i.map((e) => e.url)).toEqual(['https://x.gov.cn/news.xml', 'https://x.gov.cn/zs.xml'])
      const urlset = '<urlset><url><loc>https://x.gov.cn/a.htm</loc><lastmod>2025-01-01</lastmod></url></urlset>'
      const u = parseSiteMap(urlset, 'https://x.gov.cn')
      expect(u[0].url).toBe('https://x.gov.cn/a.htm')
      expect(u[0].lastmod).toBe('2025-01-01')
    })

    it('parses robots.txt crawl-delay + disallow (C6, 2026-08-28)', () => {
      const robots = 'User-agent: *\nDisallow: /admin/\nDisallow: /search\nCrawl-delay: 2\nAllow: /public/'
      const r = parseRobotsTxt(robots)
      expect(r.crawlDelay).toBe(2)
      expect(r.disallow).toEqual(['/admin/', '/search'])
      expect(isPathDisallowed('https://x.gov.cn/admin/a.htm', r.disallow)).toBe(true)
      expect(isPathDisallowed('https://x.gov.cn/a.htm', r.disallow)).toBe(false)
    })

    it('extracts <title> from html (B4/title fallback, 2026-08-28)', () => {
      expect(extractPageTitle('<html><head><title>长乐区学前教育</title></head></html>')).toBe('长乐区学前教育')
      expect(extractPageTitle('<html></html>')).toBe('')
    })

    it('parses RSS2 feed items (A2, 2026-08-28)', () => {
      const rss = '<?xml?><rss><channel><item><title>长乐区幼儿园</title><link>https://x.gov.cn/a.htm</link><pubDate>Fri, 01 Jan 2025 00:00:00 GMT</pubDate></item></channel></rss>'
      const items = parseFeed(rss, 'https://x.gov.cn')
      expect(items).toHaveLength(1)
      expect(items[0].url).toBe('https://x.gov.cn/a.htm')
      expect(items[0].title).toBe('长乐区幼儿园')
      expect(items[0].lastmod).toContain('2025')
    })

    it('parses Atom feed entries (A2, 2026-08-28)', () => {
      const atom = '<?xml?><feed><entry><title>学前教育进展</title><link href="https://x.gov.cn/b.htm"/><updated>2025-02-01T00:00:00Z</updated></entry></feed>'
      const items = parseFeed(atom, 'https://x.gov.cn')
      expect(items).toHaveLength(1)
      expect(items[0].url).toBe('https://x.gov.cn/b.htm')
      expect(items[0].title).toBe('学前教育进展')
    })

    it('detects rss/atom feed link in homepage (A2, 2026-08-28)', () => {
      const html = '<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"/></head></html>'
      expect(detectFeedUrls(html, 'https://x.gov.cn')).toEqual(['https://x.gov.cn/rss.xml'])
    })
  })
}
