# 项目规范与约束

本文件是 Coding Agent 与开发者共同使用的持久项目上下文。修改项目之前，必须先阅读本文件以及 `PLAN.md` 中与当前任务相关的部分。本文件应保持简洁，并在项目级决策、当前状态或已知问题发生变化时及时更新。

## 项目目标

开发一款 Windows 桌面的、接入大模型的志书撰写工具，帮助地方党史方志办公室的公务员自动收集、整理、归纳、撰写、审校志书，覆盖"资料收集 → 志稿撰写 → 版本迭代与管控"的完整业务闭环。

## 架构

- **本地优先**：工具开发的初级阶段，所有用户个人数据均保留在本地。除（1）调用大模型时必要的交互、（2）访问用户提供的信源网址外，其他操作均在本地进行。初版不要求账号，不建自有云服务。
- **资料闭环（信源白名单）**：资料只能来自两类来源——用户手动导入的文件、用户输入的信源网址。工具**绝对不得从其他渠道自行获取信息**，撰写时只基于这两类来源。
- **人机协同**：AI 负责初稿生成、资料整理归纳、来源标注；史实考证、矛盾裁定、事件补充、终审定稿由人工主导（遵循"依靠不依赖、赋能不替代"原则）。
- **全程可溯源**：AI 生成的志稿按片段组织，每个小片段在用户需要时都能展示其原文来源（哪个信源/哪篇文章），供用户审核。
- **分层隔离**：操作系统能力（文件读写、信源抓取、数据库、模型调用）与界面层分离，仅通过规模小、类型明确且经过参数验证的接口向界面层暴露能力，避免界面层获得不受限制的本地能力。

## 技术架构（已确认）

**方案：Electron + React + TypeScript**

- 架构：Main 进程（本地文件、SQLite、信源抓取、LLM 调用）/ preload 安全桥 / React Renderer。
- 选型理由：开发效率最高，UI 组件与文档处理生态成熟（PDF/Word/OCR/RAG 均有 Node 生态库）；与参考项目"聚合拾遗"技术栈一致，可直接复用其工程化与安全实践；后续可低成本扩展其他平台。
- 已确认的约束：安装包体积较大、内存占用较高；必须严格管理 Renderer 的 Node 能力边界与信源抓取安全。

### 关键架构决策点

| 决策点 | 方案 | 状态 |
|---|---|---|
| 桌面框架 | Electron + React + TypeScript | 已确认 |
| 本地数据库 | SQLite（驱动: better-sqlite3 13） | 已确认 |
| 全文/向量检索 | SQLite FTS5（向量检索方案待 Phase 3 确定） | Phase 2 使用 LIKE 回退处理中文 |
| 文档解析 | PDF(pdf-parse) / Word(mammoth) / TXT / MD / 图片OCR(tesseract.js) | 已确认 |
| 检索增强（RAG） | 本地全文/向量索引 + 来源引用 | 检索片段必须带来源 |
| LLM 接入 | OpenAI-compatible Provider（兼容 DeepSeek、通义等国内模型） | 用户可配置 |

## 技术栈

- 运行时：Node.js LTS
- 包管理器：npm
- 桌面框架：Electron
- 构建工具：electron-vite + Vite
- Renderer：React 18 + TypeScript strict
- 自动化测试：Vitest
- 本地数据库：SQLite（驱动待 Phase 1 确定）
- 全文/向量检索：SQLite FTS5（向量检索方案待 Phase 3 确定）
- 文档解析：PDF / .docx / TXT / Markdown / 图片 OCR（具体库待 Phase 2 确定）
- AI 接入：用户可配置的 OpenAI-compatible Provider
- 打包发布：electron-builder（Windows NSIS）
- 目标平台：Windows

## 核心功能

### 1. 收集材料

收集撰写志书时需要的资料（包括图片、文字、数据等）和范本：

- 资料来源分为两类：**用户手动导入的文件**、**用户输入的信源网址**。
  - 用户手动导入的文件可被打上自定义标签，标识文件涉及的领域特征（例如：小学教育、新区经济建设等）。
  - 在之后的撰写工作中，工具只能从用户导入的文件或用户提供的信源网址中提取信息，**绝对不能自己从其他地方获取信息**。
