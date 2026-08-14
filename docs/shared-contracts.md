# 共享契约与 IPC 清单（docs/shared-contracts.md）

> 状态：规划产物（2026-08-03），对应 `PLAN.md` Task 1.2，落地为 `shared/types.ts` 与 `shared/ipc.ts`。
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
  createdAt: string;
  updatedAt: string;
}

interface Tag { id: string; name: string; createdAt: string; }

interface TemplateBook {
  id: string;
  name: string;
  filePath: string;
  outline: string;        // outline_json，篇目层级结构（原始 JSON 字符串）
  styleProfile?: string;  // style_profile_json
  createdAt: string;
}

/** 撰写任务 */
interface WritingTask {
  id: string;
  title: string;
  scope: { sourceIds: string[] } | { tagIds: string[] };  // 二者取一
  templateBookId?: string;
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
  sources: SegmentSource[];  // 读取时联表返回
}

/** 片段-来源 关联（含原文位置标注） */
interface SegmentSource {
  segmentId: string;
  sourceId: string;
  position: string;       // 文件：页码/段落序号；URL：段落序号
  quote?: string;         // 原文摘句
  sourceTitle?: string;   // 来源标题（服务端 JOIN 填充，供界面展示）
}

/** RAG 检索返回的相关资料片段（writing:retrieve） */
interface RetrievedChunk {
  sourceId: string;
  sourceTitle: string;
  position: string;
  text: string;
  score: number;
}

/** 审核动作记录 */
interface ReviewRecord {
  id: string;
  draftId: string;
  segmentId?: string;
  action: 'conflict' | 'missing' | 'edit' | 'insert';
  beforeContent?: string;
  afterContent?: string;
  note?: string;
  createdAt: string;
}

/** LLM Provider 配置（密钥不回传，只回 apiKeySet） */
interface LlmProviderConfig {
  id: string;
  name: string;
  apiBase: string;
  model: string;
  apiKeySet: boolean;   // 是否已设置密钥
}

interface AppSettings {
  dataDir?: string;
  currentLlmProviderId?: string;
  workspaceDir?: string;    // Phase 2.2 工作区根目录（用户指定，资料直接引用该文件夹内文件）
  // 后续可按需扩展
}

