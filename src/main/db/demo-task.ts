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
import { logMain } from '../logger'
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
      '2021 年，全区各类幼儿园共 96 所。\n' +
      // Phase 7.12 多来源标注演示：同一件事被两个来源分别记载（这段是"另一个出处"）
      '2021 年，全市共有幼儿园 212 所，在园幼儿 11.8 万人。'
  }
] as const

const DEMO_ITEMS = [
  { sourceId: 'demo-src-prek', excerpt: '2020 年，全市共有幼儿园 204 所，在园幼儿 10.9 万人。', ts: '2020 年' },
  // Phase 7.12：这一段由「福州市学前教育发展报告」与「长乐区教育局统计」共同记载 →
  // 汇编里段尾会出现**两个圆标**（1 与 2），点开小卡可看到本段的全部出处
  {
    sourceId: 'demo-src-prek',
    excerpt: '2021 年，全市共有幼儿园 212 所，在园幼儿 11.8 万人。',
    ts: '2021 年',
    alsoSourceIds: ['demo-src-changle']
  },
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

/**
 * 写入/回收两篇演示来源（**幂等，可自愈**）。
 *
 * ⚠ 2026-10-02 实测事故：这里原先用普通 `INSERT` + 固定 id。用户删掉演示任务后，
 * `sources` 行**并没有被一起删掉**（仍指向已不存在的 task），于是重建演示任务时
 * **主键冲突抛错 → 整个种子中途失败**（任务建好了，来源与汇编都没建），
 * 而 `ensureDemoTask` 把错误吞进 console.error、任务又按标题幂等 → **界面永远是空白演示任务**。
 *
 * 现在改为 `ON CONFLICT(id) DO UPDATE`：**就地更新**（不删行，因此不会触发任何级联），
 * 把旧演示来源重新认领到当前演示任务名下。演示来源 id 固定且仅演示使用，
 * 实测真实库里引用它们的段落/关系行/矛盾说法均为 0，重认领不触碰任何真实数据。
 */
function insertDemoSources(taskId: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  const ins = db.prepare(
    `INSERT INTO sources (id, kind, title, cleaned_text, status, workspace, task_id, created_at, updated_at)
     VALUES (?, 'file', ?, ?, 'ready', 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       cleaned_text = excluded.cleaned_text,
       status = 'ready',
       task_id = excluded.task_id,
       updated_at = excluded.updated_at`
  )
  for (const s of DEMO_SOURCES) ins.run(s.id, s.title, s.cleanedText, taskId, now, now)
}

/** 该演示任务是否已有内容（判断"空壳"用，决定是否需要自愈补齐） */
function hasCompileDemoContent(taskId: string): boolean {
  return listCompilationsByTask(taskId).length > 0
}

/** 该撰写初稿演示任务是否已有内容（导入的汇编 + 初稿） */
function hasDraftDemoContent(taskId: string): boolean {
  return listCompilationsByTask(taskId).length > 0 && getLatestDraftByTask(taskId) !== null
}

/**
 * 把「生成汇编」演示内容写进一个已存在的任务（幂等）：
 * 新建演示任务与**自愈空壳演示任务**共用这一段，避免两套口径。
 */
function seedCompileContent(task: WritingTask): WritingTask {
  updateTaskInstruction(task.id, DEMO_INSTRUCTION)
  insertDemoSources(task.id)

  // 对话历史：撰写要求 + 生成摘要（已存在时不重复追加，自愈场景下不会出现双份）
  if (listTaskMessages(task.id).length === 0) {
    addTaskMessage(task.id, 'user', DEMO_INSTRUCTION, 'instruction')
    addTaskMessage(
      task.id,
      'assistant',
      '已生成资料汇编：7 段，1 组矛盾待处理。请审阅汇编内容并处理矛盾；需要修改可点右下角悬浮按钮与大模型对话，随时可点击「导出资料汇编」。',
      'notice'
    )
  }

  /*
   * 资料汇编：连续文档（Phase 7.1 起的数据模型）。
   * 演示数据必须走**与真实生成管线相同**的落库路径（段落 upsert + 来源编号表 + v1 版本），
   * 否则演示汇编会缺少年份分节、来源圆标与版本基线，界面看起来"功能没生效"。
   * 来源编号按「正文中首次引用」的顺序 1..N 分配（与 `ensureCompilationSources` 同口径）。
   */
  const compilation = createCompilation({ taskId: task.id, title: DEMO_INSTRUCTION })
  const titleBySourceId = new Map(DEMO_SOURCES.map((s) => [s.id, s.title]))
  const ordinalBySourceId = new Map<string, number>()
  // Phase 7.12：并列来源也要占号（编号＝正文中首次引用顺序），否则演示里的第二个圆标没有编号
  for (const it of DEMO_ITEMS) {
    for (const sid of [it.sourceId, ...('alsoSourceIds' in it ? (it.alsoSourceIds ?? []) : [])]) {
      if (!ordinalBySourceId.has(sid)) ordinalBySourceId.set(sid, ordinalBySourceId.size + 1)
    }
  }
  const items = upsertCompilationParagraphs(
    compilation.id,
    DEMO_ITEMS.map((it) => {
      const time = parseTimeLabel(it.ts)
      return {
        sourceId: it.sourceId,
        alsoSourceIds: 'alsoSourceIds' in it ? [...(it.alsoSourceIds ?? [])] : undefined,
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
  // 来源编号表（含并列来源与实时引用计数，用于"删除来源影响多少段"的提示）
  ensureCompilationSources(
    compilation.id,
    DEMO_ITEMS.flatMap((it) =>
      [it.sourceId, ...('alsoSourceIds' in it ? (it.alsoSourceIds ?? []) : [])].map((sid) => ({
        sourceId: sid,
        title: titleBySourceId.get(sid) ?? sid
      }))
    )
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

/** 新建「生成汇编」演示任务（内容由 `seedCompileContent` 写） */
function seedCompileDemoTask(): WritingTask {
  return seedCompileContent(createTask({ title: DEMO_TASK_TITLE, mode: 'compile' }))
}

/** 把「撰写初稿」演示内容写进一个已存在的任务（幂等，可自愈空壳） */
function seedDraftContent(task: WritingTask, compileDemo: WritingTask): WritingTask {
  updateTaskInstruction(task.id, DEMO_INSTRUCTION)
  const srcComp = listCompilationsByTask(compileDemo.id).find((c) => c.status === 'finalized')
  /*
   * 导入汇编与"对话消息是否存在"**解耦**：自愈时任务往往已有旧消息、却没有汇编，
   * 若把导入写在消息判断里，就会出现"补了消息、仍没有汇编"的半修状态。
   */
  if (listCompilationsByTask(task.id).length === 0 && srcComp) {
    importCompilationIntoTask(task.id, srcComp)
  }
  if (listTaskMessages(task.id).length === 0) {
    addTaskMessage(task.id, 'user', DEMO_INSTRUCTION, 'instruction')
    if (srcComp) addTaskMessage(task.id, 'assistant', '已从「生成汇编」导入资料汇编：' + srcComp.title, 'notice')
    addTaskMessage(task.id, 'assistant', '初稿《福州市学前教育事业发展概况》已生成，可继续编辑，也支持框选正文询问来源。', 'notice')
  }

  // 志书初稿（已存在则不重复创建，自愈场景下不会产生第二份初稿）
  if (!getLatestDraftByTask(task.id)) {
    const draft = createDraft(task.id, 0)
    const rebuilt = replaceDraftSegments(draft.id, DEMO_DRAFT_MD)
    const seg = rebuilt?.segments.find((s) => s.heading === '一、总体情况')
    if (seg) addSegmentSource(seg.id, 'demo-src-prek', '第1段', '截至 2021 年，全市共有幼儿园 212 所，在园幼儿 11.8 万人。')
  }

  return getTaskById(task.id)!
}

/** 新建「撰写初稿」演示任务 */
function seedDraftDemoTask(compileDemo: WritingTask): WritingTask {
  return seedDraftContent(createTask({ title: DEMO_TASK_TITLE, mode: 'draft' }), compileDemo)
}

function getDemoTaskByMode(mode: 'compile' | 'draft'): WritingTask | null {
  const db = getDb()
  const r = db.prepare('SELECT id FROM writing_tasks WHERE title = ? AND mode = ? LIMIT 1').get(DEMO_TASK_TITLE, mode) as
    | { id: string }
    | undefined
  return r ? getTaskById(r.id) : null
}

/**
 * 确保两个演示任务存在（幂等）：「生成汇编」一份（含汇编/矛盾/二次改动）、「撰写初稿」一份（导入汇编 + 初稿）。
 *
 * **自愈（2026-10-02 实测事故后新增）**：演示任务是按标题幂等的，一旦上一次种子在中途失败
 * （历史缺陷：演示来源固定 id 撞主键 → 抛错 → 只留下一个"空壳任务"），旧实现会**永远不再重试**，
 * 用户看到的就是一个点进去什么都没有的演示任务。现在改为：任务在但**内容缺失**时补齐内容，
 * 且失败不再只落 console（改为项目诊断日志，可在设置页「导出日志」里看到）。
 */
export function ensureDemoTask(): WritingTask | null {
  try {
    let compileDemo = getDemoTaskByMode('compile')
    if (!compileDemo) {
      compileDemo = seedCompileDemoTask()
    } else if (!hasCompileDemoContent(compileDemo.id)) {
      logMain('demo', '演示任务（生成汇编）缺少内容，自动补齐')
      compileDemo = seedCompileContent(compileDemo)
    }
    const draftDemo = getDemoTaskByMode('draft')
    if (!draftDemo) {
      seedDraftDemoTask(compileDemo)
    } else if (!hasDraftDemoContent(draftDemo.id)) {
      logMain('demo', '演示任务（撰写初稿）缺少内容，自动补齐')
      seedDraftContent(draftDemo, compileDemo)
    }
    return getTaskById(compileDemo.id)
  } catch (err) {
    // 不再静默：写入项目诊断日志（设置页「导出日志」可见），便于用户与开发者定位
    logMain('demo', '演示任务生成失败：' + String(err), 'ERROR')
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
      // Phase 7.12 多来源标注：演示汇编里有一段由两个来源共同记载（段尾两个圆标可用）
      const multi = comps[0].items.find((it) => (it.alsoSourceOrdinals ?? []).length > 0)
      expect(multi).toBeDefined()
      expect(multi!.alsoSourceOrdinals).toEqual([2])
      expect(multi!.alsoSourceTitles).toEqual(['长乐区教育局统计'])

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

    it('idempotent: second call does not duplicate the two demos', () => {
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

    /*
     * 2026-10-02 用户实测事故回归：删掉演示任务后重建，界面是空白演示任务。
     * 根因两条，本用例把它们都钉住：
     *  ① 演示来源固定 id + 普通 INSERT → 用户删任务时 sources 行留下 → 重建时主键冲突抛错，种子中途失败；
     *  ② 任务按标题幂等 + 错误被吞 → 空壳任务永远不再补齐。
     */
    it('recovers when orphaned demo sources remain (PK conflict used to abort the seed)', () => {
      // 造出"上一次删除留下的孤儿来源"：把演示任务删掉，但**保留** sources 与其中一篇的旧绑定
      getDb().prepare("DELETE FROM writing_tasks WHERE title = ? AND mode = 'compile'").run(DEMO_TASK_TITLE)
      const orphan = getDb().prepare("SELECT id, task_id FROM sources WHERE id = 'demo-src-prek'").get() as {
        id: string
        task_id: string | null
      }
      expect(orphan).toBeDefined()
      getDb().prepare("UPDATE sources SET task_id = 'ghost-task' WHERE id = 'demo-src-prek'").run()

      // 再次确保：不应抛错，且应重新建出**有内容**的演示任务
      const task = ensureDemoTask()
      expect(task).not.toBeNull()
      const comps = listCompilationsByTask(task!.id)
      expect(comps).toHaveLength(1)
      expect(comps[0].items).toHaveLength(7)
      // 演示来源被重新认领到当前任务（就地更新，不产生新的孤儿）
      const reclaimed = getDb().prepare("SELECT task_id FROM sources WHERE id = 'demo-src-prek'").get() as { task_id: string }
      expect(reclaimed.task_id).toBe(task!.id)
      const srcCount = getDb().prepare("SELECT COUNT(*) c FROM sources WHERE id LIKE 'demo-src-%'").get() as { c: number }
      expect(srcCount.c).toBe(2)
    })

    it('heals an existing but empty demo task instead of leaving it blank forever', () => {
      // 造出"空壳任务"（正是用户看到的状态：任务在、内容全无）
      const compileTask = getDemoTaskByMode('compile')!
      getDb().prepare('DELETE FROM compilations WHERE task_id = ?').run(compileTask.id)
      getDb().prepare('DELETE FROM task_messages WHERE task_id = ?').run(compileTask.id)
      expect(listCompilationsByTask(compileTask.id)).toHaveLength(0)

      const healed = ensureDemoTask()!
      expect(healed.id).toBe(compileTask.id) // 复用原任务，不新建第二个
      const comps = listCompilationsByTask(healed.id)
      expect(comps).toHaveLength(1)
      expect(comps[0].items).toHaveLength(7)
      expect(listTaskMessages(healed.id).length).toBeGreaterThanOrEqual(2)
      const total = getDb().prepare('SELECT COUNT(*) c FROM writing_tasks WHERE title = ?').get(DEMO_TASK_TITLE) as { c: number }
      expect(total.c).toBe(2)

      // 撰写初稿演示任务同理：即便它**已有对话消息**但缺汇编，也要把汇编补进来（半修状态回归）
      const draftTask = getDemoTaskByMode('draft')!
      getDb().prepare('DELETE FROM compilations WHERE task_id = ?').run(draftTask.id)
      expect(listCompilationsByTask(draftTask.id)).toHaveLength(0)
      expect(listTaskMessages(draftTask.id).length).toBeGreaterThan(0)
      ensureDemoTask()
      expect(listCompilationsByTask(draftTask.id)).toHaveLength(1)
      expect(getLatestDraftByTask(draftTask.id)).not.toBeNull()
    })
  })
}
