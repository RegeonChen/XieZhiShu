/**
 * tasks.ts —— 撰写任务仓储。
 */
import Database from 'better-sqlite3'
import type { WritingScope, WritingTask } from '../../shared/types'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

interface TaskRow {
  id: string
  title: string
  scope_json: string
  template_book_id: string | null
  llm_provider_id: string | null
  article_title: string | null
  user_instruction: string | null
  skill_ids: string | null
  current_version: number
  created_at: string
  updated_at: string
}

function parseSkillIds(raw: string | null): string[] | undefined {
  if (raw == null) return undefined
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
  } catch {
    return undefined
  }
}

function rowToTask(row: TaskRow): WritingTask {
  let scope: WritingScope
  try {
    scope = JSON.parse(row.scope_json) as WritingScope
  } catch {
    scope = { all: true }
  }
  return {
    id: row.id,
    title: row.title,
    scope,
    templateBookId: row.template_book_id ?? undefined,
    skillIds: parseSkillIds(row.skill_ids),
    llmProviderId: row.llm_provider_id ?? undefined,
    articleTitle: row.article_title ?? undefined,
    userInstruction: row.user_instruction ?? undefined,
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function getTaskRowById(id: string): TaskRow | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM writing_tasks WHERE id = ?').get(id) as TaskRow | undefined
}

export interface CreateTaskInput {
  /** 中栏显示的任务标题；缺省为"新建任务"（用户可右键重命名） */
  title?: string
  /** 文件范围；缺省为 { all: true }（资料库全部文件，Phase 3.5 起固定） */
  scope?: WritingScope
  llmProviderId?: string
}

export function createTask(input: CreateTaskInput = {}): WritingTask {
  const title = (input.title ?? '新建任务').trim() || '新建任务'
  const scope: WritingScope = input.scope ?? { all: true }
  if (input.llmProviderId) {
    const db = getDb()
    const exists = db.prepare('SELECT id FROM llm_providers WHERE id = ?').get(input.llmProviderId)
    if (!exists) throw new Error('指定的大模型不存在')
  }

  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO writing_tasks (id, title, scope_json, template_book_id, llm_provider_id, current_version, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 0, ?, ?)`
  ).run(id, title, JSON.stringify(scope), input.llmProviderId ?? null, now, now)
  const row = getTaskRowById(id)
  return rowToTask(row!)
}

/** 重命名任务标题（仅影响中栏列表显示；与文章标题 articleTitle 无关） */
export function renameTask(id: string, title: string): WritingTask | null {
  const t = title.trim()
  if (!t) throw new Error('任务标题不能为空')
  const db = getDb()
  if (!getTaskRowById(id)) return null
  db.prepare('UPDATE writing_tasks SET title = ?, updated_at = ? WHERE id = ?').run(t, new Date().toISOString(), id)
  const row = getTaskRowById(id)
  return rowToTask(row!)
}

/** 更新任务固定使用的大模型（llmProviderId 为 null = 回退全局当前 Provider） */
export function updateTaskProvider(taskId: string, llmProviderId: string | null): WritingTask | null {
  const db = getDb()
  if (!getTaskRowById(taskId)) return null
  if (llmProviderId) {
    const exists = db.prepare('SELECT id FROM llm_providers WHERE id = ?').get(llmProviderId)
    if (!exists) throw new Error('指定的大模型不存在')
  }
  db.prepare('UPDATE writing_tasks SET llm_provider_id = ?, updated_at = ? WHERE id = ?').run(llmProviderId, new Date().toISOString(), taskId)
  const row = getTaskRowById(taskId)
  return rowToTask(row!)
}

/** 保存大模型抓取的文章标题（生成初稿后由大模型返回） */
export function updateTaskArticleTitle(taskId: string, articleTitle: string): WritingTask | null {
  const db = getDb()
  if (!getTaskRowById(taskId)) return null
  db.prepare('UPDATE writing_tasks SET article_title = ?, updated_at = ? WHERE id = ?').run(articleTitle, new Date().toISOString(), taskId)
  const row = getTaskRowById(taskId)
  return rowToTask(row!)
}

/** 保存生成初稿时用户的最新要求（重新生成初稿复用） */
export function updateTaskInstruction(taskId: string, instruction: string): WritingTask | null {
  const db = getDb()
  if (!getTaskRowById(taskId)) return null
  db.prepare('UPDATE writing_tasks SET user_instruction = ?, updated_at = ? WHERE id = ?').run(instruction, new Date().toISOString(), taskId)
  const row = getTaskRowById(taskId)
  return rowToTask(row!)
}

/** 保存任务选定的部类细则规范 skill id 列表（null = 未手动选定，生成时按标题自动匹配） */
export function updateTaskSkillIds(taskId: string, skillIds: string[] | null): WritingTask | null {
  const db = getDb()
  if (!getTaskRowById(taskId)) return null
  db.prepare('UPDATE writing_tasks SET skill_ids = ?, updated_at = ? WHERE id = ?').run(
    skillIds == null ? null : JSON.stringify(skillIds),
    new Date().toISOString(),
    taskId
  )
  const row = getTaskRowById(taskId)
  return rowToTask(row!)
}

export function listTasks(): WritingTask[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM writing_tasks ORDER BY created_at DESC').all() as TaskRow[]
  return rows.map(rowToTask)
}

export function getTaskById(id: string): WritingTask | null {
  const row = getTaskRowById(id)
  return row ? rowToTask(row) : null
}

/** 删除撰写任务（drafts/segments/segment_sources 由外键级联清理；该任务绑定的网页缓存文章一并删除） */
export function deleteTask(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM sources WHERE task_id = ?').run(id)
  db.prepare('DELETE FROM writing_tasks WHERE id = ?').run(id)
}

/** 资料库（工作区）全部长期资料 id；任务绑定的网页缓存文章（task_id 非空）不计入，由生成时显式并入 scope */
export function getAllSourceIds(): string[] {
  const db = getDb()
  const rows = db.prepare('SELECT id FROM sources WHERE task_id IS NULL').all() as { id: string }[]
  return rows.map((r) => r.id)
}

/** 解析任务范围到具体资料 ID（{all:true} → 全部文件；标签范围展开为关联资料） */
export function resolveScopeSourceIds(
  task: WritingTask,
  deps: { getSourceIdsByTag: (tagId: string) => string[]; getAllSourceIds: () => string[] }
): string[] {
  const scope = task.scope
  if ('all' in scope) return deps.getAllSourceIds()
  if ('sourceIds' in scope) return scope.sourceIds
  const ids = scope.tagIds.flatMap((tid) => deps.getSourceIdsByTag(tid))
  return Array.from(new Set(ids))
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

  describe('writing task store (Task 3.3)', () => {
    it('creates and lists tasks with scope', () => {
      const t = createTask({ title: '新区教育发展', scope: { sourceIds: ['s1', 's2'] } })
      expect(t.title).toBe('新区教育发展')
      expect(t.currentVersion).toBe(0)
      const items = listTasks()
      expect(items).toHaveLength(1)
      expect(getTaskById(t.id)?.scope).toEqual({ sourceIds: ['s1', 's2'] })
    })

    it('creates task with defaults: title "新建任务" and scope {all:true} (Phase 3.5)', () => {
      const t = createTask()
      expect(t.title).toBe('新建任务')
      expect(t.scope).toEqual({ all: true })
      expect(t.llmProviderId).toBeUndefined()
    })

    it('renames task title (only list display title)', () => {
      const t = createTask()
      const renamed = renameTask(t.id, '2025年年鉴·教育卷')
      expect(renamed?.title).toBe('2025年年鉴·教育卷')
      expect(renameTask('no-such-task', 'x')).toBeNull()
      expect(() => renameTask(t.id, '  ')).toThrow('标题')
    })

    it('updates task provider / article title / instruction (Phase 3.5)', () => {
      db.prepare(
        `INSERT INTO llm_providers (id, name, api_base, model) VALUES ('prov1', '本地模型', 'http://x', 'qwen')`
      ).run()
      const t = createTask()
      const withProv = updateTaskProvider(t.id, 'prov1')
      expect(withProv?.llmProviderId).toBe('prov1')
      expect(updateTaskProvider(t.id, null)?.llmProviderId).toBeUndefined()
      expect(updateTaskProvider('no-such-task', null)).toBeNull()
      expect(() => updateTaskProvider(t.id, 'no-such-provider')).toThrow('大模型')

      const titled = updateTaskArticleTitle(t.id, '教育事业')
      expect(titled?.articleTitle).toBe('教育事业')

      const instructed = updateTaskInstruction(t.id, '这次撰写任务的标题为教育事业')
      expect(instructed?.userInstruction).toContain('教育事业')
    })

    it('resolves tag scope to source ids', () => {
      const tagIds = ['t1']
      const deps = {
        getSourceIdsByTag: (id: string) => (id === 't1' ? ['a', 'b', 'a'] : []),
        getAllSourceIds: () => ['all1']
      }
      const resolved = resolveScopeSourceIds({ id: 'x', title: 't', scope: { tagIds }, currentVersion: 0, createdAt: '', updatedAt: '' }, deps)
      expect(resolved).toEqual(['a', 'b'])
    })

    it('resolves {all:true} scope to all source ids (Phase 3.5)', () => {
      const resolved = resolveScopeSourceIds(
        { id: 'x', title: 't', scope: { all: true }, currentVersion: 0, createdAt: '', updatedAt: '' },
        { getSourceIdsByTag: () => [], getAllSourceIds: () => ['a1', 'b2'] }
      )
      expect(resolved).toEqual(['a1', 'b2'])
    })

    it('updates task skill ids (2026-08-13)', () => {
      const t = createTask({ title: '规范任务', scope: { sourceIds: ['s1'] } })
      expect(t.skillIds).toBeUndefined()

      const updated = updateTaskSkillIds(t.id, ['sk1', 'sk2'])
      expect(updated?.skillIds).toEqual(['sk1', 'sk2'])

      const cleared = updateTaskSkillIds(t.id, null)
      expect(cleared?.skillIds).toBeUndefined()

      expect(updateTaskSkillIds('no-such-task', ['sk1'])).toBeNull()
    })

    it('deletes task and cascades drafts/segments', () => {
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s1', 'file', '资料', '', 'ready')`
      ).run()
      const t = createTask({ title: '待删除任务', scope: { sourceIds: ['s1'] } })
      db.prepare(
        `INSERT INTO drafts (id, task_id, version_number, status) VALUES ('d1', ?, 0, 'editing')`
      ).run(t.id)
      db.prepare(
        `INSERT INTO segments (id, draft_id, ordering, content, ai_generated) VALUES ('seg1', 'd1', 0, '内容', 1)`
      ).run()
      db.prepare(
        `INSERT INTO segment_sources (segment_id, source_id, position) VALUES ('seg1', 's1', '第1段')`
      ).run()

      deleteTask(t.id)

      expect(getTaskById(t.id)).toBeNull()
      expect(db.prepare("SELECT COUNT(*) AS c FROM drafts WHERE task_id = ?").get(t.id) as { c: number }).toEqual({ c: 0 })
      expect(db.prepare('SELECT COUNT(*) AS c FROM segments WHERE id = ?').get('seg1') as { c: number }).toEqual({ c: 0 })
      expect(db.prepare('SELECT COUNT(*) AS c FROM segment_sources WHERE segment_id = ?').get('seg1') as { c: number }).toEqual({ c: 0 })
    })
  })
}