/** 统一错误返回 */
interface ApiError { code: string; message: string; details?: unknown; }
type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };
```

## 2. IPC 通道清单（shared/ipc.ts）

通道命名 `模块:动作`；除注明外，请求/响应均为 `ApiResult<T>` 包裹。

### 2.1 资料（sources）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `sources:list` | `{ tagIds?: string[]; search?: string }` → `{ items: Source[] }` | 资料列表，支持标签与关键词过滤 |
| `sources:importFiles` | `{ paths: string[] }` → `{ results: { path, source?, error? }[] }` | 批量导入文件并解析，逐文件成功/失败 |
| `sources:addUrl` | `{ url: string }` → `{ source: Source }` | 添加信源网址并抓取 |
| `sources:refresh` | `{ id: string }` → `{ source: Source }` | 重新抓取/解析（懒加载与重试） |
| `sources:get` | `{ id: string }` → `{ source: Source }` | 详情（含原文） |
| `sources:delete` | `{ id: string }` → `{ ok: true }` | 级联删除关联标签与片段来源 |
| `sources:updateTitle` | `{ id, title }` → `{ source: Source }` | 修改标题 |
| `sources:summarizeAll` | `void` → `{ processed, ok, failed }` | 整理资料库：对尚无摘要的资料逐篇调用 LLM 生成摘要（Task 3.2.3） |
| `sources:getSummary` | `{ id: string }` → `{ summary?: {...} }` | 读取单篇资料的 LLM 摘要（摘要/主题词/关键实体） |

### 2.2 标签（tags）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `tags:list` | `{}` → `{ items: Tag[] }` | |
| `tags:create` | `{ name }` → `{ tag: Tag }` | |
| `tags:update` | `{ id, name? }` → `{ tag: Tag }` | |
| `tags:delete` | `{ id }` → `{ ok: true }` | |
| `tags:addToSource` | `{ sourceId, tagId }` → `{ ok: true }` | 打标 |
| `tags:removeFromSource` | `{ sourceId, tagId }` → `{ ok: true }` | 取消打标 |

### 2.3 范本（templates）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `templates:list` | `{}` → `{ items: TemplateBook[] }` | |
| `templates:import` | `{ path: string }` → `{ template: TemplateBook }` | 导入并解析（含大模型行文范例增强提取，进度事件 `templates:importProgress`） |
| `templates:get` | `{ id }` → `{ template: TemplateBook }` | |
| `templates:delete` | `{ id }` → `{ ok: true }` | |
| `templates:reanalyze` | `{ id }` → `{ template: TemplateBook }` | 重新分析范本篇目结构与体例特征（Phase 3.3.1 增强：识别改进后无需重导；LLM 未配置时降级本地） |

### 2.4 撰写与初稿（writing / draft）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `writing:createTask` | `{ title?, scope?, templateBookId?, llmProviderId? }` → `{ task: WritingTask }` | Phase 3.5：点击"新建任务"立即创建——`title` 缺省为"新建任务"（中栏列表显示，可右键重命名）、`scope` 缺省为 `{ all: true }`（资料库全部文件，用户不可自定）；可传范本/大模型 |
| `writing:listTasks` | `{}` → `{ items: WritingTask[] }` | |
| `writing:deleteTask` | `{ id }` → `{ ok: true }` | 删除任务（级联清理 drafts/segments/sources） |
| `writing:renameTask` | `{ taskId, title }` → `{ task: WritingTask }` | Phase 3.5：右键重命名任务标题（仅中栏列表显示；与文章标题无关） |
| `writing:updateTemplate` | `{ taskId, templateBookId }` → `{ task: WritingTask }` | 更新任务关联的参考范本（Phase 3.3.2；`templateBookId: null` = 不使用范本，校验范本存在；初稿已生成后前端禁用） |
| `writing:updateProvider` | `{ taskId, llmProviderId }` → `{ task: WritingTask }` | Phase 3.5：更新任务固定使用的大模型（`null` = 回退全局当前 Provider；校验 Provider 存在） |
| `writing:chat` | `{ taskId, message, history? }` → `{ reply: string }` | Phase 3.5：与大模型自由对话（用任务大模型；注入当前初稿作上下文；history 为最近对话；超时 5 分钟；消息由主进程持久化到 task_messages） |
| `taskMessages:list` | `{ taskId }` → `{ items: TaskMessage[] }` | 读取任务对话历史与痕迹（role: user/assistant；kind: chat/instruction/notice；按时间升序） |
| `taskMessages:add` | `{ taskId, role, kind, content }` → `{ message: TaskMessage }` | 追加任务消息（一般由主进程在生成/对话时自动写入） |
| `writing:askSource` | `{ taskId, selection }` → `{ reply: string, refs: SourceRef[] }` | 文段来源询问（Phase 3.7 Task 3.7.5 + 2026-08-11 增强）：本地精确匹配 → **生成上下文溯源**（用该稿生成时实际使用的检索材料 Top-N 注入提示词，让大模型结合材料判断文段源自哪些文件，正文被改写后仍可溯源）→ 过滤式检索（词法 + 向量）→ LLM 兜底（注入文件编号清单）；询问与回复由主进程写入 `task_messages`（user 消息带「【文段来源询问】」标签）；`refs` 与回复文本中的 `#N` 对应，前端渲染为可点击链接（`sources:openPath` 打开原文）。`SourceRef = { index, sourceId, title, position? }` |
| `writing:retrieve` | `{ taskId }` → `{ chunks: RetrievedChunk[] }` | 任务范围内 RAG 检索预览（片段 + 来源 + 位置） |
| `writing:generateDraft` | `{ taskId, instruction }` → `{ draft: Draft, articleTitle: string \| null, contradictions: Contradiction[] }` | 生成第 0 稿。`instruction` 为用户要求（应包含标题）；Phase 3.5 起输出契约为 JSON `{ title, content, error }`——缺标题等必要信息时大模型返回 `error` 详情直接报错；成功后 `articleTitle` 入库并回传。Phase 3.7 起在生成前做矛盾预扫描、生成后做矛盾定位审查，`contradictions` 为发现的材料矛盾清单（含正文定位回填） |
| `draft:get` | `{ draftId }` → `{ draft: Draft }` | 读取某稿（含片段与来源） |
| `draft:updateContent` | `{ draftId, markdown }` → `{ draft: Draft }` | 整稿保存（Task 3.4.1：初稿连续显示，编辑后按整稿 Markdown 保存并重建片段） |
| `draft:regenerate` | `{ taskId, instruction }` → `{ draft: Draft, articleTitle: string \| null, contradictions: Contradiction[] }` | 重新生成初稿（Task 3.4.5 + Phase 3.5：删除现有第 0 稿后按当前要求/资料/范本重新生成，覆盖旧稿；Phase 3.7 起同样返回矛盾清单） |
| `draft:getContradictions` | `{ draftId }` → `{ contradictions: Contradiction[] }` | 读取某稿的矛盾清单（Phase 3.7：矛盾弹窗 / 编辑器标注初始化） |
| `draft:resolveContradiction` | `{ contradictionId, action: 'adopt'\|'ignore', variantId? }` → `{ contradiction: Contradiction }` | 矛盾取舍（Phase 3.7：采纳某说法须带属于该矛盾的说法 id；忽略清空已采纳说法）。仅标记状态、**不修改正文** |
| `draft:applyContradiction` | `{ draftId, contradictionId, variantId }` → `{ draft: Draft, contradiction: Contradiction }` | 矛盾采纳 → 正文同步修订（2026-08-11 本地替换版）：定位审查（生成阶段）已为每个说法预生成替换文句 `replacement`，采纳时主进程**不调用大模型**，仅本地替换——`from`=该矛盾正文原句 `draft_quote`（起止定位），`to`=被采纳说法的 `replacement`；校验 `from` 逐字存在于正文后替换、移除该矛盾 `【矛盾#N】` 标注并整稿落库，状态置 adopted；资料库只读。失败（缺定位/缺替换文句/正文已被手动修改导致 `from` 未匹配）返回稳定错误且状态不变 |
| `sources:openPath` | `{ sourceId }` → `{ opened: boolean }` | 用系统默认软件打开资料源文件（Phase 3.7：工作区 / 存量导入路径解析 + `shell.openPath`；URL 资料走 `shell.openExternal`；文件缺失返回稳定错误） |
| `draft:getLatest` | `{ taskId }` → `{ draft: Draft }` | 读取任务最新一稿（删去版本管理后仅保留初稿；替代原 `version:list` 定位最新稿） |
| `segment:update` | `{ segmentId, content }` → `{ segment: Segment }` | 修改文段（内容为 Markdown，记 review_records；整稿编辑器启用后不再使用，保留兼容） |
| `segment:resolveConflict` | `{ segmentId, chosenSourceId, note? }` → `{ segment: Segment }` | 矛盾裁定：采纳某来源的记述 |
| `segment:addManual` | `{ draftId, heading?, content, insertAfter? }` → `{ segment: Segment }` | 事件缺失手动补写 |
| `segment:insertGenerated` | `{ draftId, heading?, scope, insertAfter? }` → `{ segment: Segment }` | 导入新资料后 AI 生成并插入 |

