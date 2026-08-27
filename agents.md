# 项目规范与约束

本文件是 Coding Agent 与开发者共同使用的持久项目上下文。修改项目之前，必须先阅读本文件以及 `PLAN.md` 中与当前任务相关的部分。本文件应保持简洁，并在项目级决策、当前状态或已知问题发生变化时及时更新。

## 项目目标

开发一款 Windows 桌面的、接入大模型的志书撰写工具，帮助地方党史方志办公室的公务员自动收集、整理、归纳、撰写、审校志书，覆盖"资料收集 → 志稿撰写 → 初稿完成"的完整业务闭环。

## 架构原则

- **本地优先**：所有用户个人数据均保留在本地。除（1）调用大模型时必要的交互、（2）访问用户提供的信源网址外，其他操作均在本地进行。初版不要求账号，不建自有云服务。
- **资料闭环（信源白名单）**：资料只能来自两类来源——用户手动导入的文件、用户输入的信源网址。工具**绝对不得从其他渠道自行获取信息**，撰写时只基于这两类来源。
- **人机协同**：AI 负责初稿生成、资料整理归纳、来源标注；史实考证、矛盾裁定、事件补充、终审定稿由人工主导（遵循"依靠不依赖、赋能不替代"原则）。
- **全程可溯源**：AI 生成的志稿每个片段在用户需要时都能展示其原文来源（哪个信源/哪篇文章），供用户审核。
- **分层隔离**：操作系统能力（文件读写、信源抓取、数据库、模型调用）与界面层分离，仅通过规模小、类型明确且经过参数验证的接口向界面层暴露能力，避免界面层获得不受限制的本地能力。

## 技术架构（已确认）

**方案：Electron + React + TypeScript**。Main 进程（本地文件、SQLite、信源抓取、LLM 调用）/ preload 安全桥 / React Renderer 三层。Renderer 使用 `sandbox: true` + `contextIsolation: true`，不暴露 Node 能力。

### 关键架构决策点（现状）

| 决策点 | 方案 | 状态 |
|---|---|---|
| 桌面框架 | Electron 43 + React 18 + TypeScript strict（electron-vite 构建） | 已确认 |
| 本地数据库 | SQLite（better-sqlite3 13，WAL + 外键 + 嵌入式迁移框架 Migration 001–016） | 已确认 |
| 检索增强（RAG） | 本地向量嵌入（BGE-small-zh-v1.5，transformers.js + onnxruntime-web WASM 后端，纯本地）+ 词法 bigram 过滤式检索 + 可选 LLM 摘要粗筛；模型/引擎不可用自动降级纯词法 | 已确认 |
| 文档解析 | PDF(pdf-parse) / Word(mammoth + word-extractor) / WPS(签名分发) / Excel(xlsx 0.20.3) / TXT / MD / 图片OCR(tesseract.js) | 已确认 |
| 工作区资料库 | 指定本地文件夹即资料库：sha256+mtime/size 指纹对账、chokidar 实时监听 + 聚焦/进资料库/每分钟确定性兜底、双向同步（删除→回收站、改名→重命名文件） | 已确认 |
| LLM 接入 | OpenAI-compatible Provider（兼容 DeepSeek、智谱等），safeStorage(DPAPI) 加密存密钥；任务可固定 Provider，未固定回退全局当前 Provider | 已确认 |
| 写作规范 | 「范本」已重构为「写作规范 skills」（2026-08-13）：通用规范默认注入 + 部类细则按标题匹配/智能匹配/手动选择 | 已确认 |
| 编辑器 | TipTap 2.27 + tiptap-markdown，初稿为单编辑器连续 Markdown 文档，800ms 防抖整稿保存 | 已确认 |
| 打包发布 | electron-builder（Windows NSIS，GitHub Actions tag 触发） | 已确认 |

## 技术栈

