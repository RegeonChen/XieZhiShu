# Project Plan

本计划基于 `AGENTS.md` 制定。项目尚未初始化，文中的"影响模块"是职责范围，具体文件路径将在脚手架建立后补充。本项目为**单人开发**，`Team Responsibilities` 中的模块划分是代码组织边界，不涉及多人协作。

设计文档已产出（见 `docs/`）：数据模型与 Schema（`data-model.md`）、共享契约与 IPC 清单（`shared-contracts.md`）、UI 信息架构与页面清单（`ui-architecture.md`）。Task 1.1–1.3 分别以对应文档为落地依据。

## Team Responsibilities（模块职责范围）

| 模块 | 主要职责 | 主要交付 |
|---|---|---|
| 桌面框架与界面 | 桌面应用框架、资料管理界面、撰写编辑器、版本对比界面、交互状态 | 应用骨架、资料/撰写/版本管理各功能页面、片段级审核 UI |
| 资料解析与信源 | 文件导入解析、OCR、信源抓取、内容清洗、标签体系 | 结构化资料、来源快照、标签体系、范本体例解析 |
| 数据与 AI 服务 | 本地数据库、RAG 检索、LLM Provider、初稿生成、来源标注、版本管控 | SQLite、向量/全文索引、生成与审校服务、版本快照与回滚 |

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

- **Task Detail:** 按 `docs/data-model.md` 建立 SQLite 数据库与迁移机制（驱动在 better-sqlite3 / sql.js 中确定），持久化资料、标签、范本、撰写任务、志稿版本、片段、片段来源、审核记录与本地设置，并提供统一的数据访问接口。
- **Affected Areas:** 数据库连接、迁移、数据仓储、查询接口。
- **Verification:** 重启应用后数据仍然存在；迁移可重复执行；核心实体（资料/标签/志稿/版本）可正确写入与读取。

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

## Phase 4: Version Iteration & Control

**Overall Goal:** 完成"第 n 稿 → 人工审核（矛盾 / 缺失 / 修改）→ 确认 → 第 n+1 稿 → 版本查看 / 对比 / 回滚"的闭环。

### Task 4.1 - Segment-level Review & Edit

- **Task Detail:** 编辑器支持片段级审核：矛盾提示与多来源对比选择、事件缺失的手动补写或导入新资料后生成插入、文段直接修改。
- **Affected Areas:** 编辑器、矛盾检测、多来源对比视图、插入/补写流程。
- **Verification:** 矛盾（内容/时间/地点不一致）、事件缺失、文段修改三种人工审核场景均可完成并保存为新的稿件内容。

### Task 4.2 - Version Snapshot, Compare & Rollback

- **Task Detail:** 用户点击"确认"后从第 n 稿生成第 n+1 稿；保存历次版本快照；支持版本列表、任意版本差异对比、回滚。
- **Affected Areas:** 版本快照存储、差异对比、回滚服务、版本管理界面。
- **Verification:** 历次版本均可查看；相邻或任意版本可对比差异；回滚后内容与对应版本快照一致；重启后版本数据仍完整。

### Phase 4 Integration

- 版本闭环端到端。
- **Verification:** 从初稿开始，经多轮人工审核与确认可生成第 1、2…稿；任意时刻可查看、对比、回滚到历史版本。

## Phase 5: Acceptance & Packaging

**Overall Goal:** 产出 Windows 安装包、完成端到端演示与项目文档。

- **Task Detail:** Windows 安装包构建与安装验证（electron-builder NSIS）；核心闭环（收集 → 撰写 → 版本管控）端到端演示；整理演示数据、使用说明、开发文档与 Git 提交记录。
- **Affected Areas:** 打包发布、端到端验证、项目文档。
- **Verification:** 安装包可安装运行；全流程演示通过；数据全部本地保存，对外仅调用用户配置的大模型与用户提供的信源；已知限制被明确记录。

## Project Completion Criteria

- 收集 → 撰写 → 版本迭代与管控的完整业务闭环可用。
- 初稿及后续各稿均支持逐片段溯源（每个片段可查看原文来源）。
- 数据默认保存在本地；对外仅调用用户配置的大模型与用户提供的信源网址，无其他外联行为。
- 矛盾、事件缺失、文段修改三种人工审核场景均可完成。
- 历次版本可查看、对比、回滚。
- Windows 实机验证通过；每项任务可通过项目文档和提交历史追溯到验证结果。
