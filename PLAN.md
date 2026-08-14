# Project Plan

本计划基于 `AGENTS.md` 制定。项目尚未初始化，文中的"影响模块"是职责范围，具体文件路径将在脚手架建立后补充。本项目为**单人开发**，`Team Responsibilities` 中的模块划分是代码组织边界，不涉及多人协作。

设计文档已产出（见 `docs/`）：数据模型与 Schema（`data-model.md`）、共享契约与 IPC 清单（`shared-contracts.md`）、UI 信息架构与页面清单（`ui-architecture.md`）。Task 1.1–1.3 分别以对应文档为落地依据。

## Team Responsibilities（模块职责范围）

| 模块 | 主要职责 | 主要交付 |
|---|---|---|
| 桌面框架与界面 | 桌面应用框架、资料管理界面、撰写编辑器、交互状态 | 应用骨架、资料/撰写各功能页面、片段级审核 UI |
| 资料解析与信源 | 文件导入解析、OCR、信源抓取、内容清洗、标签体系 | 结构化资料、来源快照、标签体系、范本体例解析 |
| 数据与 AI 服务 | 本地数据库、RAG 检索、LLM Provider、初稿生成、来源标注 | SQLite、向量/全文索引、生成与审校服务 |

> 全部任务由开发者本人负责。各模块共同维护共享类型和接口；修改共享类型或接口协议时，须同步更新所有调用方与相关文档。

## Phase 1: Project Foundation

**Overall Goal:** 建立可运行的 Electron 项目脚手架、共享类型/接口契约与本地数据库，作为后续各 Phase 的公共基础。

### Task 1.1 - Application Scaffold

- **Task Detail:** 初始化 Electron、React 和 TypeScript 工程，建立主进程、preload、renderer 三层结构与基础窗口；配置开发与构建脚本（electron-vite + Vite）；按 `docs/ui-architecture.md` 搭建三栏导航壳（顶栏 + 左栏一级导航 + 页面路由）与各页面空态占位。
- **Affected Areas:** Electron 框架、前端入口、开发和构建配置。
- **Verification:** 应用可以启动并显示基础窗口；界面层不能直接访问完整的 Node.js/文件系统能力，本地能力仅经安全接口暴露。

### Task 1.2 - Shared Contracts

- **Task Detail:** 按 `docs/shared-contracts.md` 落地核心数据类型（Source 资料、Tag 标签、TemplateBook 范本、WritingTask 撰写任务、Draft 志稿、Segment 片段、SegmentSource 来源标注、ReviewRecord 审核记录等）、界面层调用本地服务的基本接口（IPC 通道清单）与错误返回格式，以及生成初稿的结构化输出契约。
- **Affected Areas:** 共享类型、接口约定、错误返回格式。
- **Verification:** 各模块基于同一组类型开发，模块之间不直接引用彼此的内部实现。

### Task 1.3 - Local Database Foundation

- **Task Detail:** 按 `docs/data-model.md` 建立 SQLite 数据库与迁移机制（驱动在 better-sqlite3 / sql.js 中确定），持久化资料、标签、范本、撰写任务、志稿、片段、片段来源、审核记录与本地设置，并提供统一的数据访问接口。
- **Affected Areas:** 数据库连接、迁移、数据仓储、查询接口。
- **Verification:** 重启应用后数据仍然存在；迁移可重复执行；核心实体（资料/标签/志稿）可正确写入与读取。

### Phase 1 Integration

- 骨架、类型契约与数据库连通。
- **Verification:** 应用启动即完成数据库初始化；界面层可按约定接口读写基础实体；为 Phase 2/3/4 的开发提供稳定基础。

## Phase 2: Material Collection

**Overall Goal:** 完成"导入文件 / 添加信源 → 解析 → 打标 → 本地入库 → 可检索"的资料收集闭环。

### Task 2.1 - File Import & Parsing

- **Task Detail:** 支持常见资料格式导入（PDF、Word(.docx)、TXT、Markdown，以及图片 OCR），提取文字、表格、图片；记录文件来源与元数据；生成适合检索和 AI 输入的结构化文本。
- **Affected Areas:** 导入服务、文档解析器、OCR、本地文件存储。
- **Verification:** 使用各类格式样本测试后，文字/表格/图片可正确提取入库；不支持的格式给出可读错误且不中断其余导入；重启后资料完整保留。

### Task 2.2 - Source URL Fetching

- **Task Detail:** 用户输入信源网址后，抓取网页正文并保存原文快照（URL、抓取时间、正文、清洗后文本），作为可溯源的资料；提供失败时的稳定错误码与可读提示。
- **Affected Areas:** 信源抓取、正文清洗、来源快照存储。
- **Verification:** 给定真实网址可抓取正文入库并保留来源与快照；抓取失败返回稳定错误码而非通用失败；抓取范围严格限于用户提供的网址。

### Task 2.3 - Tag System

- **Task Detail:** 用户可对资料打自定义标签（如"小学教育""新区经济建设"）；支持标签增删改查、一份资料多个标签、按标签筛选资料。**Phase 2.1 增强：** 标签为独立关联（`source_tags` 表），不写入资料标题；事务安全操作，删除标签级联解除全部资料关联。
- **Affected Areas:** 标签数据模型、资料-标签关联、检索接口、标签管理界面。
- **Verification:** 标签 CRUD 正常；一份资料可带多个标签；按标签可筛出全部相关资料；重启后标签与关联状态保持。

### Phase 2.1 - 资料删除与标签系统重构（补充开发计划）

> 本补充计划在 Phase 2 资料收集闭环（Task 2.1–2.4）基础上，补齐资料删除与标签管理的完整交互。标签系统**推荐整体重构**（参照 `HaiDiXiaoZongDui` 项目方案），标签与资料为独立关联（`source_tags` 表），重构标签管理界面与相关接口。

#### Task 2.1.1 - 资料删除（右键菜单 + 批量管理）

- **Task Detail:** 支持删除资料库中的资料，提供两种删除方式：
  1. **右键菜单删除**：右键点击"全部资料"列表中的任一资料，弹出右键菜单，其中包含"删除该资料"选项；点击后二次确认并删除该资料。
  2. **批量管理删除**：在"资料库"页面中栏"全部资料"标题右侧新增一个功能按钮，点击后弹出功能菜单（当前菜单仅"资料管理"一个选项）；点击"资料管理"后进入批量选择模式，可通过点击勾选/取消勾选下方资料，并提供"全选/取消全选"按钮；勾选完成后批量删除所选资料。
- **Affected Areas:** 资料列表 UI、右键菜单、批量选择模式、`sources:delete` IPC 通道、资料仓储（含级联清理标签关联）。
- **Verification:** 右键菜单可删除单个资料且带确认提示；批量模式下可勾选/取消勾选、全选/取消全选并批量删除；删除后资料从列表与检索结果中消失，其标签关联同步清理；批量删除不会误删未选中资料。

#### Task 2.1.2 - 标签系统重构（标签管理界面与接口）

- **Task Detail:** 整体重构标签管理系统（界面与相关接口），保留中栏"标签管理"按钮：点击后右栏显示"标签管理"界面，默认提供四个功能模块：
  1. **新建标签**：用户在文本框中输入新标签名称，输入过程中系统实时搜索当前已有标签中文本匹配度最高的前 5 个，以"已有的相似标签："为标题展开显示在文本框下方（无匹配时该项不显示）；用户输入完毕后点击"创建"即可创建新标签。
  2. **添加标签（批量打标）**：系统在下方显示当前全部标签与资料列表（资料默认按**最近添加优先**排序）；用户选择一个已有标签后，通过勾选确定要为哪些资料添加该标签，提供"全选/取消全选"按钮；确认后为所选资料批量添加标签。
  3. **删除标签**：系统在下方显示当前全部标签；用户选择一个标签后，经过二次确认删除该标签；删除后所有带该标签的资料自动解除关联。
  4. **按标签检索**：系统在下方显示当前全部标签；用户通过点击选择/取消选择标签（支持多选），系统自动检索同时具有所选全部标签的资料，以列表形式呈现（默认按**最近添加优先**排序）。
- **Affected Areas:** 标签数据模型、资料-标签关联、标签管理界面（新建 / 添加 / 删除 / 检索四个功能模块）、相似标签搜索（文本匹配 Top5）、`tags:*` IPC 接口。
- **Verification:** 四个功能模块均可正常使用；新建标签时相似标签建议（前 5 个）正确展示；批量打标/取消打标正确；删除标签有二次确认且级联解除全部资料关联；多选标签检索返回同时具备所选标签的资料并按最近添加排序；重启后所有状态与关联保持。

### Task 2.4 - Template Book (范本) Upload & Parsing

- **Task Detail:** 用户上传历年成品志书作为范本，工具解析其篇目层级结构与行文体例，形成"范本模板"供后续撰写任务参照。
- **Affected Areas:** 范本解析、体例模型、范本管理界面。
- **Verification:** 范本能解析出篇目层级与体例特征；生成的范本模板可作为撰写任务的体例参照。

### Phase 2 Integration

- 文件导入 / 信源抓取 → 打标 → 入库 → 按标签与关键词检索 全链路打通。
- **Verification:** 用户可导入文件与网址、打标签、按标签浏览全部资料；每条资料可溯源到具体文件或网址。

## Phase 2.2: 工作区资料库（全面重构）

> 重构 Phase 2 资料收集机制（需求于 2026-08-06 决策）：部分用户习惯将本地文件夹作为工作区、资料也存于该文件夹，期望**指定文件夹即资料库**——软件**实时双向同步**该文件夹（含多级子目录）：文件夹内增删改 → 软件实时感知并自动更新理解（解析 / 向量化 / 摘要索引）；软件内调整（删除 / 改标题）→ 自动同步回本地文件。本次为**全面替换**：不再"导入文件"转存副本，`importFiles` 的 copy 逻辑退役（存量资料经迁移工具一次性迁入工作区）。
>
> 关键设计决策：
> - **指纹映射**：`content_hash`（sha256）+ `file_mtime/size` 作为"文件系统 ↔ 数据库"映射锚点，文件移动 / 重命名不丢 id / 标签 / 摘要。
> - **实时监听**：chokidar（Windows 原生 fs.watch 递归不可靠）+ 防抖聚合 + mtime 兜底对账（防监听漏事件，保证最终一致）。
> - **反向同步语义**：软件内删除资料 → `shell.trashItem` 移入系统回收站（可反悔）；改标题 → 重命名工作区原文件。
> - **元数据仅存应用数据库**：标签 / 摘要 / 范本不写文件系统，工作区文件夹保持纯净。
> - **防环路**：应用自身触发的文件系统操作打 `byApp` 标记跳过，避免"改名 → 事件 → 再改名"风暴。
> - **URL 资料**（kind='url'）无本地文件，维持 DB 快照存储，不受工作区机制影响。

### Task 2.2.1 - 工作区基础设施（配置 + 扫描 + 指纹对账）

