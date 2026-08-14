# 项目规范与约束

本文件是 Coding Agent 与开发者共同使用的持久项目上下文。修改项目之前，必须先阅读本文件以及 `PLAN.md` 中与当前任务相关的部分。本文件应保持简洁，并在项目级决策、当前状态或已知问题发生变化时及时更新。

## 项目目标

开发一款 Windows 桌面的、接入大模型的志书撰写工具，帮助地方党史方志办公室的公务员自动收集、整理、归纳、撰写、审校志书，覆盖"资料收集 → 志稿撰写 → 初稿完成"的完整业务闭环。

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

### 3. 初稿人工审核（并入 Phase 3 实现）

初稿完成后由人工审核与修订，大模型无法把控的内容交人工处理：

- **出现矛盾**：对于同一件事，不同资料中记述的内容、时间或地点不同，需人工审核并选择正确的记述内容——工具在正文插入 `【矛盾#N】` 标注，点击弹出多说法对比，支持采纳（正文同步本地修订）与忽略。
- **修改文段**：用户直接在编辑器中对文段进行修改。

> **2026-08-11 决策**：版本迭代与管控（第 n 稿 → 人工审核 → 确认 → 第 n+1 稿，以及版本查看 / 对比 / 回滚）已从产品范围删除，每个任务仅保留一稿（初稿）；"事件缺失补充"暂不在当前范围。

## 编码约定

- 采用 TypeScript strict，除非有明确记录的理由，否则不得引入 `any`。
- 代码标识符、文件名、API 名称、数据库字段和 Git Commit 标题使用英文。
- 面向用户的文字不得硬编码在组件里，应集中在文案资源中（便于后续本地化与统一定稿口径）。
- 界面组件只负责呈现与交互；持久化、网络请求、解析、检索和 AI 逻辑放入服务层。
- 不得向界面层提供不受限制的 Node.js、文件系统、Shell 或数据库访问能力；每个接口请求都必须在主进程中验证并返回结构化结果。
- 外部资料（导入文件、信源内容）均视为不可信输入，显示前必须进行安全清洗。
- 不得在源码或普通日志中写入 API Key、凭证、个人路径或资料正文。
- 本地数据库结构确定后，所有 Schema 变更必须通过迁移完成。
- 为文档解析、信源抓取、数据库操作、AI 响应处理、初稿生成与矛盾检测编写针对性测试。
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

截至 2026-08-11：

- **Phase 3.7 已完成**（初稿矛盾检测与来源溯源）：生成链路新增矛盾预扫描 `scanContradictions` → 生成注入"材料矛盾提示"（**严禁自然合并/折中**，分开并列表述或只取一种 + 正文插 `【矛盾#N】` 标注）→ 定位审查 `locateContradictions`（回填正文原句与 merged 兜底标记）三次调用编排，扫描/定位失败独立降级不阻断生成；数据模型新增 `draft_contradictions`（矛盾分组，seq 与标记序号对应）+ `contradiction_variants`（各说法 + source_ids JSON，支持同主题 3+ 来源，Migration 009，随 draft 级联删除）；编辑器注册不可编辑的 `contradictionMarker` 内联节点（加载转节点、保存序列化回标记），工具栏「矛盾」按钮 + `ContradictionDialog`（单条对比/总览 + 采纳/忽略取舍持久化）；**文段来源询问**（右键选中文段 → `writing:askSource` 本地精确匹配 → 过滤式检索 → LLM 兜底，询问与回复持久化到对话面板，`#N` 按 refs 渲染为可点击链接）；`sources:openPath` 统一打开来源文件（工作区/导入路径解析 + `shell.openPath`，URL 走 `shell.openExternal`，缺失返回稳定错误）。验证通过：typecheck 零错误、125 项单测（含扫描/定位解析、提示词"严禁合并"断言、标注往返序列化、`#N` 解析、路径解析、迁移级联删除）、生产构建成功。下一步 Phase 5（验收与打包）。
- **Phase 3.7 增强已完成**（2026-08-11，用户体验）：① **矛盾采纳 → 正文本地修订**——定位审查（生成阶段）除回填 `draftQuote/merged` 外，还为每个说法预生成"采纳替换文句"（`replacements`，存 `contradiction_variants.replacement`，Migration 011）；用户点「采纳」时主进程**不调用大模型**，仅本地替换（`from`=正文原句 `draft_quote` 起止定位 → `to`=被采纳说法 `replacement`）+ 移除 `【矛盾#N】` 标注 + 整稿落库（`draft:applyContradiction`；失败返回可读错误且状态不变；资料库只读），前端重挂载编辑器即时展示。② **矛盾 vs 警告**——定位审查据 `draftQuote` 判定 `in_draft`：在正文 →「矛盾」按钮（可采纳/忽略）；不在正文 → 工具栏新增「警告」按钮并列展示，警告清单仅查看各说法来源与忽略，不影响正文。③ 文段来源询问上下文溯源（沿用 2026-08-11 早间版本：Migration 010 生成上下文 + Top-N 材料注入 LLM 溯源）。④ **矛盾捕捉健壮性修复（2026-08-11 晚）**：排查发现矛盾预扫描偶发漏检——同一份材料（78621 字符输入）一次 205 秒返回 940 字符矛盾、另一次仅 1 秒返回 `{"contradictions":[]}`（模型默认采样温度下不确定性 + 链路无重试）；修复为扫描/定位调用传低温度（确定性）并在"失败 / 空结果 / 在正文矛盾缺采纳替换文句"时按温度阶梯（0→0.3→0.7）自动重试（`chatCompletion` 新增可选 `temperature` 参数）。⑤ **矛盾扫描防漏改进（2026-08-11，分治扫描）**：扫描输入由"检索 chunk 子集"改为任务范围内全部资料分块（`loadAllScopeChunks`，绕过检索过滤，避免"检索把含矛盾点的资料段落剔除 → 矛盾永久不可见"）；按共同字符对聚类（`clusterSourcesByTopics`，dice≥0.05）后，聚类内资料两两配对（≤6 份）或整组窗口扫描，单窗口 ≤60000 字符（`sliceChunkWindows`），跨窗口结果按 topic 相似度合并去重（`mergeScanGroups`）；扫描提示词改为结构化核对（先列事实条目清单、按时间/数据/地点/主体/过程五维逐条核对）；各窗口仍低温度 + 温度阶梯重试。**扫描提速（2026-08-11 续）**：实测"正在扫描资料矛盾"阶段卡顿极久——两两配对调用爆炸（≤6 份资料 C(n,2) 组合 × 每对重新提交整份资料，调用数约整组窗口的 6 倍）+ 全窗口串行 + 空结果按温度阶梯 0→0.3→0.7 反复空跑 ×3 + 无进度反馈；改为聚类内一律整组窗口扫描（单份材料只提交一次）、窗口并发执行（`CONTRADICTION_SCAN_CONCURRENCY=2` 防 429 限流）、空结果重试收敛（温度 0 空 → 跳最高档 0.7 再确认一次，仍空即接受；解析失败仍全档重试）、扫描推送窗口级进度（"正在扫描资料矛盾（x/y 个窗口）…"）。**扫描视野收敛（2026-08-11 深夜，最终决策）**：全量扫描仍太慢且产生大量与正文无关的"警告"条目（失大于得），改为**只在粗筛/检索后、撰写初稿实际用到的文段（`chunks`）之间找矛盾**——删除 `loadAllScopeChunks`（全量分块）及测试，`scanContradictions` 输入改为 `retrieveChunksHybrid` 产物（摘要粗筛 + 段落级精检后、将提交给生成大模型的文段）；代价是被检索剔除段落中的矛盾可能不被发现（用户已确认此取舍）。验证通过：typecheck 零错误、139 项单测、生产构建成功。⑥ **矛盾采纳兼容"撤销"按钮（2026-08-11 晚）**：采纳修订不再重挂载编辑器（旧 `setDraftNonce` 销毁 editor 实例使 TipTap/ProseMirror history 栈丢失、内置撤销失效）——`DraftEditor` 改 `forwardRef` 暴露 `applyDraftForAdoption`（`editor.commands.setContent(markdown, true)` 经 tiptap-markdown 重写的 setContent 直接解析 Markdown 并整体替换，事务进入 undo 历史，**一次撤销即恢复采纳前正文**）与 `getMarkdown`；标注文本 → 节点转换（加载初始化 / 采纳后紧随 setContent）传 `addToHistory:false`，保证撤销不拆分、加载转换不污染历史；`WritingWorkspace` 维护"正文 Markdown → 矛盾状态"快照 Map（采纳前后各注册一份），监听编辑器 undo/redo 事务（ProseMirror history meta `tr.getMeta('history')`）经 `onHistoryChanged` 命中快照时回退/恢复矛盾状态，`draft:resolveContradiction` 新增 `action='revert'`（`updateContradictionStatus(id,'pending')` 清空已采纳说法）同步主进程数据库，自动保存随撤销把正文落库回滚——撤销后整个界面（正文 + 矛盾清单 + 工具栏计数）恢复到采纳前，redo 可重放采纳。验证通过：typecheck 零错误、140 项单测（新增 revert 回退测试）、生产构建成功。⑦ **删去版本管理 + 生成进度条（2026-08-11 晚，产品范围收敛为"资料收集 → 撰写 → 初稿完成"）**：移除 `version:*` 三个 IPC 通道、`draft:confirm`、`VersionListItem`/`SegmentDiff` 类型、`listVersions` 仓储与 handler、前端「版本管理」导航项/图标/文案/任务列表"第 N 稿"显示，新增 `draft:getLatest`（`getLatestDraftByTask` 加载任务最新一稿）；数据库保留 `version_number/status/confirmed_at/current_version` 列（不删列，初稿恒为 0）。同时生成初稿新增**进度条与预计剩余时间**：`onProgress` 升级为 `(stage, percent, etaSeconds)`，阶段百分比（整理摘要 5 → 检索 12 → 矛盾扫描 15~55 按窗口推进 → 生成 60 → 定位 95 → 完成 100）；耗时预估取 `llm_call_logs` 历史平均（`estimateLlmSeconds`，缺省回退默认值）；`draft:generateProgress` 负载扩展 `percent`/`etaSeconds`，ChatPanel busy 气泡内进度条 + "预计还需 X 分 Y 秒"。验证：typecheck 零错误、140 项单测、生产构建成功。⑧ **网页资料库（2026-08-11，资料收集/撰写增强）**：完善资料库"输入网页网址"预留接口——用户注册站点（如 `https://fzxq.fuzhou.gov.cn/`），生成初稿时自动检索该站点与撰写要求相关的文章并抓取正文，与本地文件同等参与粗筛/矛盾检测/溯源。方案（经探讨确认）：栏目遍历+标题粗筛（探测确认政务站纯 HTML、URL 模式固定，不依赖逆向搜索接口）；持久入库+增量（URL 已存在跳过）；资料库全局绑定。实现：Migration 012 `web_sites`+`web_site_articles`；仓储 `db/web-sites.ts`（站点 CRUD+清单增量 upsert）；服务 `web-source/site-crawler.ts`（`discoverSiteArticles` BFS 发现、`filterArticlesByQuery` 标题 bigram 粗筛、`importSiteArticle` 增量抓正文、`syncSite`、`fetchRelatedSiteSources`）；IPC `webSource:list/add/remove/sync`+preload；前端 `WebSourcePanel`（资料库页注册/列表/删除/同步）；`generateDraft` 新增"网页资料检索"阶段（进度锚点 8%，摘要后、RAG 检索前，抓取文章并入 scope；无向量文章仍可词法检索）。验证：typecheck 零错误、146 项单测（新增 7 项）、生产构建成功。实际站点抓取（网络/反爬/栏目结构）留待用户注册站点后实测。
- **Phase 3.6 已完成**（预设大模型 + 获取 API key 指引）：内置三条主流大模型预设配置（DeepSeek v4 Flash / v4 Pro、智谱 GLM-4-Flash），共享数据层 `src/shared/llm-presets.ts`（前后端共用，每条含 model/apiBase/pricing/signupUrl + 逐模型"注册→获取 API key"教程步骤）；新 IPC `app:openExternal`（http/https 白名单 + `shell.openExternal`，preload/index.d.ts/main handler 同步）；设置页 Provider 区上方新增「预设大模型」区块（「使用此模型」一键预填新建表单 name/apiBase/model、「获取 API key」弹出悬浮窗）；新组件 `PresetGuideDialog`（分步教程 + 「打开注册页」跳官方平台）。验证通过：typecheck 零错误、104 项单测（新增 llm-presets 3 项）、生产构建成功。用户填入 key 走现有「测试连接」/生成链路的实测留待用户操作。
- **Phase 2.2 已完成**（工作区资料库，全面重构）：用户指定本地文件夹即资料库——递归扫描（含多级子目录）→ sha256 指纹对账（`sources.content_hash/file_mtime/file_size/workspace`，Migration 006）→ chokidar 实时监听（500ms 防抖 + 5 分钟兜底对账）自动解析/向量化/失效摘要；反向同步：软件内删除 → `shell.trashItem` 回收站、改标题 → 重命名工作区原文件（重名加后缀）；存量导入资料可经设置页一次性迁移到工作区；内嵌文件服务改按资料 id 提供（白名单化）。验证通过：typecheck 零错误、50 项单测、生产构建成功。**注意：importFiles 转存逻辑退役，以工作区为准。**
- **Phase 3.2 已完成**（资料预处理与混合检索）：本地向量嵌入（BGE-small-zh-v1.5 + @huggingface/transformers，onnxruntime WASM 后端，纯本地）+ 词法/向量 RRF 混合检索 + LLM 摘要索引（"整理资料库"手动触发）。资料导入/更新后自动增量向量化；检索接口与下游生成保持兼容。验证通过：typecheck 零错误、39 项单测、生产构建成功。下一步 Phase 5（验收与打包）。**BGE 模型已下载至 `resources/models/bge-small-zh-v1.5/`，WASM 推理验证通过（512 维向量，Node 与 CJS 双路径）。**
- **Phase 3.1 已完成**（撰写闭环增强）：撰写任务删除（右键 + 二次确认）与初稿文档编辑器（TipTap 所见即所得，Markdown 存储、自动保存、来源标注保留）全部通过验收。验证通过：typecheck 零错误、30 项单测、生产构建成功。下一步 Phase 5（验收与打包）。
- **Phase 3 Task 3.2/3.3 已完成**（撰写闭环）：本地 RAG 检索（bigram 词法打分 + 来源位置标注，`writing:retrieve` 预览）→ 初稿生成（提示词工程 + JSON 解析校验 + 失败重试 + 片段来源落库）→ 撰写页 UI（任务列表 / 新建 / 工作台）。验证通过：typecheck 零错误、26 项单测、生产构建成功。下一步 Phase 5（验收与打包）。
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
- 版本管控（已删除，2026-08-11 决策）：原计划以"第 n 稿"为版本单元支持查看/对比/回滚；产品范围收敛为"收集 → 撰写 → 初稿完成"，版本管理模块及其代码已移除。
- 技术选型：采用 Electron + React + TypeScript（2026-08-03 确认）。
- RAG 检索方案（2026-08-05）：采用本地词法检索——段落分块 + 字符 bigram 打分 + 来源位置标注，纯本地、无网络、中文无需分词；不引入向量数据库/嵌入依赖，向量索引留待后续按需扩展。
- 向量检索落地（2026-08-06，Phase 3.2）：资料预处理与混合检索上线——本地 embedding 模型 **BGE-small-zh-v1.5**（`@huggingface/transformers`，纯本地 ONNX 推理）+ 词法/向量 **RRF 混合检索** + 可选 **LLM 摘要索引**（"整理资料库"手动触发）。模型文件放 `<appPath>/resources/models/bge-small-zh-v1.5/`（transformers.js 兼容格式，local_files_only）；**模型/引擎不可用时自动降级为纯词法检索**，不阻塞其它功能。推理后端：本机 Windows System32 存在系统组件 `onnxruntime.dll`（Microsoft ONNX Runtime 1.17.1），其加载优先级高于应用目录，导致 onnxruntime-node 原生绑定无法完成 DLL 初始化；故以 `vendor/onnxruntime-node-stub`（`file:` 依赖，`module.exports = require('onnxruntime-web')`）替换 onnxruntime-node，统一走 **onnxruntime-web WASM 后端**。embed 采用动态 import 延迟加载，仅在首次推理时初始化。
- 检索范围约束（Phase 3.2 沿用）：向量/摘要索引与检索均严格限定在用户导入的资料（sourceIds 白名单）内，不引入外部信息。
- 工作区资料库（2026-08-06，Phase 2.2）：用户指定本地文件夹即资料库、双向实时同步（决策：全面替换导入转存机制）。文件系统 ↔ 数据库以 `content_hash`（sha256）+ `file_mtime/size` 为映射锚点（移动/重命名不丢 id/标签/摘要）；监听用 chokidar（Windows 原生 fs.watch 递归不可靠）+ 500ms 防抖 + 5 分钟兜底对账；反向同步：删除 → 系统回收站（`shell.trashItem`，可反悔）、改标题 → 重命名原文件（重名加后缀）；标签/摘要等元数据仅存应用数据库，工作区文件夹保持纯净；对账只做"文件系统 → 数据库"方向、不写文件系统，天然无自触发环路。内嵌文件服务改按资料 id 白名单化提供。
- 文档编辑器选型（2026-08-05）：**TipTap**（ProseMirror 所见即所得 + Markdown 序列化）；片段内容以 Markdown 文本存储（AI 生成 Markdown 片段、编辑器编辑/保存 Markdown），支持粗体/斜体/标题/下划线/表格/列表，保留逐片段来源标注。

