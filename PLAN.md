# Project Plan

本计划基于 `AGENTS.md` 制定。本项目为**单人开发**，`Team Responsibilities` 中的模块划分是代码组织边界，不涉及多人协作。设计文档位于 `docs/`（数据模型 `data-model.md`、共享契约 `shared-contracts.md`、UI 架构 `ui-architecture.md`），与代码同步维护。

> **2026-08-19 文档整理说明**：原文件按时间追加了大量已完成任务的详细记录（含多次修订过程），本版将已完成阶段的冗杂过程合并为「已完成阶段摘要」，保留对后续开发仍有价值的方案结论与根因；详细历史仍可在 Git 提交记录中回溯。**未完成的 Last Phase（收尾阶段，原 Phase 5）保持完整规划。**

## 目录

- [Team Responsibilities（模块职责范围）](#team-responsibilities模块职责范围)
- [已完成阶段摘要（Phase 1 – Phase 3.7）](#已完成阶段摘要phase-1--phase-37)
- [Phase 6: 三段式撰写重构](#phase-6-三段式撰写重构资料汇编--行文规范--初稿2026-08-25-规划中)
- [Phase 6.x 网页资料库后续优化](#phase-6x-网页资料库后续优化)
- [Phase 7：生成汇编功能区重构（连续文档 + 人机协同编辑 + 版本管控）](#phase-7生成汇编功能区重构连续文档--人机协同编辑--版本管控2026-09-10-草拟决策已敲定实施中)
- [Last Phase（收尾阶段）：Acceptance & Packaging](#last-phaseacceptance--packaging收尾阶段全项目最后执行)
- [Project Completion Criteria](#project-completion-criteria)


## Team Responsibilities（模块职责范围）

| 模块 | 主要职责 | 主要交付 |
|---|---|---|
| 桌面框架与界面 | 桌面应用框架、资料管理界面、撰写编辑器、交互状态 | 应用骨架、资料/撰写各功能页面、片段级审核 UI |
| 资料解析与信源 | 文件导入解析、OCR、信源抓取、内容清洗、标签体系、工作区同步 | 结构化资料、来源快照、标签体系、网页资料库 |
| 数据与 AI 服务 | 本地数据库、RAG 检索、LLM Provider、初稿生成、来源标注、矛盾检测 | SQLite、向量/词法索引、生成与审校服务 |

> 全部任务由开发者本人负责。各模块共同维护共享类型和接口；修改共享类型或接口协议时，须同步更新所有调用方与相关文档。

---

## 已完成阶段摘要（Phase 1 – Phase 3.7）

### Phase 1：项目基础（已完成 2026-08-03）

Electron 43 + React 18 + TypeScript 脚手架（electron-vite）；三栏导航壳；preload 安全桥（sandbox + contextIsolation）；共享类型（`src/shared/types.ts`）与 IPC 通道契约（`src/shared/ipc.ts`，`ApiResult<T>` 统一错误返回 + ErrorCodes）；better-sqlite3 本地数据库 + 嵌入式迁移框架（Migration 001 含 10 张表 + FTS5 + 触发器）。**验证**：typecheck 零错误、单测、生产构建、窗口正常启动。

### Phase 2 / 2.1：资料收集闭环（已完成 2026-08-03~05）

- 文件导入（PDF/Word/TXT/MD/图片 OCR）+ 信源网址抓取（net.fetch + 正文清洗 + 稳定错误码）。
- 标签系统（独立 `source_tags` 关联）：CRUD、批量打标、相似标签建议（bigram Jaccard Top5）、多标签 AND 筛选；删除资料（右键 + 批量管理，二次确认）；移除标签颜色与"标签嵌入标题"机制（Migration 002/004）。
- 后续格式扩展：`.doc`（word-extractor）、`.wps`（按文件头签名分发 OOXML/OLE）、`.xls/.xlsx`（SheetJS 0.20.3 逐单元格展开）。

### Phase 2.2：工作区资料库（已完成 2026-08-06~09）

指定本地文件夹即资料库，全面替换"导入转存"（存量资料一次性迁移）。**关键方案**：
- **指纹映射**：sha256 + mtime/size 为"文件系统 ↔ 数据库"锚点（Migration 006），移动/重命名保留 id/标签/摘要。
- **实时同步**：chokidar 500ms 防抖增量对账（`reconcilePaths`）；聚焦 / 进入资料库 / 每分钟定时做确定性全量对账兜底（`auto-sync` 统一互斥排队，mtime/size 快筛，开销低）。
- **删除语义**：工作区删文件 → 直接删库（级联清理标签/向量/摘要；同内容哈希仍被其它路径占用视为重命名不删）；软件内删除 → `shell.trashItem` 回收站；改名 → 重命名原文件（重名加后缀、非法字符清洗）。
- **性能**：扫描/指纹/解析全异步（fs/promises + 分批让出事件循环）；向量索引改后台串行队列（列表秒出）；嵌入推理移入 worker_threads（`out/main/embed.worker.js`，WASM 单线程，崩溃/缺失回退主进程推理）。

### Phase 3.1：LLM Provider 配置（已完成 2026-08-05）

`llm:*` 四通道（list/save/delete/test）+ `settings:*`；safeStorage（Windows DPAPI）加密存密钥（列表只回 `apiKeySet`）；连通性测试（/chat/completions，错误映射 LLM 错误码）；"设为当前"默认 Provider。

### Phase 3.2：资料预处理与混合检索（已完成 2026-08-06）

- 本地向量嵌入 **BGE-small-zh-v1.5**（transformers.js + onnxruntime-web WASM，纯本地，`resources/models`）；模型/引擎不可用自动降级纯词法。
- 词法（bigram + 子串打分）/ 向量（余弦）双路召回（曾用 RRF 融合，后随 3.4.7 改为过滤式）。
- LLM 摘要索引（"整理资料库"手动触发；生成前自动补齐任务范围内缺摘要的资料，失败不阻断）。

### Phase 3.3 → 写作规范 skills（范本重构，2026-08-07 完成、2026-08-13 重构）

原"范本"功能：导入历年志书 → 本地统计 + LLM 提取三个正常小节行文范例（剔除目录页与概要/大事记/人物传等特殊模块）→ 生成初稿时注入提示词（标注"仅作体例与行文风格参考，不得作为史料引用"）。**2026-08-13 重构为"写作规范 skills"**：`writing_skills`（general/section，Migration 014）+ 任务 `skill_ids`；通用规范默认注入 system prompt，部类细则按标题匹配（`matchSectionSkills`）、智能匹配（`writing:suggestSkills`）或手动选择；范本 UI/IPC 移除。

### Phase 3.4：初稿连续显示与生成链路升级（已完成 2026-08-07）

- 初稿为**单个连续 TipTap 编辑器**（整稿 Markdown 渲染、800ms 防抖整稿保存、按标题行重建片段，`draft:updateContent`）。
- 生成检索升级：**摘要级粗筛**（无摘要资料保守保留）→ **chunk 级过滤式精检**——词法 score>0 或向量余弦 ≥0.3 的段落全部保留，**取消 Top-N/每源配额/800 字截断**；标题行（≤12 字短语等）剔除（修复"初稿只有标题无正文"根因）。
- 输出形态：整篇连贯正文（JSON `{title,content,error}` 契约，缺标题时大模型返回详细报错）；"重新生成初稿"（二次确认覆盖第 0 稿）；范本提取剔除目录页；生成超时 10 分钟；生成前自动整理范围内摘要。

### Phase 3.5：聊天式工作台（已完成 2026-08-08）

点击"新建任务"立即创建（标题默认"新建任务"、范围固定全部文件、右键重命名）；工作台 = 正文编辑器（右）+ 对话框（左，380px）；生成前主按钮「生成初稿」/生成后「发送」自由对话（注入当前初稿 ≤12000 字 + 最近 20 条历史，超时 5 分钟）；大模型选择持久化到任务；对话历史持久化（`task_messages` Migration 008）+ `llm_call_logs` 调用痕迹；生成阶段进度推送（文字 + 百分比 + 预计剩余时间）。

### Phase 3.6：预设大模型 + 获取 API key 指引（已完成 2026-08-09）

内置 DeepSeek v4 Flash/Pro + 智谱 GLM-4-Flash 三条预设（`src/shared/llm-presets.ts`）；设置页预设卡片（一键预填表单 / 弹窗教程 / 打开注册页，`app:openExternal` http/https 白名单）。

### Phase 3.7：矛盾检测与来源溯源（已完成 2026-08-10~11）

- **三次调用链路**：检索后**矛盾预扫描**（低温度 + 温度阶梯 0→0.3→0.7 重试；主题聚类 `clusterSourcesByTopics`（dice≥0.12）+ 整组窗口扫描（≤60000 字/窗，并发 2）+ 跨窗口合并去重；只扫"撰写实际用到的检索文段"——用户确认的取舍）→ **生成注入**"材料矛盾提示"（严禁合并/折中，分开并列表述或只取一种 + 正文插 `【矛盾#N】` 标注）→ **定位审查**（回填 `draftQuote/merged/inDraft` 与每个说法的采纳替换文句 `replacements`）。扫描/定位失败独立降级不阻断生成。
- **数据模型**：`draft_contradictions` + `contradiction_variants`（Migration 009，随 draft 级联删除）；`draft_generation_sources` 生成上下文（Migration 010）；`in_draft`/`replacement`（Migration 011）。
- **编辑器**：不可编辑内联节点 `contradictionMarker`（往返序列化 `【矛盾#N】`）；工具栏「矛盾」+「警告」按钮（不在正文的矛盾仅查看/忽略）；`ContradictionDialog` 单条对比/总览。
- **采纳 = 本地修订**：`draft:applyContradiction` 纯本地替换（from=draftQuote → to=replacement + 移除标注，失败状态不变，资料库只读）；编辑器 setContent 进 undo 历史 + 正文快照 Map，撤销/重做同步回退矛盾状态（`action="revert"`）。
- **文段来源询问**：右键选中文段 → `writing:askSource`（本地精确匹配 → 生成上下文溯源 → 过滤式检索 → LLM 兜底），回复 `#N` 按 refs 渲染为可点击链接；`sources:openPath`（工作区/导入路径解析，URL 走浏览器）。

### 网页资料库（已完成 2026-08-11~13）

注册站点（`web_sites` + `web_site_articles`，Migration 012）→ 生成初稿时自动"发现文章清单（BFS 栏目遍历，限 20 页/深度 2）→ 标题 bigram 宽召回（领域下位词兜底表，教育→学前教育核心词）→ 正文精确子串精过滤 → 增量抓取正文"，落库为任务绑定缓存（`sources.task_id`，Migration 013，删任务级联清理、不进资料库列表），与本地文件同等参与粗筛/矛盾检测/溯源。**实站抓取效果待用户注册站点后实测。**

### Phase 4：版本迭代与管控（已删除，2026-08-11）

产品范围收敛为"资料收集 → 撰写 → 初稿完成"，每个任务仅保留一稿（初稿）。代码层面移除 `version:*`/`draft:confirm` 与版本 UI/类型；数据库保留旧列不删（避免迁移风险）。"矛盾取舍"与"文段直接修改"已并入 Phase 3 实现。

---


---

## Phase 6: 三段式撰写重构（资料汇编 → 行文规范 → 初稿）（2026-08-25 规划中）

> 产品形态大改：把目前「输入要求 → 黑箱检索+矛盾+生成」一条龙，拆成**用户可见、可介入**的三个环节，每个环节仍以**对话框**为主要交互方式，中间结果与进度全程可见。
> **已确认决策（2026-08-25）**：
> - 资料汇编 = **本地宽召回 + AI 细读**；硬约束：**召回阶段宁多勿漏**（宁可给 AI 的提交物偏大，也不能把可能相关的材料筛掉；召回阈值放宽 + 相关来源整篇全分块，候选集规模对用户可见）。
> - 文档编辑器 = **深改现有 TipTap**（按成熟文档软件观感重做，不再要求在正文逐段标来源）。
> - 整体界面 = **三套风格全保留**（简洁明亮 / 明亮+深色可切换 / 古典公文风），发布版**内置主题切换**（用户可切换并记忆）；已产出单页交互预览供参考。
> - 三个环节 = **三个独立页面**，用户通过顶部「三步向导」点击切换显示（并非同一页面堆叠）；每步有「上一步 / 下一步」，对话框贯穿。
> - 三步入口 = **同一撰写工作台内的三步向导**（顶部步骤条，右侧内容区随步骤切换，对话框贯穿）。
> - 矛盾取舍 = **卡片级标注，必须完成取舍后才可进入下一步**。
> - 行文规范 = **整理现有通用规范并作为默认注入**；删除全部部类细则（预设 + 自建）；①之后、③之前的「指定行文规范」环节**本次仅预留数据结构与把规范文本传入③的通道**，不开发独立 UI。
> - 初稿来源 = **仅汇编层溯源**（正文不逐段标注来源，溯源收敛到资料卡片层）。
>
> 覆盖范围：本条规划落地后，新任务完整路径为「新建任务 → ① 生成资料汇编（审阅/取舍/确认）→ ② 行文规范（预留）→ ③ 生成志书初稿」；原「单次生成（内部完成检索/矛盾/生成）」链路退役，相关旧逻辑按需保留兼容或删除。

### Phase 6.0 数据模型与共享契约（Migration 016）

- 新增表：
  - `compilations`：`id TEXT PK`、`task_id TEXT NOT NULL REFERENCES writing_tasks(id) ON DELETE CASCADE`、`title TEXT NOT NULL`、`status TEXT NOT NULL DEFAULT 'drafting' CHECK('drafting','reviewing','finalized')`、`created_at/updated_at`。
  - `compilation_items`（资料卡片）：`id TEXT PK`、`compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE`、`position INTEGER NOT NULL`（时间排序）、`source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE`、`excerpt TEXT NOT NULL`、`ts TEXT NULL`（时间标签，如年份/时间范围）、`note TEXT NULL`、`extra_tags TEXT NOT NULL DEFAULT '[]'`、`kept INTEGER NOT NULL DEFAULT 1`。
  - `compilation_contradictions`（矛盾分组）：`id TEXT PK`、`compilation_id FK CASCADE`、`topic TEXT`、`kind TEXT`、`status TEXT CHECK('pending','resolved','ignored')`、`chosen_item_id TEXT NULL`；`compilation_contradiction_variants`（每组内各说法）：`id TEXT PK`、`contradiction_id FK CASCADE`、`item_id TEXT NOT NULL REFERENCES compilation_items(id) ON DELETE CASCADE`、`variant_text TEXT`、`source_id TEXT`。采用独立表（取舍持久化、可级联）。旧 `draft_contradictions` 保留（兼容初稿阶段，但生成链路不再在③里做矛盾扫描）。
- `src/shared/types.ts`：新增 `Compilation / CompilationItem / CompilationContradiction / CompilationContradictionVariant`（读取时 `sourceTitles/sourcePath` 由服务端 JOIN 填充）。
- `src/shared/ipc.ts`：新增 `compilation:*` 通道——`compilation:list/get/generate/updateItem/deleteItem/resolveContradiction/confirm/regenerate` 与进度事件 `compilation:progress`（含阶段/百分比/剩余秒/候选统计）；请求/响应均为 `ApiResult<T>`。
- preload / main handler / `docs/data-model.md`、`docs/shared-contracts.md` 同步。

### Phase 6.1 资料汇编生成服务（后端核心）

- **召回（宁多勿漏）**：以撰写标题/要求生成稳定主题词（复用 `extractTopicTerms`/`expandDomainHints`），在任务范围（资料库全部长期资料 + 网页资料库缓存文章）内做**宽松召回**：放宽词法 `scoreChunk>0` 与向量 `vecMinScore`（如 0.2）、摘要粗筛对“命中即保留”，并对**摘要相关来源取整篇全部有效分块**；候选集上限做防御（如 2000 块），上限内“宁可多”。候选统计（命中多少来源 / 多少块）经进度事件对用户可见。
- **AI 细读**：新模块 `src/main/writing/compilation-service.ts`，对候选集分窗提交 LLM，系统提示：判定相关性、提取时间标签、按主题去重、保留可溯源（强制引原文 + 来源编号 `#N`）、识别同一事实的相左说法；输出结构化卡片 JSON（`createJsonFieldStreamer` 仅流正文/摘要，原始 JSON 不刷屏）。失败降级：无 Provider / 调用失败 → 退回“本地候选直接成卡片 + 无矛盾标注”，不阻断。
- **矛盾标注**：在候选集（或 AI 细读命中的卡片集）上复用/改造现有 `scanContradictions`（窗口并发、温度阶梯、低温度确定性），产出矛盾分组并挂到卡片。
- **落库**：`insertCompilation` + `insertCompilationItems` + `insertCompilationContradictions`（事务），初始 `status='drafting'`；返回卡片列表（含来源标题/位置/时间标签）。

> **Status（2026-08-25）**：后端已完成——`compilation-service.ts` 实现全量召回（宁多勿漏）、AI 分窗细读、解析/合并/映射/时间排序、本地降级；`compilation:generate`/`regenerate` handler 已接入并推送 `compilation:progress`；新增 5 项单测（149 项全通过）。**真实 Provider 的 AI 细读与矛盾标注效果待用户实测**。
>
> **2026-08-25 性能优化**：AI 细读前新增**保守本地闸门** `recallCompilationCandidates`——把交给大模型的材料从"任务范围内全部段落"收敛为"与主题相关的来源及其相关段落"：① 来源级：仅保留有相关信号的来源（标题含查询词 / 任一段词法 score>0 / 任一段向量余弦 ≥ 0.1），完全无关的来源整篇舍弃（多数资料库含大量无关文件，这是减少窗口数的主因）；② 来源内：标题含任一查询词或来源较小且词法信号强 → 整篇保留（篇内不漏）；宽口径来源（如综合年鉴）只保留有信号的分块，删掉无关章节。向量低阈值路径兜底"字面无关但语义相关"段落（如含地点名的数据段），避免误删。升级后窗口数从 94 个（约 31 分钟）显著下降，具体幅度取决于资料库中无关文档占比。新增 4 项单测（153 项全通过）；typecheck/构建通过。
>
> **2026-08-25 相关性修正（用户实测反馈；随后按用户要求回调）**：① 此前 AI 细读提示词未注入用户实际撰写要求，模型按“志书汇编”泛化标准筛选，把“先进个人/优秀教师”等荣誉卡片纳入。现把 `instruction`（撰写主题与范围）注入 system/user prompt，模型按用户标题自行判断哪些事实相关并提炼卡片（**不再显式列举“排除荣誉称号/党建/后勤”等类别**）。② 词法闸门**回退为宽松粗筛**：仅剔除与标题无任何信号（词法 score==0 且无向量命中）的“肯定无关”段；有任意词法信号或向量语义 ≥0.1 的段都保留，交由模型细筛，避免“教育”单字对误判导致无关候选过多，也不因收紧而误删“公办园数量”这类相关但无字面重叠的段。③ 卡片不再展示“位置：第 N 段”注释（来源标题 chip + 逐字摘录已足够定位；该段落序号是单一来源内原始段落编号，对人类无意义且易误导）。
>
> **2026-08-25 大模型提取标题与粗筛关键词（用户提议）**：静态 `extractTopicTerms` 只取引号内核心词，无法覆盖“包含例如：…托儿所/招生/等级/占比”等细节词，导致粗筛可能漏掉仅含这些词、不出现“学前/幼儿园”的段（窗口偏少的原因之一）。现改为：先生成标题与粗筛关键词时**先调用大模型**（若已配置 Provider）——把用户完整撰写要求（“标题为…等方面”）交给大模型，由其提取标题 + 近义词/上下位词/专业词（并理解方志语境做扩展），返回 `{title,keywords}`；再据此生成 `coarseQuery`（词法粗筛）与 `vecQuery`（标题做向量查询）。解析函数 `parseKeywordExtraction`、本地兜底 `fallbackCoarseQuery`（extractTopicTerms + expandDomainHints）均已导出并单测；大模型调用失败或无 Provider 时自动回退本地兜底。新增 3 项单测（156 项全通过）；typecheck/构建通过。
>
> **2026-08-25 三段式细节修正（用户逐条反馈）**：① **段落划分**：粗筛改为按原始换行划分（新增 `chunkParagraphs`，仅剔除标题行、不按句/字数二次切分），避免把一句话从中间截断；AI 细读改成先判断相关性、再按时间/事实/条目做更细切分并输出完整事实摘录（不截断）。超长单段（>30000 字）在切窗时按句兜底拆分以防上下文溢出。② **矛盾取舍**：采纳某张卡后，后端自动删除该矛盾分组中未被采纳的卡片（级联清理对应 variant 行），前端重新拉取汇编同步删卡。③ **去除“生成资料汇编”阶段的写作规范**：移除输入框上方写作规范 UI（智能匹配/手动选择），并删除 `WRITING_UPDATE_SKILLS`/`WRITING_SUGGEST_SKILLS` 通道、handler、preload 方法与 `suggestSkillsForTask`/`parseSuggestSkillsOutput`；`writing_skills` 数据管理（规范页）与初稿生成侧自动注入保留。新增 2 项单测（chunkParagraphs、采纳删卡），共计 158 项全通过；typecheck/构建通过。
>
> **2026-08-25 对话持久化 + 矛盾稳定性 + 卡片 UI**：① **对话历史持久化**——`compilation:generate`/`regenerate` 处理器现在会把用户撰写要求写入 `task.userInstruction` 并 `addTaskMessage(instruction)`；前端在生成/重新生成后持久化助理摘要消息并 `reloadMessages()`；`load()` 从最新汇编的 `title` 恢复 `compilationInstruction`，因此关闭重开/切页后对话历史保留，“重新生成汇编”按钮也能正常取到要求。② **矛盾发现稳定性**——逐窗细读会漏掉“两个相左说法落在不同窗口”的跨窗口矛盾；新增**卡片级矛盾扫描** `scanCardContradictions`：细读产出最终卡片后，对精简卡片集再做一次低成本的 LLM 矛盾归类（`parseCardScanGroups`/`mergeContradictionGroups`），与窗口级矛盾合并去重，显著提升跨来源/跨窗口矛盾召回，且输入量小、不牺牲效率。③ **卡片 UI**——资料卡片改为每张独占一行；来源/编辑/删除收进卡片右侧的“…”下拉菜单（`menuFor` 状态）。新增 2 项单测（parseCardScanGroups、mergeContradictionGroups），共计 160 项全通过；typecheck/构建通过。
>
> **2026-08-25 任务自动改名 + 矛盾回收站**：① **自动改名**——`generateCompilation` 用大模型提取出标题后，若任务标题仍是默认“新建任务”，自动 `renameTask(taskId, extracted.title)`（用户仍可在中栏右键重命名）。② **矛盾回收站**——采纳/忽略某组矛盾时，除把未被采纳卡片“软删除”（`kept=0`，UI 隐藏）外，还把整组矛盾快照进新表 `compilation_recycle_bin`（Migration 017，引用 contradiction_id，随 compilation 级联删除）；右上角垃圾桶小圆钮进入回收站，可“恢复”某组矛盾——所有 variant 卡片改回 `kept=1`、矛盾状态回到 pending，并删除回收站条目。用软删除代替硬删除，**恢复不会重建卡片，避免重复卡片/卡片数异常**（单测验证恢复后卡片总数不变）。新增回收站 IPC（`compilation:recycleBin:list/restore`）、preload、Repository 函数与 UI。验证：typecheck 零错误、160 项单测、构建通过。

### Phase 6.2 资料卡片审阅 UI（Step 1）

- 撰写工作台顶部**步骤条**：①资料汇编 → ②行文规范 → ③生成初稿（②当前为“预留/占位”，仅提示）。
- 右栏「资料汇编」视图：卡片按时间升序；每张卡片显示——时间标签 chip、来源文件徽标（`sources:openPath` 可打开原文）、正文摘录、相关度/备注；操作：编辑、删除、打开来源；疑似矛盾卡片加“⚠ 矛盾”标记与分组。
- 左侧对话框贯穿：可就汇编与 AI 对话（如“仅保留 2010 年后的内容”），对话记录持久化。
- 矛盾取舍：点击矛盾标注 → 多说法对比弹窗（复用/改造 `ContradictionDialog` 交互），用户选择保留某张卡片（或“忽略”）；**未处理完的矛盾会阻止进入下一步**（finish 时校验 `resolved/ignored`，有 `pending` 则给出明确提示）。
- 「确认汇编」→ `status='finalized'`，锁定卡片（不可再增删/编辑，除非“重新生成汇编”）；Step 2/3 才可用。

> **Status（2026-08-25）**：前端已完成——工作台顶部三步向导（`writing-stepper`，未确认汇编时锁定 Step 2/3）、`CompilationStep` 卡片审阅（时间 chip/来源徽标/摘录/位置、编辑/删除/打开来源、矛盾分组内联取舍、确认按钮被未处理矛盾阻止）、左侧对话框贯穿（Step 1 生成汇编 / Step 2 自由对话预留行文规范 / Step 3 生成初稿）、`compilation:progress` 驱动候选统计与进度条。**端到端审阅/取舍/确认待用户实测**（本阶段为 UI，沿用项目内联单测惯例，未新增组件测试）。

### Phase 6.3 生成链路改造（Step 3 只基于最终汇编）

- `generateDraft` 改为接收 `{ taskId, compilationId, instruction }`：材料仅取该汇编的 `kept` 卡片文本（按时间排序、去重），**不再实时检索、不再做矛盾预扫描/定位**（矛盾已在 Step 1 处理；初稿来源只到汇编层）。
- 上下文：通用规范（`resolveTaskSkills` 改为仅通用规范，删除部类细则注入）+ 用户要求 `instruction`（含风格文本）。
- 保留：流式输出（`onDelta` + `createJsonFieldStreamer`）、进度事件（`draft:generateProgress`，阶段：整理汇编 → 准备上下文 → 生成 → 完成）。
- 重生成：基于同一 `compilationId` 重跑；「重新生成汇编」在 Step 1 触发（重新生成会覆盖当前汇编并回到 drafting，需二次确认）。
- 落库：初稿仍为 Draft/Segments；本次仅做“汇编卡片 → 初稿”统计，不逐段标来源。

> **Status（2026-08-25）**：链路已完成——`generateDraft`/`regenerateDraft` 新增可选 `compilationId`：提供已确认汇编时仅取 `kept` 卡片文本（按时间排序）作为材料，跳过摘要/网页/检索/矛盾扫描；流式输出与进度事件复用现有机制；未提供 `compilationId` 时保持旧检索链路兼容。**2026-08-25 第三步落地**：① 移除工作区底部「上一步 / 下一步」按钮，导航只通过顶部三步向导；② Step 3 提交物固定为「已确认汇编的 kept 卡片（已剔除矛盾取舍排除的卡片）＋ 第二步默认行文规范 ＋ 可选参考范本」，`buildUserPrompt` 按「用户要求 → 写作规范 → 参考范本（可选）→ 参考材料（来自已确认汇编）」组织，并提示严格遵循规范、仅依据材料撰写；材料区标注其来源为已确认汇编、已剔除矛盾排除卡片。新增 2 项单测（参考范本注入、材料来源标注）。验证：typecheck 零错误、165 项单测、生产构建通过。**真实大模型生成初稿待用户实测**。

### Phase 6.4 行文规范简化（删除部类细则 + 合并通用规范为默认规范）（已完成）

- **删除整个「写作规范 skills」模块**前后端：删除 `SkillsManager`/`SkillPickerDialog`、`writing-skills.ts` 仓储、`skills:*` IPC（list/create/update/delete）、preload 方法与 `WritingSkill` 类型；移除「规范」页导航；Migration 018 `DROP TABLE writing_skills` 并清空 `writing_tasks.skill_ids`。[^既有 `skill_ids` 列保留，仅清空]
- **仅保留两篇通用规范（志书文体文风 + 志书行文规则）**，合并为**一篇默认规范** `DEFAULT_STYLE_GUIDE`（`src/shared/style-guide.ts`），作为默认规范**注入第二步（行文规范）显示**，并在生成初稿时作为全局写作约束注入 system/user prompt；`resolveTaskSkills`/`listSectionSkills`/`matchSectionSkills`/`formatSkillsText` 移除，生成侧不再按部类细则注入。
- 验证：typecheck 零错误、159 项单测、构建成功。

### Phase 6.4.1 规范文档库与第二步文本编辑器（2026-08-25 构思）

> 把「指定行文规范」做成真正的**规范文档库**：多篇规范文档可持久化、重命名、修改，并可指定其中一篇为**默认注入规范**（初始为合并后的「志书文体文风与行文规则」）。风格参考设置页。

- **数据模型**（Migration 019）：`style_guides` 表——`id TEXT PK`、`name TEXT NOT NULL`、`content TEXT NOT NULL`（Markdown）、`is_default INTEGER CHECK(0,1)`（全局唯一默认）、`created_at/updated_at`；启动时若表为空自动写入 `DEFAULT_STYLE_GUIDE` 作为默认规范。
- **IPC**：`styleGuide:list/get/save/setDefault/delete`（save：给出 `id` 为覆盖、不给为新建；`setDefault` 指定默认注入的规范；`delete` 删除，若删的是默认则回退到剩余第一篇，无则生成侧回退 `DEFAULT_STYLE_GUIDE`）。
- **第二步界面（StyleGuideEditor）**：右侧为文本编辑器（textarea）展示当前（默认）规范内容；右上角按钮「**导入已有规范作为底稿**」——选择已保存的某篇规范 → **二次确认**（提示会替换编辑器全部文本）→ 载入作为底稿；右下角按钮「**保存规范**」——弹出「选择保存方式」：已有规范列表 + 空白「+」项；点已有项 → 提示「**选择覆盖现有规范**」→ 覆盖；点「+」→ 提示「**另存为新规范**」→ 输入新名称另存。保存后刷新列表；每篇规范可「设为默认」；列表支持重命名。
- **入口按钮**：撰写工作台头部、回收站按钮**左侧并列一个“规范”入口**，进入/退出第二步的规范编辑视图。
- **生成侧**：`generateDraft` 生成初稿时读取当前默认规范（`getDefaultStyleGuide()?.content`，无则回退 `DEFAULT_STYLE_GUIDE`）注入 prompt，不再使用硬编码常量。
- **验收**：可新建/覆盖/重命名/删除多篇规范；默认规范可切换并真正注入生成；导入底稿有二次确认；保存流程符合「覆盖 / 另存」二选一；typecheck/单测/构建通过。

### Phase 6.4.4 资料卡片「提纯」（细读 → **提纯** → 修正 → 矛盾，2026-09-08 新增，已完成）

> 用户实测反馈（以「高中教育3」真实数据为据）：切片策略是「尽可能把一整段内容作为一张资料卡片」，导致大量卡片只有一两句与主题相关、其余与标题毫无关联。实测该汇编 **191 张卡片 / 48,063 字中，相关句仅约 14,914 字（31%）**，无关约 33,149 字（69%）；**51 张卡片（27%）通篇无一句相关**；典型无关内容是《长乐年鉴》的民生支出、老区扶贫、计生协、学校建设项目（幼儿园/小学为主）等。噪声直接稀释了矛盾检测与第三步初稿材料。
>
> 因此新增一道**大模型提纯**工序：把细读产出的整段卡片交给大模型阅读理解，**摘录**出与任务主题确有关系的句段、舍弃无关部分，得到更细粒度、更纯净的卡片集。

- **阶段位置**：`关键词提取 → 网页检索 → 本地宽召回 → 保守闸门 → AI 分窗细读 → 提纯 → 修正 → 卡片矛盾扫描 → 落库`。提纯置于**修正之前**（用户确认）：修正的「标记 + 回退」始终与最终卡片一对一，无需迁移修正记录；同时修正与矛盾扫描的输入从整篇降到约 1/3，净增成本只有提纯这一趟 pass。`CompilationResumeState.phase` 扩为 `window | purify | repair | contradiction`，纳入 `compilation:continue` 断点续跑（只重跑未完成批次）。
- **两条硬约束**（用户确认）：① **严格逐字摘录** —— 片段必须是父卡片原文中连续出现的一段，本地用「去空白归一化子串匹配」校验并回取**原文真实子串**（含原始排版空格），校验失败的片段丢弃；某卡片全部片段校验失败 → **保留该原卡**（宁多勿漏，绝不丢材料）。② **不做内容拦截** —— 由提示词判定、代码侧只统计不干预（不设丢弃比例阈值）。
- **失败与预算**：无可解析输出 / LLM 异常 / 超阶段预算时，未提纯的卡片一律**按原样保留**并透出 `purifyScan:{ok:false,message}`；异常中断走既有「尝试继续」。
- **黑箱定位**（用户确认）：不新增列/表、不保留提纯前原文、不做「查看原段」UI；提纯结果不支持单独回退，需要退回时用「重新生成汇编」。被提纯舍弃的内容不入回收站。
- **实现**：新增 `src/main/writing/purify-service.ts`（`buildPurifyCandidates` / `splitPurifyBatches` / `buildPurifyMessages` / `parsePurifyOutput` / `locateSpans` / `snapSpansToSentenceBounds` / `resolvePurifiedSpans` / `coalesceSpans` / `purifyBatch` / `applyPurifyOutcome` / `mapVariantThroughPurify` + 11 项内联单测）；`compilation-service.ts` 新增 `runPurifyPhase`、进度重排（细读 12→66%、提纯 67→77%、修正 78→87%、矛盾 88→99%）、窗口级矛盾说法经提纯映射（`mapWindowGroupsThroughPurify`，否则落库按 excerpt 匹配不到卡片会整组丢失）；前端生成汇总展示提纯前后卡片数/字数、保留比例与「未获提纯结果、已按原样保留」的卡片数。
- **规模实测（离线按句级摘录估算）**：48,063 字 → 约 16,197 字（34%）；卡片 191 张 → 166 张（连续相关句合并）或 214 张（逐句成卡）；44–51 张整卡因通篇无关被丢弃。

> **Status（2026-09-10 实测复议与改造，已完成）**：用户用真实 Provider 复跑同类任务（「高中教育4」：253 张卡 / 48,213 字）后反馈「无关内容仍大量存在」「卡片文字残缺」「提纯超预算」。复盘实测数据：**相关字占比只从 31%（高中教育3）升到 40%**，离目标（≥70%）很远；提纯 8 次调用输出 65,441 字 ≈ 输入材料的 70–75%（只删了约 1/4，应删约 2/3）；`compilation-purify` 8 批**严格串行**耗时 610s（细读 19 窗 1,331s 计算量靠 4 路并发墙钟仅 411s），第 9 批超 600s 预算被整批按原样保留；第 9 批之外的漏答/解析失败降级**完全没有日志**。三项改造（用户逐项确认）：
> 1. **口径收紧为「写通测试」**：提示词从「只要有可能的联系就保留、拿不准的一律保留」改为「设想这段文字会不会写进题为《主题》的志稿正文」——同为教育大领域但对象/学段/业务不是本主题的（幼儿园、小学、义务教育、教师聘任表、文明校园评比等）一律删除；判定依据是「志稿正文会不会用到它」，而不是「有没有一点点关系」。
> 2. **本地句读吸附** `snapSpansToSentenceBounds`：模型返回的片段起点若在词中/半句中则**向左扩到句读边界**，终点若不以句末标点收尾则**向右扩到句末标点**（含收尾引号/括号），**只向外扩、绝不向内收缩**（不丢任何字符）；外扩上限 `PURIFY_SNAP_MAX_CHARS=200`，超限则保持原样。实测该缺陷规模：181 张可在来源中定位的卡片里 **43 张起点不在句读边界**（如 `心扑在…` 被截掉了「一」）、**11 张结尾是半句**（如 `…被省高职院校录取 498 人`）——且这些卡片**都没有修正记录**，说明旧修正阶段的判定条件根本覆盖不到句子完整性。残留的缺主语/指代不明交由修正阶段补全。
> 3. **性能与可观测**：批次 30→**50 张 / 18000 字**、整阶段预算 600s→**900s**、调用由**串行改为按 Provider 并发数并行**（与细读一致；续跑改用 `purifyDoneBatches` 集合）；**去掉 `reason` 字段**（黑箱用不到，实测占输出 25–30%）；新增**漏答重问**（模型漏答的卡片单独小批补问一次）与**解析失败换温度重试一次**；新增逐批诊断日志（输入卡片/字数、返回条目数、保留卡片/字数、整卡丢弃、漏答、原样保留、校验失败片段、句读吸附处数、重试次数）与 `purifyScan.passthroughCards` 透出。预期提纯墙钟 519s → 约 180s。
>
> **验收**：typecheck 零错误、228 项单测通过（总计 229，1 项 watcher chokidar 环境失败为既有问题）、生产构建成功。**待用户用真实 Provider 复跑同类任务复核：相关字占比目标 ≥65%、最终字数目标 ≤30,000、卡片边界不合格数目标 0、缺年份时间戳目标 0、提纯全部批次跑完且墙钟 ≤200s。**

### Phase 6.4.3 资料卡片「大模型修正」（原「二次加工/语义补全」，2026-09-08 改版，已完成）

> 用户需求变更：① 修正不必再由用户逐条裁定「采纳/不用」，改为**默认全部应用**，只在卡片上留标记，用户点标记查看修正前原文与理由并决定是否回退；② 修正流程**提前到矛盾检索与归集之前**，使提交给大模型做矛盾检测的卡片内容更清晰完整；③ 回收站不再包含该类条目（改由卡片标记承载）。

- **流程位置**：生成管线内串行 —— `关键词提取 → 网页检索 → 本地宽召回 → 保守闸门 → AI 分窗细读 → 【大模型修正】 → 卡片矛盾扫描 → 落库`；`CompilationResumeState.phase` 扩为 `window | repair | contradiction`，异常中断由 `compilation:continue`（「尝试继续」）续跑，**只重跑未完成的修正批次**（已完成批次结果保留在 state 中）。
- **默认应用**：修正文本直接在管线内写入卡片（`applyRepairOutcome`），矛盾的候选预筛/扫描因此面对语义完整、时间戳齐备的卡片；缺失时间戳仍在同一阶段**静默补齐**（用户确认：不算“修正”，无标记、不可回退——但随管线前移，落库按时间排序自然正确）。
- **落库**：`compilation_repairs`（Migration 029 重建，status CHECK `('applied','reverted')`）由 `insertCompilationItems` 与卡片**同事务**写入；修正记录以 `CompilationItemInput.repair` 随卡片流经来源过滤与按时间排序，保证标记与卡片严格对应。Migration 029 同时 `DROP TABLE compilation_repair_recycle_bin`，并把老数据迁移为：accepted→applied；pending→applied 且写入卡片；rejected→丢弃。
- **IPC**：删除 `compilation:repairScan` / `compilation:repairs:list` / `compilation:repairs:decide`，新增 `compilation:repairs:revert`（回退到修正前）与 `compilation:repairs:apply`（重新应用）；二者均登记撤销栈。`compilation:generate` 结果新增 `repairScan:{ok,message}`（超出阶段时间预算时提示「修正未完成」）。
- **可靠性**：分批（30 张 / 12000 字，`splitRepairBatches`）串行 + 单批 300s 超时 + 整阶段 900s 预算；上下文改用**同来源相邻段落**（卡片本身即整段，旧的「来源全文 ±120 字」窗口等价于无上下文）；窗口级矛盾的 variant 文本同步改写（`remapRepairedVariantExcerpts`），否则落库按 excerpt 匹配不到卡片会整组丢失。
- **前端**：卡片 meta 行新增可点击标记「✎ 经过大模型修正」（回退后转灰「↺ 已回退到修正前」），点开「大模型修正详情」弹窗（修正前原文[灰/删除线] / 修正后文本[绿] / 修正理由 + 回退或重新应用按钮），卡片「…」菜单也提供入口；回收站弹窗由三类降为两类（资料卡片 / 矛盾）；生成完成汇总提示「N 张经过大模型修正」。
- **验收**：typecheck 零错误、214 项单测通过（1 项 watcher chokidar 环境失败为既有问题）、生产构建成功；修正阶段位于矛盾扫描之前（进度条顺序体现）；卡片标记可查看/回退/再次应用；回收站仅剩两类。**真实 Provider 下的修正质量与回退体验待用户实测。**

> **Status（2026-09-10 补充：时间戳必须含年份 + 补全残缺句/指代，已完成）**：真实数据实测发现 **253 张卡片中有 12 张时间戳只有月日没有年份**（`5 月 19 日`、`7—9 日`、`9 月 13 日`、`十三五规划期间`…），**全部没有修正记录**，且 0/12 在自身正文中含 4 位年份。根因是旧提示词只处理「时间显示为『无』」，把「有月日无年份」当成了有时间戳。改造：
> - **提示词**：时间补齐范围扩为「（a）时间为『无』；（b）时间**缺少年份**」两种情形，明确「志书的时间标注**必须含年份**」，并要求结合上下文与来源年鉴年份（如《长乐年鉴2019》→ 2018 年）推断；**确无依据时不给 ts，不得编造年份**。
> - **本地两道校验**（`hasYear` / `shouldFillTs`）：模型给出的 ts **不含 4 位年份一律不采纳**（并计入 `tsRejected` 诊断）；卡片已有含年份的 ts 一律不覆盖；**缺年份的旧值允许被覆盖**（`applyRepairOutcome` 同步放宽）。
> - **残缺判定**：提示词补充「（a）句子起点或终点不完整（从词中间/半句话开始、以半句话结束）；（b）缺少主语、谓语或宾语；（c）指代不明（他/其/该校/该年而摘录与上下文均看不出指代对象）」等情形，并明确「**优先补全，不要删**——只有确实无法补全时才可删去该残缺部分并在 reason 中说明」（旧实现中模型多次直接删掉残缺数据，等于丢材料）。
> - **验收**：typecheck 零错误、228 项单测通过（总计 229，1 项 watcher chokidar 环境失败为既有问题）、生产构建成功；新增 2 项内联单测（缺年份 ts 识别与采纳规则、提示词要求）。**待用户实测：12 张缺年份 ts 应补齐为含年份形式、残缺卡片应被补全而非删除。**

### Phase 6.4.2 第二步「添加范本」（2026-08-25 构思）

> 在第二步「指定行文规范」中增加一个**可选的「添加范本」**：用户可录入一段自己的志书示例正文，作为第三步生成初稿时的**体例与行文风格参考**，与行文规范、资料汇编一并作为提交物。

- **数据模型**（Migration 020）：writing_tasks 增加 model_text TEXT NULL 列，保存任务级范本正文（可选）。
- **IPC**：writing:getModelText（{ taskId } → { text }）与 writing:setModelText（{ taskId, text } → { text }），preload 暴露 getModelText / setModelText。
- **UI（StyleGuideEditor 增加 taskId 时显示）**：工具栏「**添加范本**」按钮置于「导入已有规范作为底稿」**左侧并列**；点击展开**范本窗口**（可折叠，展开/收起逻辑参考第一步矛盾窗口——展开显示文本框 + 固定在底部的「▲ 收起」；收起时若有内容显示「范本 ▼」条）。录入自动防抖保存到任务；头部「规范」弹窗（无 taskId）不显示该按钮。
- **生成侧**：generateDraft 读取 task.modelText，非空时在 buildUserPrompt 中注入【参考范本】区块（与【写作规范】【参考材料】并列），并提示模型参考其体例与行文风格。
- **验收**：范本可录入/折叠/展开/自动保存；生成初稿时 prompt 含【参考范本】与范本内容；不填范本时 prompt 不含【参考范本】；modal 文本编辑区高度拉大（80vh）；typecheck/单测/构建通过。

### Phase 6.5 前端工作台重构（三步向导 + 商业化风格，先出预览）

- **UI 风格方案（已确定）**：三套风格（简洁明亮 / 明亮+深色切换 / 古典公文风）已评审选定，交互预览已作为临时工作痕迹删除；方案要点固化在本计划中。
- **落地为正式功能**：三套风格全保留，发布版内置**主题切换**（设置项持久化）；三个环节为**独立页面**，通过三步向导点击切换（每步含「上一步/下一步」），并非同页堆叠。
- 选定风格细节后重构：撰写任务页顶部步骤条 + 主区域随步骤整页切换；左侧对话框 + 右侧内容区；整体配色/排版/间距/圆角/阴影统一；滚动条、动效、空态、加载态按商业软件标准；旧版“参考范本 / 部类细则 / 版本”等入口清理。
- AI 过程可见：检索/AI 细读/矛盾扫描用进度事件 + 流式输出；Step 1 可将 AI 细读结论以卡片实时追加；Step 3 流式正文。

> **Status（2026-08-25）**：已完成——三套主题落地并可在**设置页「外观（主题）」区块三选一**（简洁明亮 / 明亮+深色 / 古典公文风），通过 data-theme 注入 html 切换 CSS 变量并 localStorage 持久化记忆；三步向导 + 左右分栏 + 顶部步骤条已按商业风格落地（配色/间距/圆角/阴影统一、动效/滚动条/空态/加载态完善）。验证：typecheck 零错误、165 项单测、生产构建通过。

### Phase 6.6 初稿编辑器升级（深改 TipTap）

- 目标观感接近成熟文档软件：正文衬线（宋体）排版、最大阅读宽度、标题层级、页边距、目录/页脚字数统计、撤销重做、打印友好工具栏。
- 保留：Markdown 存储、800ms 防抖整稿保存、`draft:updateContent`、右键菜单（复制/粘贴/全选等）。
- 由于“仅汇编层溯源”，正文不再需矛盾/来源节点，可移除矛盾标注相关扩展（按需保留旧数据兼容）。

> **Status（2026-08-25）**：已完成——初稿编辑器深改：正文衬线（宋体/Noto Serif SC）排版、760px 最大阅读宽度、标题层级、页边距与 @media print 打印友好、页脚字数统计、撤销重做工具栏、保存状态；保留 Markdown 存储/800ms 防抖整稿保存/draft:updateContent/右键菜单。矛盾标注扩展保留（兼容旧稿，不阻断）。验证：typecheck 零错误、165 项单测、生产构建通过。

### Phase 6.8 按步骤分别指定大模型（2026-08-25，已完成）

> 用户澄清：本功能是**设置界面**为「第 1 步（资料汇编）」与「第 3 步（生成初稿）」各设一个**默认大模型**（从已配置的 Provider 中选取），而非按任务、也非在撰写工作台内切换。第 2 步（规范/范本编辑）无 LLM 调用。

- **数据**：`AppSettings` 新增 `compilationProviderId` / `draftProviderId`，对应 `settings` 表 key `compilation_provider_id` / `draft_provider_id`（key-value，无需迁移；保存/清空时校验 Provider 存在）。
- **Provider 解析**：`resolveTaskProvider(task, step)` 优先级为——`task.llmProviderId`（任务固定）→ 步骤默认（第 1 步用 settings.compilationProviderId、第 3 步用 settings.draftProviderId）→ 全局当前 Provider；`generateCompilation`（第 1 步）、`generateDraft`（第 3 步）分别按各自默认解析，对话维持现有回退。
- **UI**：设置页新增「**步骤默认模型**」区块（中栏导航新增「步骤默认模型」），两个下拉分别选第 1/3 步默认模型，选项为已配置 Provider + 「未设置（回退任务/全局）」；保存即时生效。
- **验收**：第 1/3 步可分别选不同默认模型并真实生效（生成汇编 / 生成初稿分别用所设 Provider）；未设置或任务已固定时按「任务 → 步骤默认 → 全局」回退；typecheck 零错误、166 项单测、构建通过。

### Phase 6.7 测试、文档与发布（已完成）

- 更新 `docs/{data-model,shared-contracts,ui-architecture}.md`、`PLAN.md`（本阶段标记完成）、`README.md`、`agents.md`（决策与近期记录）。
- 全量验证：typecheck 零错误 / 单测（预计 150+）/ 生产构建；端到端演示：选工作区 → ① 生成汇编（召回+细读+矛盾）→ 审阅取舍 → 确认 → ② 规范（预留）→ ③ 生成初稿（流式）→ 编辑保存。
- 视达成度发布新版本（如 `v0.2.0`），配置 GitHub Actions release（沿用 v* tag 触发）。

> **Status（2026-09-06）**：已完成——文档同步至当前三段式代码现状（`docs/{data-model,shared-contracts,ui-architecture}.md` 更新资料汇编/二次加工/回收站/规范库/按步骤默认模型/网页资料库优化/PDF cmaps；`README.md` 功能与技术实现更新；`PLAN.md` 标记本阶段完成、将 Phase 5 重命名为 **Last Phase（收尾阶段）** 避免序号歧义；`AGENTS.md` 同步当前状态与近期记录）。验证：typecheck 零错误、单测 190 项通过（1 项 watcher chokidar 环境失败为既有问题）、生产构建成功。端到端真实大模型生成/矛盾取舍/站点抓取仍需用户实测。

### 验收标准汇总

- **6.0**：迁移可重复、级联删除正确；类型/IPC/preload/main 对齐；typecheck 零错误、新增 ≥4 项单测、构建成功。
- **6.1**：给定真实标题（如“学前教育中的园所设置”）产出按时间排序的卡片列表，每张含来源+位置+时间标签；**召回不丢相关材料**（用含近期数据/无字面重叠的样例验证仍能召回）；矛盾分组正确；无 Provider 时降级返回本地候选不阻断；typecheck/单测（新增 ≥5 项）/构建通过。
- **6.2**：卡片按时间返回、来源可打开；编辑/删除持久化、重启保持；矛盾取舍后解锁下一步；存在未处理矛盾时确认被阻止并提示；typecheck/单测（新增 ≥3 项）/构建通过；端到端可审阅并确认。
- **6.3**：用已确认汇编生成连贯初稿；材料与汇编完全一致（无库外内容）；流式输出 + 进度可见；重生成不重检；缺标题等必要信息时大模型详细报错；typecheck/单测（generate 相关 ≥6 项）/构建通过。
- **6.4**：规范页仅显示通用规范；生成仅注入通用规范；任务无部类细则选择；迁移后无 section 残留；typecheck/单测/构建通过。
- **6.5**：UI 预览 2–3 套交付并选定风格；三步向导状态正确；各步过程可见（进度+流式）；无死链；typecheck/构建通过；端到端走完三步。
- **6.6**：编辑器观感达到选定样板；Markdown 存储/防抖保存/撤销重做正常；typecheck/构建通过。
- **6.7**：文档与代码一致；三项验证通过；端到端闭环可用；发布产物可安装。

## Phase 6.x 网页资料库后续优化（D8/E10/E11 已完成 2026-09-01）

在已完成 **A1（sitemap 优先发现）/ A3（URL 规范化去重）/ B4（条件请求）/ C6（robots + 礼貌限速）/ A2（RSS/Atom 订阅源）** 的基础上继续：

- **D8 成熟正文提取器 + 降级** ✅：新增 extractArticleText(html)——优先 article/main/正文容器，保留表格（单元格→制表符、行→换行）、去 script/style/nav/footer/aside；抓取正文用它做 cleanedText，过短自动回退浏览器净化的 stripHtml（诊断日志标注提取器=extractArticleText/stripHtml）。单篇失败保留标题+链接并跳过，不阻塞整站。
- **E10 发布时间排序** ✅：新增 extractPublishedDate(html) 解析 meta（published_time/publishdate/pubdate/date）、<time datetime>、可见日期文本；抓取后写 web_site_articles.published_at（Migration 025），文章清单按 COALESCE(published_at, discovered_at) DESC 排序，与资料汇编时间排序一致。
- **E11 领域词表自动化** ✅→已撤销（2026-09-01）：曾落地「用户按站点配置关键词」（parseSiteKeywords + web_sites.keywords + IPC webSource:updateKeywords + WebSourcePanel 输入），应产品要求**移除站点关键词功能**——Migration 026 删除 keywords 列，IPC/preload/UI/召回逻辑一并删除。「已抓文章标题词频/聚类自动扩充」进阶方案未实现。

## Phase 7：生成汇编功能区重构（连续文档 + 人机协同编辑 + 版本管控）（2026-09-10 草拟，**决策已敲定，实施中**）

> **Status**：计划已评审，7.9 的六项决策已由用户裁定（2026-09-10）；按「一阶段一验收」推进。本阶段**推翻 Phase 6 的「资料卡片」模型**：把「生成汇编」功能区从"卡片列表 + 事后批量调整"改造为"**连续文档（Markdown）+ 悬浮对话框人机协同编辑 + 版本差异管控**"。

### 7.0 需求与设计总纲

**用户需求（2026-09-10，六点）**：

1. **汇编形态**：前端呈现为**一篇连续文本**；每段**开头注明时间（必须含年份）**，每段**末尾带来源标记**（含数字的小圆形 = 该段来自资料库中的第几篇文章）。
2. **放宽提取限制**：允许大模型主动**裁剪、整合**每个候选文段中"能够写进《撰写标题》志稿"的内容（不再要求整段保留、不再禁止组织与提炼）——现行管线为保文本完整性做的约束，正是"每段掺入大量无关内容"的根因。
3. **交互模式改变**：右栏为**文本查看器**（展示当前汇编）；一个**悬浮圆按钮**唤出与大模型的对话框，用户提出修改要求 → 大模型修改汇编 → 查看器自动更新为修改后状态。
4. **查看器的特殊渲染**：Markdown 呈现 + 段尾来源标记；并计划**版本管控**（直观看到当前版本相较上一版有哪些修改）。
5. **时间排序**：汇编仍须按时间排序（需在"每段必须含年份"的前提下定义排序机制）。
6. **交互协议**：规定软件 ↔ 大模型之间"以什么格式返回修改、以什么格式返回回答、软件如何校验与应用"。

**设计总纲（职责重划）**：

- **细读 = 只筛选**：宁多勿漏地挑出"可能相关"的候选文段，保留来源归属（不再让它产出终稿素材）。
- **整合提取 = 裁剪 + 补全 + 整合**（新增阶段，吸收原「提纯」+「修正」）：产出可直接作为志稿素材的**干净段落**——每段**单一来源**、段首**含年份的时间**、段尾**来源编号**；允许删减无关内容、允许同来源内的合并与语序调整、允许补全主语/指代（「他/该校」→具体名称）。
- **矛盾扫描 = 不变**：在干净段落上比对同一事实的不同说法。
- **所有修改统一走「版本 + 操作协议」**：无论大模型对话编辑、矛盾采纳还是（若保留）用户手动编辑，都产生**一个新版本**——"可对比、可回滚、可审计"由版本体系天然提供，替代现行的内存快照式撤销栈。

### 7.1 数据模型与迁移（Migration 030–032）

> **Status（2026-09-10）**：**已完成**（Migration 030 新增列/表 + 031 JS 回填；破坏性 032 按计划推迟到 7.7）。
> 交付：`compilation_items` 段落元数据 9 列、`compilation_sources` / `compilation_versions` / `compilation_messages` 三张新表；
> 新增纯函数模块 `src/main/writing/compilation-document.ts`（`parseTimeLabel` / `renderDocumentMarkdown` /
> `buildParagraphSnapshot` / `summarizeParagraphChange` / `sortParagraphsByTime`，5 项内联单测）；
> 仓储层新增 `ensureCompilationSources`（编号只增不回收）、**`upsertCompilationParagraphs`（保留段 id）**、
> `listCompilationSources` / `insertCompilationVersion` / `snapshotCompilationVersion` / `getCompilationVersion` /
> `listCompilationVersions` / `insertCompilationMessage` / `listCompilationMessages`（4 项内联单测）；
> `connection.ts` 新增 030/031 迁移回归测试（覆盖「有年份/只有月日/日区间/无年份」四种时间形态）。
> **真实库副本演练结果**：迁移前 `maxVersion=29`、5 份汇编、646 张卡片、无 `year` 列 →
> 迁移后 `maxVersion=31`，**无编号段 0 条**、有年份段 611 条、时间待核段 35 条、来源编号行 24 条、
> 版本 5 个（= 有卡片的汇编数）、数据零丢失、`PRAGMA integrity_check = ok`、抽样校验"版本段落数 = 汇编段落数"
> 且"markdown 行数 = 段落数"（一段一行）且段落 id 与卡片 id 完全一致。
> 验证：typecheck 零错误、**238/239 单测通过**（1 项 watcher chokidar 环境失败为既有问题）、生产构建成功。
> **界面未改动**（仍旧卡片视图，无功能退化），符合 7.1 的独立验收口径。

**7.1.1 `compilation_items` 升级为「段落」**（保留表名与既有列，新增列；沿用 `excerpt` 作为段落正文，`ts` 作为段首显示时间）：

| 新列 | 语义 |
|---|---|
| `year` / `month` / `day` INTEGER（月日可空） | 结构化排序键（不再从 `ts` 正则抽年份） |
| `time_confidence` TEXT CHECK('exact','inferred','unknown') | 时间依据强度；`unknown` = 段首显示「时间待核」并在 UI 汇总提示 |
| `source_ordinal` INTEGER | 段尾圆标数字（指向 `compilation_sources.ordinal`）；空 = 无来源段（旧数据/降级段） |
| `evidence` TEXT | 该段的原文证据引文（本地逐字校验用；"查看出处"也用它） |
| `origin` TEXT CHECK('generate','llm-edit','user-edit','contradiction','import') | 该段的最近一次产生方式 |
| `revision` INTEGER DEFAULT 1 | 段级修订号（diff 的稳定辅助键） |
| `kind` TEXT DEFAULT 'paragraph' CHECK('paragraph','heading') | 预留分节标题（年份分节渲染时使用） |

**7.1.2 新表 `compilation_sources`（每汇编一份来源编号表）**：
`id, compilation_id FK CASCADE, source_id FK SET NULL, ordinal INTEGER NOT NULL, title TEXT NOT NULL, cited_count INTEGER DEFAULT 0`，`UNIQUE(compilation_id, ordinal)`。**编号生成规则**：按该来源在文档中**首次被引用**的顺序编号 1..N；新增段落引用新来源时**追加**编号；删除段落**不回收**编号（保证历史版本与正文里的编号不漂移）。

**7.1.3 新表 `compilation_versions`（版本历史，落库而非内存）**：
`id, compilation_id FK CASCADE, version_no INTEGER, paragraphs TEXT(JSON 段落数组快照), markdown TEXT(渲染快照), origin CHECK('generate','llm-edit','user-edit','restore','contradiction','import'), instruction TEXT, reply TEXT, change_summary TEXT(JSON: {added,removed,modified,moved,paragraphIds[]}), base_version_no INTEGER, created_at`，`UNIQUE(compilation_id, version_no)`。
存储策略：**段落数组 + markdown 双份快照**（markdown 可推导，冗余存储换取 diff/导出的确定性）；体量估算 250 段 ≈ 60KB/版本，100 版 ≈ 6MB，可接受；**不引入 Yjs/CRDT**（单人使用、无实时协作需求）。

**7.1.4 新表 `compilation_messages`（汇编级对话历史）**：
`id, compilation_id FK CASCADE, role CHECK('user','assistant'), content, version_no, applied TEXT(JSON), rejected TEXT(JSON), created_at`。
理由：对话属于**汇编**（随导入/导出一起走），而 `task_messages` 属于任务且其 `kind` 有 CHECK 约束（SQLite 改 CHECK 需重建表）；左侧任务对话继续承担"生成/重新生成"，右侧悬浮对话框使用 `compilation_messages`。

**7.1.5 段落 id 稳定性（硬要求）**：生成期由本地分配稳定 id（如 `p{w}-{seq}`）并**落库后不再变化**；`replaceCompilationItems`（先删后插、id 每次全变）改为 **`upsertCompilationParagraphs`**（按 id upsert、缺失者删除、重写 position）——矛盾 variants、`evidence`、版本快照都依赖段 id 稳定。

**7.1.6 迁移与老数据回填**：
- **Migration 030（纯新增，不动既有数据）**：`compilation_items` 新增列、`compilation_sources` / `compilation_versions` / `compilation_messages` 三张新表 + 索引。此迁移执行后**旧界面仍完全可用**（卡片视图继续工作），保证 7.1 可独立验收、不出现半截状态。
- **Migration 031（JS 回填，用迁移框架的 `run(db)` 钩子）**：为既有汇编——按段落首次出现顺序分配 `ordinal` 与 `compilation_sources` 行；从 `ts` 解析 `year/month`（无年份 → `time_confidence='unknown'`）；按 `source_id` 反查写 `source_ordinal`；`origin='generate'`、`revision=1`、`kind='paragraph'`；并为每个汇编生成 **v1 版本**（origin='generate'，`paragraphs` + `markdown` 双快照，`change_summary` 记为初始版本）。
- **Migration 032（破坏性清理）推迟到 7.7**：`DROP TABLE compilation_repairs`、删卡片回收站、移除内存撤销栈——必须等 7.3/7.5 的新界面与版本机制上线、旧界面不再依赖它们之后再执行，避免中途 UI 断裂。
- **演练要求**：在**真实库副本**（`%APPDATA%\xie-zhishu\xie-zhishu.db` 的复制品）上跑迁移，断言旧汇编可正常打开、编号/年份回填正确、v1 版本可对比；并补迁移回归单测（沿用 `connection.ts` 既有 029 迁移测试的写法）。

### 7.2 生成管线改造：细读筛选 → 整合提取 → 矛盾扫描

- **细读阶段（小改）**：提示词从"相关则整段成卡"改为"挑出可能相关的段落/条目（可整段或整条），**宁可多留**；裁剪交给后续整合提取"；保留现有窗口并发、ETA、断点续跑。
- **新增 `extract-service.ts`**（替换 `purify-service.ts` + `repair-service.ts`）：输入窗口内候选文段（带 `#N` 来源编号与来源标题），输出：
  `{"paragraphs":[{"sourceRef":"#3","text":"<整合后的段落正文>","timeLabel":"2018 年 5 月","year":2018,"month":5,"confidence":"exact|inferred|unknown","evidence":"<原文逐字引文>","reason":"…"}],"dropped":[{"sourceRef":"#4","why":"…"}]}`
- **硬约束（提示词 + 本地校验双重）**：
  1. **每段只能来自单一来源**（禁止跨来源拼接）→ 保证圆标唯一、矛盾可检；
  2. **事实不可改写**：数字/日期/人名/地名/机构名必须逐字来自 `evidence`；
  3. **不得合并互相矛盾的说法**——发现冲突时保留为**多段**，交给矛盾扫描（防止"自由整合"把矛盾和谐掉）；
  4. 允许在同一来源内裁剪、合并、调整语序、补全主语与指代；
  5. 每段必须给出含 **4 位年份**的 `timeLabel`，且与 `year` 一致；确实推断不出 → `timeLabel:"时间待核"` + `confidence:"unknown"`（本地汇总并在 UI 提示，供用户用对话框补）；
  6. `evidence` 必须是来源原文中**逐字连续**出现的一段——沿用现有「去空白归一化子串匹配」校验；**校验失败的段落降级为原文整段保留**（不丢材料，并计入诊断）。
- **本地处理**：同批次相邻/包含段合并；跨窗口**近似重复检测**（bigram 相似度高且数字一致 → 保留信息更全的一段；数字不一致 → 都保留，作为矛盾候选）；按 `(year, month, 来源序号, 生成序)` **稳定排序**；编号分配见 7.1.2。
- **失败/降级**：无 Provider、解析失败、超预算 → 该批候选按原文整段保留（沿用现行降级与 `passthroughCards` 式统计）。
- **提纯/修正的遗留物**：`hasYear`/`shouldFillTs` 等年份校验逻辑迁入整合提取的本地校验；`purify-service`/`repair-service` 于 7.7 删除。

### 7.3 连续文档查看器 + 来源编号圆标（右栏主体切换）

- **右栏布局**：顶部工具栏（段数/字数、**「时间待核」计数**、来源编号总览、版本下拉、按时间重排、导出）+ 矛盾面板（保留）+ **文档查看器**（滚动区）+ **右下悬浮圆按钮**（机器人图标，7.5 接管）。
- **段落渲染**：`〔2018 年 5 月〕` 时间标签 chip + 正文 + 段末圆标 `③`（数字 = 该来源在本汇编中的编号，**必须可点击** —— 用户 2026-09-10 明确要求：点击弹出小卡显示来源标题 / 该来源在本汇编中的全部段落 / 「打开原文」跳来源查看器）。无来源段落显示「来源待补」。同时**移除 7.1 的临时展示层**（卡片 meta 行的圆标 / 悬停气泡 / 「缺年份」芯片由正式查看器接管，`CompilationStep` 改为文档查看器）。
- **矛盾面板联动**：`定位到该段` 从"卡片锚点"改为"段落锚点"（滚动 + 高亮，复用现有 `.is-located` 动效）；`采纳该说法` 从"把其他卡片 `kept=0`"改为**把该段改写为采纳文本**（生成新版本，origin='contradiction'）。
- **Markdown 支持**：段落正文支持行内 Markdown（加粗/引用等）与 `remark-gfm` 表格；表格段同样带段首时间与段尾圆标。
- **渲染架构（调研结论，2026-09-10）**：**按段落渲染，不做全文单次 parse**——每段用自己的 markdown 片段渲染（`react-markdown@10` + `remark-gfm` + `remark-cjk-friendly`，MIT），段落身份即持久化的 `pid`，因此**不需要** offset↔pid 映射（调研提示的最大坑）；段落组件 `React.memo` + `key=pid`，版本切换只重渲染变化段（天然与 diff 结果对齐）。段内 Markdown（加粗/引用/列表/表格）按段渲染，避免块级元素跨段。
- **时间标签不由 markdown 源承载**：时间标签来自段落元数据 `ts`（渲染成 chip），正文里不重复写时间，避免"改源文本破坏标记"。
- **备选方案（仅在实测不达标时启用）**：`CodeMirror 6` 只读视图（`Decoration.widget` 挂圆标 + `Decoration.line` 上色 + `scrollIntoView`），它是唯一"天生虚拟化"的方案；**不采用 TipTap 做审阅视图**（markdown round-trip 产生格式噪音、每个 React NodeView = 一个 React root，且官方 Tracked Changes 是付费 add-on）。
- **Spike 前置**：开工前先花小成本取三个数字——(a) 真实 10 万字文档的渲染/换版耗时；(b) 段落级 + 段内字级 diff 耗时（含中文 `Intl.Segmenter`，Electron 43 内置 full-ICU 可用）；(c) 300+ 段 memo 渲染下点击/滚动/高亮是否掉帧。数字决定是否需要虚拟滚动或切 CodeMirror 6。

### 7.4 版本管控与差异高亮

- **建版本时机**：生成完成（v1）、每次对话编辑、矛盾采纳、手动编辑（若保留）、恢复历史版本、导入。
- **版本下拉**：列出`版本号 / 时间 / 来源（生成·对话·手动·矛盾·恢复）/ 变更统计（+N 段 ~M 段 −K 段）`；选中某个历史版本进入**只读对比模式**（与当前版本 diff）；提供「恢复到该版本」（**恢复也生成新版本**，不销毁历史）。
- **diff 计算（两级，调研结论）**：① **段落级结构 diff**——本地算，不信任模型：以 `pid` / 内容哈希做 `diffArrays` 比对（added / removed / modified / moved），相邻"一删一增"用字符级相似度配对判定为 modified；② **段内字级 diff**——仅对 modified 段跑；中文用 `diffWords` + `Intl.Segmenter('zh')`（Electron 43 内置 full-ICU），结果不合直觉则回退 `diffChars`（jsdiff v6+ 按 code point，最保真）。库选型 **`diff@9`（jsdiff，BSD-3-Clause，7.9 KB gzip）为主**；**不引入 Monaco**（体积/worker 打包成本高、收益低）、**不引入 CRDT/Yjs**（单人串行版本链属过度设计）。
- **降级开关**：差异比例过大或计算超时（jsdiff `timeout`/`maxEditLength`）→ 只标"整段变更"，不做字级；UI 明确提示"差异过大，已降级为整块标记"。
- **呈现**：默认统一视图（新增=绿、修改=黄、删除=红色划线占位，可展开看原文；段落左侧色条）；「仅看改动段落」开关（同时把渲染量降到变更数）；「并排对比」视图（左旧右新、按段对齐，用 `react-diff-view`（MIT，`viewType="split"` + 行内高亮）或自研对齐列表）。
- **存储规范化**：版本快照的 `markdown` **一段一行**（段内换行转空格）——使"行级 diff ≈ 段落级 diff"，并让并排视图与第三方 diff 组件可直接复用。
- **版本存储**：`compilation_versions` 直接内联存 `paragraphs`(JSON) + `markdown` 快照（体量估算 250 段 ≈ 60KB/版本，100 版 ≈ 6MB，可忽略）；**内容寻址 + gzip 去重（`blob(hash, codec, payload)` + 版本行只存 hash）暂不实现**——调研建议的这层优化留到版本数确实影响体积时再加，避免过早增加一次间接寻址（7.1 已按内联方案落地）。
- **与旧撤销栈的关系（D6 已裁定）**：现行 `compilation-undo.ts` 是**进程内** 5 表快照（重启即失、整表重插会重建 id）。**以版本为准**：撤销/恢复按钮语义改为"上一版/下一版"，内存快照栈在 7.7 删除。

### 7.5 悬浮对话框与人机协同编辑协议（最关键）

**UI**：右下悬浮圆按钮（机器人简笔）+ 可拖动/可最小化的对话面板（约 380px，覆盖在查看器上，不遮挡正文时为半透明）；展示 `compilation_messages` 历史（用户/助手气泡）；底部输入框 + 发送；编辑进行中禁用发送并显示"正在修改汇编…"；错误态明确（未配置第 1 步模型 / 调用失败 / 格式无法解析）。

**协议（软件 → 大模型）**：提交物 = 用户要求 + **id 化的当前文档**（每行 `p12 | 2018 年 | 《长乐年鉴2019》 | 段落正文`）+ 允许的来源编号清单（1..N 与标题）。

**协议（大模型 → 软件）**：只返回一个 JSON：`{"reply":"给用户看的回答","ops":[…]}`；支持的操作：

| op | 参数 | 说明 |
|---|---|---|
| `delete` | `ids[]` | 删除段落 |
| `replace` | `id, text, timeLabel?, evidence?` | 改写某段正文（时间可一并修正） |
| `insertAfter` | `afterId, text, timeLabel, sourceOrdinal, evidence` | 在某段后插入新段（须指定来源编号，禁止新增"无来源"内容） |
| `move` | `ids[], afterId` | 移动段落（用户可用对话调整时间顺序） |
| `merge` | `ids[]` | 合并相邻段（**仅允许同一来源**） |
| `split` | `id, at` | 拆分段落 |
| `setTime` | `id, timeLabel` | 只改段首时间（用户说"这段应该是 2019 年"） |
| `replaceAll` | `paragraphs[]` | 逃生舱：整篇重写（仅在用户明确要求"重写/统一文风/整体重排"时使用） |

**本地校验（不可跳过，逐条失败即整条 op 拒绝并记入 `rejected[]`）**：id 必须存在；`sourceOrdinal` 必须在 `1..N`；插入/改写的正文中出现的**年份与数字必须能在该来源全文（或提供的 evidence）中找到**（防幻觉硬校验）；`merge` 仅同一来源；`replace`/`replaceAll` 必须保留段尾来源归属（缺来源的段落要有明确标记）；删除不得清空全部段落（除非用户明确要求清空）；`ops` 解析失败 → **文档不变**、报错并保留用户消息。

**应用（单事务）**：应用 ops → upsert 段落 + 编号表 → 生成新版本（origin='llm-edit'，记 `instruction`/`reply`/`change_summary`）→ 写两条 `compilation_messages` → 返回 `{document, version, diff, reply, applied[], rejected[]}`。**并发保护**：请求带 `baseVersionNo`，若版本已变化则拒绝并提示重试（乐观锁）。

**前端反馈**：查看器自动刷新 + 高亮本次改动段落 + 滚动到首个改动段；对话框显示 `reply` 与「已修改 N 段（新增 a / 修改 b / 删除 c）」；若 `rejected` 非空，追加说明（如"有 1 项被拒绝：引用了不存在的段落"）。

**手动编辑的解锁条件（用户补充裁定 D5，2026-09-10）**：**在汇编最终确定之前，用户只能通过对话框向大模型提出修改要求**，查看器不提供任何直接编辑入口。只有当用户**确认汇编（finalized）**之后，工具栏才出现 **「开始人工修改」** 按钮；点击弹出**二次确认弹窗**，明确告知"进入人工修改模式后，将直接改写当前资料汇编，此操作不可逆"（文案入 i18n），用户确认后才进入手动编辑模式。进入后可逐段编辑正文/时间标签、删除、插入；此阶段的每次操作同样**生成新版本**（origin='user-edit'）——"不可逆"指不再受"只能由大模型改动"的约束，一旦手改就不提供"退出编辑模式并回滚全部手改"的额外兜底，误操作只能靠版本历史逐版恢复。"开始人工修改"按钮出现前的状态（`drafting`/`reviewing`）在 UI 上明确标注为"仅可对话修改"。

**与旧链路的关系**：`compilation:adjust`（`compilation-adjust.ts` 的 `editActions`/`cardId` 协议）被本协议**取代并删除**（其 `cardId` 寻址在文档模型下不成立；顺带修掉其中 `parseEditActions` 的围栏正则笔误与"`update` 缺省字段写 null"问题）；左侧任务对话框的"调整现有汇编"预设文案改为引导用户使用右侧对话框（或直接路由到同一 `doc:edit` 后端，避免两条竞争链路）。

### 7.6 导出 / 第三步 / 回收站 / 来源删除的重新定义

- **`.docx`**：标题 + 正文（段首时间 + 正文 + **上标编号**）+ **附：来源清单（编号 ↔《标题》）** + 矛盾说明；替代现行"一卡两头两段"。
- **`.xzsc`**：文档（段落数组）+ 来源编号表 + 版本历史（可裁剪）+ 对话历史；保留 `version:1` 旧格式的**读取兼容**。
- **第三步（撰写初稿）**：素材改为**段落数组**（含时间与来源标题），提示词按年份分组呈现；`draft_generation_sources` 落痕继续（`chunk_text` = 段落正文）；`kept` 语义改为"是否纳入素材"（默认全部纳入）。
- **来源删除与级联**：引用计数从"卡片数"改为"**被引用段数**"；删除来源后段落标记「来源已删除」并保留（或按用户选择一并删除），UI 明确提示影响 N 段。
- **回收站（待裁定 D6）**：建议收缩为「仅矛盾」；段落删除由版本历史恢复（少一套并行机制）。

### 7.7 收尾（端到端、性能、文档、清理）

- 真实 Provider 端到端：生成 → 浏览（时间/编号/来源）→ 多轮对话编辑 → 版本对比与恢复 → 导出 → 导入到新任务 → 第三步生成初稿。
- 性能基线记录：生成耗时（对比现行三阶段）、查看器滚动、diff 计算（两版本间）、单轮对话编辑耗时。
- 删除死代码（`purify-service.ts`、`repair-service.ts`、`compilation-adjust.ts`、`compilation-undo.ts` 快照栈、`compilation_repairs` 相关仓储与 IPC）。
- 文档全量同步：`AGENTS.md`、`PLAN.md`、`README.md`、`docs/{data-model,shared-contracts,ui-architecture}.md`；更新演示任务种子（`demo-task.ts`）与新手教程文案（若含"卡片"表述）；更新验证基线数字。

### 7.8 阶段验收标准（每阶段均需"可直观验收"）

| 阶段 | 可直观验收的产品行为 | 工程验收 |
|---|---|---|
| **7.1** 数据模型与迁移 | 打开**旧汇编**仍能正常显示（界面不变、无功能退化），底层已为每段分配好来源编号与年份 | Migration 030/031 在**真实库副本**上跑通 + 迁移回归单测；编号/年份回填断言；`upsertCompilationParagraphs` 保持段 id 稳定；typecheck / 单测 / 构建通过 |
| **7.2** 管线（细读→整合提取→矛盾） | 同一标题重新生成后：**每段都含年份、每段都带来源编号**；无关内容大幅减少（字数明显下降） | 相关字占比、最终字数、"时间待核"段数、evidence 校验通过率、矛盾组数对比旧管线；耗时对比；新增单测（校验/排序/编号/降级） |
| **7.3** 文档查看器 | 右栏是一篇**连续文本**；段首时间、段尾圆标可见且点击能打开对应来源；矛盾面板「定位到该段」能滚动高亮 | 三种主题样式一致；500 段以上滚动流畅；旧汇编同样正常渲染；单测/构建 |
| **7.4** 版本与差异 | 做一次修改后，**改动段落被高亮**（绿/黄/红）；可在版本下拉里查看历史、对比差异、一键恢复；**重启后版本历史仍在** | diff 正确性单测（新增/删除/修改/移动/段内字符级）；恢复后生成新版本且与目标版本内容一致 |
| **7.5** 对话框协同编辑 | 用户示例场景跑通：输入「校区建设不属于这方面的内容，请你把校区建设相关内容都删掉」→ 相关段被删除、查看器即时更新、对话框回「已按你的要求删除 N 段」；**未确认汇编前查看器无任何编辑入口**，确认后才出现「开始人工修改」并弹不可逆确认 | 错误路径：坏 JSON → 文档不变 + 明确报错；幻觉 id → 该 op 被拒并说明；跨来源 merge → 拒绝；乐观锁冲突 → 提示重试；单测（协议解析/校验/应用/回滚） |
| **7.6** 导出与下游 | 导出的 docx 段落连续、上标编号与附录来源清单对应；导入到新任务后文档/编号/版本一致；第三步用它生成初稿 | 导出单测（含编号↔来源映射）；第三步素材构造单测；来源删除影响段数提示正确 |
| **7.7** 收尾 | 全流程演示通过；文档与实现一致 | typecheck 0 / 单测全通过（除既有 chokidar 环境项）/ 生产构建成功；死代码清理确认；基线数字更新 |

### 7.9 已裁定事项（用户敲定，2026-09-10）

| # | 事项 | 裁定 |
|---|---|---|
| **D1** | 管线顺序 | **A**：合并为一趟 —— `细读筛选 → 整合提取（裁剪 + 补全 + 整合）→ 矛盾扫描`；原「提纯」「修正」两阶段被整合提取取代 |
| **D2** | 圆标数字的含义 | **A**：**本汇编内**按首次引用顺序编号 1..N（同一篇文章的多段共用同一编号；编号只增不回收） |
| **D3** | 大模型编辑协议 | **A**：ops 引用段 id（`delete/replace/insertAfter/move/merge/split/setTime`）+ `replaceAll` 逃生舱；本地逐条校验后应用 |
| **D4** | 时间排序 | **C + D**：结构化 `year/month` + 本地稳定多键排序（年→月→来源序号→生成序）+ **按年份分节渲染**（`## 2018 年`）+ 允许用对话"移动段落" |
| **D5** | 手动编辑 | **用户补充裁定（覆盖面超出原三选项）**：**确认汇编（finalized）之前查看器无任何直接编辑入口，只能通过对话框让大模型改**；确认后工具栏出现 **「开始人工修改」** 按钮，点击弹**不可逆二次确认**，确认后进入手动编辑模式（详见 7.5）。后期如需调整再议 |
| **D6** | 旧机制处置 | **A**：废弃「大模型修正」记录（`compilation_repairs`）与卡片回收站，撤销/恢复改为"上一版/下一版"；破坏性清理放在 7.7（新界面与版本机制上线后） |

> **实施节奏（用户敲定）**：**按阶段推进，每完成一阶段停下来等用户验收**（每阶段完成即提交，遵守"一个提交一个目的"）。开工顺序：7.1 → 7.2 → 7.3 → 7.4 → 7.5 → 7.6 → 7.7。

## Last Phase（收尾阶段）: Acceptance & Packaging（待进行）

> **说明**：本阶段是**整个项目的收尾阶段**，在所有功能阶段（Phase 1–6.x）全部完成后才执行。此处保留「Phase 5」的旧编号仅为历史追溯，不代表其应在 Phase 6 之前完成；序号与执行顺序无关。

**Overall Goal:** 产出 Windows 安装包、完成端到端演示与项目文档。

- **Task Detail:**
  1. Windows 安装包构建与安装验证（electron-builder NSIS，GitHub Actions 已配置 tag 触发）。
  2. 核心闭环（收集 → 撰写 → 初稿完成）端到端演示。
  3. 整理演示数据、使用说明、开发文档与 Git 提交记录。
- **Affected Areas:** 打包发布、端到端验证、项目文档。
- **Verification:** 安装包可安装运行；全流程演示通过；数据全部本地保存，对外仅调用用户配置的大模型与用户提供的信源；已知限制被明确记录。

## Project Completion Criteria

- 收集 → 撰写 → 初稿完成的完整业务闭环可用。
- 初稿支持逐片段溯源（每个片段可查看原文来源）。
- 数据默认保存在本地；对外仅调用用户配置的大模型与用户提供的信源网址，无其他外联行为。
- 矛盾、文段修改两种人工审核场景均可完成（事件缺失补充已移出范围）。
- Windows 实机验证通过；每项任务可通过项目文档和提交历史追溯到验证结果。
