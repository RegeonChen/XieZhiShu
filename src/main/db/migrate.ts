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
  },
  {
    // 向量索引与摘要索引（Phase 3.2 Task 3.2.1）：chunk_embeddings 存分块向量，
    // source_summaries 存 LLM 摘要；sources 增加向量索引状态标记
    version: 5,
    sql: `
CREATE TABLE IF NOT EXISTS chunk_embeddings (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    chunk_text TEXT NOT NULL,
    position TEXT NOT NULL,
    embedding BLOB NOT NULL,
    model_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_source ON chunk_embeddings(source_id);

CREATE TABLE IF NOT EXISTS source_summaries (
    source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]',
    entities TEXT NOT NULL DEFAULT '[]',
    llm_model TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE sources ADD COLUMN indexed_at TEXT;
ALTER TABLE sources ADD COLUMN index_state TEXT NOT NULL DEFAULT 'pending' CHECK (index_state IN ('pending', 'indexing', 'ready', 'failed'));
`
  },
  {
    // 工作区资料库（Phase 2.2 Task 2.2.1）：文件指纹映射 + 工作区标记。
    // content_hash(file sha256) / file_mtime / file_size 作为"文件系统 ↔ 数据库"映射锚点，
    // workspace=1 表示该资料直接引用用户工作区文件（不再转存副本）。
    version: 6,
    sql: `
ALTER TABLE sources ADD COLUMN content_hash TEXT;
ALTER TABLE sources ADD COLUMN file_mtime TEXT;
ALTER TABLE sources ADD COLUMN file_size INTEGER;
ALTER TABLE sources ADD COLUMN workspace INTEGER NOT NULL DEFAULT 0;
`
  },
  {
    // 撰写工作台聊天式重构（Phase 3.5 Task 3.5.1）：
    // llm_provider_id 任务固定大模型；article_title 大模型从用户要求中抓取的文章标题；
    // user_instruction 生成初稿时用户的最新要求（重新生成复用）。
    version: 7,
    sql: `
ALTER TABLE writing_tasks ADD COLUMN llm_provider_id TEXT;
ALTER TABLE writing_tasks ADD COLUMN article_title TEXT;
ALTER TABLE writing_tasks ADD COLUMN user_instruction TEXT;
`
  },
  {
    // 对话与痕迹持久化（Phase 3.5 后续）：task_messages 存任务对话框消息
    // （user/assistant，kind: chat 对话 / instruction 生成初稿的用户要求 / notice 系统提示）；
    // llm_call_logs 存每次大模型调用的元数据痕迹（kind: generate/chat/summarize/test，
    // 记模型/输入输出字符数/耗时/状态/错误，不记密钥与正文，用于诊断"生成慢/超时"类问题）。
    version: 8,
    sql: `
CREATE TABLE IF NOT EXISTS task_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES writing_tasks(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'instruction', 'notice')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id, created_at);

CREATE TABLE IF NOT EXISTS llm_call_logs (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    kind TEXT NOT NULL,
    model TEXT,
    input_chars INTEGER NOT NULL DEFAULT 0,
    output_chars INTEGER NOT NULL DEFAULT 0,
    elapsed_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_call_logs_task ON llm_call_logs(task_id, created_at);
`
  },
  {
    // 矛盾检测数据模型（Phase 3.7 Task 3.7.1）：
    // draft_contradictions 为"矛盾分组"——同一事实主题一个分组（seq 与生成提示词序号 #N 对应，
    // 正文标记【矛盾#N】按序号映射）；status 记录人工取舍（pending/adopted/ignored），
    // adopted_variant_id 记录被采纳的说法；merged/draft_quote 由生成后"定位审查"回填
    // （draft_quote 为正文中涉及该矛盾的原文原句，用于正文定位）。
    // contradiction_variants 为组内每条相左"说法"，source_ids 存 JSON 数组（≥1 个来源，支持同主题 3+ 来源）。
    version: 9,
    sql: `
CREATE TABLE IF NOT EXISTS draft_contradictions (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    topic TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('data', 'time', 'place', 'fact', 'other')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'adopted', 'ignored')),
    merged INTEGER NOT NULL DEFAULT 0,
    draft_quote TEXT,
    adopted_variant_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (draft_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_draft_contradictions_draft ON draft_contradictions(draft_id);

CREATE TABLE IF NOT EXISTS contradiction_variants (
    id TEXT PRIMARY KEY,
    contradiction_id TEXT NOT NULL REFERENCES draft_contradictions(id) ON DELETE CASCADE,
    variant_text TEXT NOT NULL,
    source_ids TEXT NOT NULL DEFAULT '[]',
    position TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contradiction_variants_contradiction ON contradiction_variants(contradiction_id);
`
  },
  {
    // 生成上下文落库（2026-08-11）：记录初稿生成时实际使用的检索材料块（来源 + 位置 + 原文），
    // 供"文段来源询问"按生成时的上下文让大模型溯源（仅凭文件标题判断太弱，需结合材料原文）。
    version: 10,
    sql: `
CREATE TABLE IF NOT EXISTS draft_generation_sources (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    position TEXT NOT NULL,
    chunk_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (draft_id, source_id, position)
);
CREATE INDEX IF NOT EXISTS idx_draft_gen_sources_draft ON draft_generation_sources(draft_id);
`
  },
  {
    // 矛盾采纳本地修订 + 警告分类（2026-08-11）：
    // - draft_contradictions.in_draft：定位审查是否在正文中发现该矛盾（1=在正文/矛盾，0=不在正文/警告，NULL=定位未执行）。
    // - contradiction_variants.replacement：定位审查预生成的"采纳该说法后正文应替换成的文句"，
    //   用户采纳时本地直接替换（from=draft_quote → to=replacement），无需再次调用大模型。
    version: 11,
    sql: `
ALTER TABLE draft_contradictions ADD COLUMN in_draft INTEGER;
ALTER TABLE contradiction_variants ADD COLUMN replacement TEXT;
`
  },
  {
    // 网页资料库（2026-08-11）：
    // - web_sites：用户注册的"网页资料库"站点（root_url 唯一；last_synced_at 记录上次同步时间）。
    // - web_site_articles：站点文章 URL 清单缓存（site_id + url 唯一；生成初稿时先发现/更新清单，
    //   再用撰写要求标题粗筛，命中文章增量抓取正文落库为 kind='url' 的 sources）。
    version: 12,
    sql: `
CREATE TABLE IF NOT EXISTS web_sites (
  id TEXT PRIMARY KEY,
  root_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS web_site_articles (
  site_id TEXT NOT NULL REFERENCES web_sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (site_id, url)
);
`
  },
  {
    // 网页资料库文章作为任务绑定缓存（2026-08-13）：
    // sources.task_id 标记"任务绑定的网页缓存文章"——非空 = 某任务生成初稿时抓取的网站文章（暂存、不属于长期资料库）；
    // NULL = 工作区文件 / 手动添加的网址信源（长期资料）。删除撰写任务时级联清理其 task_id 对应的 sources；
    // 资料库列表只显示 task_id IS NULL 的长期资料，网页缓存文章不进入资料库。
    version: 13,
    sql: `ALTER TABLE sources ADD COLUMN task_id TEXT;`
  },
  {
    // 写作规范 skills（2026-08-13）：将"范本"功能重构为"规范"。
    // writing_skills 存志书写作规范（通用规范 category='general' + 部类细则 category='section'）；
    // writing_tasks.skill_ids 存该任务选定的部类细则 skill id 列表（JSON 数组；NULL = 未手动选定，生成时自动匹配）。
    version: 14,
    sql: `
CREATE TABLE IF NOT EXISTS writing_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('general', 'section')),
  tags TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  is_preset INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE writing_tasks ADD COLUMN skill_ids TEXT;
`
  },
  {
    // 工作区资料去重 + 路径唯一索引（2026-08-20）：
    // 此前设置页触发与手动"同步工作区"直接调用 reconcileWorkspace，绕过 auto-sync 互斥调度器，
    // 与自动同步/监听增量并发对账，同一新文件被两路同时扫描入库（资料列表重复显示）。
    // 本迁移清理已有重复行（每个 file_path 保留最早一条，其余随外键级联清理其关联），
    // 并建立部分唯一索引（workspace=1 文件按 file_path 唯一），从结构上杜绝再次重复入库。
    version: 15,
    sql: `
DELETE FROM sources
WHERE workspace = 1 AND kind = 'file' AND file_path IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM sources s2
    WHERE s2.workspace = 1 AND s2.kind = 'file'
      AND s2.file_path = sources.file_path
      AND (s2.created_at < sources.created_at OR (s2.created_at = sources.created_at AND s2.rowid < sources.rowid))
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_workspace_path
  ON sources(file_path)
  WHERE workspace = 1 AND kind = 'file';
`
  },
  {
    // 三段式撰写重构（Phase 6.0，2026-08-25）：资料汇编 → 行文规范 → 初稿。
    // compilations = 一次「资料汇编」；compilation_items = 审阅中的资料卡片；
    // compilation_contradictions/variants = 汇编阶段的资料矛盾分组与取舍。
    version: 16,
    sql: `
CREATE TABLE IF NOT EXISTS compilations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES writing_tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'drafting' CHECK (status IN ('drafting','reviewing','finalized')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compilations_task ON compilations(task_id);

CREATE TABLE IF NOT EXISTS compilation_items (
  id TEXT PRIMARY KEY,
  compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  excerpt TEXT NOT NULL,
  ts TEXT,
  note TEXT,
  extra_tags TEXT NOT NULL DEFAULT '[]',
  kept INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compilation_items_comp ON compilation_items(compilation_id);

CREATE TABLE IF NOT EXISTS compilation_contradictions (
  id TEXT PRIMARY KEY,
  compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('data','time','place','fact','other')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','ignored')),
  chosen_item_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (compilation_id, topic)
);
CREATE INDEX IF NOT EXISTS idx_compilation_contradictions_comp ON compilation_contradictions(compilation_id);

CREATE TABLE IF NOT EXISTS compilation_contradiction_variants (
  id TEXT PRIMARY KEY,
  contradiction_id TEXT NOT NULL REFERENCES compilation_contradictions(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES compilation_items(id) ON DELETE CASCADE,
  variant_text TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compilation_cv_contradiction ON compilation_contradiction_variants(contradiction_id);
`
  },
  {
    // 汇编矛盾的回收站：采纳/忽略某组矛盾时，把该矛盾“原封不动”快照进回收站，
    // 用户可恢复后重新取舍。引用 contradiction_id（矛盾行保留，卡片用 kept 软删除便于恢复），
    // 随 compilation 级联删除。
    version: 17,
    sql: `
CREATE TABLE IF NOT EXISTS compilation_recycle_bin (
  id TEXT PRIMARY KEY,
  compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  contradiction_id TEXT NOT NULL REFERENCES compilation_contradictions(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL CHECK (status IN ('resolved','ignored')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compilation_recycle_bin_comp ON compilation_recycle_bin(compilation_id);
CREATE INDEX IF NOT EXISTS idx_compilation_recycle_bin_contra ON compilation_recycle_bin(contradiction_id);
`
  },
  {
    // Phase 6.4：删除「写作规范 skills」模块——移除 writing_skills 表并清空任务已选的 skill_ids。
    version: 18,
    sql: `
DROP TABLE IF EXISTS writing_skills;
UPDATE writing_tasks SET skill_ids = NULL;
`
  },
  {
    // Phase 6.4.1：规范文档库——第二步「指定行文规范」的多篇规范持久化 + 默认注入指定。
    version: 19,
    sql: `
CREATE TABLE IF NOT EXISTS style_guides (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_style_guides_default ON style_guides(is_default);
`
  },
  {
    // Phase 6.4.2：第二步「添加范本」——任务级范本（用户提供的示例正文，生成初稿时作为参考提交）。
    version: 20,
    sql: `
ALTER TABLE writing_tasks ADD COLUMN model_text TEXT;
`
  },
  {
    // 资料卡片二次加工（语义补全/修订）：对表意不明的卡片读取原文上下文后由大模型提出补全/修订，
    // 落库为 compilation_repairs（pending/accepted/rejected）；采纳/拒绝后快照进 compilation_repair_recycle_bin 供恢复。
    version: 21,
    sql: `
CREATE TABLE IF NOT EXISTS compilation_repairs (
  id TEXT PRIMARY KEY,
  compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES compilation_items(id) ON DELETE CASCADE,
  original_text TEXT NOT NULL,
  revised_text TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compilation_repairs_comp ON compilation_repairs(compilation_id);
CREATE INDEX IF NOT EXISTS idx_compilation_repairs_item ON compilation_repairs(item_id);
CREATE TABLE IF NOT EXISTS compilation_repair_recycle_bin (
  id TEXT PRIMARY KEY,
  compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  repair_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  original_text TEXT NOT NULL,
  revised_text TEXT NOT NULL,
  chosen TEXT NOT NULL CHECK (chosen IN ('accepted','rejected')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compilation_repair_bin_comp ON compilation_repair_recycle_bin(compilation_id);
`
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
