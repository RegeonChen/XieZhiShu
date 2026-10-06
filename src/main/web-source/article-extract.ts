/**
 * article-extract.ts —— 网页正文的**双提取器择优**（Phase 10 P4）。
 *
 * 为什么换掉原来的实现：旧的"正则找 `article/main/class` 容器"在真实站点上 **600/600 全部退回整页文本**（等于没生效）。
 * 外部评测（trafilatura 官方 `evaluation.html`，2026-10-02，990 篇多语言含中文）显示 trafilatura 2.3.0 的
 * F1 **0.926**、readability-lxml **0.853**、goose3 精度高但召回仅 0.713；而 Node 侧有 `trafilatura`（rs-trafilatura 的
 * napi-rs 绑定）。本模块**两个都跑、按质量择优**，并且**任何一步失败都不阻断**（最差退回旧的正则整页文本）。
 *
 * 实测（长乐新闻网 6 篇真实文章，2026-10-04）：trafilatura 4–11 ms/篇、readability+linkedom 4–17 ms/篇；
 * trafilatura 会在**首行**带上站点元数据（`http://… 日期 来源 字号`），readability 的标题会带 `_正文_信息公开_长乐新闻网`
 * 之类的后缀 —— 两者都需要清理，故本模块提供 `stripLeadingMeta` / `cleanExtractedTitle`（纯函数、可测试）。
 */
import { extractArticleText } from './site-crawler'

/** 提取结果的来源（写进 `sources.text_source`：`extractor` 表示结构化提取成功、`full-page` 表示退回整页文本） */
export type ExtractSource = 'trafilatura' | 'readability' | 'regex' | 'full-page'

export interface ExtractedArticle {
  /** 正文纯文本（已做首行元数据剥离） */
  text: string
  /** 页面声明的标题（可能为 null） */
  title: string | null
  /** 页面声明的发布时间（L5 证据；该站没有 JSON-LD/meta 时为 null） */
  date: string | null
  source: ExtractSource
  /** 质量评分（0–1，供"择优"与后续诊断） */
  quality: number
  /** 各候选的字数（诊断用） */
  candidates: { source: ExtractSource; chars: number; quality: number }[]
}

/**
 * 剥离正文**首行**的站点元数据行。
 * 真实站点形如：`http://www.clnews.com.cn 2022-04-19 08:59:26 来源：福州市长乐区保障性住房建设 【字号 大 中 小】`
 * 规则（保守）：只在**第 1–2 行**里、且该行同时含 URL 与日期时才删；不碰正文内容。
 */
export function stripLeadingMeta(text: string): string {
  const lines = (text ?? '').replace(/\r/g, '').split('\n')
  let cut = 0
  for (let i = 0; i < Math.min(2, lines.length); i++) {
    const l = lines[i].trim()
    if (l && /https?:\/\/\S+/.test(l) && /(20\d{2})[-年/.]\d{1,2}/.test(l)) cut = i + 1
  }
  return lines.slice(cut).join('\n').trim()
}

/**
 * 清理提取器给出的标题：去掉 `_正文_信息公开_长乐新闻网` 这类**站点后缀**。
 * 规则：截断到第一个 `_正文` 之前；若仍含 `_`/`-` 分隔且尾段像站点名（含"网/报/新闻/政府/频道"或与站点名相同）则再截掉。
 * 保守优先：只在**确实像后缀**时才截断，避免把 `2018年长乐区公开选聘"一懂两爱"村务工作者公告` 这类标题改坏。
 */
export function cleanExtractedTitle(raw: string | null | undefined, siteTitle?: string | null): string | null {
  let t = (raw ?? '').trim()
  if (!t) return null
  const idx = t.search(/[_｜|]\s*正文/)
  if (idx > 0) t = t.slice(0, idx).trim()
  const st = (siteTitle ?? '').trim()
  if (st && t.endsWith(st) && t.length > st.length) {
    t = t.slice(0, t.length - st.length).replace(/[_｜|\-–—\s]+$/, '').trim()
  }
  const m = /^(.*?)[_｜|]([^_｜|]{2,12})$/.exec(t)
  if (m && /(网|报|新闻|政府|频道|门户|融媒|日报|晚报|电视台)$/.test(m[2])) t = m[1].trim()
  return t || null
}

