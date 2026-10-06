
/** * site-crawler.ts —— 网页资料库：**站点发现 + 文章清单同步 + 检索词分层**（2026-08-11 起，2026-10-05 清理）。 * * 生成流程中的角色（2026-10-04 Phase 10 P4/P5 起，**抓正文已不在本文件**）： *   1. `syncSite` 对每个注册站点同步文章清单（feed → sitemap → BFS 列表页），增量 upsert 到 `web_site_articles`， *      并在发现期用 L1–L5 日期阶梯（`article-date.ts`）给每条清单项定发布时间； *   2. `classifyTopicTerm` / `scanTopicLexicon` 提供**检索词分层词表**（specific/weak/generic/scope）， *      **排序**（本文件已删除的旧排序）与**正文相关性判定**（`body-relevance.ts`）共用同一套词表； *   3. robots.txt（`Crawl-delay` 秒→毫秒）+ 礼貌限速（`awaitPoliteDelay`，先占位再等待）。 * **按年份区间抓正文 + 抓取账本**已迁到 `article-crawl.ts`（P4/P5）；旧的"标题粗筛 + 增量导入正文" * （`filterArticlesByQuery` / `importSiteArticle` 及其纯函数与单测）已于 **2026-10-05 P6 删除**。 * 抓取使用 Electron net（url-fetcher.fetchUrl），遵循 http/https 白名单。 */
import { fetchUrl }
 from '../import/url-fetcher'
import { logMain }
 from '../logger'
import { parseUrlDate, pickArticleDate, type ArticleDateSource }
 from './article-date'
import { getWebSiteById,  updateWebSiteLastSynced,  upsertSiteArticles, listSiteArticleKeys, updateSiteDiscoveryLimits}
 from '../db/web-sites'
import {
  decideStop,
  cellOf,
  pagePriority,
  patternOf,
  resolveLimits,
  describeStop,
  SATURATION_WINDOW,
  AUTO_TIME_BUDGET_MS,
  type DiscoveryLimits,
  type DiscoveryStopReason,
  type PageYield,
  type PatternStat
} from './site-discovery'
import type { WebDiscoveryReport } from '../../shared/types'
/** 政务网站常见的静态文章后缀 */
const ARTICLE_SUFFIX_RE = /\.(?:htm|html|shtml|aspx?)\b/i/** 单次站点同步最多抓取列表页数（首页 + 栏目/分页），控制耗时 */
/*
 * ⚠ 2026-10-06（Phase 11 H）：固定上限 `SYNC_MAX_PAGES/SYNC_MAX_DEPTH` 已被**自适应发现**取代
 * （`site-discovery.ts`：走到"收益饱和"为止，页/层数由算法测出来并记回站点行）。
 * 下面这两个常量**只作为回退值与单测基线**保留——真实走的是 `resolveLimits()` 解析出的限额：
 *   自动 = 安全阀（300 页/6 层/3 分钟）+ 饱和提前收工；手动 = 设置页填的页/层（不提前收工）。
 * 为什么必须换掉固定值：实测 `clnews.com.cn` 既无 sitemap 也无 RSS，它的 62,506 条目录来自一次
 * **深层**发现，而 20 页/2 层的帽子让它此后每次同步只能新增几十条——旧站自己都喂不饱。
 */
const SYNC_MAX_PAGES = 20/** 站点发现 BFS 最大深度（0=仅首页） */
const SYNC_MAX_DEPTH = 2/** 增量导入正文的串行延迟（毫秒），降低对目标站点的压力 */
const IMPORT_DELAY_MS = 120/** 前沿（待访问列表页）容量上限：超出时丢弃**优先级最差**的，避免内存被导航链接撑爆 */
const FRONTIER_CAP = 2000/** Phase 10 P4：同一站点两次请求之间的**最小**间隔（毫秒）——抓取流水线据此计算 ETA 的物理下限 */
export const WEB_FETCH_MIN_INTERVAL_MS = IMPORT_DELAY_MS/** * robots.txt 里 `Crawl-delay` 的上限（毫秒）。 * **2026-10-04 修正的单位缺陷**：`parseRobotsTxt` 原先按**秒**解析、`politeDelay` 按**毫秒**使用， * 于是站点声明 `Crawl-delay: 10` 时我们仍按 120ms 连发（快约 83 倍）——站点声明的限速被完全忽略， * 而且看不出来。现在统一在解析处换算为毫秒；另设上限，避免个别站点声明 `Crawl-delay: 3600` * 让一次生成卡死数小时（超上限时记日志说明）。 */
const CRAWL_DELAY_MAX_MS = 10000/** * 空标题候选（sitemap 发现，`title === ''`）的正文长度下限。 * 这类候选取不到"抓取前就知道的标题"，A1 的标题探针必然命中页面自己的 `<title>` → 形同不存在； * 改用两条可判定的兜底：① 清洗后正文短于此长度；② 同站点**别的 URL** 已抓到完全相同的正文（模板页成群出现）。 */
/** 简单 HTML → 纯文本（标签/实体/空白清理，供提取链接文本） */
/** 成熟正文提取（D8）：优先取 article/main/内容容器，去导航/页脚/广告噪音，并保留表格单元格（如志书数据表）。纯函数、可测试。 */
export function extractArticleText(html: string): string {
  let doc = html
  const article = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)
        const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)
        if (article) { doc = article[1]  }
 
else if (main) { doc = main[1]  }
 
else {
  const content = /<(?:div|section)[^>]*class=["'][^"']*(?:content|article|news|detail|body|text)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i.exec(html)
        if (content)
  doc = content[1]  }
  // 表格保留：单元格→制表符，行→换行
  doc = doc.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, (_, c: string) => c.trim() + '\t')
  doc = doc.replace(/<tr[^>]*>/gi, '\n').replace(/<\/tr>/gi, '\n')
  doc = doc.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  doc = doc.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  doc = doc.replace(/<(?:nav|footer|aside)\b[^>]*>[\s\S]*?<\/(?:nav|footer|aside)>/gi, '')
  doc = doc.replace(/<[^>]+>/g, ' ')
  doc = doc    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))    .replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n')
        return doc.trim()}
export function stripTags(html: string): string {
  return html    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')    .replace(/<[^>]+>/g, '')    .replace(/&nbsp;/g, ' ')    .replace(/&amp;/g, '&')    .replace(/&lt;/g, '<')    .replace(/&gt;/g, '>')    .replace(/&quot;/g, '"')    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))    .replace(/[ \t\r\n]+/g, ' ')    .trim()}
/** * 从 HTML 中提取全部超链接（绝对 URL + 链接文本），供发现文章清单用（纯函数、可测试）。 */
export function extractLinks(html: string, baseUrl: string): { href: string;
  text: string }[] {
  const out: { href: string; text: string }[] = []
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
  const href = m[1].trim()
        if (!href || href.startsWith('#') || href.startsWith('javascript:'))
  continue
      let abs: URL
  try { abs = new URL(href, baseUrl)
  }
 catch {
  continue    }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:')
  continue
      const text = stripTags(m[2])
  out.push({ href: abs.toString(), text })
  }
  return out}
