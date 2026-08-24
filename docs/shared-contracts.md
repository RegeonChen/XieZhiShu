# 共享契约与 IPC 清单（docs/shared-contracts.md）

> 状态：与代码同步维护（2026-08-19 整理）。落地为 `src/shared/types.ts` 与 `src/shared/ipc.ts`（通道名与类型以这两个文件为准，本文档是说明性视图）。
> 原则：类型与协议独立于 UI 组件与具体服务实现；修改契约必须同时更新所有调用方与相关文档。

## 1. 核心类型（shared/types.ts）

以下类型字段与 `docs/data-model.md` 的表结构一一对应：

```ts
/** 资料（文件或信源网址的统一抽象） */
interface Source {
  id: string;
  kind: 'file' | 'url';
  title: string;
  filePath?: string;        // kind=file，dataDir 相对路径（workspace 资料为工作区相对路径）
  url?: string;             // kind=url
  urlSnapshotAt?: string;   // 抓取时间 ISO
  cleanedText: string;      // 清洗后正文
  status: 'pending' | 'processing' | 'ready' | 'failed';
  errorCode?: string;
  contentHash?: string;     // 文件内容 sha256（Phase 2.2 指纹锚点）
  fileMtime?: string;       // 文件修改时间 ISO
  fileSize?: number;        // 文件字节数
  workspace?: boolean;      // true=直接引用用户工作区文件（不转存副本）
  taskId?: string;          // 非空 = 任务绑定的网页缓存文章（暂存、不进资料库列表）
  createdAt: string;
  updatedAt: string;
}

interface Tag { id: string; name: string; createdAt: string; }

/** 网页资料库站点（2026-08-11） */
interface WebSite { id: string; rootUrl: string; title: string; createdAt: string; updatedAt: string; lastSyncedAt?: string; }

/** 写作规范（2026-08-13 由「范本」重构） */
interface WritingSkill {
  id: string;
  name: string;
  category: 'general' | 'section';  // general=通用规范（默认注入）；section=部类细则（按标题匹配）
  tags: string[];                     // 匹配关键词
  content: string;                    // 蒸馏后的规范要点（Markdown）
  isPreset: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 撰写任务 */
interface WritingTask {
  id: string;
  title: string;
  scope: { all: true } | { sourceIds: string[] } | { tagIds: string[] };  // Phase 3.5 起固定 { all: true }，旧任务兼容保留
  templateBookId?: string;  // 已废弃（2026-08-13 由 skillIds 替代）
  skillIds?: string[];      // 任务选定的部类细则规范 id；空 = 生成时按标题自动匹配
  llmProviderId?: string;   // 任务固定大模型；未设置回退全局当前 Provider
  articleTitle?: string;    // 大模型从用户要求中抓取的文章标题
  userInstruction?: string; // 生成初稿时用户的最新要求（重新生成复用）
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** 志稿（初稿；2026-08-11 删去版本管理后仅保留初稿） */
interface Draft {
  id: string;
  taskId: string;
  versionNumber: number;  // 恒为 0（初稿）
  status: 'editing' | 'confirmed';
  confirmedAt?: string;
  createdAt: string;
  segments: Segment[];    // 读取时联表返回
}

/** 片段（逐片段溯源的最小单元） */
interface Segment {
  id: string;
  draftId: string;
  ordering: number;
  heading?: string;
  content: string;
  aiGenerated: boolean;
  createdAt: string;
  updatedAt: string;
  sources: SegmentSource[];
}

/** 片段-来源 关联（含原文位置标注） */
interface SegmentSource {
  segmentId: string;
  sourceId: string;
  position: string;
  quote?: string;
  sourceTitle?: string;
}

/** RAG 检索返回的相关资料片段 */
interface RetrievedChunk { sourceId: string; sourceTitle: string; position: string; text: string; score: number; }

/** 矛盾检测（Phase 3.7） */
type ContradictionKind = 'data' | 'time' | 'place' | 'fact' | 'other';
type ContradictionStatus = 'pending' | 'adopted' | 'ignored';
interface ContradictionVariant {
  id: string; contradictionId: string;
  variantText: string;
  sourceIds: string[];
  position?: string;
  sourceTitles: string[];   // 服务端 JOIN 填充
  replacement?: string;     // 定位审查预生成的"采纳替换文句"（采纳时本地替换）
}
interface Contradiction {
  id: string; draftId: string; seq: number; topic: string;
  kind: ContradictionKind; status: ContradictionStatus;
  merged: boolean;
  draftQuote?: string;      // 正文定位原句（定位审查回填）
  adoptedVariantId?: string;
  inDraft?: boolean;        // true=在正文（矛盾）/ false=不在正文（警告）/ undefined=定位未执行
  createdAt: string;
  variants: ContradictionVariant[];
}

/** LLM Provider 配置（密钥不回传，只回 apiKeySet） */
interface LlmProviderConfig { id: string; name: string; apiBase: string; model: string; apiKeySet: boolean; }

interface AppSettings { dataDir?: string; currentLlmProviderId?: string; workspaceDir?: string; }

/** 统一错误返回 */
interface ApiError { code: string; message: string; details?: unknown; }
type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };
```