/** 模板残余启发式：命中则扣分（这是 readability 相对 trafilatura 的优势项） */
const BOILERPLATE_RE = /相关新闻|相关阅读|更多>>|闽ICP备|版权所有|字号\s*[大小中]|责任编辑|上一篇|下一篇/

/**
 * 质量评分（0–1，纯函数、可测试）：**长度**为主，**模板残余**扣分，**链接密度**（Markdown/裸链数量）扣分。
 * 只用于"在两个候选之间选一个"，不参与后续相关性判断。
 */
export function scoreExtracted(text: string): number {
  const t = (text ?? '').trim()
  if (!t) return 0
  const chars = t.length
  // 长度分：200 字起步、2000 字满分（志书材料通常几百到几千字）
  const lenScore = Math.min(1, Math.max(0, (chars - 200) / 1800))
  const links = (t.match(/https?:\/\//g) ?? []).length
  const linkPenalty = Math.min(0.35, links * 0.03)
  const boilerPenalty = BOILERPLATE_RE.test(t) ? 0.2 : 0
  return Math.max(0, Math.min(1, 0.6 * lenScore + 0.4 - linkPenalty - boilerPenalty))
}

/** 单个候选提取器的返回（内部使用；依赖注入以便单测） */
interface Candidate {
  source: ExtractSource
  text: string
  title: string | null
  date: string | null
}

type TrafilaturaLike = {
  extract: (html: string, opts?: { url?: string; favorPrecision?: boolean }) => {
    contentText?: string
    metadata?: { title?: string | null; date?: string | null }
  }
}

/** 惰性加载原生绑定：加载失败（缺预编译产物/架构不符）时**降级**而不是崩，故不放在顶层 import */
let trafilaturaModule: TrafilaturaLike | null | undefined
function loadTrafilatura(): TrafilaturaLike | null {
  if (trafilaturaModule !== undefined) return trafilaturaModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    trafilaturaModule = require('trafilatura') as TrafilaturaLike
  } catch {
    trafilaturaModule = null
  }
  return trafilaturaModule
}

let readabilityModule: { Readability: new (doc: unknown) => { parse: () => { textContent?: string; title?: string; publishedTime?: string | null } | null } } | null | undefined
let linkedomModule: { parseHTML: (html: string) => { document: unknown } } | null | undefined
function loadReadability(): typeof readabilityModule {
  if (readabilityModule !== undefined) return readabilityModule
  try {
    readabilityModule = require('@mozilla/readability') as typeof readabilityModule
  } catch {
    readabilityModule = null
  }
  return readabilityModule
}
function loadLinkedom(): typeof linkedomModule {
  if (linkedomModule !== undefined) return linkedomModule
  try {
    linkedomModule = require('linkedom') as typeof linkedomModule
  } catch {
    linkedomModule = null
  }
  return linkedomModule
}

/**
 * 提取正文（**双提取器择优 + 最差退回整页正则**）。任何候选抛错都只丢该候选。
 * @param siteTitle 站点名称（用于清理标题里的站点后缀）
 */
export function extractArticle(html: string, url: string, siteTitle?: string | null): ExtractedArticle {
  const raw = html ?? ''
  const candidates: Candidate[] = []
  const errors: string[] = []

  // ① trafilatura（原生，Rust 移植）
  const tf = loadTrafilatura()
  if (tf) {
    try {
      const r = tf.extract(raw, { url, favorPrecision: true })
      const text = stripLeadingMeta(r?.contentText ?? '')
      if (text) candidates.push({ source: 'trafilatura', text, title: r?.metadata?.title ?? null, date: r?.metadata?.date ?? null })
    } catch (err) {
      errors.push('trafilatura: ' + String(err).slice(0, 80))
    }
  }

  // ② readability + linkedom（纯 JS，无原生依赖）
  const rd = loadReadability()
  const ld = loadLinkedom()
  if (rd && ld) {
    try {
      const { document } = ld.parseHTML(raw)
      const parsed = new rd.Readability(document).parse()
      const text = stripLeadingMeta(parsed?.textContent ?? '')
      if (text) candidates.push({ source: 'readability', text, title: parsed?.title ?? null, date: parsed?.publishedTime ?? null })
    } catch (err) {
      errors.push('readability: ' + String(err).slice(0, 80))
    }
  }

  // ③ 兜底：旧的容器正则（真实站点上通常退回整页文本）——保证"永不空手而归"
  if (candidates.length === 0) {
    const text = stripLeadingMeta(extractArticleText(raw))
    if (text) candidates.push({ source: 'regex', text, title: null, date: null })
  }

  const scored = candidates.map((c) => ({ ...c, quality: scoreExtracted(c.text) }))
  scored.sort((a, b) => b.quality - a.quality || b.text.length - a.text.length)
  const best = scored[0]
  if (!best) {
    return { text: '', title: null, date: null, source: 'full-page', quality: 0, candidates: [] }
  }
  return {
    text: best.text,
    title: cleanExtractedTitle(best.title, siteTitle),
    date: best.date,
    source: best.source,
    quality: best.quality,
    candidates: scored.map((c) => ({ source: c.source, chars: c.text.length, quality: c.quality }))
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('article-extract（Phase 10 双提取器择优的纯函数部分）', () => {
    it('strips the site metadata line that trafilatura leaves on the first line', () => {
      const text = [
        'http://www.clnews.com.cn 2022-04-19 08:59:26 来源：福州市长乐区保障性住房建设 【字号 大 中 小】',
        '根据《长乐市公共租赁住房建设配租管理的实施意见》的规定……'
      ].join('\n')
      const out = stripLeadingMeta(text)
      expect(out.startsWith('根据')).toBe(true)
      expect(out).not.toContain('字号')
      // 正文首行本身含 URL 与日期时**不动**（保守：只在第 1–2 行、且同时含 URL 与日期才删）
      const legit = 'https://example.com 2022 年的资料表明……'
      expect(stripLeadingMeta(legit)).toBe(legit)
      expect(stripLeadingMeta('')).toBe('')
    })

    it('cleans site suffixes from extracted titles without damaging real titles', () => {
      expect(cleanExtractedTitle('福州市长乐区总工会公开招聘工会专干公告_正文_信息公开_长乐新闻网')).toBe(
        '福州市长乐区总工会公开招聘工会专干公告'
      )
      expect(cleanExtractedTitle('长乐区这所学校改扩建项目完工', '长乐新闻网')).toBe('长乐区这所学校改扩建项目完工')
      expect(cleanExtractedTitle('要闻_长乐新闻网')).toBe('要闻')
      // 真实标题里带引号/年份的不能被截坏
      const t = '2018年长乐区公开选聘"一懂两爱"村务工作者公告'
      expect(cleanExtractedTitle(t)).toBe(t)
      expect(cleanExtractedTitle('')).toBeNull()
      expect(cleanExtractedTitle(null)).toBeNull()
    })

    it('scores longer, cleaner text higher (用于两个候选之间择优)', () => {
      const long = '正文内容。'.repeat(300) // 1500 字
      const short = '短正文。'
      expect(scoreExtracted(long)).toBeGreaterThan(scoreExtracted(short))
      // 模板残余扣分
      const withBoiler = long + '相关新闻 更多>> 闽ICP备'
      expect(scoreExtracted(withBoiler)).toBeLessThan(scoreExtracted(long))
      // 链接密度扣分
      const withLinks = long + ' https://a.com https://b.com https://c.com'
      expect(scoreExtracted(withLinks)).toBeLessThan(scoreExtracted(long))
      expect(scoreExtracted('')).toBe(0)
    })

    it('never returns nothing: falls back to the legacy regex extractor', () => {
      const html = '<html><body><article><p>' + '长乐区的材料内容。'.repeat(50) + '</p></article></body></html>'
      const r = extractArticle(html, 'https://x.gov.cn/a.htm')
      // 环境里两个库都能加载时应走结构化提取；若都加载失败则退回 regex —— 两条路都必须有正文
      expect(r.text.length).toBeGreaterThan(100)
      expect(['trafilatura', 'readability', 'regex']).toContain(r.source)
      expect(r.quality).toBeGreaterThan(0)
    })
  })
}