/** 常用"栏目/列表/频道页"的 basename（去掉扩展名后）——这些几乎不可能是单篇文章页。 */
const LIST_PAGE_BASENAMES = new Set(['list', 'index', 'default', 'channel', 'category', 'column', 'col', 'lm', 'more', 'news_list'])/** * 是否为"栏目/列表页"链接（纯函数、可测试、强特征、低误伤）： * 只用 URL 的 basename 判断主流列表/栏目页命名（list/index/default/channel/category/column/col/lm/more/news_list）。 * 真实文章页的 basename 通常是日期/文章 ID/数字字母串（如 t20250101_xxx.htm、20250101.htm、a.htm），不在名单内，不会被误伤。 */
export function isListPageUrl(url: string): boolean {
  let u: URL
  try { u = new URL(url) }
 catch {
  return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
        return false
  const path = u.pathname.replace(/\/+$/, '')
        const seg = path.split('/').filter(Boolean)
        const last = seg.length > 0 ? seg[seg.length - 1] : ''
  const base = last.replace(/\.(?:htm|html|shtml|aspx?)$/i, '').toLowerCase()
        if (LIST_PAGE_BASENAMES.has(base))
        return true  // 路径段命中列表关键词（如 /more/<栏目ID>.shtml 这类"更多"列表页）且 basename 为纯数字 → 视为列表页。
  // 真实文章页的 basename 通常含日期/文章 ID（含字母）或不带列表关键词的路径段，不会被命中，避免误伤相关文章。
  if (/^\d+$/.test(base) && seg.some((s) => LIST_PAGE_BASENAMES.has(s.toLowerCase())))
        return true
  return false}
/** 是否为"文章页"链接（静态后缀判定；纯函数、可测试） */
export function isArticleUrl(url: string): boolean { // ① 排除常见栏目/列表页（如 .../list.shtml、.../index.html），避免列表页被当作单篇文章收录
  if (isListPageUrl(url))
        return false
  return ARTICLE_SUFFIX_RE.test(url.split('?')[0].split('#')[0])}
/** * 领域下位词兜底表（2026-08-13）： * 政务新闻标题是"下位概念"（如"配建幼儿园""新学年校历""学校拟招生"）， * 与撰写章节标题"学前教育"几乎没有字面/字符对重叠，纯标题 bigram 永远对不上。 * 当撰写关键词命中某领域的 key（如"教育"）时，把该领域的高区分度下位词一并纳入候选与精过滤。 * * 收窄原则（2026-08-13 实测修正；2026-08-14 再次收窄）： * 1. 不含宽泛的 key 本身（"教育"），避免"政绩观学习教育""警示教育"政治学习文章误召回。 * 2. 剔除"入学"——它作为子串会命中"深**入学**习贯彻"（"深入"+"学习"跨词拼接）， *    导致大量"学习教育"类政治新闻被误判为教育相关（test1 实测 5 篇误召回的直接根因）。 * 3. 剔除"教学/小学/中学/大学/义务/教师/学生/课程/普惠"等泛教育词—— *    它们会召回"重庆中新大学""兰州教育信息化""厦门大学"等外地/高等教育新闻，与本地学前教育志书无关。 * 4. 2026-08-14 再剔除"招生/校历/学位"：这三词过宽，会命中"中招计划""普高自主招生""义务教育招生" *    "小学剩余学位抽签"等大量中小学/高中新闻，正文精过滤仅因含"招生/学位"就落库， *    使网页召回的无关文章膨胀到 300+ 篇，矛盾扫描被噪音淹没（test2 漏检 test1 矛盾的主因之一）。 *    学前教育真正的招生/学位类新闻，其正文必含"幼儿园/学前/幼儿/保育/入园"等核心词，仍会被保留。 * 只保留学前教育高区分度核心词（学前/幼儿园/幼儿/保育/托育/入园/幼教），后续可按需扩展其他门类。 */
const DOMAIN_HINTS: { key: string; words: string[] }[] = [  { key: '教育', words: ['学前', '幼儿园', '幼儿', '保育', '托育', '入园', '幼教']  }
]/** 从撰写指令中提取用于粗筛的短关键词（标题/子标题），避免整句长文本稀释 bigram（纯函数、可测试） */
export function extractTopicTerms(query: string): string[] {
  const out: string[] = []
  const add = (t: string): void => {
  const v = t.trim()
        if (v && v.length >= 2 && v.length <= 20 && !out.includes(v))
  out.push(v)
  }
  // 1) 引号内短文本（标题/子标题）：'…' "…" 「…」 “…” 『…』
  for (const m of query.matchAll(/[「『“"']([^」』”"']{2,20})[」』”"']/g)) { add(m[1])
  }
  // 2) "标题为/标题是/标题：…" 后的短词（无引号时的兜底）。`主题` 同样计入：

  //     预设提示词已改为「本次资料收集的主题为 ……」，用户若删掉引号，这一步才兜得住。
  //     2026-08-14 容错：捕获组前允许一个可选的引号字符，兼容"标题为“学前教育“"这类
  //     引号不配对（结尾误用左引号）的输入——否则会因紧跟引号而提取失败、回退整句，
  //     导致矛盾扫描/网页检索的主题词不稳定（test3 漏检矛盾的直接根因）。
  const titled = query.match(/(?:标题|题目|主题)[为是]?\s*[:：]?\s*[「『“"'」』”]?([^\s，。；、,.「『』」“”"']+)/)
        if (titled) add(titled[1])  // 3) 引号/引导语都没取到时，若检索词本身就是**关键词列表**（生成管线把大模型提取的

  //     「标题 + 关键词」用空格拼成 coarseQuery），必须逐词当作检索词，不能抹掉词间空格拼成一整句——
  //     否则 `title.includes(整串)` 永远不成立。2026-09-12 实测：正是这一步把
  //     「高中学校设置 高中 新建 扩建 …」压成一个长串，导致抓取上限的"按相关度排序"全部 0 分、
  //     退化成按清单顺序截断（丢掉 478 篇里的切题材料，汇编网页段落 77 → 4 段）。
  if (out.length === 0) {
  const tokens = query.split(/\s+/).map((s) => s.trim()).filter(Boolean)
        if (tokens.length >= 2)
        for (const tk of tokens) add(tk)
  }
  // 4) 仍提取不到任何短词时回退整句（兼容"无标题、纯要求"的指令）
  if (out.length === 0) {
  const fallback = query.replace(/\s+/g, '')
        if (fallback)
  out.push(fallback)
  }
  return out}
/** 依据关键词命中领域 key，扩展出该领域的高区分度下位词（纯函数、可测试） */
export function expandDomainHints(terms: string[]): string[] {
  const out = new Set<string>()
        for (const t of terms) {
  for (const d of DOMAIN_HINTS) {
  if (t.includes(d.key))
        for (const w of d.words)
  out.add(w)
  }
  }
  return [...out]}
/*
 * URL 规范化与去重键已抽到 `url-key.ts`（2026-10-06 Phase 11 H）：它现在有**两个使用方**
 * （本文件的发现遍历 + `db/web-sites.ts#listSiteArticleKeys`），两边口径必须完全一致，
 * 否则"已知/新增"判错、饱和判据永远不成立。这里导入并**重新导出**，旧调用方与单测不受影响。
 */
import { dedupeArticleKey, normalizeArticleUrl } from './url-key'
export { dedupeArticleKey, normalizeArticleUrl }
/** * 解析 sitemap（xml）为 `{ url, lastmod?, publicationDate? }`（纯函数、可测试）：兼容 sitemap index（子 sitemap）与 urlset。 * `publicationDate` 取 Google News 扩展的 `<news:publication_date>`——它比 `lastmod` 更贴"发布时间"（Phase 10 日期阶梯 L2 的 a/b 两级）。 */
export function parseSiteMap(  html: string, baseUrl: string): { url: string;
  lastmod?: string;
  publicationDate?: string }[] {
  const out: { url: string; lastmod?: string;
  publicationDate?: string }[] = []
  const locs = [...html.matchAll(/<loc>([^<]+)/gi)].map((m) => m[1].trim())
        const metaByLoc = new Map<string, { lastmod?: string;
  publicationDate?: string }
>()
        const blockRe = /<url>([\s\S]*?)<\/url>/gi
  let b: RegExpExecArray | null
  while ((b = blockRe.exec(html)) !== null) {
  const loc = /<loc>([^<]+)/i.exec(b[1])?.[1]?.trim()
        const lm = /<lastmod>([^<]+)/i.exec(b[1])?.[1]?.trim()    // 命名空间前缀可能是 news:/n:/没有前缀
  const pd = /<(?:[\w-]+:)?publication_date>([^<]+)/i.exec(b[1])?.[1]?.trim()
        if (loc)
  metaByLoc.set(loc, { lastmod: lm || undefined, publicationDate: pd || undefined })
  }
  for (const loc of locs) {
  let abs: string
  try { abs = new URL(loc, baseUrl).toString() }
 catch {
  continue }
  const meta = metaByLoc.get(loc)
  out.push({ url: abs, lastmod: meta?.lastmod, publicationDate: meta?.publicationDate })
  }
  return out}
/** 解析 RSS/Atom 订阅源为 { url, title, lastmod? } 列表（纯函数、可测试）：支持 RSS2 `<item>` 与 Atom `<entry>` */
export function parseFeed(xml: string, baseUrl: string): { url: string;
  title: string;
  lastmod?: string }[] {
  const out: { url: string; title: string;
  lastmod?: string }[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null) {
  const b = m[1]
  const loc = /<link>([^<]+)<\/link>/i.exec(b)?.[1]?.trim()
        if (!loc)
  continue
      let abs: string
  try { abs = new URL(loc, baseUrl).toString() }
 catch {
  continue }
  const title = /<title>([^<]+)<\/title>/i.exec(b)?.[1]?.trim() ?? ''
  const pub = /<pubDate>([^<]+)<\/pubDate>/i.exec(b)?.[1]?.trim()
  out.push({ url: abs, title, lastmod: pub || undefined })
  }
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi
  while ((m = entryRe.exec(xml)) !== null) {
  const b = m[1]
  const loc = /<link[^>]*href="([^"]+)"/i.exec(b)?.[1]?.trim()
        if (!loc)
  continue
      let abs: string
  try { abs = new URL(loc, baseUrl).toString() }
 catch {
  continue }
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(b)?.[1]?.trim() ?? ''
  const upd = /<updated>([^<]+)<\/updated>/i.exec(b)?.[1]?.trim()
  out.push({ url: abs, title, lastmod: upd || undefined })
  }
  return out}
/** 从站点首页 HTML 检测 RSS/Atom 订阅源链接（纯函数、可测试）：`<link rel=alternate type=application/rss|atom+xml href=...>` */
export function detectFeedUrls(html: string, baseUrl: string): string[] {
  const out = new Set<string>()
        const re = /<link\b[^>]*type=["']application\/(rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
  try { out.add(new URL(m[2], baseUrl).toString()) }
 catch {
 
/* ignore */
 }
  }
  return [...out]}
/** * 尝试抓取并解析 RSS/Atom 订阅源（A2）：先检测首页 `<link>`，再尝试常见 feed 路径；无结果返回空（由 sitemap/BFS 兜底）。 * `feedDate` 即 feed 里的 `pubDate`/`updated`（`parseFeed` 目前把它放在 `lastmod` 字段里返回）——它是日期阶梯的 **L1**。 */
async function fetchFeedArticles(  rootUrl: string): Promise<{ url: string;
  title: string;
  feedDate?: string }[]> {
  const base = new URL(rootUrl)
        const origin = base.origin
  const feedUrls = new Set<string>()
  try {
  const home = (await fetchUrl(base.toString())).rawHtml
  for (const u of detectFeedUrls(home, origin))
  feedUrls.add(u)
  }
 catch {
 
/* ignore */
 }
  for (const p of ['/rss.xml', '/atom.xml', '/feed.xml', '/index.xml', '/rss', '/feed', '/rss/', '/feed/'])
  feedUrls.add(origin + p)
        const found = new Map<string, { url: string;
  title: string;
  lastmod?: string }
>()
        for (const f of feedUrls) {
  let xml: string
  try { xml = (await fetchUrl(f)).rawHtml }
 catch {
  continue }
  const items = parseFeed(xml, origin)
        if (items.length === 0)
  continue
      for (const it of items)
        if (isArticleUrl(it.url) && !found.has(dedupeArticleKey(it.url)))
  found.set(dedupeArticleKey(it.url), it)
        if (found.size > 0)
  break  }
  return [...found.values()].map(({ url, title, lastmod }) => ({ url, title, feedDate: lastmod }))}
/** * 解析 robots.txt（User-agent: * 段落，简单尽力解析）：返回 **crawl-delay（毫秒）** 与 disallow 路径（纯函数、可测试）。 * `Crawl-delay` 在 robots.txt 里的单位是**秒**，本模块对外一律用毫秒（`crawlDelayMs`），避免再次出现单位混用。 */
export function parseRobotsTxt(text: string): { crawlDelayMs?: number;
  disallow: string[] } {
  let agentStar = false
  let crawlDelayMs: number | undefined
  const disallow: string[] = []
  for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim()
        if (!line || line.startsWith('#'))
  continue
      const m = /^(user-agent|disallow|allow|crawl-delay)\s*:\s*(.*)$/i.exec(line)
        if (!m)
  continue
      const key = m[1].toLowerCase()
        const val = m[2].trim()
        if (key === 'user-agent')
  agentStar = val.toLowerCase() === '*'
    else if (key === 'crawl-delay') {
  const d = parseFloat(val)      // 秒 → 毫秒（原先漏了这一步，等于完全不限速）；超过上限按上限执行
  if (!isNaN(d) && d > 0)
  crawlDelayMs = Math.min(Math.round(d * 1000), CRAWL_DELAY_MAX_MS)
  }
    else if (key === 'disallow' && agentStar && val !== '')
  disallow.push(val)
  }
  return { crawlDelayMs, disallow }
}
/** 抓取站点 robots.txt（失败视为未限制）。 */
export async function fetchRobotsTxt(rootUrl: string): Promise<{ crawlDelayMs?: number;
  disallow: string[] } > {
  try {
  const base = new URL(rootUrl)
        const robots = new URL('/robots.txt', base.origin).toString()
        const res = await fetchUrl(robots)
        return parseRobotsTxt(res.rawHtml)
  }
 catch {
  return { crawlDelayMs: undefined, disallow: [] }
  }
}
/** 判断 URL 的 path 是否命中 robots 的 Disallow 规则（纯函数、可测试）。 */
export function isPathDisallowed(url: string, disallow: string[]): boolean {
  if (disallow.length === 0)
        return false
  let u: URL
  try { u = new URL(url) }
 catch {
  return false }
  const p = u.pathname
  return disallow.some((d) => d && (p === d || p.startsWith(d)))}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms)) }
