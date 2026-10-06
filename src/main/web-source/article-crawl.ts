/**
 * article-crawl.ts —— Phase 10 P4：**按年份区间全量抓取 + 抓到即粗筛**的流水线。
 *
 * 用户裁定的口径（不得擅自放宽）：
 * ① 只抓**发布时间**落在区间内的文章（`published_date`，L1–L5 阶梯的归一化结果）；
 * ② 抓取在**生成流程内同步跑完**（本模块是同步 await 的流水线，不做后台常驻服务）；
 * ③ **未命中粗筛的正文丢弃**——只留哈希 + 字数；
 * ④ **没有篇数上限**；上限只落在"送大模型的字符预算"上（P5）；
 * ⑥ **标题永不作为相关性判据**——本模块的粗筛只看**正文**（`screenArticle` 的输入是抽取后的正文）；
 * ⑦（2026-10-04 追加）**账本是任务级的**：新建任务/新主题时**默认重新抓取并重跑筛选**，用户零操作。
 *    实现见 `db/task-web-fetch.ts`（Migration 047）——同一篇文章在别的任务里处理过**不影响本任务**。
 *
 * 与本地资料库一致的粗筛口径：切块 `chunkByParagraphs` → 词法打分 `scoreChunk` →
 * 命中即保留（`score > RECALL_LEX_MIN` 或正文命中任一检索词）。**阈值刻意保守（宁多勿漏）**：
 * 抓取期的判断只决定"正文要不要留在磁盘上"，**不是**最终相关性结论——最终仍由生成管线在保留集合上再筛一遍。
 *
 * 断点续跑：只处理**本任务账本里没有的**文章。2026-10-05 起：起始时把该任务 `state='failed'` 的记账**清掉**
 * （`clearTaskFetchFailed`），否则"抓失败"的篇会因 `NOT EXISTS` 判定而**永不重试**——旧的手动「重置抓取状态」
 * 入口删除后这是唯一的重试路径（用户裁定 A 删除了那个入口，故在管线内保留可重试能力）。
 * 礼貌限速：同站并发默认 **2**、每请求 **≥120ms**（robots 的 `Crawl-delay` 优先、单位秒）。
 */
