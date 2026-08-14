/**
 * task-messages.ts —— 撰写任务对话框消息仓储（Phase 3.5 后续：对话与痕迹持久化）。
 * role: user / assistant；kind: chat（对话）/ instruction（生成初稿的用户要求）/ notice（系统提示）。
 */
import Database from 'better-sqlite3'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

export type TaskMessageRole = 'user' | 'assistant'
export type TaskMessageKind = 'chat' | 'instruction' | 'notice'

export interface TaskMessage {
  id: string
  taskId: string
  role: TaskMessageRole
  kind: TaskMessageKind
  content: string
  createdAt: string
}

interface MessageRow {
  id: string
  task_id: string
  role: TaskMessageRole
  kind: TaskMessageKind
  content: string
  created_at: string
}

function rowToMessage(row: MessageRow): TaskMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    role: row.role,
    kind: row.kind,
    content: row.content,
    createdAt: row.created_at
  }
}

/** 读取任务的全部消息（按创建时间升序） */
export function listTaskMessages(taskId: string): TaskMessage[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(taskId) as MessageRow[]
  return rows.map(rowToMessage)
}

/** 追加一条任务消息（对话/指令/提示），返回写入的消息 */
export function addTaskMessage(taskId: string, role: TaskMessageRole, content: string, kind: TaskMessageKind = 'chat'): TaskMessage {
  const db = getDb()
  const id = crypto.randomUUID()
  db.prepare('INSERT INTO task_messages (id, task_id, role, kind, content) VALUES (?, ?, ?, ?, ?)').run(
    id,
    taskId,
    role,
    kind,
    content
  )
  return {
    id,
    taskId,
    role,
    kind,
    content,
    createdAt: new Date().toISOString()
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

  describe('task messages store (Phase 3.5: 对话与痕迹持久化)', () => {
    it('adds and lists messages in order (chat/instruction/notice)', () => {
      db.prepare(
        `INSERT INTO writing_tasks (id, title, scope_json, current_version, created_at, updated_at)
         VALUES ('t1', '新建任务', '{"all":true}', 0, ?, ?)`
      ).run(new Date().toISOString(), new Date().toISOString())

      addTaskMessage('t1', 'user', '这次撰写任务的标题为教育', 'instruction')
      addTaskMessage('t1', 'assistant', '初稿《教育》已生成。', 'notice')
      addTaskMessage('t1', 'user', '请修改第三段', 'chat')
      addTaskMessage('t1', 'assistant', '已按你的要求调整。', 'chat')

      const msgs = listTaskMessages('t1')
      expect(msgs).toHaveLength(4)
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
      expect(msgs.map((m) => m.kind)).toEqual(['instruction', 'notice', 'chat', 'chat'])
      expect(msgs[0].content).toBe('这次撰写任务的标题为教育')
    })

    it('cascades messages when task is deleted', () => {
      addTaskMessage('t1', 'user', 'x', 'chat')
      db.prepare('DELETE FROM writing_tasks WHERE id = ?').run('t1')
      expect(listTaskMessages('t1')).toHaveLength(0)
    })
  })
}