## 路线图

1. Phase 1：项目基础（脚手架、共享契约、本地数据库）
2. Phase 2：资料收集闭环（文件导入 / 信源抓取 / 标签 / 范本）
3. Phase 3：撰写闭环（LLM 接入 / RAG 检索 / 初稿生成与来源标注 / 矛盾检测与取舍）
4. Phase 5：验收与打包（Windows 安装包、端到端演示、文档）

详细任务和验收标准位于 `PLAN.md`，本文件不重复记录任务级进度。

## 近期记录

- **2026-08-10（本次修改）**：Phase 3.7 Task 3.7.3/3.7.4/3.7.6 完成（正文矛盾标注 + 对比弹窗 + 来源文件打开；规划见 `PLAN.md`）——**编辑器标注**：新模块 `src/renderer/src/editor/contradiction-marker.ts`——自定义内联节点 `ContradictionMarker`（atom 不可编辑，attrs.seq，NodeView 渲染 ⚠️#N 芯片可点击，tiptap-markdown 经 `storage.markdown.serialize` 序列化回 `【矛盾#N】` 保证往返一致）+ `findContradictionMarkers`/`contradictionMarkerText` 纯函数 + `InvalidContradictionMarker` 扩展（decoration 把未关联矛盾记录的残留标记弱化高亮）+ `convertMarkerTextToNodes`（加载时仅把存在于矛盾清单的合法标记转节点，按位置从大到小应用避免偏移）。`DraftEditor.tsx`：注册扩展、onCreate 转节点（convertedRef 跳过首次保存）、工具栏新增"矛盾"按钮（显示待处理数）、props（contradictions/onContradictionClick/onOpenContradictions）。**对比弹窗**：新组件 `ContradictionDialog.tsx`（总览模式列出全部矛盾含状态、单条模式并列展示各说法 + 来源文件链接 + 正文定位 draftQuote + merged 提示；采纳某说法/忽略操作）。**IPC**：新增 `draft:getContradictions`（读某稿矛盾清单）、`draft:resolveContradiction`（adopt 须带属于该矛盾的说法 id、忽略清空采纳）、`sources:openPath`（工作区/存量导入路径解析 + `shell.openPath`，URL 走 `shell.openExternal`，文件缺失稳定错误），ipc.ts/preload/index.d.ts/main handler 同步。`WritingWorkspace.tsx`：加载任务时经 `getDraftContradictions` 初始化、生成/重生成用响应 contradictions、挂载弹窗（点击标注单条 / 工具栏总览）。i18n（draftEditor.toolbar.contradictions* + contradiction 区块）、main.css（标注芯片/残留高亮/弹窗样式）。`docs/shared-contracts.md` 同步 3 个新通道。验证通过：typecheck 零错误、118 项单测（新增标注纯函数 3 项）、生产构建成功。**说明**：3.7.3 的标注点击依赖弹窗才可用，故一并完成 3.7.4 与 3.7.6 的弹窗/IPC 部分；3.7.6 的"文段来源链接（对话消息 #N 渲染）"依赖 Task 3.7.5，留待其完成后接入。