import type { Source, WebCrawlProgress, WebCrawlResult, WebCrawlTier } from '../../shared/types'
import Database from 'better-sqlite3'
import { setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { enqueueIndex } from '../rag/indexer'
import { judgeBodyRelevance, type RelevanceTier } from './body-relevance'
import { getSourceByUrl, insertSource, updateSourcePublishedAt } from '../db/sources'
import { updateArticleDates, updateArticleFetchState } from '../db/web-sites'
import { countTaskFetch, listRangeArticles, listUncachedRangeArticles, recordTaskFetch, type TaskFetchTarget } from '../db/task-web-fetch'
import { fetchUrl, type FetchResult } from '../import/url-fetcher'
import { logMain } from '../logger'
import { extractArticle } from './article-extract'
import { EtaEstimator } from './eta'
import { WEB_FETCH_MS_PER_ARTICLE } from './fetch-estimate'
import {
  awaitPoliteDelay,
  fetchRobotsTxt,
  isListPageUrl,
  isPathDisallowed,
  WEB_FETCH_MIN_INTERVAL_MS
} from './site-crawler'
import { allowedHostsForSite, isAllowedTargetUrl, judgeFetchedArticle, pageContainsArticle } from './article-guards'
import { AdaptiveRate } from './adaptive-rate'
import { isFetchCancelled, isFetchPaused, resetFetchControl } from './fetch-control'
import { getSettings } from '../db/settings'
import { getCachedBody, putCachedBody, putCacheMiss } from '../db/article-body-cache'
import { findSiteArticleByBodyHash, listWebSites } from '../db/web-sites'

/** 抓取期粗筛的最低词法分（与本地库保守闸门同口径：`score > RECALL_LEX_MIN`，即 ≥2） */
export const CRAWL_SCREEN_MIN_SCORE = 2

export interface ScreenResult {
  hit: boolean
  /** 正文各块里的最高词法分 */
  bestScore: number
  chunks: number
  /** 正文里出现的检索词（诊断用） */
  matchedTerms: string[]
  /** Phase 10 P5b：放行层级（specific / weak-pair / lexical / none）与理由，写进日志便于审计 */
  tier: RelevanceTier
  reason: string
}

/**
 * **抓取期正文粗筛**（纯函数、可测试）。
 *
 * Phase 10 P5b 起改为**分层口径**（`judgeBodyRelevance`）：专指词命中、弱词组合、bigram 高重合三条之一才放行，
 * **只命中范围词（长乐区/全区/乡镇…）一律剔除**——这是此前 84% 噪声的直接来源。
 * 标题**不参与**相关性判定（用户裁定 ⑦）；未命中的正文按裁定 ③ 丢弃（只留哈希 + 字数）。
 */
export function screenArticle(text: string, query: string, title = '', extraTerms: string[] = []): ScreenResult {
  const q = (query ?? '').trim()
  if (!q) return { hit: false, bestScore: 0, chunks: 0, matchedTerms: [], tier: 'none', reason: '未提供主题关键词' }
  const r = judgeBodyRelevance(text, q, title, extraTerms)
  const matchedTerms = [...r.specificHits, ...r.weakHits, ...r.genericHits]
  const reason =
    r.tier === 'specific'
      ? `专指词命中：${r.specificHits.slice(0, 4).join('/')}`
      : r.tier === 'weak-pair'
        ? `弱词+泛词组合：弱词 ${r.weakHits.join('/')}、泛词 ${r.genericHits.slice(0, 3).join('/')}`
        : r.tier === 'lexical'
          ? '与要求 bigram 高度重合（未命中完整词）'
          : `只命中范围词/无主题词（范围词：${r.scopeHits.slice(0, 3).join('/') || '无'}）`
  return {
    hit: r.relevant,
    bestScore: r.bestScore,
    chunks: r.chunks,
    matchedTerms,
    tier: r.tier,
    reason
  }
}

export interface CrawlOptions {
  fromYear: number
  toYear: number
  /** 主题关键词（用于正文粗筛；P5 会从撰写要求来）。`build` 模式不需要，可省略 */
  query?: string
  /**
   * 撰写要求**现算词表**（第一组 ③）追加的补充词：只在分层判定里"只升不降"地并入，
   * 不进 `scoreChunk` 的词法分（它是主题词/要点词/范围词三组词，不是"查询串"）。
   */
  extraTerms?: string[]
  /** 命中的文章落成该任务的来源（P5 传任务 id；`build` 模式不需要，可省略） */
  taskId?: string
  /**
   * 2026-10-06（Phase 11 B 批）：抓取**模式**。
   * - `screen`（默认）= 生成期：抓完按主题判定相关性、命中落成任务来源、写任务账本；
   * - `build` = 建立缓存：**只抓正文并写缓存**（可用正文写 `ok`、无可用正文写 `no-body` 标记），
   *   **不做主题筛选、不落任务来源、不写任务账本**（建立缓存时根本没有主题）。
   *
   * 两种模式**共用**同一套礼貌限速 / 档位 / ETA / robots / 安全白名单 / 自适应降档 / 暂停续跑，
   * 因此不存在"两套判定漂移"的风险。
   */
  mode?: 'screen' | 'build'
  /** 并发度（默认取设置档位：标准档 = 4） */
  concurrency?: number
  onProgress?: (p: WebCrawlProgress) => void
  shouldCancel?: () => boolean
  /** 测试缝：注入假抓取（默认用 Electron net 的 fetchUrl） */
  fetchImpl?: (url: string) => Promise<FetchResult>
}

/**
 * 档位 → 请求间隔与并发（用户裁定 2026-10-05：默认 `standard`）。
 * 间隔是**同站两次请求之间的最小间距**（礼貌限速的物理下限），并发只用来把"服务耗时的等待"填满。
 */
export function crawlTierParams(tier: WebCrawlTier | undefined): { intervalMs: number; concurrency: number } {
  switch (tier) {
    case 'safe':
      return { intervalMs: WEB_FETCH_MIN_INTERVAL_MS, concurrency: 2 }
    case 'fast':
      return { intervalMs: 40, concurrency: 6 }
    case 'standard':
    default:
      return { intervalMs: 60, concurrency: 4 }
  }
}

/** 简单并发池：保持"同站每请求 ≥minInterval"的礼貌间隔由调用方在任务内 await 完成 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  shouldCancel?: () => boolean,
  shouldPause?: () => boolean
): Promise<number> {
  let next = 0
  let pausedMs = 0
  const n = Math.max(1, Math.min(concurrency, items.length || 1))
  const runners = Array.from({ length: n }, async () => {
    while (true) {
      if (shouldCancel?.()) return
      // 暂停：在**取任务之前**等待（既不占限速名额、也不发请求），按钮切回「继续」后从原处接着跑
      while (shouldPause?.() && !shouldCancel?.()) {
        const t0 = Date.now()
        await new Promise((r) => setTimeout(r, 200))
        pausedMs += Date.now() - t0
      }
      if (shouldCancel?.()) return
      const i = next++
      if (i >= items.length) return
      await worker(items[i])
    }
  })
  await Promise.all(runners)
  return pausedMs
}

/**
 * 执行抓取。**同步 await 完成**（用户裁定 ②），可在任意时刻取消（已处理的状态已落库，重跑即续跑）。
 *
 * 两种模式（{@link CrawlOptions.mode}）：
 * - `screen`（生成期）：抓取 + 有效性判定 + **主题相关性粗筛** + 命中落成任务来源 + 写任务账本；
 * - `build`（建立缓存，Phase 11 B）：抓取 + 有效性判定 + **写正文缓存**（`ok` / `no-body` 标记），
 *   不做主题筛选、不落任务来源、不写任务账本。
 */
export async function crawlAndScreenArticles(opts: CrawlOptions): Promise<WebCrawlResult> {
  const started = Date.now()
  const { fromYear, toYear } = opts
  /**
   * 2026-10-06（Phase 11 B 批）：`build` = 建立缓存模式（无主题、不落来源、不写账本）。
   * 它复用本函数的**全部**抓取基础设施，只在"抓完之后做什么"上分叉。
   */
  const buildMode = (opts.mode ?? 'screen') === 'build'
  const query = opts.query ?? ''
  const taskId = opts.taskId ?? ''
  if (!buildMode && !taskId) throw new Error('抓取+筛选模式必须提供 taskId（建立缓存模式不需要）')
  /** 建立缓存模式没有任务账本，因此"本次处理多少篇"直接看区间目录 */
  const extraTerms = opts.extraTerms ?? []
  /*
   * 抓取节奏（用户裁定 2026-10-05）：默认**标准档**（间隔 60ms / 同站并发 4），设置里可切保守或快速。
   * 抓取中若出现批量失败，`AdaptiveRate` 会**自动降档**（间隔翻倍）并**重抓本轮失败的文章**；
   * **降档只影响本次运行**——下一次生成仍从设置档位开始（不记忆、不持久化），这是用户明确要求的口径。
   */
  const tier = crawlTierParams(getSettings().webCrawlTier)
  const concurrency = Math.max(1, opts.concurrency ?? tier.concurrency)
  resetFetchControl()
  /*
   * 目标 = 区间内**全部**文章（用户裁定 A：账本不再作为跳过依据，每次生成都全量重筛）。
   * 是否联网完全由 `article-body-cache`（正文缓存）决定：命中 → 本地重筛（毫秒级、零网络），未命中 → 抓取。
   */
  const allTargets = buildMode ? listUncachedRangeArticles(fromYear, toYear) : listRangeArticles(fromYear, toYear)
  /** `build` 模式不写任务账本，所以"区间内多少篇"直接取区间目录条数 */
  const rangeCount = buildMode ? { total: allTargets.length, processed: 0, failed: 0 } : countTaskFetch(taskId, fromYear, toYear)

  /*
   * 2026-10-05（安全加固）：抓取目标来自 feed / sitemap / BFS 解析出的 `<loc>` / `<link>`，属于**外部数据**——
   * 被篡改的 sitemap 可以塞进跨域地址或非 http(s) 协议（内网、metadata、file:、javascript: 等）。
   * 旧管线只有"手动添加网址"走了 `validateUrl`，抓取路径从不校验 → 这里统一按「http(s) + 该站点允许主机」过滤：
   * 不放行的**不抓取**，只记账 + 记日志（计 `blocked`，不进"未命中丢弃"的语义）。
   */
  const allowedBySite = new Map<string, string[]>()
  for (const s of listWebSites()) allowedBySite.set(s.id, allowedHostsForSite(s.rootUrl))
  const blockedTargets: TaskFetchTarget[] = []
  const targets = allTargets.filter((t) => {
    if (isAllowedTargetUrl(t.url, allowedBySite.get(t.siteId) ?? [])) return true
    blockedTargets.push(t)
    return false
  })
  for (const t of blockedTargets) {
    /*
     * 这类 URL 永远不会被允许，重跑也不该再撞（避免每次生成都重试同一批垃圾）：
     * `screen` 模式记进任务账本；`build` 模式写 `blocked` 缓存标记——**否则生成前的缓存闸门
     * 会把它们永远算作"待建立"、永远不放行**（这正是 Phase 11 决策 3A 要解决的问题）。
     */
    try {
      if (buildMode) putCacheMiss(t.siteId, t.url, 'blocked')
      else recordTaskFetch(taskId, t.siteId, t.url, { state: 'dropped', hit: false })
    } catch (err) {
      logMain('web', `跳过非法目标时记账失败（忽略）：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (blockedTargets.length > 0) {
    logMain(
      'web',
      `安全过滤：${blockedTargets.length} 篇的 URL 不在该站点的 http(s) 同域白名单内，已跳过（不抓取）；` +
        `示例：${blockedTargets.slice(0, 3).map((t) => t.url).join('、')}`
    )
  }

  // 礼貌限速：读取各站 robots（Crawl-delay 单位为秒，site-crawler 已换算成毫秒）
  const siteMeta = new Map<string, { host: string; crawlDelayMs?: number; disallow: string[]; title: string }>()
  for (const t of targets) {
    if (siteMeta.has(t.siteId)) continue
    let host = t.url
    try {
      host = new URL(t.url).host
    } catch {
      /* 非法 URL：原样使用 */
    }
    const rootUrl = `https://${host}`
    const robots = await fetchRobotsTxt(rootUrl).catch(() => ({ crawlDelayMs: undefined, disallow: [] }))
    siteMeta.set(t.siteId, { host, crawlDelayMs: robots.crawlDelayMs, disallow: robots.disallow, title: t.siteTitle })
  }
  /*
   * 请求间隔 = max(设置档位, 站点 robots 的 Crawl-delay)；自适应降档从这里起步往上走（间隔翻倍，上限 480ms）。
   * 注意：robots 的 Crawl-delay 是"站点声明的底线"，降档只会**更慢**，永远不会突破它。
   */
  const maxCrawlDelay = Math.max(...[...siteMeta.values()].map((m) => m.crawlDelayMs ?? 0), 0)
  const baseIntervalMs = Math.max(tier.intervalMs, maxCrawlDelay)
  const rate = new AdaptiveRate({ intervalMs: baseIntervalMs, maxIntervalMs: Math.max(baseIntervalMs * 8, 480) })
  let intervalMs = rate.currentIntervalMs
  const eta = new EtaEstimator({
    warmup: 20,
    window: 30,
    intervalMs,
    concurrency,
    priorMsPerArticle: WEB_FETCH_MS_PER_ARTICLE
  })

  let done = 0
  let hits = 0
  let dropped = 0
  let failed = 0
  let chars = 0
  let lastTitle = ''
  let cancelled = false
  /**
   * Phase 10 P5b：按放行层级计数（如实汇报"是谁放行的"）。
   * 2026-10-05 追加三类"有效正文"判定计数（此前 P4 管线缺失这些兜底，界面对应文案恒为 0）：
   * `invalidBody` = A1 标题探针不过（老文章失效 → 模板页）；`shortBody` / `templateRepeat` = 空标题候选兜底。
   */
  const tierCount: Record<RelevanceTier, number> = { specific: 0, 'weak-pair': 0, lexical: 0, none: 0 }
  let invalidBody = 0
  let shortBody = 0
  let templateRepeat = 0
  /** 2026-10-05：从正文缓存复用（零网络）的篇数 */
  let cacheHits = 0
  /** 2026-10-06（Phase 11 B）：本次写进正文缓存的篇数（`ok` 与 `no-body` 标记都算） */
  let cacheWritten = 0
  /** 2026-10-05 自适应降档：本轮失败的目标（降档后要**重抓一遍**）与降档说明 */
  const failedTargets: TaskFetchTarget[] = []
  const downgradeNotes: string[] = []

  const emit = (phase: WebCrawlProgress['phase']): void => {
    const snap = eta.snapshot()
    const rate = snap.msPerArticle > 0 ? 1000 / snap.msPerArticle : 0
    opts.onProgress?.({
      phase,
      total: targets.length,
      done,
      hits,
      dropped,
      failed,
      chars,
      ratePerSec: Math.round(rate * 100) / 100,
      etaSeconds: eta.etaSeconds(targets.length - done),
      provisional: snap.provisional,
      currentTitle: lastTitle,
      paused: isFetchPaused(),
      cacheHits,
      intervalMs,
      cacheWritten
    })
  }

  emit('fetching')
  logMain(
    'web',
    `网页抓取开始：区间 ${fromYear}-${toYear}，区间内 ${rangeCount.total} 篇，本次全量重筛 ${targets.length} 篇；` +
      `并发 ${concurrency}；请求间隔下限 ${intervalMs}ms` +
      (maxCrawlDelay > 0 ? `（站点声明 Crawl-delay ${maxCrawlDelay}ms）` : '') +
      `；安全过滤跳过 ${blockedTargets.length} 篇`
  )

  const pausedMs = await runPool(
    targets,
    concurrency,
    async (t: TaskFetchTarget) => {
      if (opts.shouldCancel?.() || isFetchCancelled()) {
        cancelled = true
        return
      }
      const meta = siteMeta.get(t.siteId)
      lastTitle = t.title || t.url
      let fetchMs = 0
      let processMs = 0
      try {
        if (meta && isPathDisallowed(t.url, meta.disallow)) {
          /*
           * robots 禁止的路径：`screen` 模式记账为失败（每次生成都会再试一遍，因为不再有"跳过"语义）；
           * `build` 模式写 `blocked` 标记（robots 不允许抓 = 永远建不了，不该计入缺口）。
           */
          if (buildMode) putCacheMiss(t.siteId, t.url, 'blocked')
          else recordTaskFetch(taskId, t.siteId, t.url, { state: 'failed' })
          failed++
          return
        }
        // 列表页兜底：栏目/列表页绝不当文章（与旧管线同一规则）
        if (isListPageUrl(t.url)) {
          // `build` 模式：列表页**永远不会有正文**，必须写 no-body 标记，否则它永远是"待建立"
          if (buildMode) putCacheMiss(t.siteId, t.url, 'no-body')
          else recordTaskFetch(taskId, t.siteId, t.url, { state: 'dropped', hit: false })
          dropped++
          return
        }
        /*
         * **缓存优先**（2026-10-05 用户裁定）：正文与主题无关，不该因为换了任务就重新下载。
         * 命中缓存 → 直接本地重筛（零网络、不占限速名额）；未命中 → 走礼貌限速抓取，抓完**一律写缓存**。
         */
        const doFetch = opts.fetchImpl ?? ((u: string) => fetchUrl(u))
        const p0 = Date.now()
        let res: FetchResult | null = null
        let text = ''
        let probeOk = true
        /** 页面自己声明的标题（缓存命中时为 null —— 标题只用于来源展示与相关性提示，不参与判定） */
        let extractedTitle: string | null = null
        /** 正文来源（结构化提取 / 整页回退）；缓存命中时沿用首次抓取的结论 */
        let textSource = 'extractor'
        let datePatch: { publishedDate?: string; dateSource?: string; dateConfidence?: string; httpLastModified?: string } = {}
        const cached = getCachedBody(t.siteId, t.url)
        if (cached) {
          text = cached.text
          probeOk = cached.probeOk
          textSource = cached.textSource
          cacheHits++
        } else {
          // 间隔用**当前生效值**（自适应降档后会变大）：礼貌限速必须先占位再等待
          await awaitPoliteDelay(meta?.host ?? t.url, Math.max(meta?.crawlDelayMs ?? 0, rate.currentIntervalMs))
          // **计时从"真正发出请求"开始**：礼貌等待不计入服务耗时（否则并发下样本互相污染）。
          // 请求间隔由 EtaEstimator 的 `intervalMs` 单独建模，二者相乘即墙钟每篇成本。
          const t0 = Date.now()
          try {
            res = await doFetch(t.url)
          } catch (err) {
            // 自适应降档：把失败交给控制器，由它在越线时降档（调用方随后重抓本轮失败篇）
            const msg = err instanceof Error ? err.message : String(err)
            const d = rate.record({ failed: true, errorMessage: msg })
            if (d.downgraded) {
              intervalMs = rate.currentIntervalMs
              eta.setIntervalMs(intervalMs)
              downgradeNotes.push(d.reason ?? '')
              logMain(
                'web',
                `抓取节奏自动降档（第 ${rate.downgradeCount} 次）：${d.reason} → 请求间隔 ${intervalMs}ms（本次运行有效；下次生成仍从设置档位开始）`
              )
            }
            throw err
          }
          fetchMs = Date.now() - t0
          rate.record({ failed: false })

          const extracted = extractArticle(res.rawHtml, t.url, siteMeta.get(t.siteId)?.title ?? null)
          text = extracted.text ?? ''
          extractedTitle = extracted.title
          textSource = extracted.source === 'regex' || extracted.source === 'full-page' ? 'full-page' : 'extractor'
          // A1 标题探针：带标题的候选才会被判（无标题候选走"正文过短/同站重复"兜底）
          probeOk = !t.title.trim() ? true : pageContainsArticle(res.rawHtml, text, t.title)
          // 缓存写入**已移到有效性判定之后**（2026-10-06 Phase 11 B）：要按结论写 ok / no-body，见下

          // L4/L5 日期回填：只在"原日期缺失/偏低"时补齐（L5 优先于 L4 —— 阶梯顺序；页面日期更贴发布时间）
          const needDate = !t.publishedDate || t.dateConfidence === 'low'
          if (needDate) {
            const pageDate = extracted.date ? normalizeDate(extracted.date) : null
            const httpDate = res.lastModified ? normalizeDate(res.lastModified) : null
            if (pageDate) datePatch = { publishedDate: pageDate.date, dateSource: 'page', dateConfidence: 'high' }
            else if (httpDate) datePatch = { publishedDate: httpDate.date, dateSource: 'http', dateConfidence: 'medium' }
          }
          if (res.lastModified) datePatch.httpLastModified = res.lastModified
        }
        const bodyChars = text.length
        const bodyHash = hashText(text)
        /** 本次是否**真的联网抓了**这一篇（缓存命中时不再写缓存，避免无意义地刷新 `fetched_at`） */
        const fetchedNow = cached === null

        /*
         * 2026-10-05（P0 兜底回归，见 `article-guards.ts` 的 `judgeFetchedArticle`）：有效性判定。
         * `knownProbeOk` 传缓存里记录的探针结论（缓存只存正文、不存原始 HTML，重跑探针会误杀"标题只在 `<title>` 里"的正常文章）。
         * 判定本身是纯函数（已单测）：带标题的候选走 A1 标题探针；无标题候选（sitemap）走"正文过短/同站正文重复"。
         * 丢弃时只记 dropped + 分类计数（正文不落库），并由生成汇总如实告知用户。
         */
        const duplicateUrl = t.title.trim() ? null : findSiteArticleByBodyHash(t.siteId, bodyHash, t.url)?.url ?? null
        const verdict = judgeFetchedArticle({
          candidateTitle: t.title,
          rawHtml: res?.rawHtml ?? '',
          text,
          duplicateUrl,
          knownProbeOk: probeOk
        })
        /*
         * 2026-10-06（Phase 11 B 批）：缓存写入移到**判定之后**，并按结论写对状态 ——
         * `ok` = 正文可用；`no-body` = 已尝试但没取到可用正文（老文章失效 / 模板页 / 过短）。
         * 旧实现是"抓到就按 ok 写"，于是"试过但没正文"的篇在缓存里和好篇长得一样，
         * 生成前的闸门分不出"还要建"与"永远建不了"。`putCacheMiss` 是 `ON CONFLICT DO NOTHING`，
         * 所以**绝不会**把以前抓到的好正文降级掉。
         */
        if (fetchedNow) {
          if (verdict === 'ok') putCachedBody(t.siteId, t.url, text, bodyHash, probeOk, textSource)
          else putCacheMiss(t.siteId, t.url, 'no-body')
        }
        if (verdict !== 'ok') {
          /*
           * `build` 模式（建立缓存）：日期照常回填（抓到了就顺手把 L4/L5 补上，否则下次按年份筛还是"未知"），
           * 但不写任务账本、不写站点筛选痕迹（那些是"筛选结论"，建立缓存时没有主题）。
           */
          if (buildMode) {
            if (datePatch.publishedDate || datePatch.httpLastModified) updateArticleDates(t.siteId, t.url, datePatch)
            dropped++
            if (fetchedNow) cacheWritten++ // 命中缓存时并没有写缓存
            if (verdict === 'invalidBody') invalidBody++
            else if (verdict === 'shortBody') shortBody++
            else templateRepeat++
            return
          }
          recordTaskFetch(taskId, t.siteId, t.url, {
            state: 'dropped',
            hit: false,
            bodyHash,
            bodyChars,
            publishedDate: datePatch.publishedDate ?? t.publishedDate
          })
          updateArticleFetchState(t.siteId, t.url, { state: 'dropped', bodyHash, bodyChars, screenHit: false, ...datePatch })
          dropped++
          if (verdict === 'invalidBody') invalidBody++
          else if (verdict === 'shortBody') shortBody++
          else templateRepeat++
          logMain(
            'web',
            `未取到正文（${verdict === 'invalidBody' ? '页面为模板/该文章已失效' : verdict === 'shortBody' ? `空标题候选且清洗后仅 ${text.trim().length} 字` : `空标题候选且与已抓文章正文完全相同 ${duplicateUrl}`}），` +
              `丢弃 url=${t.url}`
          )
          return
        }

        if (buildMode) {
          /*
           * 建立缓存模式到此结束：**不做主题筛选、不落任务来源、不入向量索引、不写任务账本**。
           * 语义映射：`hits` = 正文可用（缓存里有好正文）；`dropped` = 无可用正文（已写 no-body 标记）。
           * `cacheWritten` 只统计**本次真的写了缓存**的篇数（命中缓存不算）。
           */
          if (datePatch.publishedDate || datePatch.httpLastModified) updateArticleDates(t.siteId, t.url, datePatch)
          hits++
          if (fetchedNow) cacheWritten++
          return
        }

        const screen = screenArticle(text, query, extractedTitle ?? t.title ?? '', extraTerms)
        tierCount[screen.tier]++
        processMs = Date.now() - p0

        if (!screen.hit) {
          // 未命中：**本任务账本**记 dropped（正文丢弃），站点行只留诊断痕迹
          recordTaskFetch(taskId, t.siteId, t.url, {
            state: 'dropped',
            hit: false,
            bestScore: screen.bestScore,
            bodyHash: hashText(text),
            bodyChars,
            publishedDate: datePatch.publishedDate ?? t.publishedDate
          })
          updateArticleFetchState(t.siteId, t.url, {
            state: 'dropped',
            bodyHash: hashText(text),
            bodyChars,
            screenHit: false,
            ...datePatch
          })
          dropped++
          return
        }

        // 命中：落成**任务绑定的网页来源**（与旧管线一致的可溯源结构），并排队入本地向量索引
        const existing = getSourceByUrl(t.url, taskId)
        if (existing) {
          updateSourcePublishedAt(existing.id, datePatch.publishedDate ?? t.publishedDate ?? '')
        } else {
          const source: Source = {
            id: crypto.randomUUID(),
            kind: 'url',
            title: extractedTitle || t.title || t.url,
            url: t.url,
            urlSnapshotAt: res?.snapshotAt ?? new Date().toISOString(),
            publishedAt: datePatch.publishedDate ?? t.publishedDate,
            cleanedText: text,
            status: 'ready',
            taskId,
            textSource: textSource === 'full-page' ? 'full-page' : 'extractor',
            bodyMissing: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
          const inserted = insertSource(source)
          enqueueIndex(inserted.id)
          chars += bodyChars
        }
        recordTaskFetch(taskId, t.siteId, t.url, {
          state: 'fetched',
          hit: true,
          bestScore: screen.bestScore,
          bodyHash: hashText(text),
          bodyChars,
          publishedDate: datePatch.publishedDate ?? t.publishedDate
        })
        updateArticleFetchState(t.siteId, t.url, {
          state: 'fetched',
          bodyHash: hashText(text),
          bodyChars,
          screenHit: true,
          ...datePatch
        })
        hits++
      } catch (err) {
        // 失败也是一次真实的服务耗时（超时/连接失败），照常计入样本；截尾均值会压掉偶发尖峰
        if (fetchMs === 0 && processMs === 0) fetchMs = 0
        recordTaskFetch(taskId, t.siteId, t.url, { state: 'failed' })
        updateArticleFetchState(t.siteId, t.url, { state: 'failed' })
        failed++
        failedTargets.push(t)
        logMain('web', `网页抓取失败 url=${t.url}：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        done++
        eta.push({ fetchMs: Math.max(0, fetchMs), processMs: Math.max(0, processMs) })
        if (done % 5 === 0 || done === targets.length) emit(opts.shouldCancel?.() ? 'cancelled' : 'fetching')
      }
    },
    opts.shouldCancel,
    isFetchPaused
  )

  /*
   * 2026-10-05（用户要求）：若本轮因"抓太快"触发了降档，就**把本轮失败的文章重抓一遍**。
   * 有界：最多 2 个重抓轮次，且每轮之间不复位失败集合（第二轮仍失败就记 failed，交给下次生成）。
   * 只处理"确实失败"的篇（网络/超时/非 2xx），不含被判定丢弃的篇。
   */
  let retryRounds = 0
  while (downgradeNotes.length > 0 && retryRounds < 2) {
    const retryList = failedTargets.splice(0, failedTargets.length)
    if (retryList.length === 0) break
    retryRounds += 1
    logMain(
      'web',
      `降档后重抓本轮失败文章（第 ${retryRounds} 轮）：${retryList.length} 篇；当前请求间隔 ${intervalMs}ms、并发 ${concurrency}`
    )
    const beforeFailed = failed
    await runPool(
      retryList,
      concurrency,
      async (t: TaskFetchTarget) => {
        if (opts.shouldCancel?.() || isFetchCancelled()) return
        try {
          await awaitPoliteDelay(siteMeta.get(t.siteId)?.host ?? t.url, Math.max(siteMeta.get(t.siteId)?.crawlDelayMs ?? 0, intervalMs))
          const doFetch = opts.fetchImpl ?? ((u: string) => fetchUrl(u))
          const res = await doFetch(t.url)
          rate.record({ failed: false })
          const extracted = extractArticle(res.rawHtml, t.url, siteMeta.get(t.siteId)?.title ?? null)
          const text = extracted.text ?? ''
          const probeOk = !t.title.trim() ? true : pageContainsArticle(res.rawHtml, text, t.title)
          const bodyHash = hashText(text)
          const duplicateUrl = t.title.trim() ? null : findSiteArticleByBodyHash(t.siteId, bodyHash, t.url)?.url ?? null
          const verdict = judgeFetchedArticle({ candidateTitle: t.title, rawHtml: res.rawHtml, text, duplicateUrl, knownProbeOk: probeOk })
          // 与主路径**同一口径**：按判定结论写缓存（ok / no-body），且绝不降级已抓到的好正文
          if (verdict === 'ok') putCachedBody(t.siteId, t.url, text, bodyHash, probeOk)
          else putCacheMiss(t.siteId, t.url, 'no-body')
          if (verdict !== 'ok') {
            if (buildMode) {
              dropped++
              cacheWritten++
              if (verdict === 'invalidBody') invalidBody++
              else if (verdict === 'shortBody') shortBody++
              else templateRepeat++
              return
            }
            recordTaskFetch(taskId, t.siteId, t.url, { state: 'dropped', hit: false, bodyHash, bodyChars: text.length })
            dropped++
            if (verdict === 'invalidBody') invalidBody++
            else if (verdict === 'shortBody') shortBody++
            else templateRepeat++
            return
          }
          if (buildMode) {
            // 建立缓存模式：命中正文即完成（不筛选、不落来源、不写账本）
            hits++
            cacheWritten++
            failed = Math.max(0, failed - 1) // 该篇本轮已从失败转为成功
            return
          }
          const screen = screenArticle(text, query, extracted.title ?? t.title ?? '', extraTerms)
          tierCount[screen.tier]++
          if (!screen.hit) {
            recordTaskFetch(taskId, t.siteId, t.url, { state: 'dropped', hit: false, bestScore: screen.bestScore, bodyHash, bodyChars: text.length })
            dropped++
            return
          }
          const existing = getSourceByUrl(t.url, taskId)
          if (!existing) {
            const inserted = insertSource({
              id: crypto.randomUUID(),
              kind: 'url',
              title: extracted.title || t.title || t.url,
              url: t.url,
              urlSnapshotAt: res.snapshotAt,
              publishedAt: t.publishedDate,
              cleanedText: text,
              status: 'ready',
              taskId,
              textSource: res.rawHtml ? 'extractor' : 'full-page',
              bodyMissing: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            } as Source)
            enqueueIndex(inserted.id)
            chars += text.length
          }
          recordTaskFetch(taskId, t.siteId, t.url, { state: 'fetched', hit: true, bestScore: screen.bestScore, bodyHash, bodyChars: text.length })
          hits++
          failed = Math.max(0, failed - 1) // 该篇本轮已从失败转为成功
        } catch (err) {
          // 仍然失败：交给下一次生成（全量重筛时天然会再试）
          failedTargets.push(t)
          logMain('web', `重抓仍失败 url=${t.url}：${err instanceof Error ? err.message : String(err)}`)
        } finally {
          done++
          eta.push({ fetchMs: 0, processMs: 0 })
          emit('fetching')
        }
      },
      opts.shouldCancel,
      isFetchPaused
    )
    if (failed === beforeFailed) break
  }

  if (opts.shouldCancel?.() || isFetchCancelled()) cancelled = true
  emit(cancelled ? 'cancelled' : 'done')
  const elapsedMs = Date.now() - started
  if (buildMode) {
    logMain(
      'web',
      `建立缓存结束：本次处理 ${done}/${targets.length} 篇（正文可用 ${hits}、无可用正文 ${dropped}、失败 ${failed}；其中**缓存复用 ${cacheHits} 篇**未联网），` +
        `本次写入缓存 ${cacheWritten} 篇；有效正文判定：A1 标题探针不过 ${invalidBody}｜空标题正文过短 ${shortBody}｜同站正文重复 ${templateRepeat}；` +
        `安全过滤跳过 ${blockedTargets.length} 篇；` +
        (rate.downgradeCount > 0 ? `自适应降档 ${rate.downgradeCount} 次（当前间隔 ${intervalMs}ms）＋重抓 ${retryRounds} 轮；` : '') +
        (pausedMs > 0 ? `暂停累计 ${(pausedMs / 1000).toFixed(0)}s；` : '') +
        `耗时 ${(elapsedMs / 1000).toFixed(1)}s（${(elapsedMs / Math.max(1, done)).toFixed(0)}ms/篇）——建立缓存不做主题筛选、不落任务来源`
    )
  } else {
    logMain(
      'web',
      `网页抓取结束：本次处理 ${done}/${targets.length} 篇（命中 ${hits}、未命中丢弃 ${dropped}、失败 ${failed}；其中**缓存复用 ${cacheHits} 篇**未联网），` +
        `有效正文判定：A1 标题探针不过 ${invalidBody}｜空标题正文过短 ${shortBody}｜同站正文重复 ${templateRepeat}；` +
        `安全过滤跳过 ${blockedTargets.length} 篇；` +
        (rate.downgradeCount > 0 ? `自适应降档 ${rate.downgradeCount} 次（当前间隔 ${intervalMs}ms）＋重抓 ${retryRounds} 轮；` : '') +
        (pausedMs > 0 ? `暂停累计 ${(pausedMs / 1000).toFixed(0)}s；` : '') +
        `放行层级：专指词 ${tierCount.specific}｜弱词组合 ${tierCount['weak-pair']}｜bigram 兜底 ${tierCount.lexical}｜剔除 ${tierCount.none}；` +
        `落库正文 ${chars} 字，耗时 ${(elapsedMs / 1000).toFixed(1)}s（${(elapsedMs / Math.max(1, done)).toFixed(0)}ms/篇）`
    )
  }
  return {
    total: targets.length,
    done,
    hits,
    dropped,
    failed,
    chars,
    cancelled,
    elapsedMs,
    crawlDelayMs: maxCrawlDelay,
    sites: siteMeta.size,
    invalidBody,
    shortBody,
    templateRepeat,
    blocked: blockedTargets.length,
    cacheHits,
    cacheWritten,
    downgrades: rate.downgradeCount,
    pausedMs
  }
}

/** 与旧管线一致的正文字符哈希（djb2，仅用于"模板页/重复正文"判定与复筛痕迹） */
function hashText(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(16)
}

/** 页面/HTTP 日期 → 归一化（复用 article-date 的规则；单独抽出来是为了避免 here 重复导入） */
function normalizeDate(raw: string): { date: string } | null {
  const m = /(\d{4})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/.exec(raw)
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    const dt = new Date(Date.UTC(y, mo - 1, d))
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) {
      return { date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
    }
  }
  const ym = /(\d{4})\s*[-年/.]\s*(\d{1,2})/.exec(raw)
  if (ym) {
    const y = Number(ym[1])
    const mo = Number(ym[2])
    if (mo >= 1 && mo <= 12) return { date: `${y}-${String(mo).padStart(2, '0')}` }
  }
  return null
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  describe('article-crawl 抓取期正文粗筛（Phase 10 P4）', () => {
    it('keeps on-topic bodies and drops clearly unrelated ones (只按正文判断)', () => {
      const query = '高中学校设置 高中 中学 学校 新建 扩建 改建 合并 规模 招生人数 分布 长乐区'
      const onTopic =
        '长乐第六中学对照省三级达标高中评估标准进行自查自评，经主管教育部门核实确认后，向福州市教育局提出申报省三级达标高中晋级评估的申请。' +
        '该校现有高中三个年级，设计规模60个班。'
      const offTopic =
        '为提升城市品质，我区今年新建改建公厕234所，其中一类公厕12所，二类公厕80所，全部免费开放，并配备无障碍设施与第三卫生间。'
      const on = screenArticle(onTopic, query, '刚刚发布！长乐这所学校申报三级达标高中')
      const off = screenArticle(offTopic, query, '我区加快推进厕所革命，两年新建改建公厕234所')
      expect(on.hit).toBe(true)
      expect(on.tier).toBe('specific')
      expect(on.matchedTerms).toContain('高中')
      // Phase 10 P5b：**跑题文章不再放行**（此前"命中任一检索词"的宽口径会把它留下——它含范围词"长乐区"与泛词"新建/改建"）
      expect(off.hit).toBe(false)
      expect(off.tier).toBe('none')
      expect(off.reason).toContain('范围词')
    })

    it('never hits on a title alone (用户裁定：标题不能作为相关性判据)', () => {
      const query = '高中学校设置 高中 学校 长乐区'
      // 标题党：标题很像，正文完全无关
      const r = screenArticle('今日天气晴朗，适合出行。全区共有公园12个，绿地面积稳步增加。', query, '长乐将新建一所高中！')
      expect(r.matchedTerms).not.toContain('高中')
      expect(r.chunks).toBeGreaterThan(0)
      expect(r.hit).toBe(false)
    })

    it('returns no hit when the query is empty (不筛 = 不保留)', () => {
      const r = screenArticle('一些正文内容。'.repeat(20), '', '标题')
      expect(r.hit).toBe(false)
      expect(r.chunks).toBe(0)
    })
  })

  /*
   * 2026-10-05 追加：**管线级**验证（内存库 + 注入式 fetch，不联网、不调模型、不写真实库）。
   * 覆盖本次两处改动：① 抓取目标的 http(s) + 同域白名单（越权 URL 绝不发起请求）；② P0 兜底回归
   * （A1 标题探针 / 空标题正文过短 / 同站正文重复）。故意让所有目标都不"命中"（相关性未通过），
   * 于是不会走 `insertSource` + `enqueueIndex`（避免测试里启动向量索引）。
   */
  describe('article-crawl 抓取目标白名单与有效正文判定（2026-10-05）', () => {
    let db: Database.Database
    const before = () => db
    const HOST = 'https://x.gov.cn'
    const QUERY = '高中学校设置 长乐区' // 与下面所有页面的正文都无关 → 全部走"相关性未命中"

    const page = (title: string, body: string): string =>
      `<!doctype html><html><head><title>${title}</title></head><body><article>${body}</article></body></html>`

    beforeAll(() => {
      db = new Database(':memory:')
      setDb(db)
      runMigrations(db)
      db.prepare("INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t1','任务','{\"all\":true}')").run()
      db.prepare(
        "INSERT INTO web_sites (id, root_url, title, created_at, updated_at) VALUES ('s1', ?, 'X站','2026-01-01','2026-01-01')"
      ).run(`${HOST}/`)
      const ins = db.prepare(
        'INSERT INTO web_site_articles (site_id, url, title, discovered_at, published_date, date_source, date_confidence) VALUES (?,?,?,?,?,?,?)'
      )
      // A 站内正常文章（标题在页面里，正文很短 → 不命中相关性）
      ins.run('s1', `${HOST}/a.htm`, '长乐区某中学新建项目开工', '2026-01-01', '2020-05-01', 'url', 'high')
      // B 跨域（不在白名单）
      ins.run('s1', 'https://evil.example.com/b.htm', '恶意 sitemap 注入的跨域地址', '2026-01-01', '2020-05-01', 'url', 'high')
      // C 非 http(s) 协议
      ins.run('s1', 'javascript:alert(1)', '非 http 协议', '2026-01-01', '2020-05-01', 'url', 'high')
      // D 有标题但页面是通用模板页（不含该文章）
      ins.run('s1', `${HOST}/d.htm`, '长乐新添一所普通高中！将于9月开学！', '2026-01-01', '2020-05-01', 'url', 'high')
      // E 空标题（sitemap）+ 正文极短
      ins.run('s1', `${HOST}/e.htm`, '', '2026-01-01', '2020-05-01', 'url', 'high')
      // F1/F2 空标题（sitemap）+ 两份**完全相同的长正文** → 第二份应判 templateRepeat
      ins.run('s1', `${HOST}/f1.htm`, '', '2026-01-01', '2020-05-01', 'url', 'high')
      ins.run('s1', `${HOST}/f2.htm`, '', '2026-01-01', '2020-05-01', 'url', 'high')
    })
    afterAll(() => db.close())

    it('白名单外的目标不发起请求；A1 探针与空标题兜底各自记账、绝不落库', async () => {
      const fetched: string[] = []
      const longBody = '长乐新闻网 乡镇风采 部门动态 通知公告 '.repeat(20) // 约 480 字 > 200
      const bodies: Record<string, string> = {
        [`${HOST}/a.htm`]: page('长乐区某中学新建项目开工', '今天天气不错，公园里人很多。'),
        [`${HOST}/d.htm`]: page('长乐新闻网', '长乐新闻网 长乐要闻 乡镇风采 部门动态 | 读懂福州，从一朵茉莉花开始'),
        [`${HOST}/e.htm`]: page('长乐新闻网', '短正文'),
        [`${HOST}/f1.htm`]: page('长乐新闻网', longBody),
        [`${HOST}/f2.htm`]: page('长乐新闻网', longBody)
      }
      const result = await crawlAndScreenArticles({
        fromYear: 2020,
        toYear: 2020,
        query: QUERY,
        taskId: 't1',
        concurrency: 1,
        onProgress: () => undefined,
        // 注入式 fetch：只记录 + 返回固定 HTML，**绝不产生真实网络请求**
        fetchImpl: async (url: string) => {
          fetched.push(url)
          return {
            url,
            rawHtml: bodies[url] ?? page('未知', '未知内容'),
            cleanedText: '',
            snapshotAt: new Date().toISOString()
          }
        }
      })

      // ① 白名单：跨域与非 http(s) 一律不抓
      expect(fetched).not.toContain('https://evil.example.com/b.htm')
      expect(fetched).not.toContain('javascript:alert(1)')
      expect(result.blocked).toBe(2)
      // ② 站内 5 篇都抓了
      expect(fetched.sort()).toEqual(
        [`${HOST}/a.htm`, `${HOST}/d.htm`, `${HOST}/e.htm`, `${HOST}/f1.htm`, `${HOST}/f2.htm`].sort()
      )
      // ③ A1 标题探针：d 的页面不含候选标题 → invalidBody
      expect(result.invalidBody).toBe(1)
      // ④ 空标题候选：e 正文过短 → shortBody；f2 与 f1 正文逐字相同 → templateRepeat
      //    （"正文过短"只对**无标题/标题不可信**的候选生效：a 有真标题且正文很短，但仍交给相关性判定 → 计入 dropped）
      expect(result.shortBody).toBe(1)
      expect(result.templateRepeat).toBe(1)
      // ⑤ 其余（a 与 f1）通过有效正文判定，仅因相关性未命中而丢弃
      expect(result.dropped).toBe(5)
      // ⑥ 全部丢弃 → 一篇都不落库（也不触发向量索引）
      expect(result.hits).toBe(0)
      expect((before().prepare('SELECT COUNT(*) c FROM sources').get() as { c: number }).c).toBe(0)
      // ⑦ 账本：7 篇目录行全部记账（5 篇抓过 + 2 篇被白名单拦下，避免每次生成重复撞）
      expect((before().prepare('SELECT COUNT(*) c FROM task_web_fetch').get() as { c: number }).c).toBe(7)
    })
  })

  /*
   * 2026-10-06（Phase 11 B 批）：**建立缓存模式**（`mode: 'build'`）。
   * 口径：只抓正文并写缓存（可用正文 `ok`、无可用正文 `no-body`、白名单外 `blocked`），
   * **不做主题筛选、不落任务来源、不写任务账本、不写站点筛选痕迹**，但日期照常回填（L4/L5）。
   */
  describe('article-crawl 建立缓存模式（Phase 11 B：只抓不筛）', () => {
    let db: Database.Database
    const HOST = 'https://y.gov.cn'
    const page = (title: string, body: string): string =>
      `<!doctype html><html><head><title>${title}</title></head><body><article>${body}</article></body></html>`
    const count = (table: string): number => (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c

    beforeAll(() => {
      db = new Database(':memory:')
      setDb(db)
      runMigrations(db)
      db.prepare(
        "INSERT INTO web_sites (id, root_url, title, created_at, updated_at) VALUES ('s1', ?, 'Y站','2026-01-01','2026-01-01')"
      ).run(`${HOST}/`)
      const ins = db.prepare(
        'INSERT INTO web_site_articles (site_id, url, title, discovered_at, published_date, date_source, date_confidence) VALUES (?,?,?,?,?,?,?)'
      )
      // A 正常文章（标题在页面里、正文够长）；日期置信度 low → 建立缓存时应被 L4 升级
      ins.run('s1', `${HOST}/a.htm`, '某中学新建项目开工', '2026-01-01', '2021-01-01', 'url', 'low')
      // D 有标题但页面是通用模板页（不含该文章）→ invalidBody
      ins.run('s1', `${HOST}/d.htm`, '这所学校的教学楼封顶了', '2026-01-01', '2021-01-01', 'url', 'high')
      // E 空标题（sitemap）+ 正文极短 → shortBody
      ins.run('s1', `${HOST}/e.htm`, '', '2026-01-01', '2021-01-01', 'url', 'high')
      // G 跨域（不在白名单）→ blocked 标记，**不发起请求**
      ins.run('s1', 'https://evil.example.com/g.htm', '恶意 sitemap 注入', '2026-01-01', '2021-01-01', 'url', 'high')
    })
    afterAll(() => db.close())

    it('只写缓存：三态分类正确、不落来源、不写账本、不动站点筛选痕迹，日期照常回填', async () => {
      const fetched: string[] = []
      const bodies: Record<string, string> = {
        [`${HOST}/a.htm`]: page('某中学新建项目开工', '长乐区某中学新建项目开工，设计规模 36 个班。'.repeat(6)),
        [`${HOST}/d.htm`]: page('Y站首页', 'Y站 首页 要闻 公告 服务 导航 '.repeat(20)),
        [`${HOST}/e.htm`]: page('Y站首页', '短正文')
      }
      const result = await crawlAndScreenArticles({
        fromYear: 2021,
        toYear: 2021,
        // **故意不传 query / taskId**：建立缓存模式不需要主题，也不需要任务
        mode: 'build',
        concurrency: 1,
        onProgress: () => undefined,
        fetchImpl: async (url: string) => {
          fetched.push(url)
          return {
            url,
            rawHtml: bodies[url] ?? page('未知', '未知内容'),
            cleanedText: '',
            snapshotAt: new Date().toISOString(),
            lastModified: '2021-04-05'
          }
        }
      })

      // ① 白名单外**不发起请求**，但留下 blocked 标记（否则闸门永远差这几篇）
      expect(fetched).not.toContain('https://evil.example.com/g.htm')
      expect(result.blocked).toBe(1)
      expect(getCachedBody('s1', 'https://evil.example.com/g.htm')?.state).toBe('blocked')

      // ② 三篇站内都抓了
      expect(fetched.sort()).toEqual([`${HOST}/a.htm`, `${HOST}/d.htm`, `${HOST}/e.htm`].sort())
      expect(result.cacheWritten).toBe(3)
      expect(result.hits).toBe(1) // a：正文可用
      expect(result.dropped).toBe(2) // d：模板页；e：过短
      expect(result.invalidBody).toBe(1)
      expect(result.shortBody).toBe(1)

      // ③ 缓存三态：ok 存正文；no-body **不存正文**（空文本、0 字）
      const a = getCachedBody('s1', `${HOST}/a.htm`)
      expect(a?.state).toBe('ok')
      expect(a?.text).toContain('设计规模 36 个班')
      const d = getCachedBody('s1', `${HOST}/d.htm`)
      expect(d?.state).toBe('no-body')
      expect(d?.text).toBe('')
      expect(d?.bodyChars).toBe(0)
      expect(getCachedBody('s1', `${HOST}/e.htm`)?.state).toBe('no-body')

      // ④ **绝不**落任务来源、**绝不**写任务账本（建立缓存没有任务）
      expect(count('sources')).toBe(0)
      expect(count('task_web_fetch')).toBe(0)

      // ⑤ 站点筛选痕迹不动（fetch_state / screen_hit 保持为空），但日期照常升级（low → medium）
      const row = db
        .prepare('SELECT fetch_state, screen_hit, published_date, date_confidence FROM web_site_articles WHERE site_id = ? AND url = ?')
        .get('s1', `${HOST}/a.htm`) as {
        fetch_state: string | null
        screen_hit: number | null
        published_date: string | null
        date_confidence: string | null
      }
      expect(row.fetch_state).toBeNull()
      expect(row.screen_hit).toBeNull()
      expect(row.published_date).toBe('2021-04-05')
      expect(row.date_confidence).toBe('medium')
    })

    it('第二次建立：已建立的**根本不进队列** → 零网络、零写入、零判定（幂等）', async () => {
      const fetched: string[] = []
      const result = await crawlAndScreenArticles({
        fromYear: 2021,
        toYear: 2021,
        mode: 'build',
        concurrency: 1,
        onProgress: () => undefined,
        fetchImpl: async (url: string) => {
          fetched.push(url)
          throw new Error('不应该联网：缓存应已命中')
        }
      })
      expect(fetched).toEqual([])
      /*
       * Phase 11 C 起：build 模式的目标来自 `listUncachedRangeArticles`（**只取没有缓存行的**），
       * 所以第二次建立连"逐篇判定"都不做——`total` 直接是 0。这比"取全区间再靠缓存命中跳过"更省，
       * 也让进度条的"总数"等于真正要干活的篇数（真实库 50,825 而不是目录 61,701）。
       * 界面上"已建立的不重复建立"由引擎用只读规划如实汇报（`alreadyBuilt`），见 cache-build.ts。
       */
      expect(result.total).toBe(0)
      expect(result.done).toBe(0)
      expect(result.cacheWritten).toBe(0)
      expect(result.hits).toBe(0)
      expect(result.dropped).toBe(0)
    })
  })
}
