# 数据模型与 Schema 设计（docs/data-model.md）

> 状态：规划产物（2026-08-03），对应 `PLAN.md` Task 1.3，是本地数据库的建库依据。
> 设计原则：本地优先；逐片段溯源；每任务一稿（初稿，2026-08-11 起删去版本管理）；所有 Schema 变更必须通过迁移完成。

## 1. 实体总览与关系

- **Source（资料）**是"用户导入的文件"与"信源网址"的统一抽象，用 `kind` 字段区分。
- 一份资料可打多个 **Tag**（多对多）。
- **TemplateBook（范本）**独立于普通资料存储。
- 一个 **WritingTask（撰写任务）**对应一个 **Draft（志稿/初稿）**（2026-08-11 删去版本管理后仅保留初稿，`version_number` 恒为 0），每稿是完整快照。
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
| content_hash | TEXT | NULL | 文件内容 sha256（Phase 2.2 指纹锚点） |
| file_mtime | TEXT | NULL | 文件修改时间 ISO |
| file_size | INTEGER | NULL | 文件字节数 |
| workspace | INTEGER | NOT NULL DEFAULT 0 | 1=直接引用用户工作区文件（不转存副本） |
| task_id | TEXT | NULL | 非空 = 某任务生成初稿时抓取的网页缓存文章（Migration 013，暂存、不属于长期资料库；删任务时级联清理；资料库列表只显示 task_id IS NULL 的长期资料） |
| created_at / updated_at | TEXT | NOT NULL | |

> 注：Phase 2.2（Migration 006，2026-08-06）新增 `content_hash`/`file_mtime`/`file_size`/`workspace` 四列，作为"文件系统 ↔ 数据库"映射锚点；工作区资料 `file_path` 存工作区相对路径（正斜杠分隔）。
>
> 注：Migration 015（2026-08-20）清理工作区重复行（并发对账导致的同 `file_path` 重复入库，保留最早一条）并建立部分唯一索引 `idx_sources_workspace_path（file_path WHERE workspace=1 AND kind='file'）`，从结构上杜绝再次重复。

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

### 2.4 template_books（范本，已废弃保留）

> 2026-08-13「范本」重构为「写作规范 skills」（见 2.19）：表保留不删（避免迁移风险），不再有新数据写入。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| name | TEXT NOT NULL | 范本名称 |
| file_path | TEXT NOT NULL | 本地相对路径 |
| outline_json | TEXT NOT NULL | 已弃用（撰写只针对一个小节正文，不再提取篇目结构；写入空数组占位） |
| style_profile_json | TEXT NULL | 体例特征（本地统计 + 大模型行文范例增强，结构见下表） |
| created_at | TEXT NOT NULL | |

> 注：`style_profile_json`（Phase 3.3 Task 3.3.1，2026-08-07，方案多次升级）为**本地统计兜底 + 大模型提取"三个正常小节"行文范例**结果，供撰写任务生成初稿时作为体例参考注入提示词。**不再提取篇目结构**（撰写只针对一个小节正文）。本地统计始终存在、不依赖 LLM；行文范例由大模型提取（`llm=true`），未配置 Provider 或调用失败时自动降级。结构：
>
> ```json
> {
>   "totalChars": 32450,          // 全文字符数（去除空白，本地）
>   "paragraphCount": 180,        // 正文段落数（本地）
>   "avgParagraphChars": 180,     // 平均段长（字/段，本地）
>   "maxLevel": 3,                // 标题最大层级（本地）
>   "sectionCounts": { "1": 3, "2": 5, "3": 12 },  // 各级标题数量（本地）
>   "headingStyle": "第X篇/章/节 编号",             // 标题样式（本地）
>   "exampleSections": {          // LLM：三个正常小节行文范例（排除概要/大事记/人物传记/附录/索引等特殊模块）
>     "summary": "三个小节共有的行文逻辑与风格标准总体总结",
>     "sections": [
>       {
>         "title": "科技项目与成果",
>         "structureSummary": "该小节的行文逻辑与结构总结（如何开头收尾、先总述后分述、段落衔接）",
>         "styleGuidelines": "每一段、每一句话的行文风格标准（客观平实、述而不作、句式与数据表述规范）",
>         "example": "该小节的原文正文示例（直接摘录原文不改写）"
>       }
>     ]
>   },
>   "samples": ["…"],             // 兼容字段（本地截断 200 字）
>   "llm": true,                  // true = 行文范例经大模型增强提取
>   "llmModel": "deepseek-chat"    // LLM 增强时使用的模型名
> }
> ```
>
> 存量范本该列为 NULL 或旧结构时自动降级（生成初稿兼容旧字段），可通过范本页"重新提取"更新。`outline_json` 列已弃用（写入空数组占位）。

