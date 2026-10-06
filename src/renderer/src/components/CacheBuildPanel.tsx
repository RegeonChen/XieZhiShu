/**
 * CacheBuildPanel.tsx —— 设置页「建立缓存与索引」面板（Phase 11 D，2026-10-06 用户需求）。
 *
 * 一次「建立」做两件事（与主进程 `web-source/cache-build.ts` 一一对应）：
 * ① **网页正文缓存**：按年份区间（默认 2005–2025，用户可改）抓正文并写缓存——只抓不筛，已建立的自动跳过；
 * ② **本地资料库索引**：把未索引的资料排队（与抓取**并行**，进度来自既有的 rag 队列）。
 *
 * 界面口径（都来自用户裁定，不要改）：
 * - **只提示不限制**：这里如实报"本次要建 N 篇 / 已有 M 篇跳过 / 无法建立 K 篇"，**不设任何总量上限**；
 * - **已建立的不重复建立**：靠主进程的只读规划与"只取未缓存目标"保证，界面如实显示跳过数；
 * - **不花大模型额度**：嵌入是本地模型，这里不会调用任何大模型（面板上如实写明）。
 *
 * 兼容性：preload 只在创建窗口时加载一次，"界面已更新但内核仍旧"时会缺方法——
 * 因此所有桥方法都先做存在性自检，缺方法时给出"请重启软件"的明确指引，而不是抛 TypeError。
 */
import { type JSX, useCallback, useEffect, useState } from 'react'
import { zhCN } from '../i18n/zh-CN'
import type { CacheBuildPlan, CacheBuildStatus } from '../../../shared/types'

/** 与主进程 `AppSettings.webCrawlTier` 一致 */
type CrawlTier = 'safe' | 'standard' | 'fast'

interface RagStatus {
  total: number
  ready: number
  failed: number
  bodyMissing?: number
  lastError: string | null
  bodyMissingCount?: number
  rebuild: { status: 'running' | 'interrupted' | 'done'; processed: number; totalQueued: number; remaining: number; percent: number }
  engine?: { poolSize: number; workerThreads: number; workerErrors: number; directFallbacks: number; lastWorkerError: string | null }
}

interface CacheStats {
  entries: number
  bytes: number
  byState: { ok: number; 'no-body': number; blocked: number }
}

const DEFAULT_FROM = 2005
const DEFAULT_TO = 2025
const MIN_YEAR = 1900
const MAX_YEAR = 2100
/** 网页抓取一完成就刷新一次规划（间隔统计），但不跟着 1.5 秒轮询反复查库 */
const POLL_MS = 1500

function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (m >= 60) return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
  return m > 0 ? `${m} 分 ${String(s).padStart(2, '0')} 秒` : `${s} 秒`
}

function tierLabel(tier: CrawlTier): string {
  const c = zhCN.compilation
  if (tier === 'safe') return c.webCrawlTierSafe
  if (tier === 'fast') return c.webCrawlTierFast
  return c.webCrawlTierStandard
}