- **范本**：用户上传自己的范本（一般为历年成品志书等），工具根据用户上传的范本，自动生成符合其体例要求的志书片段。

### 2. 撰写

- 用户输入：当前需要撰写部分的**标题**、涉及的**文件范围**（可以手动勾选，也可以指定某个标签下的所有资料）。
- 工具输出：根据标题与文件范围，接入的大模型自动生成符合要求的志书片段——即"**初稿**"（第 0 稿）。
- 初稿的内容不能只是一篇纯文本：初稿中的每一个小片段，在用户需要时都能显示其原文来源（哪个信源/哪篇文章），方便用户审核。

### 3. 版本迭代与管控

生成第 n 稿时（n = 0、1、2、3…，初稿视为第 0 稿），会出现大模型无法把控、需要人工审核的情况：

- **出现矛盾**：对于同一件事，不同资料中记述的内容、时间或地点不同，需人工审核并选择正确的记述内容。
- **事件缺失**：所有资料中都没有相关记载、但用户自己知道需要进行补充记录的事件，可由用户直接手动撰写，或导入新的资料/信源后由大模型生成并插入片段。
- **修改文段**：用户直接对文段进行修改。

当用户人工审核、修改完毕后，点击确认，即从第 n 稿生成第 n+1 稿。工具需要保存历次版本，确保用户随时可以进行版本的**查看、对比、回滚**等操作。

## 编码约定

- 采用 TypeScript strict，除非有明确记录的理由，否则不得引入 `any`。
- 代码标识符、文件名、API 名称、数据库字段和 Git Commit 标题使用英文。
- 面向用户的文字不得硬编码在组件里，应集中在文案资源中（便于后续本地化与统一定稿口径）。
- 界面组件只负责呈现与交互；持久化、网络请求、解析、检索和 AI 逻辑放入服务层。
- 不得向界面层提供不受限制的 Node.js、文件系统、Shell 或数据库访问能力；每个接口请求都必须在主进程中验证并返回结构化结果。
- 外部资料（导入文件、信源内容）均视为不可信输入，显示前必须进行安全清洗。
- 不得在源码或普通日志中写入 API Key、凭证、个人路径或资料正文。
- 本地数据库结构确定后，所有 Schema 变更必须通过迁移完成。
- 为文档解析、信源抓取、数据库操作、AI 响应处理、版本快照/回滚编写针对性测试。
- 面向用户的流程必须处理加载、空数据、成功、部分失败和错误状态。
- 避免无关重构；每次修改限制在 `PLAN.md` 指定的任务与模块范围内。
- 修改共享类型或接口协议时，必须同时更新所有调用方与相关文档，不得静默修改。

## 单人开发与 Git 约定

- 本项目为**单人开发**，所有任务由开发者本人完成；`PLAN.md` 中的模块划分是代码组织边界，不涉及多人协作。
- 使用自己的 Git 身份提交代码；每个 Commit 只处理一个明确目的。
- 每个 Commit 应包含其验证结果（测试/检查通过情况），便于回溯。

## 远程仓库（GitHub）

- **仓库地址**：`https://github.com/RegeonChen/XieZhiShu`。该仓库是开发版本控制的权威远程源，本地仓库始终与之保持同步。
- **默认分支**：`main`。单人开发默认直接在 `main` 上提交；涉及大改动可开 `feature/*` 分支，完成并验证后合并回 `main` 并删除分支。
- **同步规则**：
  - 开始任何开发前先 `git pull --rebase`，确保本地基于远程最新的 `main`。
  - 每完成一个任务并验证后提交并 `git push`，保持远程与本地一致，避免长周期离线开发。
- **版本发布规则**：
  - 使用语义化版本（SemVer），在里程碑（如 Phase 完成、可用闭环）打 tag：`vX.Y.Z`（如 `v0.1.0`）。
  - 每个发布版本编写发布说明（如 `RELEASE_NOTES.md`）并在 GitHub Release 中记录。
- **禁止事项**：
  - 不得对 `main` 使用 `git push --force`、`git reset --hard`、`git checkout .` 等破坏性命令，除非用户明确要求。
  - 未经用户明确要求，不执行 commit、push、tag、release 等远程相关操作。
