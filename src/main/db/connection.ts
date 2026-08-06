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
  })
}