/** 站点点对点礼貌限速：按站点 host 维护最近一次请求时间，保证相邻请求间隔 >= `crawlDelayMs`（或默认最小间隔）。 * `crawlDelayMs` 由 `parseRobotsTxt` 从 robots.txt 的秒换算而来（2026-10-04 修单位错），站点声明的限速从此真正生效。 */
const lastRequestByHost = new Map<string, number>()
async function politeDelay(host: string, crawlDelayMs?: number): Promise<void> {
  const minMs = Math.max(IMPORT_DELAY_MS, crawlDelayMs ?? 0)
        const now = Date.now()
        const last = lastRequestByHost.get(host) ?? 0  /*   * **先占位、再等待**（2026-10-04 P4 修竞态）：原实现是"读 last → 等待 → 写 last"，   * 多个 worker 会同时读到同一个过期值、同时醒来、**同时发请求**——实测并发 2 时达到 12.5 篇/秒，   * 超过 120ms 间隔允许的 8.3 篇/秒，等于对站点超发。现在把"下一个可用时刻"同步写回，   * 并发调用者各自拿到**互不重叠的时间片**，真实请求间隔严格 ≥ minMs。   */
  const fireAt = Math.max(now, last + minMs)
  lastRequestByHost.set(host, fireAt)
        const wait = fireAt - now
  if (wait > 0) await delay(wait)}
/** * Phase 10 P4：把礼貌限速开放给抓取流水线复用（`article-crawl.ts`）。 * **两条抓取路径（旧的导入路径与新的按年份抓取）必须共用同一份限速状态**——各自维护会导致同一站点被并发翻倍。 */
export async function awaitPoliteDelay(host: string, crawlDelayMs?: number): Promise<void> {
  return politeDelay(host, crawlDelayMs)}
/** 站点发现产出的文章条目（Phase 10：目录里必须带日期，见 `article-date.ts`） */
export interface DiscoveredArticle { url: string; title: string  /** 归一化发布日期（`YYYY-MM-DD` / `YYYY-MM` / `YYYY`）——年份区间筛选**只认它** */
  publishedDate?: string  /** 日期来自哪一级（feed / sitemap-news / sitemap-lastmod / url） */
  dateSource?: ArticleDateSource; dateConfidence?: 'high' | 'medium' | 'low'  /** URL 内嵌日期（L3 的原始证据，供互校与模板日期检测） */
  urlDate?: string  /** sitemap 的 `lastmod` 原始值（L2b 证据） */
  sitemapLastmod?: string}
/** 发现期的中间结构：把各级日期"原材料"带上，最后统一走 `pickArticleDate` */
interface RawDiscovered { url: string; title: string; feedDate?: string; sitemapLastmod?: string; sitemapPublication?: string}
/** 中间结构 → 落库条目：按 L1→L5 挑日期（发现期只有 L1/L2/L3，L4/L5 在抓取阶段回填） */
function toDiscovered(list: RawDiscovered[]): DiscoveredArticle[] {
  return list.map((a) => {
  const picked = pickArticleDate({ feed: a.feedDate, sitemapPublication: a.sitemapPublication, sitemapLastmod: a.sitemapLastmod,
  url: a.url    })
        return { url: a.url, title: a.title, publishedDate: picked?.date,
  dateSource: picked?.source, dateConfidence: picked?.confidence, urlDate: parseUrlDate(a.url)?.date, sitemapLastmod: a.sitemapLastmod    }
  })}
/** 发现结果的日期覆盖情况（写进日志，便于"为什么某站筛不出文章"这类排查） */
function logDiscovery(host: string, method: string, list: DiscoveredArticle[]): void {
  const bySource = new Map<string, number>()
        let noDate = 0
  for (const a of list) {
  if (!a.publishedDate) noDate++
    else bySource.set(a.dateSource ?? '?', (bySource.get(a.dateSource ?? '?') ?? 0) + 1)
  }
  const detail = [...bySource.entries()].map(([k, v]) => `${k}=${v}`).join(' ')
        logMain(    'web',    `站点发现 host=${host} 方式=${method} 文章=${list.length} 有日期=${list.length - noDate} 无日期=${noDate}${detail ? ' ' + detail : ''}`  )}
/** 尝试用站点 sitemap 发现文章清单 (sitemap-first, A1)：无可用 sitemap 时返回空数组（由 BFS 兜底）。 */
async function fetchSiteMapArticles(rootUrl: string): Promise<RawDiscovered[]> {
  const base = new URL(rootUrl)
        const origin = base.origin
  const candidates = ['/sitemap_index.xml', '/sitemap.xml']
  const found = new Map<string, { url: string;
  lastmod?: string;
  publicationDate?: string }
>()
        for (const path of candidates) {
  const sitemapUrl = new URL(path, origin).toString()
        let html: string
  try { html = (await fetchUrl(sitemapUrl)).rawHtml }
 catch {
  continue }
  const entries = parseSiteMap(html, origin)
        if (entries.length === 0)
  continue
      const childSitemaps = entries.filter((e) => /[a-z0-9_].*\.xml$/i.test(new URL(e.url).pathname) || /sitemap/i.test(new URL(e.url).pathname))
        if (childSitemaps.length > 0) {
  for (const cs of childSitemaps) {
  let r: string
  try { r = (await fetchUrl(cs.url)).rawHtml }
 catch {
  continue }
  for (const e of parseSiteMap(r, cs.url)) {
  if (isArticleUrl(e.url) && !found.has(dedupeArticleKey(e.url)))
  found.set(dedupeArticleKey(e.url), e)
  }
      }
    }
 
else {
  for (const e of entries) {
  if (isArticleUrl(e.url) && !found.has(dedupeArticleKey(e.url)))
  found.set(dedupeArticleKey(e.url), e)
  }
    }
  if (found.size > 0)
  break  }
  return [...found.values()].map((v) => ({ url: v.url, title: '', sitemapLastmod: v.lastmod,
  sitemapPublication: v.publicationDate  }))}