- **敏感与数据隔离**：
  - 不得将 API Key、凭证、`.env`、本地数据库文件、用户资料样本提交到仓库；维护 `.gitignore` 排除上述内容及 `node_modules`、`dist`、`release` 等构建产物。
  - 项目文档（`AGENTS.md`、`PLAN.md`、`init.md`、`docs/` 设计文档）纳入版本管理；`参考-agents.md`、`参考-PLAN.md` 属于外部项目参考，默认不纳入仓库。

## Agent 工作规则

- 修改代码前，先阅读本文件与 `PLAN.md` 中当前执行的任务。
- 先确认仓库的真实状态，不得假设文件或依赖已经存在。
- 遵守 `PLAN.md` 中规定的任务边界与影响模块。
- 当某项选择会改变产品范围、共享协议、安全性、存储数据或平台行为时，将决策及理由记录到本文件"设计决策"或"近期记录"，确保决策可追溯。
- 报告任务完成前，必须运行当前环境中最相关的检查。
- 未证明任务的 `Verification` 验收条件之前，不得将任务或阶段标记为完成。
- 当修改对项目产生实质影响时，更新"当前状态"和"已知问题"。

## 当前状态

截至 2026-08-05：

- **Phase 3 Task 3.2/3.3 已完成**（撰写闭环）：本地 RAG 检索（bigram 词法打分 + 来源位置标注，`writing:retrieve` 预览）→ 初稿生成（提示词工程 + JSON 解析校验 + 失败重试 + 片段来源落库）→ 撰写页 UI（任务列表 / 新建 / 工作台）。验证通过：typecheck 零错误、26 项单测、生产构建成功。下一步 Phase 4（版本迭代与管控）。
- **Phase 3 Task 3.1 已完成**（LLM Provider 配置）：`llm:*` 四通道（list/save/delete/test）与 `settings:*` 两通道全部落地——Provider 增删改查、safeStorage（Windows DPAPI）加密存密钥、连通性测试（net.fetch 调 /chat/completions，错误映射 LLM 错误码）、"设为当前"默认 Provider；设置页 UI 接入，范本管理独立为导航项。验证通过：typecheck 零错误、13 项单测、生产构建成功。下一步 Task 3.2（本地 RAG 检索）。
- **Phase 2.1 全部完成**：资料删除（Task 2.1.1）与标签系统重构（Task 2.1.2）均通过验收。标签与资料为独立关联（`source_tags` 表），**不再嵌入资料标题**；2026-08-05 移除标签颜色（Migration 002 删除 `tags.color`）并移除"标签嵌入标题"机制（Migration 004 清理历史 `[tag:...]` 前缀）。下一步 Phase 3（撰写闭环）。

