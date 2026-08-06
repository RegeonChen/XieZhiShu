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
  const currentLlmProviderId = getSetting('current_llm_provider_id')
  if (currentLlmProviderId) settings.currentLlmProviderId = currentLlmProviderId
  return settings
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const db = getDb()

  // 键显式出现在 patch 中即表示要修改该设置：非空字符串写入，空（undefined/''）表示清除
  if ('dataDir' in patch) {
    const v = patch.dataDir?.trim()
    if (v) setSetting('data_dir', v)
    else deleteSetting('data_dir')
  }

  if ('currentLlmProviderId' in patch) {
    const v = patch.currentLlmProviderId?.trim()
    if (v) {
      const exists = db.prepare('SELECT id FROM llm_providers WHERE id = ?').get(v)
      if (!exists) throw new Error('指定的 Provider 不存在')
      setSetting('current_llm_provider_id', v)
    } else {
      deleteSetting('current_llm_provider_id')
    }
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
      const pid = 'provider-1'
      db.prepare('INSERT INTO llm_providers (id, name, api_base, model) VALUES (?, ?, ?, ?)').run(pid, 'P', 'https://x/v1', 'm')

      const saved = updateSettings({ currentLlmProviderId: pid, dataDir: 'C:\\xie-zhishu-data' })
      expect(saved.currentLlmProviderId).toBe(pid)
      expect(saved.dataDir).toBe('C:\\xie-zhishu-data')

      // 模拟重启：重新读取
      const again = getSettings()
      expect(again.currentLlmProviderId).toBe(pid)
      expect(again.dataDir).toBe('C:\\xie-zhishu-data')
    })

    it('clears settings when set to undefined', () => {
      const cleared = updateSettings({ currentLlmProviderId: undefined, dataDir: undefined })
      expect(cleared.currentLlmProviderId).toBeUndefined()
      expect(cleared.dataDir).toBeUndefined()
    })

    it('rejects unknown provider id', () => {
      expect(() => updateSettings({ currentLlmProviderId: 'no-such-id' })).toThrow('不存在')
    })
  })
}