### 2.5 writing_tasks（撰写任务）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| title | TEXT NOT NULL | 需要撰写部分的标题（中栏显示，可重命名） |
| scope_json | TEXT NOT NULL | 文件范围：`{ all: true }`（Phase 3.5 起固定全部长期资料）/ `{ sourceIds: [] }` / `{ tagIds: [] }`（旧任务兼容） |
| template_book_id | TEXT NULL REFERENCES template_books(id) ON DELETE SET NULL | 参照范本（已废弃，2026-08-13 由 skill_ids 替代） |
| llm_provider_id | TEXT NULL | 任务固定大模型（Migration 007；未设置回退全局当前 Provider） |
| article_title | TEXT NULL | 大模型从用户要求中抓取的文章标题（Migration 007） |
| user_instruction | TEXT NULL | 生成初稿时用户的最新要求，重新生成复用（Migration 007） |
| skill_ids | TEXT NULL | 任务选定的部类细则规范 id（JSON 数组，Migration 014；NULL/空 = 未手动选定，生成时按标题自动匹配） |
| current_version | INTEGER NOT NULL DEFAULT 0 | 当前稿号（恒为 0 = 初稿；版本管理已删除，列保留兼容） |
| created_at / updated_at | TEXT NOT NULL | |

### 2.6 drafts（志稿/初稿）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| task_id | TEXT NOT NULL REFERENCES writing_tasks(id) ON DELETE CASCADE | |
| version_number | INTEGER NOT NULL | 恒为 0（初稿；版本管理已删除，列保留兼容） |
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
- 现有键：`data_dir`、`current_llm_provider_id`、`workspace_dir`（Phase 2.2 工作区根目录）

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

### 2.15 draft_contradictions（初稿矛盾分组，Phase 3.7 Task 3.7.1）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | uuid |
| draft_id | TEXT | NOT NULL REFERENCES drafts(id) ON DELETE CASCADE | 所属初稿（矛盾只在生成初稿阶段产生） |
| seq | INTEGER | NOT NULL, UNIQUE(draft_id, seq) | 生成提示词中的序号 #N，与正文标记 `【矛盾#N】` 对应 |
| topic | TEXT | NOT NULL | 事实主题一句话（同一主题一个分组，不逐对罗列） |
| kind | TEXT | NOT NULL DEFAULT 'other', CHECK('data','time','place','fact','other') | 矛盾类型：数据/时间/地点/事实经过/其他 |
| status | TEXT | NOT NULL DEFAULT 'pending', CHECK('pending','adopted','ignored') | 人工取舍状态：待处理/已采纳某说法/已忽略 |
| merged | INTEGER | NOT NULL DEFAULT 0 | 生成后定位审查发现"正文自然合并矛盾说法"的兜底标记 |
| draft_quote | TEXT | NULL | 正文中涉及该矛盾的原文原句（定位审查回填；即采纳修订时待替换语句的起止定位 from） |
| in_draft | INTEGER | NULL | 定位审查是否在正文中发现该矛盾：1=在正文（矛盾）/ 0=不在正文（警告）/ NULL=定位审查未执行（未知） |
| adopted_variant_id | TEXT | NULL | 用户采纳的说法 variant id（status=adopted 时） |
| created_at | TEXT | NOT NULL | |