- 项目处于**需求与规划阶段**：已完成两篇 AI 赋能修志行业文章研读，产出公务员访谈提纲（见 `init.md`）。
- 技术架构选型**已确认**：Electron + React + TypeScript；`PLAN.md` 已按该方案调整。
- **单人开发**，无队友。
- 已创建远程仓库 `https://github.com/RegeonChen/XieZhiShu`（2026-08-03），作为版本控制权威源；交互规则见"远程仓库（GitHub）"章节。
- 已产出三份设计文档（2026-08-03）：`docs/data-model.md`（数据模型与 Schema）、`docs/shared-contracts.md`（共享契约与 IPC 清单）、`docs/ui-architecture.md`（UI 信息架构与页面清单），作为 Phase 1 各任务的直接落地依据。
- **Phase 1 Task 1.1 已完成**（2026-08-03）：Electron 43 + React 18 + TypeScript 脚手架、三栏导航壳（顶栏/左侧一级导航/4 页面空态占位）、preload 安全桥（sandbox + contextIsolation）。验证通过：typecheck 零错误、1 项单测、生产构建、0 依赖漏洞、Electron 窗口正常启动。
- **Phase 1 Task 1.2 已完成**（2026-08-03）：落地 `src/shared/types.ts`（10 类核心实体 + ApiResult/ErrorCodes）与 `src/shared/ipc.ts`（7 组 32 个 IPC 通道常量 + 请求/响应类型 + IpcMapping 类型安全映射）。
- **Phase 1 Task 1.3 已完成**（2026-08-03）：better-sqlite3 本地数据库、嵌入式迁移框架（Migration 001 含全部 10 张表 + FTS5 全文索引 + 触发器自动同步）、sources/tags repository 层、`sources:list` 与 `tags:list` 两个 IPC handler 端到端验证。验证通过：typecheck 零错误、5 项单测（创建表/迁移幂等/CRUD/FTS5 同步）、生产构建。
- **Phase 1 全部 Task 已完成**（2026-08-03）。
- **Phase 2 Task 2.1 已完成**（2026-08-03）：多格式文件导入。**Phase 2.1（2026-08-03）：** 标签系统深度增强——标签嵌入标题前缀 `[tag:name|color]`、事务安全操作 + 级联标题重建、颜色选择器、`sources:get` IPC handler。参照海地小纵队项目 Phase 4.1.3 方案实现。下一步 Phase 3（撰写闭环）。 个 IPC handler：create/update/delete/addToSource/removeFromSource）。TagManager 组件（创建/删除标签 + 彩色标记 + 为资料打标/取消标签）。SourceList 标签筛选（按标签筛选资料列表）。验证通过。下一步 Task 2.4（范本）。
- **Phase 2.1 Task 2.1.1 已完成**（2026-08-04）：资料删除功能——右键菜单删除单个资料（含二次确认）；中栏"全部资料"标题右侧功能菜单按钮 → "资料管理"批量勾选删除（全选/取消全选、已选计数）。新增 `sources:deleteMany` IPC 通道（事务批量删除）、仓库 `deleteSources`、preload `deleteSource/deleteSources`。验证通过：typecheck 零错误、生产构建成功。下一步 Task 2.1.2（标签系统重构）。
- **Phase 2.1 Task 2.1.2 已完成**（2026-08-04）：标签系统重构——标签管理界面四个功能模块（新建标签带相似标签 Top5 建议、批量添加标签、删除标签二次确认、按标签多选交集检索）。新增 `tags:search`/`tags:batchAdd`/`tags:sourcesByTag` IPC 通道、`searchTags`（bigram 相似度）与 `getSourceIdsByTag` 仓库函数；`sources:list` 多标签检索改为 AND 语义（HAVING COUNT）。验证通过：typecheck 零错误、生产构建成功。下一步 Phase 3（撰写闭环）。
- **2026-08-05：标签颜色功能移除**——标签统一显示，不再支持自定义颜色。`Tag` 类型与 `tags:create`/`tags:update` 请求移除 `color`；标题前缀格式由 `[tag:name|color]` 改为 `[tag:name]`（解析兼容旧格式，旧数据仅取标签名）；Migration 002 删除 `tags.color` 列；TagManager 移除颜色选择器与色块、SourceList/SourceViewer 移除颜色内联样式、zh-CN.ts/main.css 同步清理；迁移幂等测试改为按 MIGRATIONS 总数断言。验证通过：typecheck 零错误、5 项单测通过、生产构建成功。下一步 Phase 3（撰写闭环）。

## 设计决策

- 本地优先：所有用户数据保存在本地，不要求账号或自有云服务；对外仅调用用户配置的大模型与用户提供的信源网址。
- 信源白名单：AI 撰写时只使用用户导入的文件与用户提供的信源网址，杜绝模型自发获取外部信息。
- 全程可溯源：AI 输出按片段标注来源，每个片段可回溯到原文。
- 人机协同：矛盾裁定、事件补充、文段修改、终审定稿由人工主导。
- 版本管控：以"第 n 稿"为版本单元，人工确认即产生新版本，支持查看、对比、回滚。
- 技术选型：采用 Electron + React + TypeScript（2026-08-03 确认）。
- RAG 检索方案（2026-08-05）：采用本地词法检索——段落分块 + 字符 bigram 打分 + 来源位置标注，纯本地、无网络、中文无需分词；不引入向量数据库/嵌入依赖，向量索引留待后续按需扩展。

## 路线图

