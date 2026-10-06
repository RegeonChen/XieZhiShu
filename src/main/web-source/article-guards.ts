/**
 * article-guards.ts —— 网页抓取的两类**硬判定**（纯函数、可测试），2026-10-05 建立。
 *
 * 为什么有这个模块：
 * 1. **A1/A2 兜底回归**。P0（2026-10-04）修的三处缺陷里，「A1 标题探针」与「空标题候选兜底」原本实现在
 *    旧抓取路径（`site-crawler.ts` 的 `importSiteArticle`）里；Phase 10 P4 换成 `article-crawl.ts` 之后
 *    **没有接回**这两条 —— 结果是：站点对已失效的老文章返回「HTTP 200 + 通用模板页」时照常当材料入库，
 *    界面上 `webScanShortBody` / `webScanTemplateRepeat` 两条提示**恒为 0、永不渲染**。
 *    这里把两条判定还原成纯函数，并由 `article-crawl.ts` 在"抓到正文之后、落库之前"调用。
 * 2. **抓取目标的协议 + 同域白名单**。文章 URL 来自 feed / sitemap / BFS 解析出的 `<loc>` / `<link>`，
 *    属于**外部数据**：被篡改的 sitemap 可以塞入跨域地址或非 http(s) 协议。旧管线里 `validateUrl` 只被
 *    "手动添加网址"调用，抓取路径**从不校验** → 软件可能被诱导去抓内网/任意主机。
 *    现在统一在抓取前用 `isAllowedTargetUrl` 过滤（只放行 http(s) 且主机属于该注册站点）。
 */
import { validateUrl } from '../import/url-fetcher'

/** 空标题候选（sitemap 发现）的正文长度下限：清洗后短于此长度判为模板/失效页 */
export const MIN_ARTICLE_CHARS_EMPTY_TITLE = 200

/**
 * 允许启用 A1 标题探针的候选标题**最短长度**（去空白后）。
 *
 * 为什么不是旧实现的 4 字：候选标题来自 list 页锚文本（`discoverSiteArticles` 用 `text || url`），
 * 真实站点上存在大量**非标题锚文本**——「更多>>」「详情」「查看全文」这类 4~6 字按钮文本，
 * 甚至直接是 URL 本身。旧阈值 4 字会让这类候选去正文里找「更多>>」→ 必然找不到 → **把真文章整篇丢掉**。
 * 8 字意味着"探针字符串至少 8 字"（探针本身取前 8 字），按钮文本基本被排除；
 * 真正靠 sitemap 发现的候选本来就没有标题（走正文长度/重复两条兜底），保护范围不受影响。
 */
export const MIN_TITLE_CHARS_FOR_PROBE = 8

/** 匹配用归一化：去掉空白与全角空格 */
function stripSpaces(value: string | undefined): string {
  return (value ?? '').replace(/[\s\u3000]/g, '')
}

/**
 * A1：**抓回来的页面是否真的包含这篇文章**（纯函数）。
 *
 * 动因（2026-09-12 用户实测）：站点对**已失效的老文章 URL 返回 HTTP 200 + 一份通用模板页**
 * （导航 + 其他文章列表 + 页脚）。只看状态码就会把整页模板当正文入库——实测某次任务 208 篇里
 * 119 篇（57%）如此，正文完全相同且不含该文章标题，随后被当素材送进大模型。
 *
 * 判定：标题核心片段（去空白后前 8 字）必须出现在**提取正文**或**原始 HTML** 里；
 * 标题过短（< 4 字）时不判定（避免误杀）；原始 HTML 命中即可通过（防结构化提取器输出的正文不含标题）。
 */
export function pageContainsArticle(rawHtml: string | undefined, text: string | undefined, title: string): boolean {
  const t = stripSpaces(title)
  if (t.length < 4) return true
  const probe = t.slice(0, Math.min(8, t.length))
  return stripSpaces(text).includes(probe) || stripSpaces(rawHtml).includes(probe)
}