- **2026-08-10（本次修改）**：Phase 3.7 Task 3.7.2 生成链路改造完成（矛盾预扫描 + 生成注入 + 定位审查，规划见 `PLAN.md`）——`src/main/writing/generate.ts`：① 新增 `buildSourceRefList`（按 chunks 首次出现顺序去重编号的来源清单，预扫描/生成/定位共用）；② 矛盾预扫描 `scanContradictions`（独立调用，kind=contradiction-scan，10 分钟超时，纯 JSON 契约 `{contradictions:[{topic,kind,variants:[{text,sourceRefs:[#N]}]}]}`，按事实主题分组、支持 3+ 来源、仅实质性冲突）+ 解析 `parseScanOutput` + 映射 `scanGroupsToInputs`（#N → sourceId，非法来源/说法不足分组丢弃）；③ 生成 system prompt 增加"材料矛盾提示"区块（`formatContradictionBlock` + `buildSystemPrompt(block?)`），明确指令：**严禁将矛盾说法自然合并/折中成材料中没有的表述，应分开并列表述或只取一种，并在正文插入 `【矛盾#N】` 标注**；④ 矛盾定位审查 `locateContradictions`（kind=contradiction-locate，独立调用，输出 `{items:[{seq,draftQuote,merged}]}`）+ `parseLocateOutput`，回填 `draft_quote`/`merged`；⑤ `generateDraft` 编排：检索后预扫描 → 生成（注入矛盾区块）→ 初稿落库 → `insertContradictions` 落库 → 定位审查回填 → 返回值与 IPC 响应新增 `contradictions`（`writing:generateDraft`/`draft:regenerate` 契约 + preload/index.d.ts 同步）；预扫描失败降级为"无矛盾清单"（notice 提示可重试）、定位失败降级为"矛盾保留但无正文定位"，均不阻断生成；幂等早退分支返回既有矛盾清单。`docs/shared-contracts.md` 同步生成契约与矛盾检测说明。验证通过：typecheck 零错误、115 项单测（新增 6 项：来源编号清单去重 / 扫描解析含 fenced 与非法分组丢弃 / #N 映射与 kind 回退 / 矛盾区块与"严禁合并"注入 / 定位解析）、生产构建成功。前端展示（标注/弹窗）留待 Task 3.7.3/3.7.4。

- **2026-08-10（本次修改）**：Phase 3.7 Task 3.7.1 矛盾检测数据模型完成（初稿生成时发现资料间矛盾，Phase 3.7 规划见 `PLAN.md`）——**Migration 009** 新增两张表：`draft_contradictions`（矛盾分组：`draft_id` FK 级联、`seq` 与生成提示词序号 #N / 正文标记 `【矛盾#N】` 对应并 UNIQUE(draft_id, seq)、`topic` 事实主题、`kind`[data/time/place/fact/other]、`status`[pending/adopted/ignored]、`merged` 定位审查"正文自然合并"兜底标记、`draft_quote` 正文定位原句、`adopted_variant_id` 被采纳说法）与 `contradiction_variants`（组内每条相左说法：`variant_text` ≤200 字、`source_ids` JSON 数组[≥1，支持同主题 3+ 来源]、`position`）。共享类型新增 `Contradiction`/`ContradictionVariant`/`ContradictionInput`/`ContradictionVariantInput`（读取时 `sourceTitles` 由仓储 JOIN sources 填充，来源已删回退为 sourceId）。新仓储 `src/main/db/contradictions.ts`：`insertContradictions`（事务批量写入并读回）、`getContradictionsByDraft`（按 seq 升序 + 来源标题）、`updateContradictionStatus`（adopted 必须校验说法归属、ignored 清空采纳、不存在返回 null）、`updateContradictionQuote`（回填 draft_quote + merged）。`docs/data-model.md` 增 2.15/2.16 两节。**设计说明**：`draft_quote` 放在矛盾分组层而非说法层——正文原句属于"该矛盾在正文中的位置"，由生成后定位审查按 seq 一次性回填（与 PLAN 文本列在 variants 表略有出入，语义一致）。验证通过：typecheck 零错误、109 项单测（新增 4 项：多来源说法读回含标题 / 采纳归属校验与忽略清空 / 定位回填与 merged / 级联删除）、生产构建成功。

- **2026-08-09（本次修改）**：修复"工作区加回大文件导致切回软件卡顿"（用户复现：资源管理器删文件→切回正常；加回文件→切回时明显卡顿、聚焦迟缓）。根因：`ingestFile` 同步 `await indexSource`，而向量嵌入是 onnxruntime-web **WASM 单线程同步推理**（`embed.ts` `numThreads=1`），大文件数百上千 chunk 会在**主进程事件循环**上累计阻塞数十秒~数分钟（期间窗口无法激活/聚焦/重绘）；PDF 解析本身也同步 CPU 密集。修复（A+B 方案，用户选定）：**A 快速缓解**——① `indexer.ts` 嵌入批次 20→5；② `reconcile.ts` 不再 `await indexSource`，新增 `indexer.enqueueIndex(sourceId)` **后台串行索引队列**（同资料去重，失败仅 console.error），文件解析入库后立即返回、列表秒出，向量后台补。**B 根治**——新增 `src/main/rag/embed.worker.ts`（worker_threads Worker，消息协议 init/embed→result/error），把 WASM 推理移出主线程；`embed.ts` 增加 Worker 客户端 `embedTexts` 优先走 Worker（120s 超时 + 崩溃/缺失文件时**自动回退主进程直接推理**，`stopEmbedWorker` 退出清理）；`electron.vite.config.ts` main 增 `embed.worker` 多入口（产出 `out/main/embed.worker.js`），`index.ts` will-quit 调 `stopEmbedWorker`。验证：typecheck 零错误、105 项单测（reconcile 套件因索引不再阻塞由 ~1000ms 降至 ~330ms）、生产构建产出 embed.worker.js、运行时 Worker 回路实测通过（2 向量×512 维）。**已知限制**：大 PDF 的解析（pdf-parse 同步 CPU）仍短暂占用主进程，未移出（用户未选 C 方案）；向量索引为后台异步，生成初稿前如索引未完成会自动降级为纯词法检索（既有兜底）。

- **2026-08-09（本次修改）**：修复"工作区伪实时同步"——DB 实时更新但资料列表不刷新。根因：`SourceList` 订阅 `workspace:progress` 完成事件时只清进度条、未重载列表；而 chokidar→`reconcilePaths` 其实 ~1 秒内已把增删改写入数据库。修复：① `reconcile.ts` 的 `ReconcileProgress` 扩展 `added/changed/removed/moved/errors/finished`，`reconcileWorkspace` 与 `reconcilePaths` 末尾经 `emitFinished` 发送带最终计数的完成事件（覆盖"只有删除/无变化时 total=0"的边界）；② preload `onWorkspaceProgress` 与 index.d.ts 类型同步扩展；③ `SourceList.tsx` 进度订阅收到完成事件后：有实际变更时自动 `loadSources`（用 `activeTagIdRef` 取最新标签筛选，避免订阅闭包过期）并显示"同步完成：新增/变更/删除…"提示；手动"同步工作区"由 `manualReconcilingRef` 标记，其完成刷新仍由按钮处理器负责，避免重复。新增单测 1 项（完成事件含计数，全量+增量）。验证通过：typecheck 零错误、105 项单测、生产构建成功。实际效果：工作区文件增删改后资料库列表约 1 秒内自动刷新。

- **2026-08-09（本次修改）**：界面 UI 布局调整三连（用户需求）——① **左栏功能区改图标导航**：`SideNav.tsx` 左侧五个功能区从纯文字改为「线性图标 + 图标下方 11px 浅色小字」的纵向排列（资料库=文件夹、撰写=铅笔、版本管理=时钟、范本=书本、设置=齿轮，stroke 风格 SVG）；选中态图标与文字同色高亮。② **撰写工作台左右两栏**：`WritingWorkspace.tsx` 的「对话框+对话历史」与「正文」由上下布局改为左右两栏（用户选定：**对话在左、正文在右**），CSS `.writing-workspace__body` 改 `flex-direction: row`，对话栏固定宽 380px 全高、正文编辑器占剩余宽度。③ **隐藏中栏（全局顶栏按钮）**：`TopBar.tsx` 右侧新增中栏显隐切换按钮（竖条+箭头图标，展开/收起两种状态）；`App.tsx` 新增 `centerVisible` 状态（localStorage `ui.centerVisible` 持久化，默认显示），隐藏时中栏与其中间的 ResizeHandle 一并收起；i18n 增 `topbar.hideCenter/showCenter`。验证通过：typecheck 零错误、生产构建成功。

- **2026-08-09（本次修改）**：Phase 3.6 预设大模型 + 获取 API key 指引完成。**共享数据层**：新建 `src/shared/llm-presets.ts`（`LlmPreset`：id/vendor/name/model/apiBase/pricing/signupUrl/guide；`LLM_PRESETS` 内置 DeepSeek v4 Flash / v4 Pro + 智谱 GLM-4-Flash 三条，每条 guide 为专属"注册→创建/复制 API Key→充值或免费→填入软件"教程步骤；`findLlmPreset`；文件头加 `/// <reference types="vitest/importMeta" />` 供 web 侧 typecheck）。**IPC**：新通道 `app:openExternal`（`{url}`，main 用 `shell.openExternal` + http/https 白名单校验），preload `openExternal` + index.d.ts 声明同步。**前端**：`PresetGuideDialog.tsx` 模态悬浮窗（预设名 + 免费/付费标签 + 分步教程列表 + 「打开注册页」跳 signupUrl + 关闭）；Settings 页 Provider 区上方新增「预设大模型」区块（卡片显示名称/模型名/API 地址/价格标签；「使用此模型」一键打开新建表单预填 name/apiBase/model；「获取 API key」弹教程悬浮窗）；zh-CN.ts 增 preset/presetGuide 文案；main.css 增预设区与悬浮窗样式。**验证**：`llm-presets.ts` 内联单测 3 项（结构校验/三条预设模型名/未知 id），typecheck 零错误、104 项单测、生产构建成功。PLAN.md Task 3.6.1~3.6.4 已标注完成。

