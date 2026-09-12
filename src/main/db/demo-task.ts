/**
 * demo-task.ts —— 演示用「测试任务（仅作为演示）」种子（2026-08-28）。
 * 仅用于新手教程展示三段式撰写闭环：预置对话历史、资料汇编（连续文档，含矛盾）、志书初稿。
 * 幂等：若已存在同标题任务则直接返回，不重复创建。
 */
import Database from 'better-sqlite3'
import type { WritingTask } from '../../shared/types'
import { DEMO_TASK_TITLE } from '../../shared/demo'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'
import { createTask, getTaskById, updateTaskInstruction } from './tasks'
import { addTaskMessage, listTaskMessages } from './task-messages'
import {
  createCompilation,
  insertCompilationContradictions,
  confirmCompilation,
  listCompilationsByTask,
  importCompilationIntoTask,
  ensureCompilationSources,
  upsertCompilationParagraphs,
  snapshotCompilationVersion
} from './compilations'
import { parseTimeLabel } from '../writing/compilation-document'
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

function seedCompileDemoTask(): WritingTask {
  const task = createTask({ title: DEMO_TASK_TITLE, mode: 'compile' })
  updateTaskInstruction(task.id, DEMO_INSTRUCTION)
  insertDemoSources(task.id)

  // 对话历史：撰写要求 + 生成摘要
  addTaskMessage(task.id, 'user', DEMO_INSTRUCTION, 'instruction')
  addTaskMessage(
    task.id,
    'assistant',
    '已生成资料汇编：7 段，1 组矛盾待处理。请审阅汇编内容并处理矛盾；需要修改可点右下角悬浮按钮与大模型对话，随时可点击「导出资料汇编」。',
    'notice'
  )

  /*
   * 资料汇编：连续文档（Phase 7.1 起的数据模型）。
   * 演示数据必须走**与真实生成管线相同**的落库路径（段落 upsert + 来源编号表 + v1 版本），
   * 否则演示汇编会缺少年份分节、来源圆标与版本基线，界面看起来"功能没生效"。
   * 来源编号按「正文中首次引用」的顺序 1..N 分配（与 `ensureCompilationSources` 同口径）。
   */
  const compilation = createCompilation({ taskId: task.id, title: DEMO_INSTRUCTION })
  const titleBySourceId = new Map(DEMO_SOURCES.map((s) => [s.id, s.title]))
  const ordinalBySourceId = new Map<string, number>()
  for (const it of DEMO_ITEMS) {
    if (!ordinalBySourceId.has(it.sourceId)) ordinalBySourceId.set(it.sourceId, ordinalBySourceId.size + 1)
  }
  const items = upsertCompilationParagraphs(
    compilation.id,
    DEMO_ITEMS.map((it) => {
      const time = parseTimeLabel(it.ts)
      return {
        sourceId: it.sourceId,
        text: it.excerpt,
        timeLabel: it.ts,
        year: time.year,
        month: time.month,
        day: time.day,
        timeConfidence: time.confidence,
        sourceOrdinal: ordinalBySourceId.get(it.sourceId),
        origin: 'generate' as const,
        revision: 1,
        kind: 'paragraph' as const
      }
    })
  )
  // 来源编号表（含引用计数，用于"删除来源影响多少段"的提示）
  ensureCompilationSources(
    compilation.id,
    DEMO_ITEMS.map((it) => ({ sourceId: it.sourceId, title: titleBySourceId.get(it.sourceId) ?? it.sourceId }))
  )
  snapshotCompilationVersion(compilation.id, 'generate')

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
  confirmCompilation(compilation.id)

  return getTaskById(task.id)!
}