1. Phase 1：项目基础（脚手架、共享契约、本地数据库）
2. Phase 2：资料收集闭环（文件导入 / 信源抓取 / 标签 / 范本）
3. Phase 3：撰写闭环（LLM 接入 / RAG 检索 / 初稿生成与来源标注）
4. Phase 4：版本迭代与管控（片段级审核 / 矛盾解决 / 版本对比回滚）
5. Phase 5：验收与打包（Windows 安装包、端到端演示、文档）

详细任务和验收标准位于 `PLAN.md`，本文件不重复记录任务级进度。

## 近期记录

- **2026-08-05（本次修改）**：输入框聚焦问题排查——用户反馈所有文本框点击后无光标、无法输入。经运行时调试（插桩 document mousedown/focusin/keydown + 主进程窗口焦点事件）验证：窗口焦点、elementFromPoint、defaultPrevented、输入框属性/样式全部正常，当前代码无缺陷；原因为一次性运行时状态（窗口"可见但未激活"）。预防性硬化：`ready-to-show` 中 `win.show()` 后调用 `win.focus()`。验证通过：typecheck 零错误、29 项单测、生产构建成功。

- **2026-08-05（本次修改）**：移除"标签嵌入标题"机制——标签改为纯独立关联（`source_tags` 表），不再写入资料标题：删除 `src/utils/source-title-tags.ts`、移除 `db/tags.ts` 中标题重建逻辑（update/delete/add/remove/batch 均不再触碰 `sources.title`）、前端 SourceList/TagManager/SourceViewer 直接使用 `source.title`；Migration 004（JS 迁移，迁移框架扩展支持 `run`）清理历史数据残留的 `[tag:...]` 标题前缀。删除标签级联验证：`deleteTag` 事务内 `DELETE FROM source_tags WHERE tag_id=?` 实时解除全部资料关联。验证通过：typecheck 零错误、29 项单测（新增迁移 004 清理、deleteTag 级联 2 项）、生产构建成功。

- **2026-08-05（本次修改）**：Phase 3 Task 3.2/3.3 完成——本地 RAG 检索（`src/main/rag/retrieval.ts`：段落分块 + 字符 bigram 打分 + 每来源 Top3/全局 Top12 + 位置标注；`writing:retrieve` 通道）；初稿生成（`src/main/writing/generate.ts`：任务范围解析 → 检索 → 提示词（含范本体例）→ `llm/chat.ts`（net.fetch 对话 + LLM 错误码）→ JSON 解析校验 + 失败重试一次 → 落库 draft/segments/segment_sources）；新增 `db/tasks.ts`、`db/drafts.ts` 仓储、`version:list` handler；preload 新增 createTask/listTasks/retrieveChunks/generateDraft/getDraft/listVersions；撰写页 UI（任务列表 / 新建表单[资料或标签范围+范本] / 工作台[检索预览+生成初稿+片段来源展开]）。验证通过：typecheck 零错误、26 项单测（新增 retrieval 4 项、tasks 3 项、drafts 2 项、generate 解析 4 项）、生产构建成功。下一步 Phase 4（版本迭代与管控）。

- **2026-08-05（本次修改）**：Phase 3 Task 3.1 LLM Provider 配置完成——`llm:listProviders/saveProvider/deleteProvider/testConnection` 与 `settings:get/update` 六个 IPC handler；Migration 003 新增 `llm_providers` 表；`src/main/llm/secret.ts`（safeStorage 加密 `safe-storage:v1:` 前缀）、`provider-store.ts`（CRUD + 密钥不回传）、`test.ts`（net.fetch 连通性测试，LLM 错误码映射）、`db/settings.ts`（data_dir / current_llm_provider_id）；preload 新增 6 个 API；设置页 Settings 组件（新建/编辑/删除/测试/设为当前，密钥 password 输入、已设置徽标）；范本管理从设置页迁移为独立导航项（修复原误挂载）。验证通过：typecheck 零错误、13 项单测（含 provider-store 5 项、settings 3 项）、生产构建成功。下一步 Task 3.2（本地 RAG 检索）。