## 2. IPC 通道清单（shared/ipc.ts）

通道命名 `模块:动作`；除注明外，请求/响应均为 `ApiResult<T>` 包裹。

### 2.1 资料（sources）与网页资料库（webSource）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `sources:list` | `{ tagIds?: string[]; search?: string }` → `{ items: Source[] }` | 资料列表（仅长期资料，任务绑定的网页缓存文章不显示），支持标签 AND 与 FTS 关键词过滤 |
| `sources:importFiles` | `{ paths: string[] }` → `{ results: { path, source?, error? }[] }` | 批量导入文件并解析（转存副本，存量路径；工作区资料库已为主路径） |
| `sources:addUrl` | `{ url: string }` → `{ source: Source }` | 添加信源网址并抓取 |
| `sources:get` | `{ id: string }` → `{ source: Source, tags: Tag[] }` | 详情（含原文与标签） |
| `sources:renderHtml` | `{ id: string }` → `{ html: string }` | .docx 转 HTML（mammoth） |
| `sources:getFileUrl` | `{ id: string }` → `{ url: string }` | 内嵌 HTTP 文件服务 URL（PDF/图片渲染） |
| `sources:delete` / `sources:deleteMany` | `{ id }` / `{ ids }` → `{ ok: true }` | 删除资料；工作区文件先移入系统回收站再删库（级联清理） |
| `sources:updateTitle` | `{ id, title }` → `{ source: Source }` | 修改标题（工作区文件同步重命名） |
| `sources:summarizeAll` | `void` → `{ processed, ok, failed }` | 整理资料库：对尚无摘要的资料逐篇调用 LLM 生成摘要 |
| `sources:getSummary` | `{ id: string }` → `{ summary?: {...} }` | 读取单篇资料的 LLM 摘要（摘要/主题词/关键实体） |
| `sources:openPath` | `{ sourceId }` → `{ opened: boolean }` | 用系统默认软件打开来源文件（URL 走浏览器；缺失返回稳定错误） |
| `webSource:list` | `{}` → `{ sites: WebSite[] }` | 网页资料库站点列表 |
| `webSource:add` | `{ rootUrl, title? }` → `{ site: WebSite }` | 注册站点（root_url 去重） |
| `webSource:remove` | `{ id }` → `{ ok: true }` | 删除站点（文章清单级联删除） |
| `webSource:sync` | `{ id }` → `{ articles: number }` | 手动同步站点文章清单，返回新增数 |

### 2.2 标签（tags）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `tags:list` | `{}` → `{ items: Tag[] }` | |
| `tags:create` | `{ name }` → `{ tag: Tag }` | 同名幂等返回已有 |
| `tags:update` | `{ id, name? }` → `{ tag: Tag }` | |
| `tags:delete` | `{ id }` → `{ ok: true }` | 级联解除全部资料关联 |
| `tags:addToSource` / `tags:removeFromSource` | `{ sourceId, tagId }` → `{ ok: true }` | 打标 / 取消打标 |
| `tags:search` | `{ query, limit? }` → `{ items: Tag[] }` | 相似标签建议（bigram Jaccard Top-N） |
| `tags:batchAdd` | `{ tagIds, sourceIds }` → `{ ok: true }` | 批量打标 |
| `tags:sourcesByTag` | `{ tagId }` → `{ sourceIds: string[] }` | 该标签下的资料 id |

### 2.3 写作规范（skills，2026-08-13 由「范本」重构）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `skills:list` | `{}` → `{ items: WritingSkill[] }` | 规范列表（预设 + 自建） |
| `skills:create` | `{ name, category, tags, content }` → `{ skill: WritingSkill }` | 新建 |
| `skills:update` | `{ id, name, category, tags, content }` → `{ skill: WritingSkill }` | 修改（预设规范也可改） |
| `skills:delete` | `{ id }` → `{ ok: true }` | 删除 |

> 原 `templates:*` 通道随范本重构移除（`template_books` 表保留不删，避免迁移风险）。

### 2.3.1 资料汇编（compilation，Phase 6.0，2026-08-25）

