/**
 * connection.ts —— 单例数据库连接，启动时自动运行迁移。
 * 用 better-sqlite3 原生同步驱动，外键 + WAL 模式。
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { runMigrations, MIGRATIONS } from './migrate'

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  const dbPath = join(app.getPath('userData'), 'xie-zhishu.db')

  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')

  runMigrations(_db)

  return _db
}

/** 仅用于测试 */
export function setDb(db: Database.Database): void {
  _db = db
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

  describe('database connection (Task 1.3)', () => {
    it('creates all core tables', () => {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='view' ORDER BY name")
        .all() as { name: string }[]
      const names = rows.map((r) => r.name)
      expect(names).toContain('sources')
      expect(names).toContain('tags')
      expect(names).toContain('source_tags')
      expect(names).toContain('template_books')
      expect(names).toContain('writing_tasks')
      expect(names).toContain('drafts')
      expect(names).toContain('segments')
      expect(names).toContain('segment_sources')
      expect(names).toContain('review_records')
      expect(names).toContain('settings')
      expect(names).toContain('schema_migrations')
      expect(names).toContain('sources_fts')
    })

    it('migration is idempotent', () => {
      runMigrations(db)
      const { count } = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number }
      expect(count).toBe(MIGRATIONS.length)
    })

    it('sources CRUD works', () => {
      const id = crypto.randomUUID()
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', ?, 'some content', 'pending')`
      ).run(id, '测试文件.pdf')

      const row = db.prepare('SELECT title, status FROM sources WHERE id = ?').get(id) as {
        title: string
        status: string
      }
      expect(row.title).toBe('测试文件.pdf')
      expect(row.status).toBe('pending')

      db.prepare('UPDATE sources SET status = ? WHERE id = ?').run('ready', id)
      const updated = db.prepare('SELECT status FROM sources WHERE id = ?').get(id) as { status: string }
      expect(updated.status).toBe('ready')

      db.prepare('DELETE FROM sources WHERE id = ?').run(id)
      expect(db.prepare('SELECT id FROM sources WHERE id = ?').get(id)).toBeUndefined()
    })

    it('FTS5 trigger syncs rowids on insert and delete', () => {
      const id = crypto.randomUUID()
      db.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'url', 'FTS Test Title', 'searchable body content', 'ready')`
      ).run(id)

      // 验证触发器已将行写入 FTS5 表
      const source = db.prepare('SELECT rowid FROM sources WHERE id = ?').get(id) as { rowid: number }
      const ftsRow = db.prepare('SELECT title FROM sources_fts WHERE rowid = ?').get(source.rowid) as {
        title: string
      } | undefined
      expect(ftsRow).toBeDefined()
      expect(ftsRow!.title).toBe('FTS Test Title')

      // 英文分词搜索可命中
      const matchRow = db.prepare("SELECT rowid FROM sources_fts WHERE sources_fts MATCH 'searchable'").get() as {
        rowid: number
      } | undefined
      expect(matchRow).toBeDefined()

      db.prepare('DELETE FROM sources WHERE id = ?').run(id)
      const after = db.prepare('SELECT title FROM sources_fts WHERE rowid = ?').get(source.rowid)
      expect(after).toBeUndefined()
    })

    it('migration 004 strips legacy [tag:] title prefixes', () => {
      // 模拟升级前状态：仅应用迁移 1-3，并写入带旧前缀的历史标题
      const old = new Database(':memory:')
      old.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      const insertMigration = old.prepare('INSERT INTO schema_migrations (version) VALUES (?)')
      const applyAll = old.transaction(() => {
        for (const m of MIGRATIONS.filter((x) => x.version < 4)) {
          if (m.sql) old.exec(m.sql)
          insertMigration.run(m.version)
        }
      })
      applyAll()
      old.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('legacy1', 'file', '[tag:小学教育] 资料标题A', '', 'ready')`
      ).run()
      old.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('legacy2', 'file', '[tag:小学教育] [tag:新区经济] 资料标题B', '', 'ready')`
      ).run()
      old.prepare(
        `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('legacy3', 'file', '无前缀的标题', '', 'ready')`
      ).run()

      // 升级：应用迁移 4
      runMigrations(old)

      const getTitle = (id: string): string =>
        (old.prepare('SELECT title FROM sources WHERE id = ?').get(id) as { title: string }).title
      expect(getTitle('legacy1')).toBe('资料标题A')
      expect(getTitle('legacy2')).toBe('资料标题B')
      expect(getTitle('legacy3')).toBe('无前缀的标题')
      old.close()
    })

    it('migration 015 dedupes duplicate workspace files and enforces unique path (2026-08-20)', () => {
      // 模拟升级前状态：仅应用迁移 1-14
      const old = new Database(':memory:')
      old.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      const insertMigration = old.prepare('INSERT INTO schema_migrations (version) VALUES (?)')
      const applyAll = old.transaction(() => {
        for (const m of MIGRATIONS.filter((x) => x.version < 15)) {
          if (m.sql) old.exec(m.sql)
          insertMigration.run(m.version)
        }
      })
      applyAll()
      // 同路径的重复工作区资料（模拟并发对账重复入库）+ 一条同路径的非工作区存量资料（不应被误删）
      const insert = old.prepare(
        `INSERT INTO sources (id, kind, title, file_path, cleaned_text, status, workspace)
         VALUES (?, 'file', ?, ?, '', 'ready', ?)`
      )
      insert.run('dup-early', 'a.txt', 'a.txt', 1)
      insert.run('dup-late', 'a.txt', 'a.txt', 1)
      insert.run('legacy-same', 'a.txt', 'a.txt', 0)
      insert.run('unique-other', 'b.txt', 'b.txt', 1)

      // 升级：应用迁移 15（去重 + 部分唯一索引）
      runMigrations(old)

      // 每个 workspace 文件路径只保留最早一条（本用例中 dup-early 保留）
      const rows = old
        .prepare('SELECT id, workspace FROM sources WHERE file_path = ? ORDER BY workspace DESC, id ASC')
        .all('a.txt') as { id: string; workspace: number }[]
      expect(rows.map((r) => r.id).sort()).toEqual(['dup-early', 'legacy-same'])
      expect(old.prepare('SELECT COUNT(*) AS c FROM sources WHERE id = ?').get('dup-late') as { c: number }).toEqual({ c: 0 })

      // 唯一索引生效：再次插入同路径的 workspace 文件必须失败
      expect(() => insert.run('dup-again', 'a.txt', 'a.txt', 1)).toThrow()
      // 不同路径 / 非工作区（workspace=0）不受唯一索引约束
      expect(() => insert.run('legacy-again', 'a.txt', 'a.txt', 0)).not.toThrow()
      old.close()
    })

    it('migration 029 turns repairs into applied/reverted, applies pending text and drops the repair recycle bin (2026-09-08)', () => {
      // 模拟升级前状态：应用迁移 1-28（含 028 的清库，故测试数据在其后插入）
      const old = new Database(':memory:')
      old.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      const insertMigration = old.prepare('INSERT INTO schema_migrations (version) VALUES (?)')
      const applyAll = old.transaction(() => {
        for (const m of MIGRATIONS.filter((x) => x.version < 29)) {
          if (m.run) m.run(old)
          else if (m.sql) old.exec(m.sql)
          insertMigration.run(m.version)
        }
      })
      applyAll()

      // 旧数据：已采纳 / 未裁定 / 已拒绝三种修订，各对应一张卡片
      old.prepare("INSERT INTO writing_tasks (id, title, scope_json) VALUES ('t1','汇编测试','{\"all\":true}')").run()
      old.prepare("INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES ('s1','file','报告','正文','ready')").run()
      old.prepare(
        "INSERT INTO compilations (id, task_id, title, status, created_at, updated_at) VALUES ('c1','t1','汇编','drafting','2026-01-01','2026-01-01')"
      ).run()
      const insItem = old.prepare(
        "INSERT INTO compilation_items (id, compilation_id, position, source_id, excerpt, extra_tags, kept, created_at) VALUES (?, 'c1', ?, 's1', ?, '[]', 1, '2026-01-01')"
      )
      insItem.run('i1', 0, '原文一')
      insItem.run('i2', 1, '原文二')
      insItem.run('i3', 2, '原文三')
      const insRepair = old.prepare(
        "INSERT INTO compilation_repairs (id, compilation_id, item_id, original_text, revised_text, reason, status, created_at, updated_at) VALUES (?, 'c1', ?, ?, ?, '理由', ?, '2026-01-01','2026-01-01')"
      )
      insRepair.run('r1', 'i1', '原文一', '修正一', 'accepted')
      insRepair.run('r2', 'i2', '原文二', '修正二', 'pending')
      insRepair.run('r3', 'i3', '原文三', '修正三', 'rejected')
      old.prepare(
        "INSERT INTO compilation_repair_recycle_bin (id, compilation_id, repair_id, item_id, original_text, revised_text, chosen, created_at) VALUES ('b1','c1','r1','i1','原文一','修正一','accepted','2026-01-01')"
      ).run()

      runMigrations(old)

      // accepted 保留为 applied；pending 按“默认采纳”口径转为 applied；rejected 丢弃
      const statuses = old.prepare('SELECT id, status FROM compilation_repairs ORDER BY id').all() as { id: string; status: string }[]
      expect(statuses).toEqual([
        { id: 'r1', status: 'applied' },
        { id: 'r2', status: 'applied' }
      ])
      // pending 的修订文本写入卡片；accepted 的卡片此前已应用，不重复改写
      expect((old.prepare('SELECT excerpt FROM compilation_items WHERE id = ?').get('i2') as { excerpt: string }).excerpt).toBe('修正二')
      expect((old.prepare('SELECT excerpt FROM compilation_items WHERE id = ?').get('i1') as { excerpt: string }).excerpt).toBe('原文一')
      // 回收站表已删除，不再收录该类条目
      const tbl = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='compilation_repair_recycle_bin'").all()
      expect(tbl).toHaveLength(0)
      // 新状态约束生效：只允许 applied / reverted
      expect(() =>
        old
          .prepare(
            "INSERT INTO compilation_repairs (id, compilation_id, item_id, original_text, revised_text, reason, status, created_at, updated_at) VALUES ('x','c1','i1','a','b','c','pending','2026-01-01','2026-01-01')"
          )
          .run()
      ).toThrow()
      old.close()
    })
  })
}
