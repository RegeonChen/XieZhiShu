# 数据模型与 Schema 设计（docs/data-model.md）

> 状态：规划产物（2026-08-03），对应 `PLAN.md` Task 1.3，是本地数据库的建库依据。
> 设计原则：本地优先；逐片段溯源；以"第 n 稿"为版本单元；所有 Schema 变更必须通过迁移完成。

## 1. 实体总览与关系

- **Source（资料）**是"用户导入的文件"与"信源网址"的统一抽象，用 `kind` 字段区分。
- 一份资料可打多个 **Tag**（多对多）。
- **TemplateBook（范本）**独立于普通资料存储。
- 一个 **WritingTask（撰写任务）**对应多个 **Draft（志稿版本）**，第 n 稿即 `version_number = n`，每稿是完整快照。
- 一个 Draft 由多个 **Segment（片段）**组成；每个片段可关联多个 Source 并记录原文位置（溯源核心）。

```
WritingTask 1─N Draft 1─N Segment N─N Source N─N Tag
                 │                          └─(segment_sources: 位置标注)
                 └─1─N ReviewRecord（审核动作留痕）
```

## 2. 表定义

### 2.1 sources（资料）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | uuid |
| kind | TEXT | NOT NULL, CHECK('file','url') | 文件 / 信源网址 |
| title | TEXT | NOT NULL | 资料标题（文件名为默认） |
| file_path | TEXT | NULL | kind=file 时，原始文件在本地 dataDir 下的相对路径 |
| url | TEXT | NULL | kind=url 时 |
| url_snapshot_at | TEXT | NULL | 抓取时间（ISO） |
| raw_text | TEXT | NULL | 原始文本 / OCR 结果 |
| cleaned_text | TEXT | NOT NULL | 清洗后正文，供 FTS5 检索与 AI 输入 |
| status | TEXT | NOT NULL DEFAULT 'pending', CHECK('pending','processing','ready','failed') | 解析/抓取状态 |
| error_code | TEXT | NULL | 失败时的稳定错误码 |
| created_at / updated_at | TEXT | NOT NULL | |

### 2.2 tags（标签）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | TEXT | PK |
| name | TEXT | NOT NULL UNIQUE |
| created_at | TEXT | NOT NULL |

> 注：`color` 列（标签颜色）已通过 Migration 002 移除（2026-08-05，标签统一显示）。

### 2.3 source_tags（资料-标签 关联）

- `source_id` TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE
- `tag_id` TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE
- PRIMARY KEY(source_id, tag_id)

### 2.4 template_books（范本）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| name | TEXT NOT NULL | 范本名称 |
| file_path | TEXT NOT NULL | 本地相对路径 |
| outline_json | TEXT NOT NULL | 解析出的篇目层级结构 |
| style_profile_json | TEXT NULL | 体例特征（文体标记、行文特征摘要） |
| created_at | TEXT NOT NULL | |

### 2.5 writing_tasks（撰写任务）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| title | TEXT NOT NULL | 需要撰写部分的标题 |
| scope_json | TEXT NOT NULL | 文件范围：`{ sourceIds: [] }` 或 `{ tagIds: [] }`，二者取一 |
| template_book_id | TEXT NULL REFERENCES template_books(id) ON DELETE SET NULL | 参照范本 |
| current_version | INTEGER NOT NULL DEFAULT 0 | 当前所在稿号 |
| created_at / updated_at | TEXT NOT NULL | |

### 2.6 drafts（志稿版本）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| task_id | TEXT NOT NULL REFERENCES writing_tasks(id) ON DELETE CASCADE | |
| version_number | INTEGER NOT NULL | 0 为初稿 |
| status | TEXT NOT NULL DEFAULT 'editing' CHECK('editing','confirmed') | |
| confirmed_at | TEXT NULL | |
| created_at | TEXT NOT NULL | |
| UNIQUE(task_id, version_number) | | |

### 2.7 segments（片段）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| draft_id | TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE | |
| ordering | INTEGER NOT NULL | 片段顺序 |
| heading | TEXT NULL | 片段小标题 |
| content | TEXT NOT NULL | 片段正文 |
| ai_generated | INTEGER NOT NULL DEFAULT 0 | 1=AI 生成，0=人工撰写/修改 |
| created_at / updated_at | TEXT NOT NULL | |
| UNIQUE(draft_id, ordering) | | |

### 2.8 segment_sources（片段-来源 关联，溯源核心）