/** 撰写初稿演示任务：从「生成汇编」演示任务导入其资料汇编，再预置志书初稿 */
function seedDraftDemoTask(compileDemo: WritingTask): WritingTask {
  const task = createTask({ title: DEMO_TASK_TITLE, mode: 'draft' })
  updateTaskInstruction(task.id, DEMO_INSTRUCTION)
  addTaskMessage(task.id, 'user', DEMO_INSTRUCTION, 'instruction')
  const comps = listCompilationsByTask(compileDemo.id)
  const srcComp = comps.find((c) => c.status === 'finalized')
  if (srcComp) {
    importCompilationIntoTask(task.id, srcComp)
    addTaskMessage(task.id, 'assistant', '已从「生成汇编」导入资料汇编：' + srcComp.title, 'notice')
  }
  addTaskMessage(task.id, 'assistant', '初稿《福州市学前教育事业发展概况》已生成，可继续编辑，也支持框选正文询问来源。', 'notice')

  // 志书初稿
  const draft = createDraft(task.id, 0)
  const rebuilt = replaceDraftSegments(draft.id, DEMO_DRAFT_MD)
  const seg = rebuilt?.segments.find((s) => s.heading === '一、总体情况')
  if (seg) addSegmentSource(seg.id, 'demo-src-prek', '第1段', '截至 2021 年，全市共有幼儿园 212 所，在园幼儿 11.8 万人。')

  return getTaskById(task.id)!
}

function getDemoTaskByMode(mode: 'compile' | 'draft'): WritingTask | null {
  const db = getDb()
  const row = db.prepare('SELECT id FROM writing_tasks WHERE title = ? AND mode = ? LIMIT 1').get(DEMO_TASK_TITLE, mode) as
    | { id: string }
    | undefined
  return row ? getTaskById(row.id) : null
}

/** 确保两个演示任务存在（幂等）：「生成汇编」一份（含汇编/矛盾/二次改动）、「撰写初稿」一份（导入汇编 + 初稿）。 */
export function ensureDemoTask(): WritingTask | null {
  try {
    let compileDemo = getDemoTaskByMode('compile')
    if (!compileDemo) compileDemo = seedCompileDemoTask()
    if (!getDemoTaskByMode('draft')) seedDraftDemoTask(compileDemo)
    return getTaskById(compileDemo.id)
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

  describe('demo task seed (两个功能区各一份，2026-09)', () => {
    it('creates compile demo (compilation/contradictions) and draft demo (imported compilation/draft)', () => {
      const task = ensureDemoTask()
      expect(task).not.toBeNull()
      expect(task!.title).toBe(DEMO_TASK_TITLE)
      expect(task!.userInstruction).toContain('学前教育')
      const msgs = listTaskMessages(task!.id)
      expect(msgs.length).toBeGreaterThanOrEqual(2)
      const comps = listCompilationsByTask(task!.id)
      expect(comps).toHaveLength(1)
      expect(comps[0].status).toBe('finalized')
      expect(comps[0].items).toHaveLength(7)
      expect(comps[0].contradictions).toHaveLength(1)
      expect(comps[0].contradictions[0].status).toBe('pending')

      // 撰写初稿演示任务：从生成汇编导入汇编 + 预置初稿
      const draftRows = getDb().prepare("SELECT id FROM writing_tasks WHERE title = ? AND mode = 'draft'").all(DEMO_TASK_TITLE) as { id: string }[]
      expect(draftRows).toHaveLength(1)
      const draftTask = getTaskById(draftRows[0].id)!
      const draftComps = listCompilationsByTask(draftTask.id)
      expect(draftComps).toHaveLength(1)
      expect(draftComps[0].status).toBe('finalized')
      const draft = getLatestDraftByTask(draftTask.id)
      expect(draft).not.toBeNull()
      expect(draft!.segments.length).toBeGreaterThanOrEqual(3)
    })

    it('is idempotent: second call does not duplicate the two demos', () => {
      const a = ensureDemoTask()!
      const b = ensureDemoTask()!
      expect(a.id).toBe(b.id)
      const total = getDb().prepare('SELECT COUNT(*) c FROM writing_tasks WHERE title = ?').get(DEMO_TASK_TITLE) as { c: number }
      expect(total.c).toBe(2)
      const compileCount = getDb().prepare("SELECT COUNT(*) c FROM writing_tasks WHERE title = ? AND mode = 'compile'").get(DEMO_TASK_TITLE) as { c: number }
      const draftCount = getDb().prepare("SELECT COUNT(*) c FROM writing_tasks WHERE title = ? AND mode = 'draft'").get(DEMO_TASK_TITLE) as { c: number }
      expect(compileCount.c).toBe(1)
      expect(draftCount.c).toBe(1)
    })
  })
}