三段式撰写第一步的资料汇编契约。当前 `compilation:generate` / `compilation:regenerate` 为已登记通道（AI 服务在 Phase 6.1 实现，暂返回稳定错误），其余 CRUD / 矛盾取舍 / 确认已实现。

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `compilation:list` | `{ taskId }` → `{ compilations: Compilation[] }` | 任务的全部资料汇编（按时间倒序，含卡片与矛盾） |
| `compilation:get` | `{ compilationId }` → `{ compilation: Compilation }` | 读取一次资料汇编 |
| `compilation:generate` | `{ taskId, title }` → `{ compilation: Compilation }` | 生成资料汇编（本地宽召回 + AI 细读；Phase 6.1 实现） |
| `compilation:regenerate` | `{ taskId, title }` → `{ compilation: Compilation }` | 重新生成资料汇编（Phase 6.1 实现） |
| `compilation:updateItem` | `{ itemId, excerpt?, ts?, note?, extraTags?, kept? }` → `{ item: CompilationItem }` | 编辑资料卡片 |
| `compilation:deleteItem` | `{ itemId }` → `{ ok: true }` | 删除资料卡片 |
| `compilation:resolveContradiction` | `{ contradictionId, action: 'resolve'\|'ignore', chosenItemId? }` → `{ contradiction: CompilationContradiction }` | 汇编矛盾取舍：resolve 须传保留的卡片 id（属于该矛盾）；ignore 清空已选 |
| `compilation:confirm` | `{ compilationId }` → `{ compilation: Compilation }` | 确认汇编（finalize），进入下一步 |

### 2.4 撰写与初稿（writing / draft）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `writing:createTask` | `{ title?, scope?, llmProviderId? }` → `{ task: WritingTask }` | 点击"新建任务"立即创建：title 缺省"新建任务"、scope 缺省 `{ all: true }`（全部长期资料） |
| `writing:listTasks` | `{}` → `{ items: WritingTask[] }` | |
| `writing:deleteTask` | `{ id }` → `{ ok: true }` | 删除任务（级联清理 drafts/segments/messages/矛盾，并清理任务绑定的网页缓存文章） |
| `writing:renameTask` | `{ taskId, title }` → `{ task: WritingTask }` | 右键重命名任务标题（仅中栏显示；与文章标题无关） |
| `writing:updateSkills` | `{ taskId, skillIds: string[] \| null }` → `{ task: WritingTask }` | 更新任务选定的部类细则规范（null=自动匹配） |
| `writing:suggestSkills` | `{ taskId, need }` → `{ skillIds: string[] }` | 智能匹配写作规范（单独请求大模型，temperature 0，找不到匹配返回空） |
| `writing:updateProvider` | `{ taskId, llmProviderId: string \| null }` → `{ task: WritingTask }` | 更新任务固定大模型（null=回退全局当前 Provider；校验存在） |
| `writing:chat` | `{ taskId, message, history? }` → `{ reply: string }` | 自由对话（任务大模型 + 注入当前初稿 ≤12000 字；超时 5 分钟；消息由主进程持久化） |
| `taskMessages:list` | `{ taskId }` → `{ items: TaskMessage[] }` | 任务对话历史（role: user/assistant；kind: chat/instruction/notice） |
| `taskMessages:add` | `{ taskId, role, kind, content }` → `{ message: TaskMessage }` | 追加任务消息（一般由主进程自动写入） |
| `writing:retrieve` | `{ taskId }` → `{ chunks: RetrievedChunk[] }` | 任务范围内 RAG 检索预览 |
| `writing:generateDraft` | `{ taskId, instruction }` → `{ draft: Draft, articleTitle: string \| null, contradictions: Contradiction[] }` | 生成第 0 稿（幂等：已有初稿直接返回既有稿与矛盾清单）。阶段进度经事件 `draft:generateProgress` 推送 |
| `draft:get` | `{ draftId }` → `{ draft: Draft }` | 读取某稿（含片段与来源） |
| `draft:getLatest` | `{ taskId }` → `{ draft: Draft }` | 读取任务最新一稿（仅初稿） |
| `draft:updateContent` | `{ draftId, markdown }` → `{ draft: Draft }` | 整稿保存（按标题行重建片段） |
| `draft:regenerate` | `{ taskId, instruction }` → 同 generateDraft | 删除现有第 0 稿后重新生成（覆盖旧稿） |
| `draft:getContradictions` | `{ draftId }` → `{ contradictions: Contradiction[] }` | 读取矛盾清单 |
| `draft:resolveContradiction` | `{ contradictionId, action: 'adopt'\|'ignore'\|'revert', variantId? }` → `{ contradiction: Contradiction }` | 矛盾取舍：adopt 须带属于该矛盾的说法 id；ignore 清空采纳；revert=撤销采纳（配合编辑器撤销回退为待处理）。仅标记状态，不修改正文 |
| `draft:applyContradiction` | `{ draftId, contradictionId, variantId }` → `{ draft: Draft, contradiction: Contradiction }` | 采纳 → 正文本地替换（from=draftQuote → to=replacement，移除 `【矛盾#N】` 标注，整稿落库，不调用大模型，资料库只读；from 未逐字匹配则失败且状态不变） |
| `writing:askSource` | `{ taskId, selection }` → `{ reply: string, refs: SourceRef[] }` | 文段来源询问：本地精确匹配 → 生成上下文溯源 → 过滤式检索 → LLM 兜底；询问/回复写入 task_messages；`refs` 与回复中 `#N` 对应。`SourceRef = { index, sourceId, title, position? }` |
| `segment:update` | `{ segmentId, content }` → `{ segment: Segment }` | 修改文段（Markdown，记 review_records；整稿编辑器启用后不再使用，保留兼容） |

