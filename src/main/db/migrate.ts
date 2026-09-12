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
  },
    {
    // 2026-08-28：工作区文件被删除时，应经「来源删除确认」后再清理资料汇编，删除来源不应自动级联删除汇编卡片。
    // 将 compilation_items / compilation_contradiction_variants 的 source_id 外键改为 ON DELETE SET NULL（可空），
    // 这样删除来源时卡片保留（source_id 置空），由确认流程决定是否删除对应卡片（含矛盾/二次改动，不入回收站）。
    version: 22,
    sql: `
CREATE TABLE IF NOT EXISTS compilation_items_new (
  id TEXT PRIMARY KEY,
  compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  excerpt TEXT NOT NULL,
  ts TEXT,
  note TEXT,
  extra_tags TEXT NOT NULL DEFAULT '[]',
  kept INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
INSERT INTO compilation_items_new (id, compilation_id, position, source_id, excerpt, ts, note, extra_tags, kept, created_at)
  SELECT id, compilation_id, position, source_id, excerpt, ts, note, extra_tags, kept, created_at FROM compilation_items;
DROP TABLE compilation_items;
ALTER TABLE compilation_items_new RENAME TO compilation_items;
CREATE INDEX IF NOT EXISTS idx_compilation_items_comp ON compilation_items(compilation_id);

CREATE TABLE IF NOT EXISTS compilation_contradiction_variants_new (
  id TEXT PRIMARY KEY,
  contradiction_id TEXT NOT NULL REFERENCES compilation_contradictions(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES compilation_items(id) ON DELETE CASCADE,
  variant_text TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
INSERT INTO compilation_contradiction_variants_new (id, contradiction_id, item_id, variant_text, source_id, created_at)
  SELECT id, contradiction_id, item_id, variant_text, source_id, created_at FROM compilation_contradiction_variants;
DROP TABLE compilation_contradiction_variants;
ALTER TABLE compilation_contradiction_variants_new RENAME TO compilation_contradiction_variants;
CREATE INDEX IF NOT EXISTS idx_compilation_cv_contradiction ON compilation_contradiction_variants(contradiction_id);
`
  },
  {
    // 2026-08-28：被删除的资料卡片也进入回收站（第三类：卡片），可恢复（含其矛盾变异/语义补全修订，存于 extra JSON）。
    // 单卡删除与汇编调整批量删除会入该表；来源级联清理仍为“硬删除不入回收站”（来源已删，恢复无意义且会外键悬空）。
    version: 23,
    sql: `
CREATE TABLE IF NOT EXISTS compilation_card_recycle_bin (
  id TEXT PRIMARY KEY,
  compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  source_id TEXT,
  excerpt TEXT NOT NULL,
  ts TEXT,
  note TEXT,
  extra_tags TEXT NOT NULL DEFAULT '[]',
  kept INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_compilation_card_bin_comp ON compilation_card_recycle_bin(compilation_id);
`
  },
  {
    // 2026-08-28：网页资料库增量抓取/条件请求——web_site_articles 增加文章抓取元数据：
    // 用于 If-Modified-Since/ETag 条件请求（B4）、正文哈希去重（A3 辅助）、发布时间排序（E10 预留）。
    version: 24,
    sql: `
ALTER TABLE web_site_articles ADD COLUMN etag TEXT;
ALTER TABLE web_site_articles ADD COLUMN last_modified TEXT;
ALTER TABLE web_site_articles ADD COLUMN body_hash TEXT;
ALTER TABLE web_site_articles ADD COLUMN last_fetched_at TEXT;
`
  },
  {
    // 2026-08-28：网页资料库 E10/E11——文章发布时间（E10）与站点用户关键词（E11）。
    version: 25,
    sql: `
ALTER TABLE web_site_articles ADD COLUMN published_at TEXT;
ALTER TABLE web_sites ADD COLUMN keywords TEXT NOT NULL DEFAULT '';
`
  },
  {
    // 2026-09-01：撤销站点关键词（E11）功能——删除 web_sites.keywords 列
    version: 26,
    sql: `
ALTER TABLE web_sites DROP COLUMN keywords;
`
  },
  {
    // Phase B：每个 LLM Provider 可配置「并发数」（同时处理的窗口请求数；默认 4，上限由 UI 限制 8）。
    // 用于资料汇编 AI 细读/矛盾扫描并发，缩短大量窗口的等待时间。
    version: 27,
    sql: `
ALTER TABLE llm_providers ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 4;
`
  },
  {
    // 2026-09-0x：撰写功能区拆分为「生成汇编 / 撰写初稿」——任务按类型区分，并删除本地全部旧任务。
    version: 28,
    run: (db) => {
      db.exec("ALTER TABLE writing_tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'compile';")
      // 升级到分区前清空本地旧任务（外键在迁移批次中被关闭，需手动按依赖顺序删除子表）
      const tables = [
        'review_records',
        'segment_sources',
        'segments',
        'contradiction_variants',
        'draft_contradictions',
        'draft_generation_sources',
        'drafts',
        'compilation_card_recycle_bin',
        'compilation_repair_recycle_bin',
        'compilation_repairs',
        'compilation_recycle_bin',
        'compilation_contradiction_variants',
        'compilation_contradictions',
        'compilation_items',
        'compilations',
        'task_messages',
        'writing_tasks'
      ]
      for (const table of tables) {
        db.prepare("DELETE FROM " + table).run()
      }
    }
  },
  {
    // 2026-09-08：资料卡片「大模型修正」（原“二次加工/语义补全”）改为**默认应用**，由卡片上的标记承载
    // （点击标记可查看修正前原文与理由、并可回退）。因此：
    //   ① compilation_repairs 状态由「待裁定 pending / accepted / rejected」改为「已应用 applied / 已回退 reverted」
    //      （CHECK 约束无法就地修改，故重建表）；
    //   ② 回收站不再收录该类条目 → 删除 compilation_repair_recycle_bin（被删卡片仍把其修正记录快照进
    //      compilation_card_recycle_bin.extra，随卡片一起恢复）。
    // 老数据迁移口径（用户确认）：accepted → applied（保留记录，文本此前已应用）；pending → applied 且把修订文本
    // 写入卡片（新口径“默认采纳所有二次修改”）；rejected → 丢弃（旧语义为“不采用”，卡片文本未变，无留存痕迹）。
    version: 29,
    run: (db) => {
      db.exec(`
CREATE TABLE compilation_repairs_new (
  id TEXT PRIMARY KEY,
  compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES compilation_items(id) ON DELETE CASCADE,
  original_text TEXT NOT NULL,
  revised_text TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','reverted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO compilation_repairs_new (id, compilation_id, item_id, original_text, revised_text, reason, status, created_at, updated_at)
  SELECT id, compilation_id, item_id, original_text, revised_text, reason, 'applied', created_at, updated_at
  FROM compilation_repairs
  WHERE status IN ('accepted', 'pending');
UPDATE compilation_items
   SET excerpt = (SELECT r.revised_text FROM compilation_repairs r
                   WHERE r.item_id = compilation_items.id AND r.status = 'pending'
                   ORDER BY r.created_at LIMIT 1)
 WHERE id IN (SELECT item_id FROM compilation_repairs WHERE status = 'pending');
DROP TABLE compilation_repairs;
ALTER TABLE compilation_repairs_new RENAME TO compilation_repairs;
CREATE INDEX IF NOT EXISTS idx_compilation_repairs_comp ON compilation_repairs(compilation_id);
CREATE INDEX IF NOT EXISTS idx_compilation_repairs_item ON compilation_repairs(item_id);
DROP TABLE IF EXISTS compilation_repair_recycle_bin;
`)
    }
  },
  {
    // 2026-09-10（Phase 7.1）：「资料卡片」升级为「连续文档中的段落」——**纯新增**，不动既有数据，
    // 因此本迁移执行后旧界面（卡片视图）仍完全可用。
    //   ① compilation_items 增加段落元数据：结构化时间（year/month/day）、时间可信度、来源编号、
    //      证据引文、产生方式、段级修订号、段类型；
    //   ② compilation_sources：每份汇编的来源编号表（圆标数字 = ordinal，按文档首次引用顺序 1..N，
    //      编号只增不回收，保证历史版本与正文中的编号不漂移）；
    //   ③ compilation_versions：版本历史（段落数组 + markdown 双快照 + 变更统计），替代进程内撤销栈；
    //   ④ compilation_messages：汇编级人机对话历史（跟汇编走，导入/导出一起带）。
    version: 30,
    sql: `
ALTER TABLE compilation_items ADD COLUMN year INTEGER;
ALTER TABLE compilation_items ADD COLUMN month INTEGER;
ALTER TABLE compilation_items ADD COLUMN day INTEGER;
ALTER TABLE compilation_items ADD COLUMN time_confidence TEXT NOT NULL DEFAULT 'unknown' CHECK (time_confidence IN ('exact','inferred','unknown'));
ALTER TABLE compilation_items ADD COLUMN source_ordinal INTEGER;
ALTER TABLE compilation_items ADD COLUMN evidence TEXT;
ALTER TABLE compilation_items ADD COLUMN origin TEXT NOT NULL DEFAULT 'generate' CHECK (origin IN ('generate','llm-edit','user-edit','contradiction','import'));
ALTER TABLE compilation_items ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE compilation_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'paragraph' CHECK (kind IN ('paragraph','heading'));

CREATE TABLE IF NOT EXISTS compilation_sources (
  id TEXT PRIMARY KEY,
  compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  cited_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (compilation_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_compilation_sources_comp ON compilation_sources(compilation_id, ordinal);

CREATE TABLE IF NOT EXISTS compilation_versions (
  id TEXT PRIMARY KEY,
  compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  paragraphs TEXT NOT NULL,
  markdown TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('generate','llm-edit','user-edit','restore','contradiction','import')),
  instruction TEXT,
  reply TEXT,
  change_summary TEXT NOT NULL DEFAULT '{}',
  base_version_no INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (compilation_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_compilation_versions_comp ON compilation_versions(compilation_id, version_no);

CREATE TABLE IF NOT EXISTS compilation_messages (
  id TEXT PRIMARY KEY,
  compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  version_no INTEGER,
  applied TEXT,
  rejected TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compilation_messages_comp ON compilation_messages(compilation_id, created_at);
`
  },
  {
    // 2026-09-10（Phase 7.1 回填）：把既有汇编的卡片数据补齐为段落模型，使旧汇编在新模型下立即可用。
    //   - 按段落**首次出现顺序**分配来源编号 1..N，写 compilation_sources，并把编号回填到每段 source_ordinal；
    //   - 从 ts 解析 year/month（无 4 位年份者 time_confidence='unknown'，交由 7.2 之后的整合提取或用户补齐）；
    //   - 为每个非空汇编生成 **v1 版本**（origin='generate'），使"版本对比"从第一阶段起就有基线。
    version: 31,
    run: (db) => {
      const comps = db.prepare('SELECT id, title, updated_at, created_at FROM compilations').all() as {
        id: string
        title: string
        updated_at: string
        created_at: string
      }[]
      const listItems = db.prepare(
        'SELECT id, source_id, excerpt, ts FROM compilation_items WHERE compilation_id = ? ORDER BY position ASC, rowid ASC'
      )
      const sourceTitle = db.prepare('SELECT title FROM sources WHERE id = ?')
      const insSource = db.prepare(
        'INSERT OR REPLACE INTO compilation_sources (id, compilation_id, source_id, ordinal, title, cited_count, created_at) VALUES (?,?,?,?,?,?,?)'
      )
      const updItem = db.prepare(
        'UPDATE compilation_items SET year = ?, month = ?, day = ?, time_confidence = ?, source_ordinal = ?, origin = ?, revision = 1, kind = ? WHERE id = ?'
      )
      const insVersion = db.prepare(
        'INSERT INTO compilation_versions (id, compilation_id, version_no, paragraphs, markdown, origin, instruction, reply, change_summary, base_version_no, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      const now = new Date().toISOString()

      for (const comp of comps) {
        const items = listItems.all(comp.id) as { id: string; source_id: string; excerpt: string; ts: string | null }[]
        if (items.length === 0) continue

        // ① 来源编号表（按首次引用顺序）
        const ordinalBySource = new Map<string, number>()
        const citedBySource = new Map<string, number>()
        for (const it of items) {
          if (!it.source_id) continue
          if (!ordinalBySource.has(it.source_id)) ordinalBySource.set(it.source_id, ordinalBySource.size + 1)
          citedBySource.set(it.source_id, (citedBySource.get(it.source_id) ?? 0) + 1)
        }
        for (const [sourceId, ordinal] of ordinalBySource) {
          const row = sourceTitle.get(sourceId) as { title: string } | undefined
          insSource.run(
            crypto.randomUUID(),
            comp.id,
            sourceId,
            ordinal,
            row?.title ?? sourceId,
            citedBySource.get(sourceId) ?? 0,
            comp.created_at || now
          )
        }

        // ② 段落元数据回填（时间解析口径与 compilation-document.parseTimeLabel 保持一致）
        const paragraphs: {
          id: string
          ordinal: number
          text: string
          timeLabel?: string
          year?: number
          month?: number
          day?: number
          timeConfidence: string
          sourceOrdinal?: number
          evidence?: string
          kind: string
          revision: number
          origin: string
        }[] = []
        items.forEach((it, index) => {
          const label = (it.ts ?? '').trim()
          const yearMatch = label.match(/(?:18|19|20)\d{2}/)
          const year = yearMatch ? Number(yearMatch[0]) : null
          const monthMatch = label.match(/(\d{1,2})\s*月/)
          const month = monthMatch ? Number(monthMatch[1]) : null
          const dayMatch = label.match(/(\d{1,2})\s*日/)
          const day = dayMatch ? Number(dayMatch[1]) : null
          const confidence = year ? 'exact' : 'unknown'
          const ordinal = it.source_id ? (ordinalBySource.get(it.source_id) ?? null) : null
          updItem.run(year, month, day, confidence, ordinal, 'generate', 'paragraph', it.id)
          paragraphs.push({
            id: it.id,
            ordinal: index,
            text: it.excerpt,
            timeLabel: label || undefined,
            year: year ?? undefined,
            month: month ?? undefined,
            day: day ?? undefined,
            timeConfidence: confidence,
            sourceOrdinal: ordinal ?? undefined,
            kind: 'paragraph',
            revision: 1,
            origin: 'generate'
          })
        })

        // ③ v1 版本（一段一行；段内换行转空格，保证"行级 diff ≈ 段落级 diff"）
        const markdown = paragraphs
          .map((p) => ((p.timeLabel ? p.timeLabel + '　' : '') + p.text).replace(/\s*\n+\s*/g, ' '))
          .join('\n')
        insVersion.run(
          crypto.randomUUID(),
          comp.id,
          1,
          JSON.stringify(paragraphs),
          markdown,
          'generate',
          null,
          null,
          JSON.stringify({ added: paragraphs.length, removed: 0, modified: 0, moved: 0, paragraphIds: [] }),
          null,
          comp.updated_at || comp.created_at || now
        )
      }
    }
  },
  {
    // 2026-09-10（Phase 7.2 诊断增强）：把生成时「整合提取」阶段的诊断汇总（ExtractScanStats JSON）落库，
    // 便于事后复盘"通过校验 / 降级（数字无据 / 证据非原文）/ 整卡丢弃 / 漏答 / 重复合并"各占多少，
    // 不必再靠临时脚本反推（本轮就吃过这个亏）。
    version: 32,
    sql: `
ALTER TABLE compilations ADD COLUMN extract_scan TEXT;
`
  },
  {
    // 2026-09-10（数据修复，Phase 7.3 验收发现）：旧「撤销/恢复」恢复快照时只重插了 10 个旧列，
    // 把 Migration 030 新增的段落元数据（year/month/day/time_confidence/source_ordinal/evidence/origin/revision/kind）
    // 全部重置为默认值——实测一次撤销就让某份 148 段汇编的 year 与 source_ordinal 全部丢失，
    // 表现为界面「年份小标题消失 + 每段都显示待补年份」。
    // 本迁移把**可从现有数据确定性重建**的部分补回来（撤销本身无法区分"被写坏"与"本来就未知"，故只补明确不一致的行）：
    //   ① ts 含 4 位年份但 year 为空 → 按 ts 重建 year/month/day 与 confidence='exact'；
    //   ② ts 无年份且 source_id 存在 → 用来源标题的年鉴年份 −1 兜底（confidence='inferred'）；
    //   ③ source_id 存在但 source_ordinal 为空 → 从 compilation_sources 反查编号。
    // evidence / origin / revision / kind 无法重建（模型引文未留存），保持默认值：不影响展示与排序。
    version: 33,
    run: (db) => {
      const rows = db
        .prepare(
          `SELECT i.id, i.ts, i.source_id, i.compilation_id,
                  (SELECT title FROM sources s WHERE s.id = i.source_id) AS source_title
             FROM compilation_items i
            WHERE i.year IS NULL OR (i.source_id IS NOT NULL AND i.source_id <> '' AND i.source_ordinal IS NULL)`
        )
        .all() as { id: string; ts: string | null; source_id: string | null; compilation_id: string; source_title: string | null }[]
      const upd = db.prepare(
        'UPDATE compilation_items SET year = ?, month = ?, day = ?, time_confidence = ?, source_ordinal = ? WHERE id = ?'
      )
      const ordinalOf = db.prepare('SELECT ordinal FROM compilation_sources WHERE compilation_id = ? AND source_id = ?')
      for (const r of rows) {
        const label = (r.ts ?? '').trim()
        const yearMatch = label.match(/(?:18|19|20)\d{2}/)
        let year = yearMatch ? Number(yearMatch[0]) : null
        const monthMatch = label.match(/(\d{1,2})\s*月/)
        const month = monthMatch ? Number(monthMatch[1]) : null
        const dayMatch = label.match(/(\d{1,2})\s*日/)
        const day = dayMatch ? Number(dayMatch[1]) : null
        let confidence = year ? 'exact' : 'unknown'
        if (!year) {
          // 年鉴惯例兜底（与 extract-service / compilation-document 同口径）：《长乐年鉴2019》→ 2018 年
          const titleYear = (r.source_title ?? '').match(/(?:18|19|20)\d{2}/)
          if (titleYear) {
            const inferred = Number(titleYear[0]) - 1
            if (inferred >= 1900) {
              year = inferred
              confidence = 'inferred'
            }
          }
        }
        let ordinal: number | null = null
        if (r.source_id) {
          const found = ordinalOf.get(r.compilation_id, r.source_id) as { ordinal: number } | undefined
          ordinal = found?.ordinal ?? null
        }
        upd.run(year, month, day, confidence, ordinal, r.id)
      }
    }
  },
  {
    // 2026-09-10（Phase 7.5 验收反馈）：用户裁定「人工修改模式一旦进入就不可逆」——
    // 需要跨任务切换与软件重启保持，因此必须落库，不能只存在渲染层状态里。
    // 语义：0 = 汇编确认前的人机协同（只能通过对话框让大模型改）；1 = 已解锁人工修改。
    // 只增不减（没有把 1 改回 0 的入口）。
    version: 34,
    sql: `
ALTER TABLE compilations ADD COLUMN manual_edit INTEGER NOT NULL DEFAULT 0;
`
  },
  {
    // 2026-09-10（Phase 7.5 二次验收）：用户当天改变了需求——**删除「人工修改模式」**，
    // 改为「导出资料汇编到本地修改、需要核对来源时再回到软件内查看」。于是 Migration 034 引入的
    // `manual_edit` 列失去意义，本次一并删列（同类先例：Migration 026 删除 E11 的 keywords 列）。
    // 保留 034 条目而不改写历史：迁移是只增不改的账本，用户库里已记录 034。
    version: 35,
    sql: `
ALTER TABLE compilations DROP COLUMN manual_edit;
`
  },
  {
    // 2026-09-10（Phase 7.7 破坏性清理）：Phase 7.2 的「整合提取」取代了「提纯 + 大模型修正」两趟，
    // 7.6 又把「资料卡片」改造成连续文档——「卡片级修正记录」与「卡片回收站」两套机制再无入口：
    //   · compilation_repairs：修正记录不再产生，也不再有徽标/弹窗/回退通道；
    //   · compilation_card_recycle_bin：软件内已无逐段删除入口，卡片回收站不会再新增条目。
    // 回收站因此收缩为**仅矛盾**（保留 compilation_recycle_bin）。
    // 迁移账本只增不改：029 建立/改写这两张表的条目保持原样，此处只做删除。
    version: 36,
    sql: `
DROP TABLE IF EXISTS compilation_repairs;
DROP TABLE IF EXISTS compilation_card_recycle_bin;
`
  },
  {
    // 2026-09-10（Phase 7.7 收尾后补强：网页资料库并入修志流程·第一批）：
    // 网页文章的**发布时间**此前只写在 `web_site_articles.published_at`（仅用于文章清单排序），
    // 抓成 `sources` 后完全丢失，于是网页段落缺年份时只能按标题兜底——而「年鉴惯例 −1」用在新闻标题上
    // 是**错的**（「2021年全区教育工作总结」会被推成 2020 年）。故把发布时间落到 sources 上，
    // 供年份兜底使用（标为 inferred），并可在来源小卡中查证。
    version: 37,
    sql: `
ALTER TABLE sources ADD COLUMN published_at TEXT;
UPDATE sources SET published_at = (
  SELECT w.published_at FROM web_site_articles w
   WHERE w.url = sources.url AND w.published_at IS NOT NULL
   LIMIT 1
) WHERE kind = 'url' AND published_at IS NULL;
`
  },
  {
    // 2026-09-12（向量索引失败可诊断）：真实数据核对发现全库 `index_state='failed'`、`chunk_embeddings` 为空，
    // 但**失败原因无处可查**（只有日志里的 console.error），用户无法判断是模型缺失还是引擎不可用。
    // 本迁移增加 `index_error`（失败原因，成功时清空），供设置页展示与"重建索引"后核对。
    version: 38,
    sql: `
ALTER TABLE sources ADD COLUMN index_error TEXT;
`
  },
  {
    // 2026-09-12（第三批 A1）：**网页材料集合在首次生成时落定**。
    // 动因：此前每次生成都会重新发现并抓取最新命中文章，同一指令在不同时间生成的材料集合不同；
    // 用户点「重新生成汇编」时可能引入从未见过的网页段落，还会污染版本差异与矛盾编号。
    // 现在把"某任务实际采用的网页来源"记在这张表里：重新生成默认复用同一批，
    // 新发现但未纳入的文章只报数量（由用户点「纳入新材料」才抓取入库）。
    version: 39,
    sql: `
CREATE TABLE IF NOT EXISTS task_web_materials (
    task_id TEXT NOT NULL REFERENCES writing_tasks(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url TEXT,
    title TEXT,
    added_at TEXT NOT NULL,
    PRIMARY KEY (task_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_task_web_materials_task ON task_web_materials(task_id);
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

  // 迁移批次期间关闭外键：部分迁移需要重建被其它表引用的父表（如 compilation_items 的 source_id 外键），
  // PRAGMA foreign_keys 无法在事务内修改，故须在事务开始前关闭、结束后开启。
  db.pragma('foreign_keys = OFF')
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
  db.pragma('foreign_keys = ON')
}
