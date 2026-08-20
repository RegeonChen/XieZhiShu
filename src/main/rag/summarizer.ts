/**
 * summarizer.ts —— LLM 摘要索引（Phase 3.2 Task 3.2.3）。
 * "整理资料库"：对资料调用 LLM 生成摘要/主题词/关键实体，存入 source_summaries。
 * 用户手动触发，LLM 失败返回稳定错误提示，不影响其它功能。
 */
import { getDb, setDb } from '../db/connection'
import { getSettings } from '../db/settings'
import { getProviderSecret } from '../llm/provider-store'
import { safeStorageCodec } from '../llm/secret'
import { chatCompletion, type ChatMessage } from '../llm/chat'
import { ErrorCodes } from '../../shared/types'
import Database from 'better-sqlite3'
import { runMigrations } from '../db/migrate'

const MAX_INPUT_CHARS = 4000

export interface SourceSummary {
  sourceId: string
  summary: string
  keywords: string[]
  entities: string[]
  llmModel?: string
  updatedAt: string
}

interface SummaryRow {
  source_id: string
  summary: string
  keywords: string
  entities: string
  llm_model: string | null
  updated_at: string
}

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 10) : []
  } catch {
    return []
  }
}

function rowToSummary(row: SummaryRow): SourceSummary {
  return {
    sourceId: row.source_id,
    summary: row.summary,
    keywords: parseList(row.keywords),
    entities: parseList(row.entities),
    llmModel: row.llm_model ?? undefined,
    updatedAt: row.updated_at
  }
}

export function getSourceSummary(sourceId: string): SourceSummary | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM source_summaries WHERE source_id = ?').get(sourceId) as SummaryRow | undefined
  return row ? rowToSummary(row) : null
}

/** 批量读取资料摘要（Task 3.4.2：生成初稿前摘要级粗筛） */
export function getSourceSummariesByIds(sourceIds: string[]): Map<string, SourceSummary> {
  const db = getDb()
  const map = new Map<string, SourceSummary>()
  if (sourceIds.length === 0) return map
  const placeholders = sourceIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT * FROM source_summaries WHERE source_id IN (${placeholders})`)
    .all(...sourceIds) as SummaryRow[]
  for (const r of rows) map.set(r.source_id, rowToSummary(r))
  return map
}

/** 从 LLM 输出中提取 JSON（支持围栏与包裹文本） */
function extractJson(text: string): unknown | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1].trim() : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

export type SummarizeResult =
  | { ok: true; summary: SourceSummary }
  | { ok: false; error: { code: string; message: string } }

/** 为单篇资料生成摘要并入库（幂等：重复调用覆盖更新） */
export async function summarizeSource(sourceId: string): Promise<SummarizeResult> {
  const db = getDb()
  const source = db.prepare('SELECT id, title, cleaned_text FROM sources WHERE id = ?').get(sourceId) as
    | { id: string; title: string; cleaned_text: string }
    | undefined
  if (!source) return { ok: false, error: { code: 'INVALID_PARAM', message: '资料不存在' } }
  const text = (source.cleaned_text ?? '').trim()
  if (!text) return { ok: false, error: { code: 'INVALID_PARAM', message: '资料无正文内容' } }

  const settings = getSettings()
  if (!settings.currentLlmProviderId) {
    return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '请先在设置中配置并选择 LLM Provider' } }
  }
  const provider = getProviderSecret(settings.currentLlmProviderId, safeStorageCodec)
  if (!provider) return { ok: false, error: { code: ErrorCodes.TASK_NO_PROVIDER, message: '所选的 LLM Provider 不存在' } }
  if (!provider.apiKey) return { ok: false, error: { code: ErrorCodes.LLM_UNAUTHORIZED, message: '所选的 LLM Provider 未设置 API 密钥' } }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是一个地方志资料整理助手。根据提供的资料内容，仅输出一个 JSON 对象，结构如下：' +
        '{"summary":"1-3 句话的内容摘要","keywords":["3-8 个主题关键词"],"entities":["关键实体，如人名、机构、地名、事件"]}。' +
        '不要输出 JSON 之外的任何文字。'
    },
    { role: 'user', content: `标题：《${source.title}》\n正文：\n${text.slice(0, MAX_INPUT_CHARS)}` }
  ]

  const result = await chatCompletion(
    { apiBase: provider.config.apiBase, model: provider.config.model, apiKey: provider.apiKey },
    messages,
    undefined,
    { kind: 'summarize' },
    { maxRetries: 1 }
  )
  if (!result.ok) return { ok: false, error: result.error }

  const raw = extractJson(result.text) as { summary?: unknown; keywords?: unknown; entities?: unknown } | null
  if (!raw || typeof raw.summary !== 'string' || !raw.summary.trim()) {
    return { ok: false, error: { code: ErrorCodes.LLM_FORMAT_INVALID, message: '模型输出无法解析为摘要结构' } }
  }
  const summary = raw.summary.trim()
  const keywords = Array.isArray(raw.keywords) ? raw.keywords.filter((k): k is string => typeof k === 'string').slice(0, 10) : []
  const entities = Array.isArray(raw.entities) ? raw.entities.filter((e): e is string => typeof e === 'string').slice(0, 10) : []

  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO source_summaries (source_id, summary, keywords, entities, llm_model, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       summary = excluded.summary,
       keywords = excluded.keywords,
       entities = excluded.entities,
       llm_model = excluded.llm_model,
       updated_at = excluded.updated_at`
  ).run(sourceId, summary, JSON.stringify(keywords), JSON.stringify(entities), provider.config.model, now)

  return { ok: true, summary: { sourceId, summary, keywords, entities, llmModel: provider.config.model, updatedAt: now } }
}