- `segment_id` TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE
- `source_id` TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE
- `position` TEXT NOT NULL（原文位置：文件为"页码/段落序号"，URL 为"段落序号"）
- `quote` TEXT NULL（片段引用该来源的原文摘句，便于人工核对）
- PRIMARY KEY(segment_id, source_id, position)

### 2.9 review_records（审核动作记录）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| draft_id | TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE | |
| segment_id | TEXT NULL REFERENCES segments(id) ON DELETE SET NULL | |
| action | TEXT NOT NULL CHECK('conflict','missing','edit','insert') | 矛盾/缺失/修改/插入 |
| before_content | TEXT NULL | |
| after_content | TEXT NULL | |
| note | TEXT NULL | 人工备注（如矛盾裁定的理由） |
| created_at | TEXT NOT NULL | |

### 2.10 settings（本地设置，key-value）

- `key` TEXT PK
- `value` TEXT NOT NULL
- `updated_at` TEXT NOT NULL
- 现有键：`data_dir`、`current_llm_provider_id`

### 2.11 llm_providers（LLM Provider 配置，Phase 3 Task 3.1）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | uuid |
| name | TEXT | NOT NULL UNIQUE | 显示名称 |
| api_base | TEXT | NOT NULL | OpenAI-compatible API 地址（如 `https://api.deepseek.com/v1`） |
| model | TEXT | NOT NULL | 模型名 |
| api_key | TEXT | NULL | 密钥，以 `safe-storage:v1:<base64>`（Electron safeStorage/Windows DPAPI）加密存储 |
| created_at / updated_at | TEXT | NOT NULL | |

### 2.12 FTS5 索引（全文检索）

- 对 `sources.cleaned_text` 建 FTS5 虚拟表（`sources_fts`），外部内容表模式，写入时同步维护。

### 2.13 chunk_embeddings（分块向量索引，Phase 3.2 Task 3.2.1）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | uuid |
| source_id | TEXT | NOT NULL REFERENCES sources(id) ON DELETE CASCADE | 所属资料 |
| chunk_text | TEXT | NOT NULL | 分块文本 |
| position | TEXT | NOT NULL | 来源位置（如"第N段"） |
| embedding | BLOB | NOT NULL | float32 向量（本地 embedding 模型生成） |
| model_id | TEXT | NOT NULL | 生成向量的模型标识 |
| created_at | TEXT | NOT NULL | |

### 2.14 source_summaries（LLM 摘要索引，Phase 3.2 Task 3.2.3）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| source_id | TEXT | PK REFERENCES sources(id) ON DELETE CASCADE | 所属资料 |
| summary | TEXT | NOT NULL | LLM 生成的内容摘要 |
| keywords | TEXT | NOT NULL DEFAULT '[]' | 主题关键词（JSON 数组） |
| entities | TEXT | NOT NULL DEFAULT '[]' | 关键实体（JSON 数组） |
| llm_model | TEXT | NULL | 生成摘要的模型名 |
| updated_at | TEXT | NOT NULL | |

`sources` 表新增列：`indexed_at`（向量索引完成时间）、`index_state`（'pending'/'indexing'/'ready'/'failed'，向量索引状态）。

## 3. 关键设计决策

- **资料统一抽象**：文件与信源网址合并为 `sources.kind`，撰写范围、来源标注不区分类型。
- **片段独立建表 + 多对多来源**：满足"每个小片段可显示原文来源"，一个片段可由多个来源佐证（矛盾场景天然支持）。
- **版本 = 整稿快照**：确认后复制整稿生成新 `drafts` 行（version_number+1）；查看/对比/回滚在版本间进行。初版不做 diff 存储，简单可靠，后续可优化为增量。
- **正文入库 + 原始文件落盘**：`cleaned_text` 存 DB 供检索与 AI 输入；图片/原始文件存本地 dataDir，DB 只存相对路径。
- **审核留痕**：`review_records` 记录矛盾裁定、缺失补写、文段修改，保证人工审核过程可追溯（符合"人工主导"原则）。
- **迁移策略**：`schema_migrations` 表记录已执行迁移号；迁移文件按 `001_xxx.sql` 递增编号；禁止直接改表。

## 4. 待定项

- 向量检索表结构（Phase 3 确定后追加）。
- LLM 凭证加密已落地（2026-08-05）：Electron `safeStorage`（Windows DPAPI）加密后存入 `llm_providers.api_key`。
