/**
 * site-sync.ts —— **站点清单同步的编排与状态**（Phase 11 G，2026-10-06 用户实测反馈）。
 *
 * 背景（这是 Phase 11 漏掉的一环，务必记住）：
 * 「发现一个站点里有哪些文章」= `site-crawler.syncSite`（feed → sitemap → BFS 列表页，写入 `web_site_articles`）。
 * 2026-10-05 P6 清理把手动同步入口删掉之后，**全项目只剩生成管线会调用它**。而 Phase 11 把"抓正文"
 * 搬到了「建立缓存与索引」，却没把它的前置步骤（同步清单）一起搬 —— 后果：
 *   注册新站 → 目录 0 条 → **建立完全看不到它**（建立直接读 `web_site_articles`）→ 用户以为"软件只认一个站"。
 *
 * 本模块把"同步"做成**任何地方都能安全调用**的一件事，并**在内存里跟踪状态**（谁在同步、上次失败原因），
 * 供三处使用：
 *   ① 注册站点后自动同步一次（`index.ts` 的 `WEB_SOURCE_ADD`）；
 *   ② 面板上的「同步清单」手动重试（失败后要有救）；
 *   ③ **建立缓存与索引的第一步**（`cache-build.ts`：先同步所有站点，再按区间建立）。
 *
 * 状态**只放内存**（不落库、不加迁移）：`last_synced_at` 已经持久化，够界面显示"上次同步时间"；
 * 而"正在同步/上次失败原因"是瞬时信息，重启后本来就该重新来一遍。
 */
