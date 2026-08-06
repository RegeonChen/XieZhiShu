/**
 * 迁移框架 —— 迁移定义内嵌在代码中（避免 .sql 文件打包路径问题）。
 * 迁移按编号依次执行，已执行过的跳过。
 */
import type Database from 'better-sqlite3'

interface Migration {
  version: number
  /** SQL 迁移（与 run 二选一） */
  sql?: string
  /** JS 迁移（需要逐行处理数据时使用） */
  run?: (db: Database.Database) => void
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'url')),
    title TEXT NOT NULL,
    file_path TEXT,
    url TEXT,
    url_snapshot_at TEXT,
    raw_text TEXT,
    cleaned_text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
    error_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS source_tags (
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (source_id, tag_id)
);

CREATE TABLE IF NOT EXISTS template_books (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    outline_json TEXT NOT NULL,
    style_profile_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS writing_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    template_book_id TEXT REFERENCES template_books(id) ON DELETE SET NULL,
    current_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES writing_tasks(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'editing' CHECK (status IN ('editing', 'confirmed')),
    confirmed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (task_id, version_number)
);

CREATE TABLE IF NOT EXISTS segments (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    ordering INTEGER NOT NULL,
    heading TEXT,
    content TEXT NOT NULL DEFAULT '',
    ai_generated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (draft_id, ordering)
);

CREATE TABLE IF NOT EXISTS segment_sources (
    segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    position TEXT NOT NULL,
    quote TEXT,
    PRIMARY KEY (segment_id, source_id, position)
);

CREATE TABLE IF NOT EXISTS review_records (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    segment_id TEXT REFERENCES segments(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (action IN ('conflict', 'missing', 'edit', 'insert')),
    before_content TEXT,
    after_content TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 全文检索（独立表，触发器自动同步 sources 表变更）
CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(
    title,
    cleaned_text
);

-- FTS5 同步触发器
DROP TRIGGER IF EXISTS sources_fts_ai;
CREATE TRIGGER sources_fts_ai AFTER INSERT ON sources BEGIN
    INSERT INTO sources_fts(rowid, title, cleaned_text)
    VALUES (new.rowid, new.title, new.cleaned_text);
END;

DROP TRIGGER IF EXISTS sources_fts_ad;
CREATE TRIGGER sources_fts_ad AFTER DELETE ON sources BEGIN
    DELETE FROM sources_fts WHERE rowid = old.rowid;
END;

DROP TRIGGER IF EXISTS sources_fts_au;
CREATE TRIGGER sources_fts_au AFTER UPDATE ON sources BEGIN
    DELETE FROM sources_fts WHERE rowid = old.rowid;
    INSERT INTO sources_fts(rowid, title, cleaned_text)
    VALUES (new.rowid, new.title, new.cleaned_text);
END;
`
  },
  {
    // 移除标签颜色功能（2026-08-05）：标签统一显示，不再支持自定义颜色
    version: 2,
    sql: `
ALTER TABLE tags DROP COLUMN color;
`
  },
  {
    // LLM Provider 配置（Phase 3 Task 3.1）：api_key 存 safeStorage 加密串（safe-storage:v1:...）
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS llm_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    api_base TEXT NOT NULL,
    model TEXT NOT NULL,
    api_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`
  },
  {
    // 移除"标签嵌入标题"机制（2026-08-05）：清理历史数据中残留的 [tag:...] 标题前缀
    version: 4,
    run: (db) => {
      const rows = db.prepare("SELECT id, title FROM sources WHERE title LIKE '[tag:%'").all() as {
        id: string
        title: string
      }[]
      const strip = (title: string): string => title.replace(/^(?:\[tag:[^\]\r\n]+\]\s*)+/, '').trim()
      const stmt = db.prepare('UPDATE sources SET title = ?, updated_at = ? WHERE id = ?')
      for (const row of rows) {
        const clean = strip(row.title)
        if (clean !== row.title) stmt.run(clean, new Date().toISOString(), row.id)
      }
    }
  }
]

export function runMigrations(db: Database.Database): void {
  // 确保迁移表存在（首次启动时还没有 schema_migrations）
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r: unknown) => (r as { version: number }).version)
  )

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version))

  if (pending.length === 0) return

  const insert = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)')

  const runOne = db.transaction(() => {
    for (const m of pending) {
      if (m.run) {
        m.run(db)
      } else if (m.sql) {
        db.exec(m.sql)
      }
      insert.run(m.version)
    }
  })

  runOne()
}