/** 整理所有尚无摘要的资料（逐篇调用 LLM） */
export async function summarizeAllPending(): Promise<{ processed: number; ok: number; failed: number }> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT s.id FROM sources s
       LEFT JOIN source_summaries ss ON ss.source_id = s.id
       WHERE ss.source_id IS NULL`
    )
    .all() as { id: string }[]
  let ok = 0
  let failed = 0
  for (const r of rows) {
    const res = await summarizeSource(r.id)
    if (res.ok) ok += 1
    else failed += 1
  }
  return { processed: rows.length, ok, failed }
}

/** 返回指定范围内尚无摘要的资料 id（幂等：已有摘要的不算待整理，不会重复整理） */
export function pendingSummarySourceIds(sourceIds: string[]): string[] {
  const db = getDb()
  if (sourceIds.length === 0) return []
  const placeholders = sourceIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT s.id FROM sources s
       LEFT JOIN source_summaries ss ON ss.source_id = s.id
       WHERE ss.source_id IS NULL AND s.id IN (${placeholders})`
    )
    .all(...sourceIds) as { id: string }[]
  return rows.map((r) => r.id)
}

/** 整理指定范围内尚无摘要的资料（Task 3.4.9：生成初稿前自动补齐；已整理的不重复处理） */
export async function summarizePendingForSourceIds(sourceIds: string[]): Promise<{ processed: number; ok: number; failed: number }> {
  const pending = pendingSummarySourceIds(sourceIds)
  let ok = 0
  let failed = 0
  for (const id of pending) {
    const res = await summarizeSource(id)
    if (res.ok) ok += 1
    else failed += 1
  }
  return { processed: pending.length, ok, failed }
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

  describe('summarizer store (Task 3.2.3)', () => {
    it('extracts JSON from fenced output', () => {
      const out = extractJson('```json\n{"summary":"摘要","keywords":["a"],"entities":["b"]}\n```')
      expect(out).toEqual({ summary: '摘要', keywords: ['a'], entities: ['b'] })
    })

    it('reads and round-trips summaries', () => {
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('ss1', 'file', '资料', '正文', 'ready')`
      ).run()
      db.prepare(
        `INSERT INTO source_summaries (source_id, summary, keywords, entities, llm_model, updated_at)
         VALUES ('ss1', '这是摘要', '["教育","发展"]', '["某学校"]', 'test-model', datetime('now'))`
      ).run()
      const s = getSourceSummary('ss1')
      expect(s).not.toBeNull()
      expect(s?.summary).toBe('这是摘要')
      expect(s?.keywords).toEqual(['教育', '发展'])
      expect(s?.entities).toEqual(['某学校'])
    })

    it('summarizeSource fails clearly without LLM provider configured', async () => {
      // 无 provider 配置 → 明确错误
      const res = await summarizeSource('ss1')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error.message).toContain('Provider')
    })

    it('pendingSummarySourceIds only returns sources without summary (idempotent, Task 3.4.9)', () => {
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('p1', 'file', '无摘要', '正文一', 'ready')`
      ).run()
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('p2', 'file', '有摘要', '正文二', 'ready')`
      ).run()
      // p2 已有摘要
      db.prepare(
        `INSERT INTO source_summaries (source_id, summary, keywords, entities, llm_model, updated_at)
         VALUES ('p2', '已有摘要', '[]', '[]', 'test-model', datetime('now'))`
      ).run()
      // 范围内：p1（无摘要）、p2（有摘要）、ss1（前序测试已建摘要）→ 只有 p1 待整理
      expect(pendingSummarySourceIds(['p1', 'p2', 'ss1'])).toEqual(['p1'])
      expect(pendingSummarySourceIds([])).toEqual([])
      // 已整理过的不再返回（不重复整理）
      expect(pendingSummarySourceIds(['p2'])).toEqual([])
      expect(pendingSummarySourceIds(['ss1'])).toEqual([])
    })
  })
}