import { logMain } from '../logger'
import Database from 'better-sqlite3'
import { setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { getWebSiteById, listWebSites } from '../db/web-sites'
import { syncSite, type DiscoveryReport, type SyncSiteOptions, type SiteSyncResult } from './site-crawler'
import { resolveLimits, type DiscoveryLimits } from './site-discovery'
import { getDiscoverySettings, updateSettings } from '../db/settings'
import type { WebSite } from '../../shared/types'

/** 正在同步的站点 id（内存） */
const syncing = new Set<string>()
/** 站点 id → 最近一次同步失败原因（内存；成功后清除） */
const errors = new Map<string, string>()

export interface SiteSyncSnapshot {
  syncing: string[]
  errors: Record<string, string>
}

/** 供界面轮询：谁在同步、谁上次失败了 */
export function getSiteSyncSnapshot(): SiteSyncSnapshot {
  return { syncing: [...syncing], errors: Object.fromEntries(errors) }
}

export function isSiteSyncing(siteId: string): boolean {
  return syncing.has(siteId)
}

export interface SiteSyncOutcome {
  siteId: string
  rootUrl: string
  title: string
  /** 本次**新增**的清单条数（增量 upsert；首次同步为全量） */
  added: number
  /** 失败原因（成功时不带此字段） */
  error?: string
  /**
   * 本次发现的**实测报告**（Phase 11 H）：走了多少页/层、停止原因、发现/新增条数。
   * 界面与日志据此如实展示"这个站点实际需要走多深"（页/层数由算法测出，不再由人预设）。
   */
  report?: DiscoveryReport
}

/** 同步时可选的上下文（Phase 11 H）：限额（自动/手动 + 上次用量）与目标年份区间 */
export interface SiteSyncContext {
  /** 目标年份区间（建立区间），用于"未覆盖年份优先出队" */
  fromYear?: number
  toYear?: number
  /** 限额（不传则按自动默认 + 该站上次用量解析） */
  limits?: DiscoveryLimits
}

/** 测试缝：默认走真实的 `syncSite` 与站点列表 */
export interface SiteSyncDeps {
  sync?: (siteId: string, opts?: SyncSiteOptions) => Promise<SiteSyncResult>
  list?: () => WebSite[]
  get?: (siteId: string) => WebSite | null
}

/**
 * 解析某个站点本次的发现限额（Phase 11 H）。
 * 输入：设置页的自动/手动模式与数值（`resolveDiscoveryLimitsOf`）+ **该站上次实测用量**（站点行）。
 */
export function limitsForSite(site: WebSite | null, ctx: SiteSyncContext = {}): DiscoveryLimits {
  if (ctx.limits) return ctx.limits
  const s = getDiscoverySettings()
  return resolveLimits({
    mode: s.mode,
    manualPages: s.pages,
    manualDepth: s.depth,
    hintPages: site?.discoveryPages ?? null,
    hintDepth: site?.discoveryDepth ?? null
  })
}

/**
 * 同步单个站点的清单（**带状态跟踪**）。
 * 同一个站点同时只跑一次：已在同步中时直接返回（不排队、不重复请求站点）。
 */
export async function syncSiteTracked(
  siteId: string,
  deps: SiteSyncDeps = {},
  ctx: SiteSyncContext = {}
): Promise<SiteSyncOutcome> {
  const get = deps.get ?? getWebSiteById
  const sync = deps.sync ?? syncSite
  const site = get(siteId)
  if (!site) return { siteId, rootUrl: '', title: '', added: 0, error: '站点不存在' }
  if (syncing.has(siteId)) return { siteId, rootUrl: site.rootUrl, title: site.title ?? '', added: 0, error: '该站点正在同步中' }

  syncing.add(siteId)
  errors.delete(siteId)
  try {
    // 发现限额：设置页的自动/手动 + 该站**上次实测用量**（下限，防退化）
    const limits = limitsForSite(site, ctx)
    const res = await sync(siteId, { limits, fromYear: ctx.fromYear, toYear: ctx.toYear })
    logMain(
      'web',
      `站点清单同步完成：${site.rootUrl} 新增 ${res.added} 篇（发现 ${res.report.discovered} 篇，走 ${res.report.pagesFetched} 页/${res.report.maxDepthReached} 层，${res.report.stopText}）`
    )
    return { siteId, rootUrl: site.rootUrl, title: site.title ?? '', added: res.added, report: res.report }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    errors.set(siteId, message)
    logMain('web', `站点清单同步失败：${site.rootUrl}：${message}`)
    return { siteId, rootUrl: site.rootUrl, title: site.title ?? '', added: 0, error: message }
  } finally {
    syncing.delete(siteId)
  }
}

export interface SyncAllOptions extends SiteSyncDeps, SiteSyncContext {
  /** 用户按了「停止」→ 不再开下一个站点（**当前这个站点的同步不会被中断**：它没有取消通道） */
  shouldCancel?: () => boolean
  /** 开始同步某个站点前的回调（供建立引擎推进度：第几个/共几个/哪个站） */
  onSite?: (p: { index: number; total: number; site: WebSite }) => void
}

export interface SyncAllResult {
  outcomes: SiteSyncOutcome[]
  /** 因用户停止而没轮到的站点数 */
  notAttempted: number
  added: number
  failed: number
}

/**
 * 依次同步**所有**注册站点的清单（与生成管线同一实现、同一礼貌限速）。
 * **单站失败绝不中断**（记下原因继续下一个）；支持"停止"（在站点之间生效）。
 */
export async function syncAllSitesTracked(opts: SyncAllOptions = {}): Promise<SyncAllResult> {
  const list = opts.list ?? ((): WebSite[] => listWebSites())
  const sites = list()
  const outcomes: SiteSyncOutcome[] = []
  let notAttempted = 0
  for (let i = 0; i < sites.length; i++) {
    if (opts.shouldCancel?.()) {
      notAttempted = sites.length - i
      logMain('web', `站点清单同步：已按用户要求停止，剩余 ${notAttempted} 个站点未同步`)
      break
    }
    opts.onSite?.({ index: i + 1, total: sites.length, site: sites[i] })
    outcomes.push(
      await syncSiteTracked(sites[i].id, opts, { fromYear: opts.fromYear, toYear: opts.toYear, limits: opts.limits })
    )
  }
  const added = outcomes.reduce((n, o) => n + o.added, 0)
  const failed = outcomes.filter((o) => o.error).length
  if (sites.length > 0) {
    logMain('web', `站点清单同步结束：${outcomes.length}/${sites.length} 个站点，新增 ${added} 篇${failed > 0 ? `，失败 ${failed} 个` : ''}`)
  }
  return { outcomes, notAttempted, added, failed }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
    db.prepare(
      "INSERT INTO web_sites (id, root_url, title, created_at, updated_at) VALUES ('s1','https://a.gov.cn','A站','2026-01-01','2026-01-01'), ('s2','https://b.gov.cn','B站','2026-01-01','2026-01-01')"
    ).run()
  })
  afterAll(() => db.close())

  /** 假同步结果（Phase 11 H 起 `syncSite` 返回"新增数 + 发现报告"） */
  const fakeSyncResult = (added: number): SiteSyncResult => ({
    added,
    report: {
      method: 'bfs',
      pagesFetched: 3,
      maxDepthReached: 1,
      stopReason: 'saturated',
      stopText: '收益饱和（走到 3 页后，连续多页已无新文章）',
      discovered: added,
      freshArticles: added,
      added,
      dated: added,
      byYear: {},
      cellCount: 1,
      depthPruned: 0,
      seconds: 0.1,
      limits: resolveLimits({})
    }
  })

  describe('site-sync（站点清单同步编排，Phase 11 G）', () => {
    it('单站同步：成功记新增数、清掉旧失败原因；失败记原因且不抛', async () => {
      const ok = await syncSiteTracked('s1', { sync: async () => fakeSyncResult(7) })
      expect(ok).toMatchObject({ siteId: 's1', added: 7 })
      expect(ok.error).toBeUndefined()
      expect(getSiteSyncSnapshot().errors.s1).toBeUndefined()

      const bad = await syncSiteTracked('s2', {
        sync: async () => {
          throw new Error('模拟站点超时')
        }
      })
      expect(bad.error).toContain('模拟站点超时')
      expect(getSiteSyncSnapshot().errors.s2).toContain('模拟站点超时')
      // 同步中标志在结束后必须清掉（否则界面永远显示"正在同步"）
      expect(isSiteSyncing('s2')).toBe(false)
    })

    it('站点不存在 → 不抛错、如实报原因', async () => {
      const r = await syncSiteTracked('nope', { sync: async () => fakeSyncResult(1) })
      expect(r.error).toBe('站点不存在')
      expect(r.added).toBe(0)
    })

    it('限额按站点解析：自动模式吃该站上次用量当下限，手动模式用用户值', async () => {
      // 自动（默认）：s1 上次走了 77 页 / 4 层 → 本次下限 77、层数上限至少 4
      db.prepare("UPDATE web_sites SET discovery_pages = 77, discovery_depth = 4 WHERE id = 's1'").run()
      const s1 = getWebSiteById('s1')
      const auto = limitsForSite(s1)
      expect(auto.mode).toBe('auto')
      expect(auto.minPages).toBe(77)
      expect(auto.maxPages).toBeGreaterThanOrEqual(77)
      expect(auto.maxDepth).toBeGreaterThanOrEqual(4)
      // 显式传 limits 时以传入为准
      const fixed = limitsForSite(s1, { limits: resolveLimits({ mode: 'manual', manualPages: 30, manualDepth: 2 }) })
      expect(fixed).toMatchObject({ mode: 'manual', maxPages: 30, minPages: 0 })

      // 手动（设置项）→ 用户值生效，且不被该站上次用量盖过（取大者）
      updateSettings({ webDiscoveryMode: 'manual', webDiscoveryPages: 50, webDiscoveryDepth: 3 })
      const manual = limitsForSite(getWebSiteById('s2'))
      expect(manual).toMatchObject({ mode: 'manual', saturation: false })
      expect(manual.maxPages).toBe(50)
      // 复原（避免影响其它用例与库状态）
      updateSettings({ webDiscoveryMode: 'auto', webDiscoveryPages: undefined, webDiscoveryDepth: undefined })
    })

    it('全部站点：单站失败不中断其它站；统计新增与失败数', async () => {
      const res = await syncAllSitesTracked({
        sync: async (id) => {
          if (id === 's1') throw new Error('A站挂了')
          return fakeSyncResult(3)
        }
      })
      expect(res.outcomes).toHaveLength(2)
      expect(res.failed).toBe(1)
      expect(res.added).toBe(3)
      expect(res.notAttempted).toBe(0)
    })

    it('用户停止：只在站点之间生效，剩余站点如实记为未同步', async () => {
      const visited: string[] = []
      const res = await syncAllSitesTracked({
        sync: async (id) => {
          visited.push(id)
          return fakeSyncResult(1)
        },
        // 第一个站点同步完就返回 true（模拟用户在同步过程中按了停止）
        shouldCancel: () => visited.length >= 1,
        onSite: (p) => visited.push(`begin:${p.index}/${p.total}`)
      })
      expect(res.outcomes).toHaveLength(1)
      expect(res.notAttempted).toBe(1)
      expect(visited.filter((v) => v.startsWith('begin:'))).toHaveLength(1)
    })
  })
}
