/**
 * settings.ts —— 本地设置仓储（settings 表，key-value）。
 * AppSettings 字段与表键映射：
 *   dataDir              → data_dir
 *   currentLlmProviderId → current_llm_provider_id
 */
import Database from 'better-sqlite3'
import type { AppSettings } from '../../shared/types'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'
import { existsSync, statSync } from 'node:fs'

interface SettingRow {
  key: string
  value: string
  updated_at: string
}

function getSetting(key: string): string | undefined {
  const db = getDb()
  const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as SettingRow | undefined
  return row?.value
}

/**
 * 通用键值读写（2026-09-12）：`settings` 表本身就是 key-value，向量索引重建这类**需要跨重启保留**的
 * 运行态（进度/中断标记）直接借用它，避免为一个瞬时状态再加一张表。
 */
export function readSetting(key: string): string | undefined {
  return getSetting(key)
}

export function writeSetting(key: string, value: string): void {
  setSetting(key, value)
}

function setSetting(key: string, value: string): void {
  const db = getDb()
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, value, new Date().toISOString())
}

function deleteSetting(key: string): void {
  const db = getDb()
  db.prepare('DELETE FROM settings WHERE key = ?').run(key)
}

export function getSettings(): AppSettings {
  const settings: AppSettings = {}
  const dataDir = getSetting('data_dir')
  if (dataDir) settings.dataDir = dataDir
  const workspaceDir = getSetting('workspace_dir')
  if (workspaceDir) settings.workspaceDir = workspaceDir
  const compilationProviderId = getSetting('compilation_provider_id')
  if (compilationProviderId) settings.compilationProviderId = compilationProviderId
  const draftProviderId = getSetting('draft_provider_id')
  if (draftProviderId) settings.draftProviderId = draftProviderId
  // Phase 7.6：资料汇编字号档位（缺省 = medium，调用方自行兜底）
  const docScale = getSetting('doc_scale')
  if (docScale === 'small' || docScale === 'medium' || docScale === 'large') settings.docScale = docScale
  // 新手引导已完成标记（落库，dev 与打包版共用；仅显式完成时落库）
  if (getSetting('onboarding_done') === '1') settings.onboardingDone = true
  // 长任务保持唤醒：只在显式关闭时落库（缺省即开启）
  // 注：原先只写不读，导致该开关重启后被重置为"开启"——2026-09-10 一并修掉
  if (getSetting('keep_awake') === 'false') settings.keepAwake = false
  // Phase 10 P3：网页资料库的发布时间筛选区间（两年份都在且合法才生效）
  const yf = getSetting('web_year_from')
  const yt = getSetting('web_year_to')
  if (yf && yt) {
    const from = Number(yf)
    const to = Number(yt)
    if (isValidYearRange(from, to)) {
      settings.webYearFrom = from
      settings.webYearTo = to
    }
  }
  // 2026-10-05：网页抓取节奏档位（缺省 = 标准档，由调用方兜底）
  const tier = getSetting('web_crawl_tier')
  if (tier === 'safe' || tier === 'fast') settings.webCrawlTier = tier
  return settings
}

/** 年份是否落在可接受范围内（与 `article-date.ts` 的 MIN_YEAR 口径一致） */
function isValidYear(y: number): boolean {
  return Number.isInteger(y) && y >= 1990 && y <= new Date().getFullYear() + 1
}

