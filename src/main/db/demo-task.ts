/**
 * demo-task.ts —— 演示用「测试任务（仅作为演示）」种子（2026-08-28）。
 * 仅用于新手教程展示三段式撰写闭环：预置对话历史、资料汇编（含矛盾与二次改动）、志书初稿。
 * 幂等：若已存在同标题任务则直接返回，不重复创建。
 */
import Database from 'better-sqlite3'
import type { WritingTask } from '../../shared/types'
import { DEMO_TASK_TITLE } from '../../shared/demo'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'
import { createTask, getTaskById, updateTaskInstruction } from './tasks'
import { addTaskMessage, listTaskMessages } from './task-messages'
import { createCompilation, insertCompilationItems, insertCompilationContradictions, confirmCompilation, listCompilationsByTask } from './compilations'
import { insertRepair } from './compilation-repairs'
import { createDraft, replaceDraftSegments, addSegmentSource, getLatestDraftByTask } from './drafts'

const DEMO_INSTRUCTION =
  '本次撰写任务：撰写福州市学前教育事业发展概况，包括园所数量与变化、新增与撤销、招生人数、幼儿园等级与各类占比等情况。'

const DEMO_SOURCES = [
  {
    id: 'demo-src-prek',
    title: '福州市学前教育发展报告',
    cleanedText:
      '2020 年，全市共有幼儿园 204 所，在园幼儿 10.9 万人。\n' +
      '2021 年，全市共有幼儿园 212 所，在园幼儿 11.8 万人。\n' +
      '2021 年，全市公办园占比 42%。\n' +
      '2021 年，全市新增幼儿园 6 所。\n' +
      '全市幼儿园教职工总数 1.2 万人，其中专任教师 0.9 万人。'
  },
  {
    id: 'demo-src-changle',
    title: '长乐区教育局统计',
    cleanedText:
      '2020 年，长乐区新增幼儿园 3 所。\n' +
      '2020 年，全区新增幼儿园 5 所。\n' +
      '2021 年，全区各类幼儿园共 96 所。'
  }
] as const

const DEMO_ITEMS = [
  { sourceId: 'demo-src-prek', excerpt: '2020 年，全市共有幼儿园 204 所，在园幼儿 10.9 万人。', ts: '2020 年' },
  { sourceId: 'demo-src-prek', excerpt: '2021 年，全市共有幼儿园 212 所，在园幼儿 11.8 万人。', ts: '2021 年' },
  { sourceId: 'demo-src-prek', excerpt: '2021 年，全市公办园占比 42%。', ts: '2021 年' },
  { sourceId: 'demo-src-prek', excerpt: '2021 年，全市新增幼儿园 6 所。', ts: '2021 年' },
  { sourceId: 'demo-src-changle', excerpt: '2020 年，全市新增幼儿园 3 所。', ts: '2020 年' },
  { sourceId: 'demo-src-changle', excerpt: '2020 年，全市新增幼儿园 5 所。', ts: '2020 年' },
  { sourceId: 'demo-src-prek', excerpt: '全市幼儿园教职工总数 1.2 万人。', ts: undefined }
] as const

const DEMO_DRAFT_MD = [
  '# 福州市学前教育事业发展概况',
  '',
  '本志记述福州市学前教育事业发展的总体情况、园所数量变化与办园结构。',
  '',
  '## 一、总体情况',
  '截至 2021 年，全市共有幼儿园 212 所，在园幼儿 11.8 万人，教职工 1.2 万人。',
  '',
  '## 二、园所数量变化',
  '2020 年全市共有幼儿园 204 所，2021 年增至 212 所，新增 6 所。',
  '',
  '## 三、办园结构',
  '全市公办园占比 42%，普惠性幼儿园覆盖率稳步提升。'
].join('\n')

function insertDemoSources(taskId: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  const ins = db.prepare(
    "INSERT INTO sources (id, kind, title, cleaned_text, status, workspace, task_id, created_at, updated_at) VALUES (?, 'file', ?, ?, 'ready', 0, ?, ?, ?)"
  )
  for (const s of DEMO_SOURCES) ins.run(s.id, s.title, s.cleanedText, taskId, now, now)
}

