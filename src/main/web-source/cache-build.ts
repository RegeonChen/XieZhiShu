/**
 * cache-build.ts —— 「建立缓存与索引」的**编排引擎**（Phase 11 C，2026-10-06 用户需求）。
 *
 * 它把两件事编排成一次「建立」：
 * ① **网页正文缓存**：调 `crawlAndScreenArticles({ mode: 'build' })`——只抓正文并写缓存，
 *    不做主题筛选、不落任务来源、不写任务账本（建立缓存时没有主题）。**已建立的自动跳过**
 *    （目标来自 `listUncachedRangeArticles`，所以进度条上的 `total` 就是"真正要干活的篇数"）。
 * ② **本地资料库索引**：直接复用既有的 rag 串行队列（`requeuePendingIndexes`），
 *    与抓取**并行**跑（网络 vs CPU，不互相抢资源），进度由队列自己持久化（可跨重启续跑）。
 *
 * 三条硬约束（都来自用户裁定，不要改）：
 * - **只增不减**：本引擎只写缓存与索引，**绝不删**目录 / `sources` / 账本；
 * - **幂等**：中断、关软件、再点「建立」都只是"把还没建的接着建"；
 * - **不花 LLM 额度**：嵌入是本地模型；LLM 摘要（`source_summaries`）只在用户手动点「整理资料库」时才跑。
 *
 * ⚠ 已知限制（如实记录）：抓取池是**全局单例**（`fetch-control` 的取消开关、礼貌限速状态都在模块级），
 * 因此**同一时刻只能有一个抓取在跑**。本引擎会拒绝"已在建立中"的重复启动；若用户在生成汇编的**同时**
 * 点「建立」，两条抓取会互相干扰——Phase E（生成前闸门）会保证不会走到那种状态。
 */
