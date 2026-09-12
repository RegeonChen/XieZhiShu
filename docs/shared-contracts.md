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

/** 撰写任务（2026-09：拆分为「生成汇编 / 撰写初稿」两个功能区） */
interface WritingTask {
  id: string;
  title: string;
  mode: 'compile' | 'draft';  // 任务类型：compile=生成汇编，draft=撰写初稿（Migration 028）
  scope: { all: true } | { sourceIds: string[] } | { tagIds: string[] };  // Phase 3.5 起固定 { all: true }，旧任务兼容保留
  llmProviderId?: string;   // 任务固定大模型；未设置回退全局当前 Provider
  articleTitle?: string;    // 大模型从用户要求中抓取的文章标题
  userInstruction?: string; // 生成初稿时用户的最新要求（重新生成复用）
  modelText?: string;       // （Phase 6.4.2）第二步「添加范本」的任务级示例正文，生成初稿时作为【参考范本】注入
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

> **2026-09（撰写拆分）**：`writing:createTask` 新增可选 `mode`（`compile`/`draft`，缺省 `compile`），`writing:listTasks` 新增可选 `mode` 过滤；新增 IPC `compilation:exportDocx`、`compilation:exportArchive`（导出 `.docx`/`.xzsc`）、`compilation:importFromTask`（从生成汇编已完成任务深拷贝资料汇编到撰写初稿任务）、`compilation:listFinalizedForImport`（列出可导入的已完成汇编）、`compilation:importArchive`（外部 `.xzsc` 导入，当前返回 `NOT_IMPLEMENTED` 占位）。

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

/** 资料汇编（Phase 6：三段式撰写第一步） */
type CompilationStatus = 'drafting' | 'reviewing' | 'finalized';
type CompilationContradictionStatus = 'pending' | 'resolved' | 'ignored';
interface CompilationItem {
  id: string; compilationId: string; position: number; sourceId: string;
  excerpt: string; ts?: string; note?: string; extraTags: string[]; kept: boolean;
  sourceTitle?: string;   // 服务端 JOIN 填充
  createdAt: string;
}
interface CompilationContradictionVariant {
  id: string; contradictionId: string; itemId: string; variantText: string;
  sourceId: string; sourceTitle?: string; createdAt: string;
}
interface CompilationContradiction {
  id: string; compilationId: string; topic: string; kind: ContradictionKind;
  status: CompilationContradictionStatus; chosenItemId?: string; createdAt: string;
  variants: CompilationContradictionVariant[];
}
type CompilationRepairStatus = 'pending' | 'accepted' | 'rejected';
interface CompilationRepair {
  id: string; compilationId: string; itemId: string; originalText: string;
  revisedText: string; reason: string; status: 'applied' | 'reverted';   // 2026-09-08 起：默认应用，可回退/再次应用
  createdAt: string; updatedAt: string;
}
interface Compilation {
  id: string; taskId: string; title: string; status: CompilationStatus;
  createdAt: string; updatedAt: string;
  items: CompilationItem[]; contradictions: CompilationContradiction[]; repairs?: CompilationRepair[];
}
/** 汇编回收站条目（判别联合：资料卡片 / 矛盾；大模型修正不再入回收站，改由卡片标记承载） */
type CompilationRecycleBinItem =
  | { kind: 'contradiction'; id: string; contradiction: CompilationContradiction }
  | { kind: 'card'; id: string; item: CompilationItem };

/** 规范文档库（Phase 6.4.1） */
interface StyleGuide { id: string; name: string; content: string; isDefault: boolean; createdAt: string; updatedAt: string; }

/** LLM Provider 配置（密钥不回传，只回 apiKeySet） */
interface LlmProviderConfig { id: string; name: string; apiBase: string; model: string; apiKeySet: boolean; concurrency?: number; }

interface AppSettings { dataDir?: string; workspaceDir?: string; compilationProviderId?: string; draftProviderId?: string; keepAwake?: boolean; }

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
| `sources:delete` / `sources:deleteMany` | `{ id }` / `{ ids }` → `{ ok: true, data?: { pendingCascade?: boolean } }` | 删除资料；工作区文件先移入系统回收站再删库。若该资料已被资料汇编引用，暂不删库，登记级联清理待确认（`pendingCascade: true`），由 `workspace:sourceRemoval:decide` 处理（单删与批量删除均触发；批量会逐个来源弹确认框） |
| `sources:updateTitle` | `{ id, title }` → `{ source: Source }` | 修改标题（工作区文件同步重命名） |
| `sources:summarizeAll` | `void` → `{ processed, ok, failed }` | 整理资料库：对尚无摘要的资料逐篇调用 LLM 生成摘要 |
| `sources:getSummary` | `{ id: string }` → `{ summary?: {...} }` | 读取单篇资料的 LLM 摘要（摘要/主题词/关键实体） |
| `sources:openPath` | `{ sourceId }` → `{ opened: boolean }` | 用系统默认软件打开来源文件（URL 走浏览器；缺失返回稳定错误） |
| `webSource:list` | `{}` → `{ sites: WebSite[] }` | 网页资料库站点列表 |
| `webSource:add` | `{ rootUrl, title? }` → `{ site: WebSite }` | 注册站点（root_url 去重） |
| `webSource:remove` | `{ id }` → `{ ok: true }` | 删除站点（文章清单级联删除） |
| `webSource:update` | `{ id, rootUrl?, title? }` → `{ site: WebSite }` | 修改站点名称/根网址（根网址重复返回错误） |

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

> Phase 6.4：**「写作规范 skills」模块整体移除**——`skills:*` 通道、`WritingSkill` 类型、`writing_skills` 表（Migration 018 删除）与任务 `skill_ids` 选择均不再存在；生成初稿时改用共享的 `DEFAULT_STYLE_GUIDE`（合并「志书文体文风」+「志书行文规则」）作为默认行文规范注入。原 `templates:*`/`template_books` 亦已随范本重构移除/保留不删。

### 2.3.1 资料汇编（compilation，Phase 6.0，2026-08-25）

三段式撰写第一步的资料汇编契约。`compilation:generate` / `compilation:regenerate` 在 Phase 6.1 已接入生成服务（本地宽召回宁多勿漏 + AI 细读 + **大模型提纯** + 大模型修正 + 矛盾标注；无 Provider / 失败降级为本地候选卡片）；生成进度经事件 `compilation:progress` 推送。CRUD / 矛盾取舍 / 确认已实现。

> **生成管线阶段顺序（Phase 7.2，2026-09-10）**：`关键词提取 → 网页检索 → 本地宽召回 → 保守闸门 → AI 分窗细读（**只做筛选**）→ **整合提取（extract）** → 卡片矛盾扫描（contradiction）→ 落库`。
> 原「提纯（purify）」与「修正（repair）」两个阶段已被**整合提取**取代（用户裁定 D1）：细读阶段放宽为"只挑可能相关的、宁多勿漏、整段保留"，
> 由整合提取统一完成**裁剪 + 补全 + 整合**，产出志稿素材段落（段首含年份的时间 + 段尾来源编号 + **每段单一来源**）。
> 三道本地硬校验兜住自由度：① `evidence` 必须是来源卡片原文中逐字连续的一段；② 正文里的数字必须都能在来源卡片原文中找到（**整 token** 比较，拦住编造/推算）；③ 时间可信度由本地解析 `timeLabel` 决定（不采信模型自报）。任一不过 → **降级保留原文整段**（不丢材料）并计入 `extractScan.degraded`。
> 提示词另禁两条：**不得跨卡片拼接**（跨来源）与**不得合并互相矛盾的说法**（冲突必须保留为不同段落，否则"自由整合"会把矛盾抹平、矛盾扫描形同虚设）。
> 成文阶段（`assembleDocument`）再做去重与排序：同一来源的近似重复且**数字一致**才去重，**数字不一致则两段都保留**（疑似矛盾）；按 年→月→生成序 稳定排序后分配来源编号 1..N。`compilation:continue` 续跑只重跑未完成的提取批次（`extractDoneBatches`）。

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `compilation:list` | `{ taskId }` → `{ compilations: Compilation[] }` | 任务的全部资料汇编（按时间倒序，含卡片与矛盾） |
| `compilation:get` | `{ compilationId }` → `{ compilation: Compilation }` | 读取一次资料汇编 |
| `compilation:generate` | `{ taskId, title }` → `{ compilation: Compilation, contradictionScan?, extractScan?, interrupted? }` | 生成资料汇编（本地宽召回 + AI 细读筛选 + **整合提取** + 矛盾标注；无 Provider/失败降级本地候选）。大模型异常中断时返回 `interrupted:{stage,message,percent}` 且 `compilation` 为已完成阶段的部分卡片（`drafting`），供前端展示「尝试继续」 |
| `compilation:regenerate` | `{ taskId, title }` → `{ compilation: Compilation }` | 重新生成资料汇编 |
| `compilation:continue` | `{ compilationId }` → `{ compilation: Compilation, contradictionScan?, extractScan?, interrupted? }` | 中断续跑（Phase 6.x，会话内）：从断点继续窗口细读 / **整合提取（只重跑未完成批次）** / 矛盾扫描，复用已完成结果，不重复读取；再次异常仍返回 `interrupted`（可再点「尝试继续」） |

> **整段化切片（Phase A/B）**：切片以**整段**为基本单元——`chunkByParagraphs`（默认上限 `CHUNK_PARAGRAPH_MAX=1000`）按换行切段；超长段仅按句号折成 ≤上限 的子块并共存同一 `paragraphIndex`；**粗细筛以整段为单位做“保留/剔除”**（段内任一子块有信号 → 整段所有子块一起保留，避免“一整段相关却被误筛”）。**资料卡片=整段/整子块**（AI 不再按时间/事实切分，excerpt=该段原文，随后由管线内的**整合提取**阶段裁剪/补全/整合为志稿段落）。
> **整合提取阶段（Phase 7.2）**：`extractScan:{ok, message?, inputCards?, outputParagraphs?, inputChars?, outputChars?, accepted?, degraded?, droppedCards?, omitted?, passthrough?}`——卡片 → 段落与字数变化供生成汇总展示；`accepted` 为通过本地校验的段落数，`degraded` 为校验失败而降级按原文整段保留的卡片数，`droppedCards` 为模型判定与主题无关而整卡丢弃，`omitted/passthrough` 为漏答与按原文保留。`ok=false` 表示超出阶段时间预算（1200s），其余卡片**按原文整段保留**（绝不丢材料）。
> **429 自动续传（Phase A/B）**：窗口细读/矛盾扫描遇到**限流（HTTP 429）**时，主进程自动降本次生成并发数（`reduceConcurrency` 减半、最小 1，**不写回 Provider 设置**，仅本次生效）、退避后从断点自动续跑（`runWithRateLimitAutoResume`，默认上限 `RATE_LIMIT_RESUME_LIMIT=2`）；降并发时经事件 **``compilation:advice`（`{ taskId, kind:'reduce-concurrency' }`）** 推送建议，渲染层翻译为「建议降低当前大模型的并发数」存为对话消息。若仍限流，`interrupted.retryable=true` 供前端自动续传兜底（前端最多 2 次、间隔递增），其余异常 `retryable` 缺省，仅提供手动「尝试继续」。`CompilationInterrupt` 增加 `retryable?: boolean`。
| `compilation:updateItem` | `{ itemId, excerpt?, ts?, note?, extraTags?, kept? }` → `{ item, compilation? }` | 编辑资料段落。**Phase 7.5**：`ts` 变化时主进程在**同一次操作内**按时间重排整份汇编（`reorderCompilationItemsByTs(cid,'asc')`）并额外返回重排后的完整 `compilation`（前端整体替换，避免界面顺序与库中 position 不一致）；同时重算 `year/month/day/time_confidence`（年鉴惯例兜底）并标记 `origin='user-edit'`、`revision+1`。只改正文时不重排 |
| `compilation:deleteItem` | `{ itemId }` → `{ ok: true }` | 删除资料卡片 |
| `compilation:resolveContradiction` | `{ contradictionId, action: 'resolve'\|'ignore', chosenItemId? }` → `{ contradiction: CompilationContradiction }` | 汇编矛盾取舍：resolve 须传保留的卡片 id（属于该矛盾）；ignore 清空已选 |
| `compilation:confirm` | `{ compilationId }` → `{ compilation: Compilation }` | 确认汇编（finalize），进入下一步 |
| `compilation:manualEdit` | `{ compilationId }` → `{ compilation: Compilation }` | **Phase 7.5** 解锁「人工修改」模式（Migration 034 落库）。**不可逆**：没有反向通道，不记版本、不登记撤销栈（否则撤销能把它退回去）。界面状态由 `compilation.manualEdit` 派生 |
| `compilation:reorder` | `{ compilationId, direction: 'asc'|'desc' }` → `{ compilation: Compilation }` | 资料汇编卡片按时间标签重新排序并重写 position（asc 正序 / desc 反序；无时间戳排最后），返回最新汇编 |
| `compilation:undo` / `compilation:redo` | `{ compilationId }` → `{ compilation, undoAvailable, redoAvailable }` | 撤销/恢复资料汇编操作（快照机制：编辑/删除/调整/矛盾取舍/大模型修正回退或应用/回收站恢复/排序/确认等，会话内） |
| `compilation:undoState` | `{ compilationId }` → `{ undoAvailable, redoAvailable }` | 查询当前汇编可撤销/可恢复步数 |
| `compilation:recycleBin:list` | `{ compilationId }` → `{ items: CompilationRecycleBinItem[] }` | 回收站条目（资料卡片 + 矛盾两类，按删除时间倒序 = 最近删除在前） |
| `compilation:recycleBin:restore` | `{ binId }` → `{ contradiction?, item?, card? }` | 恢复条目：矛盾回到 pending；资料卡片还原（含其矛盾变异与大模型修正记录，映射为 card 返回） |
| `compilation:repairs:revert` | `{ repairId }` → `{ item, repair }` | **回退**一条大模型修正（卡片还原为修正前文本，状态 applied→reverted；登记撤销栈） |
| `compilation:repairs:apply` | `{ repairId }` → `{ item, repair }` | **再次应用**一条已回退的修正（卡片回到修正后文本，状态 reverted→applied；登记撤销栈） |
| `compilation:versions` | `{ compilationId }` → `{ versions: CompilationVersionSummary[] }` | **Phase 7.4** 版本列表（`versionNo / origin / instruction? / reply? / changeSummary / createdAt`）。内容变更类操作各记一版；**恢复不记版本**；只保留最近 2 版（`pruneCompilationVersions(id, 2)`） |
| `compilation:version:diff` | `{ compilationId, fromVersionNo, toVersionNo }` → `{ fromVersionNo, toVersionNo, segments, summary }` | **Phase 7.4** 两版差异（段落级 + modified 段的行内字级 diff）。`segments[].kind ∈ added/removed/modified/unchanged`；**被删除的段带 `beforeId`**（= 删除前紧邻的下一段），渲染层据此把「已删除」占位插回原位；差异过大（>400k 单元格）时降级为整块标记 |
| `compilation:version:restore` | `{ compilationId, versionNo }` → `{ compilation, restoredFrom }` | 恢复到某历史版本（写回全部段落列；**不记录新版本**）。**渲染层暂未提供入口**（用户 2026-09-10：先不做该功能） |
| `compilation:doc:edit` | `{ compilationId, instruction, baseVersionNo? }` → `{ compilation, reply, applied, rejected, versionNo?, changedIds, changeSummary }` | **Phase 7.5** 与文档对话：把 id 化的当前文档 + 用户要求交给大模型，模型返回 `{reply, ops}`，本地逐条校验后应用并记一个版本（origin `llm-edit`）。`rejected` 为被拒 op 与原因；`changedIds`/`changeSummary` 供前端高亮与滚动；乐观锁冲突返回 `VERSION_CONFLICT` |
| `compilation:messages` | `{ compilationId }` → `{ messages: {role, content, versionNo?, createdAt}[] }` | **Phase 7.5** 汇编级对话历史（`compilation_messages`，按时间升序） |

> **大模型修正（2026-09-08 改版；2026-09-10 收紧）**：修正由生成管线在「提纯」之后、「卡片矛盾扫描」之前产出并**默认应用**（不再有 `repairScan`/`repairs:list`/`repairs:decide` 三个旧通道），卡片上以「经过大模型修正」标记承载；渲染层点标记弹窗查看修正前原文与理由并选择回退/再次应用。修正阶段异常 → `interrupted`（429 置 `retryable`），`compilation:continue` 续跑只重跑未完成批次；超出阶段预算 → 结果带 `repairScan:{ok:false,message}` 提示「修正未完成」。**时间戳规则（2026-09-10）**：需要补齐的情形为「时间为『无』**或时间缺少年份**（如 `5 月 19 日`、`7—9 日`）」，提示词要求时间标注**必须含年份**、依据上下文与来源年鉴年份推断、**不得编造**；本地以 `hasYear`（4 位年份）取舍——模型给的 ts 不含年份一律不采纳，卡片已有含年份的 ts 一律不覆盖，缺年份的旧值允许被覆盖（`tsFills` 仍属静默补齐，不落 `compilation_repairs`、无标记、不可回退）。残缺判定补充「句子起点/终点不完整、缺少主谓宾、指代不明」，并要求**优先补全而非删除**。
> **对话编辑协议（Phase 7.5，2026-09-10；用户裁定 D3/D5）**：**软件 → 大模型** = 系统提示（`[p12] 2018 年 | 来源3 | 段落正文` 形式的 id 化文档 + 可引用来源编号清单 + 规则）+ 用户要求；**大模型 → 软件** = 单个 JSON `{"reply":"给用户看的回答","ops":[…]}`（容忍代码块围栏与前后夹带文字）。op 类型：`delete{ids}` / `replace{id,text,timeLabel?}` / `insertAfter{afterId,text,timeLabel,sourceOrdinal}` / `move{ids,afterId}` / `merge{ids}`（**仅同一来源**）/ `split{id,at,text}` / `setTime{id,timeLabel}` / `replaceAll{paragraphs}`（逃生舱）。
> **本地校验**（逐条失败即该 op 拒绝并记入 `rejected`，其余照常应用）：① 段号（`pN`）必须存在；② `sourceOrdinal` 必须落在 `1..N`；③ 新增/改写正文中的**数字必须能在该来源原文中找到**（沿用 `numbersCoveredBy` 整 token 口径，防幻觉）；④ `merge` 仅限同一来源；⑤ **不得删空整篇**；⑥ 不支持的 op 直接拒绝。解析失败 → **文档不变**并明确报错（用户消息仍留痕）。
> **数字校验的豁免（2026-09-10 用户裁定）**：用户**明确要求**把某个数字改成指定值时，**大模型和软件都照做即可**。协议上由 op 携带 `"allowNewNumbers":true`（`replace` / `insertAfter` / `replaceAll.paragraphs[]` 均支持），本地校验见到该字段**直接跳过数字校验**；解析层只认字面 `true`（其它值不算）。提示词要求"**只有用户点名具体数值时才能加这个字段**，其它任何情况一律不加，绝不可用它给推测/估算/补齐数据开口子"。
> **撤销栈一致性**：落库前必须 `pushUndo(compilationId)`（`doc-edit-runner` 已补）——否则「撤销操作」会跳过这次对话改动、直接回退到上一个快照（2026-09-10 用户实测的 bug）。
> **应用**：应用 ops → **单次** `upsertCompilationParagraphs`（保留段 id；来源 id 由 ordinal 预解析后一次传入，避免"只传一段会删掉其余段"）→ 生成新版本（origin `llm-edit`，含 `instruction`/`reply`/`baseVersionNo`）→ 写两条 `compilation_messages`（用户 + 助手，助手带 `versionNo`/`applied`/`rejected`）。**并发保护**：请求带 `baseVersionNo`，与最新版本号不一致则拒绝（`VERSION_CONFLICT`）并提示重试。
> **手动编辑解锁（D5）**：确认汇编（`finalized`）之前查看器**不提供任何直接编辑入口**（工具栏标注「仅可对话修改」）；确认后才出现「开始人工修改」按钮，点击弹**不可逆二次确认**，确认后进入人工修改模式（悬停显示编辑/删除，每次改动同样生成新版本 origin `user-edit`）。**2026-09-10 验收后补充裁定**：该模式**落库持久化且不可逆**（`compilations.manual_edit`，Migration 034）——进入一次即永久生效，切换任务与重启软件都保持，不提供回到锁定态的入口。改时间标签会**同一次操作内自动按时间重排**并返回完整 `compilation`（前端滚动定位到该段新位置 + 2 秒高亮）。



### 2.3.2 规范文档库（styleGuide，Phase 6.4.1）

第二步「指定行文规范」的多篇规范文档持久化 + 全局唯一默认注入指定。初始默认 = 合并后的「志书文体文风与行文规则」。

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `styleGuide:list` | `{}` → `{ items: StyleGuide[] }` | 全部规范（默认排前） |
| `styleGuide:save` | `{ id?, name, content }` → `{ styleGuide: StyleGuide }` | 新建（无 id；首个自动设为默认）或覆盖（有 id） |
| `styleGuide:setDefault` | `{ id }` → `{ styleGuide: StyleGuide }` | 设为默认注入（全局唯一） |
| `styleGuide:delete` | `{ id }` → `{ ok: true }` | 删除；若删的是默认则回退到剩余第一篇 |

> `StyleGuide = { id, name, content, isDefault, createdAt, updatedAt }`。生成初稿时读取 `getDefaultStyleGuide()?.content`（无则回退 `DEFAULT_STYLE_GUIDE`）注入 prompt。

### 2.4 撰写与初稿（writing / draft）

| 通道 | 请求 → 响应 data | 说明 |
|---|---|---|
| `writing:createTask` | `{ title?, scope?, llmProviderId? }` → `{ task: WritingTask }` | 点击"新建任务"立即创建：title 缺省"新建任务"、scope 缺省 `{ all: true }`（全部长期资料） |
| `writing:listTasks` | `{}` → `{ items: WritingTask[] }` | |
| `writing:deleteTask` | `{ id }` → `{ ok: true }` | 删除任务（级联清理 drafts/segments/messages/矛盾，并清理任务绑定的网页缓存文章） |
| `writing:renameTask` | `{ taskId, title }` → `{ task: WritingTask }` | 右键重命名任务标题（仅中栏显示；与文章标题无关） |
| `writing:updateProvider` | `{ taskId, llmProviderId: string \| null }` → `{ task: WritingTask }` | 更新任务固定大模型（null=回退全局当前 Provider；校验存在） |
| `writing:getModelText` | `{ taskId }` → `{ text: string }` | 读取任务级范本正文（Phase 6.4.2） |
| `writing:setModelText` | `{ taskId, text }` → `{ text: string }` | 保存任务级范本正文（Phase 6.4.2；生成初稿时注入【参考范本】） |
| `writing:chat` | `{ taskId, message, history? }` → `{ reply: string }` | 自由对话（任务大模型 + 注入当前初稿 ≤12000 字；超时 5 分钟；消息由主进程持久化） |
| `taskMessages:list` | `{ taskId }` → `{ items: TaskMessage[] }` | 任务对话历史（role: user/assistant；kind: chat/instruction/notice） |
| `taskMessages:add` | `{ taskId, role, kind, content }` → `{ message: TaskMessage }` | 追加任务消息（一般由主进程自动写入） |
| `writing:retrieve` | `{ taskId }` → `{ chunks: RetrievedChunk[] }` | 任务范围内 RAG 检索预览 |
| `writing:generateDraft` | `{ taskId, instruction, compilationId }` → `{ draft: Draft, articleTitle: string \| null, contradictions: Contradiction[] }` | 生成第 0 稿（幂等：已有初稿直接返回既有稿与矛盾清单）。**三步式（强制）**：`compilationId` 必填且须为已确认（`finalized`）的资料汇编，仅以该汇编 kept 卡片为材料，跳过检索/扫描；缺失/未确认返回 `COMPILATION_NOT_FINALIZED`。阶段进度经事件 `draft:generateProgress` 推送 |
| `draft:get` | `{ draftId }` → `{ draft: Draft }` | 读取某稿（含片段与来源） |
| `draft:getLatest` | `{ taskId }` → `{ draft: Draft }` | 读取任务最新一稿（仅初稿） |
| `draft:updateContent` | `{ draftId, markdown }` → `{ draft: Draft }` | 整稿保存（按标题行重建片段） |
| `draft:regenerate` | `{ taskId, instruction, compilationId }` → 同 generateDraft | 删除现有第 0 稿后重新生成（覆盖旧稿）；`compilationId` 语义同 generateDraft（必填、须已确认） |
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
| `workspace:sourceRemoval:list` | `{}` → `{ items: WorkspaceSourceRemovalPending[] }` | 列出待确认的来源移除（来源=工作区文件被删除或资料库直接删除，且已被资料汇编引用） |
| `workspace:sourceRemoval:decide` | `{ sourceId, action: 'delete'|'keep' }` → `{ deletedItems, deletedContradictions, deletedRepairs }` | 处理来源移除确认：`delete` 删除该来源在全部资料汇编中的卡片（含矛盾/二次改动，不入回收站）再删来源；`keep` 仅删来源、保留卡片（source_id 置空） |
| `workspace:sourceRemoved`（主进程推送事件） | `WorkspaceSourceRemovalPending` | 推送新增的来源移除待确认项（渲染层弹确认框） |
| `app:openFileDialog` | `{}` → `{ paths: string[] }` | 系统文件选择对话框（主进程打开，仅回传路径） |
| `app:openDirectoryDialog` | `{}` → `{ path: string \| null }` | 系统目录选择对话框（工作区选择） |
| `app:getInfo` | `{}` → `{ version, platform }` | 应用版本与平台 |
| `app:getPdfCmapsUrl` | `{}` → `{ url: string }` | pdf.js cMaps 资源基址（渲染层预览中文/CID 字体 PDF 需要；主进程启动时注入 `setPdfCmapsDir`） |
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
- **撰写**：`TASK_NOT_FOUND`、`DRAFT_NOT_FOUND`、`TASK_NO_SCOPE`、`TASK_NO_PROVIDER`、`COMPILATION_NOT_FINALIZED`
- **通用**：`INVALID_PARAM`、`INTERNAL_ERROR`

## 4. 生成初稿的契约（Phase 3.5：指令驱动 + JSON 输出）

- 请求：`writing:generateDraft { taskId, instruction, compilationId }`（`instruction` 为用户要求；`compilationId` **必填**且须为已确认 `finalized` 的资料汇编，材料仅取该汇编 kept 卡片，不再实时检索/扫描）。
- 提交物：**三段式（Phase 6.3）**——已确认资料汇编的 `kept` 卡片文本（矛盾取舍中被排除的卡片 `kept=0` 不纳入，按时间排序去重）+ 当前默认行文规范（`getDefaultStyleGuide()?.content` 或回退 `DEFAULT_STYLE_GUIDE`）+ 可选任务级参考范本（`task.modelText`，非空时注入【参考范本】）。仅在未提供 `compilationId` 的旧链路下，材料为「资料库检索到的全部有效材料 + 用户要求」。
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