### 2.5 LLM 与设置（llm / settings）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `llm:listProviders` | `{}` → `{ items: LlmProviderConfig[] }` | 只回 `apiKeySet`，不回密钥 |
| `llm:saveProvider` | `{ id?, name, apiBase, model, apiKey? }` → `{ provider: LlmProviderConfig }` | apiKey 本地加密存储 |
| `llm:deleteProvider` | `{ id }` → `{ ok: true }` | |
| `llm:testConnection` | `{ id }` → `{ ok: true }` | 连通性测试 |
| `settings:get` | `{}` → `{ settings: AppSettings }` | |
| `settings:update` | `{ patch: Partial<AppSettings> }` → `{ settings: AppSettings }` | |

### 2.7 工作区（workspace，Phase 2.2）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `app:openDirectoryDialog` | `{}` → `{ path: string \| null }` | 系统目录选择对话框 |
| `workspace:status` | `{}` → `{ workspaceDir?, workspaceSources, legacySources, totalSources }` | 工作区状态与资料统计 |
| `workspace:reconcile` | `{}` → `{ workspaceDir, added, changed, removed, moved, errors, total }` | 全量对账（扫描 + 解析 + 索引）；手动"同步工作区"按钮 |
| `workspace:navSync` | `{}` → `{}` | 进入"资料库"功能区时自动触发一次同步（Task 2.2.5，效果等同手动按钮） |
| `workspace:migrate` | `{}` → `{ migrated, failed, skipped }` | 一次性迁移存量导入资料到工作区 |
| `sources:updateTitle` | `{ id, title }` → `{ source: Source }` | 修改标题（工作区文件同步重命名） |
| `sources:delete` / `sources:deleteMany` | 见 2.1 | 工作区文件先移入系统回收站，再删库 |

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
- 提交物：参考范本上下文（`formatTemplateContext`，若有）+ 资料库检索到的全部有效材料 + 用户要求。
- 大模型输出要求为 JSON（缺标题等必要信息时输出 error 详情）：

```json
{ "title": "抓取的文章标题", "content": "完整连贯的志书小节正文（Markdown）", "error": null }
```

或（用户要求缺少标题等必要信息时）：

```json
{ "title": null, "content": null, "error": "详细说明缺少什么、应如何补充" }
```