- **2026-08-04（本次修改）**：Phase 2.1 Task 2.1.2 标签系统重构完成——标签管理界面四模块（新建/添加/删除/检索），相似标签搜索（bigram Jaccard Top5）、批量打标（批量预勾选已带标签资料）、删除标签二次确认（级联重建标题）、按标签多选交集检索（AND 语义）；新增 `tags:search`/`tags:batchAdd`/`tags:sourcesByTag` IPC。验证通过：typecheck 零错误、生产构建成功。下一步 Phase 3（撰写闭环）。
- **2026-08-04**：Phase 2.1 Task 2.1.1 资料删除功能完成——右键菜单删除单资料、中栏"全部资料"标题右侧功能菜单 → "资料管理"批量勾选删除。新增 `sources:delete`/`sources:deleteMany` IPC handler、仓库 `deleteSources`（事务）、preload `deleteSource/deleteSources`；SourceList 增加自定义右键菜单与批量选择模式；App 增加功能菜单按钮与批量模式状态管理。验证通过：typecheck 零错误、生产构建成功。下一步 Task 2.1.2（标签系统重构）。
- **2026-08-03（本次修改）**：Task 2.4 范本完成。Phase 2 全部通过验收：4 个 Task 完成（文件导入/信源抓取/标签体系/范本解析），typecheck 零错误、5 项单测、0 依赖漏洞。下一步 Phase 3。（5 个 IPC handler、TagManager UI 组件、SourceList 标签筛选）。验证通过。下一步 Task 2.4（范本）。（Electron net.fetch + HTML清洗、URL白名单校验、timeout/大小限制、错误码分类）。UI 资料列表新增 URL 输入栏。验证通过。下一步 Task 2.3。（better-sqlite3 原生驱动、嵌入式迁移框架 Migration 001 含全部 10 张表 + FTS5 + 触发器、sources/tags repository、`sources:list` 与 `tags:list` IPC handler）。Phase 1 全部通过验收。下一步进入 Phase 2。
- **2026-08-03**：Task 1.1 脚手架完成。
- **2026-08-03**：产出三份设计文档——`docs/data-model.md`、`docs/shared-contracts.md`、`docs/ui-architecture.md`，作为 Phase 1 任务落地依据；`PLAN.md` 相应补充任务说明，`docs/` 纳入版本管理。
- **2026-08-03**：登记远程仓库 `https://github.com/RegeonChen/XieZhiShu`，新增"远程仓库（GitHub）"章节，约定同步流程、分支与 tag 规则、禁止事项及敏感信息/.gitignore 隔离。
- **2026-08-03**：确认技术架构选型为 Electron + React + TypeScript；确认项目为单人开发；按上述确认更新"技术架构""技术栈""单人开发与 Git 约定"等章节，并同步调整 `PLAN.md`。
- **2026-08-03**：建立项目文档。确定初版需求（收集 → 撰写 → 版本管控）与本地优先约束；提出四个技术架构候选方案与关键架构决策点；编写 `PLAN.md` 开发计划初稿。

## 已知问题

- **大模型幻觉风险**：无依据编造史实是本工具必须重点抑制的风险，需通过"信源白名单 + RAG 检索 + 逐片段来源标注"在架构层面约束。
- **单人开发进度压力**：任务量大，需严格按 `PLAN.md` 分阶段推进并保证每个任务的验收标准完成后再进入下一任务。
- **FTS5 中文全词检索受限**：unicode61 tokenizer 对中文按单字分词，"全文检索"不会整体匹配。已落地方案（2026-08-05）：RAG 检索改用字符 bigram 打分（不受分词限制）；FTS5 仍用于资料列表关键词过滤，英文分词正常可用。
- **better-sqlite3 原生模块分发**：首次 `npm install` 需要本地编译工具（node-gyp / VS Build Tools）。electron-builder 打包时需配置 `nativeRebuilder` 确保跨机器可运行。当前开发机已编译通过。
- **部分 IPC 通道仅有类型无实现**：已实现资料/标签/范本/设置/LLM Provider/撰写任务/初稿/版本列表相关的主要 handler；撰写审核与版本对比回滚通道（`draft:confirm`、`segment:*`、`version:compare`、`version:rollback`）需在 Phase 4 中实现。接口契约均已定义，无阻塞风险。