### 2.5 LLM 与设置（llm / settings）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `llm:listProviders` | `{}` → `{ items: LlmProviderConfig[] }` | 只回 `apiKeySet`，不回密钥 |
| `llm:saveProvider` | `{ id?, name, apiBase, model, apiKey? }` → `{ provider: LlmProviderConfig }` | apiKey 本地加密存储（更新时留空保持原密钥） |
| `llm:deleteProvider` | `{ id }` → `{ ok: true }` | 删除（若为当前 Provider 同步清除设置） |
| `llm:testConnection` | `{ id }` → `{ ok: true }` | 连通性测试（15s 超时，错误映射 LLM 错误码） |
| `settings:get` | `{}` → `{ settings: AppSettings }` | |
| `settings:update` | `{ patch: Partial<AppSettings> }` → `{ settings: AppSettings }` | 校验 Provider/工作区目录存在性 |

### 2.6 工作区（workspace，Phase 2.2）与对话框 / 应用 / 诊断

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `workspace:status` | `{}` → `{ workspaceDir?, workspaceSources, legacySources, totalSources }` | 工作区状态与资料统计 |
| `workspace:progress`（主进程推送事件） | `{ done, total, newFiles?, added?, changed?, removed?, moved?, errors?, finished? }` | 自动同步进度推送（含 finished 完成事件与最终计数；手动「同步工作区」按钮已于 2026-08-24 移除，由聚焦/进资料库/每分钟/设置变更/监听增量自动触发） |
| `workspace:navSync` | `{}` → `{}` | 进入"资料库"功能区时自动触发一次同步 |
| `workspace:migrate` | `{}` → `{ migrated, failed, skipped }` | 一次性迁移存量导入资料到工作区 |
| `app:openFileDialog` | `{}` → `{ paths: string[] }` | 系统文件选择对话框（主进程打开，仅回传路径） |
| `app:openDirectoryDialog` | `{}` → `{ path: string \| null }` | 系统目录选择对话框（工作区选择） |
| `app:getInfo` | `{}` → `{ version, platform }` | 应用版本与平台 |
| `app:openExternal` | `{ url }` → `{ ok: true }` | 打开外部链接（http/https 白名单，预设模型注册页等） |
| `clipboard:readText` | `{}` → `{ text: string }` | 读取系统剪贴板纯文本（自定义右键菜单「粘贴」经主进程访问 clipboard） |
| `clipboard:writeText` | `{ text }` → `{ ok: true }` | 写入系统剪贴板纯文本（自定义右键菜单「复制/剪切」经主进程访问 clipboard） |
| `window:focus` | `{}` → `{ ok: true }` | 请求主进程恢复窗口激活（输入失焦兜底） |
| `log:append` | `{ level?, tag, message }` → `{ ok: true }` | 渲染进程上报诊断日志（脱敏） |
| `log:export` | `{}` → `{ path, fileName }` | 导出诊断日志文件（含大模型提交物记录） |

## 3. 错误返回格式

统一结构：

```
{ ok: true, data }          // 成功
{ ok: false, error: { code, message, details? } }   // 失败
```

错误码分类（稳定、可读、不泄露 URL/正文）：