function isValidYearRange(from: number, to: number): boolean {
  return isValidYear(from) && isValidYear(to) && from <= to
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const db = getDb()

  // 键显式出现在 patch 中即表示要修改该设置：非空字符串写入，空（undefined/''）表示清除
  if ('dataDir' in patch) {
    const v = patch.dataDir?.trim()
    if (v) setSetting('data_dir', v)
    else deleteSetting('data_dir')
  }

  if ('workspaceDir' in patch) {
    const v = patch.workspaceDir?.trim()
    if (v) {
      // 校验目录存在且为文件夹
      if (!existsSync(v) || !statSync(v).isDirectory()) {
        throw new Error('指定的工作区目录不存在或不是文件夹')
      }
      setSetting('workspace_dir', v)
    } else {
      deleteSetting('workspace_dir')
    }
  }

  if ('compilationProviderId' in patch) {
    const v = patch.compilationProviderId?.trim()
    if (v) {
      const exists = db.prepare('SELECT id FROM llm_providers WHERE id = ?').get(v)
      if (!exists) throw new Error('指定的 Provider 不存在')
      setSetting('compilation_provider_id', v)
    } else {
      deleteSetting('compilation_provider_id')
    }
  }

  if ('draftProviderId' in patch) {
    const v = patch.draftProviderId?.trim()
    if (v) {
      const exists = db.prepare('SELECT id FROM llm_providers WHERE id = ?').get(v)
      if (!exists) throw new Error('指定的 Provider 不存在')
      setSetting('draft_provider_id', v)
    } else {
      deleteSetting('draft_provider_id')
    }
  }

  if ('keepAwake' in patch) {
    if (patch.keepAwake === false) setSetting('keep_awake', 'false')
    else deleteSetting('keep_awake') // 缺省即开启，清除键即可回到默认
  }

  if ('onboardingDone' in patch) {
    // 只在"已完成"时落库；传 false 视为清除标记（设置页"重新打开新手引导"不需要清，用户点开即视为未完成）
    if (patch.onboardingDone === true) setSetting('onboarding_done', '1')
    else deleteSetting('onboarding_done')
  }

  if ('docScale' in patch) {
    const v = patch.docScale
    // 非法值一律当作"回到默认"，避免把坏值写进库
    if (v === 'small' || v === 'large') setSetting('doc_scale', v)
    else deleteSetting('doc_scale') // medium 是默认值，不落库
  }

  // Phase 10 P3：网页资料库年份区间。两个值必须成对且合法，否则**两个键一起清除**（回到"不按年份筛"）
  if ('webYearFrom' in patch || 'webYearTo' in patch) {
    const from = patch.webYearFrom
    const to = patch.webYearTo
    if (typeof from === 'number' && typeof to === 'number' && isValidYearRange(from, to)) {
      setSetting('web_year_from', String(from))
      setSetting('web_year_to', String(to))
    } else {
      deleteSetting('web_year_from')
      deleteSetting('web_year_to')
    }
  }

  // 2026-10-05：网页抓取节奏档位。缺省/非法一律**清除键**（回到默认 = 标准档），避免把坏值写进库
  if ('webCrawlTier' in patch) {
    const v = patch.webCrawlTier
    if (v === 'safe' || v === 'fast') setSetting('web_crawl_tier', v)
    else deleteSetting('web_crawl_tier') // standard 是默认值，不落库
  }

  return getSettings()
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
  })
  afterAll(() => db.close())

  describe('settings store (Task 3.1)', () => {
    it('saves and reads settings, persists across sessions', () => {
      const saved = updateSettings({ dataDir: '/tmp/xie-zhishu-data' })
      expect(saved.dataDir).toBe('/tmp/xie-zhishu-data')

      // 模拟重启：重新读取
      const again = getSettings()
      expect(again.dataDir).toBe('/tmp/xie-zhishu-data')
    })

    it('clears settings when set to undefined', () => {
      const cleared = updateSettings({ dataDir: undefined })
      expect(cleared.dataDir).toBeUndefined()
    })

    it('persists the compilation font scale and the keep-awake switch (Phase 7.6)', () => {
      // 缺省：docScale 未设置（调用方按 medium 兜底）、keepAwake 视为开启
      const initial = updateSettings({ docScale: undefined, keepAwake: undefined })
      expect(initial.docScale).toBeUndefined()
      expect(initial.keepAwake).toBeUndefined()

      // 显式改档位/关闭唤醒 → 重新读取（模拟重启）仍然生效
      updateSettings({ docScale: 'large', keepAwake: false })
      const reopened = getSettings()
      expect(reopened.docScale).toBe('large')
      expect(reopened.keepAwake).toBe(false)

      // 回到默认：medium 不落库、keepAwake 清除键即恢复开启
      updateSettings({ docScale: 'medium', keepAwake: true })
      const reset = getSettings()
      expect(reset.docScale).toBeUndefined()
      expect(reset.keepAwake).toBeUndefined()
      // small 也要能持久化（三个档位都可选）
      updateSettings({ docScale: 'small' })
      expect(getSettings().docScale).toBe('small')
    })

    it('rejects unknown provider id', () => {
      expect(() => updateSettings({ compilationProviderId: 'no-such-id' })).toThrow('不存在')
    })

    it('persists the web-material year range and clears invalid pairs (Phase 10 P3)', () => {
      // 缺省：未设置（不按年份筛）
      updateSettings({ webYearFrom: 0, webYearTo: 0 })
      expect(getSettings().webYearFrom).toBeUndefined()
      expect(getSettings().webYearTo).toBeUndefined()

      // 合法区间 → 落库，重新读取（模拟重启）仍在
      updateSettings({ webYearFrom: 2005, webYearTo: 2020 })
      const saved = getSettings()
      expect(saved.webYearFrom).toBe(2005)
      expect(saved.webYearTo).toBe(2020)

      // 起点大于终点 → 两个键一起清除（当作"回到不筛"）
      updateSettings({ webYearFrom: 2020, webYearTo: 2005 })
      expect(getSettings().webYearFrom).toBeUndefined()
      expect(getSettings().webYearTo).toBeUndefined()

      // 越界年份 → 同样清除
      updateSettings({ webYearFrom: 1899, webYearTo: 2020 })
      expect(getSettings().webYearFrom).toBeUndefined()
      expect(getSettings().webYearTo).toBeUndefined()
    })

    it('persists per-step default provider ids (Phase 6.8)', () => {
      const p1 = 'provider-a'
      const p2 = 'provider-b'
      db.prepare('INSERT INTO llm_providers (id, name, api_base, model) VALUES (?, ?, ?, ?)').run(p1, 'A', 'https://a/v1', 'm')
      db.prepare('INSERT INTO llm_providers (id, name, api_base, model) VALUES (?, ?, ?, ?)').run(p2, 'B', 'https://b/v1', 'm')

      const saved = updateSettings({ compilationProviderId: p1, draftProviderId: p2 })
      expect(saved.compilationProviderId).toBe(p1)
      expect(saved.draftProviderId).toBe(p2)

      const again = getSettings()
      expect(again.compilationProviderId).toBe(p1)
      expect(again.draftProviderId).toBe(p2)

      const cleared = updateSettings({ compilationProviderId: undefined, draftProviderId: undefined })
      expect(cleared.compilationProviderId).toBeUndefined()
      expect(cleared.draftProviderId).toBeUndefined()

      expect(() => updateSettings({ draftProviderId: 'no-such-id' })).toThrow('不存在')
    })
  })
}