### 2.16 contradiction_variants（矛盾说法，Phase 3.7 Task 3.7.1）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | uuid |
| contradiction_id | TEXT | NOT NULL REFERENCES draft_contradictions(id) ON DELETE CASCADE | 所属矛盾分组 |
| variant_text | TEXT | NOT NULL | 该说法原文摘录（≤200 字） |
| source_ids | TEXT | NOT NULL DEFAULT '[]' | 该说法关联的来源文件 id（JSON 数组，≥1；同主题可有 3+ 来源） |
| position | TEXT | NULL | 原文位置（可选） |
| replacement | TEXT | NULL | 定位审查预生成的"采纳该说法后正文应替换成的文句"（用户采纳时本地直接替换 from=draft_quote → to=replacement，不再调用大模型） |
| created_at | TEXT | NOT NULL | |

> 注：`source_ids` 存 JSON 数组而非外键关联，因为"同主题多个来源支持同一说法"是一对多且数量不定的集合；来源删除后 `sourceTitles` 读取时回退为 sourceId（界面再提示文件缺失，见 Phase 3.7 Task 3.7.6）。

### 2.17 draft_generation_sources（初稿生成上下文，Migration 010，2026-08-11）

记录初稿生成时**实际使用**的检索材料块，供"文段来源询问"按生成时的上下文让大模型溯源（正文经大模型改写后逐字匹配失效，需结合生成时材料判断同源文件）；采纳矛盾修订正文等场景亦可复用。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | uuid |
| draft_id | TEXT | NOT NULL REFERENCES drafts(id) ON DELETE CASCADE | 所属初稿 |
| source_id | TEXT | NOT NULL | 来源资料 id |
| position | TEXT | NOT NULL | 原文位置（如"第N段"） |
| chunk_text | TEXT | NOT NULL | 材料块原文（≤500 字） |
| created_at | TEXT | NOT NULL | |
| | | UNIQUE(draft_id, source_id, position) | 同一稿内同一来源同一位置唯一 |

> 重新生成初稿时按 draft 覆盖写入；初稿删除后随外键级联清理。

### 2.18 task_messages 与 llm_call_logs（对话持久化与调用痕迹，Migration 008，2026-08-08）

- `task_messages`：id PK、task_id（FK CASCADE）、role CHECK('user','assistant')、kind CHECK('chat','instruction','notice')、content、created_at；索引 (task_id, created_at)。
- `llm_call_logs`：id PK、task_id、kind、model、input_chars/output_chars、elapsed_ms、status CHECK('ok','error')、error_code、error_message、created_at；**只存元数据与字符数/耗时，不存密钥与正文**，用于诊断"生成慢/超时"与剩余时间预估。

### 2.19 writing_skills（写作规范，Migration 014，2026-08-13 由「范本」重构）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| name | TEXT NOT NULL | 规范名（如「学前教育」「志书文体文风与行文规则」） |
| category | TEXT NOT NULL CHECK('general','section') | general=通用规范（默认注入）；section=部类细则（按标题匹配/智能匹配/手动选择） |
| tags | TEXT NOT NULL DEFAULT '[]' | 匹配关键词（JSON 数组） |
| content | TEXT NOT NULL | 蒸馏后的规范要点（Markdown） |
| is_preset | INTEGER NOT NULL DEFAULT 0 | 预设（内置，可修改）或用户自建 |
| created_at / updated_at | TEXT NOT NULL | |

> 首次启动幂等写入预设规范（`seedPresetSkills`，仅当表为空时）。

### 2.20 web_sites 与 web_site_articles（网页资料库，Migration 012，2026-08-11）

