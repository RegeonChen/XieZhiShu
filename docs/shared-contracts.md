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

/** 志稿版本（第 n 稿） */
interface Draft {
  id: string;
  taskId: string;
  versionNumber: number;  // 0 = 初稿
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
| `templates:import` | `{ path: string }` → `{ template: TemplateBook }` | 上传并解析篇目结构 |
| `templates:get` | `{ id }` → `{ template: TemplateBook }` | |
| `templates:delete` | `{ id }` → `{ ok: true }` | |

### 2.4 撰写与初稿（writing / draft）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `writing:createTask` | `{ title, scope: { sourceIds } \| { tagIds }, templateBookId? }` → `{ task: WritingTask }` | 校验范围非空 |
| `writing:listTasks` | `{}` → `{ items: WritingTask[] }` | |
| `writing:deleteTask` | `{ id }` → `{ ok: true }` | 删除任务（级联清理 drafts/segments/sources） |
| `writing:retrieve` | `{ taskId }` → `{ chunks: RetrievedChunk[] }` | 任务范围内 RAG 检索预览（片段 + 来源 + 位置） |
| `writing:generateDraft` | `{ taskId }` → `{ draft: Draft }` | AI 生成第 0 稿（结构化片段 + 来源） |
| `draft:get` | `{ draftId }` → `{ draft: Draft }` | 读取某稿（含片段与来源） |
| `draft:confirm` | `{ draftId }` → `{ nextDraft: Draft }` | 确认当前稿 → 生成第 n+1 稿 |
| `segment:update` | `{ segmentId, content }` → `{ segment: Segment }` | 修改文段（内容为 Markdown，记 review_records） |
| `segment:resolveConflict` | `{ segmentId, chosenSourceId, note? }` → `{ segment: Segment }` | 矛盾裁定：采纳某来源的记述 |
| `segment:addManual` | `{ draftId, heading?, content, insertAfter? }` → `{ segment: Segment }` | 事件缺失手动补写 |
| `segment:insertGenerated` | `{ draftId, heading?, scope, insertAfter? }` → `{ segment: Segment }` | 导入新资料后 AI 生成并插入 |

### 2.5 版本（version）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `version:list` | `{ taskId }` → `{ versions: { draftId, versionNumber, status, confirmedAt }[] }` | |
| `version:compare` | `{ taskId, a: number, b: number }` → `{ diff: SegmentDiff[] }` | 版本差异对比（片段级） |
| `version:rollback` | `{ taskId, toVersion: number }` → `{ draft: Draft }` | 回滚到目标版本 |

### 2.6 LLM 与设置（llm / settings）

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
| `workspace:reconcile` | `{}` → `{ workspaceDir, added, changed, removed, moved, errors, total }` | 全量对账（扫描 + 解析 + 索引） |
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

## 4. 生成初稿的契约（结构化输出）

- 请求：`writing:generateDraft { taskId }`。
- 大模型输出要求为 JSON：

```json
{
  "segments": [
    { "heading": "片段小标题", "content": "片段正文", "sources": [ { "sourceId": "…", "position": "第3段" } ] }
  ]
}
```

- 服务端解析与校验：片段非空；`sourceId` 必须存在于任务范围内；不满足时按"解析失败 → 受控重试一次"处理（结构化兼容策略，参考项目经验）。
- 人工改写的片段 `aiGenerated = false`，界面以样式区分。

## 5. 安全边界

- Renderer 只能通过 preload 暴露的 `window.api.*` 调用白名单通道，不得获得不受限制的 Node/文件系统访问。
- 每个 handler 在主进程校验参数；信源抓取限定 http(s) 且仅用户提供的 URL（防 SSRF）。
- 密钥仅存本地（`safeStorage` 加密），任何列表接口只返回 `apiKeySet` 布尔值；日志不得包含 URL/正文/凭证。
