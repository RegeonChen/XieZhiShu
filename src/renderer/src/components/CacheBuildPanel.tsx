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
import ConfirmDialog from './ConfirmDialog'
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

/** 数字加千分位：34,325 比 34325 好扫读（2026-11-04 改版） */
function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString('zh-CN')
}

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
  /** 上一次「建立」实测的每篇毫秒（null = 还没测过，估算用默认 75ms/篇） */
  const [measuredMs, setMeasuredMs] = useState<number | null>(null)

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

  // 初始设置（抓取节奏档位 + 站点清单发现模式 + 上次实测速度）与一次性刷新
  useEffect(() => {
    void (async () => {
      try {
        const res = await window.api.getSettings()
        const patch =
          res.ok && res.data
            ? (res.data as {
                webCrawlTier?: CrawlTier
                webDiscoveryMode?: 'auto' | 'manual'
                webDiscoveryPages?: number
                webDiscoveryDepth?: number
                webFetchMsPerArticle?: number
              })
            : null
        if (patch?.webCrawlTier) setTier(patch.webCrawlTier)
        if (patch?.webDiscoveryMode) setDiscoveryMode(patch.webDiscoveryMode)
        if (patch?.webDiscoveryPages) setDiscoveryPages(patch.webDiscoveryPages)
        if (patch?.webDiscoveryDepth) setDiscoveryDepth(patch.webDiscoveryDepth)
        if (patch?.webFetchMsPerArticle) setMeasuredMs(patch.webFetchMsPerArticle)
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

  /*
   * 「上次实测」必须跟着**档位**与**建立结束**刷新（2026-11-02 实测时发现的 UI 缺口）：
   * 只在挂载时读一次，会让刚建完的实测值一直到重启才出现；换档后显示的也还是旧档位的数。
   */
  useEffect(() => {
    void (async () => {
      try {
        const res = await window.api.getSettings()
        const v = res.ok && res.data ? (res.data as { webFetchMsPerArticle?: number }).webFetchMsPerArticle : undefined
        setMeasuredMs(typeof v === 'number' ? v : null)
      } catch {
        /* 读不到就按"没测过"显示 */
      }
    })()
  }, [tier, finishedAt])
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
    /*
     * `measuredMs` 也要进依赖：刚建完时实测值会变，预计分钟数必须跟着用新口径重算。
     * 2026-11-02 实测时发现漏了它——面板显示"预计 60 分钟"（默认 75ms 口径），
     * 而接口按实测 124ms 算出来是 98 分钟，两个数字自相矛盾。
     */
  }, [f, t, yearsValid, bridgeReady, finishedAt, measuredMs])

  /*
   * 2026-11-03（用户实测反馈）：建立结束后，点击时那句绿色的"已开始建立…"仍留在面板上，
   * 与「已完成」并存会让用户以为还在跑 → 一旦确认这轮已结束，就把这条"开工回执"收掉
   * （错误类提示由 status.message 负责，不受影响）。
   */
  useEffect(() => {
    if (!msg?.ok) return
    if (!status || status.running) return
    if (status.phase === 'done' || status.phase === 'cancelled') setMsg(null)
  }, [msg, status])

  const start = async (): Promise<void> => {
    setMsg(null)
    setBusy(true)
    setTouched(true)
    try {
      const res = await window.api.cacheBuildStart({ fromYear: f, toYear: t, includeLocal: true })
      if (res.ok && res.data) {
        setStatus(res.data.status)
        // 2026-11-02：被拒（如"正在生成汇编、抓取进行中"）时显示**主进程的真实原因**，不要笼统说"已拒绝"
        setMsg({
          ok: res.data.started,
          text: res.data.started ? index.started : res.data.message || index.refused
        })
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

  /**
   * 2026-11-02（审查修复）：清空缓存**必须先确认**。
   * 它是全表 `DELETE FROM web_article_body`：正文全丢要重抓，而且连 `no-body` 标记一起清掉——
   * 那批"永远建不了"的老文章会重新变成"待建立"，闸门又被它们卡住。与"删站点/删资料"的确认口径对齐。
   */
  const [pendingClear, setPendingClear] = useState(false)

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
      setPendingClear(false)
    }
  }

  const web = status?.web
  // 已开始处理但还不到 1% 时也给一点点宽度，否则进度条看起来"没动"
  const webPct = web && web.total > 0 ? Math.min(100, Math.max(web.done > 0 ? 1 : 0, Math.round((web.done / web.total) * 100))) : 0
  /*
   * 2026-11-03（用户实测反馈）：网页侧必须有"收尾态"。
   * `running=false` 之后进度条仍按 `web.total > 0` 常显，看起来像还在跑；
   * 这里按 phase 明确区分 已完成 / 已停止 / 失败（失败时保留红色提示，不伪装成完成）。
   */
  const webFinished = !running && status?.phase === 'done' && (web?.total ?? 0) > 0
  const webCancelled = !running && status?.phase === 'cancelled' && (web?.total ?? 0) > 0
  const webFinishedLabel = (() => {
    const t = status?.finishedAt
    if (!t) return ''
    const d = new Date(t)
    if (Number.isNaN(d.getTime())) return ''
    return index.webFinishedAt.replace('{time}', d.toLocaleTimeString('zh-CN', { hour12: false }))
  })()
  const local = status?.local
  const localPending = (local?.pending ?? 0) + (local?.indexing ?? 0)
  const localReady = (local?.total ?? 0) > 0 && (local?.ready ?? 0) === (local?.total ?? 0) && (local?.failed ?? 0) === 0
  /*
   * 2026-11-04（用户反馈"纯文本堆砌、抓不住重点"）：重排信息层级——
   * ① 顶部四个数字：还剩多少要建（待建立网页 / 已缓存 / 待索引本地 / 无可用正文）；
   * ② 一条状态横幅：运行中 / 已完成 / 已停止 / 建立失败（带颜色，替代原来的一堆灰字）；
   * ③ 年份区间 + 预计小胶囊；
   * ④ 两张进度卡（网页正文缓存 / 本地资料库索引），进度条 + 关键数字；
   * ⑤ 「更多设置」折叠：清单发现、抓取档位、站点概况、缓存占用与清空、引擎自检。
   * **功能与 IPC 调用一律不动**，只改信息层级与视觉。
   */
  const pendingWeb = plan ? plan.web.pending : null
  const cachedEntries = cache?.entries ?? 0
  const noBodyCount = cache?.byState['no-body'] ?? 0
  const planChipText = plan
    ? plan.web.pending > 0
      ? index.planChip.replace('{pending}', fmtNum(plan.web.pending)).replace('{minutes}', String(plan.web.estimatedMinutes))
      : index.planChipDone
    : '—'

  /** 状态横幅：优先级 = 失败 > 运行中 > 操作回执 > 已完成 > 已停止 */
  const banner = (() => {
    if (status?.phase === 'failed' && status.message) return { tone: 'err', text: status.message }
    if (running) return { tone: 'info', text: index.runningBanner }
    if (msg) return { tone: msg.ok ? 'ok' : 'err', text: msg.text }
    if (webFinished) return { tone: 'ok', text: index.doneBanner + (webFinishedLabel ? '　' + webFinishedLabel : '') }
    if (webCancelled) return { tone: 'muted', text: index.webStoppedHint }
    return null
  })()

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

      {/* ① 四个数字：用户一眼看到"还剩多少要建" */}
      <div className="cache-build__stats" data-testid="cache-build-stats">
        <div className="cache-build__stat">
          <span className="cache-build__stat-num">{fmtNum(pendingWeb)}</span>
          <span className="cache-build__stat-label">{index.statWebPending}</span>
        </div>
        <div className="cache-build__stat is-ok">
          <span className="cache-build__stat-num">{fmtNum(cachedEntries)}</span>
          <span className="cache-build__stat-label">{index.statCached}</span>
        </div>
        <div className="cache-build__stat">
          <span className="cache-build__stat-num">{fmtNum(localPending)}</span>
          <span className="cache-build__stat-label">{index.statLocalPending}</span>
        </div>
        <div className="cache-build__stat is-muted">
          <span className="cache-build__stat-num">{fmtNum(noBodyCount)}</span>
          <span className="cache-build__stat-label">{index.statNoBody}</span>
        </div>
      </div>

      {/* ② 状态横幅（运行中 / 已完成 / 已停止 / 失败 / 操作回执） */}
      {banner ? (
        <div className={`cache-build__banner is-${banner.tone}`} data-testid="cache-build-banner" role="status">
          <span className="cache-build__banner-dot" aria-hidden="true" />
          <span>{banner.text}</span>
        </div>
      ) : null}
      {!bridgeReady ? <p className="settings__hint settings__hint--err">{index.staleBridge}</p> : null}

      {/* ③ 年份区间 + 预计（只读规划：本次要建多少篇） */}
      <div className="cache-build__controls">
        <div className="cache-build__year-block">
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
        </div>
        <span className="cache-build__chip" data-testid="cache-build-plan-chip">
          {planChipText}
        </span>
      </div>

      {yearsValid && plan && status?.phase !== 'syncing' ? (
        <p className="settings__field-hint" data-testid="cache-build-plan">
          {plan.web.total - plan.web.pending > 0
            ? index.planAlready.replace('{already}', fmtNum(plan.web.total - plan.web.pending)) + '　'
            : ''}
          {/* 估算依据摊开：上次实测比"预计 X 分钟"更能帮用户判断 */}
          {measuredMs != null
            ? index.planRateMeasured.replace('{ms}', String(measuredMs)).replace('{perSec}', (1000 / measuredMs).toFixed(1))
            : index.planRateDefault}
        </p>
      ) : null}
      {/* Phase 11 G（C）：站点概况——"有几个站、几个还没清单"必须看得见 */}
      {yearsValid && plan && status?.phase !== 'syncing' ? (
        <p className="settings__field-hint" data-testid="cache-build-sites">
          {index.sites.replace('{total}', fmtNum(plan.sites.total))}
          {plan.sites.neverSynced > 0 ? index.sitesNeverSynced.replace('{count}', fmtNum(plan.sites.neverSynced)) : ''}
        </p>
      ) : null}
      {yearsValid && plan && plan.web.blocked > 0 ? (
        <p className="settings__field-hint">{index.planBlocked.replace('{blocked}', fmtNum(plan.web.blocked))}</p>
      ) : null}
      {yearsValid && plan && plan.web.undatedArticles > 0 ? (
        <p className="settings__field-hint">{index.planUndated.replace('{undated}', fmtNum(plan.web.undatedArticles))}</p>
      ) : null}
      {planErr ? <p className="settings__field-hint settings__hint--err">{index.planFailed.replace('{message}', planErr)}</p> : null}

      {/* ④ 两张进度卡：网页 / 本地，并排 */}
      <div className="cache-build__cards">
        <div className="cache-build__card">
          <div className="cache-build__card-head">
            <span className="cache-build__card-title">{index.webTitle}</span>
            {running ? (
              <span className="settings__status-chip">{index.webChipRunning}</span>
            ) : webFinished ? (
              <span className="settings__status-chip is-ok">✓ {index.webChipDone}</span>
            ) : webCancelled ? (
              <span className="settings__status-chip">{index.webChipStopped}</span>
            ) : status?.phase === 'failed' ? (
              <span className="settings__status-chip is-err">{index.webChipFailed}</span>
            ) : null}
          </div>
          {web && (running || web.total > 0) ? (
            <>
              <div className="cache-build__progress">
                <div
                  className={`cache-build__progress-bar${webFinished ? ' cache-build__progress-bar--done' : ''}`}
                  style={{ width: `${webFinished ? 100 : webPct}%` }}
                />
              </div>
              <div className="cache-build__card-metrics">
                <span>
                  {fmtNum(web.done)} / {fmtNum(web.total)} 篇
                </span>
                <span>{webFinished ? 100 : webPct}%</span>
                <span>{index.webMetricOk.replace('{count}', String(web.hits))}</span>
                <span>{index.webMetricNoBody.replace('{count}', String(web.dropped))}</span>
                {web.failed > 0 ? <span>{index.metricFailed.replace('{count}', String(web.failed))}</span> : null}
              </div>
              <p className="settings__field-hint" data-testid="cache-build-web">
                {webFinished
                  ? webFinishedLabel || index.webChipDone
                  : webCancelled
                    ? index.webStoppedHint
                    : index.webRate.replace('{rate}', String(web.ratePerSec)).replace('{eta}', fmtEta(web.etaSeconds))}
                {!webFinished && !webCancelled && web.total - web.done > 0 && web.currentTitle ? `　当前：${web.currentTitle.slice(0, 24)}` : ''}
              </p>
              {web.cacheHits > 0 ? <p className="settings__field-hint">{index.webSkipped.replace('{count}', String(web.cacheHits))}</p> : null}
            </>
          ) : plan && status?.phase !== 'syncing' ? (
            /*
             * 2026-11-04（改版）：还没开跑时别只留一句灰字——用只读规划显示"已建 / 总数"，
             * 让这张卡与右边的本地索引卡在视觉上对等，用户一眼知道起点在哪。
             */
            <>
              <div className="cache-build__progress">
                <div className="cache-build__progress-bar" style={{ width: `${plan.web.total > 0 ? Math.round((plan.web.cached / plan.web.total) * 100) : 0}%` }} />
              </div>
              <div className="cache-build__card-metrics">
                <span>
                  {fmtNum(plan.web.cached)} / {fmtNum(plan.web.total)} 篇
                </span>
                <span>{plan.web.total > 0 ? Math.round((plan.web.cached / plan.web.total) * 100) : 0}%</span>
                {plan.web.pending > 0 ? <span>{index.planChip.replace('{pending}', fmtNum(plan.web.pending)).replace('{minutes}', String(plan.web.estimatedMinutes))}</span> : null}
              </div>
              <p className="settings__field-hint">{plan.web.pending > 0 ? index.webIdle : index.nothingToDo}</p>
            </>
          ) : (
            <p className="settings__field-hint">{index.webIdle}</p>
          )}
        </div>

        <div className="cache-build__card">
          <div className="cache-build__card-head">
            <span className="cache-build__card-title">{index.localTitle}</span>
            {rag ? (
              <span className={`settings__status-chip${localReady ? ' is-ok' : ''}`}>
                {localReady ? index.localChipReady : index.localChipPending}
              </span>
            ) : null}
          </div>
          {rag ? (
            <>
              <div className="cache-build__progress">
                <div
                  className={`cache-build__progress-bar${localReady ? ' cache-build__progress-bar--done' : ''}`}
                  style={{ width: `${rebuildRunning ? rag.rebuild.percent : localReady ? 100 : 0}%` }}
                />
              </div>
              <div className="cache-build__card-metrics">
                <span>
                  {fmtNum(rag.ready)} / {fmtNum(rag.total)} 篇
                </span>
                <span>{rebuildRunning ? `${rag.rebuild.percent}%` : localReady ? '100%' : '0%'}</span>
                {rag.failed > 0 ? <span>{index.metricFailed.replace('{count}', String(rag.failed))}</span> : null}
                {localPending > 0 ? <span>{index.localChipPending} {fmtNum(localPending)}</span> : null}
              </div>
              {localPending > 0 ? <p className="settings__field-hint">{index.localPending.replace('{count}', fmtNum(localPending))}</p> : null}
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
      </div>

      {status?.message && status.phase !== 'idle' && banner?.text !== status.message ? (
        <p className="settings__field-hint">{status.message}</p>
      ) : null}

      {/* ⑤ 更多设置：这些是低频项，折叠起来但入口常在（功能全保留） */}
      <details className="cache-build__more" data-testid="cache-build-more">
        <summary>{index.advanced}</summary>
        <div className="cache-build__more-body">
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
              {status.phase !== 'syncing' && status.sync.lastSummary ? (
                <p className="settings__field-hint" data-testid="cache-build-discovery">
                  {status.sync.lastSummary}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="cache-build__block">
            <span className="settings__field-label">{index.discoveryLabel}</span>
            <div className="cache-build__tier">
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

          <div className="cache-build__block">
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

          <div className="cache-build__block">
            <span className="settings__field-label">{zhCN.compilation.webCacheTitle}</span>
            <p className="settings__field-hint" data-testid="cache-build-usage">
              {cache && cache.entries > 0
                ? zhCN.compilation.webCacheUsage
                    .replace('{entries}', fmtNum(cache.entries))
                    .replace('{mb}', String(Math.round((cache.bytes / 1048576) * 10) / 10)) +
                  `（正文可用 ${cache.byState.ok}、无可用正文 ${cache.byState['no-body']}、白名单外 ${cache.byState.blocked}）`
                : zhCN.compilation.webCacheEmpty}
            </p>
            <p className="settings__field-hint">{zhCN.compilation.webCacheHint}</p>
            <div>
              <button
                type="button"
                className="source-list__btn"
                onClick={() => setPendingClear(true)}
                disabled={clearing || running || (cache?.entries ?? 0) === 0}
              >
                {clearing ? zhCN.compilation.webCacheClearing : zhCN.compilation.webCacheClearBtn}
              </button>
            </div>
          </div>

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
        </div>
      </details>

      {/* 说明放最后：作为脚注，而不是正文 */}
      <p className="settings__hint settings__hint--foot">{index.hint}</p>

      {pendingClear ? (
        <ConfirmDialog
          title={zhCN.compilation.webCacheClearTitle}
          message={zhCN.compilation.webCacheClearMessage
            .replace('{entries}', String(cache?.entries ?? 0))
            .replace('{noBody}', String(cache?.byState['no-body'] ?? 0))}
          confirmText={zhCN.compilation.webCacheClearBtn}
          cancelText={zhCN.common.cancel}
          busy={clearing}
          busyText={zhCN.compilation.webCacheClearing}
          onConfirm={() => void clearCache()}
          onCancel={() => setPendingClear(false)}
        />
      ) : null}
    </>
  )
}