- **2026-08-08（本次修改）**：新增"一键复制"功能——① 正文撰写编辑器（DraftEditor）工具栏新增「全文一键复制」按钮：取 TipTap `editor.getText()` 纯文本写入剪贴板，点击后按钮短暂显示"已复制"；② AI 对话界面（ChatPanel）每条 AI 回复气泡下方新增复制按钮（⧉，点击后短暂显示"已复制"）。实现：新建 `src/renderer/src/utils/clipboard.ts`（`copyPlainText`：navigator.clipboard 优先，失败回退 textarea + execCommand）；i18n 增 `copyAll`/`copied`/`copyReply`；CSS 增 `.chat-panel__assistant-block`/`.chat-panel__copy`/`.draft-editor__copy-label`。验证通过：typecheck 零错误、生产构建成功。

- **2026-08-08（本次修改）**：Phase 3.5 三连修（用户实测反馈）：① **对话历史持久化**——Migration 008 新增 `task_messages`（role: user/assistant，kind: chat/instruction/notice，任务删除级联）与 `llm_call_logs`（每次 LLM 调用痕迹：kind generate/chat/summarize/template/misc、model、输入/输出字符数、耗时 ms、状态/错误，**不存密钥与正文**）；新仓储 `db/task-messages.ts`（list/add + 2 项单测）；`chatCompletion` 增加可选 `meta` 参数并在调用方写入痕迹（generate/chat/summarize/template）；`generateDraft`/`chatWithTask` 由主进程统一写入消息（指令/生成结果/对话/失败提示），前端加载 `taskMessages:list` 回填并在每次生成/对话/重生成后重新加载（乐观追加 + 权威刷新，无重复）。② **"学前教育"任务生成耗时排查**（结论：非故障，材料量大所致——3 个巨型 PDF 全量相关段落提交给 Deepseek 导致约 5 分 44 秒；**用户决策：仅加阶段进度提示，不改材料供给**——新增 `IPC_EVENTS.DRAFT_GENERATE_PROGRESS` 推送事件，`generateDraft` 增加 `onProgress` 回调，生成过程对话框实时显示「整理资料摘要 → 检索资料 → 等待大模型回应（预计 1~5 分钟）」）。③ **对话超时修复**——`chatWithTask` 原用 `chatCompletion` 默认 60s 超时，对话携带初稿全文+历史、Deepseek 等模型响应较慢即超时；新增 `CHAT_TIMEOUT_MS=300000` 并传入。验证通过：typecheck 零错误、101 项单测、生产构建成功。契约文档已同步。**调查结论（"学前教育"任务）**：任务创建 14:03:19→初稿落库 14:09:03，耗时约 5 分 44 秒；资料库 13 篇全有摘要（生成前自动整理摘要环节本次未触发）；3 个巨型 PDF 正文 148 万/73 万/72 万字，Task 3.4.7 取消材料供给限制后相关段落全量提交给 Deepseek（deepseek-v4-flash），大模型处理海量材料+生成长文是耗时主因；此前无 LLM 调用日志，查不到精确请求/响应（现已可通过 llm_call_logs 诊断）。

- **2026-08-08（本次修改）**：Phase 3.5 撰写工作台交互重构为"聊天式界面"（用户确认：点击"新建任务"立即创建、中栏标题=「新建任务」+右键重命名、文章标题由大模型从要求中抓取并作为必需项返回[缺则详细报错]、生成前主按钮=「生成初稿」/生成后=「发送」、大模型选择持久化到任务、文件范围固定为工作区全部文件；先实现到生成初稿阶段）。**数据层**：Migration 007 给 `writing_tasks` 加 `llm_provider_id`/`article_title`/`user_instruction` 三列；`WritingScope` 增 `{all:true}`（旧任务具体 scope 兼容保留）。**仓储/IPC**：`createTask` 默认（标题"新建任务"、范围 all）、新增 `renameTask`/`updateTaskProvider`/`updateTaskArticleTitle`/`updateTaskInstruction`、`resolveScopeSourceIds` 支持 all；新通道 `writing:renameTask`/`writing:updateProvider`/`writing:chat`；`writing:generateDraft`/`draft:regenerate` 增加 `instruction`（必填），返回 `{ draft, articleTitle }`。**生成改造**：`generateDraft(taskId, instruction)` 保存 user_instruction、检索查询词改用 instruction、user prompt 按"你是一名资深志书撰稿专家……以下是用户的要求（应包含标题和可能的其他要求）"设计；输出契约为 JSON `{title,content,error}`（`parseGenerateOutput`：error 直接报错、title 更新 article_title、content 落库）；新增 `chatWithTask`（任务 provider + 注入当前初稿 ≤12000 字作上下文）。**前端**：右栏空状态（WritingEmptyState 插图+「新建任务」按钮立即创建）、WritingTaskList 右键新增「重命名」（新 PromptDialog）、删除 WritingCreateForm（表单废弃）、WritingWorkspace 重构为统一布局（上正文编辑器 + 下 ChatPanel 对话框，含范本/大模型下拉与 生成初稿/发送 按钮切换）、App 接入 taskCount 空态判断。验证通过：typecheck 零错误、99 项单测（新增任务默认值/重命名/provider/articleTitle/instruction/scope-all 6 项、parseGenerateOutput 4 项、提示词契约更新）、生产构建成功。契约文档已同步。

- **2026-08-08（本次修改）**：资料库支持 `.wps`（WPS 文字，公务员常用格式）。关键认知：`.wps` 无统一格式，需按**文件头签名**识别——① 现代 WPS Office 保存的 `.wps` 实为 OOXML(zip) 容器（`PK\x03\x04`），与 `.docx` 同构 → 复用 mammoth；② 兼容旧版保存的 `.wps` 为 OLE 复合文档（`D0 CF 11 E0`），与 `.doc` 同构 → 复用 word-extractor；③ 老版 WPS 私有二进制格式无公开文档，纯 JS 无法解析 → 抛 `PARSE_UNSUPPORTED`（提示"仅支持由 WPS Office 保存的 .wps 文档"）。改动：① `file-parser.ts` 的 `SUPPORTED_EXTS` 增加 `.wps`、`ParseResult.format` 增加 `'wps'`，抽取公共 `extractDocxText`/`extractOleText` 供 parseDocx/parseDoc/parseWps 复用，新增 `parseWps`（签名检测分发）；② `index.ts` 手动导入对话框 filters 增加 `wps`；③ `SourceViewer.tsx` 类型徽标新增 "WPS"。新增内联单测 2 项（jszip 构造最小 OOXML zip 写入 .wps 全链路解析断言正文；伪造私有二进制头断言 PARSE_UNSUPPORTED）。验证通过：typecheck 零错误、92 项单测、生产构建成功。未引入新依赖（复用 mammoth/word-extractor/jszip）。

- **2026-08-08（本次修改）**：资料库支持 `.xls` / `.xlsx`（Excel，用户确认：仅支持这两类旧版/新版 Excel，`.ppt`/`.pptx` 暂不支持）。依赖：`xlsx@0.20.3`（SheetJS，**从官方 CDN 安装修复版**——npm 仓库仅 0.18.5，含已知高危 CVE；0.20.3 无漏洞，npm audit 的 2 个高危来自存量 tesseract.js 的 sharp 依赖）。改动：① `file-parser.ts` 的 `SUPPORTED_EXTS` 增加 `.xls`/`.xlsx`、`ParseResult.format` 增加 `'xls'|'xlsx'`、新增 `parseXls`（SheetJS `XLSX.read(buffer)` 统一解析新旧格式，按用户选定方案**逐单元格展开**——输出 `【工作表：{名}】` + `第r行第c列：{值}`，带行列标记信息不丢失，跳过空单元格，取值优先 `cell.w` 格式化文本）；② `index.ts` 手动导入对话框 filters 增加 `xls`/`xlsx`；③ `SourceViewer.tsx` 类型徽标新增 "Excel"。新增内联单测 2 项（xlsx/xls 各一：用 SheetJS 生成真实文件 → `parseFile` 全链路解析 → 断言工作表标记与行列标记）。验证通过：typecheck 零错误、90 项单测、生产构建成功；运行时确认动态 import 互操作与 xls/xlsx 双格式读写回路正常。`.ppt`/`.pptx` 因志书场景少见且旧版 `.ppt` 纯 Node 解析库不成熟，暂不支持（已与用户确认）。

- **2026-08-08（本次修改）**：资料库支持 `.doc`（旧版 Word 二进制格式）——用户反馈工作区无法同步 `.doc` 后缀文件。根因：`file-parser.ts` 的 `SUPPORTED_EXTS` 只含 `.docx`，`.doc` 在扫描器 `isSupported` 处被过滤、手动导入对话框也不列该后缀。修复：① 新增依赖 `word-extractor`（纯 JS 无原生依赖，解析 OLE 二进制 .doc）+ `@types/word-extractor`；② `file-parser.ts` 的 `SUPPORTED_EXTS` 增加 `.doc`、`ParseResult.format` 增加 `'doc'`、新增 `parseDoc`（Buffer 输入，动态 import 经 `.default` 取类，`extract(buffer).getBody()`）；③ `index.ts` 手动导入对话框 filters 增加 `doc`；④ `SourceViewer.tsx` 类型徽标把 `.doc` 也标为 "Word"（查看器走纯文本分支展示 `cleanedText`，无需 HTML 渲染）。验证通过：typecheck 零错误、88 项单测、生产构建成功；运行时确认 word-extractor 在 Node/Electron 下 CJS 动态 import 正常、Buffer 输入 + getBody() 链路可用（本机无 Word，未做真实 .doc 端到端，建议用户实测）。