- 运行时 Node.js LTS / npm；桌面框架 Electron 43；构建 electron-vite + Vite；Renderer React 18 + TS strict；测试 Vitest（内联单测）
- 本地数据库 better-sqlite3；RAG：@huggingface/transformers + onnxruntime-web（WASM，经 `vendor/onnxruntime-node-stub` 转发）
- 文档解析：pdf-parse / mammoth / word-extractor / jszip / xlsx(SheetJS 0.20.3) / tesseract.js；PDF 查看 pdfjs-dist（主线程 LoopbackPort worker）
- 编辑器：@tiptap/* + tiptap-markdown；打包：electron-builder（Windows NSIS）
- 目标平台：Windows

## 核心功能

### 1. 收集材料

- 资料来源：**工作区文件夹内文件**（指定文件夹即资料库，多级子目录自动同步入库）、**用户输入的信源网址**、**网页资料库**（注册站点后生成初稿时自动检索相关文章）。
- 资料可打自定义标签（独立 `source_tags` 关联），撰写时按任务范围（当前固定为全部长期资料）检索使用。
- **写作规范 skills**：预设 + 自建的志书写作规范（通用规范/部类细则），生成初稿时注入提示词。

### 2. 撰写（聊天式工作台）

- 任务创建即建（标题默认"新建任务"，右键重命名）；用户输入撰写要求 → 自动整理摘要 → 网页资料检索 → RAG 检索 → 矛盾预扫描 → 大模型生成整篇连贯 Markdown 初稿（第 0 稿）→ 矛盾定位审查回填。
- 生成后输入框变为自由对话（注入当前初稿 ≤12000 字上下文）；对话历史持久化（`task_messages`）。
- 生成过程推送阶段进度 + 百分比 + 预计剩余时间；失败（缺标题等）由大模型返回详细报错。

### 3. 初稿人工审核（并入 Phase 3 实现）

- **出现矛盾**：正文插入 `【矛盾#N】` 标注，点击弹出多说法对比（含来源文件链接），支持采纳（正文本地替换 + 撤销兼容）与忽略；不在正文的矛盾归入「警告」清单。
- **文段来源询问**：框选正文右键询问来源——本地精确匹配 → 生成上下文溯源 → 过滤式检索 → LLM 兜底，回复中 `#N` 渲染为可点击来源链接。
- **修改文段**：直接在编辑器中编辑，自动保存。

> **2026-08-11 决策**：版本迭代与管控已从产品范围删除，每个任务仅保留一稿（初稿）；"事件缺失补充"暂不在当前范围。

## 编码约定

- 采用 TypeScript strict，除非有明确记录的理由，否则不得引入 `any`。
- 代码标识符、文件名、API 名称、数据库字段和 Git Commit 标题使用英文。
- 面向用户的文字不得硬编码在组件里，应集中在文案资源（`src/renderer/src/i18n/zh-CN.ts`）。
- 界面组件只负责呈现与交互；持久化、网络请求、解析、检索和 AI 逻辑放入服务层（主进程）。
- 不得向界面层提供不受限制的 Node.js、文件系统、Shell 或数据库访问能力；每个接口请求都必须在主进程中验证并返回结构化结果（`ApiResult<T>`）。
- 外部资料（导入文件、信源内容）均视为不可信输入，显示前必须进行安全清洗。
- 不得在源码或普通日志中写入 API Key、凭证、个人路径或资料正文（诊断日志统一脱敏）。
- 本地数据库结构确定后，所有 Schema 变更必须通过迁移完成。
- 为文档解析、信源抓取、数据库操作、AI 响应处理、初稿生成与矛盾检测编写针对性测试。
- 面向用户的流程必须处理加载、空数据、成功、部分失败和错误状态。
- 避免无关重构；修改共享类型或接口协议时，必须同时更新所有调用方与相关文档，不得静默修改。
- 为任务创建的临时脚本、调试文件、预览产物等，在任务完成后必须及时删除，不留工作痕迹；确需保留的演示产物须明确归档说明。

## 单人开发与 Git 约定

- 本项目为**单人开发**，`PLAN.md` 中的模块划分是代码组织边界，不涉及多人协作。
- 使用自己的 Git 身份提交代码；每个 Commit 只处理一个明确目的，并包含其验证结果（测试/检查通过情况），便于回溯。

## 远程仓库（GitHub）

- **仓库地址**：`https://github.com/RegeonChen/XieZhiShu`，是开发版本控制的权威远程源。默认分支 `main`，单人开发默认直接提交；大改动可开 `feature/*` 分支。
- **同步规则**：开发前先 `git pull --rebase`；每完成一个任务并验证后提交并 `git push`。
- **版本发布规则**：语义化版本（SemVer），里程碑打 tag `vX.Y.Z` 并在 GitHub Release 记录发布说明。
- **禁止事项**：不得对 `main` 使用 `git push --force`、`git reset --hard`、`git checkout .` 等破坏性命令；未经用户明确要求，不执行 commit、push、tag、release 等远程相关操作。
- **敏感与数据隔离**：API Key、`.env`、本地数据库文件、用户资料样本不入库；`.gitignore` 排除 `node_modules`、`dist`、`release`、`out`、模型文件等；项目文档（本文件、`PLAN.md`、`init.md`、`docs/`）纳入版本管理。

## Agent 工作规则

- 修改代码前，先阅读本文件与 `PLAN.md` 中当前执行的任务。
- 先确认仓库的真实状态，不得假设文件或依赖已经存在。
- 当某项选择会改变产品范围、共享协议、安全性、存储数据或平台行为时，将决策及理由记录到本文件"设计决策"或"近期记录"。
- 报告任务完成前，必须运行当前环境中最相关的检查（typecheck / 单测 / 构建）。
- 未证明任务的 `Verification` 验收条件之前，不得将任务或阶段标记为完成。
- 当修改对项目产生实质影响时，更新"当前状态"和"已知问题"。

## 当前状态

截至 2026-08-25（三段式撰写重构启动）：

- **已完成**：Phase 1（脚手架/共享契约/数据库迁移框架）、Phase 2（文件导入/信源抓取/标签）、Phase 2.1（删除与标签重构）、Phase 2.2（工作区资料库 + 实时双向同步 + 自动同步触发源）、Phase 3.1（LLM Provider 配置）、Phase 3.2（BGE 向量嵌入 + 词法/向量混合检索 + LLM 摘要索引）、Phase 3.3（范本 → 后重构为写作规范 skills）、Phase 3.4（连续整稿显示 / 摘要粗筛 / 检索过滤式 / 重新生成）、Phase 3.5（聊天式工作台 + 对话持久化 + 进度提示）、Phase 3.6（预设大模型 + 获取 API key 指引）、Phase 3.7（矛盾预扫描 → 生成注入 → 定位审查三次调用链路、编辑器内嵌矛盾标注与弹窗、采纳本地修订 + 撤销兼容、矛盾/警告分类、文段来源询问、来源文件打开）、网页资料库（站点注册/发现/粗筛/增量抓取，任务绑定缓存文章）。
- **产品范围**：收敛为"资料收集 → 撰写 → 初稿完成"；版本管理已删除（数据库保留旧列不动），每个任务仅保留初稿。
- **验证基线**：typecheck 零错误；vitest 内联单测 149 项通过；生产构建成功。端到端实测（真实大模型生成/矛盾取舍/站点抓取）部分场景留待用户操作。
- **进行中**：Phase 6.0/6.1/6.2/6.3 已实现——6.0 数据模型（Migration 016 + 仓储 + CRUD/取舍/确认 handler）；6.1 汇编生成服务（本地宽召回宁多勿漏 + AI 分窗细读 + 矛盾标注 + 本地降级，`compilation:progress` 进度事件，新增 5 项单测）；6.2 前端三步向导（顶部步骤条、`CompilationStep` 卡片审阅/编辑/删除/打开来源、矛盾内联取舍、未处理矛盾阻止确认）+ 三步对话框贯穿（Step 1 生成汇编 / Step 2 预留行文规范 / Step 3 生成初稿）；6.3 生成链路改造（`generateDraft`/`regenerateDraft` 接收可选 `compilationId`，仅取已确认汇编 kept 卡片、跳过检索/扫描，旧链路兼容）。验证：typecheck 零错误、149 项单测、生产构建成功。**待用户实测：真实 Provider 的 AI 细读/矛盾标注、三步端到端、基于汇编生成初稿**。

## 设计决策（要点，按时间倒序）

- **写作规范 skills 替代范本（2026-08-13）**：范本（体例参考）重构为"写作规范"（通用规范默认注入 + 部类细则按标题匹配/智能匹配/手动选择），`writing_skills` + `writing_tasks.skill_ids`（Migration 014）；范本相关 UI/IPC 移除。
- **网页资料库（2026-08-11/13）**：注册站点 → BFS 栏目遍历发现文章清单（限 20 页/深度 2）→ 标题 bigram 宽召回 → 正文精确子串精过滤 → 增量抓取正文落库为任务绑定缓存（`sources.task_id`，删任务级联清理，不进资料库列表）；标题粗筛用"领域下位词兜底表"（当前仅教育→学前教育核心词），严格收窄避免政务学习类新闻误召回。
- **矛盾检测三次调用链路（2026-08-10/11）**：检索后预扫描（低温度 + 温度阶梯 0→0.3→0.7 重试、主题聚类 + 整组窗口并发扫描、空结果收敛）→ 生成注入"严禁合并/折中 + `【矛盾#N】` 标注" → 定位审查（回填 draftQuote/merged/inDraft/replacements）。扫描视野收敛为"撰写实际用到的检索文段"（用户确认取舍）。**采纳 = 纯本地替换**（from=draftQuote → to=replacement，无 LLM 调用），编辑器 setContent 进 undo 历史实现撤销兼容。
- **产品范围收敛（2026-08-11）**：删除版本迭代与管控；"事件缺失补充"暂不在范围。
- **检索策略演进（2026-08-07）**：取消 Top-N/截断限制，改为"过滤式"——词法 score>0 或向量余弦 ≥0.3 的段落全部保留；标题行（≤12 字短语等）一律剔除（曾致初稿只有标题无正文的根因）。
- **向量推理后端（2026-08-06/09）**：Windows System32 的 onnxruntime.dll 抢先加载导致 onnxruntime-node 原生绑定不可用 → `vendor/onnxruntime-node-stub` 转发到 onnxruntime-web WASM（单线程）；嵌入推理移到 worker_threads（embed.worker.js），主进程自动回退直接推理；索引改为后台串行队列（列表秒出，向量后台补）。
- **工作区资料库（2026-08-06/07）**：全面替换"导入转存"；指纹（sha256+mtime/size）做映射锚点（移动/重命名不丢 id/标签/摘要）；chokidar 500ms 防抖增量 + 聚焦/进资料库/每分钟全量兜底（mtime/size 快筛，开销低）；工作区删除文件 → 直接删库（级联清理），软件内删除 → 回收站；对账只做"文件系统 → 数据库"方向防环路。
- **全程可溯源 / 信源白名单 / 人机协同 / 本地优先**：见"架构原则"。
- **技术选型（2026-08-03）**：Electron + React + TypeScript。
- **编辑器选型（2026-08-05）**：TipTap + tiptap-markdown，初稿以 Markdown 存储、连续显示。
- **版本管控（已删除，2026-08-11）**：原"第 n 稿"版本单元方案随产品范围收敛移除。

## 路线图

1. Phase 1：项目基础（脚手架、共享契约、本地数据库）——已完成
2. Phase 2：资料收集闭环（工作区资料库 / 标签 / 网页资料库 / 写作规范）——已完成
3. Phase 3：撰写闭环（LLM 接入 / RAG 检索 / 初稿生成与来源标注 / 矛盾检测与取舍）——已完成
4. Phase 5：验收与打包（Windows 安装包、端到端演示、文档）——**待进行**

详细任务和验收标准位于 `PLAN.md`，本文件不重复记录任务级进度。

## 近期记录（摘要）

> 完整的历史修改日志已整理进 `PLAN.md` 各阶段摘要；此处保留对未来开发仍有价值的根因结论。

- **2026-08-25（第三步「生成撰写初稿」落地：三步提交物协同 + 移除底部导航按钮）**：① 移除工作区底部「上一步 / 下一步」按钮，切换仅靠顶部三步导航（`writing-stepper`，仍按未确认汇编锁定 Step 2/3）。② Step 3 提交物固定为三样——已确认资料汇编的 `kept` 卡片文本（矛盾取舍中被排除的卡片 `kept=0` 不纳入，按时间排序去重）、第二步确认的默认行文规范（`getDefaultStyleGuide`）、可选任务级参考范本（`task.modelText`）。③ 提示词组织：`buildUserPrompt`（新增 `materialsOrigin` 可选参数）按「用户要求 → 写作规范 → 参考范本（可选）→ 参考材料（标注来自已确认资料汇编、已剔除矛盾排除卡片）」注入，系统提示仍为默认规范 + JSON 输出契约；`generateDraft` 汇编分支读取三者并构建 messages。新增 2 项单测（参考范本注入、参考材料来源标注），共计 165 项全通过；typecheck/构建通过。
- **2026-08-25（Phase 6.4.2 第二步「添加范本」 + 规范弹窗高度）**：① **任务级范本**——在第二步「指定行文规范」的可选「添加范本」：`StyleGuideEditor` 增加 `taskId` 参数，工具栏「添加范本」置于「导入已有规范作为底稿」左侧并列；点击展开**可折叠范本窗口**（展开/收起逻辑参考第一步矛盾窗口：展开=文本框 + 底部固定「▲ 收起」，收起=有内容时显示「范本 ▼」条），录入防抖自动保存。**数据**：Migration 020 `writing_tasks.model_text TEXT NULL`；新 IPC `writing:getModelText`/`writing:setModelText` + preload + main handlers + `WritingTask.modelText`。**生成侧**：`generateDraft` 读取 `task.modelText`，非空时 `buildUserPrompt` 注入 `【参考范本】` 区块（与【写作规范】【参考材料】并列），并提示参考其体例与行文风格；不填范本时不出现该区块。② **规范弹窗高度**——头部「规范」弹窗 `.style-guide-modal` 由 `max-height` 改为固定 `height: 80vh`，文本编辑区随高度拉大（此前点击某篇规范后编辑区因高度自适应过低）。验证：typecheck 零错误、164 项单测、构建通过。
- **2026-08-25（Phase 6.4.1 规范文档库 + 第二步文本编辑器）**：按用户构思实现多篇规范文档库与第二步「指定行文规范」编辑器。**数据**：Migration 019 `style_guides` 表（多篇，`is_default` 全局唯一默认，启动时表空自动写入 `DEFAULT_STYLE_GUIDE`）；新仓储 `db/style-guides.ts`（list/get/save[有 id 覆盖、无 id 新建且首个自动设默认]/setDefault/delete[删除默认回退剩余第一篇]/ensure，含 4 项单测）。**IPC**：`styleGuide:list/save/setDefault/delete` + preload + main handlers。**UI**：`StyleGuideEditor`（textarea 展示当前默认规范；右上「导入已有规范作为底稿」→ 选择已保存规范 → 二次确认替换全文；右下「保存规范」→ 弹「选择保存方式」：已有规范列表 + 空白「+」，点已有项→「覆盖现有规范」，点「+」→「另存为新规范」输入名称；每篇可设为默认/重命名/删除），第二步内嵌显示；头部新增「规范」入口按钮（回收站按钮左侧并列）打开同款弹窗。**生成侧**：`buildSystemPrompt`/`buildUserPrompt` 改为读取 `getDefaultStyleGuide()?.content`（无则回退 `DEFAULT_STYLE_GUIDE`）注入。文档（shared-contracts/data-model/ui-architecture）同步。验证：typecheck 零错误、163 项单测、构建通过。
> 后续微调：头部「规范」按钮图标改为**三角板**，点击打开**规范列表**（点击某一篇进入编辑/保存）；第一步「矛盾」窗口增加**向上三角形**收起/展开按钮，且该按钮固定在矛盾窗口（可滚动列表）**下方、始终可见**，无需随列表滚动到底。后续修复：矛盾列表改为**容器整体上限 40% + 内部滚动区**（原把 40% 上限移到内层列表导致容器高度失控，矛盾多时把下方资料卡片挤出视口）。

- **2026-08-25（Phase 6.4 行文规范简化：删除 skills 模块 + 合并默认规范）**：① **删除整个「写作规范 skills」模块**——移除 `SkillsManager`/`SkillPickerDialog`、`writing-skills.ts` 仓储、`skills:*` IPC（list/create/update/delete）+ preload 方法 + `WritingSkill` 类型，删除「规范」页导航，移除 `resolveTaskSkills`/`listSectionSkills`/`matchSectionSkills`/`formatSkillsText` 及 `updateTaskSkillIds`；Migration 018 `DROP TABLE IF EXISTS writing_skills` 并 `UPDATE writing_tasks SET skill_ids = NULL`。② **合并仅保留的两篇通用规范（志书文体文风 + 志书行文规则）为默认规范** `DEFAULT_STYLE_GUIDE`（`src/shared/style-guide.ts`），作为默认规范注入第二步（行文规范）显示，并在生成初稿时作为全局写作约束注入 system/user prompt；`buildSystemPrompt`/`buildUserPrompt` 改为直接使用该默认规范。验证：typecheck 零错误、159 项单测、构建通过。

- **2026-08-25（任务自动改名 + 矛盾回收站）**：① 自动改名——`generateCompilation` 用大模型提取出标题后，若任务标题仍为默认“新建任务”，自动 `renameTask(taskId, extracted.title)`；用户仍可右键重命名。② 矛盾回收站——采纳/忽略某组矛盾时，除把未被采纳卡片“软删除”（`kept=0`，UI 只显示 kept=1）外，还把整组矛盾快照进新表 `compilation_recycle_bin`（Migration 017，引用 contradiction_id，随 compilation 级联删除）。右上角垃圾桶小圆钮进入回收站，可“恢复”某组矛盾：所有 variant 卡片改回 `kept=1`、矛盾状态回到 pending、删除回收站条目。**用软删除代替硬删除，恢复不重建卡片，避免重复卡片/卡片数异常**（单测验证恢复后卡片总数不变）。新增回收站 IPC（`compilation:recycleBin:list/restore`）+ preload + Repository + UI（垃圾桶圆钮 + 回收站弹窗）。验证：typecheck 零错误、160 项单测、构建通过。

- **2026-08-25（对话持久化 + 矛盾稳定性 + 卡片 UI）**：用户反馈三点并修复。① **对话历史持久化**——`compilation:generate`/`regenerate` 处理器现把撰写要求写入 `task.userInstruction` + `addTaskMessage('instruction')`；前端生成/重生成后持久化助理摘要并 `reloadMessages()`；`load()` 从最新汇编 `title` 恢复 `compilationInstruction`。因此关软件/切页后对话历史保留，“重新生成汇编”按钮能取到要求。② **矛盾稳定性**——逐窗细读会漏“两个相左说法在不同窗口”的跨窗口矛盾；新增 `scanCardContradictions` 在细读产出最终卡片后对精简卡片集做一次低成本 LLM 矛盾归类（`parseCardScanGroups` + `mergeContradictionGroups`，与窗口级矛盾合并去重），提升跨来源/跨窗口矛盾召回且不牺牲效率。③ **卡片 UI**——资料卡片每张独占一行；来源/编辑/删除收进右侧“…”下拉菜单（`menuFor` 状态）。新增 2 项单测（`parseCardScanGroups`、`mergeContradictionGroups`），共 160 项全通过；typecheck / 构建通过。

- **2026-08-25（Phase 6.1 三段式细节修正）**：用户逐条反馈三点，均已修改。① **段落划分**——粗筛改按原始换行划分（`retrieval.ts` 新增 `chunkParagraphs`，仅剔除标题行、不按句/字数二次切分），避免“最后一句话被截半”；AI 细读提示词改为“先判相关性、再按时间/事实/条目做更细切分、输出完整事实摘录（不截断）”，超长单段（>30000 字）在切窗时按句兜底拆分防上下文溢出（`sliceChunks`）。② **矛盾取舍**——采纳某卡后 `updateCompilationContradictionStatus` 自动删除该矛盾分组中未被采纳的卡片（级联清理 variant 行），前端重新拉取汇编同步删卡。③ **去除生成资料汇编阶段的写作规范**——移除 ChatPanel 输入框上方写作规范 UI（智能匹配/手动选择），删除 `WRITING_UPDATE_SKILLS`/`WRITING_SUGGEST_SKILLS` 通道与 handler、preload `updateTaskSkills`/`suggestSkills`、`generate.ts` 的 `suggestSkillsForTask`/`parseSuggestSkillsOutput`；`writing_skills` 数据管理（规范页）与初稿生成侧自动注入保留。新增 2 项单测（`chunkParagraphs`、采纳删卡），共 158 项全通过；typecheck / 构建通过。

- **2026-08-25（Phase 6.1 大模型提取标题与粗筛关键词）**：用户指出静态 `extractTopicTerms` 只取引号内核心词，覆盖不了“包含例如：…托儿所/招生/等级/占比”等细节词，粗筛可能漏掉只含这些词、不出现“学前/幼儿园”的段（窗口偏少的主因之一）。按用户提议实现：调用大模型前**先用大模型**（配置了 Provider 时）从用户完整撰写要求中提取标题 + 近义词/上下位词/专业词（理解方志语境做扩展），返回 `{title,keywords}`；据此生成 `coarseQuery`（词法粗筛词）与 `vecQuery`（标题向量）。新增可测的 `parseKeywordExtraction`（解析 JSON）与本地兜底 `fallbackCoarseQuery`（extractTopicTerms + expandDomainHints）；大模型调用失败或无 Provider 时自动回退本地。粗筛阶段因此能保留“托儿所/招生/等级/占比”相关的段，再由模型细筛判断。新增 3 项单测（156 项全通过）；typecheck / 构建通过。

- **2026-08-25（Phase 6.1 汇编相关性修正，最终形态）**：用户实测发现资料汇编混入“福州市先进教育工作者/优秀教师”等荣誉卡片（来源《长乐志》，263 卡、候选 2660 段）。根因：① AI 细读提示词未注入用户撰写要求，模型按“志书汇编”泛化标准筛选；② 词法闸门把“教育”双字对命中即算相关，荣誉记录混入候选。**最终修正（按用户要求回调后）**：a) 把 `instruction`（撰写主题与范围）注入 system/user prompt，模型按用户标题自行判断相关事实并提炼卡片，**不再显式列举“排除荣誉/党建/后勤”等类别**；b) 词法闸门**回退为宽松粗筛**——仅剔除无任何信号（score==0 且无向量命中）的“肯定无关”段，有任意词法或向量（≥0.1）信号的段都保留，交由模型细筛，既不因“教育”单字对误判而候选过多，也不因收紧而误删“公办园数量”这类相关但无字面重叠的段；c) 卡片移除“位置：第 N 段”注释。验证：typecheck 零错误、153 项单测、构建通过。

- **2026-08-25（Phase 6.1 汇编候选性能优化：保守本地闸门）**：用户实测“学前教育园所设置”生成汇编时 AI 细读出现 94 个窗口、预计 31 分钟，过长且费钱。优化——在 `generateCompilation` 调用大模型前新增 `recallCompilationCandidates` 保守闸门，把提交物从“任务范围内全部段落”收敛为“与主题相关的来源及其相关段落”：①来源级：仅保留有相关信号的来源（标题含查询词 / 任一段词法 score>0 / 任一段向量余弦 ≥0.1），完全无关的来源整篇舍弃（资料库中大量无关文件是窗口数主因）；②来源内：标题含任一查询词或来源较小且词法信号强 → 整篇保留（篇内不漏）；宽口径来源（如综合年鉴）只保留有信号的分块。向量路径用低阈值（0.1）兜底“字面无关但语义相关”段落（如含地点名的数据段）。无 Provider / AI 失败时回退用全量集合（不因闸门丢材料）。为省去无意义开销，把 `embedTexts` 移到无 Provider 检查之后。新增 4 项单测（153 项全通过）；typecheck / 构建通过。

- **2026-08-25（Phase 6.2/6.3 三步向导前端 + 生成链路改造）**：`WritingWorkspace.tsx` 重写为三段式向导——顶部 `writing-stepper` 步骤条（未确认汇编时锁定 Step 2/3，仅可回退）、右栏随步骤切换（Step 1 `CompilationStep` 卡片审阅 / Step 2 行文规范占位 / Step 3 初稿编辑器）、左侧 `ChatPanel` 贯穿（Step 1 主按钮「生成资料汇编」走 `onPrimaryAction`；Step 2 预留自由对话；Step 3 生成初稿），`compilation:progress` 事件驱动候选统计与进度条；`CompilationStep` 空态不再放误导性按钮（改为引导左侧输入），卡片操作/矛盾取舍回写本地状态。`generate.ts` 的 `generateDraft`/`regenerateDraft` 新增可选 `compilationId` 分支——已确认汇编时仅取 `kept` 卡片文本（按时间排序）作为材料，跳过摘要/网页/检索/矛盾扫描，未提供时保留旧检索链路；修复 `regenerateDraft` 未透传 `compilationId` 的问题。新增 CSS（`.writing-stepper`/`.writing-style-step`/`.compilation-*`）。验证：typecheck 零错误、149 项单测、生产构建成功。待用户实测三步端到端与基于汇编生成初稿。

- **2026-08-25（Phase 6.1 资料汇编生成服务）**：新增 `writing/compilation-service.ts`——①本地宽召回 `recallCandidateChunks` 直接返回任务范围内全部有效分块（词法分仅用于排序，**不做任何过滤**，从机制上保证不丢相关材料）；②AI 分窗细读（≤30000 字/窗、并发 2、温度 0→0.3 重试、maxRetries 1），提示词要求逐字摘录/提取时间标签/来源编号/发现实质冲突，输出 `{items,contradictions}`；③解析/合并去重/#N 映射/按年份排序落库；④无 Provider 或 AI 未产出有效卡片时降级为「全部候选块直接成卡片（ts 取首个年份）」。`compilation:generate`/`regenerate` handler 接入服务并推送 `compilation:progress`（候选块数/来源数/窗口进度）。新增 5 项单测（宁多勿漏召回、JSON 解析、#N 映射、合并去重、空输入）。真实 Provider 的 AI 细读/矛盾标注效果待用户实测。

- **2026-08-25（Phase 6.0 资料汇编数据模型）**：三段式撰写重构启动——Migration 016 新增 `compilations`/`compilation_items`/`compilation_contradictions`/`compilation_contradiction_variants`；`shared/types.ts` 新增 Compilation/Item/Contradiction/Variant；`shared/ipc.ts` 新增 `compilation:list/get/generate/regenerate/updateItem/deleteItem/resolveContradiction/confirm`；新仓储 `db/compilations.ts`（创建/读取、卡片写入/编辑/删除、矛盾写入/取舍[resolve 校验卡片归属]、确认 finalize、级联删除）+ 4 项单测；主进程 CRUD/取舍/确认 handler 已实现，`generate`/`regenerate` 契约登记、AI 服务待 Phase 6.1。已确认决策固化在 `PLAN.md` Phase 6：本地宽召回+AI 细读（**宁多勿漏**）、深改 TipTap、三主题发布版可切换、三步为独立页面由向导切换、矛盾必须取舍后才能进下一步、通用规范默认注入、初稿仅汇编层溯源。验证：typecheck 零错误、144 项单测、生产构建成功。

- **2026-08-24（移除手动「同步工作区」）**：决策——手动同步按钮及其调用的 `workspace:reconcile` 通道、preload API、i18n 文案与 SourceList 相关逻辑整体删除；同步改为纯自动（启动 / 窗口聚焦 / 进入资料库 / 每分钟定时 / 设置页变更工作区 / chokidar 监听增量）。理由：自动触发已全覆盖手动按钮的功效，保留只会多一个入口与 UI 负担，删除后涉及「手动同步」的代码面归零，也消除了未来新增调用路径时绕过互斥调度的风险。清理范围：`shared/ipc.ts`（WORKSPACE_RECONCILE 通道与 WorkspaceReconcileRes 类型、IpcMapping 项）、`main/index.ts`（handler）、`preload`（方法 + 类型声明）、`SourceList.tsx`（按钮/说明气泡/handleReconcile/reconciling/manualReconcilingRef）、`zh-CN.ts`（reconcileBtn/reconciling/infoReconcile/reconcileFailed）、`docs/shared-contracts.md`、`docs/ui-architecture.md`。自动同步完成事件保留列表刷新与提示逻辑。验证：typecheck 零错误、140 项单测、生产构建成功。

- **2026-08-24（重复入库二次审计）**：重新盘点全部触发工作区对账/扫描的机制——启动、窗口聚焦、进入资料库、每分钟定时、手动同步、设置页变更工作区、chokidar 监听增量、存量迁移。结论：v0.1.3 的互斥调度 + 入库前复核 + Migration 015 唯一索引已覆盖并发重复入库主路径；本次再加固三处残留缝隙：① 手动同步在排队期间被合并后不再直接调用 reconcileWorkspace（避免微小并发窗口），改为循环重提调度器直至拿到结果；② workspace:migrate（迁移存量资料）纳入调度器串行，避免迁移搬入的文件被并发对账先入库后 UPDATE 撞唯一索引；③ 工作区新扫描到的文件若与「旧版导入副本（workspace=0）」内容哈希一致，改为吸收旧记录（保留 id/标签/摘要并升级为工作区记录），消除「旧副本 + 工作区记录」并存的另一类重复；设置页切换工作区后监听重启保留进度回调。新增 2 项单测（调度器 await 契约、旧副本吸收）。验证：typecheck 零错误、140 项单测、生产构建成功。

- **2026-08-20（工作区重复入库修复）**：资料列表每个文件显示两次的根因是**并发对账**——设置页变更工作区与手动「同步工作区」直接调用 `reconcileWorkspace`，绕过 `auto-sync.runWorkspaceSync` 互斥；窗口聚焦/进资料库/每分钟定时/监听增量均经调度器。多个全量/增量对账同时扫描到同一批新文件，各自在「查不到库记录」后依次插库 → 同一 `file_path` 产生多行。修复：① `runWorkspaceSync` 升级为可 await 的调度器（busy 期间只保留最新任务排队，队列清空后 resolve 等待者），设置变更与手动按钮全部改为经该调度器；② `ingestFile` 在解析后插入前复核路径（并发兜底，已存在则更新指纹而非重复插入）；③ Migration 015 清理存量重复行（每个 file_path 保留最早一条，级联清理其关联）并建立部分唯一索引（workspace=1 文件按 file_path 唯一），结构性杜绝复现；新增迁移 015 回归单测。验证：typecheck 零错误、138 项单测、生产构建成功。另注：若重复还来自「旧版导入副本（workspace=0）+ 工作区记录并存」，属另一类数据，可经设置页「迁移旧资料到工作区」收敛。

- **2026-08-20（右键粘贴修复）**：Electron 沙箱渲染进程无法直接读系统剪贴板，导致文本框中 Ctrl+V 正常、右键无粘贴。新增 `clipboard:readText`/`clipboard:writeText` 两个 IPC 通道（主进程 `clipboard` 模块读写，preload 暴露 `readClipboardText`/`writeClipboardText`）；新建全局 `TextContextMenu`（input/textarea/contenteditable 右键菜单：剪切/复制/粘贴/全选，粘贴经主进程读剪贴板，React 受控输入用原生 setter + input 事件同步）；`DraftEditor` 正文右键菜单同步扩展为「剪切/复制/粘贴/全选 + 询问文段来源」，未选中文本时按右键位置定位光标。验证：typecheck 零错误、137 项单测、生产构建成功。

- **2026-08-19（本轮大规模优化）**：① **文档整理**——`agents.md`/`PLAN.md` 将历次已完成任务的冗杂过程合并为「已完成阶段摘要」，保留方案结论与根因；`docs/shared-contracts.md`/`data-model.md`/`ui-architecture.md` 同步到代码现状（skills 替代范本、网页资料库、矛盾表、task_id 缓存文章、诊断日志通道等）。② **接口清理**——`shared/ipc.ts` 删除无实现无调用的死通道（`sources:refresh`、`segment:resolveConflict/addManual/insertGenerated`），新增 `app:openFileDialog`/`app:openDirectoryDialog` 常量与 `workspace:progress`/`writing:streamDelta` 事件常量（preload/main 改引用常量），修正 `sources:get` 响应类型为 `{ source, tags }`。③ **隐患与性能修复**——`file-parser.parseImage` 失败路径不再泄漏 tesseract worker；`url-fetcher` 空响应体防御；`drafts.splitMarkdownIntoSegments` 标题正则容忍 `##标题`（无空格）；`retrieval` 新增按 `sourceId+contentHash` 的分块缓存 + 查询 bigram/词条预计算（大资料重复检索显著提速，无 contentHash 的存量资料不缓存避免碰撞）；`generateDraft` 幂等检查前置到所有副作用之前（避免重复写消息/整理摘要/抓取网页/检索扫描）。④ **LLM 交互稳定性与速度（用户选定方案 A+B）**——`chat.ts` 新增瞬时故障自动重试（HTTP 429/5xx/网络错误，指数退避 0.8s/2s/4s，经 `ChatCallOptions.maxRetries` 开启；生成/对话 2 次、摘要/来源询问/智能匹配 1 次；401/超时/空响应/格式错误不重试）+ **SSE 流式输出**（`onDelta` 回调 + `createJsonFieldStreamer` 只把生成输出 JSON 中的 content 字段增量推给前端，原始 JSON 不刷屏；非 SSE 响应回退普通 JSON 解析）；新增 `writing:streamDelta` IPC 事件，`ChatPanel` 实时流式气泡 + 光标动画，生成/对话完成后再以持久化消息为准刷新。⑤ **前端视觉与交互打磨**——补齐历史遗留未定义 CSS 变量（`--bg/--bg-soft/--bg-elevated/--fg-faint` 等）；统一按钮过渡/焦点环/滚动条/模态动效；顶栏品牌标识；左栏选中指示条；资料列表选中高亮（App 传 activeId）；资料详情新增「复制全文」；任务列表第二行显示文章标题/创建时间；编辑器页脚字数统计；对话面板智能自动滚动（阅读历史时不抢滚动）、打字动画、流式气泡、空状态引导步骤；ConfirmDialog 支持 Esc 取消；各处加载态统一 spinner；SourceList 硬编码文案迁入 zh-CN（`sourceStatus.*` 等）。**设置页重设计**——中栏由空占位改为「设置导航」（总览/工作区/预设/Provider 四项，点击平滑滚动 + IntersectionObserver scroll-spy 高亮）；右栏改卡片式区块（分区图标 chips、总览渐变卡含当前 Provider/工作区状态速览与新手教程/导出日志入口、工作区状态 chip、预设卡片头像与悬停、Provider 条目头像/模型 pill/密钥状态圆点）。**规范页同风格重设计**——导航组件抽成通用 `SectionNav`（设置/规范两页共用）；规范页中栏改「规范导航」（总览/通用规范/部类细则），右栏改总览渐变卡（条数统计 + 新建入口）+ 搜索工具栏（清空按钮）+ 通用规范/部类细则两张卡片式区块（图标 + 说明 + 数量、条目头像/徽标/关键词 chips/内容预览），新建/编辑/删除逻辑不变。**验证**：typecheck 零错误、137 项单测、生产构建通过。
- **2026-08-14**：生成链路解耦重构——矛盾扫描/网页检索改用"标题词 + 领域下位词"稳定主题查询（`extractTopicTerms`/`expandDomainHints`），与生成正文 chunks 解耦，避免同一主题不同措辞导致两次生成材料不一致；`clusterSourcesByTopics` minDice 0.05→0.12（泛教育政治学习文章不再聚成超大簇）；网页召回下位词表再收窄（剔除"招生/校历/学位"等）。新增智能匹配写作规范（`writing:suggestSkills`，temperature 0）；诊断日志系统（IPC 调用/LLM 调用/提交物记录 + 一键导出，敏感信息脱敏）；新手引导聚光教程（设置页可重开）；撰写工作台常驻挂载（切页不丢对话/进度）。
- **2026-08-13**：写作规范 skills 重构（见设计决策）；网页缓存文章绑定任务（Migration 013，资料库只显示 `task_id IS NULL` 的长期资料）；矛盾扫描要求"不同来源相左"（同一来源总分关系不算矛盾）；`matchesExact` 正文精过滤替代 bigram 模糊。
- **2026-08-11**：Phase 3.7 增强（采纳本地修订 + 矛盾/警告分类 + 撤销兼容 + 生成进度条）；矛盾扫描提速（整组窗口 + 并发 2 + 空结果重试收敛）与视野收敛（只扫检索文段）；删除版本管理模块（代码移除、数据库保留旧列）。
- **2026-08-10**：Phase 3.7 三次调用链路 + 矛盾数据模型（Migration 009）+ 编辑器标注 + 弹窗 + 来源打开。
- **2026-08-09**：工作区加回大文件卡顿根治——索引改后台串行队列 + WASM 推理移入 worker_threads（embed.worker.js，崩溃/缺失自动回退主进程推理）；"伪实时同步"修复（对账完成事件带计数，SourceList 自动刷新）；UI 三连（图标导航/撰写左右栏/中栏显隐持久化）。
- **2026-08-08**：Phase 3.5 三连修（对话历史持久化 Migration 008 + llm_call_logs 痕迹；生成进度事件；对话超时 5 分钟）；"学前教育"生成耗时 5 分 44 秒排查结论：材料量大所致（用户决策仅加进度提示）；聊天式工作台；一键复制；.wps/.xls/.xlsx/.doc 格式支持（按文件头签名分发）。
- **2026-08-07**：Task 3.4 系列——连续整稿编辑器（`draft:updateContent` 整稿保存重建片段）；摘要粗筛（无摘要资料保守保留）；整篇连贯正文（去除 JSON 片段契约）；标题行剔除修复"初稿只有几行字"；重新生成初稿；范本剔除目录页；取消材料供给限制（过滤式检索）；生成超时 10 分钟；生成前自动整理范围内摘要。
- **2026-08-06**：工作区资料库全面重构 + 批量录入异步化（fs/promises + 分批让出事件循环，300 文件全量对账 0.6s）；BGE-small-zh-v1.5 模型落地 + WASM 后端固化（本地 `ort.env.wasm` 路径配置）；窗口/布局状态持久化；输入框失焦 bug（原生 confirm 导致，全部替换为自定义 ConfirmDialog + `window:focus` 恢复激活）。
- **2026-08-03~05**：Phase 1/2/3.1 完成；标签系统重构（独立关联、去颜色、去标题嵌入）；TipTap 编辑器选型；RAG 词法 bigram 检索。

## 已知问题

- **大模型幻觉风险**：无依据编造史实是必须重点抑制的风险，通过"信源白名单 + RAG 检索 + 逐片段来源标注 + 提示词硬约束（严禁编造）"在架构层面约束。
- **生成耗时与稳定性**：材料量大时单次生成可达数分钟（10 分钟超时）；矛盾扫描/定位的温度阶梯重试带来额外 LLM 调用。2026-08-19 已落地瞬时故障自动重试 + 流式输出（用户选定）；未采纳的备选方案（生成结果缓存、扫描并发提速、材料瘦身）记录于本轮优化记录，可按需再议。
- **向量索引后台化**：索引为后台异步，生成初稿前如索引未完成会自动降级为纯词法检索（既有兜底）；大 PDF 解析（pdf-parse 同步 CPU）仍短暂占用主进程。
- **FTS5 中文全词检索受限**：unicode61 对中文按单字分词；资料列表关键词过滤英文正常、中文受限（RAG 检索走 bigram 打分不受影响）。
- **网页资料库实站效果**：站点抓取（网络/反爬/栏目结构）依赖真实环境，需用户注册站点后实测。
- **better-sqlite3 原生模块分发**：首次 `npm install` 需要编译工具（node-gyp/VS Build Tools）；electron-builder 打包配置 `nativeRebuilder` 保证跨机器可运行。