function seedDemoTask(): WritingTask {
  const task = createTask({ title: DEMO_TASK_TITLE })
  updateTaskInstruction(task.id, DEMO_INSTRUCTION)
  insertDemoSources(task.id)

  // 对话历史：撰写要求 + 生成摘要 + 初稿提示
  addTaskMessage(task.id, 'user', DEMO_INSTRUCTION, 'instruction')
  addTaskMessage(
    task.id,
    'assistant',
    '已生成资料汇编：7 张卡片，1 组矛盾待处理。请在第一步审阅资料卡片并处理矛盾，然后点击「确认汇编」。',
    'notice'
  )
  addTaskMessage(
    task.id,
    'assistant',
    '初稿《福州市学前教育事业发展概况》已生成，可在第三步查看并继续编辑，也支持框选正文询问来源。',
    'notice'
  )

  // 资料汇编：卡片 + 矛盾 + 二次改动（语义补全/修订）
  const compilation = createCompilation({ taskId: task.id, title: DEMO_INSTRUCTION })
  const items = insertCompilationItems(
    compilation.id,
    DEMO_ITEMS.map((it) => ({ sourceId: it.sourceId, excerpt: it.excerpt, ts: it.ts, extraTags: [] }))
  )
  const byExcerpt = new Map(items.map((it) => [it.excerpt, it]))
  const item5 = byExcerpt.get('2020 年，全市新增幼儿园 3 所。')
  const item6 = byExcerpt.get('2020 年，全市新增幼儿园 5 所。')
  if (item5 && item6) {
    insertCompilationContradictions(compilation.id, [
      {
        topic: '2020 年全市新增幼儿园数量',
        kind: 'data',
        variants: [
          { itemId: item5.id, variantText: item5.excerpt, sourceId: item5.sourceId },
          { itemId: item6.id, variantText: item6.excerpt, sourceId: item6.sourceId }
        ]
      }
    ])
  }
  const item7 = byExcerpt.get('全市幼儿园教职工总数 1.2 万人。')
  if (item7) {
    insertRepair({
      compilationId: compilation.id,
      itemId: item7.id,
      originalText: item7.excerpt,
      revisedText: '2021 年，全市幼儿园教职工共 1.2 万人，其中专任教师 0.9 万人。',
      reason: '表意不明：缺少年份与分项，疑为表格切片。'
    })
  }
  confirmCompilation(compilation.id)

  // 志书初稿
  const draft = createDraft(task.id, 0)
  const rebuilt = replaceDraftSegments(draft.id, DEMO_DRAFT_MD)
  const seg = rebuilt?.segments.find((s) => s.heading === '一、总体情况')
  if (seg) addSegmentSource(seg.id, 'demo-src-prek', '第1段', '截至 2021 年，全市共有幼儿园 212 所，在园幼儿 11.8 万人。')

  return getTaskById(task.id)!
}

/** 确保演示任务存在（幂等）：已存在同标题任务则不重复创建 */
export function ensureDemoTask(): WritingTask | null {
  const db = getDb()
  const existing = db.prepare('SELECT id FROM writing_tasks WHERE title = ? LIMIT 1').get(DEMO_TASK_TITLE) as
    | { id: string }
    | undefined
  if (existing) return getTaskById(existing.id)
  try {
    return seedDemoTask()
  } catch (err) {
    console.error('演示任务生成失败:', err)
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

  describe('demo task seed (2026-08-28)', () => {
    it('creates a demo task with messages/compilation/contradictions/repairs/draft', () => {
      const task = ensureDemoTask()
      expect(task).not.toBeNull()
      expect(task!.title).toBe(DEMO_TASK_TITLE)
      expect(task!.userInstruction).toContain('学前教育')
      const msgs = listTaskMessages(task!.id)
      expect(msgs.length).toBeGreaterThanOrEqual(3)
      const comps = listCompilationsByTask(task!.id)
      expect(comps).toHaveLength(1)
      expect(comps[0].status).toBe('finalized')
      expect(comps[0].items).toHaveLength(7)
      expect(comps[0].contradictions).toHaveLength(1)
      expect(comps[0].contradictions[0].status).toBe('pending')
      expect(comps[0].repairs).toHaveLength(1)
      const draft = getLatestDraftByTask(task!.id)
      expect(draft).not.toBeNull()
      expect(draft!.segments.length).toBeGreaterThanOrEqual(3)
    })

    it('is idempotent: second call returns the same task without duplicating', () => {
      const a = ensureDemoTask()!
      const b = ensureDemoTask()!
      expect(a.id).toBe(b.id)
      expect(listCompilationsByTask(a.id)).toHaveLength(1)
      const count = getDb().prepare('SELECT COUNT(*) c FROM writing_tasks WHERE title = ?').get(DEMO_TASK_TITLE) as { c: number }
      expect(count.c).toBe(1)
    })
  })
}