/**
 * 空标题候选（sitemap 发现，`title === ''`）的正文有效性判定（纯函数）。
 * 这类候选取不到"抓取前就知道的标题"，A1 标题探针**必然通过**（页面标题就取自同一份 HTML）→ 形同不存在。
 * 改用两条可判定兜底：① 清洗后正文短于 {@link MIN_ARTICLE_CHARS_EMPTY_TITLE}；
 * ② 同站点**别的 URL** 已抓到完全相同的正文（模板页成群出现，逐字相同）。返回 `null` 表示通过。
 */
export function checkEmptyTitleBody(
  cleanedText: string,
  duplicateUrl: string | null
): 'shortBody' | 'templateRepeat' | null {
  if ((cleanedText ?? '').trim().length < MIN_ARTICLE_CHARS_EMPTY_TITLE) return 'shortBody'
  if (duplicateUrl) return 'templateRepeat'
  return null
}

/** 取 URL 的主机名（小写）；非法 URL 返回 null */
export function hostOf(rawUrl: string): string | null {
  try {
    const u = new URL((rawUrl ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * 该注册站点允许抓取的主机集合：根网址的主机，以及它的 `www.` / 去 `www.` 变体
 * （老政务站常在同一站点内混用两种写法，只认一种会静默丢材料）。
 */
export function allowedHostsForSite(rootUrl: string): string[] {
  const host = hostOf(rootUrl)
  if (!host) return []
  const bare = host.startsWith('www.') ? host.slice(4) : host
  return [...new Set([host, bare, `www.${bare}`])]
}

/**
 * 抓取目标是否放行（协议 + 同域白名单）。
 * 口径：必须能被 `validateUrl` 接受（**仅 http/https**）且主机在该站点的允许集合内。
 * 任何不满足的目标**不抓取**、只记账（见 `article-crawl.ts` 的 blocked 计数与日志）。
 */
export function isAllowedTargetUrl(rawUrl: string, allowedHosts: readonly string[]): boolean {
  const raw = (rawUrl ?? '').trim()
  try {
    validateUrl(raw)
  } catch {
    return false
  }
  const host = hostOf(raw)
  if (!host) return false
  if (allowedHosts.length === 0) return false
  return allowedHosts.includes(host)
}

/** 抓到的页面是否"确实是这篇文章的正文"（判定结果；`ok` = 放行给后续相关性筛选） */
export type BodyVerdict = 'ok' | 'invalidBody' | 'shortBody' | 'templateRepeat'

/**
 * 把 A1 探针与空标题两条兜底合成**一个纯判定**，供抓取管线在"抓到正文之后、落库之前"调用。
 * 这样整条判定逻辑都能被单测覆盖（管线侧只剩"按结果记账+计数"这一步）。
 *
 * @param candidateTitle 候选文章的标题（来自 feed / BFS 的锚文本；sitemap 候选为空串）
 * @param rawHtml 原始 HTML（A1 探针要在原始 HTML 里也能命中，防提取器输出不含标题）
 * @param text 提取后的正文纯文本
 * @param duplicateUrl 同站点**别的 URL** 已抓到相同正文时的那个 URL（没有则 `null`）
 */
export function judgeFetchedArticle(input: {
  candidateTitle: string
  rawHtml: string
  text: string
  duplicateUrl: string | null
  /**
   * 已知的 A1 探针结论（正文缓存命中时由缓存提供）。
   * 传 `true` 表示"这一页在抓取时已确认包含该文章" → 跳过探针（缓存里没有原始 HTML，重跑会误杀正常文章）；
   * 传 `false` 表示抓取时探针未通过 → 直接判 `invalidBody`。不传则按 `rawHtml` 现算。
   */
  knownProbeOk?: boolean
}): BodyVerdict {
  const rawTitle = (input.candidateTitle ?? '').trim()
  const title = stripSpaces(rawTitle)
  // 只有"看起来真的是标题"的候选才做 A1 探针：够长、且不是 URL（发现兜底会把 URL 当标题，见文件头注释）
  const looksLikeUrl = /^https?:\/\//i.test(rawTitle)
  const probeable = title.length >= MIN_TITLE_CHARS_FOR_PROBE && !looksLikeUrl
  const probeOk = input.knownProbeOk ?? (probeable ? pageContainsArticle(input.rawHtml, input.text, rawTitle) : true)
  if (!probeOk) return 'invalidBody'
  /*
   * 只有**探针天生不可用**的候选（空标题 / 按钮文本 / URL 当标题 —— 多数来自 sitemap）才走"正文过短 / 同站正文逐字相同"。
   * 为什么不对有标题的候选也套长度下限：正文短不等于页面失效 —— 一则 150 字的真实通知不该被丢掉（宁多勿漏），
   * 是否采用交给后面的**正文相关性**判定。这样口径与本项目 P0 记录的原始语义一致。
   */
  if (!probeable) return checkEmptyTitleBody(input.text, input.duplicateUrl) ?? 'ok'
  return 'ok'
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('article-guards（A1 标题探针 / 空标题兜底 / 抓取白名单）', () => {
    it('A1：老文章失效返回的通用模板页必须判掉，正常文章页放行', () => {
      const title = '长乐新添一所普通高中！将于9月开学！'
      // 正常文章页：原始 HTML 里有标题（哪怕提取出的正文不含标题）→ 通过
      expect(pageContainsArticle('<html><title>长乐新添一所普通高中！将于9月开学！</title></html>', '正文', title)).toBe(true)
      // 标题出现在提取正文里 → 通过
      expect(pageContainsArticle('', `${title}\n福州市福外高级中学…`, title)).toBe(true)
      // 通用模板页（导航 + 其他文章列表，既无标题也无正文）→ 丢弃
      const template = '长乐新闻网_长乐区互联网新闻中心 长乐要闻 长乐时讯 乡镇风采 八闽风物正当时 | 读懂福州，从一朵茉莉花开始'
      expect(pageContainsArticle('<html><title>长乐新闻网</title></html>', template, title)).toBe(false)
      // 标题过短（<4 字）不判定，避免误杀
      expect(pageContainsArticle(undefined, '随便什么正文', '教育')).toBe(true)
    })

    it('空标题候选：正文过短判 shortBody，与同站别的 URL 正文逐字相同判 templateRepeat', () => {
      const short = '长乐新闻网 长乐要闻 乡镇风采 部门动态 更多>>'
      expect(checkEmptyTitleBody(short, null)).toBe('shortBody')
      const long = '长乐新闻网'.repeat(80) // 640 字，长度达标
      expect(checkEmptyTitleBody(long, 'https://x.gov.cn/other.htm')).toBe('templateRepeat')
      expect(checkEmptyTitleBody(long, null)).toBeNull()
    })

    it('合成判定 judgeFetchedArticle：四类结果各就各位', () => {
      const title = '长乐新添一所普通高中！将于9月开学！'
      const body = title + '\n' + '正文内容'.repeat(60)
      // 带标题 + 页面确实含该文章 → ok
      expect(judgeFetchedArticle({ candidateTitle: title, rawHtml: `<html><title>${title}</title></html>`, text: body, duplicateUrl: null })).toBe('ok')
      // 带标题 + 模板页 → invalidBody
      const template = '长乐新闻网 长乐要闻 长乐时讯 乡镇风采 部门动态 | 读懂福州，从一朵茉莉花开始'
      expect(judgeFetchedArticle({ candidateTitle: title, rawHtml: '<html><title>长乐新闻网</title></html>', text: template, duplicateUrl: null })).toBe('invalidBody')
      // 无标题 + 正文过短 → shortBody（哪怕同站已有重复也不改变结论顺序）
      expect(judgeFetchedArticle({ candidateTitle: '', rawHtml: '', text: '短正文', duplicateUrl: 'https://x.gov.cn/other.htm' })).toBe('shortBody')
      // 无标题 + 正文够长但与同站别的 URL 逐字相同 → templateRepeat
      expect(judgeFetchedArticle({ candidateTitle: '', rawHtml: '', text: '长乐新闻网'.repeat(80), duplicateUrl: 'https://x.gov.cn/other.htm' })).toBe('templateRepeat')
      // 无标题 + 正文够长且不重复 → ok
      expect(judgeFetchedArticle({ candidateTitle: '', rawHtml: '', text: '长乐新闻网'.repeat(80), duplicateUrl: null })).toBe('ok')
      // 标题只有空白字符 → 视作无标题候选（走长度/重复兜底，不会被误判为 invalidBody）
      expect(judgeFetchedArticle({ candidateTitle: '   ', rawHtml: '', text: '长乐新闻网'.repeat(80), duplicateUrl: null })).toBe('ok')
      // ⚠ 锚文本是按钮文本/URL 时**不得**走标题探针（否则会把真文章整篇误杀）：正文够长 → 放行
      expect(judgeFetchedArticle({ candidateTitle: '更多>>', rawHtml: '', text: '长乐新闻网'.repeat(80), duplicateUrl: null })).toBe('ok')
      expect(
        judgeFetchedArticle({ candidateTitle: 'https://www.clnews.com.cn/html/22/a.htm', rawHtml: '', text: '长乐新闻网'.repeat(80), duplicateUrl: null })
      ).toBe('ok')
      // 但这类候选仍然受"正文过短/同站重复"约束
      expect(judgeFetchedArticle({ candidateTitle: '更多>>', rawHtml: '', text: '短正文', duplicateUrl: null })).toBe('shortBody')
      expect(
        judgeFetchedArticle({ candidateTitle: '', rawHtml: '', text: '长乐新闻网'.repeat(80), duplicateUrl: 'https://x.gov.cn/other.htm' })
      ).toBe('templateRepeat')
    })

    it('抓取白名单：只放行 http(s) 且属于该站点允许主机的 URL', () => {
      const allowed = allowedHostsForSite('https://www.clnews.com.cn/')
      expect(allowed).toContain('www.clnews.com.cn')
      expect(allowed).toContain('clnews.com.cn')
      // 放行：http / https、www 与去 www 变体、带端口不算同主机（端口会进 host）
      expect(isAllowedTargetUrl('https://www.clnews.com.cn/html/22/a.htm', allowed)).toBe(true)
      expect(isAllowedTargetUrl('http://clnews.com.cn/html/22/a.htm', allowed)).toBe(true)
      // 拦截：跨域、子域、非 http(s)、相对/空值
      expect(isAllowedTargetUrl('https://evil.example.com/a.htm', allowed)).toBe(false)
      expect(isAllowedTargetUrl('https://static.clnews.com.cn/a.htm', allowed)).toBe(false)
      expect(isAllowedTargetUrl('http://169.254.169.254/latest/meta-data/', allowed)).toBe(false)
      expect(isAllowedTargetUrl('file:///C:/Windows/win.ini', allowed)).toBe(false)
      expect(isAllowedTargetUrl('javascript:alert(1)', allowed)).toBe(false)
      expect(isAllowedTargetUrl('data:text/html,<h1>x</h1>', allowed)).toBe(false)
      expect(isAllowedTargetUrl('/relative/a.htm', allowed)).toBe(false)
      expect(isAllowedTargetUrl('', allowed)).toBe(false)
      // 站点根网址非法 → 允许集合为空 → 一律不放行（宁可少抓，不可乱抓）
      expect(isAllowedTargetUrl('https://www.clnews.com.cn/a.htm', allowedHostsForSite('not-a-url'))).toBe(false)
    })
  })
}