/**
 * 站点发现的**报告**（Phase 11 H）：页/层数不再是输入，而是这次的**实测结果**，
 * 必须如实报给用户（撞安全阀时不能假装"抓全了"）。
 * 跨层契约部分（IPC/界面用）定义在 `shared/types.ts#WebDiscoveryReport`，这里补上主进程侧才有的 `limits`。
 */
export interface DiscoveryReport extends WebDiscoveryReport {
  seconds: number
  limits: DiscoveryLimits
}

export interface DiscoveryOptions {
  /** 兼容旧调用：直接给定页/层上限（会给出一份"自动但指定硬顶"的限额） */
  maxPages?: number
  maxDepth?: number
  /** 限额（优先于 maxPages/maxDepth；由 `resolveLimits` 解析，见 `site-discovery.ts`） */
  limits?: DiscoveryLimits
  /** 站内目录已有的 URL 去重键（用于"新增"统计与饱和判据；重复同步时它很大） */
  existingKeys?: Set<string>
  /** 目标年份区间（建立区间）：用于"未覆盖年份优先出队" */
  fromYear?: number
  toYear?: number
  /**
   * 测试缝：注入页面抓取（默认走 Electron net 的 `fetchUrl`）。
   * 遍历器是本次改动的核心（优先级队列 + 饱和停止），必须可被单测完整驱动。
   */
  fetchHtml?: (url: string) => Promise<string>
}

function emptyReport(): DiscoveryReport {
  return {
    method: 'bfs',
    pagesFetched: 0,
    maxDepthReached: 0,
    stopReason: 'frontier-empty',
    stopText: '未开始',
    discovered: 0,
    freshArticles: 0,
    added: 0,
    dated: 0,
    byYear: {},
    cellCount: 0,
    depthPruned: 0,
    seconds: 0,
    limits: resolveLimits({})
  }
}

/** 取优先级最优的前沿候选（线性扫描；前沿有容量上限，规模可控） */
function takeBestFrontier(
  frontier: { url: string; depth: number }[],
  stats: Map<string, PatternStat>,
  uncoveredYears: Set<number>
): { url: string; depth: number } {
  let bestIdx = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let i = 0; i < frontier.length; i++) {
    const s = pagePriority({ url: frontier[i].url, depth: frontier[i].depth, stats, uncoveredYears })
    if (s < bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  return frontier.splice(bestIdx, 1)[0]
}

/** 入队（容量满时按优先级淘汰最差的一个；优先级更差的直接丢弃） */
function pushFrontier(
  frontier: { url: string; depth: number }[],
  item: { url: string; depth: number },
  stats: Map<string, PatternStat>,
  uncoveredYears: Set<number>
): void {
  if (frontier.length < FRONTIER_CAP) {
    frontier.push(item)
    return
  }
  let worstIdx = 0
  let worstScore = Number.NEGATIVE_INFINITY
  for (let i = 0; i < frontier.length; i++) {
    const s = pagePriority({ url: frontier[i].url, depth: frontier[i].depth, stats, uncoveredYears })
    if (s > worstScore) {
      worstScore = s
      worstIdx = i
    }
  }
  const newScore = pagePriority({ url: item.url, depth: item.depth, stats, uncoveredYears })
  if (newScore < worstScore) frontier.splice(worstIdx, 1, item)
}

/** * 站点发现（feed → sitemap → **自适应 BFS**）：返回文章清单 + 本次发现报告。 * * 与旧实现的差别（Phase 11 H）：BFS 不再固定 20 页/2 层，而是 *   - 出队**按优先级**（年-月归档 > 索引页 > 翻页 > 其他；并按本次实测的形态收益自我调整）； *   - 停止条件为"**收益饱和**"（连续多页既无新文章也无新的年月格子）或前沿走空， *     页/层数只是安全阀； *   - 每次至少走到**上次的用量**（`limits.minPages`，来自站点行的 discovery_pages），防退化。 * * Phase 10：目录必须在建立时就带上发布日期（用户裁定 ①），因此每条都走一遍日期阶梯的 L1/L2/L3 * （L4 `Last-Modified`、L5 页面日期要抓正文才有，放在抓取阶段回填）。 */
export async function discoverSiteArticlesDetailed(
  rootUrl: string,
  opts: DiscoveryOptions = {}
): Promise<{ articles: DiscoveredArticle[]; report: DiscoveryReport }> {
  const started = Date.now()
  let base: URL
  try {
    base = new URL(rootUrl)
  } catch {
    return { articles: [], report: emptyReport() }
  }
  const host = base.host
  const known = opts.existingKeys ?? new Set<string>()
  const robots = await fetchRobotsTxt(rootUrl).catch(() => ({ crawlDelayMs: undefined, disallow: [] }))
  const found = new Map<string, RawDiscovered>() // dedupeKey -> 文章

  /** 汇总报告（feed/sitemap/BFS 三条路共用） */
  const buildReport = (
    method: DiscoveryReport['method'],
    list: DiscoveredArticle[],
    extra: { pagesFetched: number; maxDepthReached: number; stopReason: DiscoveryStopReason | null; stopText: string; cellCount: number; depthPruned?: number; limits: DiscoveryLimits }
  ): DiscoveryReport => {
    const byYear: Record<string, number> = {}
    let dated = 0
    for (const a of list) {
      if (a.publishedDate) dated++
      const y = a.publishedDate?.slice(0, 4)
      if (y) byYear[y] = (byYear[y] ?? 0) + 1
    }
    return {
      method,
      pagesFetched: extra.pagesFetched,
      maxDepthReached: extra.maxDepthReached,
      stopReason: extra.stopReason,
      stopText: extra.stopText,
      discovered: list.length,
      freshArticles: [...found.keys()].filter((k) => !known.has(k)).length,
      added: 0,
      dated,
      byYear,
      cellCount: extra.cellCount,
      depthPruned: extra.depthPruned ?? 0,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      limits: extra.limits
    }
  }

  // A2: RSS/Atom 订阅源优先（最稳、带标题/日期）；无订阅源则回退 sitemap/BFS
  const feedArticles = await fetchFeedArticles(rootUrl).catch(() => [])
  for (const a of feedArticles) {
    if (!found.has(dedupeArticleKey(a.url))) found.set(dedupeArticleKey(a.url), a)
  }
  if (found.size > 0) {
    const list = toDiscovered([...found.values()])
    logDiscovery(host, 'feed', list)
    const limits = resolveLimits({})
    return {
      articles: list,
      report: buildReport('feed', list, { pagesFetched: 0, maxDepthReached: 0, stopReason: null, stopText: '站点提供 RSS/Atom 订阅源（无需遍历列表页）', cellCount: 0, limits })
    }
  }
  // A1: sitemap 优先发现（更全、省翻页；标题需在导入正文时从页面 <title> 补齐）
  const sitemapArticles = await fetchSiteMapArticles(rootUrl).catch(() => [])
  for (const a of sitemapArticles) {
    if (!found.has(dedupeArticleKey(a.url))) found.set(dedupeArticleKey(a.url), a)
  }
  if (found.size > 0) {
    const list = toDiscovered([...found.values()])
    logDiscovery(host, 'sitemap', list)
    const limits = resolveLimits({})
    return {
      articles: list,
      report: buildReport('sitemap', list, { pagesFetched: 0, maxDepthReached: 0, stopReason: null, stopText: '站点提供 sitemap（无需遍历列表页）', cellCount: 0, limits })
    }
  }

  /*
   * 无 RSS/sitemap → 回退**自适应 BFS**（遵守 robots + 礼貌延迟；页/层数由收益决定）。
   * 限额来源（优先级从高到低）：调用方给的 limits（设置页的自动/手动 + 上次用量）→ 兼容旧参数 → 默认自动。
   */
  const limits: DiscoveryLimits =
    opts.limits ??
    (opts.maxPages !== undefined || opts.maxDepth !== undefined
      ? {
          maxPages: Math.max(1, opts.maxPages ?? SYNC_MAX_PAGES),
          maxDepth: Math.max(0, opts.maxDepth ?? SYNC_MAX_DEPTH),
          minPages: 0,
          saturation: true,
          timeBudgetMs: AUTO_TIME_BUDGET_MS,
          mode: 'auto' as const
        }
      : resolveLimits({}))

  const visited = new Set<string>()
  const queued = new Set<string>([base.toString()])
  const frontier: { url: string; depth: number }[] = [{ url: base.toString(), depth: 0 }]
  const stats = new Map<string, PatternStat>()
  const cells = new Set<string>()
  const byYear = new Map<string, number>()
  const recent: PageYield[] = []
  let pages = 0
  let maxDepthReached = 0
  let freshArticles = 0
  /** 因层数上限被剪掉的更深链接数（如实报给用户） */
  let depthPruned = 0
  let stopReason: DiscoveryStopReason = 'frontier-empty'

  const uncoveredYears = (): Set<number> => {
    const out = new Set<number>()
    if (!opts.fromYear || !opts.toYear || opts.fromYear > opts.toYear) return out
    for (let y = opts.fromYear; y <= opts.toYear; y++) if (!byYear.has(String(y))) out.add(y)
    return out
  }

  for (;;) {
    // 取下一个可用候选（跳过已访问 / robots 禁止的）
    let next: { url: string; depth: number } | null = null
    for (;;) {
      if (frontier.length === 0) break
      const cand = takeBestFrontier(frontier, stats, uncoveredYears())
      if (visited.has(cand.url)) continue
      if (isPathDisallowed(cand.url, robots.disallow)) {
        visited.add(cand.url)
        continue
      }
      next = cand
      break
    }
    const reason = decideStop({
      recent,
      frontierEmpty: next === null,
      pages,
      limits,
      nextDepth: next?.depth ?? 0,
      elapsedMs: Date.now() - started,
      alreadyKnown: known.size,
      discoveredNow: found.size
    })
    if (reason) {
      stopReason = reason
      break
    }
    const { url, depth } = next as { url: string; depth: number }
    visited.add(url)
    await politeDelay(host, robots.crawlDelayMs)
    let html: string | null = null
    try {
      // 测试缝：注入的抓取优先（单测据此完整驱动遍历器）
      html = opts.fetchHtml ? await opts.fetchHtml(url) : (await fetchUrl(url)).rawHtml
    } catch {
      html = null // 列表页抓取失败则跳过该页（计为"零收益"，让饱和判据照样能收工）
    }
    pages++
    maxDepthReached = Math.max(maxDepthReached, depth)
    let pageFresh = 0
    let pageArticles = 0
    let pageNewCells = 0
    if (html !== null) {
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
          pageArticles++
          const key = dedupeArticleKey(abs)
          if (!found.has(key)) {
            found.set(key, { url: abs, title: text || abs })
            const cell = cellOf(abs)
            if (cell) {
              if (!cells.has(cell)) {
                cells.add(cell)
                pageNewCells++
              }
              byYear.set(cell.slice(0, 4), (byYear.get(cell.slice(0, 4)) ?? 0) + 1)
            }
            if (!known.has(key)) {
              pageFresh++
              freshArticles++
            }
          }
        } else if (depth + 1 <= limits.maxDepth && !queued.has(abs)) {
          // 非文章链接（栏目/归档/翻页）入队继续走；容量满时按优先级淘汰
          queued.add(abs)
          pushFrontier(frontier, { url: abs, depth: depth + 1 }, stats, uncoveredYears())
        } else if (depth + 1 > limits.maxDepth) {
          // 因层数上限没走：**如实计数**（撞层数时不能假装"抓全了"）
          depthPruned++
        }
      }
    }
    // 形态收益统计（用"这一页给出多少文章"衡量，重复同步时也成立——用于自我调整出队顺序）
    const pattern = patternOf(url)
    const st = stats.get(pattern) ?? { pages: 0, articles: 0 }
    stats.set(pattern, { pages: st.pages + 1, articles: st.articles + pageArticles })
    recent.push({ newArticles: pageFresh, newCells: pageNewCells })
    if (recent.length > SATURATION_WINDOW * 3) recent.splice(0, recent.length - SATURATION_WINDOW * 3)
  }

  const list = toDiscovered([...found.values()])
  logDiscovery(host, 'bfs', list)
  const stopText = describeStop(stopReason, pages, limits.maxPages, frontier.length)
  const prunedNote = depthPruned > 0 ? `；另有 ${depthPruned} 个更深的链接因层数上限（${limits.maxDepth}）未走` : ''
  logMain(
    'web',
    `站点发现（自适应）：${host} 走了 ${pages} 页 / ${maxDepthReached} 层，发现 ${list.length} 篇（新增 ${freshArticles} 篇，年月格子 ${cells.size} 个），${stopText}${prunedNote}`
  )
  return {
    articles: list,
    report: buildReport('bfs', list, {
      pagesFetched: pages,
      maxDepthReached,
      stopReason,
      stopText: stopText + prunedNote,
      cellCount: cells.size,
      depthPruned,
      limits
    })
  }
}