- **资料**：`SOURCE_NOT_FOUND`、`SOURCE_DUPLICATE`、`PARSE_UNSUPPORTED`、`PARSE_FAILED`
- **信源**：`URL_INVALID`、`URL_BLOCKED`（协议白名单外）、`FETCH_FAILED`、`FETCH_TIMEOUT`
- **LLM**：`LLM_UNAUTHORIZED`、`LLM_TIMEOUT`、`LLM_RATE_LIMIT`、`LLM_NETWORK`、`LLM_PROVIDER_ERROR`、`LLM_EMPTY_RESPONSE`、`LLM_FORMAT_INVALID`、`LLM_NO_CANDIDATES`
- **撰写**：`TASK_NOT_FOUND`、`DRAFT_NOT_FOUND`、`TASK_NO_SCOPE`、`TASK_NO_PROVIDER`
- **通用**：`INVALID_PARAM`、`INTERNAL_ERROR`

## 4. 生成初稿的契约（Phase 3.5：指令驱动 + JSON 输出）

- 请求：`writing:generateDraft { taskId, instruction }`（`instruction` 为用户要求，应包含标题与可能的其他要求）。
- 提交物：写作规范上下文（通用规范注入 system prompt，部类细则注入 user prompt，标注"仅作写作规范"）+ 资料库检索到的全部有效材料 + 用户要求。
- 大模型输出要求为 JSON（缺标题等必要信息时输出 error 详情）：

```json
{ "title": "抓取的文章标题", "content": "完整连贯的志书小节正文（Markdown）", "error": null }
```

或（用户要求缺少标题等必要信息时）：

```json
{ "title": null, "content": null, "error": "详细说明缺少什么、应如何补充" }
```

- 服务端解析：`error` 非空 → 直接报错给用户；`title` + `content` 齐全 → `title` 更新任务的 `article_title`，`content` 整篇存为单个片段（第 0 稿，连续显示）；无法解析 → `LLM_FORMAT_INVALID`。
- 检索查询词为 `instruction`；任务范围固定为资料库全部文件（`scope: { all: true }`，旧任务保留原 scope 兼容）；检索为"摘要级粗筛 + chunk 级过滤式精检"（词法 score>0 或向量余弦 ≥0.3 的段落全部保留，不做 Top-N 截断）。
- 矛盾检测（Phase 3.7）：生成前对检索材料做**矛盾预扫描**（低温度 + 温度阶梯 0→0.3→0.7 重试；主题聚类 + 整组窗口并发扫描；只扫"撰写实际用到的检索文段"），扫描结果以"材料矛盾提示"区块注入生成 system prompt（**严禁将矛盾说法自然合并/折中**，分开并列表述或只取一种 + 正文插 `【矛盾#N】` 标注）；初稿落库后做**矛盾定位审查**（回填 `draftQuote/merged/inDraft` 与每个说法的采纳替换文句 `replacements`）。扫描/定位失败独立降级不阻断生成。
- 矛盾 vs 警告：`draftQuote` 非空（在正文）→ 矛盾（可采纳/忽略）；为空（不在正文）→ 警告（仅查看/忽略）。定位未执行按矛盾展示。
- 重新生成：`draft:regenerate { taskId, instruction }`（删除现有第 0 稿后按当前要求/资料/规范重新生成）。
- 自由对话：`writing:chat { taskId, message, history? }` → `{ reply }`（任务大模型 + 初稿上下文 ≤12000 字，超时 5 分钟）。
- 文段来源询问：`writing:askSource { taskId, selection }` → `{ reply, refs }`。① 原文逐字精确匹配（秒回）；② 生成上下文溯源（`draft_generation_sources` Top-N 注入提示词）；③ 过滤式混合检索；④ LLM 兜底（文件编号清单）。询问与回复写入 `task_messages`；回复中 `#N` 按 refs 渲染为可点击链接。
- 矛盾采纳 → 正文同步修订：`draft:applyContradiction` 为**纯本地替换**（from=draftQuote → to=replacement + 移除标注 + 整稿落库），失败返回稳定错误且状态不变；资料库只读。
- 痕迹持久化：每次 LLM 调用写入 `llm_call_logs`（task_id、kind、model、输入/输出字符数、耗时、状态、错误码；不存密钥与正文）；生成/对话记录写入 `task_messages`。

## 5. 安全边界

- Renderer 只能通过 preload 暴露的 `window.api.*` 调用白名单通道，不得获得不受限制的 Node/文件系统访问（sandbox + contextIsolation）。
- 每个 handler 在主进程校验参数；信源抓取限定 http(s) 且仅用户提供的 URL（防 SSRF）；外部链接（app:openExternal）同样 http/https 白名单。
- 密钥仅存本地（`safeStorage` 加密），任何列表接口只返回 `apiKeySet` 布尔值；日志与导出日志均脱敏，不包含 URL/正文/凭证。