- **2026-08-08（本次修改）**：修复说明气泡被右栏遮挡——用户反馈点击 ⓘ 子按钮弹出的说明气泡有时被右栏盖住。根因：气泡原是 `.source-list__tool-btn` 的 `absolute` 子元素（z-index 120），位于中栏 `.center-pane`（`overflow-y: auto`）内，受滚动容器/层叠上下文影响被右栏盖住。修复：① `SourceList.tsx` 引入 `createPortal`，气泡改为渲染到 `document.body` 顶层，`info` 状态改存触发按钮的屏幕坐标（`getBoundingClientRect()` 记录 left/bottom），Portal 节点用 `fixed` 定位在按钮下方；② `main.css` 的 `.source-list__info-popover` 改为 `position: fixed; z-index: 9999`（悬浮在软件窗口最上方，不再受中栏滚动容器约束）；③ 关闭逻辑扩展：点击外部 / Esc / 窗口滚动（捕获阶段，覆盖内部滚动容器）/ 窗口 resize 均自动关闭。验证通过：typecheck 零错误、生产构建成功。待用户实测确认。

- **2026-08-07（本次修改）**：资料库工具栏按钮优化——① 按钮文字不再换行：`.source-list__toolbar` 加 `flex-wrap: wrap`、`.source-list__btn` 加 `white-space: nowrap` + `flex-shrink: 0`（中栏宽度不足时**按钮整体换行**，而非按钮内文字折行）；② 三个按钮（导入文件/整理资料库/同步工作区）各加一个"圆圈 i"信息子按钮（`.source-list__info-tip`），点击弹出该按钮的详细说明（`.source-list__info-popover`，点击外部/Esc 关闭，按钮内 `onMouseDown stopPropagation` 避免误关），说明文案初稿在 `zh-CN.ts sourceList.infoImport/infoSummarize/infoReconcile`（用户后续可再调整）。验证通过：typecheck 零错误、生产构建成功。

- **2026-08-07（本次修改）**：Task 3.4.9 生成初稿前自动整理任务范围资料摘要（用户选择：触发时机=生成初稿时；"整理资料库"按钮保留）。实现：`summarizer.ts` 新增 `pendingSummarySourceIds(sourceIds)`（幂等：只返回范围内尚无摘要的资料 id，已整理的不重复）+ `summarizePendingForSourceIds(sourceIds)`（逐篇 LLM 补齐）；`generateDraft` 在摘要级粗筛前 `await summarizePendingForSourceIds(scopeIds).catch(() => undefined)`——失败不阻断生成（无摘要时粗筛保守保留）；前端 `generating`/`regenerating` 文案更新为"正在整理资料摘要并生成初稿…"。验证通过：typecheck 零错误、88 项单测（新增 pendingSummarySourceIds 幂等 1 项）、生产构建成功。

- **2026-08-07（本次修改）**：资料库界面清理——① 删除"刷新"按钮（功能仅是 `loadSources` 重新加载列表，与"同步工作区"及自动同步[聚焦/进资料库/每分钟]重叠，同步完成自动重载、增删操作也刷新）；② "标签管理"从工具栏移入"全部资料"右侧三点菜单，与"资料管理"并列（`App.tsx` 菜单加 `sourceMenu.tagManage` 项，`SourceList` 删除 `onTagManage` prop 与按钮）；③ "整理资料库"保留（对无摘要资料调用 LLM 生成 `source_summaries`，供摘要粗筛使用，独立功能不重叠）。验证通过：typecheck 零错误、生产构建成功。

- **2026-08-07（本次修改）**：同步触发逻辑去重清理——合并了两套重复的"互斥 + 排队补跑"实现：watcher.ts 自有的 `runTask`/`rerunQueued`/`reconciling`（Task 2.2.4 引入）与 auto-sync.ts 的 `busy`/`queued`（Task 2.2.5 引入）功能完全重复。清理：auto-sync.ts 泛化出通用调度器 `runWorkspaceSync(task)`（全量对账与 watcher 增量对账共用互斥排队），`requestWorkspaceSync` 变为便捷封装；watcher.ts 删除 `runTask`/`rerunQueued`/`reconciling`，增量对账改走 `runWorkspaceSync`，对应排队测试迁移到 auto-sync（watcher 测试 2→1、auto-sync 测试 2→3）。保留项：chokidar 实时增量、手动按钮、聚焦/进资料库/每分钟定时、启动对账、分批嵌入。验证通过：typecheck 零错误、87 项单测、生产构建成功。

- **2026-08-07（本次修改）**：Task 2.2.5 自动同步触发源 + 新文件预处理提示（用户方案：①窗口聚焦自动同步 ②进资料库自动同步 ③每分钟自动同步 ④识别到文件添加即刻显示预处理进度+卡顿提示；效果均等同手动"同步工作区"）。实现：新模块 `src/main/workspace/auto-sync.ts`（`requestWorkspaceSync` 全量对账 + busy/queued 互斥排队、`startAutoSyncTimer` 每分钟定时取代 watcher 心跳、`isWorkspaceSyncBusy`）；`index.ts` `win.on('focus')` 聚焦触发 + 启动对账并入调度器 + 新 IPC `workspace:navSync` + `App.tsx` 进入资料库页触发；`ReconcileProgress` 增加 `newFiles`（reconcileWorkspace/reconcilePaths 进度回调携带），watcher 增量对账接入进度（`startWorkspaceWatcher(progress)`），`SourceList` 收到 `newFiles>0` 且未完成时显示黄色提示条"正在预处理新添加的文件…可能存在短暂卡顿" + 进度条。关键决策：**放弃完全依赖 chokidar 实时事件，用确定性全量对账（mtime/size 快筛、开销低）在用户交互关键点兜底**，确保增删最终自动收敛。验证通过：typecheck 零错误、87 项单测（新增 auto-sync 2 项）、生产构建成功。

- **2026-08-07（本次修改）**：Task 2.2.4 补充修复（用户实测：① 删工作区文件后条目仍在、需手动点"同步工作区"才消失；② 加回文件后软件卡顿/卡死，重启才正常）。**问题①根因**：`watcher.ts` 的 `runTask` 在 `reconciling` 时直接 return，`flushPendingPaths` 未执行、路径滞留 `pendingPaths` 且后续无新事件时永不处理——启动/心跳全量对账（含大文件解析+索引可达数十秒）期间 unlink/add 事件被静默丢弃（全量对账删除逻辑本身正常，故手动同步才生效）。修复：`runTask` 被拒时置 `rerunQueued`，当前任务结束后**补跑同一个任务**（事件不丢）。**问题②根因**：`reconcilePaths → ingestFile → await indexSource` 把整个文件全部 chunk 一次性喂 WASM 嵌入推理（大 PDF 数百 chunk），推理同步计算占满主进程事件循环 → UI 卡死（重启后是后台 `void reconcileWorkspace` + 模型已加载故不卡）。修复：`indexer.ts` 分批嵌入（每批 20 个，批间 `setImmediate` 让出）。**兜底**：心跳全量对账 5 分钟 → 1 分钟（chokidar 在 Windows 漏 unlink 时也自动收敛）。单测新增 runTask 排队补跑 1 项。验证通过：typecheck 零错误、85 项单测、生产构建成功。

- **2026-08-07（本次修改）**：Task 2.2.4 工作区删除实时同步到资料库（用户三点要求：① 实时自动同步、② 工作区删文件 → 资料库直接删除（连同标签等所有绑定信息）、③ 新增自动入库为"白板"文件）。根因：原 `reconcile.ts` 设计为"消失：仅统计，不删库"（删除语义交软件侧回收站处理），工作区删文件后库记录一直在，无论实时还是手动"同步工作区"都不生效。修改：`reconcileWorkspace` 与 `reconcilePaths` 对"文件系统消失且库中有记录"的资料直接 `deleteSources`（外键级联清标签绑定/向量/摘要）；`reconcilePaths` 重构为两阶段（先处理仍存在文件含移动识别，再处理消失文件）+ **重命名保护**（同内容哈希仍被其它路径占用 → 视为 rename/move 不删库，保留 id/标签）；watcher 本已启动（500ms 防抖增量 + 5 分钟心跳兜底全量），新增/修改/删除均自动同步，无需手动按钮；新增文件 `insertSource` 本就不绑标签（白板）。测试更新：reconcile 删除语义 3 项（删除级联 / 增量删除 / 增量 rename 不误删）+ moved 不误删断言 + watcher 实时删库断言。验证通过：typecheck 零错误、84 项单测、生产构建成功。

- **2026-08-07（本次修改）**：Task 3.4.8 初稿生成放宽 LLM 超时——根因：`chatCompletion` 默认超时 60s，`generateDraft` 未传自定义超时，3.4.7 取消材料限制后材料 6.3 万字、模型生成完整小节正文需数分钟，60s 必被 AbortController 掐断（报 `LLM_TIMEOUT`）。修复：`generate.ts` 新增 `DRAFT_GENERATE_TIMEOUT_MS = 600000`（10 分钟）并在 `generateDraft` 调用时传入；前端 `generating`/`regenerating` 文案由"可能需要数十秒"改为"资料较多时可能需要数分钟，请耐心等待"。验证通过：typecheck 零错误、单测通过。

