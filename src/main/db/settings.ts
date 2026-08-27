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

    it('rejects unknown provider id', () => {
      expect(() => updateSettings({ compilationProviderId: 'no-such-id' })).toThrow('不存在')
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