/** 兼容入口：只要文章清单（旧的 `discoverSiteArticles` 语义与返回类型不变） */
export async function discoverSiteArticles(rootUrl: string, opts: DiscoveryOptions = {}): Promise<DiscoveredArticle[]> {
  const { articles } = await discoverSiteArticlesDetailed(rootUrl, opts)
  return articles
}

export interface SyncSiteOptions {
  /** 限额（设置页的自动/手动 + 上次用量，由 `site-sync.ts` 解析） */
  limits?: DiscoveryLimits
  /** 目标年份区间（建立区间），用于"未覆盖年份优先" */
  fromYear?: number
  toYear?: number
}

export interface SiteSyncResult {
  added: number
  report: DiscoveryReport
}

/** * 同步站点：发现文章清单 → 增量写入 web_site_articles → 更新 last_synced_at。 * 返回**本次新增条数 + 发现报告**（Phase 11 H：页/层数实测值会记回站点行，供下次当起点下限）。 */
export async function syncSite(siteId: string, opts: SyncSiteOptions = {}): Promise<SiteSyncResult> {
  const site = getWebSiteById(siteId)
  if (!site) return { added: 0, report: emptyReport() }
  /*
   * 把站内目录已有的 URL 键喂给发现器：① "新增"才算收益（饱和判据的分子）；
   * ② 重复同步时它很大 → 阈值随之变大 → 只要还有成批新文章就会继续走；目录已建全则立刻饱和。
   */
  const existingKeys = listSiteArticleKeys(siteId)
  const { articles, report } = await discoverSiteArticlesDetailed(site.rootUrl, { ...opts, existingKeys })
  const added = upsertSiteArticles(siteId, articles)
  updateWebSiteLastSynced(siteId, new Date().toISOString())
  // 把这次实际走的规模记回站点行（Migration 052），下次当**下限**（防"一次偶发失败导致发现范围退化"）
  if (report.method === 'bfs' && report.pagesFetched > 0) {
    try {
      updateSiteDiscoveryLimits(siteId, report.pagesFetched, report.maxDepthReached)
    } catch (err) {
      logMain('web', `记录站点发现规模失败（不影响同步）：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  logMain(
    'web',
    `站点同步完成：${site.rootUrl} 方式=${report.method} 发现 ${report.discovered} 篇（新增 ${added} 篇）耗时 ${report.seconds}s`
  )
  return { added, report: { ...report, added } }
}
/** 专指词（机构 / 学段）：真正指示"写的是哪一类学校" */
const SPECIFIC_TERMS = [  '高中', '完中', '中学', '初中', '小学', '幼儿园', '学前', '保育', '托育', '入园', '幼教',  '校区', '一中', '侨中', '附中', '高级中学', '职业中学', '职专', '中学部', '高中部', '双语',  '名校', '学考', '教育局', '大学', '学院', '附小',
  /*
   * 2026-10-05 补词（用户实测的第一大漏检来源）：**校名简称与学段词**。
   * 同一所学校，正文写「福州第三中学滨海校区」会被判 specific 通过，模型输出写「福州三中滨海校区」却落 scope-only
   * 被剔除——真实库回放里 13/38 网页漏检全部属于这一类（三中/六中/一中/二中/五中…）。
   * 这里只补"多字、不会误配"的写法；`X中` 那种单字数量的简称由 NUM_ZHONG_RE 三件套处理（见下）。
   */
  '普高', '独立高中', '达标高中', '省一级达标', '三级达标', '二级达标', '一级达标', '示范性高中', '示范高中',
  '集团化办学', '教育集团']/** 弱专指：教育领域通名——比泛词强，但不足以单独判定主题（党校 / 家长学校 / "政绩观学习教育"都会命中） */
const WEAK_TERMS = ['学校', '教育',
  /*
   * 2026-10-05 补：`校园`/`校舍`（**校园设施类通名**）。
   * 为什么要补：回放里 2 条正样本漏检就是「校园占地面积约142亩…」「学校地处鹤上镇…」这类段落——
   * 它们是**同一篇切题文章里描述这所学校的那一段**，但既没有"高中/中学"，也没有"学校"以外的任何词。
   * 收进**弱词档**（不是专指），所以单独出现仍不足以放行（需 弱词≥2 或 弱词+泛词≥2），不会把噪声放进来。
   */
  '校园', '校舍']/** 泛词：动作 / 属性 / 指标——只影响排序，不能单独放行 */
const GENERIC_TERMS = [  '新建', '扩建', '改建', '合并', '规模', '招生', '人数', '分布', '新增', '撤销', '设置', '建设',  '改造', '提升', '达标', '晋级', '评估', '学位', '师资', '课程', '教学楼', '竣工', '开工', '项目',  '投资', '搬迁', '整合', '办学', '规划', '用地', '面积',
  /*
   * 2026-10-05 补"动态要点词"（用户指定）：撰写要求里点名的动作/事件词。
   * 它们只进**泛词档**——泛词单独不足以放行（需 弱词≥1 且 泛词≥2），因此只会**提高**召回，不会降低既有判定。
   */
  '新办', '新设', '落成', '投用', '启用', '扩班', '增设', '更名', '并入', '招生计划', '录取', '扩容', '复办', '办班']/** 范围词：地理 / 层级限定——只能作 AND 约束，**排序中不加权、不贡献 bigram 分** */
const SCOPE_TERMS = [  '全区', '全省', '全市', '全国', '长乐区', '长乐', '福州新区', '省市', '区级', '市级', '省级',  '国家级', '乡镇', '街道', '社区', '园区']
const SCOPE_SUFFIX_RE = /(省|市|区|县|镇|乡|街道|新区|开发区)$/
/*
 * —— 校名简称「X中」的**模式 + 白名单 + 否定词**三件套（2026-10-05）——
 *
 * 项目里踩过的坑：用 `[一二三四五六七八九十]中` 通配识别校名，把「三中路」「中亭街」这类地名也算成学校。
 * 这里的三件套口径：
 *   ① **模式**：汉字数字 + `中`，且**前一个字不是** 初/高/完/附/侨 —— `初中`/`高中`/`完中`/`附中`/`侨中`
 *      本身就是专指词，不必也不该由这条规则"再认"一次（它们已由 SPECIFIC_TERMS 命中）；
 *   ② **否定词**：`中` 后面紧跟 路/街/巷/里/弄/站/桥/村/厝/境/洲/铺/亭 时，判定为地名（三中路、中亭街），不升档；
 *   ③ **白名单**：`中` 后面紧跟 学/校/滨海/校/部/新/小/高/初 等学校语境字（三中滨海校区、三中、三中学、三中部）→ 升档。
 *
 * 为什么还要白名单：真实文本里 90% 的「三中」都不带任何后缀（如「长乐三中复办」），
 * 若要求必须有后缀，等于这条规则几乎不生效；而**否定词**已经挡住了已知的误配，所以"无后缀"也放行，
 * 只把命中的子串（`三中`）当专指词。
 *
 * 口径保证：这条规则**只允许提高**档位（`upgradeTopicClass` 只做 specific > weak > generic > scope 的升档），
 * 绝不降低任何既有判定。
 */
const NUM_ZHONG_RE = /([一二三四五六七八九十])中/g
/** 模式里的前字否定：这些字与"数字+中"连读时是**别的词**（初中/高中/完中/附中/侨中），不是校名简称 */
const NUM_ZHONG_PREV_DENY = new Set(['初', '高', '完', '附', '侨', '小'])
/** 否定词（后字）：`三中路`/`中亭街` 这类地名——命中即不升档 */
const NUM_ZHONG_PLACE_FOLLOW = new Set(['路', '街', '巷', '里', '弄', '站', '桥', '村', '厝', '境', '洲', '铺', '亭', '社'])
/** 白名单（后字 / 后词）：明确的学校语境，即使同时出现地名后缀也以白名单为准 */
const NUM_ZHONG_SCHOOL_FOLLOW = ['学校', '学', '校区', '滨海', '校部', '部', '新', '小', '高', '初', '附', '党', '团', '总']

/**
 * 在**一段文本**（要求文本或正文）里找出所有"校名简称"命中（`三中`/`六中`…），返回命中的子串。
 * 纯函数、可测试；三件套齐备（模式 + 白名单 + 否定词）。
 */
export function findSchoolAbbrevHits(text: string): string[] {
  const t = text ?? ''
  if (!t.includes('中')) return []
  const chars = Array.from(t)
  const hits = new Set<string>()
  for (const m of t.matchAll(NUM_ZHONG_RE)) {
    const at = m.index ?? 0
    // 注意：中文数字与「中」都是单 code unit，可直接按下标取前后字
    const prev = at > 0 ? t[at - 1] : ''
    if (NUM_ZHONG_PREV_DENY.has(prev)) continue
    const after = t.slice(at + m[0].length, at + m[0].length + 2) // 取两个字足够判断白名单
    const next = chars[at + 2] ?? ''
    const isSchool = NUM_ZHONG_SCHOOL_FOLLOW.some((w) => after.startsWith(w))
    const isPlace = NUM_ZHONG_PLACE_FOLLOW.has(next)
    // 白名单优先于否定词（「三中学」「三中滨海校区」都要认）
    if (!isSchool && isPlace) continue
    hits.add(m[0])
  }
  return [...hits]
}

/** 档位强弱（升档用）：数字越大越强。**只用于升档，绝不用于降档。** */
const CLASS_RANK: Record<TopicTermClass, number> = { specific: 3, weak: 2, generic: 1, scope: 0 }

/** 把一个词按"只升不降"的口径与目标档位合并（2026-10-05：新增词表/规则一律不得降低既有判定） */
export function upgradeTopicClass(current: TopicTermClass, target: TopicTermClass): TopicTermClass {
  return CLASS_RANK[target] > CLASS_RANK[current] ? target : current
}/** 检索词分层（纯函数、可测试）：specific > weak > generic > scope；判定顺序不可颠倒（`校区` 不能被"（区）$"吃成范围词） */
export type TopicTermClass = 'specific' | 'weak' | 'generic' | 'scope'
export function classifyTopicTerm(term: string): TopicTermClass {
  const t = (term ?? '').trim()
        if (!t)
        return 'generic'
  if (SPECIFIC_TERMS.some((w) => t.includes(w)))
        return 'specific'
  if (WEAK_TERMS.some((w) => t.includes(w)))
        return 'weak'
  if (GENERIC_TERMS.some((w) => t.includes(w)))
        return 'generic'
  if (SCOPE_TERMS.some((w) => t.includes(w)) || SCOPE_SUFFIX_RE.test(t))
        return 'scope'  // 认不出来的词按泛词处理：给一点权重（弱于专指），但不倒扣——避免把用户自定义的主题词打进冷宫
  return 'generic'}
/** * **词表扫描**（Phase 10 P5b）：在一段文字里按四层词表逐个找出现过的词。 * * 为什么需要它：`extractTopicTerms` 面向"短查询串"，遇到**整段撰写要求**（真实例子："标题为"高中学校设置"，包括学校的 * 新建、扩建、改建、合并、规模、招生人数、地理分布等等，注意，这只能包含长乐区的内容…"）时只提出一个整句词 * 「高中学校设置」，分层表里 weak/generic 全空——用它做正文判定会把 **600 篇全部误杀**（真实库副本回放实测）。 * 词表扫描直接按已知词表取词，长短文本都稳；整句词只留给词法兜底，不作字面命中要求。 */
export function scanTopicLexicon(text: string): { specific: string[]; weak: string[]; generic: string[]; scope: string[]}
 {
  const t = text ?? ''
  const pick = (list: string[]): string[] => [...new Set(list.filter((w) => t.includes(w)))]
  // 校名简称（三中/六中…）由三件套单独识别，一律进**专指层**——正文里出现即是最强证据
  return { specific: [...new Set([...pick(SPECIFIC_TERMS), ...findSchoolAbbrevHits(t)])], weak: pick(WEAK_TERMS), generic: pick(GENERIC_TERMS),
  scope: pick(SCOPE_TERMS)
  }
}

if (import.meta.vitest) {
  const { describe, expect, it }
 = import.meta.vitest
  describe('site-crawler utils (web source library)', () => { it('extracts absolute links with anchor text', () => {
  const html = `        <a href="/xxgk/ztzl/xqnj/202512/t20251203_5239523.htm">福州新区年鉴（2025）</a>        <a href="https://example.com/other.htm">外部链接</a>        <a href="#anchor">锚点</a>        <a href="javascript:void(0)">脚本</a>        <a href="../rel/202608/t20260811_5357559.htm">相对链接</a>      `
  const links = extractLinks(html, 'https://fzxq.fuzhou.gov.cn/xxgk/ztzl/')
  expect(links).toHaveLength(3)
  expect(links[0].href).toBe('https://fzxq.fuzhou.gov.cn/xxgk/ztzl/xqnj/202512/t20251203_5239523.htm')
  expect(links[0].text).toBe('福州新区年鉴（2025）')
  expect(links[1].href).toBe('https://example.com/other.htm')
  })
  it('detects article urls by suffix', () => { expect(isArticleUrl('https://fzxq.fuzhou.gov.cn/a.htm')).toBe(true)
  expect(isArticleUrl('https://fzxq.fuzhou.gov.cn/a.htm?page=2')).toBe(true)
  expect(isArticleUrl('https://fzxq.fuzhou.gov.cn/xxgk/ztzl/xqnj/')).toBe(false)
  expect(isArticleUrl('https://fzxq.fuzhou.gov.cn/sitemap.xml')).toBe(false)
  expect(isArticleUrl('https://www.clnews.com.cn/html/22/list.shtml')).toBe(false)
  expect(isArticleUrl('https://www.clnews.com.cn/index.html')).toBe(false)
  expect(isArticleUrl('https://www.clnews.com.cn/more/22.shtml')).toBe(false)
  })
  it('detects list/channel pages but never real article pages', () => { expect(isListPageUrl('https://www.clnews.com.cn/html/22/list.shtml')).toBe(true)
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
  it('extracts title/subtitle terms from instruction', () => {
  const query = '这次撰写任务的标题为“学前教育”，分为两个子标题“教育与保育”和“园所设置”。注意按照时间顺序展开'
  expect(extractTopicTerms(query)).toEqual(['学前教育', '教育与保育', '园所设置'])      // 无引号无标题引导语 → 回退整句
      expect(extractTopicTerms('2021年全区教育')).toEqual(['2021年全区教育'])
  })
  it('tolerates unpaired quotes when extracting title (test3 regression, 2026-08-14)', () => { // 结尾误用左引号“而非右引号”，仍应提取出标题短词，而非回退整句
      expect(extractTopicTerms('这次撰写任务的标题为“学前教育“')).toEqual(['学前教育'])
  expect(extractTopicTerms('这次撰写任务的标题为“学前教育”')).toEqual(['学前教育'])
  })
  it('extracts the term after 主题为 as well (preset wording, 2026-09-10)', () => { // 预设提示词已改为「本次资料收集的主题为 ……」——用户删掉引号后，本地兜底要认得「主题为」
      expect(extractTopicTerms('本次资料收集的主题为 高中教育')).toEqual(['高中教育'])
  expect(extractTopicTerms('本次资料收集的主题是：高中教育')).toEqual(['高中教育'])      // 带引号的预设原样（占位符未替换）与替换后都应取到内容
      expect(extractTopicTerms('本次资料收集的主题为「高中教育」，具体包括「课程与升学」')).toEqual(['高中教育', '课程与升学'])
  })
  it('expands education domain hints from topic term', () => {
  const terms = extractTopicTerms('标题为“学前教育”')
        const hints = expandDomainHints(terms)
  expect(hints).toContain('幼儿园')
  expect(hints).toContain('保育')
  expect(hints).toContain('幼儿')      // 宽泛的 key 本身（"教育"）不进兜底表，避免误召回"政绩观学习教育"
  expect(hints).not.toContain('教育')      // 收窄后剔除跨词误匹配与泛教育词（2026-08-13 test1 误召回回归）
      expect(hints).not.toContain('入学') // "入学" 会命中"深**入学**习"
  expect(hints).not.toContain('大学') // 避免召回"重庆中新大学"等外地新闻
      expect(hints).not.toContain('教学')
  expect(hints).not.toContain('学生')      // 2026-08-14 再收窄：剔除招生/校历/学位，避免召回中小学/高中招生新闻（test2 漏检矛盾主因）
      expect(hints).not.toContain('招生')
  expect(hints).not.toContain('校历')
  expect(hints).not.toContain('学位')
  })
  it('does not mis-match "入学" inside "深入学习" (test1 误召回回归)', () => {
  const query = '这次撰写任务的标题为“学前教育”'
  const terms = [...extractTopicTerms(query), ...expandDomainHints(extractTopicTerms(query))]
  expect(terms).not.toContain('入学')
  })
  it('treats a space-joined keyword list as separate terms (2026-09-12 修正)', () => { // 生成管线的 coarseQuery = 大模型提取的「标题 + 关键词」用空格拼接，此前会被压成一个长串
      expect(extractTopicTerms('高中学校设置 高中 新建 扩建 合并 规模 招生人数')).toEqual([        '高中学校设置',        '高中',        '新建',        '扩建',        '合并',        '规模',        '招生人数'      ])      // 单条长句（无空格）仍回退整句，保持既有行为
      expect(extractTopicTerms('请把学校建设情况整理成汇编')).toEqual(['请把学校建设情况整理成汇编'])
  })
      it('dedupes http/https article urls to the same key', () => { expect(dedupeArticleKey('https://fzxq.fuzhou.gov.cn/a.htm')).toBe('fzxq.fuzhou.gov.cn/a.htm')
  expect(dedupeArticleKey('http://fzxq.fuzhou.gov.cn/a.htm')).toBe('fzxq.fuzhou.gov.cn/a.htm')
  expect(dedupeArticleKey('https://fzxq.fuzhou.gov.cn/b.htm/')).toBe('fzxq.fuzhou.gov.cn/b.htm')
  })
  it('classifies topic terms into specific / weak / generic / scope (2026-10-04 P1 分层排序)', () => { expect(classifyTopicTerm('高中')).toBe('specific')
  expect(classifyTopicTerm('高中学校设置')).toBe('specific')
  expect(classifyTopicTerm('校区')).toBe('specific') // 不能被"（区）$"吃成范围词：判定顺序不可颠倒
      expect(classifyTopicTerm('长乐区教育局')).toBe('specific')
  expect(classifyTopicTerm('学校')).toBe('weak')
  expect(classifyTopicTerm('教育')).toBe('weak')
  expect(classifyTopicTerm('新建')).toBe('generic')
  expect(classifyTopicTerm('招生人数')).toBe('generic')
  expect(classifyTopicTerm('长乐区')).toBe('scope')
  expect(classifyTopicTerm('福州新区')).toBe('scope')
  expect(classifyTopicTerm('全区')).toBe('scope')
  expect(classifyTopicTerm('玉田镇')).toBe('scope')      // 认不出来的词给泛词档（弱加权、不倒扣），避免把用户自定义主题词打进冷宫
      expect(classifyTopicTerm('甲乙丙')).toBe('generic')
  expect(classifyTopicTerm('')).toBe('generic')
  })
  it('认出校名简称与学段词（2026-10-05 补词表：本次漏检第一大来源）', () => { // 学段/机构类新词
  expect(classifyTopicTerm('普高')).toBe('specific')
  expect(classifyTopicTerm('独立高中')).toBe('specific')
  expect(classifyTopicTerm('省一级达标')).toBe('specific')
  expect(classifyTopicTerm('达标高中')).toBe('specific')
  expect(classifyTopicTerm('集团化办学')).toBe('specific')
  // 动态要点词只进泛词（单独不足以放行，只提高召回）
  expect(classifyTopicTerm('新办')).toBe('generic')
  expect(classifyTopicTerm('投用')).toBe('generic')
  expect(classifyTopicTerm('更名')).toBe('generic')
  expect(classifyTopicTerm('招生计划')).toBe('generic')
  expect(classifyTopicTerm('录取')).toBe('generic')
  // 校名简称：正文里"福州三中滨海校区"必须与"福州第三中学滨海校区"同档
  const hits = scanTopicLexicon('福州三中滨海校区等学校建成招生')
  expect(hits.specific).toContain('三中')
  expect(hits.specific).toContain('校区')
  expect(hits.weak).toContain('学校')
  })
  it('校名简称三件套：能升档、不误配地名（2026-10-05）', () => { // ① 能升档
  expect(findSchoolAbbrevHits('福州三中滨海校区')).toEqual(['三中'])
  expect(findSchoolAbbrevHits('长乐六中新校区')).toEqual(['六中'])
  expect(findSchoolAbbrevHits('长乐一中首占校区新增体艺特长生招生')).toEqual(['一中'])
  expect(findSchoolAbbrevHits('长乐二中、长乐五中扩容')).toEqual(['二中', '五中'])
  // 「侨中」是**词**不是"数字+中"，由 SPECIFIC_TERMS 命中，不由本条模式再认（避免两条规则互相干扰）
  expect(findSchoolAbbrevHits('长乐侨中侨港澳台生班')).toEqual([])
  expect(scanTopicLexicon('长乐侨中侨港澳台生班').specific).toContain('侨中')
  // 无后缀的"X中"（真实文本里最常见：长乐三中复办）必须能认出来。
  // 「第三中学」里的"三中"也会被命中——这是**故意**的：它同样指福州三中系，升档方向与需求一致（宁可多升、不可漏升）。
  expect(findSchoolAbbrevHits('2024年，福建省长乐第三中学复办')).toEqual(['三中'])
  expect(scanTopicLexicon('2024年，福建省长乐第三中学复办').specific).toContain('中学')
  expect(findSchoolAbbrevHits('长乐八中滨海校区')).toEqual(['八中'])
  // ② 明显误配不升档：地名（三中路 / 中亭街）与"初中/高中/完中/附中"（已由词表命中，不由本条再认）
  expect(findSchoolAbbrevHits('三中路口的红绿灯')).toEqual([])
  expect(findSchoolAbbrevHits('中亭街商业区')).toEqual([])
  expect(findSchoolAbbrevHits('长乐四中巷')).toEqual([])
  expect(findSchoolAbbrevHits('初中部')).toEqual([])
  expect(findSchoolAbbrevHits('高中三个年级')).toEqual([])
  expect(findSchoolAbbrevHits('完中校')).toEqual([])
  // 白话里"中"字极多，但没有"数字+中"就不该有任何命中
  expect(findSchoolAbbrevHits('在群众中开展集中学习')).toEqual([])
  // ③ 升档方向：只升不降
  expect(upgradeTopicClass('scope', 'specific')).toBe('specific')
  expect(upgradeTopicClass('specific', 'scope')).toBe('specific')
  expect(upgradeTopicClass('generic', 'weak')).toBe('weak')
  expect(upgradeTopicClass('weak', 'generic')).toBe('weak')
  })
  it('normalizes article urls: host lowercase, strips http/https, tracking params, trailing slash (A3, 2026-08-28)', () => { expect(normalizeArticleUrl('https://FZXQ.fuzhou.gov.cn/a.htm?utm_source=x&b=1#sec')).toBe('https://fzxq.fuzhou.gov.cn/a.htm?b=1')
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
  it('parses news:publication_date from sitemap (Phase 10 日期阶梯 L2a)', () => { // Google News 扩展比 lastmod 更贴"发布时间"，阶梯里要优先用它
  const withNews =        '<urlset><url><loc>https://x.gov.cn/a.htm</loc><lastmod>2025-01-05</lastmod>' +        '<news:publication_date>2024-12-31</news:publication_date></url>' +        '<url><loc>https://x.gov.cn/b.htm</loc><lastmod>2025-01-06</lastmod></url></urlset>'
  const s = parseSiteMap(withNews, 'https://x.gov.cn')
  expect(s[0].publicationDate).toBe('2024-12-31')
  expect(s[0].lastmod).toBe('2025-01-05')
  expect(s[1].publicationDate).toBeUndefined()
  expect(s[1].lastmod).toBe('2025-01-06')      // 无命名空间前缀的写法也要认
      expect(parseSiteMap('<urlset><url><loc>https://x.gov.cn/c.htm</loc><publication_date>2024-11-30</publication_date></url></urlset>', 'https://x.gov.cn')[0].publicationDate).toBe('2024-11-30')
  })
  it('parses robots.txt crawl-delay (seconds → milliseconds) + disallow (C6, 2026-08-28 / 单位修正 2026-10-04)', () => {
  const robots = 'User-agent: *\nDisallow: /admin/\nDisallow: /search\nCrawl-delay: 2\nAllow: /public/'
  const r = parseRobotsTxt(robots)      // robots.txt 的 Crawl-delay 单位是秒，模块内一律用毫秒（原先按秒解析、按毫秒使用 → 站点限速被完全忽略）
      expect(r.crawlDelayMs).toBe(2000)
  expect(r.disallow).toEqual(['/admin/', '/search'])
  expect(isPathDisallowed('https://x.gov.cn/admin/a.htm', r.disallow)).toBe(true)
  expect(isPathDisallowed('https://x.gov.cn/a.htm', r.disallow)).toBe(false)      // 声明过大的间隔按上限截断，避免一次生成卡死数小时
      expect(parseRobotsTxt('User-agent: *\nCrawl-delay: 3600').crawlDelayMs).toBe(10000)      // 未声明 / 非法值 → 不设间隔（由默认 120ms 兜底）
      expect(parseRobotsTxt('User-agent: *\nDisallow: /x').crawlDelayMs).toBeUndefined()
  expect(parseRobotsTxt('User-agent: *\nCrawl-delay: abc').crawlDelayMs).toBeUndefined()
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

  /*
   * Phase 11 H：**自适应发现遍历器**的单测（用注入的假站点驱动，不碰网络）。
   * 假站点结构（模仿 clnews 那种"栏目 → 年-月归档 → 文章"）：
   *   首页 → 2 个栏目页；每个栏目页 → 1 个年-月归档页 + 若干文章；归档页 → 一批文章。
   * 要验证的四件事：① 归档页优先出队；② 收益饱和即停（不走满上限）；③ 目录已有的文章不算"新增"；
   * ④ 报告如实（页数/层数/停止原因/年月格子/年份分布）。
   */
  it('自适应发现：归档页优先、收益饱和即停、目录已有的不算新增、报告如实（Phase 11 H）', async () => {
    const fetched: string[] = []
    const pages: Record<string, string> = {
      'http://x.gov.cn/': `<a href="/news/a/">栏目A</a><a href="/news/b/">栏目B</a><a href="/news/c/">栏目C</a>`,
      'http://x.gov.cn/news/a/': `<a href="/html/1/2016-01/">2016年1月</a><a href="/html/1/2016-01-05/aaa.shtml">A1</a>`,
      'http://x.gov.cn/news/b/': `<a href="/html/2/2016-02/">2016年2月</a><a href="/html/2/2016-02-06/bbb.shtml">B1</a>`,
      'http://x.gov.cn/html/1/2016-01/': `<a href="/html/1/2016-01-07/ccc.shtml">C1</a><a href="/html/1/2016-01-08/ddd.shtml">D1</a>`,
      'http://x.gov.cn/html/2/2016-02/': `<a href="/html/2/2016-02-09/eee.shtml">E1</a>`,
      // 栏目 C 及其空归档页：**不产出任何文章**，只为把"可走页面数"做大，用来考"页数下限"
      'http://x.gov.cn/news/c/': `<a href="/html/3/2016-03/">2016年3月</a><a href="/html/4/2016-04/">2016年4月</a><a href="/html/5/2016-05/">2016年5月</a>`,
      'http://x.gov.cn/html/3/2016-03/': '<html></html>',
      'http://x.gov.cn/html/4/2016-04/': '<html></html>',
      'http://x.gov.cn/html/5/2016-05/': '<html></html>'
    }
    const fetchHtml = async (url: string): Promise<string> => {
      fetched.push(url)
      const html = pages[url]
      if (html === undefined) return '<html></html>' // 未定义页面：空页（零收益）
      return html
    }

    // ① 全新站点：应发现 5 篇文章，且**归档页先于栏目页里的其它路径**被访问
    const first = await discoverSiteArticlesDetailed('http://x.gov.cn/', { fetchHtml, fromYear: 2016, toYear: 2016 })
    expect(first.report.discovered).toBe(5)
    expect(first.report.method).toBe('bfs')
    // 首页之后，第 3 个被访问的页面应当是归档页（年-月优先；首页/栏目页必然在前两步之一）
    const archiveIdx = fetched.findIndex((u) => u.includes('2016-01/') || u.includes('2016-02/'))
    expect(archiveIdx).toBeGreaterThan(0)
    expect(archiveIdx).toBeLessThanOrEqual(2)
    expect(first.report.byYear).toEqual({ '2016': 5 })
    expect(first.report.cellCount).toBe(2)
    expect(first.report.limits.mode).toBe('auto')
    // 收益饱和后主动收工（不该走满安全阀）
    expect(first.report.pagesFetched).toBeLessThan(first.report.limits.maxPages)
    expect(['saturated', 'frontier-empty']).toContain(first.report.stopReason)

    // ② 重复同步：目录里已有这 5 篇 → 一篇"新增"都没有，应当更快收工（省请求）
    const existing = new Set([...first.articles.map((a) => dedupeArticleKey(a.url))])
    const fetched2: string[] = []
    const second = await discoverSiteArticlesDetailed('http://x.gov.cn/', {
      fetchHtml: async (u) => {
        fetched2.push(u)
        return pages[u] ?? '<html></html>'
      },
      existingKeys: existing
    })
    expect(second.report.discovered).toBe(5)
    expect(second.report.freshArticles).toBe(0)
    expect(fetched2.length).toBeLessThanOrEqual(fetched.length)

    /*
     * ③ 页数下限：上次用量当下限——即使看起来饱和，也要走到至少这么多页。
     * （假站点共 9 个可达页面，其中 3 个空归档页不产出 → 足以让"下限 6"真正生效）
     */
    const floored = await discoverSiteArticlesDetailed('http://x.gov.cn/', {
      fetchHtml,
      existingKeys: existing,
      limits: resolveLimits({ hintPages: 6 })
    })
    expect(floored.report.pagesFetched).toBeGreaterThanOrEqual(6)
    expect(floored.report.limits.minPages).toBe(6)
    // 但也不该走满安全阀：下限之上仍然按饱和收工
    expect(floored.report.pagesFetched).toBeLessThan(floored.report.limits.maxPages)

    // ④ 手动限额：层数上限 1 → 只能抓首页与它的直接链接，邮件/深层归档走不到，且如实记剪枝数
    const shallow = await discoverSiteArticlesDetailed('http://x.gov.cn/', {
      fetchHtml,
      limits: resolveLimits({ mode: 'manual', manualPages: 20, manualDepth: 1 })
    })
    expect(shallow.report.maxDepthReached).toBeLessThanOrEqual(1)
    expect(shallow.report.limits.saturation).toBe(false)
    // 归档页（第 2 层）没走到 → 只有栏目页里的 2 篇文章
    expect(shallow.report.discovered).toBe(2)
  })
  })
}