- **2026-08-07（本次修改）**：Task 3.4.7 取消材料供给限制、检索改为"过滤确定无关段落"（用户定三层方案：第一层摘要粗筛不动；第二层从"Top-N 选最相关"改为"只剔除非常确定无关的段落"；第三层 limit=12/每源Top3/800字截断**完全取消**）。改动：`retrieval.ts` 的 `retrieveChunks` 重构为过滤式——词法 `scoreChunk > 0`（与标题有任何字面/字符对关联）或 向量余弦 ≥ `vecMinScore`（默认 0.3）的段落全部保留，标题行剔除，按来源→原文顺序组织（向量补充块追加在后）；删除 `MAX_PER_SOURCE`/`MIN_SCORE`/`poolTop`/RRF/limit；`vector-store.ts` 的 `vectorSearch` 支持 `limit=0` 全量返回；`generate.ts` 的 `retrieveChunksHybrid` 去 limit、`buildUserPrompt` 去 800 字截断（材料全量提交，篇幅由有效内容决定）。真实"教育"任务重现验证：材料供给从 12块≈6000字 → **610块≈6.3万字**。已知风险：材料量可能超模型上下文/超时（60s），用户约定后期再调。验证通过：typecheck 零错误、82 项单测（retrieval 过滤式语义重写 + 新增全量保留/向量阈值过滤 2 项）、生产构建成功。

- **2026-08-07（本次修改）**：Task 3.4.6 范本提取前剔除目录页（用户确认方案，要求"人物传、大事记等特殊模块不算正文"）——`src/main/import/template-style.ts`：① 新增 `isTocLikeLine(line)` 目录页行判定（页码标记 "-- 3 of 877 --"/"3/877"/"第 3 页"、"目 录"标题、标题+括号页码"第一节 机构队伍(104)"可后跟任意省略号、标题+点线+页码"政 区 (28) ……………… 29"；以句末标点结尾或括号页码后接中文语流的正文行不误伤）；② `extractNormalSections` 逐行先剔目录行再 `detectHeading`——目录条目不再产生"假小节"（此前"机构队伍""境内其他方言""人物传"三小节全来自目录页、正文节选无对应内容 → example 全"暂缺"）；③ `buildLlmInput` 降级路径同步过滤目录行；④ `SPECIAL_MODULE_RE` 补"人物传"（`人物传记` 匹配不到"人物传"）；⑤ system prompt 明确"已剔除目录页并排除概要/大事记/人物传记/人物传/人物志/附录/索引等特殊模块，example 必须摘录自所提供正文"。调试记录：括号页码正则最初 `(?:…|\.{3,}|……)?` 只能匹配 1~2 个省略号，6 个省略号的"概 述 (1) ……………"匹配失败 → 改为 `[….]*`。验证通过：typecheck 零错误、80 项单测（新增 3 项）、生产构建成功。存量范本需在范本管理页点"重新提取"（`templates:reanalyze`）后新逻辑生效。

- **2026-08-07（本次修改）**：Task 3.4.5 撰写工作台新增"重新生成初稿"（用户定夺第 1 项遗留）——初稿已存在时工具栏"生成初稿"切换为"重新生成初稿"（danger 样式），点击弹 `ConfirmDialog` 二次确认（提示将丢弃当前第 0 稿含用户修改），确认后带 generating 状态重跑并刷新整稿。链路：`db/drafts.ts` 新增 `deleteDraftByVersion`（segments/segment_sources 外键级联清理，不存在返回 false）→ `generate.ts` 新增 `regenerateDraft`（删第 0 稿后复用 generateDraft）→ 新 IPC `draft:regenerate` + preload `regenerateDraft` → `WritingWorkspace.tsx` 按钮/对话框 → `zh-CN.ts` 文案 → `docs/shared-contracts.md`（并顺带修正 `writing:generateDraft` 过时描述"结构化片段+来源"为"整篇连贯 Markdown 正文"）。范本仍锁定不可更换。验证通过：typecheck 零错误、77 项单测（新增 deleteDraftByVersion 级联 1 项）、生产构建成功。

- **2026-08-07（本次修改）**：Task 3.4.4 修复"初稿只有寥寥几行字"（实查本地库定位 + 修复，未改 UI）。诊断过程：用户操作痕迹全部在本地 SQLite（`userData/xie-zhishu.db`，WAL 被运行中的应用占用 → 复制 db+wal+shm 到临时目录查询）；查到任务"教育"初稿仅 75 字（单段无标题，3.4.3 落库格式），范本关联长乐志模板且 `style_profile_json` 注入 1436 字。用临时脚本重现提交给大模型的 system+user prompt，发现**检索到的 12 块"材料"全是标题行**（"教育""学前教育""义务教育"，2~4 字），正文段落被完全挤出——根因：词法打分 `t.includes(q) → +102` 且短标题行 bigram 重叠率满分（得分 162~202 vs 正文 110~152），`poolTop` 配额全被标题占满，模型无史实可用只能写泛泛套话；范本上下文虽已注入但无米下锅。修复 `src/main/rag/retrieval.ts`：新增导出 `isTitleLikeLine`（≤12 字短语 / ≤20 字含空格标题词组判为标题行；带句末标点或含数字的行保留），`chunkText` 分块时跳过，`retrieveChunks` RRF 融合时兜底剔除向量路历史残留标题块（无需重索引）。真实数据重现验证：候选块 998→610，Top12 由"全是标题"变为正文段落（如"【学校安全管理】2022年……3个100%目标……"）。已知遗留：范本 LLM 提取的三个示例小节"原文文段示例"因目录页与正文节选对不上而"暂缺"（范本示范价值打折，非本次初稿短的主因，后续可改进范本提取）；生成初稿按钮在初稿已存在时禁用且无"重新生成"入口（验证新逻辑需新建任务）。验证通过：typecheck 零错误、7 项（retrieval 新增 2 项）、生产构建成功。

- **2026-08-07（本次修改）**：Task 3.4.3 初稿输出形态重构为"整篇连贯正文"（用户纠正两点：志书每个小节就是一篇连贯的文章，不应强求"若干带小标题的 JSON 片段"；"加篇幅要求"不可行，篇幅由材料中实际有多少有效、有关联的内容自然决定）。改动集中在 `src/main/writing/generate.ts`：**① system prompt 删除 `{"segments":[...]}` JSON 输出契约与"每片段标注 sourceId/position"要求**，改为"撰写一个完整小节的正文，必须是一篇连贯成文的文章；直接输出 Markdown 正文，不输出 JSON/说明性文字/代码块；可自行使用小标题组织内部层次；**篇幅由材料有效内容自然决定，不注水、不重复、不硬凑篇幅，也不刻意省略重要内容**"；**② user prompt 删除"按片段组织并标注来源"指令**，改为"参照范本行文逻辑与风格，依据材料撰写连贯志书正文，篇幅以材料实际有效内容为准"；**③ 落库去掉 `parseJson`/`normalizeSegments` 与 JSON 校验重试循环**，模型输出（剥去代码块围栏）整篇存为单个片段（无 heading），由 3.4.1 连续编辑器整稿渲染/保存，空输出报 `LLM_FORMAT_INVALID`；**④ 材料供给放大**：单块注入上限 300→800 字（检索块本身 ≤500 字，保证有效内容完整供给、不因截断变短）。单测同步：删除旧 JSON 解析 4 项，新增"连贯正文 + 篇幅内容自决"提示词断言 2 项。验证通过：typecheck 零错误、14 项（generate+drafts 相关）、生产构建成功。

- **2026-08-07（本次修改）**：Phase 3.4 两项（用户提需求后开发，规划见 PLAN.md）——**① Task 3.4.1 初稿连续显示为整体**：初稿编辑器从"逐片段独立编辑框 + 逐段来源折叠卡片"重构为**单个连续 TipTap 编辑器**（`DraftEditor.tsx` 重写，`segmentsToMarkdown` 把片段 heading+content 拼为连续 Markdown 渲染；去掉每段来源展示）；新增 `draft:updateContent` IPC + `db/drafts.ts` 的 `splitMarkdownIntoSegments`（按 `#` 标题切分，纯函数）+ `replaceDraftSegments`（删旧插新，新片段无来源关联；`segment:update` 保留不删）；编辑防抖 800ms 整稿自动保存。**② Task 3.4.2 生成接入资料摘要粗筛**："理解资料后再检索"——`generate.ts` 新增 `filterSourcesBySummary`（读 `source_summaries` 批量摘要，`summaryRelevance` 用主题词/实体命中 + bigram 相似度打分，只保留相关资料再进入 chunk 精检；任务范围内无任何摘要时返回 null 不过滤、无摘要资料保守保留不排除）；`retrieveChunksHybrid` 接入粗筛，检索预览（writing:retrieve）同步受益；`retrieval.ts` 导出 `bigrams/dice`、`summarizer.ts` 新增 `getSourceSummariesByIds`。范本参照保持（exampleSections 注入）。验证通过：typecheck 零错误、76 项单测（新增整稿切分/重建 4 项 + 摘要粗筛 3 项）、生产构建成功。

- **2026-08-07（本次修改）**：范本理解模式再次重构（用户明确原意）——**① 删除篇目结构提取**：撰写任务只针对志书中一个小节正文，不再需要大纲，`template-parser.ts` 删除 `OutlineItem`/`parseFromText`（篇目树）、`ParsedTemplate.outline`，`detectHeading` 保留为"正常小节"切分工具；`outline_json` 列弃用（写空数组占位），范本管理 UI 删除篇目结构展示与 `OutlineTree`，生成初稿提示词不再注入篇目层级。**② 每个范本提取三个正常小节示例 + 总体总结**：`template-style.ts` 的 `buildLlmInput` 不再发送大纲（只发若干完整正常小节正文节选，每节 ≤5000 字、总量 ≤30000 字），system prompt 要求大模型输出 `{"summary": "三个小节共有的行文逻辑与风格标准总述", "sections": [3 个，每个含 title / structureSummary / styleGuidelines / example（原文摘录不改写）]}`，存入 `style_profile_json.exampleSections`（`mergeLlmIntoProfile`/`parseLlmStyleOutput` 相应更新）；`extractTemplateStyleWithLlm`/`insertTemplate`/`updateTemplateStyle` 全部去掉 outline 参数；`generate.ts formatTemplateContext` 单参数化并注入 exampleSections（总体总结 + 三个小节的结构/风格/原文示例，旧结构兼容）。验证通过：typecheck 零错误、69 项单测、生产构建成功。

