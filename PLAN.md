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

- **Task Detail:** 用户可对资料打自定义标签（如"小学教育""新区经济建设"）；支持标签增删改查、一份资料多个标签、按标签筛选资料。
- **Affected Areas:** 标签数据模型、资料-标签关联、检索接口、标签管理界面。
- **Verification:** 标签 CRUD 正常；一份资料可带多个标签；按标签可筛出全部相关资料；重启后标签与关联状态保持。

### Task 2.4 - Template Book (范本) Upload & Parsing

- **Task Detail:** 用户上传历年成品志书作为范本，工具解析其篇目层级结构与行文体例，形成"范本模板"供后续撰写任务参照。
- **Affected Areas:** 范本解析、体例模型、范本管理界面。
- **Verification:** 范本能解析出篇目层级与体例特征；生成的范本模板可作为撰写任务的体例参照。

### Phase 2 Integration

- 文件导入 / 信源抓取 → 打标 → 入库 → 按标签与关键词检索 全链路打通。
- **Verification:** 用户可导入文件与网址、打标签、按标签浏览全部资料；每条资料可溯源到具体文件或网址。

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