- **Task Detail:** 建立工作区模式的数据模型与核心扫描能力：
  1. **Migration 006**：`sources` 新增 `content_hash`（sha256 内容指纹）、`file_mtime`、`file_size`、`workspace`（1=工作区文件 / 0=传统导入存量）四列；`settings` 增加 `workspace_dir` 键（用户指定工作区根目录）。
  2. **文件注册**：`importFile` 由"复制副本"改为"注册工作区文件"——解析后直接引用原路径（`file_path` 存工作区相对路径），不再转存到 `userData/imports`；同时计算并写入指纹。
  3. **递归扫描器**（新模块 `src/main/workspace/scanner.ts`）：递归遍历工作区（含多级子目录），仅识别支持格式（复用 `file-parser`），对每个文件计算指纹并与数据库比对，产出三类差异：**新增**（未在库）/**变更**（hash 不同）/**消失**（库中有但文件系统已无）。
  4. **对账服务**（`src/main/workspace/reconcile.ts`）：启动时与手动"刷新"触发全量对账；新增 → 解析入库；变更 → 更新 `cleaned_text` 与指纹；消失 → 暂标记（不立刻删库，交 Task 2.2.3 处理）。
  5. **设置与 UI**：`settings:get/update` 支持 `workspaceDir`；设置页新增工作区路径选择（目录对话框）；资料库页展示当前工作区路径与同步状态。
- **Affected Areas:** Migration 006、`src/main/db/sources.ts`（指纹字段读写）、`src/main/import/index.ts`（注册而非转存）、新模块 `src/main/workspace/{scanner,reconcile}.ts`、`settings` IPC、设置页与资料库 UI、`docs/data-model.md`。
- **Verification:** 指定工作区后启动即完成全量扫描，多级子目录文件均入库；指纹可识别"移动 / 重命名（内容不变）"与"内容变更"；新增文件不转存、引用原路径；解析失败文件状态明确；重启后指纹与同步状态保持。
- **Status: 已完成（2026-08-06）**

### Task 2.2.2 - 实时监听与增量处理

- **Task Detail:** 工作区文件变更的实时感知与自动更新：
  1. **引入 chokidar**（npm 依赖，electron-vite 外部化），递归监听工作区根目录的 `add / change / unlink / addDir / unlinkDir` 事件。
  2. **防抖聚合**：事件 500ms 防抖合并为批量变更，按文件级 diff 驱动增量处理：新增 / 变更 → 解析 + 指纹更新 + 自动触发 `indexSource`（复用向量化流水线，增量幂等）并失效旧 LLM 摘要；删除 → 按 Task 2.2.3 语义处理。
  3. **防环路**：应用自身触发的文件操作（如改名）先打 `byApp` 标记，监听侧跳过对应事件，避免自触发风暴。
  4. **兜底对账**：每 5 分钟一次轻量 mtime 全量对账（仅比对 mtime/size，不重算 hash），覆盖监听漏事件场景（网络盘 / 杀软干扰）。
  5. **状态展示**：资料列表显示同步中 / 已同步 / 失败状态；索引失败可重试。
- **Affected Areas:** `package.json`（新增 chokidar）、新模块 `src/main/workspace/watcher.ts`、增量处理编排、资料库 UI 状态展示。
- **Verification:** 在工作区文件夹中新增 / 修改 / 删除文件（含子目录），软件在数秒内自动感知并更新资料库与向量索引；重复修改不产生重复索引；应用自身改名不引发事件风暴；监听失效时兜底对账仍能收敛。
- **Status: 已完成（2026-08-06）**

### Task 2.2.3 - 反向同步与存量迁移

- **Task Detail:** 软件侧调整同步回文件系统 + 存量资料一次性迁移：
  1. **删除同步**：软件内删除资料（单删 / 批量）→ 先 `shell.trashItem` 将工作区原文件移入系统回收站，再删 DB 行（级联标签 / 向量 / 摘要）；文件已在回收站或已不存在时直接删库。
  2. **改名同步**：`sources:updateTitle` 对工作区资料同步重命名原文件（保留扩展名），并更新 `file_path` / 指纹；重名冲突自动加后缀；`.md / .txt` 与 `.pdf / .docx` 均仅重命名文件本身。
  3. **存量迁移工具**：一次性迁移向导——将现有 `userData/imports` 下的资料副本移动至用户指定工作区（保持文件名），计算 `content_hash`、更新 `file_path` 为工作区相对路径、`workspace=1`；迁移后校验 DB 与文件一一对应，旧副本清理。
  4. **兼容兜底**：迁移完成前传统导入路径与工作区并存；迁移完成后 `importFiles` 转存逻辑整体退役。
- **Affected Areas:** `src/main/index.ts`（`sources:delete*` / `sources:updateTitle` 增加落盘动作）、`src/main/import/index.ts`（退役 copy 逻辑）、迁移工具模块、资料库 UI（删除 / 改名交互不变，行为同步到文件系统）。
- **Verification:** 软件内删除资料后本地文件进入系统回收站、库内记录与索引消失；软件内改名后工作区文件被重命名且可被监听重新识别（不丢标签 / 摘要）；存量资料迁移后入库完整、文件与 DB 一一对应、重启后仍一致；迁移完成后不再产生 `userData/imports` 新副本。
- **Status: 已完成（2026-08-06）**

### Task 2.2.4 - 工作区删除实时同步到资料库（删文件即删库）

> 需求于 2026-08-07 提出：① 工作区实时自动同步（无需手动点"同步工作区"）；② 工作区内手动删除的文件，资料库**直接删除**（连同标签等所有绑定信息，不管原有标签）；③ 工作区内新增文件自动入库，视为无任何标签的"白板"文件。

- **Task Detail:**
  1. **删除语义修正**：原 `reconcile.ts` 设计为"消失：仅统计，不删库"（删除语义交软件侧回收站处理），导致工作区删文件后资料库记录仍在。改为：全量对账 `reconcileWorkspace` 与增量对账 `reconcilePaths` 对"文件系统消失且库中有记录"的资料**直接 `deleteSources`**（外键级联清除标签绑定 / 向量 / 摘要）。
  2. **重命名保护**：删除前检查该内容哈希是否仍被其它路径记录占用（`content_hash` 相同且非本记录）→ 视为 rename/move，改走 moved 分支不删库，保留 id/标签。`reconcilePaths` 重构为两阶段：先处理仍存在的文件（新增 / 变更 / 移动识别），再处理已消失的文件（含重命名保护）。
  3. **实时自动同步**：watcher 已启动（启动时 `startWorkspaceWatcher`、改工作区时 `restartWorkspaceWatcher`），新增 / 修改 / 删除均 500ms 防抖增量对账 + 5 分钟心跳兜底全量对账——无需手动点"同步工作区"。
  4. **新增白板文件**：`insertSource` 本就不绑定任何标签（新增文件 = 白板），符合要求③。
- **Affected Areas:** `src/main/workspace/reconcile.ts`（`reconcileWorkspace` / `reconcilePaths` 删除逻辑 + 两阶段 + 重命名保护）、`src/main/workspace/watcher.ts`（测试更新为"删库"断言）、单测（新增删除级联 / 增量删除 / 增量 rename 不误删 / moved 不误删）。
- **Verification:** 工作区删文件 → 资料库记录 + 标签绑定 + 向量 + 摘要数秒内自动消失；工作区新增 / 修改文件仍自动入库更新；工作区 rename / move 文件不误删、保留 id/标签；typecheck / 单测（84 项）/ 构建通过。
- **Status: 已完成（2026-08-07）**

### Task 2.2.4 补充修复 - 删除仍不同步 + 加回文件卡死（用户实测反馈）

> 实测于 2026-08-07：① 删工作区文件后条目仍在、需手动点"同步工作区"才消失；② 把文件重新加回工作区后软件明显卡顿/卡死，重启后才正常。

- **Task Detail:**
  1. **事件被对账任务吞掉（问题①根因）**：`watcher.ts` 的 `runTask` 在 `reconciling` 时直接 return，`flushPendingPaths` 未执行、路径滞留 `pendingPaths`，若后续无新事件则永不处理——启动对账/心跳全量对账（含大文件解析+索引可达数十秒）期间发生的 unlink/add 事件被静默丢弃，删除/新增迟迟不同步（全量对账删除逻辑本身正常，故点"同步工作区"才生效）。修复：`runTask` 在 reconciling 时置 `rerunQueued`，当前任务结束后**补跑同一个任务**（事件不丢）。
  2. **大文件索引阻塞主进程（问题②根因）**：`reconcilePaths → ingestFile → await indexSource` 把整个文件的全部 chunk **一次性**喂给 WASM 嵌入推理（大 PDF 数百个 chunk），推理同步计算长时间占满主进程事件循环 → UI 卡死（重启后是后台 `void reconcileWorkspace` + 模型已加载，故不卡）。修复：`indexer.ts` 分批嵌入（每批 20 个 chunk，批间 `setImmediate` 让出事件循环）。
  3. **心跳兜底缩短**：5 分钟 → 1 分钟，即使 chokidar 在 Windows 上漏掉 unlink 事件，删除/新增也在一分钟内自动收敛。
- **Affected Areas:** `src/main/workspace/watcher.ts`（`runTask` 排队补跑、心跳 1 分钟）、`src/main/rag/indexer.ts`（分批嵌入 + 让出事件循环）、单测（新增 runTask 排队补跑 1 项）。
- **Verification:** typecheck / 单测（85 项，新增 1 项）/ 构建通过。用户重测：删除文件数秒内自动消失；加回大文件不再卡死。
- **Status: 已完成（2026-08-07）**

### Task 2.2.5 - 自动同步触发源（聚焦 / 进资料库 / 每分钟）+ 新文件预处理提示

> 需求于 2026-08-07 提出：实时监听仍不可靠。改为确定性触发——① 窗口重新聚焦时自动同步；② 每次回到"资料库"功能区时自动同步；③ 每分钟自动同步；④ 识别到有文件添加时，即刻显示预处理进度并提示"由于后台进程正在处理新添加的文件，可能存在卡顿"。（①②③④ 的同步效果均等同手动点击"同步工作区"按钮。）

- **Task Detail:**
  1. 新模块 `src/main/workspace/auto-sync.ts`（自动同步调度器）：`requestWorkspaceSync`（全量对账 + busy/queued 互斥排队，效果等同手动按钮）、`startAutoSyncTimer`（每分钟一次，需求③，取代 watcher 心跳）、`isWorkspaceSyncBusy`。
  2. **窗口聚焦**（需求①）：`index.ts` createWindow 里 `win.on('focus', ...)` → `requestWorkspaceSync`；启动全量对账也改走调度器（与聚焦共用互斥，避免并发）。
  3. **进入资料库**（需求②）：新 IPC `workspace:navSync` + preload `workspaceNavSync`；`App.tsx` 在 `page === 'sources'` 时调用。
  4. **新文件预处理提示**（需求④）：`ReconcileProgress` 增加 `newFiles`（本轮已发现并开始处理的新文件数），`reconcileWorkspace`/`reconcilePaths` 的进度回调携带；watcher 增量对账接入进度推送（`startWorkspaceWatcher(progress)`）；`SourceList` 收到 `newFiles>0` 且未完成时显示黄色提示条"正在预处理新添加的文件…可能存在短暂卡顿" + 同步进度条。
  5. watcher 心跳移除（由 auto-sync 每分钟定时承担），watcher 专注实时增量。
- **Affected Areas:** 新模块 `auto-sync.ts`、`src/main/workspace/reconcile.ts`（`ReconcileProgress.newFiles`）、`watcher.ts`（去心跳 + 进度回调）、`src/main/index.ts`（聚焦/定时/导航/启动调度、`workspace:navSync` handler）、`src/shared/ipc.ts`、preload、`App.tsx`（导航触发）、`SourceList.tsx`（预处理提示条）、`zh-CN.ts`、`main.css`、`docs/shared-contracts.md`。
- **Verification:** 切到别的窗口再回来 → 自动同步；进入资料库页 → 自动同步；每分钟自动同步（兜底）；工作区新增文件 → 界面即刻显示"正在预处理新添加的文件…可能存在短暂卡顿"提示 + 进度条；typecheck / 单测（87 项，新增 auto-sync 2 项）/ 构建通过。
- **Status: 已完成（2026-08-07）**

### Phase 2.2 Integration

- 工作区双向同步闭环端到端。
- **Verification:** 指定文件夹即资料库：文件夹内增删改实时反映到资料库与向量索引；软件内删除 / 改名实时反映到本地文件；存量资料迁移一次性完成；检索与撰写链路对工作区资料照常工作。

## Phase 3: Writing

**Overall Goal:** 完成"输入标题 + 选择文件范围 → 从本地资料检索 → 大模型生成带来源标注的初稿"。

### Task 3.1 - LLM Provider & Configuration

- **Task Detail:** 用户可配置 OpenAI-compatible 模型服务（API 地址、密钥、模型名），支持连通性测试；密钥与设置仅存本地。
- **Affected Areas:** Provider 接口、设置持久化（本地）、配置界面。
- **Verification:** 可新增、编辑、测试 Provider；密钥不在界面或日志中明文展示；设置重启后保持。

### Task 3.2 - Local Retrieval (RAG)

- **Task Detail:** 基于本地资料构建全文/向量索引（先落地 SQLite FTS5，向量检索方案在此阶段确定），输入撰写标题后可检索最相关资料片段，且每个片段可追溯到来源。
- **Affected Areas:** 索引构建、检索服务、来源映射。
- **Verification:** 给定标题能返回相关片段及其来源；检索范围严格限定在用户导入的资料与信源内，不引入外部信息。

### Task 3.3 - Draft Generation with Source Annotation

- **Task Detail:** 根据用户输入的标题与选定的文件范围（手动勾选或按标签），AI 生成志书初稿（第 0 稿）；初稿按片段组织，每个片段都能显示原文来源（哪个信源/哪篇文章）。
- **Affected Areas:** 提示词工程、生成服务、片段与来源标注模型、撰写界面。
- **Verification:** 生成的初稿可按片段展开阅读；每个片段可查看其来源与原文位置；生成失败或空结果有明确提示。

### Phase 3 Integration

- 撰写闭环端到端。
- **Verification:** 从"输入标题 + 勾选文件/标签"到"生成带来源标注的初稿"完整可用；初稿片段均可溯源，供用户审核。

## Phase 3.1: 撰写闭环增强（补充开发计划）

> 在 Phase 3 撰写闭环基础上补充：撰写任务删除、初稿文档编辑器。

### Task 3.1.1 - 撰写任务删除（右键菜单 + 二次确认）

- **Task Detail:** 支持删除撰写任务：右键点击撰写页中栏任务列表中的任一任务，弹出右键菜单（含"删除该任务"）；点击后二次确认，确认后删除该任务及其全部志稿/片段/来源标注（外键级联）。删除后列表即时刷新；若删除的是当前打开的任务，右栏清空。
- **Affected Areas:** 撰写任务列表 UI、右键菜单、`writing:deleteTask` IPC 通道、任务仓储（级联清理）。
- **Verification:** 右键可删除单个任务且带确认提示；删除后任务从列表消失，其 drafts/segments/segment_sources 一并清除；删除当前任务后右栏回到空态；取消确认不删除。
- **Status: 已完成（2026-08-05）**

### Task 3.1.2 - 初稿文档编辑器（TipTap）

- **Task Detail:** 生成初稿后，撰写页右栏切换为文档编辑器界面，初始载入生成的初稿；支持主流 Markdown 文字格式（**粗体、斜体、标题、下划线、表格、有序/无序列表**）的所见即所得编辑与实时渲染。
  - **选型：TipTap**（基于 ProseMirror 的 WYSIWYG 编辑器，React 官方封装；官方扩展：`underline` / `table` / 列表 / 标题）。
  - **片段内容存储格式由纯文本改为 Markdown 文本**：AI 生成时输出 Markdown 片段；编辑器加载 Markdown、编辑后序列化回 Markdown 保存（`segment:update`，同时记录 `review_records` 留痕）。
  - **溯源保留**：每个片段仍可展开查看来源（标题 + 位置 + 原文摘句），编辑不破坏来源标注。
- **Affected Areas:** 文档编辑器组件（TipTap + 工具栏 + 每片段实例）、`segment:update` 实现、提示词工程（Markdown 输出）、撰写工作台 UI。
- **Verification:** 生成初稿后右栏显示编辑器并载入初稿；粗体/斜体/标题/下划线/表格/列表可编辑并实时渲染；编辑内容保存为 Markdown 后重启仍在；片段来源标注保持可用。

## Phase 3.2: 资料预处理与混合检索（补充开发计划）

> 在 Phase 3 本地词法 RAG（Task 3.2/3.3 已实现）基础上，实现"资料更新后自动预处理 + 任务下达时本地粗筛"的完整索引链路：**本地向量嵌入（BGE-small-zh-v1.5，@huggingface/transformers + onnxruntime-web WASM 后端，纯本地无网络）** + **词法/向量混合检索（RRF 融合）** + **可选的 LLM 摘要索引（"整理资料库"手动触发，可开关）**。检索结果结构与现有 `RetrievedChunk` 契约保持一致，下游初稿生成逻辑无感。
>
> **推理后端说明（落地现状 2026-08-06）**：本机 Windows System32 存在系统组件 `onnxruntime.dll`（ORT 1.17.1），加载优先级高于应用目录，导致 onnxruntime-node 原生绑定无法完成 DLL 初始化。故通过 `vendor/onnxruntime-node-stub`（`file:` 依赖，转发到 `onnxruntime-web`）统一走 **onnxruntime-web WASM 后端**；`rag/embed.ts` 已固化 WASM 加载配置（`useWasmCache=false` + 直接配置 `ort.env.wasm` 本地文件路径）。

### Task 3.2.1 - 向量索引基础设施（预处理管道）

- **Task Detail:** 资料导入/更新成功后自动触发**增量索引**：复用 `chunkText` 分块 → 本地 embedding 模型（BGE-small-zh-v1.5，ONNX 格式，CPU 推理）将每个分块向量化 → 存入向量表。仅处理新增/变更的资料（`sources.indexed_at` 标记），支持后台渐进索引与"索引中"状态。
- **Affected Areas:** Migration 005（`chunk_embeddings` 表 + `sources.indexed_at` 列 + `source_summaries` 表）、`src/main/rag/embed.ts`（ONNX 推理封装）、`src/main/rag/indexer.ts`（索引流水线）、`importFiles`/`addUrl` 成功后的触发点、模型文件分发。
- **Verification:** 导入资料后自动生成向量索引且可查询到；重复导入不产生重复索引（增量幂等）；向量维度与模型输出一致；无网络依赖。
- **Status: 已完成（2026-08-06）**

### Task 3.2.2 - 混合检索（词法 + 向量 RRF 融合）

- **Task Detail:** 检索阶段双路召回：词法路（现有 bigram/子串打分 + FTS5）+ 向量路（查询向量余弦相似度），经 **RRF（Reciprocal Rank Fusion）** 融合取 TopK；保留每来源 Top3 / 全局 Top12 的多样性约束与来源标注；`writing:retrieve` 与初稿生成的检索调用保持接口兼容。
- **Affected Areas:** `src/main/rag/retrieval.ts`（增加向量召回路径与 RRF 融合）、向量存储与余弦检索封装。
- **Verification:** 语义相关但无字面重叠的查询能召回（如"教育事业发展"→"适龄儿童入学率"）；与纯词法相比召回质量提升；检索范围仍严格限定在用户资料内。
- **Status: 已完成（2026-08-06）**

### Task 3.2.3 - LLM 摘要索引（整理资料库）

- **Task Detail:** 提供"整理资料库"功能（用户手动触发，可开关）：对资料库内未整理的资料调用 LLM 生成摘要、主题关键词、关键实体，存入 `source_summaries`；检索时可用摘要相关性辅助粗筛与排序；整理进度与状态在资料库 UI 展示。
- **Affected Areas:** `src/main/rag/summarizer.ts`（LLM 摘要生成 + JSON 解析）、`source_summaries` 仓储、设置项（开关）、资料库 UI（整理按钮 + 进度/状态）。
- **Verification:** 整理后可查看每篇资料的摘要/关键词；检索能借助摘要提升召回；可关闭该功能；LLM 调用失败有稳定错误提示且不阻塞其他功能。
- **Status: 已完成（2026-08-06）**

## Phase 3.3: 范本成例参考（补充开发计划）

> 完善范本功能（需求于 2026-08-07 决策）：撰写任务开始前，用户导入"往年志书成例"作为参考范本；在撰写任务界面可选择任意范本，生成初稿时范本作为**上下文的一部分**发送给大模型（参考体例与行文，而非史料）。现有基础（Task 2.4）：范本导入解析篇目结构、删除、创建任务时可选一个范本、生成时仅注入篇目层级。本次补齐：范本**体例特征预处理**、撰写工作台内**选择/更换范本**、生成初稿时注入**完整范本上下文**、删除范本**二次确认**。
>
> 关键设计决策：
> - **不再提取篇目结构 + 大模型提取"三个正常小节"行文范例（2026-08-07 三次升级）**：撰写任务只针对志书中**一个小节**的正文，故**删除篇目层级结构提取**（outline 存储/展示/提示词注入全部移除，`detectHeading` 仅保留为小节切分工具）。范本是"体例与行文参考"而非"史料来源"，**不做 RAG 向量化**（避免成例史实被当作史料引用、违反"严禁编造"底线）。导入时先本地提取基础统计（全文字数/段落数/层级/标题样式，毫秒级、无依赖），随后**将范本（若干完整"正常小节"正文节选，每节 ≤5000 字、总量 ≤30000 字，受模型上下文限制必须截断）与提示词一起发送给大模型**，提取**三个正常小节**的行文范例（每节含 `structureSummary` 行文逻辑总结 + `styleGuidelines` 每段每句的风格标准 + `example` 原文文段示例[直接摘录不改写]），并**总体总结**（`summary`）三个小节共有的行文逻辑与风格标准，存入 `style_profile_json`（`exampleSections`），供撰写任务生成初稿时注入提示词。本地先用多策略标题识别切出小节，并**排除概要、大事记、人物传记、附录、索引、凡例、后记等特殊/功能性模块**。未配置 LLM Provider / 调用失败 / 输出不合规时**自动降级为本地结果**，不阻塞导入；"重新提取"（`templates:reanalyze`）可对已有范本按新模式重新分析。
> - **上下文边界声明**：提示词中范本区块明确标注"以下为参考范本，仅作体例与行文风格参考，其内容不得作为史料引用"，与任务范围内检索到的 materials 严格区分。
> - **生成后锁定**：撰写工作台内仅在**未生成初稿**时可选择/更换范本；已生成初稿后锁定当前范本不可改（避免"换范本 → 重生成覆盖已编辑初稿"的意外数据损失）。创建任务时仍可选择范本（已有）。
> - **删除安全**：`writing_tasks.template_book_id` 为 `ON DELETE SET NULL`，删除范本后引用任务自动失去关联，数据安全；删除前二次确认并提示引用影响。

### Task 3.3.1 - 范本体例特征预处理（本地统计 + 大模型行文范例增强）

- **Task Detail:** 导入范本时提取体例特征，填充预留的 `style_profile_json` 列（方案 2026-08-07 多次升级：本地统计兜底 + LLM 提取三个小节行文范例；**不再提取篇目结构**）：
  1. **本地统计**（纯本地、毫秒级）：全文字数、段落数、平均段长、标题最大层级、各级标题数量；标题命名样式识别（如"第X篇/章/节"前缀、阿拉伯数字序号）。`detectHeading` 多策略标题识别保留为"正常小节"切分工具。
  2. **大模型提取"三个正常小节"行文范例**（`src/main/import/template-style.ts`）：本地用多策略标题识别切分小节，**排除概要/大事记/人物传记/附录/索引等特殊模块**，将范本（若干完整正常小节正文节选，每节 ≤5000 字、总量 ≤30000 字）与提示词一起发送给大模型，要求提取三个主题各不相同的正常小节的行文范例（每个含**结构总结 + 行文风格标准 + 原文文段示例**）并**总体总结**（`exampleSections.summary`）；调用超时放宽至 120s，未配置 Provider / 调用失败 / 输出不合规时自动降级为本地结果，不阻塞导入。
  3. **降级兼容**：存量范本 `style_profile_json` 为 NULL 或旧结构时，生成初稿兼容旧字段并可按"重新提取"更新。
- **Affected Areas:** `src/main/import/template-parser.ts`（`extractStyleProfile` 本地统计 + StyleProfile 类型扩展 + 删除篇目结构提取）、`src/main/import/template-style.ts`（LLM 提取三个小节 + 总体总结）、`src/main/db/templates.ts`（`insertTemplate`/`updateTemplateStyle` 去 outline）、`TEMPLATES_IMPORT`/`TEMPLATES_REANALYZE` handler（llm 阶段进度 + etaSeconds）、`generate.ts`（注入 exampleSections，去大纲）、范本管理 UI（行文范例展示，去篇目结构）、`docs/data-model.md`（style_profile_json 结构说明）。
- **Verification:** 导入范本后 `style_profile_json` 正确写入：本地统计始终存在，LLM 增强时含 `exampleSections`（summary + 最多 3 个小节，每个含标题/结构总结/风格标准/原文示例）且 `llm=true`；特殊模块（概要/附录等）被排除、仅正常小节参与分析；未配置 Provider 时自动降级、导入正常完成；进度显示 llm 阶段提示"正在等待大模型回应……预计 X 秒"；生成初稿时提示词含三个小节范例与总体总结且不再含篇目层级；"重新提取"可更新已有范本。
- **Status: 已完成（2026-08-07）**

### Task 3.3.2 - 撰写工作台范本选择与更换（生成前可换，生成后锁定）

- **Task Detail:** 撰写任务界面（`WritingWorkspace`）新增"参考范本"选择器：
  1. **选择/更换**：工具栏下拉列出全部范本（含"不使用范本"项），实时更新任务关联；未生成初稿时可任意选择/更换，创建任务时已选的范本在此默认展示。
  2. **生成后锁定**：任务已存在初稿（第 0 稿）时选择器禁用并显示当前范本，提示"初稿已生成，范本已锁定"。
  3. **持久化**：新增 `writing:updateTemplate` IPC（`{ taskId, templateBookId: string | null }`），`db/tasks.ts` 新增 `updateTaskTemplate` 更新 `template_book_id`（校验范本存在或为 null），preload 暴露类型化接口。
- **Affected Areas:** `src/main/db/tasks.ts`、`src/main/index.ts`（新 IPC handler）、`src/shared/ipc.ts` + `src/preload/*`（新通道）、`src/renderer/src/components/WritingWorkspace.tsx`（选择器 + 锁定态）、`src/renderer/src/i18n/zh-CN.ts`（文案）、`docs/shared-contracts.md`。
- **Verification:** 未生成初稿时可在工作台选择/更换范本且重启后保持；已生成初稿后选择器禁用且无法绕过；删除的范本不再出现在列表中（引用任务自动置空）；`writing:updateTemplate` 校验非法范本 id。
- **Status: 已完成（2026-08-07）**

### Task 3.3.3 - 生成初稿注入范本上下文 + 范本删除二次确认

- **Task Detail:**
  1. **提示词注入**：`generate.ts` 将原"仅注入篇目层级"扩展为完整范本上下文——篇目层级 + 体例特征（`style_profile_json` 统计）+ 代表性范例片段，三块合并为一个"参考范本"区块，并明确标注"仅作体例与行文风格参考，其内容不得作为史料引用"；与任务范围内的检索 materials 严格区分；范本缺失/解析失败时降级为"（未提供范本）"。
  2. **删除二次确认**：范本管理界面删除范本改用项目内 `ConfirmDialog` 二次确认，提示"删除后引用该范本的撰写任务将自动失去范本关联（不影响已生成初稿）"。
  3. **文档同步**：更新 `docs/ui-architecture.md`（范本界面）、`AGENTS.md` 近期记录。
- **Affected Areas:** `src/main/writing/generate.ts`（提示词构建）、`src/renderer/src/components/TemplateManager.tsx`（ConfirmDialog）、`src/renderer/src/components/ConfirmDialog.tsx`（复用）、`docs/*`、`AGENTS.md`。
- **Verification:** 生成初稿时范本三要素（结构/体例/范例）正确注入提示词且标注仅作体例参考；成例内容不被当作史料（提示词边界验证）；删除范本有二次确认，取消不删除、确认后任务自动失去关联；typecheck / 单测 / 构建通过。
- **Status: 已完成（2026-08-07）**

## Phase 3.4: 初稿连续显示与生成链路升级（补充开发计划）

> 需求于 2026-08-07 提出：① 初稿不再按"片段 + 逐段来源卡片"拆开显示，而是**连续地显示为一个整体文档**（后续再做"框选某段 → 右键询问来源"）；② 初稿生成**基于对资料库资料的理解/粗筛**（接入 `source_summaries` 摘要索引做资料级粗筛）并**参照范本提取物**（已实现，保留）。用户视效果调整。

### Task 3.4.1 - 初稿连续显示为整体（单编辑器 + 整稿保存）

- **Task Detail:** 将初稿编辑器从"逐片段独立编辑框 + 来源折叠卡片"重构为**单个连续 TipTap 编辑器**：
  1. 渲染：把 draft.segments 按序拼接（heading 转 Markdown 标题行 + content）为一份连续 Markdown，一个编辑器实例渲染；去掉每段独立边框、保存状态、来源折叠卡片。
  2. 保存：新增 `draft:updateContent { draftId, markdown }` IPC；主进程用 `splitMarkdownIntoSegments`（按 `#` 标题行切分回片段）重建 segments（`replaceDraftSegments`：删旧插新，新片段无来源关联——来源展示已不再需要，后续"框选查来源"基于任务范围资料重新检索实现）。
  3. 兼容：`segment:update` IPC 保留不删（不再被编辑器使用）；数据模型 drafts/segments 表结构不变；编辑防抖自动保存（800ms）沿用。
- **Affected Areas:** `src/shared/ipc.ts`（`draft:updateContent` 通道）、`src/main/db/drafts.ts`（`splitMarkdownIntoSegments`/`replaceDraftSegments`）、`src/main/index.ts`（handler）、preload、`src/renderer/src/components/DraftEditor.tsx`（重写为单编辑器）、`zh-CN.ts`、`main.css`、`docs/shared-contracts.md`。
- **Verification:** 初稿连续显示为一个整体文档、无逐段来源卡片；编辑任意位置内容，防抖自动保存后重新打开仍完整且结构（标题/段落/表格）不变；整稿保存后 segments 按标题正确重建；typecheck / 单测 / 构建通过。
- **Status: 已完成（2026-08-07）**

### Task 3.4.2 - 生成初稿接入资料摘要粗筛（理解资料后再检索）

- **Task Detail:** 将 `generateDraft` 的检索从"直接在任务范围资料内检索 chunk"升级为"**摘要级粗筛 + chunk 级精检**"：
  1. 粗筛：读取任务范围内各资料的 `source_summaries`（摘要/主题词/关键实体，LLM 摘要索引，需用户先执行"整理资料库"），用任务标题与摘要文本做词法相关性打分（复用 `scoreChunk`），**只保留相关资料**再进入 chunk 精检；**无摘要的资料保守保留**（不排除，避免误伤未整理资料）。
  2. 精检：在粗筛后的资料子集内执行现有"词法 + 向量 RRF 混合检索"。
  3. 检索预览（`writing:retrieve`）与生成共用同一函数，同步受益。
  4. 范本参照保持现状（exampleSections 三要素注入提示词）。
- **Affected Areas:** `src/main/rag/summarizer.ts`（批量读摘要）、`src/main/writing/generate.ts`（粗筛接入 `retrieveChunksHybrid`）、检索预览、单测、`docs/data-model.md`。
- **Verification:** 任务范围内资料较多时，生成/预览检索只召回与任务标题相关的资料（有摘要时）；无摘要资料仍可被召回（不排除）；检索质量不劣于纯 chunk 检索；typecheck / 单测 / 构建通过。
- **Status: 已完成（2026-08-07）**

### Task 3.4.3 - 初稿输出形态改为"整篇连贯正文"（去除 JSON 片段契约与篇幅要求）

> 需求于 2026-08-07 提出：① 志书每个小节就是**一篇连贯的文章**，不应强求大模型以"若干带小标题的 JSON 片段"输出；② "在提示词中加篇幅要求"不可行——篇幅由资料中实际有多少有效、有关联的内容自然决定。

- **Task Detail:** 重构 `generate.ts` 的生成契约与落库：
  1. **System prompt**：删除 `{"segments":[...]}` JSON 输出契约与"每个片段标注 sourceId/position"要求；改为"撰写一个完整小节的正文，必须是一篇连贯成文的文章；直接输出 Markdown 正文，不得输出 JSON、说明性文字或代码块包裹；可根据内容需要自行使用小标题组织内部层次；**篇幅由材料中实际可用的有效内容自然决定，不注水、不重复、不硬凑篇幅，也不刻意省略重要内容**"。
  2. **User prompt**：删除"按片段组织并标注 sourceId 与 position"指令；改为"参照参考范本的行文逻辑与风格（若提供），依据材料撰写这一小节的连贯志书正文；篇幅以材料实际有效内容为准"。
  3. **落库**：去掉 `parseJson`/`normalizeSegments` 与 JSON 校验重试循环；模型输出（剥去代码块围栏）整篇存为**单个片段**（无 heading），由 Task 3.4.1 的连续编辑器整稿渲染/保存；空输出报 `LLM_FORMAT_INVALID`。
  4. **材料供给**：单块材料注入上限 300 → 800 字（检索块本身 ≤500 字，保证有效内容完整供给、不因截断变短）。
- **Affected Areas:** `src/main/writing/generate.ts`（提示词、落库、删除 JSON 解析与重试、单测同步更新为"连贯正文 + 篇幅内容自决"断言）。
- **Verification:** 模型输出不再要求 JSON；初稿整篇连续显示，内部可含小标题但整体是一篇文章；篇幅随材料有效内容多寡而增减；typecheck / 单测 / 构建通过。
- **Status: 已完成（2026-08-07）**

### Task 3.4.4 - 修复"初稿只有寥寥几行字"：检索材料被标题行挤占

> 诊断（2026-08-07，实查本地库 + 重现提示词）：任务"教育"初稿仅 75 字。重现提交给大模型的 user prompt 后发现——**检索到的 12 块"材料"全部是 2~4 个字的标题行**（"教育""学前教育""义务教育"），没有一段实质正文。根因：词法检索 `scoreChunk` 中查询词命中得 `+100+长度` 高分，而短标题行（2~4 字）的 bigram 重叠率满分，得分（162~202）高于正文段落（110~152），`poolTop` 每资料 Top3 + 全局 Top12 的配额全被标题行占据。大模型拿到的材料全是标题、无史实可用，只能输出泛泛套话；范本上下文（1436 字结构/风格指导）虽已注入，但无米下锅写不出来。

- **Task Detail:** 修复 `src/main/rag/retrieval.ts`：
  1. 新增导出 `isTitleLikeLine(text)`：判定"标题行"——≤12 字的短语，或 ≤20 字且含空格分隔的标题词组（如"开放教育 成人教育 特殊教育"）；以句末标点结尾的短句或含数字的行不算标题行（保留正文数据段）。
  2. `chunkText` 分块时跳过标题行（词法路 + 将来重新索引的向量路都受益）。
  3. `retrieveChunks` RRF 融合时对向量路命中的历史残留标题块再兜底剔除（现有 `chunk_embeddings` 无需重索引即生效）。
- **Affected Areas:** `src/main/rag/retrieval.ts`（`isTitleLikeLine`、`chunkText`、融合过滤）、单测（新增标题行过滤 2 项）。
- **Verification:** 用真实资料重现：候选块从 998 降到 610，Top12 从"全是标题"变为正文段落（含"【学校安全管理】2022年……3个100%目标……"等带年份、数据的实质内容）；typecheck / 单测 / 构建通过。
- **Status: 已完成（2026-08-07）**

### Task 3.4.5 - 撰写工作台新增"重新生成初稿"

- **Task Detail:** 用户修正检索/提示词后需要覆盖旧初稿重跑（此前 `generateDraft` 幂等 + 生成按钮在初稿已存在时禁用，无法重跑）：
  1. 仓储 `deleteDraftByVersion(taskId, version)`：删除指定版本初稿（segments/segment_sources 外键级联清理）；不存在返回 false。
  2. 服务 `regenerateDraft(taskId)`：删第 0 稿 → 复用 `generateDraft` 重新生成。
  3. 新 IPC `draft:regenerate`（`{ taskId }` → `{ draft }`）+ preload `regenerateDraft`。
  4. 工作台 UI：初稿已存在时工具栏"生成初稿"切换为"重新生成初稿"（danger 样式），点击弹出 `ConfirmDialog` 二次确认（提示将丢弃当前第 0 稿含用户修改），确认后带 generating 状态重跑并刷新整稿；范本仍锁定不可更换。
- **Affected Areas:** `src/shared/ipc.ts`（`DRAFT_REGENERATE` 通道 + 类型）、`src/main/db/drafts.ts`（`deleteDraftByVersion`）、`src/main/writing/generate.ts`（`regenerateDraft`）、`src/main/index.ts`（handler）、preload、`WritingWorkspace.tsx`（按钮 + ConfirmDialog）、`zh-CN.ts`、`docs/shared-contracts.md`。
- **Verification:** 初稿已存在时出现"重新生成初稿"按钮；确认后旧稿被覆盖、编辑器刷新为新初稿；typecheck / 单测（新增 deleteDraftByVersion 级联 1 项）/ 构建通过。
- **Status: 已完成（2026-08-07）**

### Task 3.4.6 - 范本提取前剔除目录页，确保发送给大模型的均为正文小节节选

> 需求于 2026-08-07 提出：范本提取的三个示例小节"原文文段示例"全是"暂缺"——发送给大模型的节选以目录页为主（"目 录""概 述 (1) ………""第一节 机构队伍(104)"等目录条目被误当成正常小节标题），节名与正文对不上。要求：**节选前剔除目录页**，发送给大模型的参照提示词中均为**正文小节节选**；人物传、大事记等特殊模块不算正文。

- **Task Detail:** 修复 `src/main/import/template-style.ts`：
  1. 新增 `isTocLikeLine(line)` 目录页行判定——页码标记（"-- 3 of 877 --" / "3/877" / "第 3 页"）、"目 录"标题行、标题+括号页码（"第一节 机构队伍(104)"，可后跟任意省略号/点线）、标题+点线+页码（"政 区 (28) ……………… 29"）；以句末标点结尾、括号页码后接中文语流的正文行不误伤。
  2. `extractNormalSections` 逐行先剔目录页行，再 `detectHeading` 切分——目录条目不再产生"假小节"。
  3. `buildLlmInput` 降级路径（无正常小节时全文节选）同样过滤目录行。
  4. `SPECIAL_MODULE_RE` 补充"人物传"（"人物传记"的常见标题变体，此前 `人物传记` 正则匹配不到"人物传"）。
  5. system prompt 明确"以下均为已剔除目录页、并排除概要/大事记/人物传记/人物传/人物志/附录/索引等特殊模块后的正文小节节选"，并要求 example 必须摘录自所提供正文。
- **Affected Areas:** `src/main/import/template-style.ts`（`isTocLikeLine`、`extractNormalSections`、`buildLlmInput`、`SPECIAL_MODULE_RE`、system prompt）、单测（新增目录行判定 / 目录条目剔除 / 降级路径过滤 3 项）。
- **Verification:** typecheck / 单测（80 项，新增 3 项）/ 构建通过。存量范本需在范本管理页点"重新提取"后生效（`templates:reanalyze` 复用新逻辑）。
- **Status: 已完成（2026-08-07）**

### Task 3.4.7 - 取消材料供给限制，检索改为"过滤确定无关段落"

> 需求于 2026-08-07 提出：初稿内容仍不够。重构资料库本地初筛——**① 完全取消第三层限制**（limit=12 / 每源 Top3 / 800 字截断），只保留前两层；**② 第二层逻辑改为"确定哪些段落完全与标题无关、把这些非常确定无关的段落去掉"**（不再做 Top-N 选最相关）；**③ 第一层（摘要粗筛）不动**。用户接受后期再调上下文长度。

- **Task Detail:**
  1. `src/main/rag/retrieval.ts`：`retrieveChunks` 重构为**过滤式**——词法相关（`scoreChunk > 0`，即与标题有任何字面/字符对关联）或 向量相关（余弦 ≥ `vecMinScore`，默认 0.3）的段落**全部保留**，标题行一律剔除；按来源、原文顺序组织（向量补充块追加在后）。删除 `MAX_PER_SOURCE`、`MIN_SCORE`、`poolTop`、RRF 融合与 `limit` 参数（`RetrieveParams` 增加 `vecMinScore`）。
  2. `src/main/rag/vector-store.ts`：`vectorSearch` 支持 `limit=0` 返回全部（供过滤式检索全量余弦）。
  3. `src/main/writing/generate.ts`：`retrieveChunksHybrid` 去掉 limit；`buildUserPrompt` 去掉 800 字截断——过滤后保留的全部段落完整提交，篇幅由材料实际有效内容决定。
- **Affected Areas:** `src/main/rag/retrieval.ts`、`src/main/rag/vector-store.ts`、`src/main/writing/generate.ts`、单测（改为过滤式语义：全量保留 / 无关剔除 / 向量补充 / 向量阈值过滤）。
- **Verification:** 真实"教育"任务重现：材料供给从 **12 块 ≈ 6000 字** 提升到 **610 块 ≈ 6.3 万字**（第一层粗筛仍保留全部 7 份资料）；typecheck / 单测（82 项）/ 构建通过。**已知风险**：材料量可能超出模型上下文 / 请求超时（60s），按用户约定后期再调整。
- **Status: 已完成（2026-08-07）**

### Task 3.4.8 - 初稿生成放宽 LLM 超时（材料体量大时耗时数分钟）

> 需求于 2026-08-07 提出：3.4.7 后初稿生成出现超时。用户确认"体量较大时生成本身就可能花费数分钟"——问题不在生成慢，而在超时限制过短。

- **Task Detail:** `chatCompletion` 默认超时 60s，`generateDraft` 之前未传自定义超时，3.4.7 后材料 6.3 万字、模型生成完整小节正文需数分钟 → 60s 必被 AbortController 掐断（报 `LLM_TIMEOUT`）：
  1. `src/main/writing/generate.ts` 新增 `DRAFT_GENERATE_TIMEOUT_MS = 600000`（10 分钟），`generateDraft` 调用 `chatCompletion` 时传入。
  2. 前端文案：`generating`/`regenerating` 由"可能需要数十秒"改为"资料较多时可能需要数分钟，请耐心等待"。
- **Affected Areas:** `src/main/writing/generate.ts`、`src/renderer/src/i18n/zh-CN.ts`。
- **Verification:** typecheck / 单测通过。若 10 分钟内仍未完成仍报 `LLM_TIMEOUT`（极小概率），届时再评估流式输出或分块提交。
- **Status: 已完成（2026-08-07）**

### Task 3.4.9 - 生成初稿前自动整理任务范围资料摘要

> 需求于 2026-08-07 提出：用户开始撰写任务时，软件应自动检查所选资料是否都已整理（有无 LLM 摘要），缺则自动补齐；并确认"已通过'整理资料库'生成过摘要的资料不会重复整理"。用户选择：触发时机 = 生成初稿时；"整理资料库"按钮保留（全库入口，与任务自动整理互补）。

- **Task Detail:**
  1. `src/main/rag/summarizer.ts` 新增 `pendingSummarySourceIds(sourceIds)`（返回指定范围内**尚无摘要**的资料 id，幂等：已有摘要的不算待整理）+ `summarizePendingForSourceIds(sourceIds)`（逐篇调用 LLM 补齐摘要，返回 processed/ok/failed）。
  2. `src/main/writing/generate.ts` 的 `generateDraft`：在摘要级粗筛（`retrieveChunksHybrid`）之前 `await summarizePendingForSourceIds(scopeIds)`——只整理任务范围内缺摘要的资料，已整理的跳过；**整理失败不阻断生成**（`.catch` 静默，无摘要时粗筛保守保留，不影响正确性）。
  3. 前端文案：`generating`/`regenerating` 更新为"正在整理资料摘要并生成初稿…"。
- **Affected Areas:** `src/main/rag/summarizer.ts`、`src/main/writing/generate.ts`、`src/renderer/src/i18n/zh-CN.ts`、单测（新增 pendingSummarySourceIds 幂等 1 项）。
- **Verification:** 生成初稿时，任务范围内缺摘要的资料自动补齐（此前手动"整理资料库"生成的摘要不被重复处理）；无 Provider/整理失败时生成不受阻断；typecheck / 单测（88 项）/ 构建通过。
- **Status: 已完成（2026-08-07）**

## Phase 3.5: 撰写工作台交互重构——聊天式界面（补充开发计划）

> 需求于 2026-08-08 提出：右栏撰写界面与用户交互逻辑重构为网页版大模型常见的"聊天对话框"形式。用户已确认关键决策：① 点击"新建任务"立即创建（标题默认"新建任务"、范围=全部文件）；② 中栏标题仅靠"新建任务"+右键重命名确定，**撰写任务的文章标题由大模型从用户要求中抓取并作为必需项返回**（缺标题等必要信息必须返回详细报错）；③ 初稿生成前输入框按钮=「生成初稿」，生成后=「发送」（自由对话）；④ 大模型选择持久化到任务；⑤ 文件范围固定为工作区全部文件。
>
> 本次范围：实现到"生成初稿"阶段（含基础自由对话，不写回正文；"修改初稿"等高级对话能力留待下阶段）。

### Task 3.5.1 - 数据模型：任务字段扩展（Migration 007）

- `writing_tasks` 新增列：`llm_provider_id TEXT`（任务固定大模型）、`article_title TEXT`（大模型抓取的文章标题）、`user_instruction TEXT`（生成初稿时用户的最新要求，重新生成复用）。
- `WritingScope` 增加 `{ all: true }` 分支（固定全部文件）；旧任务具体 scope 兼容保留。
- **Status: 已完成（2026-08-08）**

### Task 3.5.2 - 任务仓储与 IPC 通道

- `tasks.ts`：`createTask` 支持默认参数（title 默认"新建任务"、scope 默认 `{all:true}`、可选 templateBookId/llmProviderId）；新增 `renameTask` / `updateTaskProvider` / `updateTaskArticleTitle` / `updateTaskInstruction`；`resolveScopeSourceIds` 支持 `{all:true}`（返回全部资料 id）。
- `ipc.ts`/preload/main handler：新增 `writing:renameTask`、`writing:updateProvider`、`writing:chat`；`writing:createTask` 请求放宽为可选字段；`writing:generateDraft`/`draft:regenerate` 请求增加 `instruction`（必填）。
- **Status: 已完成（2026-08-08）**

### Task 3.5.3 - 生成初稿改造（指令驱动 + JSON 输出含标题/错误）

- `generate.ts`：`generateDraft(taskId, instruction)` / `regenerateDraft(taskId, instruction)`——保存 `user_instruction`；检索查询词改用 instruction；user prompt 按用户要求设计（"你是一名资深志书撰稿专家……现在用户需要生成一篇初稿，以下是用户的要求（应该包含标题和可能的其他要求）：…"）；**输出契约改为 JSON** `{"title":…,"content":…,"error":…}`——缺必要信息时大模型返回 `error` 详情，软件解析出 error 直接报错给用户；有 title 则更新 `article_title`，content 落库为初稿。
- 新增 `writing:chat` 通道：对话用任务 provider，注入当前初稿（限制长度）作为"修改初稿"类请求上下文，返回回复文本。
- **Status: 已完成（2026-08-08）**

### Task 3.5.4 - 前端：空状态右栏 + 任务列表重命名

- 无任务时右栏显示空状态（插图 + "当前还没有撰写任务，点击新建任务以开始" + 「新建任务」按钮），点击立即创建并进入工作台。
- `WritingTaskList` 右键菜单新增「重命名」（自定义输入对话框，避免原生 prompt 失焦问题）。
- 删除 `WritingCreateForm`（原表单交互废弃）。
- **Status: 已完成（2026-08-08）**

### Task 3.5.5 - 前端：统一工作台（正文编辑器 + 大模型对话框）

- `WritingWorkspace` 重构为统一布局：上方正文编辑器（占大部分；无初稿时占位引导）、下方 `ChatPanel` 对话框。
- `ChatPanel`：消息列表 + 输入框 + 底部工具条（参考范本下拉、大模型下拉、发送/生成初稿按钮切换）。生成初稿前按钮=「生成初稿」，成功后=「发送」。
- 生成初稿：把输入内容作为 instruction 提交；返回成功显示文章标题与初稿（刷新编辑器），失败在对话区显示大模型返回的详细报错。
- 范本生成后锁定（沿用现逻辑）；大模型选择持久化到任务（可随时更换）。
- **Status: 已完成（2026-08-08）**

### Task 3.5.6 - 对话历史持久化 + 对话超时修复（用户实测反馈三连修）

- 对话历史持久化：Migration 008 新增 `task_messages`（chat/instruction/notice）+ `llm_call_logs`（LLM 调用痕迹元数据，不存密钥/正文）；`chatCompletion` 增 `meta` 参数统一写痕迹；生成/对话/重生成消息由主进程写入，前端 `taskMessages:list` 回填与刷新。
- 对话超时修复：`chatWithTask` 超时从默认 60s 放宽到 5 分钟（对话携带初稿全文+历史时 Deepseek 等模型响应较慢）。
- "学前教育"任务生成耗时排查结论：材料供给（3 个巨型 PDF 全量相关段落）导致大模型处理耗时约 5 分 44 秒。**用户决策（2026-08-08）：仅加阶段进度提示，不改材料供给**——生成初稿阶段推送 `draft:generateProgress` 事件（整理资料摘要 → 检索资料 → 等待大模型回应[预计 1~5 分钟]），对话框实时显示当前阶段。
- **Status: 已完成（2026-08-08）**

## Phase 3.6: 预设大模型 + 获取 API Key 指引（补充开发计划）

> 需求于 2026-08-08 提出（在"免费模型"方案讨论后收敛）：内置主流大模型预设配置（模型名 / API 地址 / 显示名称），用户选好预设后点「获取 API key」弹出**悬浮窗教程**（注册→获取 key 的逐步指引，各模型教程不同），随后自行填 key 调用。项目初期只内置：DeepSeek v4 Pro / Flash + 智谱 GLM-4-Flash。
>
> **调研确认（2026-08-08）**：DeepSeek V4 OpenAI 格式 Base URL 为 `https://api.deepseek.com`，模型名 `deepseek-v4-pro` / `deepseek-v4-flash`（flash 已正式公测，低价按量计费）；智谱 GLM-4-Flash Base URL `https://open.bigmodel.cn/api/paas/v4`，模型名 `glm-4-flash`（**永久免费**）。现有 Provider 架构完全 OpenAI 兼容，无需改生成/对话链路。

### Task 3.6.1 - 预设模型清单（共享数据层）

- 新建 `src/shared/llm-presets.ts`：`LLM_PRESETS` 数组，每项 `{ id, vendor, name, model, apiBase, pricing, signupUrl, guide }`（guide 为各模型的"注册→获取 API key"教程步骤，文案逐模型单独编写）；内置 DeepSeek v4 Flash / DeepSeek v4 Pro / 智谱 GLM-4-Flash 三条；前后端共用（纯数据）。
- **Status: 已完成（2026-08-09）**

### Task 3.6.2 - 打开注册页（IPC）

- 新增 `app:openExternal` 通道（`{ url }`），主进程 `shell.openExternal`；preload / index.d.ts / main handler 同步。
- **Status: 已完成（2026-08-09）**：`IPC.APP_OPEN_EXTERNAL` 契约 + `openExternal` preload 方法 + `index.d.ts` 声明 + main handler（http/https 白名单校验）。

### Task 3.6.3 - 前端：设置页"预设模型"区块 + 教程悬浮窗

- Settings 页 Provider 区上方新增"预设模型"区：每条预设卡片显示名称、模型名、API 地址、免费/付费标签；「使用此模型」一键打开新建表单并预填 name/apiBase/model；「获取 API key」弹出悬浮窗。
- 新组件 `PresetGuideDialog`（模态悬浮窗）：预设名 + 分步教程（1. 注册 2. 创建 API Key 3. 复制） + 「打开注册页」按钮（跳 signupUrl）+ 关闭。
- i18n 文案；CSS。
- **Status: 已完成（2026-08-09）**：`PresetGuideDialog.tsx` 新组件；Settings 页新增预设区块（「使用此模型」预填新建表单、「获取 API key」弹窗）；zh-CN.ts 预设/教程文案；main.css 预设区与悬浮窗样式。

### Task 3.6.4 - 测试与验证

- 单测：LLM_PRESETS 结构校验（id 唯一、必填齐全、apiBase 无尾部斜杠、教程步骤非空）；typecheck / 构建；用户实测 DeepSeek / 智谱 key 填入后走现有"测试连接"与生成链路。
- **Status: 已完成（2026-08-09）**：`llm-presets.ts` 内联单测 3 项（结构校验 + 三条预设模型名 + 未知 id），`npm test` 104 项全通过；`npm run typecheck` 与 `npm run build` 通过。用户实测（填入 key 走测试连接/生成链路）留待用户操作。

## Phase 3.7: 初稿矛盾检测与来源溯源（补充开发计划）

> 需求于 2026-08-10 提出：资料库中多份资料对同一史实的叙述可能出现矛盾（同一事件事实相左、同一数据相左等），且**只在生成初稿阶段会出现**——矛盾检测应归属生成链路（Phase 3），而非后续版本审核环节。核心诉求：
> ① 大模型生成初稿时发现矛盾点 → 返回矛盾清单 → **显示在正文中**交人工审核取舍；同一事实可能被 3 个及以上文件阐述相左，矛盾按"事实主题"聚合分组（非逐对罗列）。
> ② 矛盾检测采用**生成前独立扫描 + 生成后定位审查**两次专门调用（用户已确认"两者结合"方案）；**生成正文时严禁将矛盾说法自然合并/折中**——应分开并列表述，或只采用其中一种表述（其余保留在矛盾清单待人工取舍），并在正文相应位置插入矛盾标注。
> ③ 正文编辑器升级为"**内嵌矛盾标注 + 点击弹出对比框**"（TipTap 自定义内联节点），对比框并列展示各说法及各自来源文件链接。
> ④ 正文**文段来源询问**：框选文段 → 右键"询问文段来源" → 自动在下方对话面板发起询问；矛盾内容**默认自动显示**各说法的来源文件；来源文件以**链接**呈现，点击用本机默认软件打开。
> ⑤ 来源链接采用"**文件清单编号注入**"：询问/扫描时把任务范围文件以"编号 + 标题"清单注入上下文，AI 按编号引用，前端按编号解析为可点击链接。

关键设计决策：
- **三次调用链路**：矛盾预扫描（`scanContradictions`）→ 生成初稿（注入矛盾清单 + 标注指令）→ 矛盾定位审查（`locateContradictions`，返回正文原句 `draftQuote` 与 `merged` 标记）。扫描/定位失败**不阻断生成**（降级：无矛盾清单 / 无正文定位，仅提示）。
- **矛盾分组语义**：同一"事实主题"一个分组，组内每个"说法"一条 variant（可关联 ≥1 个来源文件，支持 3+ 来源同主题）；只有**实质性冲突**（数据 / 时间 / 地点 / 主体 / 结果相左）才算矛盾，措辞差异不算。
- **标注契约**：生成提示词按序号（#1…#N）注入矛盾清单，正文中 LLM 在相关位置插入标记 `【矛盾#N】`；前端加载时转为不可编辑的内联标注节点，保存时序列化回原标记文本；`draft_contradictions.seq` 与标记序号对应。
- **文段溯源本地优先**：`writing:askSource` 先本地检索（过滤式混合检索 + 原文片段精确匹配），命中即直接返回来源（无需 LLM）；未命中再走 LLM 兜底（注入文件编号清单）。
- **来源打开**：`sources:openPath` 主进程解析工作区 / 导入路径 → `shell.openPath` 用系统默认软件打开；URL 类型资料用 `shell.openExternal`。

### Task 3.7.1 - 矛盾数据模型与迁移（Migration 009）

- **Task Detail:** 新增两张表并迁移：
  1. `draft_contradictions`：`id`(PK)、`draft_id`(FK→drafts，ON DELETE CASCADE)、`seq`（生成提示词中的序号 #N）、`topic`（事实主题一句话）、`kind`（data / time / place / fact / other，可选）、`status`（pending / adopted / ignored，默认 pending）、`merged`（定位审查发现正文自然合并的兜底标记）、`created_at`。
  2. `contradiction_variants`：`id`(PK)、`contradiction_id`(FK，CASCADE)、`variant_text`（该说法原文摘录 ≤200 字）、`source_ids`（JSON 数组，支持 ≥1 个来源）、`position`（原文位置，可选）、`draft_quote`（定位审查填写的正文原句，可空）。
  3. `drafts` / `segments` 表结构不变。
- **Affected Areas:** Migration 009、新仓储 `src/main/db/contradictions.ts`（`insertContradictions` / `getContradictionsByDraft` / `updateContradictionStatus` / `updateContradictionQuote`）、`docs/data-model.md`。
- **Verification:** 迁移可重复执行；矛盾与 variant 随 draft 级联删除；重启后矛盾数据完整；`seq` 在所属 draft 内唯一。
- **Status: 已完成（2026-08-10）**

### Task 3.7.2 - 生成链路改造（预扫描 + 生成注入 + 定位审查）

- **Task Detail:** `src/main/writing/generate.ts`：
  1. **矛盾预扫描 `scanContradictions`**：检索完成后、生成前，用任务 provider 发起专门调用。系统提示词（资料审校专家）：在【参考材料】中找出对同一事实存在冲突表述的矛盾点，按事实主题分组，每说法一条 variant（原文摘录 ≤200 字 + 来源文件编号列表）；要求纯 JSON 输出 `{"contradictions":[{"topic","kind","variants":[{"text","sourceRefs":["#N",...]}]}]}`，无矛盾返回 `{"contradictions":[]}`；强调仅实质性冲突、不确定不输出、支持同主题 3+ 来源。
  2. **来源编号清单注入**：预扫描与生成共用 `buildSourceRefList`（任务范围文件"编号 + 标题"清单），供 AI 按 `#N` 引用。
  3. **生成提示词注入矛盾清单**：system prompt 增加"材料矛盾提示"区块——列出各矛盾组（主题 + 各说法摘要 + 来源编号），并明确指令：**正文涉及矛盾史实时，严禁将不同说法自然合并 / 折中成材料中没有的表述**；应**分开并列表述**（如"据《A》载……，而《B》则载……"），**或只采用其中一种表述**（不强行调和，其余保留在矛盾清单待人工取舍）；并在相关位置插入标记 `【矛盾#N】`。输出契约仍为 `{title, content, error}`。
  4. **矛盾定位审查 `locateContradictions`**：初稿落库后，对"材料 + 初稿正文 + 矛盾清单"发起定位调用，返回 `{"items":[{"seq","draftQuote"(正文原句 / 未涉及为 null),"merged"(true|false)}]}`；据此回填 `draft_quote` 与 `merged`。
  5. **落库与降级**：全部矛盾组随 draft 落库（`insertContradictions`）；预扫描失败 → 无矛盾清单，生成照常（仅提示"矛盾扫描失败，可重试"）；定位审查失败 → 矛盾保留但 `draft_quote` 为空（弹窗可用、正文定位缺失）；预扫描 / 定位各自独立超时（沿用生成 10 分钟策略）。
  6. `generateDraft` 返回值增加 `contradictions`（供前端首次加载即展示）。
- **Affected Areas:** `src/main/writing/generate.ts`（新函数 + 提示词 + 调用编排）、`buildSourceRefList`（来源编号清单）、`src/main/db/contradictions.ts`、`src/shared/types.ts`（Contradiction / Variant 类型）、`draft:generate` 响应结构、单测（扫描 / 定位输出解析、提示词含"严禁合并"指令、降级路径）。
- **Verification:** 含矛盾的资料生成初稿后，返回矛盾清单且正文出现 `【矛盾#N】` 标记；正文不出现"融合折中"表述（提示词约束 + merged 兜底标记）；无矛盾材料生成照常且 contradictions 为空；扫描 / 定位失败不阻断生成；typecheck / 单测 / 构建通过。
- **Status: 已完成（2026-08-10）**
  - **2026-08-11 防漏改进（分治扫描）：** 扫描输入由"检索 chunk 子集"改为任务范围内**全部资料分块**（`loadAllScopeChunks`，绕过检索过滤，避免"检索把含矛盾点的资料段落剔除 → 矛盾永久不可见"）；按共同字符对聚类（`clusterSourcesByTopics`，dice≥0.05）后，聚类内资料**两两配对**（≤6 份）或**整组窗口扫描**，单窗口 ≤60000 字符（`sliceChunkWindows`），跨窗口结果按 topic 相似度合并去重（`mergeScanGroups`）；扫描提示词改为**结构化核对**（先列事实条目清单、按时间/数据/地点/主体/过程五维逐条核对）；各窗口仍低温度 + 温度阶梯重试。验证：typecheck 零错误、139 项单测、生产构建成功。
  - **2026-08-11 扫描提速：** 实测发现"正在扫描资料矛盾"阶段卡顿极久——两两配对调用爆炸（≤6 份资料产生 C(n,2) 组合 × 每对重新提交整份资料，调用数约为整组窗口的 6 倍）+ 全部窗口串行 + 空结果按温度阶梯 0→0.3→0.7 反复重试（无矛盾窗口空跑 ×3）+ 无进度反馈。修复：聚类内一律**整组窗口扫描**（单份材料只提交一次，冲突段落同窗概率由聚类保证）；窗口**并发执行**（`CONTRADICTION_SCAN_CONCURRENCY=2`，避免触发模型限流 429）；空结果重试收敛（温度 0 空 → 仅跳最高档 0.7 再确认一次，仍空即接受；解析失败仍全档重试）；扫描期间推送**窗口级进度**（"正在扫描资料矛盾（x/y 个窗口）…"）。验证：typecheck 零错误、140 项单测、生产构建成功。
  - **2026-08-11 扫描视野收敛（最终）**：用户实测全量扫描仍太慢且产生大量与正文无关的"警告"条目（失大于得），决策**改回"只在粗筛/检索后、撰写初稿实际用到的文段（`chunks`）之间找矛盾"**——删除 `loadAllScopeChunks`（全量分块）与相关测试，`scanContradictions` 输入改为 `retrieveChunksHybrid` 的产物 `chunks`（摘要粗筛 + 段落级精检后、将提交给生成大模型的文段）。代价：被检索剔除段落中的矛盾可能不被发现（用户已确认此取舍）；收益：扫描材料量大幅下降、更快、警告条目显著减少、矛盾更聚焦正文。验证：typecheck 零错误、139 项单测、生产构建成功。

### Task 3.7.3 - 编辑器内嵌矛盾标注（TipTap）

- **Task Detail:** `DraftEditor.tsx`：
  1. 注册自定义内联节点 `contradictionMarker`（atom，不可编辑），渲染为 ⚠️ 矛盾 chip（含矛盾主题或序号），属性 `seq`。
  2. 加载初稿时：扫描 content 中 `【矛盾#N】` 标记 → 转换为 `contradictionMarker` 节点（序号 N 映射 `draft_contradictions.seq`）；无对应矛盾记录的残留标记降级为普通高亮文本。
  3. 保存（`draft:updateContent` 序列化）时：`contradictionMarker` 节点序列化回 `【矛盾#N】` 文本，保证与 DB / 重新加载一致。
  4. 工具栏新增"矛盾"按钮（显示待处理数），点击打开矛盾总览弹窗（复用 Task 3.7.4 组件，all 模式）；点击正文标注节点打开该矛盾对比弹窗。
- **Affected Areas:** `DraftEditor.tsx`、TipTap 扩展注册、`zh-CN.ts`、`main.css`（标注样式）。
- **Verification:** 初稿含标记时加载显示为不可编辑标注节点、点击触发弹窗；编辑保存后重载标注不丢失；无矛盾记录时残留标记不崩溃；typecheck / 构建通过。
- **Status: 已完成（2026-08-10）**

### Task 3.7.4 - 矛盾对比弹窗与取舍操作

- **Task Detail:** 新组件 `ContradictionDialog`：
  1. 单条模式：标题（主题 + 类型标签）、各说法并列卡片（variant_text + 该说法来源文件链接列表[编号 + 标题 + 「打开」]）、正文定位片段（draft_quote，若空提示"未能定位到正文"）。
  2. 取舍操作：每条说法「采纳该说法」（置 status=adopted，记录 variantId）、「忽略该矛盾」（status=ignored）；弹窗关闭后可再次打开；被采纳的说法在弹窗中置顶高亮。
  3. 总览模式：列出该稿全部矛盾（含状态与待处理数），点击进入单条模式。
  4. IPC：`draft:getContradictions { draftId }`（含来源文件信息）、`draft:resolveContradiction { contradictionId, action, variantId? }`；preload 类型化。
- **Affected Areas:** 新组件 `ContradictionDialog.tsx`、`src/shared/ipc.ts` + `src/main/index.ts`（新 handler）+ preload、`WritingWorkspace.tsx`（挂载弹窗 + 加载矛盾列表）、`zh-CN.ts`、`main.css`、`docs/shared-contracts.md`。
- **Verification:** 点击标注 / 工具栏可打开弹窗；多说法（≥3 来源）正确并列展示；来源文件链接显示正确；采纳 / 忽略后状态持久化、重启保持；取消关闭不修改状态。
- **Status: 已完成（2026-08-10）**

### Task 3.7.5 - 文段来源询问（右键菜单 + 自动询问）

- **Task Detail:**
  1. `DraftEditor` 增加右键菜单：选中非空文本后 `contextmenu` 弹出菜单（含「询问文段来源」）；点击后调用 `writing:askSource { taskId, selection }`（选中文本 ≤300 字截断）。
  2. 主进程 `writing:askSource`：**本地检索优先**——用选中文本做过滤式检索 + 原文片段精确匹配（整句 / 子串命中），命中即直接组装回复（列出来源文件编号 + 标题 + 原文位置，来源必可点击）；未命中 → LLM 兜底：注入任务范围文件编号清单，提示词预设"请说明这段文字来源于资料库中的哪些文件（用文件编号回答）"，返回 `{ reply, refs }`。
  3. **自动发送到对话面板**：前端在 ChatPanel 以用户消息展示该询问（带"文段来源询问"标签），回复以 assistant 消息展示；消息经 `task_messages` 持久化，`#N` 引用按 `refs` 渲染为可点击链接。
- **Affected Areas:** 新模块 `src/main/writing/source-query.ts`（本地命中 + LLM 兜底）、`src/shared/ipc.ts`（`writing:askSource` 通道 + `refs` 结构）、`src/main/index.ts`、preload、`DraftEditor.tsx`（右键菜单）、`ChatPanel.tsx`（消息渲染来源链接 + 标签）、`zh-CN.ts`、`main.css`。
- **Verification:** 选中正文右键出现"询问文段来源"；原文直接命中时秒回且来源准确可点击；未命中时 LLM 兜底返回编号引用；询问自动出现在对话面板并可打开来源文件；typecheck / 单测 / 构建通过。
- **Status: 已完成（2026-08-11）**：`src/main/writing/source-query.ts`（`askSourceForTask` 本地精确匹配 → 过滤式检索 → LLM 兜底三阶；询问/回复由主进程写入 task_messages 并带「【文段来源询问】」标签）+ IPC `writing:askSource` + preload 类型化；`DraftEditor.tsx` 右键菜单（选中非空文段弹出「询问文段来源」）；`ChatPanel.tsx` 消息渲染 `#N` 来源引用为可点击链接（按最近一次 refs 解析，点击走 `sources:openPath`）；`WritingWorkspace.tsx` 接线（`handleAskSource` → 刷新对话区）；`splitRefTokens` 工具 + 单测。修复 `findExactSourceMatches` 段落定位 bug（命中首段误计为"第 2 段"：改为统计命中前已完结的段落数 + 1）。

### Task 3.7.6 - 来源文件打开（系统默认软件）

- **Task Detail:** 新 IPC `sources:openPath { sourceId }`：
  1. 主进程按资料类型解析绝对路径：工作区资料（`workspace_dir` + `file_path` 相对路径拼接）与存量导入资料路径；文件不存在返回稳定错误码与提示。
  2. 本地文件 → `shell.openPath`（系统默认软件打开原文）；URL 类型资料 → `shell.openExternal`。
  3. 矛盾弹窗（Task 3.7.4）与来源链接（Task 3.7.5）统一复用此通道；错误（文件缺失）在弹窗 / 消息内展示可读提示。
- **Affected Areas:** `src/main/index.ts`（handler + 路径解析）、`src/shared/ipc.ts` + preload、`ContradictionDialog.tsx` / `ChatPanel.tsx`（链接渲染与失败提示）、`zh-CN.ts`。
- **Verification:** 点击矛盾来源链接 / 文段来源链接，本机默认软件打开对应文件；工作区文件被删除 / 移动时给出明确提示而非崩溃；URL 资料走浏览器打开。
- **Status: 已完成（2026-08-10）**：`sources:openPath` IPC（工作区 / 存量导入路径解析 + `shell.openPath`；URL 资料走 `shell.openExternal`；文件缺失返回稳定错误）与矛盾弹窗来源链接已实现并验证。**文段来源链接（对话消息内 `#N` 引用渲染）已随 Task 3.7.5（2026-08-11）接入：`ChatPanel` 将回复中的 `#N` 按 refs 渲染为可点击链接，点击复用 `sources:openPath` 打开原文。**

### Task 3.7.7 - 测试与验证

- **Task Detail:** 单测：`scanContradictions` / `locateContradictions` 输出解析（含空矛盾、多说法、3+ 来源、非法输出）；生成提示词断言（含"严禁合并"指令、矛盾清单区块、标注契约）；标注标记与 `contradictionMarker` 节点序列化 / 反序列化往返；来源编号清单与 `#N` 解析；`sources:openPath` 路径解析（工作区 / 导入 / URL / 缺失）；迁移级联删除。端到端：准备含矛盾的多文件资料（同一数据两种说法），生成初稿 → 正文出现标注 → 弹窗并列展示 → 采纳 / 忽略 → 来源打开。
- **Affected Areas:** 上述各模块单测、`docs/ui-architecture.md` / `docs/shared-contracts.md` / `AGENTS.md` 同步。
- **Verification:** typecheck / 单测 / 构建通过；端到端场景全部通过；矛盾数据重启后保持。
- **Status: 已完成（2026-08-11）**：单测 125 项全通过——`generate.ts`（`scanContradictions` / `locateContradictions` 输出解析：空矛盾 / 多说法 / 3+ 来源 / 非法输出；生成提示词断言：含"严禁合并"指令、矛盾清单区块、标注契约）、`contradiction-marker.ts`（标记与节点序列化 / 反序列化往返）、`ref-text.ts`（来源编号清单与 `#N` 解析）、`sync.ts`（`sources:openPath` 路径解析：工作区 / 无路径 / URL）、`contradictions.ts`（迁移 + 随 draft 级联删除矛盾与说法）、`source-query.ts`（来源询问工具）。`npm run typecheck` 与 `npm run build` 通过。docs 已同步：`docs/ui-architecture.md`（P2.2 内嵌矛盾标注 / 矛盾弹窗 / 文段来源询问交互）、`docs/shared-contracts.md`（`writing:askSource` 通道 + `refs` 契约 + 4 节来源询问流程）、`agents.md`（Phase 3.7 完成状态）。端到端实测（含矛盾资料生成初稿 → 标注 → 弹窗 → 取舍 → 来源打开）留待用户操作。

### Task 3.7.8 - 矛盾采纳本地修订 + 矛盾/警告分类 + 文段来源上下文溯源（用户体验增强）

- **Task Detail（2026-08-11 补充，2026-08-11 修订）**：
  1. **采纳替换文句生成前置到定位审查**：`locateContradictions` 除返回 `draftQuote`（正文原句，即待修改语句的起止定位）/ `merged` 外，按【矛盾清单】说法编号返回每个说法的"采纳替换文句" `replacements: [{ variantIndex, text }]`（输出契约 `{ items: [{ seq, draftQuote, merged, replacements }] }`）；主进程按 seq+variantIndex 回填 `contradiction_variants.replacement`（Migration 011 新增列）。
  2. **采纳 → 本地直接修订（无 LLM 调用）**：`draft:applyContradiction` 改为纯本地——`from`=该矛盾 `draft_quote`、`to`=被采纳说法 `replacement`，校验 `from` 逐字存在于正文后替换，移除 `【矛盾#N】` 标注，整稿落库，状态置 adopted；缺定位 / 缺替换文句 / 正文被手动修改导致 `from` 未匹配 → 失败返回且状态不变。前端采纳后重挂载编辑器展示修订结果。
  3. **矛盾 vs 警告分类**：Migration 011 新增 `draft_contradictions.in_draft`（1=在正文/矛盾，0=不在正文/警告，NULL=定位未执行）。工具栏「矛盾」「警告」按钮并列：在正文的矛盾可采纳修订/忽略；不在正文的归入警告清单——仅展示各说法与来源（资料库潜在风险）并支持忽略，不提供采纳修订、不影响正文。
  4. **文段来源询问上下文溯源**：Migration 010 新增 `draft_generation_sources`（draft_id + source_id + position + chunk_text）；`generateDraft` 落库实际使用的检索材料；`writing:askSource` 逐字未命中时读取该稿生成上下文，按选中文段 bigram 重叠取 Top-N 注入提示词（文件编号清单 + 文段 + 材料块），让大模型判断同源文件（正文被改写后仍可溯源）；无上下文 / 调用失败回退原过滤式检索与 LLM 兜底。
- **Affected Areas:** `src/main/writing/generate.ts`（定位输出契约扩展 + 落库）、`src/main/db/contradictions.ts`（`updateContradictionQuote` 增 inDraft、新增 `updateVariantReplacement`）、`src/main/db/draft-context.ts`（新，Migration 010 仓储）、`src/main/writing/contradiction-apply.ts`（去 LLM 改本地替换）、`src/main/writing/source-query.ts`（上下文溯源）、`src/shared/types.ts`（`inDraft`/`replacement`）、`DraftEditor.tsx` / `WritingWorkspace.tsx` / `ContradictionDialog.tsx`（警告按钮 + 警告模式）、`zh-CN.ts`、`main.css`、docs。
- **Verification:** 采纳某说法后正文相关语句被本地替换为采纳说法、对应 `【矛盾#N】` 标注移除、状态 adopted 持久化，全程无新增 LLM 调用；`from` 无法定位 / 缺替换文句时不改状态并提示；资料库文件内容不变；不在正文的矛盾出现在"警告"清单（与"矛盾"并列），可查看来源并忽略、不影响正文；文段来源询问在正文被改写时仍能结合生成上下文给出同源文件；typecheck / 单测 / 构建通过。
- **Status: 已完成（2026-08-11）**：单测 135 项全通过（新增定位输出 `replacements` 解析与过滤、`in_draft` / `replacement` 仓储读写、本地替换/标注移除等）。**矛盾捕捉健壮性修复（2026-08-11）**：排查发现矛盾预扫描偶发漏检（同材料一次 205s 返回 940 字符矛盾、另一次 1s 返回 `{"contradictions":[]}`）——`scanContradictions` / `locateContradictions` 改为低温度 + 温度阶梯（0→0.3→0.7）自动重试（失败 / 空结果 / 在正文矛盾缺采纳替换文句时），`chatCompletion` 新增可选 `temperature` 参数。**撤销兼容（2026-08-11 晚）**：采纳修订不再"重挂载编辑器"（`setDraftNonce` 销毁 editor 实例导致 TipTap/ProseMirror history 栈丢失、内置撤销失效），改为 `DraftEditor` forwardRef 暴露 `applyDraftForAdoption`（`setContent(markdown, emitUpdate=true)` 整体替换进入 undo 历史，一次撤销即恢复采纳前正文）+ `getMarkdown`；标注文本 → 节点转换（加载初始化 / 采纳后）传 `addToHistory:false` 不进历史，保证撤销不拆分；`WritingWorkspace` 维护"正文 Markdown → 矛盾状态"快照 Map，编辑器 undo/redo 事务（带 ProseMirror history meta）触发 `onHistoryChanged` 命中快照时回退/恢复矛盾状态，并新增 `draft:resolveContradiction` action=`revert`（主进程 `updateContradictionStatus(...,'pending')` 清空已采纳说法）同步数据库，自动保存随撤销把正文落库回滚，实现"撤销后整个界面恢复到采纳前"。`npm run typecheck`、单测 140 项、`npm run build` 全部通过。端到端实测（撤销/重做回退正文与矛盾状态）依赖真实编辑器交互，留待用户操作。

### 网页资料库（2026-08-11，资料收集/撰写增强）

- **Task Detail:** 完善资料库功能区预留的"输入网页网址"功能为**网页资料库**：用户注册站点（如福州新区门户 `https://fzxq.fuzhou.gov.cn/`），每次生成初稿时自动从该站点检索与撰写要求相关的文章作为资料，与本地文件同等参与资料粗筛、矛盾检测与来源溯源。
- **方案（经探讨确认）：** ① 搜索方式 = **栏目遍历 + 标题粗筛**（探测确认目标政务站为纯 HTML、文章 URL 模式固定；不依赖逆向站内搜索接口）；② 入库 = **持久入库 + 增量**（文章落 `sources`（kind='url'），URL 已存在则跳过，仅抓新增）；③ 绑定 = **资料库全局**（所有任务生成时自动检索）。
- **实现：** Migration 012 新增 `web_sites`（站点注册，root_url 唯一）+ `web_site_articles`（文章 URL 清单缓存，site_id+url 唯一）；`src/main/db/web-sites.ts` 仓储（站点 CRUD + 文章清单增量 upsert + 级联删除）；`src/main/web-source/site-crawler.ts` 服务（`discoverSiteArticles` BFS 抓列表页提取同域 .htm 文章链接、`filterArticlesByQuery` 标题 bigram 粗筛、`importSiteArticle` 增量抓正文落库、`syncSite` 同步清单、`fetchRelatedSiteSources` 生成入口）；IPC `webSource:list/add/remove/sync` + preload + 前端 `WebSourcePanel`（资料库页网址输入区下方：注册/列表/删除/手动同步）；生成链路 `generateDraft` 新增"网页资料检索"阶段（进度锚点 8%，位于摘要之后、RAG 检索之前，抓取文章 sourceIds 并入 scope）。网页文章无向量嵌入时仍可被词法检索（retrieveChunks 词法路基于 bigram 不依赖向量）。
- **Affected Areas:** `migrate.ts`、`src/main/db/web-sites.ts`（新）、`src/main/db/sources.ts`（getSourceByUrl）、`src/main/web-source/site-crawler.ts`（新）、`src/main/writing/generate.ts`、`src/shared/types.ts`（WebSite）、`src/shared/ipc.ts`、`src/main/index.ts`、preload、`SourceList.tsx`/`WebSourcePanel.tsx`（新）、`zh-CN.ts`、`main.css`、docs。
- **Verification:** 注册站点可持久化且 root_url 去重；站点同步发现文章清单并增量去重；标题粗筛仅保留与撰写要求相关的文章；命中文章抓取正文落库后可与本地资料一同参与检索/矛盾扫描；typecheck 零错误、146 项单测（新增 web-sites 3 项 + site-crawler 4 项）、生产构建成功。**实际站点抓取（网络、反爬、栏目结构）依赖真实环境，留待用户注册站点后实测。**

## Phase 4: Version Iteration & Control（已删除）

> **2026-08-11 决策**：产品范围收敛为"资料收集 → 撰写 → 初稿完成"，删除版本迭代与管控环节（第 n 稿 → 人工审核 → 确认 → 第 n+1 稿，以及版本查看 / 对比 / 回滚）。
> 相关的版本管理 UI、`version:*` IPC、`listVersions`、版本类型与规划记录均已移除，每个任务仅保留一稿（初稿）；
> 原 Task 4.1 人工审核中的"矛盾取舍"与"文段直接修改"能力已并入 Phase 3 实现（矛盾弹窗采纳/忽略、编辑器直接编辑）。
>
> **执行记录（2026-08-11 晚）**：代码层面移除 `version:*` 三个 IPC 通道、`draft:confirm`、`VersionListItem`/`SegmentDiff` 类型、`listVersions` 仓储与 handler、前端「版本管理」导航项 / 图标 / 文案 / 任务列表"第 N 稿"显示；新增 `draft:getLatest`（`getLatestDraftByTask`，加载任务最新一稿替代版本列表定位）；数据库保留 `version_number/status/confirmed_at/current_version` 列（不删列避免迁移风险，初稿恒为 0）。
>
> **生成进度条（2026-08-11 晚，与删除版本管理同步完成）**：生成初稿新增**进度条与预计剩余时间**——`onProgress` 升级为 `(stage, percent, etaSeconds)`，各阶段推送百分比（整理摘要 5% → 检索 12% → 矛盾扫描 15~55%（按窗口推进）→ 生成 60% → 定位 95% → 完成 100%）；耗时预估优先取 `llm_call_logs` 历史平均（`estimateLlmSeconds`），缺省回退默认值；IPC 事件 `draft:generateProgress` 负载扩展 `percent`/`etaSeconds`，前端 ChatPanel busy 气泡内显示进度条 + "预计还需 X 分 Y 秒"。验证：typecheck 零错误、140 项单测、生产构建成功。

## Phase 5: Acceptance & Packaging

**Overall Goal:** 产出 Windows 安装包、完成端到端演示与项目文档。

- **Task Detail:** Windows 安装包构建与安装验证（electron-builder NSIS）；核心闭环（收集 → 撰写 → 初稿完成）端到端演示；整理演示数据、使用说明、开发文档与 Git 提交记录。
- **Affected Areas:** 打包发布、端到端验证、项目文档。
- **Verification:** 安装包可安装运行；全流程演示通过；数据全部本地保存，对外仅调用用户配置的大模型与用户提供的信源；已知限制被明确记录。

## Project Completion Criteria

- 收集 → 撰写 → 初稿完成的完整业务闭环可用。
- 初稿支持逐片段溯源（每个片段可查看原文来源）。
- 数据默认保存在本地；对外仅调用用户配置的大模型与用户提供的信源网址，无其他外联行为。
- 矛盾、事件缺失、文段修改三种人工审核场景均可完成。
- Windows 实机验证通过；每项任务可通过项目文档和提交历史追溯到验证结果。