- **2026-08-07（本次修改）**：范本理解模式重构为"提取一个小节的行文范例"（用户明确原意）——此前方案是提取"每个小节结构+多个范例段"，偏离用户意图。新模式：**将范本（标题大纲 + 若干完整"正常小节"正文节选）与提示词一起发送给大模型**，提取**一个正常小节**的行文范例并存入 `exampleSection`（`title` 小节标题 + `structureSummary` 行文逻辑与结构总结 + `styleGuidelines` 每一段每句话的行文风格标准 + `example` 原文文段示例[直接摘录不改写]）。要点：① `template-style.ts` 的 `extractNormalSections` 用多策略 `detectHeading` 切分小节并**排除特殊/功能性模块**（概要/大事记/人物传记/人物志/附录/索引/凡例/序言/前言/后记/编后记/编纂说明/出版说明/图版/目录）；② LLM 输入每节正文 ≤5000 字、总量 ≤30000 字（模型上下文限制，志书可达上百万字必须截断），无正常小节时降级为全文正文节选；③ system prompt 按用户原意修缮（含"科技项目与成果/公共场所卫生"式正常小节、排除特殊模块、example 直接摘录原文）；④ `generate.ts formatTemplateContext` 注入 exampleSection（旧 structureSummary/sectionStyles/samples 结构兼容保留）；⑤ 前端范本详情展示"行文范例小节（标题/结构总结/风格标准/原文示例）"。验证通过：typecheck 零错误、71 项单测（template-style 重构 6 项 + generate exampleSection 1 项）、生产构建成功。

- **2026-08-07（本次修改）**：修复"排版型 PDF 范本识别不到标题层级、LLM 回复未提供材料"——根因：标题识别仅支持 Markdown `#` 语法，而志书排版 PDF 提取的纯文本无 `#` 标记（outline 为空 → LLM 收到的"标题大纲 + 各节开篇样本"全空）。修复：① `template-parser.ts` 新增导出 `detectHeading` **多策略标题识别**——Markdown（#）、志书主流编号（第X篇/卷/章/节，映射 level 1/1/2/3）、括号/顿号/阿拉伯序号（level 3）、**短行兜底**（≤20 字、不以句末标点结尾、不含逗号的独立短行判为标题，适配排版 PDF）；`extractHeadings`/`parseFromText`/`splitParagraphs` 全部切换。② `template-style.ts` 的 `extractSections` 改用 `detectHeading`；`buildLlmInput` 无标题时**降级为正文节选**（2 万字内），system prompt 补充"structureSummary 与 samples 必填、未提供分节标题时 sectionStyles 可为空数组"。③ 新增 `templates:reanalyze` IPC + `updateTemplateStyle` 仓储：对**已有范本**重新解析 + LLM 提取并更新 outline/styleProfile（识别改进后无需删除重导），范本详情页新增"重新提取"按钮，进度复用 `templates:importProgress`。验证通过：typecheck 零错误、70 项单测（新增 detectHeading 多策略、编号标题 outline、无标题兜底等 3 项）、生产构建成功。

- **2026-08-07（本次修改）**：范本行文范例提取升级为大模型增强（本地启发式质量不佳）——新模块 `src/main/import/template-style.ts`：导入范本时本地统计兜底 + 调用 LLM 提取行文范例，发送"标题大纲 + 各节开篇样本"（正文超限按节裁剪、上限 2 万字，`extractSections` 逐节取开篇段落），LLM 输出 JSON 三要素：**整体体例结构总述（structureSummary）**、**每个小节的行文结构与格式（sectionStyles，如"先述沿革后述现状、段落按时代衔接"）**、**代表性范例段落（samples，完整保留不截断）**；`parseLlmStyleOutput` 容错解析 + `mergeLlmIntoProfile` 合并进本地 StyleProfile（`llm=true` + `llmModel`）；调用超时放宽 120s，未配置 Provider / 失败 / 输出不合规时自动降级为本地结果、不阻塞导入。`StyleProfile`/`ParsedTemplate` 类型扩展（`ParsedTemplate` 增 `text` 供 LLM 输入）；`TEMPLATES_IMPORT` 新增 llm 阶段进度事件（`etaSeconds` 按正文量估算 15-90 秒）；前端进度提示 llm 阶段显示"正在等待大模型回应……预计 X 秒"，范本管理页体例特征展示新增"整体体例"与"各小节行文结构与格式"（大模型提取标记）；`generate.ts formatTemplateContext` 注入整体体例 + 分节行文结构 + 范例（旧格式兼容）；`docs/data-model.md`、`PLAN.md` 决策同步。验证通过：typecheck 零错误、67 项单测（新增 template-style 5 项 + generate LLM 结构 1 项）、生产构建成功。

- **2026-08-07（本次修改）**：修复"导入较大 PDF 范本无反应"+ 新增导入进度反馈——根因：`template-parser.ts` 用 `readFileSync` 同步读取大 PDF + `TEMPLATES_IMPORT` handler 用 `copyFileSync` 同步复制，同步 IO 阻塞主进程事件循环（与资料导入性能优化同类问题，范本链路漏网），前端又无任何反馈导致"点击没反应"。修复：① 范本解析全异步化（`readFile` fs/promises，PDF 分支改传 `new Uint8Array(raw)` 与 `file-parser.ts` 一致）；② 导入复制改异步 `copyFile`；③ 新增 `templates:importProgress` 阶段进度事件（start 5% → copy 15% → parse 30% → save 90% → done/error 100%），preload 暴露 `onTemplateImportProgress` 订阅；④ 范本管理页导入按钮 busy + 进度条 UI（解析阶段提示"正在解析范本内容（文件较大，可能需要一段时间）"）。性能实测（临时 vitest 脚本，已验证后删除）：8.9MB 文件解析 22ms、事件循环心跳间隔 0ms（异步化后无阻塞）。验证通过：typecheck 零错误、61 项单测（新增 parseTemplate 端到端 1 项）、生产构建成功。

- **2026-08-07（本次修改）**：Phase 3.3 Task 3.3.3 生成初稿注入范本上下文 + 范本删除二次确认——`writing/generate.ts` 新增 `formatTemplateContext`（纯函数，测试覆盖）：将范本上下文组装为三块——篇目层级 + 体例特征统计（字数/段数/平均段长/层级/各级标题数量/标题样式）+ 代表性范例片段，并以"仅作体例与行文风格参考，其内容不得作为史料引用"明确标注边界；`buildSystemPrompt` 新增"严禁将范本史实当作当前任务史料引用，史实只能来自 materials"的硬约束；`buildUserPrompt` 中 materials 区块标注"史料只能来源于此"，与范本区块严格区分；范本缺失/解析失败降级为"（未提供范本）"。`TemplateManager` 删除范本改用 `ConfirmDialog` 二次确认（提示"删除后引用该范本的撰写任务将自动失去范本关联（不影响已生成初稿）"）。文档同步：`docs/ui-architecture.md`（P1.4 体例特征摘要与删除确认、P2.2 参考范本选择器）。验证通过：typecheck 零错误、60 项单测（新增 formatTemplateContext 3 项）、生产构建成功。Phase 3.3 全部完成，下一步可进入 Phase 4（版本迭代与管控）。

- **2026-08-07（本次修改）**：Phase 3.3 Task 3.3.2 撰写工作台范本选择与更换——新增 `writing:updateTemplate` IPC（`{ taskId, templateBookId }`，`templateBookId: null` = 不使用范本，校验范本存在，任务不存在返回 `TASK_NOT_FOUND`）；`db/tasks.ts` 新增 `updateTaskTemplate` 仓储（更新 `template_book_id` + `updated_at`）；preload 暴露 `updateTaskTemplate`；`WritingWorkspace.tsx` 工具栏新增"参考范本"下拉（未生成初稿时可任意选择/更换、创建任务时已选范本默认展示；**初稿已生成后 select 禁用**并提示"初稿已生成，范本已锁定"——生成后锁定策略，避免换范本重生成覆盖已编辑初稿）；i18n 文案 + CSS 样式；`docs/shared-contracts.md` 同步通道清单。验证通过：typecheck 零错误、57 项单测（新增 updateTaskTemplate 1 项）、生产构建成功。

- **2026-08-07（本次修改）**：Phase 3.3 Task 3.3.1 范本体例特征轻量预处理——`src/main/import/template-parser.ts` 新增 `StyleProfile` 接口与 `extractStyleProfile`（纯本地统计：全文字数 / 段落数 / 平均段长 / 篇目最大层级 / 各级标题数量 / 标题样式识别[第X篇·章·节编号、阿拉伯数字编号、括号编号、无编号] + 代表性范例片段[优先取"概述/总述"类节正文，每段截断 200 字、最多 3 段]），`parseTemplate` 返回值扩展为 `{ outline, styleProfile }`；`insertTemplate` 写入建表时预留的 `style_profile_json` 列，`TEMPLATES_IMPORT` handler 接入；范本管理界面展示体例特征摘要（统计 + 可折叠行文范例）。设计决策：范本是"体例与行文参考"而非"史料来源"，故**不做 RAG 向量化 / LLM 摘要**（避免成例中的史实被模型当作当前任务史料引用、违反"严禁编造"底线），仅本地毫秒级提取；存量范本 `style_profile_json` 为空时自动降级（生成初稿仅发篇目层级）。验证通过：typecheck 零错误、56 项单测（新增 5 项）、生产构建成功。

- **2026-08-06（本次修改）**：窗口与布局状态持久化——主进程新增 `src/main/window-state.ts`（userData/window-state.json 保存窗口 bounds/最大化/全屏；resize/move/maximize/fullscreen 事件防抖保存 + close 时立即保存；最大化/全屏存 `getNormalBounds` 正常边界，恢复时先按边界创建、再 show 后置最大/全屏，避免闪烁错位；`isValidBounds` 校验边界与显示器工作区相交，多显示器变动后窗口不会落在屏幕外）。渲染层三栏宽度（左导航 `ui.sidebarWidth` / 中栏 `ui.centerWidth`）用 localStorage 持久化，App.tsx 启动读取、变更即写回。验证通过：typecheck 零错误、51 项单测、生产构建成功。

