/**
 * provider-store.ts —— LLM Provider 仓储。
 * 密钥以 safeStorage 加密串（safe-storage:v1:...）存于 llm_providers.api_key；
 * 列表/保存结果只回传 apiKeySet，明文密钥仅经 getProviderSecret 在主进程内部使用。
 * codec 由调用方注入（生产为 safeStorageCodec，测试用假实现）。
 */
import Database from 'better-sqlite3'
import type { LlmProviderConfig } from '../../shared/types'
import { getDb, setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import type { SecretCodec } from './secret'

interface ProviderRow {
  id: string
  name: string
  api_base: string
  model: string
  api_key: string | null
  created_at: string
  updated_at: string
}

function rowToConfig(row: ProviderRow): LlmProviderConfig {
  return { id: row.id, name: row.name, apiBase: row.api_base, model: row.model, apiKeySet: row.api_key != null }
}

export interface SaveProviderInput {
  id?: string
  name: string
  apiBase: string
  model: string
  apiKey?: string
}

function getProviderRowById(id: string): ProviderRow | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(id) as ProviderRow | undefined
}

function normalizeApiBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function listProviders(): LlmProviderConfig[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM llm_providers ORDER BY created_at ASC').all() as ProviderRow[]
  return rows.map(rowToConfig)
}

/** 校验并保存 Provider（新建或更新）。apiKey 提供时加密存储；更新且未提供时保留原密钥。 */
export function saveProvider(input: SaveProviderInput, codec: SecretCodec): LlmProviderConfig {
  const name = input.name.trim()
  const apiBase = normalizeApiBase(input.apiBase)
  const model = input.model.trim()
  if (!name) throw new Error('请填写 Provider 名称')
  if (!apiBase) throw new Error('请填写 API 地址')
  if (!model) throw new Error('请填写模型名')

  const db = getDb()
  const existing = input.id ? getProviderRowById(input.id) : undefined
  if (input.id && !existing) throw new Error('Provider 不存在')

  // 名称唯一（排除自身）
  const dup = db.prepare('SELECT id FROM llm_providers WHERE name = ? AND id != ?').get(name, input.id ?? '') as
    | { id: string }
    | undefined
  if (dup) throw new Error(`Provider「${name}」已存在`)

  let apiKeyEncrypted: string | null
  if (input.apiKey) {
    if (!codec.isAvailable()) throw new Error('系统安全存储不可用，无法保存密钥')
    apiKeyEncrypted = codec.encrypt(input.apiKey)
  } else if (existing) {
    apiKeyEncrypted = existing.api_key
  } else {
    apiKeyEncrypted = null
  }

  const now = new Date().toISOString()
  if (existing) {
    db.prepare('UPDATE llm_providers SET name = ?, api_base = ?, model = ?, api_key = ?, updated_at = ? WHERE id = ?')
      .run(name, apiBase, model, apiKeyEncrypted, now, existing.id)
    const row = getProviderRowById(existing.id)
    return rowToConfig(row!)
  }

  const id = crypto.randomUUID()
  db.prepare('INSERT INTO llm_providers (id, name, api_base, model, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, apiBase, model, apiKeyEncrypted, now, now)
  const row = getProviderRowById(id)
  return rowToConfig(row!)
}

export function deleteProvider(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM llm_providers WHERE id = ?').run(id)
}

/** 获取 Provider 及其明文密钥（仅主进程内部调用：连通性测试、后续初稿生成）。 */
export function getProviderSecret(id: string, codec: SecretCodec): { config: LlmProviderConfig; apiKey: string } | null {
  const row = getProviderRowById(id)
  if (!row) return null
  const config = rowToConfig(row)
  if (!row.api_key) return { config, apiKey: '' }
  try {
    return { config, apiKey: codec.decrypt(row.api_key) }
  } catch {
    // 密钥解密失败（存储被破坏 / 编码不匹配）：返回 null，调用方按「Provider 不存在」降级，避免抛错导致界面无反馈
    return null
  }
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

  const fakeCodec: SecretCodec = {
    isAvailable: () => true,
    encrypt: (s) => `enc:${s}`,
    decrypt: (s) => s.replace(/^enc:/, '')
  }

  describe('llm provider store (Task 3.1)', () => {
    it('saves provider and encrypts api key', () => {
      const p = saveProvider(
        { name: 'DeepSeek', apiBase: 'https://api.deepseek.com/v1/', model: 'deepseek-chat', apiKey: 'sk-test-123' },
        fakeCodec
      )
      expect(p.name).toBe('DeepSeek')
      expect(p.apiBase).toBe('https://api.deepseek.com/v1') // 尾部斜杠归一化
      expect(p.apiKeySet).toBe(true)
      // 数据库中为加密串，列表接口不暴露明文
      const row = db.prepare('SELECT api_key FROM llm_providers WHERE id = ?').get(p.id) as { api_key: string }
      expect(row.api_key).toBe('enc:sk-test-123')
      const items = listProviders()
      expect(JSON.stringify(items)).not.toContain('sk-test-123')
    })

    it('updates provider keeping key when key omitted', () => {
      const p = listProviders()[0]
      saveProvider({ id: p.id, name: 'DeepSeek', apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, fakeCodec)
      expect(listProviders()[0].apiKeySet).toBe(true)
    })

    it('updates key when provided', () => {
      const p = listProviders()[0]
      saveProvider({ id: p.id, name: 'DeepSeek', apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-new' }, fakeCodec)
      const sec = getProviderSecret(p.id, fakeCodec)!
      expect(sec.apiKey).toBe('sk-new')
      expect(sec.config.apiKeySet).toBe(true)
    })

    it('rejects duplicate name and missing params', () => {
      expect(() => saveProvider({ name: 'DeepSeek', apiBase: 'https://a.com/v1', model: 'm' }, fakeCodec)).toThrow('已存在')
      expect(() => saveProvider({ name: '', apiBase: 'https://a.com/v1', model: 'm' }, fakeCodec)).toThrow('名称')
    })

    it('deletes provider', () => {
      const p = listProviders()[0]
      deleteProvider(p.id)
      expect(listProviders()).toHaveLength(0)
      expect(getProviderSecret(p.id, fakeCodec)).toBeNull()
    })
  })
}