- 服务端解析：`error` 非空 → 直接报错给用户；`title` + `content` 齐全 → `title` 更新任务的 `article_title`，`content` 整篇存为单个片段（第 0 稿，连续显示）；无法解析 → `LLM_FORMAT_INVALID`。
- 检索查询词为 `instruction`；任务范围固定为资料库全部文件（`scope: { all: true }`，旧任务保留原 scope 兼容）。
- 矛盾检测（Phase 3.7 Task 3.7.2）：生成前对检索材料做**矛盾预扫描**（独立调用，输出 `{ contradictions: [...] }`，按事实主题分组、支持同主题 3+ 来源、`#N` 来源编号引用），扫描结果以"材料矛盾提示"区块注入生成 system prompt（**严禁将矛盾说法自然合并/折中**，应分开并列表述或只取一种，并在正文插入 `【矛盾#N】` 标注）；初稿落库后再做**矛盾定位审查**（独立调用，输出 `{ items: [{ seq, draftQuote, merged, replacements }] }`——`draftQuote` 回填正文定位原句、`merged` 为"是否被合并"兜底标记、`replacements` 为每个说法（`variantIndex` 与说法编号对应）的"采纳替换文句"，一并回填 `draft_contradictions.in_draft` 与 `contradiction_variants.replacement`）。扫描/定位失败均不阻断生成（分别降级为"无矛盾清单" / "矛盾保留但无正文定位"），各自独立 10 分钟超时；两阶段调用分别记 `llm_call_logs`（kind: contradiction-scan / contradiction-locate）。
- 矛盾 vs 警告（2026-08-11）：定位审查成功时据 `draftQuote` 判定——`draftQuote` 非空（在正文）→ **矛盾**（可采纳修订/忽略，正文有标注）；`draftQuote` 为空（不在正文）→ **警告**（工具栏"警告"按钮并列展示，仅查看来源说法与忽略，不提供采纳修订、不影响正文）。定位未执行（旧数据/定位失败）按矛盾展示。
- 重新生成：`draft:regenerate { taskId, instruction }`（删除现有第 0 稿后按当前要求/资料/范本重新生成，覆盖旧稿）。
- 自由对话：`writing:chat { taskId, message, history? }` → `{ reply }`（用任务大模型，注入当前初稿作上下文，供"修改初稿"类请求参考；超时 5 分钟）。
- 文段来源询问（Phase 3.7 Task 3.7.5，2026-08-11 增强）：`writing:askSource { taskId, selection }` → `{ reply, refs }`。选中正文右键「询问文段来源」触发，选中文段 ≤300 字。主进程**本地优先**：① 原文片段逐字精确匹配（整句/子串，命中即返回来源标题 + 段落位置）；② 未命中走**生成上下文溯源**——读取该稿生成时实际使用的检索材料（`draft_generation_sources`，Migration 010），按与选中文段的字符重叠取 Top-N 注入提示词（文件编号清单 + 文段 + 材料块），让大模型判断文段源自哪些文件（正文经改写后逐字匹配失效，结合生成时材料仍可同源推断）；③ 无生成上下文或溯源失败，回退过滤式混合检索（词法 + 向量）；④ 仍未命中走 **LLM 兜底**（注入文件编号清单）。询问（带「【文段来源询问】」标签的 user 消息）与回复（assistant 消息）均写入 `task_messages` 持久化；回复中的 `#N` 按 `refs` 在对话面板渲染为可点击链接（`sources:openPath` 打开原文）。
- 矛盾采纳 → 正文同步修订（2026-08-11 本地替换版）：`draft:applyContradiction { draftId, contradictionId, variantId }` → `{ draft, contradiction }`。定位审查在**生成阶段**即返回每个说法的"采纳替换文句"（`replacements`，存 `contradiction_variants.replacement`），故采纳时**不调用大模型**：主进程用 `from`=该矛盾正文原句 `draft_quote`（定位审查回填的起止定位）、`to`=被采纳说法 `replacement` 做本地字符串替换，校验 `from` 逐字存在于正文后应用，移除该矛盾 `【矛盾#N】` 标注，整稿落库（`replaceDraftSegments`），状态置 adopted；`from` 未匹配（正文被手动修改）/ 缺定位 / 缺替换文句即失败返回且状态不变。**资料库（工作区文件）只读，绝不修改**；采纳后前端重挂载编辑器展示修订结果。
- 痕迹持久化：每次大模型调用写入 `llm_call_logs`（task_id、kind: generate/chat/summarize/template/misc、model、输入/输出字符数、耗时 ms、状态、错误码与信息；不存密钥与正文）——用于诊断"生成慢/超时"类问题；对话与生成记录写入 `task_messages`。

## 5. 安全边界

- Renderer 只能通过 preload 暴露的 `window.api.*` 调用白名单通道，不得获得不受限制的 Node/文件系统访问。
- 每个 handler 在主进程校验参数；信源抓取限定 http(s) 且仅用户提供的 URL（防 SSRF）。
- 密钥仅存本地（`safeStorage` 加密），任何列表接口只返回 `apiKeySet` 布尔值；日志不得包含 URL/正文/凭证。