import { getIndexStatus, getQueueSize, getRebuildProgress, requeuePendingIndexes } from '../rag/indexer'
import Database from 'better-sqlite3'
import { setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { putCachedBody, putCacheMiss, sweepOrphanBodyCaches } from '../db/article-body-cache'
import { getTaskById } from '../db/tasks'
import { getSettings } from '../db/settings'
import { logMain } from '../logger'
import { crawlAndScreenArticles } from './article-crawl'
import { requestFetchCancel } from './fetch-control'
import { syncAllSitesTracked } from './site-sync'
import type { DiscoveryReport } from './site-crawler'
import {
  DEFAULT_BUILD_FROM_YEAR,
  DEFAULT_BUILD_TO_YEAR,
  buildCacheBuildPlan,
  decideReadiness,
  normalizeYearRange,
  readLocalBuildPlan
} from './cache-build-plan'
import type {
  BuildNotReadyReason,
  CacheBuildStartRes,
  CacheBuildStatus,
  CacheBuildWebProgress,
  CompilationReadiness,
  WebBuildPlan
} from '../../shared/types'

const WEB_ZERO: CacheBuildWebProgress = {
  total: 0,
  done: 0,
  hits: 0,
  dropped: 0,
  failed: 0,
  cacheWritten: 0,
  cacheHits: 0,
  ratePerSec: 0,
  etaSeconds: 0
}

/** 本地索引部分的"空值"（模块刚加载、或数据库尚不可用时用它） */
function emptyLocal(): CacheBuildStatus['local'] {
  return { total: 0, ready: 0, pending: 0, indexing: 0, failed: 0, bodyMissing: 0, queued: 0, percent: 0, active: false }
}

/**
 * 本地索引部分**实时**取自 rag 队列（不另存一份，避免出现两个真相）。
 * ⚠ 必须容忍"数据库/引擎还不可用"：本模块会在 IPC 文件被 import 时加载，
 * **模块级初始化绝不允许碰数据库**（否则在 Electron 之外（单测）直接崩，且真实启动早期也可能撞上）。
 */
function localSnapshot(): CacheBuildStatus['local'] {
  try {
    const s = getIndexStatus()
    const r = getRebuildProgress()
    return {
      total: s.total,
      ready: s.ready,
      pending: s.pending,
      indexing: s.indexing,
      failed: s.failed,
      bodyMissing: s.bodyMissing ?? 0,
      queued: getQueueSize(),
      percent: r.percent,
      active: r.active
    }
  } catch {
    return emptyLocal()
  }
}

let state: CacheBuildStatus = {
  running: false,
  phase: 'idle',
  startedAt: null,
  finishedAt: null,
  fromYear: DEFAULT_BUILD_FROM_YEAR,
  toYear: DEFAULT_BUILD_TO_YEAR,
  plannedPending: 0,
  alreadyBuilt: 0,
  sync: { siteIndex: 0, siteTotal: 0, currentSite: '', added: 0, failed: 0 },
  web: { ...WEB_ZERO },
  local: emptyLocal(),
  message: ''
}

/** 「停止」用独立开关（不依赖全局抓取取消开关，避免和生成期的抓取互相影响） */
let stopRequested = false

export interface CacheBuildDeps {
  /** 测试缝：注入假抓取（默认走真实抓取管线，`mode: 'build'`） */
  crawl?: typeof crawlAndScreenArticles
  /** 测试缝：注入假本地索引重建（默认 `requeuePendingIndexes(true)`） */
  startLocalIndex?: () => { queued: number; reset: number }
  /**
   * 测试缝：注入假站点清单同步（默认同步**所有**注册站点，见 `site-sync.ts`）。
   * 单测**必须**注入它——否则会走真实同步去请求站点。
   */
  syncAll?: (opts: {
    /** 目标年份区间（Phase 11 H）：发现器据此优先走"还没发现任何文章的年份"相关页面 */
    fromYear?: number
    toYear?: number
    shouldCancel?: () => boolean
    onSite?: (p: { index: number; total: number; site: { id: string; rootUrl: string; title?: string } }) => void
  }) => Promise<{
    added: number
    failed: number
    notAttempted: number
    outcomes: { siteId: string; rootUrl: string; title?: string; added: number; error?: string; report?: DiscoveryReport }[]
  }>
}

/** 当前状态（界面按 1.5s 轮询；`local` 每次实时取，因此本地索引跑完/被打断都能立刻反映） */
export function getCacheBuildStatus(): CacheBuildStatus {
  return { ...state, web: { ...state.web }, local: localSnapshot() }
}

/** 是否正在建立（Phase E 的生成前闸门会用它，避免"边生成边建立"两条抓取互相干扰） */
export function isCacheBuildRunning(): boolean {
  return state.running
}

/**
 * 执行一次建立（**同步 await 到结束**，由调用方决定是否 fire-and-forget）。
 * 年份非法直接抛错（调用方应先校验并如实报错，**不要静默回退默认区间**）。
 */
export async function runCacheBuild(
  req: { fromYear?: number; toYear?: number; includeLocal?: boolean } = {},
  deps: CacheBuildDeps = {}
): Promise<CacheBuildStartRes> {
  if (state.running) {
    return { started: false, message: '已在建立中：不会重复建立，已建立的会自动跳过。', status: getCacheBuildStatus() }
  }
  const range = normalizeYearRange(req.fromYear, req.toYear)
  if (!range) throw new Error('年份区间无效：起止年份必须是整数、且起始不晚于结束（1900–2100）')
  const { fromYear, toYear } = range

  stopRequested = false
  state = {
    running: true,
    phase: 'syncing',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    fromYear,
    toYear,
    plannedPending: 0,
    alreadyBuilt: 0,
    sync: { siteIndex: 0, siteTotal: 0, currentSite: '', added: 0, failed: 0 },
    web: { ...WEB_ZERO },
    local: localSnapshot(),
    message: '正在同步站点清单（发现各站点有哪些文章）…'
  }
  /*
   * ⓪ 先**同步站点清单**（Phase 11 G，2026-10-06 用户实测反馈）。
   *
   * 为什么必须在最前面：站点里"有哪些文章"只有同步过才知道（`syncSite`：feed → sitemap → BFS 列表页
   * 写进 `web_site_articles`），而**注册站点并不触发同步**。不先同步的话，新注册的站点在目录里 0 条，
   * 下面的规划与抓取**完全看不到它**——用户会以为软件只认某一个站点。
   * 同步放在规划**之前**，所以"本次要建 N 篇"里会**立刻包含**新发现的文章。
   * 单站失败不中断（如实记数）；用户按「停止」时在站点之间生效（当前站点的同步没有取消通道）。
   */
  let syncFailed = 0
  let syncAdded = 0
  try {
    const syncAll = deps.syncAll ?? syncAllSitesTracked
    const syncRes = await syncAll({
      fromYear,
      toYear,
      shouldCancel: () => stopRequested,
      onSite: ({ index, total, site }) => {
        state.sync = { siteIndex: index, siteTotal: total, currentSite: site.rootUrl, added: syncAdded, failed: syncFailed }
        state.message = `正在同步站点清单（${index}/${total}：${site.title || site.rootUrl}）…`
      }
    })
    syncAdded = syncRes.added
    syncFailed = syncRes.failed
    /*
     * Phase 11 H：把**最后一个站点的实测发现规模**如实摆出来（走了多少页/层、为什么停）。
     * 页/层数不再由人预设，用户需要的正是这个"算法测出来的结果"。
     */
    const last = syncRes.outcomes[syncRes.outcomes.length - 1]
    const lastSummary = last?.report
      ? `${last.title || last.rootUrl}：走 ${last.report.pagesFetched} 页 / ${last.report.maxDepthReached} 层，发现 ${last.report.discovered} 篇（新增 ${last.added} 篇），${last.report.stopText}`
      : undefined
    state.sync = {
      siteIndex: syncRes.outcomes.length,
      siteTotal: syncRes.outcomes.length + syncRes.notAttempted,
      currentSite: '',
      added: syncAdded,
      failed: syncFailed,
      ...(lastSummary ? { lastSummary } : {})
    }
  } catch (err) {
    // 同步整体异常也不能阻断建立（目录保持原样，按已有清单继续）
    logMain('web', `建立缓存：站点清单同步异常（继续按已有清单建立）：${err instanceof Error ? err.message : String(err)}`)
  }

  /*
   * 再取一次**只读规划**：它给出"本次要建几篇 / 已经建好几篇（直接跳过）"。
   * 这两个数必须**如实**报给用户（需求 ③：已建立的不重复建立），而且进度条的"总数"应当是
   * "要干活的篇数"（真实库 2005–2025 是 50,825，而不是目录的 61,701）。
   * 规划失败不能阻断建立（尽力而为），失败时两个数记 0。
   */
  let plannedPending = 0
  let alreadyBuilt = 0
  try {
    const plan = buildCacheBuildPlan({ fromYear, toYear })
    plannedPending = plan.web.pending
    alreadyBuilt = plan.web.total - plan.web.pending
  } catch (err) {
    logMain('web', `建立缓存：只读规划失败（不影响建立）：${err instanceof Error ? err.message : String(err)}`)
  }
  state.phase = 'web'
  state.plannedPending = plannedPending
  state.alreadyBuilt = alreadyBuilt
  state.web = { ...WEB_ZERO, total: plannedPending }
  state.local = localSnapshot()
  state.message = `正在建立网页正文缓存（区间 ${fromYear}–${toYear}）：本次要建 ${plannedPending} 篇，已有 ${alreadyBuilt} 篇直接跳过…`
  logMain(
    'web',
    `建立缓存开始：区间 ${fromYear}–${toYear}；站点清单同步新增 ${syncAdded} 篇${syncFailed > 0 ? `（${syncFailed} 个站点同步失败）` : ''}；本次要建 ${plannedPending} 篇，已有 ${alreadyBuilt} 篇（含"试过但没正文"与"越权地址"标记）直接跳过，不重复建立`
  )
  /*
   * Phase 11 F：顺手清扫孤儿缓存（目录里已经没有对应条目的缓存行）。
   * 正常是 0 条（Migration 051 的触发器 + 站点级联已经保证），所以只在**真清到东西**时记一条日志——
   * 不刷无意义的日志，也不让用户看到"0 条"这种噪声。
   */
  try {
    const swept = sweepOrphanBodyCaches()
    if (swept > 0) logMain('web', `建立缓存：清扫孤儿缓存 ${swept} 条（目录里已无对应条目）`)
  } catch (err) {
    logMain('web', `建立缓存：孤儿缓存清扫失败（不影响建立）：${err instanceof Error ? err.message : String(err)}`)
  }

  const crawl = deps.crawl ?? crawlAndScreenArticles
  try {
    /*
     * ① 本地索引：**先排队**（它自己后台串行跑，与下面的网络抓取并行）。
     * `requeuePendingIndexes(true)` = 重置失败标记 + 把所有未索引的排队；已索引的不会被重做。
     */
    if (req.includeLocal !== false) {
      const start = deps.startLocalIndex ?? ((): { queued: number; reset: number } => requeuePendingIndexes(true))
      const res = start()
      if (res.queued > 0 || res.reset > 0) {
        logMain('rag', `建立缓存：本地索引重置失败 ${res.reset} 篇、排队 ${res.queued} 篇（与网页抓取并行）`)
      } else {
        logMain('rag', '建立缓存：本地索引无需建立（全部已就绪）')
      }
    }

    // ② 网页正文缓存
    const res = await crawl({
      fromYear,
      toYear,
      mode: 'build',
      shouldCancel: () => stopRequested,
      onProgress: (p) => {
        state.web = {
          total: p.total,
          done: p.done,
          hits: p.hits,
          dropped: p.dropped,
          failed: p.failed,
          cacheWritten: p.cacheWritten ?? 0,
          cacheHits: p.cacheHits ?? 0,
          ratePerSec: p.ratePerSec,
          etaSeconds: p.etaSeconds,
          intervalMs: p.intervalMs,
          paused: p.paused,
          currentTitle: p.currentTitle
        }
      }
    })

    state.phase = res.cancelled ? 'cancelled' : 'done'
    /*
     * ⚠ 收尾必须用**最终结果**覆盖进度快照：进度是"每 5 篇 emit 一次"，最后一次 emit 会落后
     * 最多 4 篇（真实库 5 万篇时更明显），拿它当结论会让界面上的数字与日志不一致。
     */
    state.web = {
      ...state.web,
      total: res.total,
      done: res.done,
      hits: res.hits,
      dropped: res.dropped,
      failed: res.failed,
      cacheWritten: res.cacheWritten ?? state.web.cacheWritten,
      cacheHits: res.cacheHits ?? state.web.cacheHits,
      paused: false,
      etaSeconds: 0
    }
    const parts = [
      `已建立 ${res.cacheWritten} 篇正文缓存（正文可用 ${res.hits} / 无可用正文 ${res.dropped}：失效页、模板页或过短）`,
      `已有缓存跳过 ${state.alreadyBuilt} 篇（未联网、未重复建立）`
    ]
    if (res.blocked && res.blocked > 0) parts.push(`白名单外跳过 ${res.blocked} 篇（已标记，不计入缺口）`)
    // 注意：这条 message 会**原样显示在设置页**（纯文本，不走 Markdown 渲染）→ 不要写 markdown 记号
    if (res.failed > 0) parts.push(`${res.failed} 篇抓取失败、未写入缓存——可再点「建立」重试`)
    if (res.cancelled) parts.push('（已按你的要求停止；已抓到的都已写入缓存）')
    state.message = parts.join('；')
    logMain('web', `建立缓存结束：${state.message}`)
  } catch (err) {
    state.phase = 'failed'
    state.message = `建立失败：${err instanceof Error ? err.message : String(err)}`
    logMain('web', `建立缓存异常：${state.message}`)
  } finally {
    state.running = false
    state.finishedAt = new Date().toISOString()
    state.local = localSnapshot()
  }
  return { started: true, message: state.message, status: getCacheBuildStatus() }
}

/** 请求停止（只停止"抓新的"，已抓到的都已写入缓存） */
export function requestCacheBuildStop(): boolean {
  if (!state.running) return false
  stopRequested = true
  // 同时置全局抓取取消开关：抓取池在 await 中也能尽快退出（下一次抓取开始时会被 reset）
  requestFetchCancel()
  state.message = '已请求停止：不再抓取新文章（已抓到的都已写入缓存）。'
  logMain('web', '建立缓存：用户请求停止')
  return true
}

/**
 * 生成前的**就绪检查**（Phase 11 E，用户需求 ②；严格阻断、无逃生门＝决策 1A）。
 *
 * 口径全部沿用只读规划（决策 2A：**逐篇判定**这一篇有没有缓存，**不比较区间大小**）：
 * - 年份区间取**该次生成真正会用的那一组**（任务优先、回退全局默认），与
 *   `compilation-service` 里 `task.webYearFrom ?? getSettings().webYearFrom` **同一表达式**——
 *   两者都没有时，生成期**根本不抓网页**，网页侧就不构成缺口；
 * - `no-body` / `blocked` 标记不算缺口（否则失效链接会让闸门永远不放行）；
 * - 本地侧排除 `body_missing = 1`；索引失败**也算未就绪**（重建即可恢复）；
 * - 正在建立缓存与索引时**也不放行**：抓取池是全局单例，两条抓取会互相干扰。
 *
 * **只读**：不写库、不抓网页、不调模型。本函数是生成前闸门的**唯一真相**（界面与主进程都用它）。
 */
export function checkCompilationReadiness(taskId: string): CompilationReadiness {
  const task = getTaskById(taskId)
  const settings = getSettings()
  const fromYear = task?.webYearFrom ?? settings.webYearFrom ?? null
  const toYear = task?.webYearTo ?? settings.webYearTo ?? null
  const buildRunning = isCacheBuildRunning()

  const local = readLocalBuildPlan()
  const hasRange = fromYear != null && toYear != null
  // 有区间才算网页侧的账；没区间时生成期不抓网页，网页侧一律记 0（不是"已建齐"，是"用不上"）
  const web: WebBuildPlan = hasRange
    ? buildCacheBuildPlan({ fromYear, toYear }).web
    : { fromYear: fromYear ?? 0, toYear: toYear ?? 0, total: 0, cached: 0, noBody: 0, blocked: 0, pending: 0, byYear: [], estimatedMinutes: 0, undatedArticles: 0 }

  const decision = decideReadiness(web, local)
  const reasons: BuildNotReadyReason[] = buildRunning ? ['build-running', ...decision.reasons] : decision.reasons
  return {
    ready: decision.ready && !buildRunning,
    reasons,
    fromYear,
    toYear,
    webPending: web.pending,
    webCached: web.cached + web.noBody + web.blocked,
    webBlocked: web.blocked,
    webUndated: web.undatedArticles,
    localPending: local.pending,
    localIndexing: local.indexing,
    localFailed: local.failed,
    buildRunning,
    estimatedMinutes: web.estimatedMinutes
  }
}

/** 未就绪时给用户的一句话（主进程拒绝生成时的 `error.message`，界面也有自己的富提示框） */
export function describeReadiness(r: CompilationReadiness): string {
  if (r.ready) return '缓存与索引已建立齐，可以生成。'
  const parts: string[] = []
  if (r.reasons.includes('build-running')) parts.push('正在「建立缓存与索引」（抓取池同一时刻只能跑一个，等它结束再生成）')
  if (r.reasons.includes('web-pending')) {
    parts.push(
      `网页资料还有 ${r.webPending} 篇没有建立缓存（年份 ${r.fromYear ?? '?'}–${r.toYear ?? '?'}，建立预计约 ${r.estimatedMinutes} 分钟）`
    )
  }
  if (r.reasons.includes('local-pending')) parts.push(`本地资料库还有 ${r.localPending} 篇没有建立索引`)
  if (r.reasons.includes('local-index-failed')) parts.push(`本地资料库有 ${r.localFailed} 篇索引失败（重新建立可恢复）`)
  return `还不能生成汇编：${parts.join('；')}。请到「设置 → 建立缓存与索引」点「建立」，建完再来生成。`
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
    // 目录：2020 年 3 篇（其中 1 篇已有缓存 → 本次应报"要建 2 篇、跳过 1 篇"）
    db.prepare(
      "INSERT INTO web_sites (id, root_url, title, created_at, updated_at) VALUES ('s1','https://x.gov.cn','X站','2026-01-01','2026-01-01')"
    ).run()
    const art = db.prepare(
      'INSERT INTO web_site_articles (site_id, url, title, discovered_at, published_date) VALUES (?,?,?,?,?)'
    )
    art.run('s1', 'https://x.gov.cn/a.htm', 'A', '2026-01-01', '2020-05-01')
    art.run('s1', 'https://x.gov.cn/b.htm', 'B', '2026-01-01', '2020-06-01')
    art.run('s1', 'https://x.gov.cn/c.htm', 'C', '2026-01-01', '2020-07-01')
    putCachedBody('s1', 'https://x.gov.cn/a.htm', '某中学新建项目开工。', 'h-a')
  })
  afterAll(() => db.close())

  /** 假抓取结果（只填断言用到的字段） */
  const fakeResult = (over: Record<string, unknown> = {}): Awaited<ReturnType<typeof crawlAndScreenArticles>> =>
    ({
      total: 10,
      done: 10,
      hits: 7,
      dropped: 2,
      failed: 1,
      chars: 0,
      cancelled: false,
      elapsedMs: 1000,
      cacheWritten: 9,
      cacheHits: 0,
      ...over
    }) as Awaited<ReturnType<typeof crawlAndScreenArticles>>

  /**
   * 假站点清单同步（Phase 11 G）：**单测绝不能走真实同步**（那会去请求站点）。
   * 默认"什么都没发现"；需要模拟"同步发现了新文章"时，在测试里自己注入 `syncAll`。
   */
  const fakeSync = (res: { added?: number; failed?: number } = {}) => async (): Promise<{
    added: number
    failed: number
    notAttempted: number
    outcomes: { siteId: string; rootUrl: string; title?: string; added: number; error?: string }[]
  }> => ({ added: res.added ?? 0, failed: res.failed ?? 0, notAttempted: 0, outcomes: [] })

  describe('cache-build 建立引擎（Phase 11 C）', () => {
    /*
     * Phase 11 G（用户实测反馈）：**建立必须先把站点清单同步进来**——否则新注册的站点
     * （目录 0 条）在建立里完全不可见。这条测试同时锁住"同步在规划**之前**"这个顺序：
     * 假同步在过程中插入一条 2019 年目录行，规划（同步之后算）必须把它算进"本次要建"。
     * 用 2019 区间与既有夹具（2020 年）互不干扰，结束时删掉自己插的那一行。
     */
    it('先同步站点清单再算计划：同步新发现的文章必须计入"本次要建"', async () => {
      let synced = false
      const res = await runCacheBuild(
        { fromYear: 2019, toYear: 2019, includeLocal: false },
        {
          syncAll: async (opts) => {
            opts.onSite?.({ index: 1, total: 1, site: { id: 's1', rootUrl: 'https://x.gov.cn', title: 'X站' } })
            synced = true
            db.prepare(
              'INSERT INTO web_site_articles (site_id, url, title, discovered_at, published_date) VALUES (?,?,?,?,?)'
            ).run('s1', 'https://x.gov.cn/new-by-sync.htm', '同步新发现', '2026-10-06', '2019-09-01')
            return { added: 1, failed: 0, notAttempted: 0, outcomes: [{ siteId: 's1', rootUrl: 'https://x.gov.cn', title: 'X站', added: 1 }] }
          },
          crawl: async () => fakeResult()
        }
      )
      try {
        expect(synced).toBe(true)
        expect(res.status.plannedPending).toBe(1)
        expect(res.status.alreadyBuilt).toBe(0)
        expect(res.status.sync.added).toBe(1)
        expect(res.status.sync.siteIndex).toBe(1)
        expect(res.status.sync.failed).toBe(0)
      } finally {
        db.prepare("DELETE FROM web_site_articles WHERE url = 'https://x.gov.cn/new-by-sync.htm'").run()
      }
    })

    it('年份非法时抛错（不静默回退默认区间）', async () => {
      await expect(
        runCacheBuild({ fromYear: 2025, toYear: 2005 }, { crawl: async () => fakeResult(), syncAll: fakeSync() })
      ).rejects.toThrow(/年份区间无效/)
    })

    it('成功后：状态转为 done、网页计数落到状态里、本地索引被触发一次', async () => {
      let localCalls = 0
      const res = await runCacheBuild(
        { fromYear: 2020, toYear: 2021 },
        {
          crawl: async (opts) => {
            expect(opts.mode).toBe('build')
            expect(opts.taskId).toBeUndefined()
            // 建立模式不该带主题
            expect(opts.query).toBeUndefined()
            opts.onProgress?.({ phase: 'fetching', total: 10, done: 3, hits: 2, dropped: 1, failed: 0, chars: 0, ratePerSec: 7, etaSeconds: 42, provisional: false, cacheWritten: 3, cacheHits: 0 })
            return fakeResult()
          },
          startLocalIndex: () => {
            localCalls += 1
            return { queued: 0, reset: 0 }
          },
          syncAll: fakeSync()
        }
      )
      expect(res.started).toBe(true)
      expect(res.status.running).toBe(false)
      expect(res.status.phase).toBe('done')
      expect(res.status.fromYear).toBe(2020)
      expect(res.status.web.cacheWritten).toBe(9)
      expect(res.status.web.hits).toBe(7)
      expect(res.status.web.dropped).toBe(2)
      // 只读规划给出的"要建 / 已跳过"（需求 ③：已建立的不重复建立，要如实说）
      expect(res.status.plannedPending).toBe(2)
      expect(res.status.alreadyBuilt).toBe(1)
      // 失败篇必须如实说"可再点建立重试"
      expect(res.status.message).toContain('已建立 9 篇')
      expect(res.status.message).toContain('1 篇抓取失败')
      expect(localCalls).toBe(1)
      expect(res.status.finishedAt).not.toBeNull()
    })

    it('includeLocal=false 时不动本地索引；取消时状态为 cancelled 且文案如实说明', async () => {
      let localCalls = 0
      const res = await runCacheBuild(
        { fromYear: 2020, toYear: 2021, includeLocal: false },
        {
          crawl: async () => fakeResult({ cancelled: true, failed: 0 }),
          startLocalIndex: () => {
            localCalls += 1
            return { queued: 5, reset: 1 }
          },
          syncAll: fakeSync()
        }
      )
      expect(localCalls).toBe(0)
      expect(res.status.phase).toBe('cancelled')
      expect(res.status.message).toContain('已按你的要求停止')
    })

    it('抓取抛错时状态为 failed 且给出原因（不让异常静默）', async () => {
      const res = await runCacheBuild(
        { fromYear: 2020, toYear: 2021, includeLocal: false },
        {
          crawl: async () => {
            throw new Error('模拟抓取崩溃')
          },
          syncAll: fakeSync()
        }
      )
      expect(res.status.phase).toBe('failed')
      expect(res.status.message).toContain('模拟抓取崩溃')
      expect(res.status.running).toBe(false)
    })

    it('已在建立中：第二次启动被拒绝（不重复建立）', async () => {
      let release: () => void = () => undefined
      const gate = new Promise<void>((r) => {
        release = r
      })
      const first = runCacheBuild(
        { fromYear: 2020, toYear: 2021, includeLocal: false },
        {
          crawl: async () => {
            await gate
            return fakeResult()
          },
          syncAll: fakeSync()
        }
      )
      // 让第一个建立先进入 running 状态
      await new Promise((r) => setTimeout(r, 0))
      expect(isCacheBuildRunning()).toBe(true)
      const second = await runCacheBuild(
        { fromYear: 2022, toYear: 2022, includeLocal: false },
        { crawl: async () => fakeResult(), syncAll: fakeSync() }
      )
      expect(second.started).toBe(false)
      expect(second.message).toContain('已在建立中')
      release()
      const done = await first
      expect(done.status.phase).toBe('done')
      expect(isCacheBuildRunning()).toBe(false)
    })

    it('请求停止会把 shouldCancel 置为真（交给抓取池在取下一篇之前退出）', async () => {
      let sawCancel = false
      let release: () => void = () => undefined
      const gate = new Promise<void>((r) => {
        release = r
      })
      const first = runCacheBuild(
        { fromYear: 2020, toYear: 2021, includeLocal: false },
        {
          crawl: async (opts) => {
            // 等测试先按下"停止"，再检查取消标志（避免两个 setTimeout 的先后竞态）
            await gate
            sawCancel = opts.shouldCancel?.() === true
            return fakeResult({ cancelled: sawCancel })
          },
          syncAll: fakeSync()
        }
      )
      await new Promise((r) => setTimeout(r, 0))
      expect(requestCacheBuildStop()).toBe(true)
      release()
      const res = await first
      expect(sawCancel).toBe(true)
      expect(res.status.phase).toBe('cancelled')
      // 没在跑时再点停止 → false（界面据此不显示"停止"）
      expect(requestCacheBuildStop()).toBe(false)
    })

    /*
     * 生成前就绪检查（Phase 11 E，用户需求 ②）——**闸门的唯一真相**，所以单测要覆盖：
     * 待建立 → 阻断；建齐 → 放行；任务没设年份（生成期不抓网页）→ 网页侧不构成缺口；
     * 正在建立 → 也阻断（抓取池是全局单例）。
     */
    it('就绪检查：区间内有未建立的文章 → 未就绪（并给出来源年份与"不算缺口"的三态）', () => {
      db.prepare("DELETE FROM web_article_body").run()
      db.prepare("INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t1','任务一','{\"all\":true}')").run()
      db.prepare('UPDATE writing_tasks SET web_year_from = 2020, web_year_to = 2020 WHERE id = ?').run('t1')
      putCachedBody('s1', 'https://x.gov.cn/a.htm', '某中学新建项目开工。', 'h-a')
      putCacheMiss('s1', 'https://x.gov.cn/b.htm', 'no-body')

      const r = checkCompilationReadiness('t1')
      expect(r.ready).toBe(false)
      expect(r.reasons).toEqual(['web-pending'])
      expect(r.fromYear).toBe(2020)
      expect(r.toYear).toBe(2020)
      // b 已"试过但没正文"、a 已建好 → 都不算缺口；只剩 c 待建立
      expect(r.webPending).toBe(1)
      expect(r.webCached).toBe(2)
      expect(r.estimatedMinutes).toBeGreaterThanOrEqual(0)
      // 文案必须给出去处（界面据此指引用户）
      expect(describeReadiness(r)).toContain('建立缓存与索引')
      expect(describeReadiness(r)).toContain('1 篇')
    })

    it('就绪检查：把剩下的也建好 → 放行（本地资料库为空则本地侧无缺口）', () => {
      putCachedBody('s1', 'https://x.gov.cn/c.htm', '某小学教学楼落成。', 'h-c')
      const r = checkCompilationReadiness('t1')
      expect(r.webPending).toBe(0)
      expect(r.webCached).toBe(3)
      expect(r.ready).toBe(true)
      expect(r.reasons).toEqual([])
      expect(describeReadiness(r)).toContain('可以生成')
    })

    it('就绪检查：任务与全局都没设年份 → 生成期不抓网页，网页侧不构成缺口', () => {
      db.prepare('UPDATE writing_tasks SET web_year_from = NULL, web_year_to = NULL WHERE id = ?').run('t1')
      const r = checkCompilationReadiness('t1')
      expect(r.fromYear).toBeNull()
      expect(r.toYear).toBeNull()
      expect(r.webPending).toBe(0)
      expect(r.ready).toBe(true)
    })

    it('就绪检查：正在建立缓存与索引 → 也阻断（抓取池同一时刻只能跑一个）', async () => {
      db.prepare('UPDATE writing_tasks SET web_year_from = 2020, web_year_to = 2020 WHERE id = ?').run('t1')
      let release: () => void = () => undefined
      const gate = new Promise<void>((r) => {
        release = r
      })
      const first = runCacheBuild(
        { fromYear: 2020, toYear: 2020, includeLocal: false },
        {
          crawl: async () => {
            await gate
            return fakeResult()
          }
        }
      )
      await new Promise((r) => setTimeout(r, 0))
      const r = checkCompilationReadiness('t1')
      expect(r.buildRunning).toBe(true)
      expect(r.ready).toBe(false)
      expect(r.reasons[0]).toBe('build-running')
      expect(describeReadiness(r)).toContain('建立缓存与索引')
      release()
      await first
      expect(checkCompilationReadiness('t1').buildRunning).toBe(false)
    })
  })
}