- `web_sites`：id PK、root_url NOT NULL UNIQUE（去尾部斜杠归一）、title、created_at/updated_at、last_synced_at。
- `web_site_articles`：site_id（FK CASCADE）+ url 联合主键、title、discovered_at——站点文章 URL 清单缓存（生成初稿时先同步清单，再用撰写要求标题粗筛，命中文章增量抓取正文落库为 `sources`（kind='url'，task_id 绑定任务））。

### 2.21 compilations（资料汇编，Migration 016，Phase 6.0，2026-08-25）

三段式撰写第一步：一次「资料汇编」对应一个撰写任务的多张资料卡片与汇编阶段矛盾。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| task_id | TEXT NOT NULL REFERENCES writing_tasks(id) ON DELETE CASCADE | 所属任务 |
| title | TEXT NOT NULL | 汇编标题（通常与撰写标题一致） |
| status | TEXT NOT NULL DEFAULT 'drafting' CHECK('drafting','reviewing','finalized') | drafting=生成中/待审阅；reviewing=审阅中；finalized=已确认 |
| created_at / updated_at | TEXT NOT NULL | |

### 2.22 compilation_items（资料卡片，Migration 016，Phase 6.0）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| compilation_id | TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE | 所属汇编 |
| position | INTEGER NOT NULL | 时间升序位次 |
| source_id | TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE | 来源资料 |
| excerpt | TEXT NOT NULL | 卡片正文摘录 |
| ts | TEXT NULL | 时间标签（如「2005 年」） |
| note | TEXT NULL | 用户/大模型备注 |
| extra_tags | TEXT NOT NULL DEFAULT '[]' | 附加标签（JSON 数组） |
| kept | INTEGER NOT NULL DEFAULT 1 | 用户是否保留（编辑/删除卡片） |
| created_at | TEXT NOT NULL | |

### 2.23 compilation_contradictions / compilation_contradiction_variants（汇编矛盾，Migration 016，Phase 6.0）

- `compilation_contradictions`：id PK、compilation_id FK CASCADE、topic NOT NULL、kind CHECK('data','time','place','fact','other')、status CHECK('pending','resolved','ignored')、chosen_item_id（status=resolved 时用户保留的卡片 id）、created_at、UNIQUE(compilation_id, topic)。
- `compilation_contradiction_variants`：id PK、contradiction_id FK CASCADE、item_id REFERENCES compilation_items(id) ON DELETE CASCADE、variant_text、source_id REFERENCES sources(id) ON DELETE CASCADE、created_at。
- 矛盾取舍只在汇编阶段发生（初稿生成不再扫描矛盾）；`pending` 未处理完时前端阻止进入下一步。

## 3. 关键设计决策

- **资料统一抽象**：文件与信源网址合并为 `sources.kind`，撰写范围、来源标注不区分类型。
- **片段独立建表 + 多对多来源**：满足"每个小片段可显示原文来源"，一个片段可由多个来源佐证（矛盾场景天然支持）。
- **每任务一稿（整稿快照）**：每个撰写任务只保存一稿（初稿，`version_number = 0`）；重新生成初稿时覆盖写入。2026-08-11 起删去版本迭代（第 n 稿 → 确认 → 第 n+1 稿、版本查看/对比/回滚）。
- **正文入库 + 原始文件落盘**：`cleaned_text` 存 DB 供检索与 AI 输入；图片/原始文件存本地 dataDir，DB 只存相对路径。
- **审核留痕**：`review_records` 记录矛盾裁定、缺失补写、文段修改，保证人工审核过程可追溯（符合"人工主导"原则）。
- **迁移策略**：`schema_migrations` 表记录已执行迁移号；迁移文件按 `001_xxx.sql` 递增编号；禁止直接改表。

## 4. 待定项

- 向量检索当前为内存暴力余弦（资料规模下足够），大规模时再考虑 ANN 索引。
- LLM 凭证加密已落地（2026-08-05）：Electron `safeStorage`（Windows DPAPI）加密后存入 `llm_providers.api_key`。