export default function CacheBuildPanel(): JSX.Element {
  const index = zhCN.settingsPage.index
  const [from, setFrom] = useState(String(DEFAULT_FROM))
  const [to, setTo] = useState(String(DEFAULT_TO))
  const [status, setStatus] = useState<CacheBuildStatus | null>(null)
  const [plan, setPlan] = useState<CacheBuildPlan | null>(null)
  const [planErr, setPlanErr] = useState<string | null>(null)
  const [rag, setRag] = useState<RagStatus | null>(null)
  const [cache, setCache] = useState<CacheStats | null>(null)
  const [tier, setTier] = useState<CrawlTier>('standard')
  // Phase 11 H：站点清单发现——默认自动（页/层由算法测出）；手动才用下面两个数
  const [discoveryMode, setDiscoveryMode] = useState<'auto' | 'manual'>('auto')
  const [discoveryPages, setDiscoveryPages] = useState(300)
  const [discoveryDepth, setDiscoveryDepth] = useState(6)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [touched, setTouched] = useState(false)

  const f = Number(from)
  const t = Number(to)
  const yearsValid = Number.isInteger(f) && Number.isInteger(t) && f >= MIN_YEAR && t <= MAX_YEAR && f <= t

  /** preload 桥自检：缺方法说明内核是旧版本（preload 只在建窗口时加载一次） */
  const bridgeReady =
    typeof window.api.cacheBuildStatus === 'function' &&
    typeof window.api.cacheBuildPlan === 'function' &&
    typeof window.api.cacheBuildStart === 'function'

  const running = status?.running === true
  const rebuildRunning = rag?.rebuild.status === 'running'
  const localQueued = status?.local.queued ?? 0
  const localActive = rebuildRunning || localQueued > 0

  const refresh = useCallback(async () => {
    if (typeof window.api.cacheBuildStatus === 'function') {
      try {
        const res = await window.api.cacheBuildStatus()
        if (res.ok && res.data) setStatus(res.data)
      } catch {
        /* 桥不可用：上面的 bridgeReady 提示已覆盖 */
      }
    }
    if (typeof window.api.getRagIndexStatus === 'function') {
      try {
        const res = await window.api.getRagIndexStatus()
        if (res.ok && res.data) setRag(res.data as unknown as RagStatus)
      } catch {
        /* 同上 */
      }
    }
    if (typeof window.api.webSourceCacheStats === 'function') {
      try {
        const res = await window.api.webSourceCacheStats()
        if (res.ok && res.data) setCache(res.data as unknown as CacheStats)
      } catch {
        /* 同上 */
      }
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 运行中（网页或本地索引任一个在跑）→ 1.5 秒轮询；都停了就不再打扰主进程
  useEffect(() => {
    if (!running && !localActive) return
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [running, localActive, refresh])

  // 初始设置（抓取节奏档位 + 站点清单发现模式）与一次性刷新
  useEffect(() => {
    void (async () => {
      try {
        const res = await window.api.getSettings()
        const patch =
          res.ok && res.data
            ? (res.data as { webCrawlTier?: CrawlTier; webDiscoveryMode?: 'auto' | 'manual'; webDiscoveryPages?: number; webDiscoveryDepth?: number })
            : null
        if (patch?.webCrawlTier) setTier(patch.webCrawlTier)
        if (patch?.webDiscoveryMode) setDiscoveryMode(patch.webDiscoveryMode)
        if (patch?.webDiscoveryPages) setDiscoveryPages(patch.webDiscoveryPages)
        if (patch?.webDiscoveryDepth) setDiscoveryDepth(patch.webDiscoveryDepth)
      } catch {
        /* 设置读不到就用默认档位 */
      }
    })()
  }, [])

  /*
   * 区间规划（只读、不写库）：输入两个合法年份后防抖 400ms 查询；
   * 另在**一次建立结束后**（finishedAt 变化）刷新，让"还要建多少篇"立刻反映结果。
   * 注意不要依赖整个 status——那会让 1.5 秒轮询每次都跑一遍 5 万行的统计。
   */
  const finishedAt = status?.finishedAt ?? null
  useEffect(() => {
    if (!yearsValid || !bridgeReady) {
      setPlan(null)
      return
    }
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await window.api.cacheBuildPlan({ fromYear: f, toYear: t })
          if (res.ok && res.data) {
            setPlan(res.data)
            setPlanErr(null)
          } else {
            setPlanErr(res.error?.message ?? '')
          }
        } catch (e) {
          setPlanErr(String(e))
        }
      })()
    }, 400)
    return () => window.clearTimeout(timer)
  }, [f, t, yearsValid, bridgeReady, finishedAt])

  const start = async (): Promise<void> => {
    setMsg(null)
    setBusy(true)
    setTouched(true)
    try {
      const res = await window.api.cacheBuildStart({ fromYear: f, toYear: t, includeLocal: true })
      if (res.ok && res.data) {
        setStatus(res.data.status)
        setMsg({ ok: res.data.started, text: res.data.started ? index.started : index.refused })
      } else {
        setMsg({ ok: false, text: index.failed.replace('{message}', res.error?.message ?? '') })
      }
    } catch (e) {
      setMsg({ ok: false, text: index.failed.replace('{message}', String(e)) })
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    setMsg(null)
    try {
      const res = await window.api.cacheBuildStop()
      if (res.ok) setMsg({ ok: true, text: index.stopped })
      else setMsg({ ok: false, text: index.stopFailed.replace('{message}', res.error?.message ?? '') })
    } catch (e) {
      setMsg({ ok: false, text: index.stopFailed.replace('{message}', String(e)) })
    } finally {
      await refresh()
    }
  }

  const saveTier = async (next: CrawlTier): Promise<void> => {
    const prev = tier
    setTier(next)
    const res = await window.api.updateSettings({ webCrawlTier: next })
    if (!res.ok) setTier(prev) // 落库失败就回到原值，不假装已生效
  }

  /**
   * 2026-10-06（Phase 11 H）：站点清单发现——自动（默认，页/层由算法测出）/ 手动（自己填硬顶）。
   * 落库失败一律回到原值，不假装已生效。
   */
  const saveDiscoveryMode = async (next: 'auto' | 'manual'): Promise<void> => {
    const prev = discoveryMode
    setDiscoveryMode(next)
    const res = await window.api.updateSettings({ webDiscoveryMode: next })
    if (!res.ok) setDiscoveryMode(prev)
  }

  const saveDiscoveryNumber = async (field: 'webDiscoveryPages' | 'webDiscoveryDepth', raw: string): Promise<void> => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return
    const res = await window.api.updateSettings({ [field]: n })
    if (res.ok) {
      const got = await window.api.getSettings()
      const s = got.ok && got.data ? (got.data as { webDiscoveryPages?: number; webDiscoveryDepth?: number }) : null
      if (s?.webDiscoveryPages) setDiscoveryPages(s.webDiscoveryPages)
      if (s?.webDiscoveryDepth) setDiscoveryDepth(s.webDiscoveryDepth)
    }
  }

  const clearCache = async (): Promise<void> => {
    setMsg(null)
    setClearing(true)
    try {
      const res = await window.api.webSourceClearCache()
      if (res.ok && res.data) {
        setMsg({ ok: true, text: zhCN.compilation.webCacheCleared.replace('{count}', String(res.data.cleared)) })
        await refresh()
      } else {
        setMsg({ ok: false, text: index.failed.replace('{message}', res.error?.message ?? '') })
      }
    } catch (e) {
      setMsg({ ok: false, text: index.failed.replace('{message}', String(e)) })
    } finally {
      setClearing(false)
    }
  }

  const web = status?.web
  // 已开始处理但还不到 1% 时也给一点点宽度，否则进度条看起来"没动"
  const webPct = web && web.total > 0 ? Math.min(100, Math.max(web.done > 0 ? 1 : 0, Math.round((web.done / web.total) * 100))) : 0
  const local = status?.local
  const localPending = (local?.pending ?? 0) + (local?.indexing ?? 0)
  const localReady = (local?.total ?? 0) > 0 && (local?.ready ?? 0) === (local?.total ?? 0) && (local?.failed ?? 0) === 0

  return (
    <>
      <div className="settings__section-header">
        <span className="settings__section-icon settings__section-icon--workspace" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h16M4 12h16M4 17h10" />
            <circle cx="18" cy="17" r="3" />
          </svg>
        </span>
        <h4 className="settings__section-title">{index.title}</h4>
        <div className="settings__workspace-actions">
          {running ? (
            <button type="button" className="source-list__btn" onClick={() => void stop()}>
              {index.stopBtn}
            </button>
          ) : null}
          <button
            type="button"
            className="source-list__btn source-list__btn--primary"
            onClick={() => void start()}
            disabled={running || busy || !yearsValid || !bridgeReady}
          >
            {running ? index.rebuilding : index.rebuildBtn}
          </button>
        </div>
      </div>
      <p className="settings__hint">{index.hint}</p>
      {!bridgeReady ? <p className="settings__hint settings__hint--err">{index.staleBridge}</p> : null}

      {/* 年份区间 + 只读规划（"本次要建多少 / 已有多少跳过"如实摆出来） */}
      <div className="settings__field cache-build__years">
        <span className="settings__field-label">{index.yearLabel}</span>
        <div className="cache-build__years-row">
          <input
            type="number"
            className="cache-build__year-input"
            min={MIN_YEAR}
            max={MAX_YEAR}
            value={from}
            disabled={running}
            onChange={(e) => setFrom(e.target.value)}
            aria-label={zhCN.compilation.webYearFrom}
          />
          <span className="cache-build__years-sep">–</span>
          <input
            type="number"
            className="cache-build__year-input"
            min={MIN_YEAR}
            max={MAX_YEAR}
            value={to}
            disabled={running}
            onChange={(e) => setTo(e.target.value)}
            aria-label={zhCN.compilation.webYearTo}
          />
          {!yearsValid && (touched || from !== String(DEFAULT_FROM) || to !== String(DEFAULT_TO)) ? (
            <span className="settings__field-hint settings__hint--err">{index.yearInvalid}</span>
          ) : null}
        </div>
        {yearsValid && plan && status?.phase !== 'syncing' ? (
          <p className="settings__field-hint" data-testid="cache-build-plan">
            {plan.web.pending > 0
              ? index.planPending.replace('{pending}', String(plan.web.pending)).replace('{minutes}', String(plan.web.estimatedMinutes))
              : index.nothingToDo}
            {plan.web.total - plan.web.pending > 0
              ? '；' + index.planAlready.replace('{already}', String(plan.web.total - plan.web.pending))
              : ''}
          </p>
        ) : null}
        {/*
          Phase 11 G（C）：站点概况 —— "有几个站、几个还没清单"必须看得见。
          没同步过的站点在目录里是 0 条，不写清楚的话，用户会以为软件漏了它（用户实测反馈）。
        */}
        {yearsValid && plan && status?.phase !== 'syncing' ? (
          <p className="settings__field-hint" data-testid="cache-build-sites">
            {index.sites.replace('{total}', String(plan.sites.total))}
            {plan.sites.neverSynced > 0 ? index.sitesNeverSynced.replace('{count}', String(plan.sites.neverSynced)) : ''}
          </p>
        ) : null}
        {yearsValid && plan && plan.web.blocked > 0 ? (
          <p className="settings__field-hint">{index.planBlocked.replace('{blocked}', String(plan.web.blocked))}</p>
        ) : null}
        {yearsValid && plan && plan.web.undatedArticles > 0 ? (
          <p className="settings__field-hint">{index.planUndated.replace('{undated}', String(plan.web.undatedArticles))}</p>
        ) : null}
        {planErr ? <p className="settings__field-hint settings__hint--err">{index.planFailed.replace('{message}', planErr)}</p> : null}
      </div>

      {/* 站点清单同步（A 的第一阶段）：运行中如实显示在同步哪个站点，结束后给汇总 */}
      {status && (status.phase === 'syncing' || status.sync.added > 0 || status.sync.failed > 0) ? (
        <div className="cache-build__block">
          <span className="settings__field-label">{index.syncLabel}</span>
          <p className="settings__field-hint" data-testid="cache-build-sync">
            {status.phase === 'syncing'
              ? status.sync.currentSite
                ? index.syncingSites
                    .replace('{index}', String(Math.max(1, status.sync.siteIndex)))
                    .replace('{total}', String(status.sync.siteTotal || '?'))
                    .replace('{site}', status.sync.currentSite)
                : index.syncingSitesSimple
              : index.syncSummary
                  .replace('{done}', String(status.sync.siteIndex))
                  .replace('{total}', String(status.sync.siteTotal))
                  .replace('{added}', String(status.sync.added)) +
                (status.sync.failed > 0 ? index.syncFailedCount.replace('{count}', String(status.sync.failed)) : '')}
          </p>
          {status.phase === 'syncing' ? <p className="settings__field-hint">{index.syncPendingHint}</p> : null}
          {/* Phase 11 H：算法**实测**出来的发现规模（页/层数不再由人预设） */}
          {status.phase !== 'syncing' && status.sync.lastSummary ? (
            <p className="settings__field-hint" data-testid="cache-build-discovery">
              {status.sync.lastSummary}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* 站点清单发现的规模（Phase 11 H）：默认自动，页/层由算法测出；撞安全阀时可切手动放开 */}
      <div className="cache-build__block">
        <span className="settings__field-label">{index.discoveryLabel}</span>
        <div className="cache-build__tiers">
          <label className="cache-build__tier-item">
            <input
              type="radio"
              name="cache-build-discovery"
              checked={discoveryMode === 'auto'}
              disabled={running}
              onChange={() => void saveDiscoveryMode('auto')}
            />
            {index.discoveryAuto}
          </label>
          <label className="cache-build__tier-item">
            <input
              type="radio"
              name="cache-build-discovery"
              checked={discoveryMode === 'manual'}
              disabled={running}
              onChange={() => void saveDiscoveryMode('manual')}
            />
            {index.discoveryManual}
          </label>
          {discoveryMode === 'manual' ? (
            <>
              <label className="cache-build__tier-item">
                {index.discoveryPages}
                <input
                  type="number"
                  className="cache-build__year-input"
                  min={10}
                  max={2000}
                  value={discoveryPages}
                  disabled={running}
                  onChange={(e) => setDiscoveryPages(Number(e.target.value))}
                  onBlur={(e) => void saveDiscoveryNumber('webDiscoveryPages', e.target.value)}
                />
              </label>
              <label className="cache-build__tier-item">
                {index.discoveryDepth}
                <input
                  type="number"
                  className="cache-build__year-input"
                  min={1}
                  max={8}
                  value={discoveryDepth}
                  disabled={running}
                  onChange={(e) => setDiscoveryDepth(Number(e.target.value))}
                  onBlur={(e) => void saveDiscoveryNumber('webDiscoveryDepth', e.target.value)}
                />
              </label>
            </>
          ) : null}
        </div>
        <p className="settings__field-hint">
          {discoveryMode === 'auto'
            ? index.discoveryAutoHint.replace('{pages}', String(discoveryPages)).replace('{depth}', String(discoveryDepth))
            : index.discoveryManualHint}
        </p>
      </div>

      {/* ① 网页正文缓存 */}
      <div className="cache-build__block">
        <span className="settings__field-label">{index.webTitle}</span>
        {web && (running || web.total > 0) ? (
          <>
            <div className="cache-build__progress">
              <div className="cache-build__progress-bar" style={{ width: `${webPct}%` }} />
            </div>
            <p className="settings__field-hint" data-testid="cache-build-web">
              {index.webProgress
                .replace('{done}', String(web.done))
                .replace('{total}', String(web.total))
                .replace('{hits}', String(web.hits))
                .replace('{dropped}', String(web.dropped))
                .replace('{failed}', String(web.failed))}
            </p>
            <p className="settings__field-hint">
              {index.webRate.replace('{rate}', String(web.ratePerSec)).replace('{eta}', fmtEta(web.etaSeconds))}
              {web.total - web.done > 0 && web.currentTitle ? `　当前：${web.currentTitle.slice(0, 24)}` : ''}
            </p>
            {web.cacheHits > 0 ? <p className="settings__field-hint">{index.webSkipped.replace('{count}', String(web.cacheHits))}</p> : null}
          </>
        ) : (
          <p className="settings__field-hint">{index.webIdle}</p>
        )}
      </div>

      {/* ② 本地资料库索引（进度来自 rag 队列，与网页抓取并行） */}
      <div className="cache-build__block">
        <span className="settings__field-label">{index.localTitle}</span>
        {rag ? (
          <>
            <p className="settings__field-hint">
              <span className={`settings__status-chip${localReady ? ' is-ok' : ''}`}>{localReady ? '索引可用' : localPending > 0 || rebuildRunning ? '尚未索引' : '索引可用'}</span>
              {' '}
              {index.localCounts.replace('{ready}', String(rag.ready)).replace('{total}', String(rag.total)).replace('{failed}', String(rag.failed))}
            </p>
            {localPending > 0 ? <p className="settings__field-hint">{index.localPending.replace('{count}', String(localPending))}</p> : null}
            {rebuildRunning || rag.rebuild.status === 'interrupted' ? (
              <p className="settings__field-hint">
                {index.localProgress
                  .replace('{percent}', String(rag.rebuild.percent))
                  .replace('{processed}', String(rag.rebuild.processed))
                  .replace('{total}', String(rag.rebuild.totalQueued))
                  .replace('{remaining}', String(rag.rebuild.remaining))}
                {rag.rebuild.status === 'interrupted' ? ' ' + index.localInterrupted : ''}
              </p>
            ) : null}
            {!rebuildRunning && localPending === 0 && !localReady ? <p className="settings__field-hint">{index.localReady}</p> : null}
            {(rag.bodyMissing ?? 0) > 0 ? (
              <p className="settings__field-hint">{index.localBodyMissing.replace('{count}', String(rag.bodyMissing ?? 0))}</p>
            ) : null}
          </>
        ) : (
          <p className="settings__field-hint">{index.localReady}</p>
        )}
      </div>

      {msg ? <p className={`settings__hint ${msg.ok ? 'settings__hint--ok' : 'settings__hint--err'}`}>{msg.text}</p> : null}
      {status?.message && status.phase !== 'idle' ? <p className="settings__hint">{status.message}</p> : null}

      {/* 抓取节奏档位（2026-10-05 用户裁定：默认标准档；降档只对本次运行有效） */}
      <div className="settings__field">
        <span className="settings__field-label">{zhCN.compilation.webCrawlTierTitle}</span>
        <div className="cache-build__tier">
          {(['safe', 'standard', 'fast'] as CrawlTier[]).map((k) => (
            <label key={k} className="cache-build__tier-item">
              <input type="radio" name="web-crawl-tier" checked={tier === k} disabled={running} onChange={() => void saveTier(k)} />
              <span>{tierLabel(k)}</span>
            </label>
          ))}
        </div>
        <p className="settings__field-hint">{zhCN.compilation.webCrawlTierHint}</p>
      </div>

      {/* 正文缓存占用与清空 */}
      <div className="settings__field">
        <span className="settings__field-label">{zhCN.compilation.webCacheTitle}</span>
        <p className="settings__field-hint" data-testid="cache-build-usage">
          {cache && cache.entries > 0
            ? zhCN.compilation.webCacheUsage
                .replace('{entries}', String(cache.entries))
                .replace('{mb}', String(Math.round((cache.bytes / 1048576) * 10) / 10)) +
              `（正文可用 ${cache.byState.ok}、无可用正文 ${cache.byState['no-body']}、白名单外 ${cache.byState.blocked}）`
            : zhCN.compilation.webCacheEmpty}
        </p>
        <p className="settings__field-hint">{zhCN.compilation.webCacheHint}</p>
        <button
          type="button"
          className="source-list__btn"
          onClick={() => void clearCache()}
          disabled={clearing || running || (cache?.entries ?? 0) === 0}
        >
          {clearing ? '清空中…' : zhCN.compilation.webCacheClearBtn}
        </button>
      </div>

      {/* 引擎自检（确认在跑 Worker 池多线程，还是一直在静默回退单线程） */}
      {rag?.engine ? (
        <p className="settings__hint">
          {index.engine
            .replace('{pool}', String(rag.engine.poolSize))
            .replace('{threads}', String(rag.engine.workerThreads || 1))
            .replace('{errors}', String(rag.engine.workerErrors))
            .replace('{fallbacks}', String(rag.engine.directFallbacks))}
          {rag.engine.lastWorkerError ? '：' + rag.engine.lastWorkerError : ''}
        </p>
      ) : null}
      {rag?.lastError ? (
        <p className="settings__hint settings__hint--err">
          {index.lastError}：<code>{rag.lastError}</code>
        </p>
      ) : null}
    </>
  )
}