- **2026-08-06（本次修改）**：工作区批量录入卡死与增量慢的性能优化——根因：扫描（`readdirSync` 递归 + 全文件读算 sha256）、解析（`readFileSync`）、批量导入（同步 copy）均为**同步 IO 阻塞主进程事件循环**，大文件量下 UI 卡死；且 watcher 每次文件变更触发**全量对账**（改 1 个文件也重扫全库）。优化四层：① 扫描/指纹/解析全改 `fs/promises` 异步 + 按批 `setImmediate` 让出事件循环（`scanner.ts` 的 `scanWorkspaceAsync`、`fingerprint.ts` 的 `*Async`、`file-parser.ts` 异步读、`import/index.ts` 异步 copy + 分片）；② **watcher 增量处理**：chokidar 事件自带路径，防抖后只对变更文件调 `reconcilePaths`（`reconcile.ts` 新增），改动单个文件为秒级；全量 `reconcileWorkspace` 仅用于启动/手动/心跳兜底；③ 变更判定 mtime/size 快筛（不读内容），仅变化文件算内容哈希；④ 进度上报：`workspace:progress` IPC 推送 `{done,total}`，资料库页显示同步进度条。性能实测（`scripts/perf-check.ts`）：300 个文件全量对账 0.6s、增量修改 1 个文件 3ms、事件循环最大心跳间隔 101ms（UI 保持响应）。验证通过：typecheck 零错误、51 项单测（新增 reconcilePaths 1 项）、生产构建成功。

- **2026-08-06（本次修改）**：Phase 2.2 工作区资料库完成（全面重构）——Migration 006（`sources` 增 `content_hash`/`file_mtime`/`file_size`/`workspace`，settings 增 `workspace_dir`）；`src/main/workspace/` 新模块：`fingerprint.ts`（sha256 指纹）、`scanner.ts`（递归扫描 + 新增/变更/消失差异，路径正斜杠归一化）、`reconcile.ts`（对账：新增解析入库 + 内容哈希识别移动保留 id、变更重解析重索引、消失仅统计）、`watcher.ts`（chokidar 监听 + 500ms 防抖 + 5 分钟兜底对账）、`sync.ts`（回收站删除 / 改名同步）、`migrate.ts`（存量导入迁移到工作区）；settings `workspaceDir` + 设置页工作区区块（选择/清除/迁移）+ 资料库页工作区状态与"同步工作区"按钮；删除/改名 handler 同步回文件系统；内嵌文件服务改按资料 id 提供（白名单化防路径穿越）；`sources:updateTitle` 通道补齐实现。验证通过：typecheck 零错误、50 项单测（新增 reconcile 6、watcher 1、sync 4）、生产构建成功。

- **2026-08-06（本次修改）**：BGE-small-zh-v1.5 模型落地 + 推理后端切换 WASM——从 hf-mirror（Xenova/bge-small-zh-v1.5）下载模型到 `resources/models/bge-small-zh-v1.5/`（config.json / tokenizer.json / tokenizer_config.json + `onnx/model.onnx` 94.8MB，transformers.js 兼容格式）。推理后端：本机 `C:\Windows\System32\onnxruntime.dll`（Windows 系统组件 ORT 1.17.1）加载优先级高于应用目录，onnxruntime-node 任何版本均 DLL 初始化失败（`API 29 not available, current ORT 1.17.1`）→ 新建 `vendor/onnxruntime-node-stub`（file: 依赖转发 `onnxruntime-web`）+ 安装 `onnxruntime-common`/`onnxruntime-web`。WASM 加载排障要点（Node/Electron 主进程）：① transformers.js 模块初始化会把 ORT 原生 env 的 `wasmPaths` 默认设为 CDN URL，而 `env.backends.onnx` 只是其浅拷贝，必须直接改 `onnxruntime-web` 的 `env.wasm`（用 `createRequire(__filename)` 保证与 stub 同一实例）；② `env.useWasmCache=false` 跳过 transformers.js 预加载（该路径把 mjs 转成 blob: URL，Node `import()` 不支持）；③ factory（`ort-wasm-simd-threaded.mjs`）须用 `file:` URL、wasm 二进制用纯文件系统路径（Emscripten `fs.readFile`）。`rag/embed.ts` 已固化上述配置；indexer 的"模型缺失"测试改为指向不存在的模型目录（确定性）。验证通过：Node ESM 与 CJS（模拟主进程 require）双路径推理输出 512 维向量、typecheck 零错误、39 项单测、生产构建成功。

- **2026-08-06（本次修改）**：Phase 3.2 资料预处理与混合检索完成——Task 3.2.1 向量索引基础设施（Migration 005：`chunk_embeddings` + `source_summaries` + `sources.indexed_at/index_state`；`rag/embed.ts` 本地 embedding（@huggingface/transformers + onnxruntime-node，动态 import 延迟加载、模型缺失/引擎不可用优雅降级）；`rag/indexer.ts` 增量索引流水线，importFiles/addUrl 成功后自动触发）；Task 3.2.2 混合检索（`rag/vector-store.ts` 余弦检索 + `retrieveChunks` 词法/向量 RRF 融合，`queryVector` 可选参数向后兼容，generateDraft/retrieveForTask 接入）；Task 3.2.3 LLM 摘要索引（`rag/summarizer.ts` 摘要/主题词/关键实体生成入库，`sources:summarizeAll`/`sources:getSummary` IPC，资料库"整理资料库"按钮 + SourceViewer 摘要展示）。契约/数据模型文档同步更新。验证通过：typecheck 零错误、39 项单测、生产构建成功。下一步 Phase 5（验收与打包）。

- **2026-08-06（本次修改）**：输入框失焦 bug 修复——根因：原生 `confirm()` 对话框（Electron 同步原生对话框）打开/关闭后窗口进入"可见但未激活"状态（Windows foreground lock），`document.hasFocus()=false`，点击输入框无 `focusin` 无法输入；打开/关闭原生文件对话框可强制恢复激活。修复：5 处 `confirm()` 全部替换为自定义 `ConfirmDialog` 模态组件（撰写任务删除/资料单删/批量删除/标签删除/Provider 删除），从根源消除失焦源；新增 `window:focus` IPC（`win.show()+focus()+moveTop()` 突破 foreground lock）+ 渲染层 mousedown 兜底检测（`!document.hasFocus()` 时请求恢复并补聚焦点）。调试证据：插桩日志确认 pre-fix 删除后点击输入框 `docHasFocus=false` 无 focusin，post-fix 全程无 blur、focusin 正常。验证通过：typecheck 零错误、30 项单测、生产构建成功。

- **2026-08-06（本次修改）**：Phase 3.1 全部完成——Task 3.1.1 撰写任务删除（右键菜单 + 二次确认、`writing:deleteTask` 通道、任务仓储级联清理、删除当前任务后右栏清空）；Task 3.1.2 初稿文档编辑器（TipTap 2.27 + `tiptap-markdown`）：`DraftEditor.tsx` 共享工具栏（粗体/斜体/下划线/标题下拉/列表/表格增删行列/撤销重做）+ 逐片段 `useEditor`（Markdown 初始化、800ms 防抖自动保存到 `segment:update`、来源折叠展示、保存状态徽标）；`updateSegmentContent` 主进程仓储（内容以 Markdown 存储，变更写入 `review_records` 留痕）；生成提示词补充 Markdown 书写指令；文档编辑器替换撰写工作台只读渲染；契约文档 `docs/shared-contracts.md` 同步 `writing:deleteTask`/`segment:update`。验证通过：typecheck 零错误、30 项单测、生产构建成功。

- **2026-08-05（本次修改）**：输入框聚焦问题排查——用户反馈所有文本框点击后无光标、无法输入。经运行时调试（插桩 document mousedown/focusin/keydown + 主进程窗口焦点事件）验证：窗口焦点、elementFromPoint、defaultPrevented、输入框属性/样式全部正常，当前代码无缺陷；原因为一次性运行时状态（窗口"可见但未激活"）。预防性硬化：`ready-to-show` 中 `win.show()` 后调用 `win.focus()`。验证通过：typecheck 零错误、29 项单测、生产构建成功。

- **2026-08-05（本次修改）**：移除"标签嵌入标题"机制——标签改为纯独立关联（`source_tags` 表），不再写入资料标题：删除 `src/utils/source-title-tags.ts`、移除 `db/tags.ts` 中标题重建逻辑（update/delete/add/remove/batch 均不再触碰 `sources.title`）、前端 SourceList/TagManager/SourceViewer 直接使用 `source.title`；Migration 004（JS 迁移，迁移框架扩展支持 `run`）清理历史数据残留的 `[tag:...]` 标题前缀。删除标签级联验证：`deleteTag` 事务内 `DELETE FROM source_tags WHERE tag_id=?` 实时解除全部资料关联。验证通过：typecheck 零错误、29 项单测（新增迁移 004 清理、deleteTag 级联 2 项）、生产构建成功。

- **2026-08-05（本次修改）**：Phase 3 Task 3.2/3.3 完成——本地 RAG 检索（`src/main/rag/retrieval.ts`：段落分块 + 字符 bigram 打分 + 每来源 Top3/全局 Top12 + 位置标注；`writing:retrieve` 通道）；初稿生成（`src/main/writing/generate.ts`：任务范围解析 → 检索 → 提示词（含范本体例）→ `llm/chat.ts`（net.fetch 对话 + LLM 错误码）→ JSON 解析校验 + 失败重试一次 → 落库 draft/segments/segment_sources）；新增 `db/tasks.ts`、`db/drafts.ts` 仓储、`version:list` handler；preload 新增 createTask/listTasks/retrieveChunks/generateDraft/getDraft/listVersions；撰写页 UI（任务列表 / 新建表单[资料或标签范围+范本] / 工作台[检索预览+生成初稿+片段来源展开]）。验证通过：typecheck 零错误、26 项单测（新增 retrieval 4 项、tasks 3 项、drafts 2 项、generate 解析 4 项）、生产构建成功。下一步 Phase 5（验收与打包）。

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
- **版本相关 IPC 已删除（2026-08-11）**：版本管理功能模块（`version:*`、`draft:confirm` 及版本 UI/类型）已随"产品范围收敛为初稿完成"的决策整体移除；`segment:*` 仅保留 `segment:update`（编辑器整稿保存已覆盖片段更新，其余片段级通道未实现）。
