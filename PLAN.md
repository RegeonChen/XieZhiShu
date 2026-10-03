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
理由：对话属于**汇编**（随导入/导出一起走），而 `task_messages` 属于任务且其 `kind` 有 CHECK 约束（SQLite 改 CHECK 需重建表）；左侧任务对话原本承担"生成/重新生成"，右侧悬浮对话框使用 `compilation_messages`。
> **2026-09-10 更新**：左侧任务对话的**修改类消息已路由到同一 `doc:edit` 后端**（三轮验收），且用户提出**下线左栏、只保留悬浮按钮**——见 **7.10**（该节会重新安置"生成/重新生成"入口）。

**7.1.5 段落 id 稳定性（硬要求）**：生成期由本地分配稳定 id（如 `p{w}-{seq}`）并**落库后不再变化**；`replaceCompilationItems`（先删后插、id 每次全变）改为 **`upsertCompilationParagraphs`**（按 id upsert、缺失者删除、重写 position）——矛盾 variants、`evidence`、版本快照都依赖段 id 稳定。

**7.1.6 迁移与老数据回填**：
- **Migration 030（纯新增，不动既有数据）**：`compilation_items` 新增列、`compilation_sources` / `compilation_versions` / `compilation_messages` 三张新表 + 索引。此迁移执行后**旧界面仍完全可用**（卡片视图继续工作），保证 7.1 可独立验收、不出现半截状态。
- **Migration 031（JS 回填，用迁移框架的 `run(db)` 钩子）**：为既有汇编——按段落首次出现顺序分配 `ordinal` 与 `compilation_sources` 行；从 `ts` 解析 `year/month`（无年份 → `time_confidence='unknown'`）；按 `source_id` 反查写 `source_ordinal`；`origin='generate'`、`revision=1`、`kind='paragraph'`；并为每个汇编生成 **v1 版本**（origin='generate'，`paragraphs` + `markdown` 双快照，`change_summary` 记为初始版本）。
- **Migration 032（破坏性清理）推迟到 7.7**：`DROP TABLE compilation_repairs`、删卡片回收站、移除内存撤销栈——必须等 7.3/7.5 的新界面与版本机制上线、旧界面不再依赖它们之后再执行，避免中途 UI 断裂。
- **演练要求**：在**真实库副本**（`%APPDATA%\xie-zhishu\xie-zhishu.db` 的复制品）上跑迁移，断言旧汇编可正常打开、编号/年份回填正确、v1 版本可对比；并补迁移回归单测（沿用 `connection.ts` 既有 029 迁移测试的写法）。

### 7.2 生成管线改造：细读筛选 → 整合提取 → 矛盾扫描

> **Status（2026-09-10）**：**已实现，待真实 Provider 复跑验收**（用户裁定 D1：把「提纯 + 修正」合并为「整合提取」一趟）。
> 交付：
> - **细读提示词调轻**（用户要求）：明确"这里只做筛选、不做裁剪"，不确定是否相关一律保留，裁剪/合并/补全交给整合提取；不再要求"自包含事实"（旧要求正是"每段掺入无关内容"的另一面）。
> - **新增 `src/main/writing/extract-service.ts`**：整合提取的提示词、解析、校验-降级流水线、分批（30 张 / 12000 字）、按 Provider 并发、漏答重问一次、解析失败换温度重试、逐批诊断日志；预算 1200s、单批先验 120s。
> - **三道本地硬校验**（`compilation-document.ts`）：`evidence` 必须逐字来自来源卡片（`locateVerbatim`，容忍排版空格）；正文数字必须都能在来源卡片里找到（`numbersCoveredBy`，**整 token** 比较）；时间可信度由本地解析（不采信模型自报）。任一不过 → **降级保留原文整段**并按原因计数。
> - **成文 `assembleDocument`**：完全重复去重、同来源近似重复（Dice ≥ 0.85）且数字一致才去重、**数字不一致两段都保留**（疑似矛盾）、按 年→月→生成序 稳定排序并重写 ordinal。
> - **落库改为文档模型**：`ensureCompilationSources`（编号按排序后首次引用 1..N，只增不回收）+ `upsertCompilationParagraphs`（**保留段 id**）+ 生成 v1 版本（`snapshotCompilationVersion(..., 'generate')`）；中断时落库部分结果、续跑只重跑未完成批次（`extractDoneBatches`）。
> - **窗口级矛盾改用「整合提取映射」**（`mapWindowGroupsThroughExtract`，取代原提纯映射 + 修正改写两道字符串兜底）：按"说法落在哪张候选卡片 → 该卡片派生段落中相似度最高的一段"映射，相似度 < 0.5 视为已被裁掉并丢弃该说法（宁丢说法不张冠李戴）。
> - **契约同步**：`purifyScan`/`repairScan` → 单一 `extractScan`（IPC、主进程 handler、渲染层生成汇总、i18n 全部同步；进度重排为 细读 12→66%、整合提取 67→87%、矛盾 88→99%）。
> - **旧阶段保留为 `@deprecated` 死代码**（`runPurifyPhase` / `runRepairPhase` 及其状态字段，带注释标明"Phase 7.2 起不再调用、Phase 7.7 清理时删除"）——先让新管线跑通并验收，再在 7.7 一并删除，避免一次改动同时"上新 + 拆旧"。
> - 测试：`compilation-document` 9 项（含数字整 token 校验、成文去重/冲突保留/排序）、`extract-service` 6 项（解析、提示词约束断言、校验降级、幻觉 sourceRef、分批）、`tests/compilation-service.test.ts` 的窗口矛盾映射用例改写为 `mapWindowGroupsThroughExtract`。
> - **测试当场抓到并修掉的三处真实缺陷**：① 数字校验原用"子串包含"，`2` 会被 `2018` 里的字符蒙混、`30` 会被 `130` 蒙混（等于给编造数字留后门）→ 改整 token 比较；② 近似重复原按"更长者胜"，会把"其中有独立高中"这类更啰嗦的写法当成"信息更全"→ 改为仅当新文本真正包含旧文本才替换；③ 只有 `dropped` 的整批"与主题无关"输出原被判为无效而整批降级 → 修正为合法输出。
> **验证**：typecheck 零错误、**248/249 单测通过**（1 项 watcher chokidar 环境失败为既有问题）、生产构建成功。
> **待用户用真实 Provider 复跑同一标题，核对对比表**：相关字占比、最终字数、段数、`extractScan.accepted/degraded`（校验通过率）、`时间待核` 段数、矛盾组数 vs 旧管线、总耗时。

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

> **Status（2026-09-10）**：**主体已完成并经用户验收**。交付：
> - 右栏由「卡片列表」改为**连续文档查看器**（`CompilationStep`）：每段 = 段首时间徽标 + 正文 + **段尾来源圆标**，
>   按年份分节（`2018 年` 小节标题，用户裁定 D4-C）；段级操作（编辑/删除）改为**悬停显示**，保持连续观感；
> - **圆标可点击**（用户点名要求）：弹出「来源小卡」——来源编号与标题、该来源在本汇编中的全部段落（点击即定位高亮）、「打开原文」；悬停另有气泡说明；
> - 工具栏统计改为「N 段 / N 篇来源」+「N 段时间待核」；7.1 的临时展示层已移除；
> - 矛盾面板「定位到该段」沿用并作用于段落；**采纳/忽略后按 D6 记录一个版**（`snapshotCompilationVersion(..., 'contradiction')`，落库可回滚；撤销栈为进程内、重启即失）；
> - 行内 Markdown 先只支持 `**加粗**`（实测 148 段中无 Markdown 结构；若将来出现表格/引用/列表，按调研选型接入 react-markdown + remark-gfm）。
>
> **7.3 剩余（并入 7.7 清理）**：`main.css` 中已无人使用的 `.compilation-card*` / `.compilation-cards` 样式清理；
> `docs/ui-architecture.md` 的右栏描述同步。**用户手动编辑**（D5：确认汇编后经「开始人工修改」+ 不可逆二次确认解锁）属 7.5。

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

> **Status（2026-09-10）**：**已实现，待用户用真实 Provider 验收**。交付：
> - **协议（纯函数，`doc-edit-service.ts`）**：提交物 = 系统提示（id 化文档 `[p12] 2018 年 | 来源3 | 正文` + 可引用来源编号清单 + 规则）+ 用户要求；
>   输出 = 单个 JSON `{"reply","ops"}`（容忍围栏/夹带文字）；8 种 op（delete/replace/insertAfter/move/merge/split/setTime/replaceAll）；
>   校验 = 段号必须存在、`sourceOrdinal` 必须 1..N、正文数字必须能在该来源原文中找到（沿用 `numbersCoveredBy` 整 token 口径，防幻觉）、
>   `merge` 仅同来源、**不得删空整篇**；任一条不过 → 该条拒绝并记入 `rejected`，其余照常应用；解析失败 → 文档不变 + 明确报错。
> - **编排（`doc-edit-runner.ts`）**：乐观锁（`baseVersionNo` 与最新版不一致即拒，错误码 `VERSION_CONFLICT`）→ 用户消息**先落库**（成功失败都留痕）→
>   `chatCompletion(kind:'compilation-doc-edit', temperature 0, maxRetries 0, 240s)` → 解析 → 校验 → 应用 →
>   **单次** `upsertCompilationParagraphs`（保留段 id；来源 id 由 ordinal 预先解析，避免"只传一段把其余段删掉"的坑）→
>   `snapshotCompilationVersion(..., 'llm-edit')`（含 instruction/reply/baseVersionNo）→ 写助手消息（含 versionNo/applied/rejected）。
>   **未触及的段落保留原 `origin`/`revision`**，不被一次对话刷成全篇"对话修改"。
> - **UI（`CompilationStep`）**：右下悬浮圆按钮（自绘机器人简笔）→ 可**拖动**（指针事件 + 边界夹取）/可最小化的面板（380px，半透明 + 模糊，默认贴右下）；
>   展示 `compilation_messages` 历史（用户/助手气泡 + 版本号）；输入框 + 发送（Ctrl/⌘+Enter）；编辑中禁用发送并显示「正在修改汇编…」；
>   错误态红条明确（未配置第 1 步模型 / 调用失败 / 格式无法解析 / 乐观锁冲突并自动刷新版本列表）；
>   改动后**高亮本次改动段**（`.is-changed`）并**滚动到首个改动段**；回复里附「已修改 N 处：新增 a 段 / 改写 b 段 / 删除 c 段」。
> - **D5 手动编辑解锁**：确认汇编前，段落悬停**不出现任何编辑/删除入口**，工具栏标注「仅可对话修改」；
>   `status === 'finalized'` 后工具栏出现「开始人工修改」→ **不可逆二次确认弹窗** → 进入人工修改模式（红色「人工修改中」标记 + 悬停编辑/删除）。
> - **旧链路收口**：左侧任务对话框的后续消息不再走 `compilation:adjust`（cardId 寻址），改为**路由到同一 `doc:edit` 后端**（`handleDocSend`），
>   避免两条竞争链路；「批量删除 / 增补内容」预设文案同步为段落口径。`compilation-adjust.ts` 与其 IPC 留待 **7.7 删除**。
> - **契约**：新增 `IPC.COMPILATION_DOC_EDIT` / `IPC.COMPILATION_MESSAGES` + `CompilationDocEditReq/Res`（含 `changedIds` / `changeSummary`）/ `CompilationMessagesReq/Res`；
>   preload 新增 `editCompilationDoc` / `listCompilationMessages`（+ `index.d.ts`）。
> - 测试：`doc-edit-service` 6 项（原 5 项 + 新增「改动摘要：文本 diff + setTime/move/merge 目标补记」）。
>
> **用户验收后整改（2026-09-10，第二轮）**——验收项基本通过，反馈 1 个 bug + 4 项改动，逐项落地：> 1. **对话编辑无法被「撤销操作」撤销（bug）**：`runDocEdit` 落库前没有 `pushUndo`，撤销栈顶仍是更早的快照，
>    撤销会跳过这次对话改动 → 落库前补 `pushUndo(compilationId)`，与手动编辑/删除/矛盾取舍同口径。
> 2. **改动段底色不变回来（bug）**：原实现把 `docChangedIds` 一直挂在 state 上，底色永不消失；且我用了 `--accent-soft`，
>    而 classic 主题的 accent 是**暗红**（`#8c3b2e`/`#f3e2dc`），所以看起来是"红色且不恢复"。
>    改为**独立高亮 token** `--hl-changed` / `--hl-changed-soft`（青绿系，三套主题各给值，**刻意不跟随 accent**，
>    与对比模式的 红=删除 / 黄=修改 / 绿=新增 都能区分），并在 `CompilationStep` 内 **3.5 秒后自动清除**。
> 3. **人工修改模式改为持久化 + 不可逆**（用户裁定改写原 D5）：新增 Migration 034 `compilations.manual_edit INTEGER NOT NULL DEFAULT 0`、
>    仓储 `setCompilationManualEdit`、IPC `compilation:manualEdit`、preload `enterCompilationManualEdit`；
>    界面状态一律由 `compilation.manualEdit` 派生（不再有渲染层 `manualMode` state），**只增不减、没有反向通道**，
>    切换任务/重启软件均保持。不记版本、不登记撤销栈（否则撤销能把它退回去，违背"不可逆"）。
>    真实库副本演练：Migration 33 → 34，`manual_edit` 列 `INTEGER NOT NULL DEFAULT 0`，5 份存量汇编全部为 0，汇编/段落数零变化，`integrity_check=ok`。
> 4. **改完时间自动重排 + 滚动定位 + 2 秒高亮**：`compilation:updateItem` 在**同一次操作内**（`params.ts !== undefined` 时）
>    调用 `reorderCompilationItemsByTs(cid, 'asc')` 并返回重排后的完整 `compilation`（契约加可选字段，前端整体替换，
>    **不额外记版本**——用户视角这是一次编辑）；前端 `refocus={id, nonce}` 触发滚动到该段新位置 + `is-refocused` 高亮 2 秒，
>    并把工具栏排序图标复位为 ↑。配套：编辑弹窗**只提交真正改动的字段**（原来每次保存都带 `ts`，
>    会把"只改正文"误判成"改了时间"，无谓重排并冲掉用户手调的顺序）。
> 5. **用户明确要求改数字时不再校验**（用户裁定）：op 上加 `allowNewNumbers?: boolean`（`replace` / `insertAfter` / `replaceAll.paragraphs` 均支持），
>    提示词明确"**只有用户点名具体数值时才能加这个字段**，其它任何情况一律不加，绝不可用它给推测/估算开口子"，
>    本地校验见到该字段**直接放行**（用户裁定"大模型和软件都照做即可"）。
> **验证（第二轮）**：typecheck 零错误、**261/262 单测通过**（1 项 watcher chokidar 环境失败为既有问题）、生产构建成功。
>
> **用户复验后整改（2026-09-10，第三轮：交互模型收敛）**——复验通过后用户改变了两条产品决策：
> 1. **删除「人工修改模式」（前后端全部实现）**。新需求：软件内不再提供逐段手改，改为「导出资料汇编 → 在本地修改」，
>    好处是核对来源存疑时可随时回到软件内查看。删除内容：Migration 035 `DROP COLUMN compilations.manual_edit`（034 当天引入当天删除，
>    保留 034 条目不改写迁移账本）、`Compilation.manualEdit`、仓储 `setCompilationManualEdit`、IPC `compilation:manualEdit`、
>    preload `enterCompilationManualEdit`、`CompilationStep` 的 D5 门槛（徽标 / 「开始人工修改」/ 不可逆二次确认弹窗）、
>    段落悬停「编辑」「删除」与编辑弹窗、`WritingWorkspace` 的 `handleStartManualEdit` / `handleUpdateItem` / `handleDeleteItem`、
>    以及配套 i18n 与 CSS（`.is-manual*` / `.compilation-manual-warn` / `.compilation-para__actions`）。
>    **真实库副本演练**：Migration 34 → 35，列 `manual_edit` 被删除、其余列完全一致，汇编 5 / 段落 664 零变化，`integrity_check=ok`、外键违规 0。
> 2. **撤销栈只登记对话编辑**（用户实测"点排序按钮也会点亮撤销"）：`pushUndo` 现在**只在 `runDocEdit` 调用**；
>    其余会改内容或顺序的路径（排序 / 矛盾取舍 / 回收站恢复 / 修正回退与再应用 / 目录级编辑 / 版本恢复 / 汇编调整）
>    改为 `clearUndoStacks(cid)`——**作废**撤销栈而不是压栈。原因：快照是整个汇编的状态，若两次对话编辑之间发生了别的改动，
>    直接弹栈会把那些改动一并回滚（用户要求"撤销 = 精确回退上一次大模型改动，绝不误伤"）。同时这些路径不再记录版本。
> 3. **取消「与修改前的上一版对比」按钮，改为自动复核**：每次对话修改成功后，主进程在响应里直接返回
>    **本次修改前后**的段落差异（`readParagraphSnapshot(改前) vs 改后` → `diffParagraphVersions`，**不靠版本号推算基线**——
>    版本会被回退、被裁剪到 2 版，用它当基线会算错），渲染层据此**自动进入对比模式**并显示 **「采纳」「回退」** 两个并列按钮：
>    采纳 = 保留改动、退出复核；回退 = 调 `compilation:undo` 弹出最近登记的撤销快照、**不产生新版本**、退出复核。
>    复核态下禁用工具栏的撤销/恢复/排序按钮，保证"唯一出口是复核条"。版本下拉、对比开关、`handleSelectVersion` 一并删除。
> 4. **对话改时间后同一次操作内按时间重排**（承接上一轮"改完时间自动重排"，原先挂在已删除的手工编辑上）：
>    `runDocEdit` 检测到"时间标签变了或有新段"即 `sortParagraphsByTime` 重排后再落库；纯 `move`（用户明确要求调序）不触发排序，避免覆盖用户的调序意图。
> **验证（第三轮）**：typecheck 零错误、**260/261 单测通过**（1 项 watcher chokidar 环境失败为既有问题）、生产构建成功
> （产物同时变小：CSS 127.15 → 125.10 kB、JS 4,175 → 4,166 kB，与删除量一致）。
> **验证**：typecheck 零错误、**258/259 单测通过**（1 项 watcher chokidar 环境失败为既有问题）、生产构建成功。
> **待用户实测**：配置好第 1 步模型后，在右侧对话框输入「校区建设不属于这方面的内容，请你把校区建设相关内容都删掉」→ 相关段被删除、查看器即时更新并高亮；错误路径（幻觉段号、跨来源 merge、引用了来源中不存在的数字、乐观锁冲突）。

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

### 7.6 导出 / 第三步 / 回收站 / 来源删除 / 左栏下线（**原 7.10 已并入本阶段**，2026-09-10 用户裁定合并）

> **Status（2026-09-10）**：**主体已实现，待用户验收**。按三个切片交付（每片一次提交）：
> 1. **左栏下线 + 悬浮面板生成模式**（`777f679`，细则见 7.6.1）：`CompilationStep` 现在只有一个悬浮入口、两种模式——
>    无汇编 / 生成中 / 生成中断时是**生成模式**（复用原左栏的 `ChatPanel`：标题与要求输入、预设提示词、进度条 + ETA、
>    中断卡片 + 「尝试继续」原样保留），否则是**对话模式**。**中断态刻意留在生成模式**：中断时主进程已落库部分段落
>    （`compilation` 非空），但此刻用户需要的是进度与续跑按钮。面板在生成中/中断/无汇编时自动展开，**生成成功时自动收起**
>    （只识别"生成中→非生成中"的真实跃迁，不会收掉用户手动展开的面板）。`WritingWorkspace` 的「生成汇编」功能区不再渲染左栏，
>    查看器占满整宽；随之删除已不可达的 `handleAdjustCompilation`（`doc:edit` 只剩悬浮面板一个入口）。
> 2. **导出改造**（`f375e6a`）：`.docx` 从"一卡两头两段"改为**连续文档**——正文每段 = 段首时间 + 正文 + **上标来源编号**
>    （与附录清单编号同源，取自 `source_ordinal`），缺时间的段落导出为「时间待核」、缺来源的标注「（来源待补）」而不冒充有来源；
>    附按编号升序的**来源清单**；再附矛盾说明。`.xzsc` 升到 **v2** 并分层：`document`（段落数组，含时间与来源标题）
>    + `sources` + `versions`（**只导摘要**，正文即当前版本，避免归档体积翻倍）+ `messages` + `contradictions`；
>    **v1 旧格式仍可读**（v1 就是整份 `Compilation` 的 dump）。
> 3. **第三步素材改段落数组**（`dc0a00b`）：新增 `buildCompilationMaterials`（纯函数）——按 `year` **分年份分组**呈现，
>    每行 = 段首时间 + 正文 + 来源标题，无年份的段进「年份待核」组（不编造年份），被排除的段不进入素材；
>    `buildUserPrompt` 支持"预渲染素材"覆盖，检索链路（旧卡片块格式）不受影响；来源删除提示与各处统计口径由「卡片」改为「**段**」。
>
> **本阶段未做（明确留给 7.7）**：**回收站收缩为「仅矛盾」**。D6 已裁定废弃卡片回收站，但那是**破坏性清理**
> （删 `compilation_card_recycle_bin` 表 + 快照/恢复代码 + 回收站 UI 入口），而 7.7 就是收尾清理阶段；
> 在这里先删表会让界面在 7.7 之前仍然提供"恢复卡片"却无数据。**左栏下线后该入口几乎已不可达**（段落只能经矛盾取舍软删除或来源级联硬删除），
> 因此风险很低，留待 7.7 与其它破坏性清理一并处理。
>
> **验证**：typecheck 零错误、**268/269 单测通过**（1 项 watcher chokidar 环境失败为既有问题）、生产构建成功。
> 新增 8 项内联单测（docx 上标编号/待核与缺来源标记/来源清单排序/XML 转义、`.xzsc` v2 载荷形状/v2 往返/v1 兼容、
> 第三步素材的年份分组与待核组）。
>
> **用户验收后追加整改（2026-09-10 试用意见三条）**：
> 1. **导出不再被矛盾拦住**：删掉「导出资料汇编」按钮上的 `pending.length > 0` 禁用与提示——
>    用户在生成/审阅过程中**随时可导出**，未处理完的矛盾在导出文档里以「待处理」状态照常列出（见下条）。
> 2. **矛盾编号**：抓住"用户要拿导出稿逐组对照"这个真实用途——矛盾按**汇编内矛盾数组顺序**编号 1..N
>    （数组来自 `ORDER BY rowid`，稳定），且**编号覆盖全部组（含已采纳/已忽略）**，否则取舍一组就会让后面的编号漂移、
>    与用户已写下的批注对不上。界面：段尾标记由「⚠ 矛盾」改为 **「⚠ 矛盾3」**（待处理=红色；已采纳/已忽略=灰色同号标记，
>    这样"这段属于第几组"在取舍之后依然看得见）。导出：**每段末尾注明「（矛盾N）」**（同段属多组时如「（矛盾1、2）」），
>    文末由「矛盾说明」升级为 **「矛盾汇总」**——按编号列出每组的状态（待处理/已采纳/已忽略）、各方说法与来源，
>    并标注哪条说法已被采纳，供本地逐组对照审阅。
> 3. **字号大/中/小 + 持久化**：设置页「外观」区块新增「资料汇编字号」（小/中/大）。`small` **就是改造前的字号与文档宽度**
>    （逐项对齐：正文 13.5px、行高 1.9、年份 13px、时间徽标 11px、文档最大宽 860px、内边距 4/2/40）；
>    `medium`（**默认**）15px + 取消 860px 宽度上限（直接铺满，解决"两边留白过多"）；`large` 17px + 行高 2.05。
>    实现为 `:root[data-doc-scale=...]` 上的 CSS 变量（与 `data-theme` 同机制），由 App 写入根元素；
>    档位**落库**（`settings.doc_scale`，medium 为默认值故不写键）→ 重启后仍生效。
>    **顺带修掉一个既有 bug**：`settings.keep_awake`（长任务保持唤醒）原先**只写不读**，导致该开关重启后被重置为"开启"；
>    本次补上读取并加了回归单测。
> **验证（追加整改后）**：typecheck 零错误、**270/271 单测通过**（1 项 watcher chokidar 环境失败为既有问题）、生产构建成功。
>
> **用户第二轮试用意见（2026-09-10，三条）**：
> 1. **预设提示词改口径**：「本次撰写任务的标题为 ……」→ **「本次资料收集的主题为 ……」**（标签/说明同步为「输入主题与需求」）。
>    连带修一处**本地兜底正则**：`extractTopicTerms` 原先只认 `(标题|题目)[为是]?`，认不得新的「主题为」——
>    用户删掉引号时主题词会整句回退、影响矛盾扫描与网页检索的召回。已把 `主题` 并入该正则并加回归单测。
> 2. **矛盾取舍纳入撤销/恢复**：采纳/忽略会保留或排除段落，此前我把它归为"非对话改动"而**作废**撤销栈
>    （用户当时只提了排序按钮，我扩大化了），现按用户要求改为**登记**——`resolveCompilationContradiction` 先 `pushUndo` 再改状态，
>    于是「撤销」可退回「待处理」、「恢复」可重新采纳。**规则收敛为**：撤销栈登记 **对话编辑 + 矛盾采纳/忽略**两类，
>    其余只改顺序或非用户裁定的路径（排序 / 回收站恢复 / 修正回退与再应用 / 目录级编辑 / 版本恢复 / 汇编调整）仍然**作废**。
>    注：**压栈与作废必须二选一**——某条改动不压栈，撤销就会跳过它去弹更早的快照、把它一并回滚（这正是用户当初"点排序也点亮撤销"的根因）。
> 3. **中字号改为固定宽度**：原先中/大都是 `--doc-max-width: 100%`（铺满无留白）；按用户要求**中字号固定 1040px**
>    （小 = 860px，中 = 1040px，大仍铺满右栏），中字号因此有稳定的版心、又明显宽于小字号。括号与内边距随档位不变。
> **验证（第二轮追加后）**：typecheck 零错误、**272/273 单测通过**（1 项 watcher chokidar 环境失败为既有问题）、生产构建成功。

- **`.docx`**：标题 + 正文（段首时间 + 正文 + **上标编号**）+ **附：来源清单（编号 ↔《标题》）** + 矛盾说明；替代现行"一卡两头两段"。
- **`.xzsc`**：文档（段落数组）+ 来源编号表 + 版本历史（可裁剪）+ 对话历史；保留 `version:1` 旧格式的**读取兼容**。
- **第三步（撰写初稿）**：素材改为**段落数组**（含时间与来源标题），提示词按年份分组呈现；`draft_generation_sources` 落痕继续（`chunk_text` = 段落正文）；`kept` 语义改为"是否纳入素材"（默认全部纳入）。
- **来源删除与级联**：引用计数从"卡片数"改为"**被引用段数**"；删除来源后段落标记「来源已删除」并保留（或按用户选择一并删除），UI 明确提示影响 N 段。
- **回收站（待裁定 D6）**：建议收缩为「仅矛盾」；段落删除由版本历史恢复（少一套并行机制）。

#### 7.6.1 左栏任务对话框下线（原 7.10）

> **动机（用户原话）**：大模型对话入口**只需保留悬浮按钮**即可。左侧再放一个对话框属于**重复入口**——同一个 `doc:edit` 后端已由右侧悬浮面板承载（2026-09-10 三轮验收中已把左栏后续消息路由到该后端），保留两个入口只会让"哪边才是权威对话"变模糊。

**前提：左栏在「生成汇编」功能区并非纯聊天框**，它还承担 4 项职责，必须逐项安置后才能删：

| # | 左栏现有职责 | 现状实现 | 下线后的去向 |
|---|---|---|---|
| 1 | **首次生成汇编的输入入口**（标题 + 要求 + 预设提示词 + 「生成汇编」主按钮） | `ChatPanel.onPrimaryAction` → `handleGenerateCompilation`。注意：汇编为空时 `CompilationStep` 只显示空态文案「请在左侧输入…」，**右栏本身没有输入框** | **已裁定 D7 = A**：悬浮面板兼作"生成模式" |
| 2 | 生成进度条 + 百分比 + 预计剩余 | `compilationProgress` | 悬浮面板内 |
| 3 | 中断提示 + **「尝试继续」**（断点续跑） | `compilationInterrupt` → `handleContinueCompilation` | 悬浮面板内（必须保留，否则中断后无法续跑） |
| 4 | 后续修改对话 + 来源引用 chips | 已路由到同一 `doc:edit` 后端 | 由悬浮面板统一承载；来源 chips 取消（段尾圆标已能打开来源） |

**目标形态（D7 = A）**：悬浮圆按钮**在汇编为空时也可用**；面板打开后按状态切换两种模式——
- **生成模式**（`compilation == null`）：标题 + 撰写要求 + 预设提示词 + 「生成汇编」按钮；生成中的**进度条、百分比、预计剩余、中断提示 + 「尝试继续」**都显示在面板内。
- **对话模式**（已有汇编）：即现有历史气泡 + 输入框 + 复核流程。
界面必须明确区分两种模式（标题/主按钮文案不同），避免用户误以为"生成"和"修改"是同一件事。

**验收标准**：「生成汇编」功能区**无左栏**；首次生成、生成进度、中断续跑、多轮修改对话**均可在悬浮面板内完成**；`task_messages` 里的生成记录仍保留（历史不丢，只是不再有独立面板）。

**边界（需单独裁定，不并入本阶段）**：「撰写初稿」功能区的左栏还承担"自由对话 + 生成初稿输入"（`handleChat` / `handleGenerateDraft`），是同一问题的另一处实例——是否一并收敛单独决定。

### 7.7 收尾（端到端、性能、文档、清理）

> **Status（2026-09-10）**：**代码清理部分已完成（切片 A–E），仅剩用户侧端到端验证（切片 F）**。切片 A 已提交（`a42e3a1`：删除被 7.5 取代的「汇编调整」链路——`compilation-adjust.ts` + IPC `compilation:adjust` + 类型 + preload + 文案）；切片 B1 已提交（`336c2c4`：删除 `purify-service.ts`/`repair-service.ts` 与 `compilation-service.ts` 里已无人调用的两个阶段函数）；切片 B2 已提交（`777e2db`：修正链路端到端下线——渲染层徽标/详情弹窗/工具栏统计、`Compilation.repairs` 类型、两个 IPC 通道、`compilation-repairs.ts` 仓储、`CompilationItemInput.repair`）；切片 C 已提交（`77e3647`：Migration 036 删表 + 回收站收缩为仅矛盾 + 撤销快照去掉 `repairs`）；切片 D 已提交（`34cab09`：删除 `compilation:updateItem`/`deleteItem`/`version:diff`/`version:restore` 四个无入口通道）；切片 E 已提交（`4be1396`：死样式、文档、演示/降级落库口径、基线数字）。
>
> **⚠ 对原计划的修正**：原 7.7 条目写着"删除 `compilation-undo.ts` 快照栈"，但**这条已作废**——用户在 7.5/7.6 验收中明确要求「撤销/恢复」可用，并要求**矛盾采纳/忽略也可撤销**，内存快照栈是这套能力的载体，**保留**。
>
> **切片 B2/C 的实机影响（用户需知）**：Migration 036 是**破坏性**的。真实库副本演练结果：`compilation_repairs` 中 **130 条历史修正记录**、`compilation_card_recycle_bin` 中 **6 条待恢复卡片快照**被永久清除；6 份汇编 / 737 段落 / 10 组矛盾 / 6 条矛盾回收站条目零变化，`integrity_check=ok`、外键违规 0。升级后**回收站只剩「矛盾」一类**，此前躺在卡片回收站里的卡片无法再恢复。
>
> **剩余切片**：
> - **E 死样式与文档**（已提交 `4be1396`）：`main.css` 的 `.compilation-card*`/`.compilation-cards` 已删（保留 `@keyframes compilation-card-locate`）；`docs/{ui-architecture,data-model,shared-contracts}.md` 已对齐；`demo-task.ts` 与新手教程文案的「卡片/大模型修正」表述已改，**演示任务与本地降级改为走真实段落模型落库**（来源编号表 + 段落 upsert + v1 版本，此前演示汇编缺年份分节与来源圆标、无 Provider 时生成的汇编看起来"功能没生效"）；`AGENTS.md`/`PLAN.md` 验证基线与迁移范围已更新（001–036、243/244）。
> - **F 用户侧端到端**（我无法代做，需要真实 Provider）：生成 → 浏览（时间/编号/来源）→ 多轮对话编辑 → 复核采纳/回退 → 导出 `.docx`/`.xzsc` → 导入到新任务 → 第三步生成初稿；以及性能基线（生成耗时、查看器滚动、diff、单轮对话耗时）。

- 真实 Provider 端到端：生成 → 浏览（时间/编号/来源）→ 多轮对话编辑 → 版本对比与恢复 → 导出 → 导入到新任务 → 第三步生成初稿。
- 性能基线记录：生成耗时（对比现行三阶段）、查看器滚动、diff 计算（两版本间）、单轮对话编辑耗时。
- 删除死代码（`purify-service.ts`、`repair-service.ts`、`compilation-adjust.ts`、`compilation-undo.ts` 快照栈、`compilation_repairs` 相关仓储与 IPC）。
- 文档全量同步：`AGENTS.md`、`PLAN.md`、`README.md`、`docs/{data-model,shared-contracts,ui-architecture}.md`；更新演示任务种子（`demo-task.ts`）与新手教程文案（若含"卡片"表述）；更新验证基线数字。

### 7.10 左栏任务对话框下线（**已并入 7.6.1**）

> 2026-09-10 用户裁定：「7.6 与 7.10 合并成一个阶段」。详细规格（职责清单、目标形态、验收标准、边界）已上移到 **7.6.1**；本节仅保留编号以保证既有引用（`AGENTS.md`、7.9 开工顺序）不悬空。

### 7.11 网页资料库并入修志流程（2026-09-10 用户提出风险评估；分三批）

> **背景**：用户指出「现有真实 Provider 测试都基于本地资料库，加入网页资料库后可能出问题」，并举例「有些网页文章不能像年鉴一样通过年份 −1 兜底」。逐条核对代码后确认 3 条高严重度 + 7 条中低severity问题（完整清单见当次评估回复）。
>
> **第一批（已完成，提交 `15df6a8`）**：
> - **① 年份兜底按来源分流**：`inferYearFromSource({title,kind,publishedAt})` —— 年鉴/年报类标题 → −1（`title-yearbook`）；其它标题年份 → 原样（`title`）；网页无标题年份 → 发布时间（`published`）；都推不出 → 「时间待核」。修掉「《2021年全区教育工作总结》被推成 2020」「标题退化为 URL 时 `t20251203` 被推成 2024」这类**静默错年**。四处调用点（整合提取、降级段、段落编辑、对话改时间）统一传来源信息。
> - **② 发布时间进管线**：Migration 037 给 `sources` 加 `published_at` 并从 `web_site_articles` 按 URL 回填；`importSiteArticle` 落库写入、304 复用、老行顺手补齐。
> - **③ 网页资料进向量索引**：`importSiteArticle` 抓取后 `enqueueIndex`；生成前 `ensureSourcesIndexed`（预算 120s）等待就绪，超预算/失败记日志。此前网页在保守闸门里只能靠词法（`score > 1`），"字面无关但语义相关"的向量兜底（`RECALL_VEC_MIN=0.1`）对网页完全失效。
> - **验证**：真实库副本演练 35 → 37（7 资料 / 2 汇编 / 147 段落零变化、0 文件来源被写发布时间、integrity ok、外键违规 0；该库无任何网页材料，回填命中 0 行）；typecheck 零错误、246/247 单测通过、构建成功。
> - **副作用（用户须知）**：−1 规则现在只对年鉴类标题生效，本地文件《2019年教育统计表》由「2018」变为「2019」。
>
> **第二批（已完成，提交待推送）**：① **跨来源近似重复合并**——`assembleDocument` 新增跨来源近似重复判定（阈值 0.92，比同来源的 0.85 更严），且**只在数字完全一致时**才算重复（合并后只留一个来源）；数字不一致一律两段都留交给矛盾扫描（绝不抹平矛盾）；诊断新增 `crossSourceMerged`。真实数据里"网页转载 / 网站版与工作区同文档"这类重复此前只会被"完全相同"这一条兜住。② **抓取上限 + 汇总告知**——`WEB_FETCH_MAX_ARTICLES=80` 篇 / `WEB_FETCH_MAX_CHARS=400000` 字，命中过多时**按标题相关度优先保留**（新增 `rankArticlesByQuery`，此前是取清单前 N 篇＝按时间新旧取舍），被截断的篇数记入 `webScan.skippedByCap` 并在生成汇总里如实显示「网页资料：标题命中 N 篇，实际采用 M 篇（X 字）（另有 K 篇因抓取上限未采用）」。③ **无 Provider 时跳过抓取**——未配置大模型时不再白等近 10 分钟抓网页，并改用**保守闸门收窄后**的材料做降级汇编（此前是宽召回全量灌进去，477 篇网页会把降级产物撑到不可用）；查询向量由本地嵌入模型生成，与 LLM Provider 无关。
>
> **2026-09-12 真实生成实测（用户注册 https://www.clnews.com.cn/ 后跑「高中学校设置」）——第一批指标验收**：
> - **网页材料确实进管线了**：本次抓取 **477 篇**网页来源（`task_id` 绑定），汇编 125 段中 **77 段来自网页**、48 段来自本地文件；全部段落 `time_confidence='exact'`、**无一段缺年份**；`extract_scan`：输入 286 卡 / 94,782 字 → 输出 125 段 / 8,233 字（保留 8.7%），accepted 123 / degraded 3 / droppedCards 150 / duplicatesDropped 1 / conflictsKept 0。
> - **① 年份兜底分流**：本次**未被触发**（0 条 `inferred`、0 条 `unknown`——新闻正文年份齐全，模型直接给了年份），因此这次数据**无法验证**该规则；但可确认没有出现错年（网页段落年份与正文/发布时间年份一致）。规则已由单测覆盖。
> - **② 发布时间进管线**：✅ 477/477 网页来源都写入了 `published_at`。但发现**既有解析 bug**：日期最后一位被截断（`2016-06-2`←`2016-06-22`、`2017-08-3`←`2017-08-30`），根因是 `extractPublishedDate` 的可见日期正则把单位数候选放在最前且结尾无强制分隔符 → 已修复并加回归单测（年份不受影响，故不影响兜底；影响的是文章清单显示与排序）。
> - **③ 网页资料进向量索引**：❌ **未达预期，且根因不在本次改动**——`chunk_embeddings` 全库为 **0**、全部 477 个网页来源与**全部 5 个本地文件来源**的 `index_state` 均为 `failed`（另有 2 个 pending）。即嵌入模型在本机整体不可用（既有环境问题），向量语义兜底对**所有**来源都从未生效；本次补丁（抓取即入队 + 生成前等待）本身按预期执行。**待办**：查清模型/引擎不可用的原因，并把失败原因落库/打日志（当前 `index_state='failed'` 无原因可查）。
> - **时间开销**：整次生成 07:50:30 → 08:17:23 ≈ **26.9 分钟**，其中**网页抓取 477 篇占 9 分 43 秒（36%）**（站点串行 + polite delay），LLM 计算 ≈ 45 分钟（细读 24 次 27.4 min、整合提取 14 次 16.2 min、矛盾 1 次 70s；按 4 路并发 ≈ 11 min 墙钟），零 LLM 调用失败。→ 直接支撑第二批的"抓取上限"必要性。
> - **矛盾**：5 组以上，多数涉及网页来源（如「融侨国际双语学校规划班级数」「福州三中滨海校区投用时间」「文武砂中学面积」）——多为**同期报道口径差异**（规划/在建/投用阶段不同），并非同一时点的事实冲突，属第三批要处理的"伪矛盾"问题。
>
> **第三批（已完成；用户 2026-09-12 裁定范围：A1、C、D、E1、E2、E3，B 从计划中删除）**：
> - **A1 网页材料集合在首次生成时落定**：Migration 039 新增 `task_web_materials`（`task_id` / `source_id` / `url` / `title` / `added_at`，主键 `(task_id, source_id)`，两个外键均 `ON DELETE CASCADE`）。首次生成把本轮实际采用的网页来源**锁定**到该任务；此后「重新生成汇编」**默认复用同一批**（`listPinnedWebMaterials` → 并回检索范围），期间站点上的新命中文章**只统计数量**（`collectSiteCandidates` 只发现、不抓正文，`webScan.reused` / `newCandidates`），由用户在悬浮面板点「纳入新材料」（IPC `compilation:adoptWebMaterials`）才抓取入库 → 锁定 → `ensureSourcesIndexed` 补索引。**取舍**：不自动跟随站点变化——否则"重新生成"会悄悄换材料，污染版本差异与矛盾编号。**已知限制**：面板提示「已锁定 N 篇 / 另有 M 篇新命中」取自最近一次生成的 `webScan`（会话内状态），重启软件后需再生成一次才重新显示；**复用行为本身不受影响**。
> - **C 来源本地快照 + 抓取时间**：新增只读 IPC `sources:getSnapshot`（读库里已存正文，**不联网**——网页改版/撤稿后仍可核对原文；上限 200,000 字并标注截断）；资料卡片表头显示「抓取于 …」（`url_snapshot_at`），「查看本地快照」在弹窗中查看并**高亮本次检索关键词命中片段**（空白容错匹配），「打开来源」仍跳浏览器。
> - **D 伪矛盾收敛**：矛盾扫描提示词新增「**以下情形不算矛盾，不要归组**」清单（不同年份、不同统计口径、规划/在建/投用等阶段差异、上位与下位范围差异）+「只有**同一时点、同一口径**下数据、时间、地点、主体、结果明确不同才算矛盾」+ 要求「**利用时间字段**判断时点」；矛盾说法行同时显示该说法的时间，便于人工核对是否真的同期。
> - **E1 站点错误透出**：`WebFetchStats.siteErrors` 进汇总，显示「另有 N 个站点检索失败」，不再静默失败。
> - **E2 标题缺失兜底**：无标题页面用 `host（页面无标题）`（`fallbackTitleFromUrl`）；年份推断对**看起来像 URL 的标题**不再采信（`looksLikeUrl`），避免 `t20251203` 被误当年份。
> - **E3 正文过短提示**：快照正文 < 500 字（多为只抓到导航/页脚）时标注「正文偏短，可信度存疑」（`shortText`）。
> - **B（已删除）**：原「生成前给出本次将使用的网页材料清单并允许逐篇排除」不再实现（用户 2026-09-12 裁定）——A1 已把材料集合固定下来，再叠一层清单-排除交互收益有限。
> - **验证（2026-09-12）**：typecheck 零错误；vitest **261/262 通过**（1 项 watcher chokidar `unlink` 环境失败为既有问题，非功能回归）；生产构建成功（CSS 123.84 kB / JS 4,182.12 kB）。**Migration 039 真实库副本演练**：38 → 39，`task_web_materials` 表与索引就绪，484 个来源 / 170,689 条分块向量 / 3 份汇编 / 272 段落 / 14 条矛盾 / 2 条回收站条目**零变化**，`integrity_check=ok`、外键违规 0、重复执行幂等。
> - **待用户实测**：真实 Provider 下首次生成 → 再次生成是否复用同一批网页材料并提示新命中篇数 → 点「纳入新材料」→ 再生成能用到新文章；以及快照弹窗、矛盾时间行、抓取于时间的显示。
>
> **2026-09-12 实测复议（同一主题：99 段 vs 上一轮 125 段）——抓取上限 + 排序口径失效，A/B/C 三项修复**：
> - **现象（逐段核对真实库）**：网页段落 **77 → 4 段**、本地文件段落 48 → **95 段**；缺失 108 段 = 换说法/合并 29 段（其中 27 段来自本地年鉴，内容没丢）+ 存疑 8 段 + **这一轮完全没有 71 段（69 段来自网页）**。76/108 明确含「高中/中学/完中/普高/高中部」；丢失内容包括滨海新城福州三中滨海校区/分校、融侨（赛德伯）国际双语学校高中部、长乐一中一分校高中部、长乐三中恢复高中办学、长乐五中申报省级达标校并筹划扩建、《长乐区 2017—2020 年高中阶段学校建设计划》等；新汇编**完全没有 2019（9 段）、2026（3 段）、2011（1 段）**的内容。
> - **根因（两条，全部有数据支撑）**：① **上限把材料集合整个换掉**——`WEB_FETCH_MAX_ARTICLES=80`（第二批引入）使抓到的网页从 477 篇降到 80 篇，**两轮重合 0 篇**（上一轮 477 篇里只有 1 篇落在本轮候选前 80 位）；上一轮 477 篇中正文含「高中」的有 151 篇 / 94.1 万字，本轮 80 篇只剩 16 篇 / 9.4 万字（切题正文 −90%）。② **排序口径失效 ⇒ 上限等于"按清单顺序瞎取"**——上游筛选 `matchesAny` 用 bigram 命中，排序 `rankArticlesByQuery` 却用完整子串 `title.includes(term)`，而检索词是长词/空格拼接的关键词串，实测 477 篇与 80 篇标题打分**全部为 0**，稳定排序退化为保持清单原序。**丢失的 69 段网页内容从未进入管线**（其来源本轮根本不在任务范围内），并非大模型判定无关。
> - **A 修排序口径**：`extractTopicTerms` 在引号/引导语都取不到时，把**空格拼接的关键词列表逐词**当作检索词（此前会抹掉空格拼成一整句，导致 `includes` 永不成立）；`rankArticlesByQuery` 改为与 `matchesAny` 一致的 **bigram 重叠计数 + 完整检索词加权**；**领域下位词不参与排序**（它服务召回，用于排序会把同为教育、却非本主题的下位领域顶到前面）。
> - **⚠ 实测告诫（长期有效）**：即使排序修好，**只要上限小于标题粗筛后的候选数（真实站点同一主题实测 495–3,293 篇），按标题排序仍会整体排除"标题不含主题词、正文却切题"的建校类文章**——实测上一轮 42 篇有用材料在上限 300 下只有 5 篇能入选。**相关性取舍必须靠正文**（抓取时的正文精过滤 + 保守闸门 + 细读窗口），上限只是成本保险丝。
> - **A1/A2/C/D：网页正文抓取质量（2026-09-12 用户实测后实施，用户裁定范围 A1/A2/C/D + 存量清理；B 已于 2026-10-02 按方案 A 处置，见下）**：
>   - **根因（用户举例「长乐新添一所普通高中，将于9月开学。」只剩标题）**，逐层查实：① **抓取层**——站点对**已失效的老文章 URL 返回 HTTP 200 + 一份通用模板页**（实测 3 个 2014–2016 的 URL 现在都返回同一份约 128 KB 的模板页，正文里连文章标题都没有）。此前只看状态码，把整页模板文本（导航 + 其他文章列表 + 页脚备案）当正文入库；最新任务 208 篇里 **119 篇（57.2%）**如此（URL 年份全在 2012–2016），全库 685 篇里 **178 篇（26%）**；这 119 篇正文**完全相同**（同一 hash、7,024 字），还吃掉约 83 万字符抓取预算（1.5M 的 56%），把真正有用的文章挤出预算。② **过滤层**——正文精过滤把标题拼进匹配文本（`matchesExact((pageTitle + '\n' + richText).slice(0,12000), terms)`），等于"标题命中即可入库"，正文是模板也照过。③ **生成层**——段落缺少"必须有正文信息量"和"时间必须有据"的硬校验：p10「长乐新添一所普通高中，将于9月开学。」标 **2019 年**（文章发布 2023-03-07，正文里根本没有 2019）、p32（2021 vs 2023-05-23）、p33（2021 vs 2022-11-07）同理，而全库 380 段**全部** `time_confidence='exact'`，界面上看不出问题。补充：这三篇的正文其实都在库里（2,360–2,949 字，含校名/规模/投资/地点），是**模型只输出标题改写**。
>   - **A1 正文有效性校验**：`pageContainsArticle(rawHtml, text, title)` —— 标题核心片段（去空白后前 8 字）必须出现在提取正文或原始 HTML 里，否则判"未取到正文"，丢弃、不入库不索引，并计入 `WebFetchStats.invalidBody`（汇总里显示「另有 N 篇未取到正文——老文章链接已失效…」）。标题 <4 字时不判定，避免误杀。
>   - **A2 正文清洗与来源标记**：`cleanArticleText(text, title)` 去掉前部导航/面包屑与后部「相关新闻/更多>>」列表、页脚备案（真实站点实测：90 行里 40 行导航 + 40 行推荐，真正正文只有 1 行）；新增 `sources.text_source`（`extractor`=结构化提取器 / `full-page`=整页回退）落库，日志里同时打印"已清洗 N 字模板噪音"。
>   - **C1 拒收标题型段落**：`isTitleOnlyParagraph(text, sourceTitle)`（归一化后互为子串，或短段与标题 bigram 相似度 ≥0.55——阈值用真实数据标定：三条实测标题复述段 0.58–0.60，正常段落 <0.3）→ 丢弃并计入 `extractScan.titleOnlyDropped`；**降级路径（漏答/解析失败按原文保留）同样过滤**，否则模板页来源仍会以标题形式混进来。
>   - **C2 时间必须有据**：`isYearSupportedBySource(year, {text,title,kind,publishedAt})` —— 年份必须出现在来源正文里，或等于来源推测年份（年鉴 −1 / 标题年份 / 网页发布时间），否则标为「时间待核」并计入 `extractScan.timeUnsupported`。
>   - **C3/D 提示词**：新增硬性要求 ⓿「**绝不能只复述文章标题**，段落必须给出正文里的具体要素」；要求 3 补「允许压缩概括，但主体名称与规模/数量/金额/地点/时间不得丢失」；要求 5 补「年份必须有依据，无据会被本地降级为待核」。
>   - **存量清理（Migration 040/041）**：040 加 `sources.text_source` / `body_missing`；041 把"正文里找不到标题前 8 字"的任务绑定网页来源标 `body_missing=1`、清空其向量、从 `task_web_materials` 摘掉（不再进检索范围；**不删 sources 行**——汇编段落通过外键引用来源，删行会级联删掉已生成的段落）。`indexer` 的待索引查询/`resetFailedIndex`/`countNotReady` 全部排除 `body_missing=1`（「重建索引」不会再去索引垃圾），设置页「本地检索索引」新增一行说明。
>   - **验证**：typecheck 零错误；vitest **266/267 通过**（1 项既有 chokidar `unlink` 环境失败）；生产构建成功；**Migration 040/041 真实库副本演练**：39 → 41，178 篇标记为正文缺失、向量 198,839 → 162,171（清掉 36,668 个垃圾分块）、锁定 208 → 90，而**来源 692 / 汇编段落 387 / 矛盾 15 / 汇编 4 / 站点文章 62,506 全部零变化**，`integrity_check=ok`、外键违规 0、重复执行幂等。
>   - **B 的复议与处置（2026-10-02，用户裁定选 A）**：原 B 含两条独立改动——**B-1** 精过滤不再把标题算进匹配文本、**B-2** 放宽 12,000 字窗口。**真实数据取证**（4 份汇编 / 777 篇网页来源）：① **B-1 收益为 0**——本轮实际采用的 300 篇里"仅标题命中、正文不命中"的**一篇都没有**；被判为模板页的 60 篇其（模板）正文**全部含检索词**，B-1 也拦不住（那是 A1 的功劳）。② **B-2 今天影响为 0**——全部网页正文最长 **10,419 字**（中位数 2,511），从未超过 12,000 字窗口；但截断是**静默失败点**（主题词出现在更后位置的长文会被悄悄丢弃，界面看不出来），一旦登记年鉴式/政府工作报告式长网页站点就会咬人。③ **顺手查明真正的噪声病灶**：300 篇里 **98 篇（32.7%）**正文不含任何"高中系"专指词（幼儿园招生公告、公厕新建改建、智慧公园、专升本、食品检查、领导调研…），全靠**泛词**（新建/扩建/改建/规模/招生…）命中进来；而 `stats.fetched` **只在落库成功时递增**（被过滤的文章不占上限），所以收紧泛词本可把约 98 个名额换给正文真正切题的文章——但实测粗粒度规则会在「我区多所学校改扩建工程年内将竣工」「福州第十九中学滨海校区全面封顶」这类**切题材料与幼儿园招生公告之间误判**，故**本轮不做**，列为后续可选项（口径需先标定 + 复跑真实生成验收）。**处置（方案 A）**：只做 B-2——`buildBodyMatchText(pageTitle, cleanedText)` 返回**标题 + 正文全文**（去掉 `.slice(0, 12000)`），标题**继续参与**匹配（B-1 不做，避免让精过滤对措辞更敏感、丢切题材料）。验证：typecheck 零错误、vitest **283/284 通过**（新增 1 项回归：13,000 字长文主题词出现在 12,500 字处仍须命中；反向"正文确实不含主题词仍挡掉"与"标题命中仍可过闸门"同时断言）、生产构建成功。**遗留**：泛词噪声（≈1/3 材料）与"上限 300 < 候选 495–3,293"两项仍在，需单独裁定。
> - **B 上限放宽**：`WEB_FETCH_MAX_ARTICLES` 80 → **300**、`WEB_FETCH_MAX_CHARS` 400,000 → **1,500,000**（用户 2026-09-12 裁定；A1 材料集合锁定让这笔抓取代价**每个任务只付一次**）。
> - **C 材料集合可重算**：新增 IPC `compilation:refreshWebMaterials`（清空 `task_web_materials` → 重新发现/排序/抓取 → 重新锁定；旧的任务绑定网页来源保留作缓存但不再并入检索范围），生成面板提示条新增「重新检索网页材料」按钮——首次落定不理想时不必新建任务。
> - **C 补正（同日，用户实测「找不到按钮」）**：原实现把提示条只放在悬浮面板的**生成模式**分支里，而「重新生成汇编」会先按 A1 复用旧集合——**"换一批材料"的入口事实上够不到**（重启后 `webScan` 为空更是什么都不显示）。改为：新增只读 IPC `compilation:webMaterials`（查锁定篇数），渲染层在任务变化/生成完成/纳入后刷新，提示条**两种模式都渲染**（无 `webScan` 时按持久化篇数显示「已锁定 N 篇」）；同时**生成进行中禁用**「纳入新材料」。
> - **C 撤销 + 根因查明（同日，用户实测后要求删除）**：用户重启后确实看到了按钮并点击，结果只回了「已重新检索网页材料：锁定 **0** 篇（标题命中 495 篇，因上限未采用 0 篇）」，且该任务的 80 篇锁定材料被清空、`task_web_materials` 变为空表。**根因（已用真实库 + 真实请求复现）**：① **口径不一致**——`filterArticlesByQuery` 用 `matchesAny`（bigram，宽松）做标题粗筛，`importSiteArticle` 的正文精过滤却用 `matchesExact`（**完整子串**）；界面入口传的是**原始撰写要求**，`extractTopicTerms` 从中取到的是「高中学校设置」这个 **7 字长词**，于是 495 篇候选的正文**没有一篇**原样包含这 7 个字 → 0 篇落库，而 `skippedByCap=0`、界面完全看不出是精过滤丢的（生成管线平时不暴露此问题，是因为它传的是大模型提取的**短关键词**）。② **非原子**——该功能"先清空锁定集合再抓取"，抓取为 0 时旧集合也一起没了。**处置（用户 2026-09-12 裁定）**：**删除**「重新检索网页材料」（IPC + 按钮 + i18n + 仓储 `clearPinnedWebMaterials` + 文档），保留只读的 `compilation:webMaterials` 与「已锁定 N 篇」提示。**`compilation:adoptWebMaterials`（纳入新材料）暂留但同样受①影响、实际不可用**，待后续统一改造（让界面入口复用生成管线的粗筛关键词，或把正文精过滤改成与粗筛同口径）。
> - **⚠ 另发现的缺口（用户已指出）**：**当前软件里没有「重新生成汇编」按钮**——`zhCN.compilation.regenerateBtn` 是**无人引用的死文案**；悬浮面板只有在"还没有汇编 / 正在生成 / 生成中断"时才是生成模式，已有汇编且不在生成中时只提供「与汇编对话」（`doc:edit`），因此已有汇编的任务**只能新建任务重跑**（或先让它中断再用「尝试继续」）。
> - **同日补齐与再清理（用户 2026-09-12 裁定）**：① **补上真正的「重新生成汇编」入口**——「与汇编对话」面板底部新增该按钮 + 二次确认（`ConfirmDialog`），确认后调用同一条 `compilation:generate` 管线；文案明确告知"网页材料沿用已锁定的一批（不重新抓取）、生成结果是一版新汇编（新对话与版本历史，旧版留在库中但界面只显示最新一版）"。② **一并删除 `compilation:adoptWebMaterials`（纳入新材料）**——它与刚删的 `refreshWebMaterials` 同属"界面入口传原始撰写要求"的对外动作，同样必然 0 篇；后端抓取/锁定能力保留给生成管线使用。至此**网页材料集合只由生成管线自身管理**（首次落定 + 后续复用），面板只读显示「已锁定 N 篇」。验证：typecheck 零错误、vitest **263/264 通过**（1 项 watcher chokidar 环境失败为既有问题；少 1 项是删掉了 `clearPinnedWebMaterials` 的单测）、生产构建成功。
> - **验证**：typecheck 零错误；vitest **264/265 通过**（1 项 watcher chokidar `unlink` 环境失败为既有问题）；生产构建成功；新增回归单测覆盖"空格拼接关键词列表逐词提取"与"长关键词串下仍能区分相关标题"。
>
> **索引失败的根因与修复（2026-09-12，先行完成）**：全库 `chunk_embeddings=0`、所有来源 `index_state='failed'` 的根因**不是模型缺失**，而是 `onnxruntime-node` 这个 file: 依赖（`vendor/onnxruntime-node-stub`）的 `node_modules` 目录是**空的**（`npm ls` 报 invalid）→ transformers 的 node 构建 import 失败 → 每次 `pipeline()` 抛错。`npm install` 修复后实测：真实网页资料 3,731 字 → 42 分块 / **5.6 秒**索引成功。配套可诊断性：Migration 038 加 `sources.index_error`（失败原因落库 + 日志）、`embed.ts` 报错同时指出"引擎/依赖不可用"、新增 `rag:indexStatus`/`rag:reindex` 与设置页「本地检索索引」区块（状态 + 最近失败原因 + 重建索引按钮，后台串行、界面 2 秒轮询）。**用户操作**：打开设置 →「本地检索索引」→「重建索引」（484 篇，实测约 5.6s/篇，需数十分钟，可后台进行）。
>
> **另需用户裁定的一项**：**「同一件事只保留一处」目前只覆盖"几乎逐字相同"**，且**合并后不标注多来源**（每段 `sourceId` 单值、圆标单编号，7.2 的 D1 明确"不得跨来源拼接"）。若要「语义相同的事实合并 + 标注多个来源」，属数据结构级改动（段落↔来源多对多、导出上标多编号、圆标多来源弹层、矛盾归因与来源删除引用计数），需另立阶段。

### 7.12 事实去重与多来源标注（2026-09-10 立项；**2026-10-02 补规格与开发规划，待用户裁定**）

> **编号说明**：用户口述为「新的阶段 phase 7.8」，但 **7.8 已被「阶段验收标准」表占用**（见下节），为避免重号，此处按下一个可用编号记为 **7.12**。若用户希望改回 7.8，需要先把验收标准表移到别处，届时一并调整引用。
>
> **状态（2026-10-02）**：用户先裁定「补规格」，随后**逐项敲定 Q1–Q5**（见 §7.12.6），并按 **S1 → S2 → S3** 开工。**S1 已完成并自验**（Migration 042 + 并列来源关系表 + 引用计数改实时查询 + 本地去重规则）；**S2 已完成并经用户实测通过**（段尾多圆标 + 来源小卡列出本段全部出处）；**S3 代码完成、待用户实测**（docx 多上标 / `.xzsc` v3 / 来源删除按关系表改指 / 导入路径深拷贝修正）。实施进度、验证数字与一处**计划偏差**见 §7.12.6.1。
> **⚠ 原注（2026-09-10）**：用户当时表示「具体实现我还没想好」，故只登记问题与待决问题、不写实现方案。
>
> **背景（已核实的现状）**：用户问「现在已经做好了查重合并功能（两段文字讲了同一件事，那么只保留一处），对吗？合并后的文字是否标注了多个来源？」——**答案是「只做了一半，且不标注多来源」**：
>
> | # | 情形 | 现状 | 代码位置 |
> |---|---|---|---|
> | 1 | 归一化后**完全一致**（仅空白/标点差异） | ✅ 只留先出现者，**跨来源也生效** | `compilation-document.ts:436-441` |
> | 2 | **同一来源内**相似度 ≥0.85 的近似重复，数字一致 | ✅ 视为重复只留一处（新段更全时才替换） | `compilation-document.ts:442-455` |
> | 3 | 同一来源内近似重复但**数字不一致** | ✅ 两段都留，计入 `conflictsKept` 交给矛盾扫描（绝不静默合并） | `compilation-document.ts:456-458` |
> | 4 | **跨来源**近似重复（转载/同一文档的网站版与工作区版）且相似度 **≥0.92、数字一致** | ✅ **已合并**（2026-09-12「网页资料库第二批」补上，阈值刻意比同来源更严）——**⚠ 本行 2026-10-02 修正，原写「❌ 不合并」已过期** | `compilation-document.ts:593-599`（`NEAR_DUPLICATE_DICE_CROSS = 0.92`） |
> | 5 | **跨来源**近似重复但相似度在 0.85–0.92 之间（数字一致） | ❌ 不合并（阈值更严的代价） | 同上 |
> | 5b | **包含关系**（一段的文字完整包含另一段）但 Dice 低于阈值 | ❌ 不合并（现行只有 Dice 一条口径，判不出包含） | 无此规则 |
> | 6 | 措辞差异大的「同一件事」（Dice <0.85，如「长乐区有省一级达标高中2所…」vs「全区各类学校中，有省一级达标高中2所…」，实测 Dice 0.722） | ❌ 不合并（字符 bigram 对改写敏感） | 同上 |
> | 7 | 「合并后是否标注多个来源」 | ❌ **不标注**：段落只有单个 `sourceId` + 单个 `source_ordinal`，导出 docx 每段只有一个上标编号；被丢弃的那一处来源若未被任何保留段落引用，连来源编号表和附录都不会出现 | `assembled`→`upsertCompilationParagraphs`（`sourceId` 单值）、`compilationDocxXml` 上标 |
> | 8 | **合并掉的来源会「消失」** | 被合并那一处的来源不再出现在编号表/附录里（若没被别的段落引用）——「同一件事有两个出处」这条信息**丢失** | `ensureCompilationSources` 只登记被保留段落的来源 |
>
> **为什么现状是"每段单一来源"**：Phase 7.2 用户裁定 D1 的一部分——提示词明确「不得跨卡片拼接（跨来源）」，本地校验以"该来源全部卡片拼成的原文"做 `evidence` 逐字比对；对话编辑的 `merge` op 也只允许同一来源。因此「多来源标注」与既有约束**直接冲突**，不是加个字段就能解决。
>
> **立项要解决的问题（待用户确认优先级）**：
> 1. **跨来源去重**：同一事实被多个来源（网页转载、多份年鉴、网站版+工作区文件版）分别收录时，汇编里只保留一处。难点：判定"同一件事"的粒度（严格字符串相似度只能覆盖改写很小的情形）+ 数字不一致时必须保留（矛盾不能抹平）。
> 2. **多来源标注**：合并后如何呈现"这一段有 N 个来源"。涉及：段落↔来源的关系是否改为多对多（新表 or 数组列）；段尾圆标显示多个编号还是"1,3"合并显示；点开来源小卡是否列出全部来源；导出 docx 的上标编号形式；来源编号表 `cited_count`、来源删除时的"影响多少段"提示如何计算。
> 3. **矛盾归因**：矛盾说法（`compilation_contradiction_variants`）当前指向 `item_id` + `source_id`；多来源段落出现后，"哪一句来自哪个来源"需要仍然可判定（否则矛盾扫描的取舍会失去依据）。
> 4. **与既有约束的调和**：D1 的「不得跨来源拼接」是否要放宽为「允许合并但必须保留全部来源标注」？`evidence` 逐字校验在多来源下用哪一份原文比对？
>
> **原始待决问题（2026-09-10 提出）**：已由下方 §7.12.6 的选项与推荐逐条覆盖，此处保留以存查。
> - 去重的判定口径：只用字符相似度阈值，还是允许大模型判断"是否同一件事"（后者要防幻觉与误合并）？
> - 合并的默认行为：自动合并（可能误合并）还是标为"疑似重复"由用户裁定（与矛盾取舍同级的交互）？
> - 多来源的展示形态：段尾圆标 `[1,3]`？还是 `[1]⁺` 点开列出多个？导出 docx 的附来源清单是否也列出全部？
> - 被合并段落的 `evidence` 与 `origin`/`revision` 语义如何定义？
> - 目的范围：只做"去重"（保留单一来源，选信息最全的一处）是否已能满足用户需求？——若"多来源标注"成本过高，可先做去重。
>
#### 7.12.1 取证（2026-10-02：真实库只读取证 + 代码核对）

**真实数据**（4 份汇编 / 384 个保留段 / 98 个来源编号；库内迁移账本 = 41，下一版即 042；只读探针，**未写入任何数据**）：

| 汇编 | 段数 | 来源 | 跨来源完全一致 | 跨来源 ≥0.92 同数字 | 跨来源 0.85–0.92 同数字 | 跨来源 0.7–0.85 | 跨来源 0.5–0.7 | 数字不一致 | 包含关系 |
|---|---|---|---|---|---|---|---|---|---|
| ①「高中学校设置」finalized | 66 | 5 | 0 | 0 | 0 | 4 | 9 | 0 | 0 |
| ②「高中学校设置」finalized | 74 | 5 | 0 | 0 | 0 | 3 | 8 | 0 | 0 |
| ③「高中学校设置」drafting | 125 | 47 | 0 | 0 | 1 | 0 | 11 | 0 | 1（同来源） |
| ④「高中学校设置」drafting | 119 | 41 | 0 | 0 | 1 | 4 | 7 | 0 | 1（同来源） |

**四条结论（全部有数据支撑）**：

1. **字符级去重已接近饱和**：库里残留的「同一件事被写了两遍」只有 **0–2 处/份**；完全一致与被 ≥0.92 规则拦下的重复**残留 0 对**（说明现行两条规则确实在工作）。
2. **包含关系不是缺口**（原猜测被数据否定）：4 份汇编合计只有 **2 对**包含关系，且**都在同一来源内**、跨来源 0 对。为它单加规则收益≈0。
3. **剩下的只有「措辞改写型」重复**（Dice 0.5–0.85，跨来源实测 46 对，其中数字一致的只是少数），例如「长乐区有省一级达标高中 2 所、二级达标高中 3 所。」vs「全区各类学校中，有省一级达标高中2所、二级达标高中3所。」（实测 Dice 0.722）。**字符相似度判不出这类重复，只能靠大模型判语义**；而同一区间里同时混着大量**真正不同的事实**——不同年份的招生数（3625 / 3770 / 4123 人）、同一项目的不同阶段（「办理工程规划许可证」vs「建设稳步推进」）、规划与投用口径差异。**误合并＝直接丢材料**。
4. 因此本功能的**真实作用面是「改写型重复约 1–4 处/份（120 段汇编）」**，不是几十处。性价比排序由此确定：**先把「多来源」的地基铺好（便宜、零风险），语义去重（贵、有误合并风险）等看到实际效果再决定**。

#### 7.12.2 目标形态（2026-10-02 用户裁定：**方案 B**）

**方案 A — 只做去重，不标多来源**
- 做法：成文阶段补两条本地规则（跨来源 0.85–0.92 同数字、包含关系），合并后仍只留一个来源。
- 代价：小（只改 `assembleDocument` 判定 + 单测）。
- 收益：实测**多合并 0–2 处/份**。
- 不满足：用户原问题「合并后是否标注多个来源」仍是否；被合并来源的信息仍然丢失。

**方案 B — 去重 + 多来源标注（本地判定）【推荐】**
- 做法：A 的规则 + 段落↔来源改**多对多**（关系表承载"并列记载"）；段落**保留一个主来源**＝ evidence 所在的那一个，**不动** evidence 逐字校验与矛盾归因。
- 界面：段尾圆标并列显示多个编号；点开来源小卡列出**全部**来源。
- 导出：docx 该段上标 `1,4`；附录来源清单不变。
- 来源删除：按关系表算「影响 N 段」，并区分"只由它记载的段"与"还有其它来源的段"。
- 代价：中（1 次迁移 + 8 处下游同步 + 版本快照那一列必须同步，见 §7.12.7）。
- 收益：真实触发面小（0–2 处/份），但**这是以后做语义去重的地基**（否则"合并"就等于"丢来源"），并顺手修掉 `cited_count` 的口径问题。
- 风险：低（本地规则零幻觉、零误合并）。

**方案 C — 语义去重 + 多来源标注（加一趟大模型）**
- 做法：B + 整合提取之后再跑一趟「同一件事归并」（输入＝成文后的段落，输出＝「X 与 Y 是同一件事，保留 X」），本地逐条校验后应用。
- 代价：大（120 段约 1–3 次调用、数分钟、按量计费；必须防幻觉误合并，需配「标出疑似重复由用户裁定」或「可回退」）。
- 收益：能覆盖实测**约 1–4 处/份**的改写型重复——**这是唯一能真正提高「同一件事只留一处」的手段**。
- 风险：中高（误合并＝丢材料，与"宁多勿漏"张力；且"同一件事"的粒度需要人工定义）。

**多来源的展示形态（子选项）**
- **b1（推荐）圆标并列多个编号**（`1` `4`）：与现有"圆标＝编号"完全一致，一眼看出这段有两个出处。
- b2 圆标 `1⁺`（主编号 + 加号）：省空间，但需要额外图例解释。
- b3 圆标只显示主编号，其余来源只在悬停/小卡里：改动最小，但"标注多来源"不显眼。

**判定口径（子选项）**
- **i（推荐）只用本地可证明的规则**（完全一致 / Dice 阈值 / 包含关系），数字不一致一律保留。
- ii 追加 LLM 判定（等价于方案 C）。

#### 7.12.3 开发规划：三个可独立验收的切片

> **依赖顺序 S1 → S2 → S3**；每个切片完成即停下等用户验收（沿用本项目惯例：一个可验收单元一次提交）。

**S1｜数据底座 + 本地去重规则（后端，界面暂无可见变化）**
- **Migration 042 新增并列来源表（纯新增，不改任何现有列）**：
  `compilation_item_sources(item_id, source_id, created_at)`，主键 `(item_id, source_id)`，`item_id → compilation_items(id) ON DELETE CASCADE`、`source_id → sources(id) ON DELETE CASCADE`，另建 `source_id` 索引。
- **回填**：把现有 391 个段落的 `source_id` 各写一行（实测 **391 行**，其中 7 行属已被排除的段落）。
- **保留** `compilation_items.source_id` 作为「主来源／证据来源」：evidence 逐字校验、矛盾归因、圆标主编号一律以它为准；并列来源只承载"另一个来源也记了这件事"。**这样 Phase 7.2 裁定的 D1「不得跨来源拼接」仍然成立**（成文仍以单一来源的证据为准，合并只是登记并列出处）。
- `assembleDocument` 合并时把被合并段的来源收进并列来源集合；补两条零风险本地规则：跨来源 0.85–0.92 同数字合并、包含关系合并（数字一致 + 短段 ≥12 字）→ 实测多合并 0–2 处/份。
- 仓储 `upsertCompilationParagraphs` 在**同一事务**内同步关系表（保留段 id 的语义不变）；`ensureCompilationSources` 的引用计数改为**按需实时查询**（顺带修掉 `cited_count` 恒为 0，见 §7.12.8）。
- **验收**：typecheck 零错误 / 单测全通过（除既有 chokidar 环境项）/ 生产构建成功；**Migration 042 真实库副本演练**——41 → 42、391 段落 → 391 关系行、`sources`／`compilation_contradictions`／`compilations`／`web_site_articles` **零变化**、`integrity_check=ok`、外键违规 0、重复执行幂等。

**S2｜界面呈现（用户第一次"看得见"）**
- 段尾圆标：一段有多个来源时**并列显示多个可点圆标**（`1` `4`），每个仍可点击、悬停显示对应来源标题。
- 来源小卡：从"单条来源"改为"列出该段全部来源"——编号 + 标题 + 该来源在本汇编的全部段落 + 打开原文/查看本地快照。
- 三套主题样式一致；**单来源段落的显示与现在完全一致**（无回归）。
- **验收**：用真实数据里那 1 对并列来源（或手工造一份演示汇编）看到两个编号并能分别打开原文；旧汇编显示不变。

**S3｜导出与来源删除（下游收口）**
- docx：该段上标 `1,4`；附录来源清单不变（编号↔标题）。`.xzsc` 升 **v3**（段落增加并列来源字段），**兼容读 v2**。
- 来源删除：`getSourceRemovalStats` 改为按关系表统计，并区分「只由该来源记载的段」与「还有其它来源的段」；确认框文案如实说明。
  - 用户选「保留卡片」：维持现行行为（段落 `source_id` 被置空、显示来源待补，**段落不删**——现行外键是 `ON DELETE SET NULL`，不是级联删除）。
  - 用户选「删除卡片」：**只删"只由该来源记载"的段**；**还有并列来源的段保留**，并把主来源改指剩余来源之一（关系行随外键级联删除）。← 本次改造**风险最高的一处**。
- **验收**：删除有并列来源的来源 → 该段仍在且编号改指另一来源；删除唯一来源 → 与现行完全一致；docx/xzsc 往返正确；来源删除提示的数字与实际相符。

#### 7.12.4 验收标准（草案）

**可直观验收（用户侧）**
1. 同一件事被两个来源分别收录时，汇编里**只有一处**，且该段显示**两个编号**；点开列出两篇来源标题，两篇都能打开原文。
2. 导出 docx：该段上标为 `1,4`，附录来源清单同时含 1 与 4。
3. **数字不一致的两段仍然都在**（矛盾不被抹平）——用真实样例断言：`长乐区普通高中招生录取 3625 人 / 3770 人 / 4123 人` 三段必须全部保留。
4. 删除其中一个来源：该段**仍在**（还有另一个来源），只少一个编号；确认框的「影响 N 段」与实际相符。
5. 旧汇编打开后显示不变（迁移回归）；既有 125 段汇编迁移后**段数、来源编号、矛盾零变化**。

**工程验收**
- typecheck 零错误；vitest 全通过（除既有 chokidar `unlink` 环境项）；生产构建成功。
- **Migration 042 真实库副本演练**：版本前进 → 目标数据变化符合预期 → `sources` / 段落数 / `compilation_contradictions` / `compilations` / `web_site_articles` 零变化 → `integrity_check=ok` → 外键违规 0 → 重复执行幂等。
- 新增单测：跨来源 0.85–0.92 同数字合并、包含关系合并、数字不一致不合并、并列来源落库与顺序、来源删除后段落保留、docx 多上标、`.xzsc` v3 往返。

#### 7.12.5 边界与不做的事（草案）

- **不做**字段级／结构化的事实合并（不把「2020 年招生 3625 人」抽成字段再跨来源比对）。
- **不删除**任何来源原文（被合并段落的原文仍在来源里，可随时回看本地快照）。
- **不动**「数字不一致一律保留」这条底线（矛盾归矛盾）。
- 对话编辑（`doc:edit` 的 `merge`）**仍只允许同来源合并**——避免用户手工改完又被自动合并；跨来源合一只在生成管线的成文阶段发生。
- **不做**「用户逐条裁定疑似重复」的新交互（除非选方案 C 并要求人工裁定）。
- **不改** `evidence` 逐字校验口径（仍以主来源的卡片原文校验；合并只增加"并列来源"，**不引入跨来源拼接成文**——D1 仍然有效）。

#### 7.12.6 裁定清单（2026-10-02 用户敲定）

| # | 问题 | 用户裁定 | 说明 |
|---|---|---|---|
| Q1 | 目标形态 | **B：去重 + 多来源标注（本地判定）** | 语义去重（C）留待看到 B 的实际效果后再定 |
| Q2 | 多来源展示形态 | **b1：段尾并列多个编号圆标** | 与既有"圆标＝编号"一致，一眼看出两个出处 |
| Q3 | 判定口径 | **i：只用本地可证明的规则** | 完全一致 / Dice 阈值 / 包含关系；数字不一致一律保留 |
| Q4 | 来源被删后该段怎么办 | **保留段落（还有别的来源）** | 该段仍在，只摘掉被删来源的编号 |
| Q5 | 顺带修 `cited_count` | **改实时查询** | 原实现恒为 0 且渲染层从未使用（见 §7.12.8） |

#### 7.12.6.1 实施进度、验证数字与计划偏差（2026-10-02）

**S3（导出与来源删除）— 代码完成、待用户实测**

- **docx**：一段由多个来源共同记载时，上标写成 `1,2`（与查看器并列圆标同口径）；**并列来源也进文末来源清单**（否则"另一处出处"在导出件里就断了）。
- **`.xzsc` 升 v3**：段落新增 `alsoSourceOrdinals` / `alsoSourceTitles`，编号表同时登记并列来源；**兼容读 v1/v2**（v2 归档没有这些字段 → 按无并列来源处理，不凭空造）。
- **来源删除按并列来源分档**：`getSourceRemovalStats` 改按关系表统计段数，并分「只由它记载（孤本）」与「还有其它来源（`sharedCount`）」两档；确认框如实写出「其中 N 段还有其它来源共同记载，将保留并改指其它来源」。
  - 用户选「删除资料汇编条目」：**先改指、再删**——还有其它来源的段改指剩余来源（`source_id` 与圆标编号一起改，编号取剩余来源在本汇编的 ordinal），随后只删孤本段；
  - 用户选「保留」：孤本段保留（外键 SET NULL → 显示「来源待补」），**共同段同样改指剩余来源**（比变成"来源待补"更可溯源）；
  - 编号表里被删来源那一行**保留不清**（"编号只增不回收"，D2 不变）。
- **顺手修正导入路径（同类缺陷）**：`importCompilationIntoTask` 原先只写旧卡片模型的 **10 列** → 从「生成汇编」导入到「撰写初稿」后**年份分节、来源圆标、证据引文、段落 origin/revision、并列来源全丢**（与 7.7 已修的"演示/降级走段落模型"同一类问题，这条路径当时漏了）。现按 **19 列 + 编号表 + 并列来源关系**整体深拷贝，编号沿用源汇编。
- **验收**：typecheck 零错误；vitest **282/283 通过**（1 项既有 chokidar 环境失败；S3 新增 6 项单测：docx 多上标与附录、xzsc v3 往返 + v2 兼容、来源删除改指共同段、保留档孤本段、导入深拷贝元数据与并列来源）；生产构建成功（CSS 124.86 kB / JS 4,187.40 kB）。

**S1（数据底座 + 本地去重规则）— 已完成并自验**

- Migration 042 新增 `compilation_item_sources(item_id, source_id, created_at)`（主键 `(item_id, source_id)`，两个外键 `ON DELETE CASCADE`）+ `source_id` 索引 + 回填；**纯新增，不改任何现有列**。
- `compilation_items.source_id` **保留为「主来源／证据来源」**：evidence 逐字校验、矛盾归因、`assembleDocument` 的「同一段只以一张卡片的证据为准」都不变 → **Phase 7.2 的 D1「不得跨来源拼接」仍然成立**。
- 合并时把被合并段的来源记入 `alsoSourceIds`（完全一致 / 包含关系 / 同来源 Dice / 跨来源 Dice 四条路径都记）；写入统一走 `upsertCompilationParagraphs` 的事务（关系行＝该段全部来源，先删后插）。
- 用户可见链路全部同步：对话编辑（`doc-edit-runner` 保留并列来源）、撤销/恢复快照（`compilation-undo` 增 `itemSources`，恢复期间外键关闭故必须显式清/重插）、版本快照与恢复（`buildParagraphSnapshot` / `restoreCompilationFromVersion`）、旧卡片写入路径（`insertCompilationItems`，保持"关系表＝全部来源"的不变量）。
- `cited_count` 改为 `listCompilationSources` **实时查询**（原 `ensureCompilationSources` 内的计数 UPDATE 与测试口径不一致，已删除）。
- **验证**：typecheck 零错误；vitest **275/276 通过**（1 项既有 chokidar `unlink` 环境失败，非回归；新增 9 项单测）；生产构建成功（CSS 124.86 kB / JS 4,186.93 kB）。**Migration 042 真实库副本演练**：41 → 42；关系行 **391**（＝有来源段落 391，覆盖段落 391，无一段多行）；`compilations` 4 / `compilation_items` 391 / `compilation_sources` 98 / `compilation_contradictions` 16 / `variants` 60 / `compilation_versions` 5 / `sources` 784 / `web_site_articles` 62,506 / `task_web_materials` 300 / `chunk_embeddings` 160,095 **全部零变化**；`integrity_check=ok`（迁移前后一致）、外键违规 0、重复执行幂等。**Q5 在真实数据上生效**：4 份汇编的 `cited_count` 合计分别为 73 / 74 / 125 / 119（＝各汇编全部段落数），原先是 98 行全 0。

**⚠ 计划偏差（我实现时改了方案，必须记录）**

§7.12.3 的 S1 原写「补两条本地规则：跨来源 0.85–0.92 同数字合并、包含关系合并」。实现时我用真实数据复核了第一条，**决定不降低跨来源阈值（保持 0.92）**，只做了包含关系：

- 支持降阈值的证据：真实库跨来源 0.85–0.92 区间确有 **2 对**，且都是"同一件事、其中一版更全"（如「长乐区全力打造现代教育强区，推动集团化办学…」vs「长乐区推动集团化办学…」，Dice 0.854/0.872）。
- **反对的证据（决定性）**：同批实测出该区间的**误合并**形态——「长乐七中教学综合楼项目投资1200万元新建教学综合楼。」vs「**长乐三中**…」Dice=**0.905**、「长乐一中首占校区的学生宿舍楼工程已完工。」vs「**长乐二中**…」Dice=**0.889**，**数字完全一致**，差别只在主体名一个字。降到 0.85 会把不同学校的材料**静默吞掉**，与"宁多勿漏"和"绝不静默丢材料"直接冲突。
- 结论：**阈值保持 0.92**；包含关系规则按计划实现（数字一致 + 短段 ≥12 字）。**代价（须知）**：包含关系在真实库里只命中 **2 对**（且都在同一来源内、其中 1 对数字不同），因此 S1 的**去重收益≈0–1 处/份**——真正能提高"同一件事只留一处"的仍然只有方案 C（大模型判语义），S1 交付的价值是**"多来源"的数据地基**（合并不再丢来源）。

**S2（界面呈现）— 代码完成、已由用户实测通过**

- 段尾圆标支持一段多个：主来源实线、并列来源虚线（**刻意不用颜色区分**——classic 主题的 accent 是暗红，靠颜色会误读成"警告"）。
- 来源小卡新增一行「这段由 N 个来源共同记载：**来源 1《…》/ 来源 2《…》**」，可点击在各出处之间切换。
- **验收前提（重要）**：并列来源只有**重新生成**后才会出现，而实测触发面是 0–2 处/份，所以"重新生成一份真实汇编"**不保证**能看到它。因此把演示数据改成可确定性验收：演示汇编里「2021 年，全市共有幼儿园 212 所，在园幼儿 11.8 万人。」一段由「福州市学前教育发展报告」与「长乐区教育局统计」共同记载（两篇演示来源的正文都已含该事实），段尾会出现 **1 与 2 两个圆标**；由于演示种子是幂等的（任务已存在即跳过），**需要先删掉「测试任务（仅作为演示）」再重启软件**才会重建。

**⚠ 演示任务重建事故与修复（2026-10-02 用户实测，S2 验收时暴露）**

用户按上述指引删除演示任务并重启后，**看到的是一个点进去空白的演示任务**。逐层查到**两条既有缺陷**（不是 S1/S2 引入，但被"删任务再重启"这个动作触发）：

1. **孤儿演示来源撞主键 → 种子中途失败**。演示来源用的是**固定 id**（`demo-src-prek` / `demo-src-changle`），而删除演示任务时 `sources` 行**不会一起删掉**（实测它们仍指向已不存在的 `2dc47da4`）；重建时 `insertDemoSources` 用的是普通 `INSERT` → **PRIMARY KEY 冲突抛错** → 任务已建好、来源/汇编/矛盾全没建（实测：新任务消息数 0、汇编 0、来源 0）。
2. **错误被吞 + 按标题幂等 → 永远不再重试**。`ensureDemoTask` 把异常 `console.error` 后返回 null，而种子判断是"同标题任务已存在就跳过"→ 空壳任务**永久保留**，用户看到的就是空白演示任务。这与项目一贯的"静默失败最危险"是同一类问题。

**修复**：① `insertDemoSources` 改为 `ON CONFLICT(id) DO UPDATE`（**就地更新、不删行**，因此不触发任何级联，把旧演示来源重新认领到当前任务；实测真实库中引用这些演示来源的段落/关系行/矛盾说法**均为 0**，重认领不触碰真实数据）；② `ensureDemoTask` 增加**自愈**：任务在但**内容缺失**（无汇编 / 无初稿）时补齐内容，并把失败写入项目诊断日志（可在设置页「导出日志」看到），不再只落 console；③ 初稿演示的"导入汇编"与"对话消息是否存在"**解耦**（否则自愈时会停在"补了消息、仍没汇编"的半修状态）；④ 种子拆成 `seedCompileDemoTask`/`seedCompileContent`、`seedDraftDemoTask`/`seedDraftContent`（新建与自愈共用同一段口径）。

**验证**：新增 2 项回归单测（孤儿来源场景、空壳任务自愈场景，含初稿演示的"半修状态"）；vitest **277/278 通过**（1 项既有 chokidar 环境失败）；typecheck 零错误；生产构建成功（CSS 124.86 kB / JS 4,186.93 kB）。**在真实库副本上端到端跑通自愈**：修前 compile/draft 演示汇编各 0 → 修后各 1（compile 7 段 / 1 组矛盾 / 并列来源段 `alsoSourceOrdinals=[2]` 且标题正确；draft 有初稿）、演示来源 2 行全部重新认领到新任务、演示任务仍为 2 个、**真实汇编 4 份 / 391 段落零变化**、`integrity_check=ok`、外键违规 0、重复执行幂等。

#### 7.12.7 波及面清单（S1–S3 实现时必须同步改的地方）

| # | 位置 | 现状 | 需改 |
|---|---|---|---|
| 1 | `src/main/writing/compilation-document.ts:555-623` | 单一 `sourceId`；Dice 两条阈值 | 合并结果携带并列来源集合 |
| 2 | `src/main/db/migrate.ts`（新增 042）+ `db/compilations.ts:743-767` | `compilation_sources` 编号表；`cited_count` 由 `source_id` 单值统计 | 建关系表 + 回填；引用计数改实时查询 |
| 3 | `db/compilations.ts:776-834` `upsertCompilationParagraphs` | 段落 19 列，`source_id`/`source_ordinal` 单值 | 事务内同步关系表（**保留段 id** 语义不变） |
| 4 | `src/main/writing/compilation-undo.ts:14-90` 与 `compilation_versions` 快照／恢复 | 快照显式写 19 列 | **必须同步处理关系表**（7.4 踩过的坑：漏列导致 `year`/`source_ordinal` 全丢） |
| 5 | `src/main/writing/compilation-export.ts:139`（docx 上标）、`:229-255`（`.xzsc` v2） | 单上标、单来源 | 多上标 `1,4`；`.xzsc` v3 + 兼容读 v2 |
| 6 | `src/renderer/src/components/CompilationStep.tsx:334 / 912-998` | 圆标＝单 `sourceOrdinal`；来源小卡按单编号反查 | 圆标并列编号；小卡列出全部来源 |
| 7 | `src/main/workspace/source-removal.ts:42-52` | `compilation_items WHERE source_id = ?` 计数 | 按关系表统计；区分"唯一来源段"与"并列来源段" |
| 8 | `src/main/writing/doc-edit-runner.ts:90-110` | 按 `sourceOrdinal → sourceId` 单值映射 | 主来源语义保持；对话编辑不得丢失并列来源 |

#### 7.12.8 本轮顺带发现的既存问题（不在 7.12 范围，需单独裁定是否修）

1. **`cited_count` 恒为 0（既存 bug：真实库 98/98 行全是 0，实算应为 5–25 条/行）**。根因是调用顺序——`compilation-service.ts:1196` 的 `ensureCompilationSources` 在 `:1201` 的 `upsertCompilationParagraphs` **之前**执行，而它内部的引用计数 UPDATE 数的是**上一轮（首次生成时为空）**的段落；重新生成会新建汇编行，所以永远数不到本轮段落。该字段**渲染层从未使用**（全项目只有类型、SQL 与内联单测引用），内联单测因"先写段落再调 ensure"一直是绿的 → **生产口径与测试口径不一致**。建议随 S1 一并改为**按需实时查询**，不再维护计数列。
2. **AGENTS.md 里「不删 sources 行，因为汇编段落通过外键引用来源，删行会级联删掉段落」的表述在当前 schema 下不准确**：Migration 022 已把 `compilation_items.source_id` / `contradiction_variants.source_id` 改为 `ON DELETE SET NULL`（本轮 `PRAGMA foreign_key_list` 核实），所以删来源**不会**级联删段落，真正删段落的是用户选「删除卡片」时的 `deleteCompilationItemsForSourceIds`（显式硬删）。**结论（不清 sources 行）仍然成立**（删来源会把段落的 `source_id` 置空、并经用户选择删段），建议只修订这句话的措辞。

历史参考数据（2026-09-12 那次真实生成）：125 段（网页 77 / 本地 48），`duplicatesDropped=1`、`conflictsKept=0`、矛盾组 5+（多数涉及网页来源）——即当时跨来源重复主要靠"完全一致"这一条兜住；2026-10-02 的完整量化见上方 §7.12.1。

### 7.8 阶段验收标准（每阶段均需"可直观验收"）

| 阶段 | 可直观验收的产品行为 | 工程验收 |
|---|---|---|
| **7.1** 数据模型与迁移 | 打开**旧汇编**仍能正常显示（界面不变、无功能退化），底层已为每段分配好来源编号与年份 | Migration 030/031 在**真实库副本**上跑通 + 迁移回归单测；编号/年份回填断言；`upsertCompilationParagraphs` 保持段 id 稳定；typecheck / 单测 / 构建通过 |
| **7.2** 管线（细读→整合提取→矛盾） | 同一标题重新生成后：**每段都含年份、每段都带来源编号**；无关内容大幅减少（字数明显下降） | 相关字占比、最终字数、"时间待核"段数、evidence 校验通过率、矛盾组数对比旧管线；耗时对比；新增单测（校验/排序/编号/降级） |
| **7.3** 文档查看器 | 右栏是一篇**连续文本**；段首时间、段尾圆标可见且点击能打开对应来源；矛盾面板「定位到该段」能滚动高亮 | 三种主题样式一致；500 段以上滚动流畅；旧汇编同样正常渲染；单测/构建 |
| **7.4** 版本与差异 | 做一次修改后，**改动段落被高亮**（绿=新增 / 黄=修改 / 红=删除，删除段插回原位）；**重启后版本历史仍在**。**2026-09-10 三轮验收简化**：不提供版本下拉与「与上一版对比」开关，改为**对话修改后自动进入复核态**（详见 7.5） | diff 正确性单测（新增/删除/修改/移动/段内字符级）；回退后**不产生新版本**且内容等于修改前 |
| **7.5** 对话框协同编辑 | 用户示例场景跑通：输入「校区建设不属于这方面的内容，请你把校区建设相关内容都删掉」→ 相关段被删除、查看器即时更新、对话框回「已按你的要求删除 N 段」；**修改后自动进入复核态**，用户「采纳 / 回退」二选一后退出 | 错误路径：坏 JSON → 文档不变 + 明确报错；幻觉 id → 该 op 被拒并说明；跨来源 merge → 拒绝；乐观锁冲突 → 提示重试；单测（协议解析/校验/应用/回滚） |
| **7.6** 导出 / 下游 / 左栏下线（含原 7.10） | 导出的 docx 段落连续、上标编号与附录来源清单对应；导入到新任务后文档/编号/版本一致；第三步用它生成初稿。**「生成汇编」功能区没有左栏**：首次生成、生成进度、中断续跑、多轮修改对话全部在悬浮面板内完成 | 导出单测（含编号↔来源映射）；第三步素材构造单测；来源删除影响段数提示正确；撰写初稿功能区不受影响；`task_messages` 生成记录仍在；typecheck / 单测 / 构建通过 |
| **7.7** 收尾 | 全流程演示通过；文档与实现一致 | typecheck 0 / 单测全通过（除既有 chokidar 环境项）/ 生产构建成功；死代码清理确认；基线数字更新 |

### 7.9 已裁定事项（用户敲定，2026-09-10）

| # | 事项 | 裁定 |
|---|---|---|
| **D1** | 管线顺序 | **A**：合并为一趟 —— `细读筛选 → 整合提取（裁剪 + 补全 + 整合）→ 矛盾扫描`；原「提纯」「修正」两阶段被整合提取取代 |
| **D2** | 圆标数字的含义 | **A**：**本汇编内**按首次引用顺序编号 1..N（同一篇文章的多段共用同一编号；编号只增不回收） |
| **D3** | 大模型编辑协议 | **A**：ops 引用段 id（`delete/replace/insertAfter/move/merge/split/setTime`）+ `replaceAll` 逃生舱；本地逐条校验后应用 |
| **D4** | 时间排序 | **C + D**：结构化 `year/month` + 本地稳定多键排序（年→月→来源序号→生成序）+ **按年份分节渲染**（`## 2018 年`）+ 允许用对话"移动段落" |
| **D5** | 手动编辑 | ~~确认汇编后经「开始人工修改」+ 不可逆二次确认解锁~~ **已于 2026-09-10 三轮验收中删除**：软件内不再提供逐段手改，改为「导出资料汇编 → 本地修改」（需要核对来源时再回软件内查看）。软件内改动汇编的唯一入口是**对话编辑**；对话修改后自动进入复核态，用户「采纳 / 回退」二选一 |
| **D6** | 版本与撤销 | 生成与**对话编辑**记版本；撤销栈只登记对话编辑（其余改动一律作废撤销栈，避免误伤）；恢复/回退**不记新版本**；只保留最近 2 版 |
| **D6** | 旧机制处置 | **A**：废弃「大模型修正」记录（`compilation_repairs`）与卡片回收站，撤销/恢复改为"上一版/下一版"；破坏性清理放在 7.7（新界面与版本机制上线后） |
| **D7** | 生成入口位置（原 7.10 待裁定） | **A**（2026-09-10 用户选定）：**悬浮面板兼作"生成模式"**——汇编为空时按钮打开的面板直接是「标题 + 要求 + 预设提示词 + 生成汇编」，生成进度与中断续跑提示也在该面板内；全局只保留**一个**入口。同时裁定**把 7.6 与 7.10 合并为一个阶段**（导出/第三步/回收站/来源删除 + 左栏下线） |

> **实施节奏（用户敲定）**：**按阶段推进，每完成一阶段停下来等用户验收**（每阶段完成即提交，遵守"一个提交一个目的"）。开工顺序：7.1 → 7.2 → 7.3 → 7.4 → 7.5 → **7.6（含原 7.10「左栏下线」）→ 7.7**。

## Phase 8：来源分栏查看与原文定位（2026-10-02 立项，**方案已裁定、实施中：先 S2**）

> **编号说明**：Phase 7（生成汇编重构）已成型，Last Phase（收尾阶段）按定义排在所有功能阶段之后；本阶段登记为 **Phase 8**，执行顺序在 Last Phase 之前。7.12 的两项后续可选项（泛词收紧、语义去重方案 C）与本阶段相互独立，各自单独裁定。

### 8.0 需求（用户 2026-10-02 提出，原话要点）

用户点击某篇文章来源之后，**可以直接在右侧分栏页打开该来源**（支持 PDF、Word、WPS、网页链接等格式），**如有可能，还需要直接定位到原文的对应位置**。开工前先调研同类实现，再给出前后端方案供用户选择。

### 8.1 调研：同类实现与可借鉴点（2026-10-02）

> **取证说明**：以下来自公开检索结果（标题/摘要）；其中部分页面本机网络取不回正文（`fetch failed`），已在"备注"里标注，**细节未经逐字核对**，仅用于判断"业界有哪种做法"，不作为实现依据。

| 参考对象 | 做法 | 可借鉴点 | 链接 / 备注 |
|---|---|---|---|
| **Obsidian PDF++ 插件** | 从笔记里的链接**精确跳到 PDF 的某页/某个选区**（链接携带位置信息），双向跳转 | 定位信息是**可序列化的锚**（页 + 位置），不是"打开就行" | [插件说明](https://github.com/RyotaUshio/obsidian-pdf-plus)（README 本机取不回） |
| **RAGFlow** | 命中分块可「点击定位到原文件对应位置」（后续提交 `#2247/#2399`）；早期 issue 明确「citations 不能跳进原文件」 | 与我们的诉求**完全同类**；业界同样分"能跳页 / 能高亮 / 能框选"三档 | [issue #12532](https://github.com/infiniflow/ragflow/issues/12532)、[定位提交](https://huggingface.co/spaces/retopara/ragflow/commit/dedc63ea55bbea711db546ae122c45d6c62a066e) |
| **FastGPT** | 知识库「引用分块阅读器」：引用列表 + 分块原文 + 高亮 | 引用与原文**同屏**（阅读器/侧栏）而不是弹窗 | [官方教程](https://fastgpt.cn/tutorial/fastgpt-knowledge-quote-reader)、[文档](https://doc.fastgpt.io/zh-CN/guide/chat/quoteList) |
| **Onyx（原 Danswer）** | 引用 → 侧栏来源面板展示引用片段并可打开文档 | **侧栏/分栏**承载来源查看 | [引文实现解析](https://blog.gitcode.com/adf212ed6ab8d013393c4b2d18a85943.html) |
| **AnythingLLM** | citation 悬浮/弹窗查看原文片段 | 轻量做法（弹窗）——我们已有类似形态（来源小卡） | [使用手册 PDF](https://edu.ge.ch/moodle/pluginfile.php/1316255/mod_folder/content/0/Livret/Atelier_IA_Locales_Livret_03_AnythingLLM.pdf) |
| **思源笔记 + Zotero** | PDF **页级**跳转（`#page=N`） | **最低成本档**：只跳页不定位 | [文章（PDF）](https://b3logfile.com/pdf/article/1613805437618.pdf) |
| **react-pdf-viewer Search Plugin / pdf.js 内置查找** | 文内搜索全部命中 + 高亮 + 「上一个/下一个」 | **用"文内搜索"代替"偏移映射"**是成熟且省力的落地方式 | [Search Plugin 文档](https://deepwiki.com/react-pdf-viewer/react-pdf-viewer/5.2-search-plugin)、[高亮居中问题 issue](https://github.com/react-pdf-viewer/react-pdf-viewer/issues/1883) |
| **react-pdf-highlighter / pixel-accurate pdf highlighting** | 用 pdf.js 的 text layer 做**像素级多词高亮**、可滚动到高亮 | PDF 高亮的现成参考实现（我们可自建，不必引依赖） | [react-pdf-highlighter](https://github.com/wbcoder0/react-pdf-highlighter)、[pdf-highlighter](https://github.com/jobzz-kj/pdf-highlighter) |
| **docx-preview / mammoth** | 浏览器端离线把 docx 渲染成 HTML（docx-preview 更保真：分页/表格/样式） | docx 的**渲染与文本定位都在前端**可解，无需服务端 | [docx-preview 原理与实战](https://developer.cloud.tencent.cn/article/2621984)、[docx 预览选型](https://developer.aliyun.com/article/1661314) |
| **kkFileView / fileView** | 服务端统一预览（LibreOffice 转 PDF 等），前端统一用 PDF 阅读器 | **代价重**（要装 LibreOffice/起服务），与"本地优先、单机安装包"冲突 → 仅作对照 | [kkFileView 方案](https://xiaobichao.blog.csdn.net/article/details/145062760)、[fileView](https://github.com/dolonfly/fileView) |

**调研结论（三条）**：
1. **"点来源 → 分栏/侧栏打开 + 高亮命中处"是成熟范式**，RAGFlow / FastGPT / Onyx 都这么做；差别只在**定位精度**（跳页 → 页内高亮 → 坐标框选）。
2. **最省力且体验可接受的做法是"文内搜索定位"**（把引文当检索词，命中的第一条滚动+高亮，可上下切换）——不依赖解析期存偏移，也不依赖更重的库。
3. **能真正"精确到坐标"的实现都要付出解析成本**（在解析时保留 text spans/bbox 或页-字符映射并落库），并且**只有 PDF 值得这么做**；`.wps`/`.doc` 在浏览器端**没有排版还原方案**（只能抽文本，或交给外部程序）。

### 8.2 本项目的现状与差距

| 能力 | 现状 | 差距 |
|---|---|---|
| 来源正文 | `sources.cleaned_text`（解析后的纯文本，已是**所有定位的公共坐标系**） | — |
| 本地快照 | `sources:getSnapshot`（读库、不联网、高亮命中片段） | 目前只在弹窗里，未进右栏 |
| 文件本体 URL | `sources:getFileUrl`（本地文件服务，PDF/图片已用） | — |
| docx → HTML | `sources:renderHtml`（mammoth 系；`SourceViewer` 已用它渲染） | 是否保留段落结构需核对；样式保真度一般 |
| PDF 渲染 | `PdfViewer.tsx`：**逐页渲染到 canvas**，仅供看图 | **没有文字层** → 不能选中、不能高亮、不能搜索 |
| 打开来源 | `openSourcePath`（系统默认程序）+ 来源小卡/矛盾弹窗里的「打开来源」 | 都是"离开软件"，不是"分栏内看" |
| 定位原语 | `locateVerbatim(parentText, needle)`（**容忍排版空格**的逐字定位，主进程纯函数，已用于 evidence 校验） | 只在主进程、只在生成期用 |
| 段落到证据 | 段落带 `evidence`（逐字引文）、矛盾说法带 `variantText` | **这些正是天然的"定位锚"**，但从未用来定位 |

### 8.3 核心技术难点（决策要点）

1. **统一的"定位锚"**：建议定义为 `{ sourceId, snippet, offsetHint?, pageHint? }`——`snippet` 取段落 `evidence`（或其前 N 字），`offsetHint` 是在 `cleaned_text` 上的字符偏移（可选，用于消歧与"优先精确"）。所有格式的差异都被"锚 → 该格式的显示位置"这一层吸收。
2. **文本类来源**（txt/md/网页快照/`.doc`/`.wps`/Excel 抽文）：对**渲染后的 DOM 文本节点**做偏移累计 → 命中即 `scrollIntoView` + `<mark>` 高亮；`locateVerbatim` 的"去空白归一化"必须沿用（PDF/Word 抽出的文本里有排版空格）。
3. **PDF**：两条路——(a) 给 `PdfViewer` 加 **text layer**（pdf.js `TextLayer` + `getTextContent()`），在页内做去空白匹配定位并高亮（**不落库**）；(b) 解析期记录**每页字符区间**（甚至 spans 的 bbox）落库，运行时可精确到坐标框选（**要 Migration**）。前者足以满足"跳到对应位置"，后者才是"像素级框选"。
4. **`.wps` / 旧 `.doc`**：浏览器端**没有**排版还原方案。可选：分栏内显示**抽取文本 + 定位**（推荐），工具条保留「用系统默认程序打开」；不做 LibreOffice 转换（体积/许可/本地优先）。
5. **网页来源**：分栏内渲染**本地快照**（已有数据，且符合"全程可溯源"），高亮命中段；「用浏览器打开线上页」保留为次选动作（线上页已改版时，快照才是证据）。

### 8.4 候选方案（**2026-10-02 用户裁定：本轮只做 A**；B/C 保留为后续升级项）

> **用户裁定（2026-10-02）**：① 只先实现 **A**（分栏 + 文内搜索定位）；② 图片型（扫描件）PDF **只需定位到页**、不做更精确的匹配；③ **所有格式都要有两套打开方式**——内部分栏打开 + 外部系统默认查看器打开；④ 不为定位新增落库（Q4 由实现方取舍 → **本轮不落库**）；⑤ 分栏两处都要（资料库 / 生成汇编），但**优先保证「生成汇编」处的效果**；⑥ 网页来源希望**内置一个简单浏览器直接加载现有页面并定位**，**不要快照效果**（详见 §8.10）。

| 方案 | 做法（前端 / 后端） | 定位精度 | 代价与风险 | 是否动数据库 |
|---|---|---|---|---|
| **A｜分栏 + 文内搜索** | 前端：右栏分栏查看器；把引文当检索词做文内查找（高亮 + 上/下一个）。后端：复用现有 IPC。 | 跳到命中处（不保证是"那一处"，多处命中时需人工切换） | 最小；PDF 仍需加文字层，否则退回"跳页" | 否 |
| **B｜分栏 + 精确锚定（推荐）** | 前端：分栏 + 通用"文本定位器"（DOM 偏移 / PDF 页内 text layer 匹配）+ 多命中排序。后端：新增纯函数把 `evidence`/`variantText` 规范化为锚（沿用 `locateVerbatim`），可选 IPC `sources:locateAnchor`。 | 精确定位到该句并高亮；PDF 定位到**页 + 页内该句** | 中等；`PdfViewer` 要重写为"canvas + text layer"（现有全页 canvas 逻辑保留，叠加文字层） | 否 |
| **C｜B + 坐标级（PDF 框选）** | 在上面的基础上，解析期保存 PDF 每页 spans（文本 + bbox），运行时画出命中句的**矩形高亮**（PDF++ / Zotero 那种体验） | 像素级（可框选原句） | 最大：解析改造 + 落库 + PDF 坐标适配（缩放/旋转） | **是（Migration 043）** |
| **D｜外部程序打开（对照）** | 维持现状（系统默认程序 + 复制引文），不做内置分栏 | 无（靠外部程序自己找） | 0 | 否 |

### 8.5 切片（按用户裁定 A 重排；**大文件性能**与**内置浏览器**的方案见 §8.9 / §8.10，待裁定后再定顺序）

- **S1 右栏分栏查看器 + 文本类文内搜索定位（含外部打开）**：右栏分栏容器（可拖动/可关闭，**优先生成汇编**，再接入资料库）；按 kind 渲染（文本 / docx HTML / 图片 / PDF 占位 / 网页占位）；"文内搜索定位"通用件——把 `evidence`（或矛盾说法）当检索词，DOM 内查找 → 滚动到命中 + 高亮 + 上/下一个；工具条**恒有「用系统默认程序打开」**（Q2）。**不改库**。 —— **✅ 已完成（2026-10-02），详见 §8.14**
- **S2 大文件性能改造**（若你一上手就用年鉴 PDF 验收，建议把它提到 S1 之前或与 S1 并行）：文件服务支持 **HTTP Range（206）+ 流式读取**；PDF 查看器改**虚拟化渲染**（只渲染可见页、滚出即释放、可取消）；超大文件走**降级守卫**（见 §8.9）。**不改库。** —— **✅ 已完成（2026-10-02），阈值降级按 Q7 不做，详见 §8.13**
- **S3 PDF 文字层与文内搜索定位**：`PdfViewer` 增加文字层（可见页）；用锚在页内文本里搜索 → 滚到命中页并高亮；**图片型 PDF 只跳到页并明示「扫描件无文字层，无法高亮」**（§8.11）。 —— **✅ 文内搜索定位与高亮已完成（2026-10-02），详见 §8.15；可选中文字（DOM 文字层）未做，作为可选项另议**
- **S4 网页内置浏览器（§8.10 的 B1）+ 资料库右栏接入**：`WebContentsView` 加载线上页 + `findInPage` 定位高亮；入口同在「生成汇编」与「资料库」。 —— **网页内置浏览器已完成（2026-10-02，见 §8.16）；`findInPage` 文内定位按用户裁定暂不做（网页定位可先不要）；资料库侧锚定入口待 §8.17 定位修复一并处理**
- 每个切片完成即停下等验收（沿用项目惯例）。

### 8.6 验收标准（草案）

- 点某段的来源圆标 / 证据引文 / 矛盾说法 → **右栏分栏**打开对应来源，并停在命中处且高亮；能上/下一个命中。
- PDF：能滚到命中所在页并高亮该句。~~文字可选（证明文字层存在）~~ → **DOM 文字层（可选中文字）本轮未做**，见 §8.15 的说明与后续选项。
- docx：渲染后可定位并高亮；`.doc`/`.wps`：显示抽取文本并可定位（排版不还原，界面需明示）。
- 网页：分栏内显示本地快照并高亮；「用浏览器打开」仍可用。
- 未命中/来源缺失/文件已不在工作区 → **明确提示**，不静默、不白屏。
- 工程：typecheck 0 / 单测全过（除既有 chokidar 环境项）/ 生产构建；新增纯函数（锚规范化、DOM 偏移定位口径）必须有单测。

### 8.7 边界与不做的事（草案）

- 分栏查看器**只读**：不在里面编辑原文（改稿仍走对话编辑）。
- **不引入服务端/LibreOffice/kkFileView 式统一预览**（与本地优先、单文件安装包冲突）。
- 不做 `.wps`/`.doc` 的排版还原。
- 不做跨来源全文搜索（那是检索的事）。
- 不把"打开来源"从外部程序改为唯一路径——**外部打开保留**（用户可能要用 WPS 高级功能）。

### 8.8 待裁定清单（用户选择后本节转正）

| # | 问题 | 选项 | 我的推荐 |
|---|---|---|---|
| Q1 | 实现深度 | A 文内搜索 / **B 精确锚定** / C 坐标框选 / D 不做 | **B**（A 是 B 的子集；C 的收益主要在 PDF，代价是解析+落库，可作后续升级） |
| Q2 | `.wps`/`.doc` 处置 | 分栏内纯文本 + 可定位 / 只给"用系统默认程序打开" / 两者都给 | **两者都给**：分栏显示文本并定位，工具条保留外部打开 |
| Q3 | PDF 定位精度 | 只跳页 / 页内定位高亮 / 坐标框选 | **页内定位高亮**（C 才需要框选） |
| Q4 | 是否允许为定位新增落库 | 允许（Migration 043：页-字符区间/段落序号） / 不允许（全部前端现算） | **本轮不允许**（B 不需要；等确认 C 再谈） |
| Q5 | 分栏出现在哪里 | 仅「生成汇编」右栏 / 仅「资料库」右栏 / 两处都要 | **两处都要**（组件共用） |
| Q6 | 网页来源的默认动作 | ~~分栏内看本地快照~~ / **内置浏览器加载线上页并定位** | **用户已裁定：内置浏览器（见 §8.10）**，不要快照效果 |

### 8.9 大文件性能：现状根因与候选方案（**新增待裁定**）

**用户担忧**：年鉴之类的较大 PDF / 其他格式文件，"打开文件和渲染完毕极慢"。

**实测根因（读代码确认，非推测）**：

| # | 位置 | 现状 | 后果 |
|---|---|---|---|
| 1 | `index.ts` 文件服务（`:205` 一带） | `readFileSync(filePath)` **把整文件读进主进程内存**，**不实现 HTTP Range / 206**（只加了允许 Range 预检的 CORS 头），且 `cache-control: no-store` | 打开 200 MB 年鉴 = 主进程同步读 200 MB（**界面卡住**）+ 一次性全量传输 + 每次重开都重读；pdf.js 也无法按需分段取 |
| 2 | `PdfViewer.tsx`（`:78` 起"渲染全部页面"） | 把**每一页**顺序渲染成 canvas 并**全部留在 DOM** | 页数一多就越看越慢、内存/显存持续增长 |
| 3 | `SourceViewer.tsx` | docx 一次性 `renderHtml` 返回**整篇 HTML** 再 `dangerouslySetInnerHTML`；纯文本直接 `<pre>{cleanedText}</pre>` | 大 Word/大文本 → 大字符串跨 IPC + 一次性建巨量 DOM |
| 4 | `file-parser.ts` / pdf.js worker | PDF 解析走主线程 `pdf-parse`；渲染层 pdf.js 用**主线程 LoopbackPort worker**（AGENTS 已记录） | 大文件期间主线程被占，界面无响应 |

**候选方案**：

| 方案 | 做法 | 收益 | 代价/风险 |
|---|---|---|---|
| **P1｜流式 + 虚拟化（推荐）** | ① 文件服务支持 **Range 206 + `createReadStream`**（不再整文件读入），加 `Accept-Ranges` / ETag；② pdf.js 打开时**分段按需取**；③ `PdfViewer` 改**虚拟化**：只渲染视口内 ±1 页，滚出即 `page.cleanup()` 释放、渲染任务可 `cancel()`，文字层同样只给可见页；④ docx/文本改**分段/虚拟列表**渲染（先首屏，滚动再渲染） | 大文件**首屏秒开**、内存可控、滚动不卡 | 中等改动（文件服务 + PDF 查看器 + 文档渲染三处）；虚拟化下"全文搜索"需要"边搜边渲染"策略 |
| P2｜P1 + 渲染缓存/预热 | 首次打开后台生成缓存（PDF 首页缩略图、docx→HTML 分块、文本分页索引）落盘 userData（key = sourceId+mtime），可持久化进度、可中断续跑 | 再开**秒开** + 缩略图导航 | 磁盘占用 + 失效策略；实现量最大 |
| P3｜阈值降级（保险丝） | 超阈值（如 PDF > 50 MB / docx > 20 MB / 文本 > 5 MB）**不内置渲染**，给「用系统默认程序打开」+说明 | 最省、绝不卡死 | 超大文件在软件内看不到；只适合**兜底** |
| P0｜不改 | 维持现状 | 0 | 年鉴类文件基本不可用（你担忧的场景必然发生） |

**推荐：P1 为主体 + P3 作极端兜底**（> 200 MB 或 > 2000 页时默认建议外部打开，但仍提供"仍要在此打开"）。P2 留待你实际用一段时间后再决定是否为"秒开"付磁盘与实现成本。

### 8.10 网页来源：内置浏览器加载线上页并定位（Q6，**新增待裁定**）

**用户诉求**：内置一个简单浏览器，直接加载该链接的**现有页面**并定位；**不要**快照效果。

| 方案 | 做法 | 关键能力 | 评价 |
|---|---|---|---|
| **B1｜`WebContentsView` + `findInPage`（推荐）** | 主进程建**独立 `WebContentsView`**（现行推荐；`BrowserView` 官方已标 Deprecated）嵌入右栏位置；加载来源 URL；用 `wc.findInPage(引文片段)` **自动高亮并滚动到命中处**，监听 `found-in-page` 取命中数/当前序号，做「上/下一个」 | Electron 官方 `webContents.findInPage()` + `found-in-page` + `stopFindInPage()`；社区有现成"页内查找条"参考（如 `electron-find`，就是把 findInPage 包成 UI） | 体验最接近成熟软件的内置浏览器 |
| B2｜`<webview>` 标签 | 渲染层 `<webview>` 加载页面 | 写法简单 | Electron 官方**不推荐**（bug/性能/安全问题），不建议 |
| B3｜外部浏览器打开（现状） | `shell.openExternal` | 0 成本 | **不满足**"软件内加载现有页并定位" |
| B4｜快照兜底（**用户已排除**） | 分栏渲染本地快照 | 改版也能看 | 只保留为"线上页找不到该句"时的**提示选项**，不默认 |

**必须同时落实的安全约束**（页面内容是不可信输入，分层隔离）：
- 该 `WebContentsView` 单独 webPreferences：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、**不注入 preload**；
- `setWindowOpenHandler` **拒绝弹窗**；`will-navigate` 限定在该来源**站点域名**（信源白名单）；`will-download` 取消；`setPermissionRequestHandler` 全拒（定位/摄像头/通知等）；
- 该 webContents **不提供任何 IPC 桥**（页面拿不到软件能力）；只读浏览，不注入脚本、不代提交表单。

**定位的现实边界（须知）**：定位＝在**线上页面当前内容**里查找该引文片段。站点改版/正文调整后可能**找不到** → 明确提示「页面上未找到该句，可能已改版」+ 提供「用系统浏览器打开」。不做 OCR、不做跨页搜索。

### 8.11 图片型（扫描件）PDF 的"定位到页"（Q1/Q3，**新增待裁定**）

**一个必须先说清的事实**：**完全扫描、无文字层**的 PDF，`pdf-parse` 抽不到文字 → 该来源 `cleaned_text` 基本为空 → **它不会成为任何段落的来源**（也就没有"要定位的那一句"）。当前真实会遇到的其实是**混合型 PDF**（部分页有文字层）：这种可以用页内文本搜索定位到**页**（甚至到句）。

| 方案 | 做法 | 成本 | 说明 |
|---|---|---|---|
| **O1｜明示 + 外部打开（推荐）** | 有文字层 → 定位到**页**并高亮该句；无文字层 → 打开文件 + **明示"扫描件无文字层，无法定位到页"** + 给页码输入框 | 0 | 诚实、不假装能做到 |
| O2｜按需 OCR 定位 | 点"定位"时对该 PDF **逐页 OCR**（命中即停；未命中则全篇并缓存） | 每页 1–3 秒（年鉴可能数十秒~数分钟） | 能真定位到页；但需缓存 → 会引入落库/缓存文件，与你 Q4 取舍有张力 |
| O3｜解析期全量 OCR 建页级索引 | 后台任务、可续跑（同索引重建） | 最重（时间 + 磁盘） | 一劳永逸，但明显超出"只做 A"的范围 |

**推荐 O1**（配合 §8.9 的 P1：即便是扫描件，至少打开与翻页要快）。

### 8.12 新增待裁定清单（§8.9 / §8.10 / §8.11）

| # | 问题 | 选项 | 我的推荐 |
|---|---|---|---|
| Q7 | 大文件性能 | P1 流式+虚拟化 / P1+P2 缓存 / 只做 P3 降级 / 不改 | **P1 + P3 兜底** |
| Q8 | 网页来源实现 | B1 `WebContentsView`+`findInPage` / B2 `<webview>` / B3 只外部打开 | **B1** |
| Q8b | 内置浏览器是否给"地址栏/自由导航" | 不给（只加载该来源 URL，站内同域链接可跟随） / 给（等于内置通用浏览器） | **不给**——否则它会变成通用浏览器，与"信源白名单"精神相悖；站内跳转保留 |
| Q9 | 扫描件 PDF | O1 明示+外部打开 / O2 按需 OCR / O3 全量 OCR 索引 | **O1** |
| Q10 | 切片顺序 | S1→S2→S3→S4（先做分栏） / S2→S1→S3→S4（先解决大文件） | 取决于你第一次验收用什么文件：**用年鉴 PDF 就先 S2** |

> **用户最终裁定（2026-10-02）**：**Q7＝P1**（只做流式 + 虚拟化，**不含 P3 阈值降级**）、**Q8＝B1**（`WebContentsView` + `findInPage`）、**Q8b＝给**（内置浏览器**给**地址栏/自由导航——用户明确选择，与我的推荐相反；安全约束一项不减，见 §8.10）、**Q9＝O1**（扫描件明示 + 外部打开，不做 OCR）、**Q10＝先 S2**。
>
> **实施顺序（用户敲定）**：**S2 大文件性能 → S1 分栏查看器 + 文本类文内搜索定位 → S3 PDF 文字层与文内搜索定位 → S4 网页内置浏览器 + 资料库右栏接入**。每片完成即停下等验收。
>
> **Q7 只选 P1 的残留风险（如实记录）**：不做阈值降级时，极端文件（如 > 200 MB 的整本扫描年鉴）仍可能"能打开但慢/吃内存"，且没有"建议改用系统查看器"的保险丝。若实测遇到这类文件，再回来补 P3 或 P2。

### 8.13 S2 实施记录（2026-10-02，代码完成待用户实测）

**做了什么（四处，均为"治根因"而非调参）**：

| # | 改动 | 文件 | 说明 |
|---|---|---|---|
| 1 | 文件服务改 **HTTP Range（206）+ 流式读取** | 新增 [src/main/file-range.ts](src/main/file-range.ts)（纯函数：`parseRangeHeader` / `fileEtag` / `resolveFileDelivery`）+ [src/main/index.ts](src/main/index.ts) 接入 | 原实现 `readFileSync` 整文件进内存、**完全没有 206**（只加了允许 Range 的 CORS 头）、`no-store`。现在：`Accept-Ranges: bytes` + `createReadStream(start,end)` 按段下发 + ETag/`If-None-Match` → **304 复用**（重开不再传字节）；起点越界回 **416 + `bytes */size`**；多区间/非法头按 RFC **忽略 Range 回 200**（不猜、不 500）；支持 HEAD |
| 2 | PDF 查看器改**虚拟化渲染** | [PdfViewer.tsx](src/renderer/src/components/PdfViewer.tsx) + [src/renderer/src/lib/pdf-pages.ts](src/renderer/src/lib/pdf-pages.ts) | 原实现"**每一页都渲染成 canvas 并全部留在 DOM**"。现在：每页先放**占位块**（A4 比例预留高度，几百页也能瞬间建好、滚动条长度立即正确）→ 只渲染进入视口 ±600px 的页、**同时最多 2 页** → 滚出视口超过 2 页即**取消任务 + `page.cleanup()` + 移除 canvas**（占位块保留高度，滚动不跳）；单页失败只影响该页；pdf.js 打开参数加 **`disableAutoFetch`**（大文件不预先整包下载，配合 Range 按需取） |
| 3 | 新增工具栏：**页码跳转 / 上一页 / 下一页 / 第 X 共 N 页** | 同上 | 几百页文件可用；这也是 S3"定位到页"的落点 |
| 4 | docx / 纯文本改**分批进 DOM** | 新增 [src/renderer/src/lib/incremental.ts](src/renderer/src/lib/incremental.ts) + [IncrementalContent.tsx](src/renderer/src/components/IncrementalContent.tsx)，接入 [SourceViewer.tsx](src/renderer/src/components/SourceViewer.tsx) | 原先 docx 整篇 HTML 一次性 `dangerouslySetInnerHTML`、文本整块 `<pre>`。现在按**顶层块**（HTML，自写深度扫描器，注释/script/属性内 `>`/空元素都处理）与**行**分批追加，滚动到末尾附近继续加载，并给「全部展开」按钮（便于用户自己滚到底或查找）；换文档时正确重置 |

**验证**：
- `npm run typecheck` 零错误；- `npx vitest run` **298 项通过 / 1 项失败**（既有 `watcher.ts` chokidar `unlink` 环境项，非回归；总 299 项）；新增 **15 项单测**（Range 各形态 8 项、PDF 分页与保留区间 2 项、HTML 分块与文本分批 5 项）；
- **真实 HTTP 端到端校验（临时脚本，已删）**：起一个复刻投递写法的本地服务，用真实请求验证 `bytes=100-199` 返回**逐字节一致**的 100 字节（`createReadStream` 的 `end` 含端点，差一字节 PDF 就静默损坏）、`bytes=-50` 后缀区间、`bytes=1000-` → 416、ETag → 304、无 Range → 200 全量；4 项全过；
- `npm run build` 成功（CSS 126.54 kB / JS 4,204.54 kB，体积增加全部来自新增功能）。

**本轮刻意没做（避免超出 Q7 范围或引入不可验证风险）**：
- **P2 渲染缓存/预热**、**P3 阈值降级**（Q7 只选 P1）→ 极端大文件仍可能慢，见上方残留风险；
- **pdf.js 切到真实 Worker**：当前仍是**主线程 LoopbackPort**（本项目在 dev/http 与生产 file:// 下都验证过的方式），改动会影响构建与协议行为，需真机验证，留待单独评估；
- docx 渲染仍走 mammoth（`sources:renderHtml`），未换 `docx-preview`（S3 再评估排版保真度）；
- **HTML 清洗**：`IncrementalHtml` 仍沿用原有信任级别（mammoth 输出直出），"外部资料显示前清洗"这条待 S1 接入分栏查看器时一并处理（已记入 §8.7 边界）。

**待用户实测**：打开一本书级/年鉴级 PDF → 观察**首屏时间**与滚动流畅度；长 docx、长 TXT 的打开速度；页码跳转与「全部展开」是否符合预期。

**实测反馈与追加小改（2026-10-02）**：用户实测确认「**大文件的打开非常流畅，达成了预期效果**」；同时提出一项小改并已完成——**把 PDF 工具栏（页码跳转 / 上一页 / 下一页 / 缩小 / 放大 / 适应宽度）吸顶固定在栏顶，不随 PDF 滚动消失**。做法：`.pdf-viewer` **去掉 `overflow: auto`**（否则它自己会成为"最近滚动容器"，`position: sticky` 挂在它身上就永远不动——这是本改动的关键坑），工具栏改 `position: sticky; top: 0; z-index: 5` + **不透明底色**（否则页面内容从底下透出来）+ 下边框。链路上确认 `.pdf-viewer__toolbar → .pdf-viewer?（无 overflow）→ .source-viewer__body（无 overflow）→ .work-pane（`flex:1` + `overflow:auto`）` 之间**只有 `.work-pane` 是滚动容器**，因此吸顶挂在它上面；这条约束已写进 CSS 注释，供 S1 把查看器放进右栏时沿用（右栏若自带 `overflow`，吸顶要挂到右栏自己的滚动容器上）。验证：typecheck 零错误、**298/299 单测通过**、生产构建成功（CSS 127.14 kB / JS 4,204.54 kB）。


### 8.14 S1 实施记录（2026-10-02，代码完成待用户实测）

**做了什么**：

| # | 改动 | 文件 | 说明 |
|---|---|---|---|
| 1 | 新增**文内定位纯逻辑** | [src/renderer/src/lib/locate.ts](src/renderer/src/lib/locate.ts) | `normalizeWithMap`（去排版空白 + **归一化下标→原文下标**映射，DOM 定位必需）、`buildNeedles`（引文→检索词；去空白后 <4 字**不发锚**，宁可不定位也不乱定位）、`findNeedle`（整段找不到时**二分找"最长且确实出现的前缀"**，比固定档位（40/24/12）精度高）、`stripTags`（含引号内 `>` 与常见实体）、`locateInBlocks`（先在**字符串层**定位到"哪一块"）、`toOriginalRange`。6 项单测 |
| 2 | 分批渲染支持**定位优先** | [src/renderer/src/lib/incremental.ts](src/renderer/src/lib/incremental.ts)（不变）+ [IncrementalContent.tsx](src/renderer/src/components/IncrementalContent.tsx) | 传了锚时：**命中块必须先渲染出来**（否则"在 DOM 里找不到"是假象）；命中 → 首批渲染到"命中块 + 余量"；**未命中 → 展开全部**（这样"未找到"才是真的搜过全文）；每次追加回调 `onReveal` 触发重算高亮 |
| 3 | `SourceViewer` 升级为**可定位的共享查看器** | [SourceViewer.tsx](src/renderer/src/components/SourceViewer.tsx) | 新增 `locate` 锚（定位于该句并高亮 + 「第 i / n 处」+ 上一处/下一处）、`dense`（分栏紧凑表头）、`onClose`；**高亮用覆盖层矩形**（`Range.getClientRects` → 绝对定位 span）而**不改写正文 DOM**——docx 是命令式分批追加的 DOM，改写文本节点会打乱分批逻辑；命中矩形做了等值短路，避免 ResizeObserver 与重渲染互相触发；`scrollIntoView` 直接作用在覆盖层上（比手工换算滚动位置更准） |
| 4 | **两种打开方式**（Q2） | 同上 | 表头**恒有「用系统默认程序打开」**（`openSourcePath`），失败**就地提示**（`openExternalFailed`）不静默；因此**资料库与分栏两处、所有格式**都同时具备"内部查看 + 外部打开"。PDF/图片在锚存在时明确提示「PDF 的文内定位将在下一步支持」「没有可检索文字层」，**不谎报"未找到"** |
| 5 | 「生成汇编」右栏分栏 | [WritingWorkspace.tsx](src/renderer/src/components/WritingWorkspace.tsx) + [main.css](src/renderer/src/assets/main.css) | `.writing-workspace__source`（可拖拽 `ResizeHandle`，向左拖变宽，320–900px，可关闭）；**同一来源切换锚点不重新加载文件**（`key` 只用 sourceId） |
| 6 | 打开来源时带上**定位锚** | [CompilationStep.tsx](src/renderer/src/components/CompilationStep.tsx) / [ContradictionDialog.tsx](src/renderer/src/components/ContradictionDialog.tsx) | 来源小卡的「打开来源」→ 传该段 **`evidence`（逐字证据引文）** + 「本汇编第 N 段」；矛盾弹窗的来源链接 → 传该说法的 `variantText`。`CompilationItemView` 补 `evidence?`（主进程早已返回，此前渲染层类型未声明） |

**验证**：typecheck 零错误；vitest **304/305 通过**（1 项既有 chokidar 环境项；新增 6 项定位单测）；生产构建成功（CSS 129.52 kB / JS 4,220.95 kB）。**不改数据库。**

**待用户实测**：① 生成汇编里点某段来源 → 右栏打开并**停在那句、高亮**，可「上一处/下一处」；② 点「用系统默认程序打开」能唤起 WPS/Word/浏览器；③ docx 与 TXT 大文件的定位是否命中、找不到时提示是否清晰；④ 分栏宽度拖拽与关闭。

**本轮未做**：PDF 的文字层定位（S3）、网页内置浏览器（S4）；资料库侧仍按"打开整篇资料"处理，未做锚定入口（S4 一并处理）。

**实测反馈追加（2026-10-02）**：用户要求「返回 / 用系统默认程序打开」那一行与「上一处 / 下一处」那一行**一并吸顶固化**。做法：`.source-viewer__header`（含操作行 + 标题/标签/元信息 + 定位条）整体 `position: sticky; top: 0; z-index: 6` + 不透明底色（默认 `--bg-primary`，生成汇编分栏内改 `--bg-panel`，与该栏背景一致）+ 浅阴影（**不用 border**：正文自带 `border-top`，加边框会出现两条线）。
**随之必须处理的冲突**：PDF 工具栏此前也吸顶在 `top: 0`，两者会互相盖住 → `SourceViewer` 用 `ResizeObserver` 量出表头**实测高度**写入 CSS 变量 `--source-sticky-top`，`.pdf-viewer__toolbar` 改为 `top: var(--source-sticky-top, 0px)`，于是工具栏挂在表头**下面**逐层吸顶（标题两行 / 标签 / 元信息换行 / 定位条有无都能自适应）。验证：typecheck 零错误、**304/305 单测通过**、生产构建成功（CSS 130.62 kB / JS 4,221.87 kB）。

### 8.16 S4 实施记录：网页来源改为内嵌浏览器（2026-10-02，代码完成待用户实测）

**用户实测反馈与诉求**：点网页来源后，右栏显示的仍是**库里存的抓取快照**；用户要的是**直接内嵌一个浏览器看到原网页**，并明确「网页的定位到某句话可以先不做」。裁定沿用 Q8=B1（`WebContentsView` + 可选 `findInPage`）、**Q8b=给地址栏**、安全约束一项不减（§8.10）。

**做了什么**：

| # | 改动 | 文件 | 说明 |
|---|---|---|---|
| 1 | 主进程：内嵌浏览器视图 | [src/main/index.ts](src/main/index.ts) | `WebContentsView`（现行推荐；`BrowserView` 已废弃）叠加在主窗口内容区，位置由渲染层上报。**安全约束**：独立会话分区 `xz-webbrowser`（cookie/缓存与应用自身渲染进程隔离）、`nodeIntegration:false` + `contextIsolation:true` + `sandbox:true` 且**不注入 preload**（页面没有任何 IPC 桥）、`setWindowOpenHandler` 一律拒绝弹窗、`will-navigate` **只放行 http(s)**、权限请求全拒、下载一律取消。只暴露五个动作：打开 / 挪位置 / 关闭 / 导航 / 前进-后退-刷新；窗口关闭时一并销毁（避免"幽灵视图"） |
| 2 | IPC 契约与 preload | [src/shared/ipc.ts](src/shared/ipc.ts) + [src/preload/index.ts](src/preload/index.ts) + [index.d.ts](src/preload/index.d.ts) | 新增 `web:browserOpen` / `SetBounds` / `Close` / `Navigate` / `Action` 五个通道与类型（矩形用**窗口内容区 DIP**）；主进程对矩形做整数化与夹取，URL 只放行 http(s) |
| 3 | 渲染层浏览器分栏 | 新增 [WebBrowserPane.tsx](src/renderer/src/components/WebBrowserPane.tsx) | 地址栏 + 后退/前进/刷新/前往 + 打开中与失败提示（失败时提示改用「用系统默认程序打开」）；把容器高度压到"刚好填满到滚动容器底边之上"，**避免所在分栏出现滚动条**——因为那个视图是窗口坐标系浮层，分栏一滚就会错位；容器尺寸/窗口尺寸变化时用 `ResizeObserver` + `resize` 同步位置 |
| 4 | 接入查看器 | [SourceViewer.tsx](src/renderer/src/components/SourceViewer.tsx) + [zh-CN.ts](src/renderer/src/i18n/zh-CN.ts) + [main.css](src/renderer/src/assets/main.css) | `kind === 'url'` 的来源走内嵌浏览器（不再是快照文本）；定位条对网页来源如实显示「网页来源暂不做文内定位（可在页面内自行查找）」；**「用系统默认程序打开」保留**（Q2）；「查看本地快照」入口不变（核对"抓取当时"内容仍走它） |

**验证**：typecheck 零错误；vitest **309/310 通过**（1 项既有 chokidar 环境项；本轮未新增单测——这段是 Electron 视图与 DOM 浮层，只能真机验证）；生产构建成功（CSS 132.66 kB / JS 4,239.18 kB）。**不改数据库。**

**待用户实测**：① 点网页来源 → 右栏应加载**原网页**（可滚动、可点链接、可输入地址前往别的网址）；② 后退/前进/刷新可用；③ 拖分栏宽度、缩放窗口时网页区域应跟随、不错位、不出现双滚动条；④ 断网或站点打不开时，应看到明确失败提示并能改用系统浏览器打开。

**本轮未做**：`findInPage` 文内定位（用户明确"可以先不做"）；资料库侧的"从某段跳到来源"入口（等 §8.17 定位缺陷修复后一起做，否则会把错锚带过去）。

### 8.17 待办：定位溯源偏差的两个缺陷（已取证，等用户方案）

用户实测发现：点某段来源后，右栏打开的**文件是对的**，但**跳到了完全无关的一页、高亮的是无关句子**。已用真实数据取证，**两个独立缺陷叠加**：

1. **锚取错了段落（界面缺陷，主因）**：来源小卡的「打开来源」用 `keptItems.find(x => x.sourceOrdinal === sourceCardFor)`（按**来源编号**反查），而同一编号下有大量段落共用（实测这份汇编 ordinal 14 下有 **16 段**，另两份分别 24 / 17 段）→ `find` 返回的永远是排在最前面的那段。实测：用户点的是**第 48 段**（引文「2022 年，长乐区普通高中招生录取 4123 人。」），界面取的是**第 47 段**的引文——与截图里"本汇编第 47 段"完全吻合。「查看本地快照」按钮同一缺陷。
2. **搜索接受过短的泛化前缀且命中即停（算法缺陷）**：`findNeedle` 每页独立做"最长前缀退让"，只要 ≥4 字即算命中。逐页实测（351 页）：正确引文整句命中在**第 216 页**，但"任意 ≥4 字前缀"能在 **280/351 页**上命中（因为"2022年"到处都是）；错误引文的 4 字前缀"普通中学"在第 **66** 页即命中 → 现有实现停在**第 66 页**（用户那次落在第 **6** 页）——**即使锚取对，也会跳错页**。

**修复方向（已与用户对齐，等其方案）**：① 三处按 ordinal 反查改为使用"用户真正点击的那一段"（已有 `cardItem`），并列来源另开来源时改开该并列来源且不带主来源引文；② 搜索改"整句优先 + 退让有底线（≥ max(12 字, 60%)）+ 绝不因弱命中跳页，找不到就如实报未找到"；③ `evidence` 为空的段落（如《高中学校设置1》该编号下 17 段全空）不发锚只提示；④ 可选：解析期记录"页 ↔ 字符区间"映射（需 Migration）以求更准。

### 8.15 S3 实施记录（2026-10-02，代码完成待用户实测）

**做了什么**：

| # | 改动 | 文件 | 说明 |
|---|---|---|---|
| 1 | 给 `PdfViewer` 加**文内搜索定位** | [PdfViewer.tsx](src/renderer/src/components/PdfViewer.tsx) | 新增 `locateNeedles` / `onLocate` 两个属性。逐页 `getTextContent()` **顺序扫描、命中即停**（年鉴几百页时通常前几页就命中，不必扫全文）；每页把文字块拼成字符串，用与文本类**同一套口径**（去空白归一化 + 最长匹配前缀退让）匹配；命中后把字符区间落到具体文字块上。全程如实回报：正在定位（已扫描 N/M 页）/ 已定位到第 P 页 / 未找到 / **该 PDF 没有文字层（扫描件）**——最后一种按用户裁定只提示，不假装能定位 |
| 2 | **几何高亮**（不依赖 DOM 文字层） | 新增 [src/renderer/src/lib/pdf-hit.ts](src/renderer/src/lib/pdf-hit.ts)（5 项单测） | 由 `viewport.transform` × `item.transform` 复合出文字块在设备像素里的基点与朝向 → 按命中字符比例切出横向区间、纵向上移约 0.88 字高 → **统一换算成页面百分比**交给 CSS。用百分比的好处：分栏拖宽 / 窗口缩放 / 页面被 CSS 拉伸都不需要重算，也没有"文字层与画布缩放不一致"的坑。**仿射合成本项目自己实现**（不依赖 pdf.js 运行时），并用**手算期望值**钉住（含 y 轴翻转、部分字符区间、旋转块、坏数据收敛） |
| 3 | 命中页的渲染与滚动 | 同上 | 命中页若已渲染过 → **释放后重渲染**并在渲染完成时画高亮（页元素是命令式创建的，直接用真实 DOM 元素承载高亮层，`scrollIntoView` 精确滚到命中处）；该页被滚出视口释放时一并清掉高亮层，避免高亮浮在占位块上 |
| 4 | 定位条如实反映 PDF 进展 | [SourceViewer.tsx](src/renderer/src/components/SourceViewer.tsx) + [zh-CN.ts](src/renderer/src/i18n/zh-CN.ts) | PDF 不再显示"下一步支持"，而是显示「正在 PDF 里定位…（已扫描 N/M 页）」/「已定位到第 P 页，并高亮该句」/「未在该 PDF 的文字中找到该句（原文可能是改写版本）」/「该 PDF 没有文字层（扫描件），无法定位到具体页；可用页码跳转或『用系统默认程序打开』」。图片仍走"无文字层"提示 |

**同时修掉的界面问题（用户实测反馈）**：吸顶表头与栏顶之间**还有一条滚动容器的 padding 带**（分栏 16px / 资料库 32px），而 `position: sticky` 是相对**内容盒**定位的 → 滚动 PDF 时页面会在表头上方那条带子里露出来。修法：用 `.source-viewer__header::before` 伪元素把该带子盖住（`bottom: 100%` + 高度 48px + `background: inherit`），**不依赖具体 padding 数值**，也不会有"--top 负值"方案的轻微跳动。

**验证**：typecheck 零错误；vitest **309/310 通过**（1 项既有 chokidar 环境项；新增 5 项几何单测）；生产构建成功（CSS 131.66 kB / JS 4,232.99 kB）。**不改数据库。**

**待用户实测**：① 点某段来源打开 **PDF** 来源 → 定位条显示已定位到第 P 页，且该句**有高亮**（不是整页高亮）；② 扫描件 PDF（无文字层）→ 如实提示"没有文字层"，不死循环、不假装成功；③ 定位后再拖分栏宽度/缩放，高亮位置是否仍然贴合（百分比定位的设计意图就是"不用重算也贴合"）。

**本轮未做（需你裁定是否要）**：**DOM 文字层（PDF 里可选中/复制文字）**。原因是它与 S2 的"画布按容器宽度拉伸"耦合：pdf.js 的文字层要按 `--scale-factor` 精确排版，画布被 CSS 拉伸后必须把文字层放进"按设备像素定尺、再用 CSS transform 缩放到显示尺寸"的包装层，并在分栏尺寸变化时重新排版——**改动会触及刚验收通过的 S2 流畅性**，而我无法在本地肉眼验证对齐效果。建议作为独立小片（S3b）单独做、单独验收。当前**定位与高亮不依赖它**，功能不受影响。

## Phase 9｜来源定位重构（2026-10-03 立项，用户裁定 Q1–Q6「全部按推荐」）

### 9.0 问题与结论

用户实测提出三条：

1. **点资料卡片的小圆标，弹的是"该来源文件下属的所有资料卡片列表"这一中间层** —— 多余。改为：点圆标**直接弹右栏显示来源文件**，中间层删除。
2. **"精确定位到某一句"靠全文检索，此路不通** —— 资料卡片常经大模型改写/整合，与原文任何一句都未必逐字相同，事后检索必然失败。要求**在生成汇编的过程中（调用大模型做文本提取时）就标记卡片的来源位置**。
3. **高亮精确来源已属鸡肋** —— 只要求**定位到所在页**（各类型文件一视同仁）。

**结论（新架构）**：**生成期记"卡片用了哪一块文字"（块号）＋ 解析期记"这一块属于第几页"（页表），二者相乘 = 定位到页；全程不做任何文本匹配。**

### 9.1 用户裁定（Q1–Q6）

| # | 事项 | 裁定 |
|---|---|---|
| Q1 | 分块粒度 | **页内 ~500 字/块、按句读吸附、且块绝不跨页**。2026-10-03 用户复议"担心块大导致精度不足"并授权我自行决策：页级精度其实由**"块不跨页"**保证，块取小是为了（a）模型指认更准、（b）Word/WPS 这类无固定页码的文件定位更细；代价约 +2–3% token |
| Q2 | 模型引用方式 | **块号**（提示词里标注 `〖S12-B07〗`），不让模型复现原文 |
| Q3 | Word/WPS 的"页" | 定位到**段/标题**（不做排版近似页——与本机 Word 排版未必一致，反而误导） |
| Q4 | 老汇编（无锚点） | 如实提示「未记录来源位置」，**不用整句检索兜底**（宁可说没有位置，也不给错位置） |
| Q5 | 并列来源圆标 | 点哪条开哪条，并带**该来源自己的锚点** |
| Q6 | 块表生成时机 | **懒生成 + 缓存**（第一次需要定位某份来源时才解析落库），不做 784 份全量回填 |

### 9.2 切片

- **S1 圆标直达右栏（界面）**：圆标 `onClick` 改为使用**被点击那段**的段落对象（不再 `find(x => x.sourceOrdinal === sourceCardFor)` 反查——该编号下 16–24 段共用，取到的永远是第一段，是错锚主因）；删除中间层"来源小卡里的卡片列表"及其状态；并列来源圆标各开各的来源；矛盾弹窗说法来源同样直达。
- **S2 解析期页表（Migration 043）**：新增 `source_blocks(source_id, block_index, char_start, char_end, page, label)`。解析时**文字与位置表一次产出**（保证字符偏移严格对齐）：PDF 逐页取文（pdfjs）边拼边记每页区间 → 页内按句读切 ~500 字块；Excel=工作表+行；图片=1 页；Word/WPS=段；网页=块（无页）。扫描件 PDF **也有页**（文字为空但页码存在）→ 无需 OCR 即可定位到页。
- **S3 生成期锚点（Migration 044）**：新增 `compilation_item_anchors(item_id, source_id, block_index, confidence, created_at)`。细读/整合提取阶段把来源正文按块编号送模型，要求每张卡片回报取自哪些块；本地校验块号合法（属本次输入集合）＋与既有 `evidence` 交叉校验（引文落在所引块内→高置信，落不进→标"位置存疑"）；非法/缺失→该卡标"来源位置待定"。`compilation_items` 不动；撤销/版本快照按 Migration 042 的"关系行先删后插"体例写。**不增加模型调用次数。**
- **S4 收敛界面与文档**：删除句子级高亮与「第 i/n 处、上一处/下一处」（`pdf-hit.ts` 与高亮覆盖层一并删，代码留在 git 历史）；定位条改为「已定位到第 P 页」/「已定位到第 N 段（Word/WPS）」/「该卡片未记录来源位置（重新生成汇编可获得页级定位）」；更新文档与基线。

**执行顺序**：S1 → S2 → S3 → S4。**状态（2026-10-03）**：S1/S2/S3/S4 均已实现并各自验证；S3 的设计变更见 **9.6**、实施记录见 **9.7**，S4 实施记录见 **9.8**。技术上尚未完成的只有"用户在真实环境重新生成一次汇编并人工抽检页码"这一步（见 9.3 验收 2/3）。

### 9.3 验收标准

1. 点任一圆标 → 右栏**直接**是来源文件，**不再出现**中间卡片列表；并列圆标各开各的。
2. 抽 10 张卡人工核对：PDF（含扫描件）定位条页码 = 该卡实际取材页。
3. **卡片文字被改写（引文与正文不一致）时仍能定位到页** —— 本次改造的核心验收点。
4. 无锚点老汇编：如实提示，**绝不跳错页**。
5. typecheck / 单测 / 构建全绿；界面改动起应用自检（读 DOM + 截图）。

### 9.4 知情与风险

- **必须重新生成汇编**才会产生锚点（现有 4 份 / 391 段无锚点，见 Q4）。
- 模型仍可能给出错误块号（幻觉）。缓解：块号合法性校验 + 引文交叉校验 + 置信度标记 + 不一致时如实显示"位置存疑"；**不使用"猜一个最近匹配"来掩盖**。

### 9.5 S2 实施记录（2026-10-03，完成）

**三块内容**：
1. **纯逻辑** [src/main/parse/page-map.ts](src/main/parse/page-map.ts)：`splitIntoBlocks`（~500 字/块、句读吸附：先向前看 160 字、再回退到最近句末标点，回退下限 60%）、`assignPages`（**把跨页的块切开**，"块不跨页"是页级精度的硬保证）、`alignPageTexts`（逐页文字 ↔ 库里正文对齐；**有非空页对不上就返回 null**，宁可不落页表也不给错页码）。
2. **Migration 043 + 块表仓储** [src/main/db/source-blocks.ts](src/main/db/source-blocks.ts)：`source_blocks(source_id, block_index, char_start, char_end, page, label)`（纯新增、**不回填存量**，Q6 懒生成 + 缓存）；`ensureSourceBlocks(sourceId, getPageTexts)` 注入式取页文字，解析失败退化为"无页码块表"，拿到页区间后复核"无块落空"。
3. **PDF 逐页取文** [src/main/parse/pdf-pages.ts](src/main/parse/pdf-pages.ts)：pdfjs 逐页 `getTextContent`；扫描页返回空串（页码仍在 → **扫描件也能定位到页**）。

**⚠ 修掉一个真 bug（页区间越界）**：`alignPageTexts` 原先把某页终点算成"起点 + 整页长度"；一旦该页是靠"开头 30 字"退让匹配上的（页眉页脚/重排使整页对不上），终点会**越过后面若干页** → 区间重叠 → 块被标成更小的页码。真实年鉴实测出现 **351 → 11 的页码倒退**。现改为 **页 N = [页 N 起点, 页 N+1 起点)**、末页到正文末尾：有序、不重叠、无洞，页间分隔符自然归前一页；新增单测钉住该口径。

**真实年鉴端到端验证**（`D:\资料库\长乐年鉴2023（完整版）.pdf`，临时用例跑完即删）：逐页提取 **351 页 / 1.6s**（347 页非空）；与库里正文（**614,116 字**）**对齐成功**；切出 **1603 块、全部有页码**且页码单调不减；抽查**第 216 页区间 2,178 字、含 "4123"** —— 即此前争议的「2022 年，长乐区普通高中招生录取 4123 人。」确落在第 216 页，页映射口径得到实证。

**验证基线**：typecheck 零错误；vitest **323/324 通过**（本阶段新增 **14 项**单测：page-map 9 + source-blocks 5；唯一失败仍是既有 watcher chokidar 环境项）；生产构建成功。
**Migration 043 真实库副本演练**：版本 42 → 43、`source_blocks` 0 行（不回填）、`integrity_check=ok`、外键违规 0、**所有既有业务表行数零变化**、重复执行幂等。

**更正**：提交 `56a00a3` 的信息把单测数写成"324/325"，**实际为 323/324**（我在未核对输出前就写了数字，属我的记录失误，在此更正）。

### 9.6 S3 设计变更：改为**本地确定性锚定**（2026-10-03，用户裁定「按建议来」）

**核查发现（关键）**：原计划"让大模型在生成时回报块号"**不成立**——整合提取送给模型的**不是来源正文**，而是上一阶段切好的**卡片摘录**（[extract-service.ts](src/main/writing/extract-service.ts) 的 `buildExtractMessages`：`'下面每张【资料卡片】都是从来源文献中整段摘出的'` + `c.excerpt`）。模型没见过的块结构，让它回报块号只会**再造成一个幻觉源**，与"否掉全文检索"的初衷相悖。

**改用的方案（确定性锚定）**：卡片摘录与 `evidence` 都是从来源正文里**逐字**切出来的，"位置"在切出那一刻就已确定：
1. 切片阶段记录候选卡片的字符区间（摘录是原文逐字片段，定位确定性）；
2. 段落落库时：每段只来自一张卡片（提示词第 255 行已硬性要求），故继承该卡片区间；再用手上已有的 `evidence` 逐字校验（`compilation-document.ts` 的 `locateVerbatim`）把区间收得更紧；
3. **区间 → 块号**（查 `source_blocks`）→ **块号 → 页码**。**零幻觉、零 token 成本**，且不怕卡片被改写（锚点取自逐字的摘录/证据，不是改写后的卡片文字）。

**已按此裁定清理**：删除 `renderNumberedBlocks` / `parseAnchorLabels`（模型块号标注与解析，已成无用代码）；`anchors.ts` 只保留**本地**逻辑：`evidenceHitsBlock`（引文↔块去空白比对，<4 字不作依据）、`blockAtOffset`、`resolveAnchor`（证据区间优先 → `exact`；只有卡片区间 → `weak`；都没有 → null）。`compilation_item_anchors` 表与仓储**保留**（`block_index` 仍是锚点单位，只是块号改由本地算出）。

**验证**：typecheck 零错误；vitest **331/332 通过**（唯一失败仍是既有 watcher chokidar 环境项）；生产构建成功。

### 9.7 S3 收尾实施记录（2026-10-03，完成）

**挂钩点（唯一）**：[compilation-service.ts](src/main/writing/compilation-service.ts) 的 `persistDocument` → `upsertCompilationParagraphs(...)` 之后，`void attachAnchorsQuietly(items)`
（该函数是同步的，故 fire-and-forget，不改签名；这一处是唯一能一次拿到全部刚写库段落 `{id, sourceId, excerpt, evidence}` 的地方）。

**新增** [src/main/writing/source-anchors.ts](src/main/writing/source-anchors.ts)：
- `attachAnchors(items)`（可 await，供演练/单测）：按 `sourceId` 分组、**逐来源串行**（块表懒生成，避免同时解析几十份 PDF）→ 取 `cleaned_text` → `ensureSourceBlocks(sourceId, pageTextsForSource)` → 每段 `findVerbatimRange(evidence)` 优先、`(excerpt)` 兜底 → `resolveAnchor` → `replaceItemAnchors`；
- **找不到就留空**（不写锚点行），界面按 Q4 如实说"未记录来源位置"；
- `attachAnchorsQuietly`：吞掉一切异常，只写 `logMain('anchor', …, 'WARN')`；
- **依赖隔离**：`../workspace/sync`（Electron）与 `../parse/pdf-pages`（pdfjs）走**动态 import**，因此本模块被 `compilation-service` 静态引入也不影响内联单测（实测单测可跑）；
- `pageTextsForSource` **只对 PDF** 取逐页文字，且用 `getPdfCmapsDir()`（新增 getter，见 `file-parser.ts`）——中文 CID 字体 PDF 没有 cmaps 提不出文字。

**⚠ 与任务简报不符的一处事实（我核对真实库后发现并更正）**：简报称"迁移已到 044、`source_blocks`/`compilation_item_anchors` 已存在但为空"。**实测真实库停在 42**（`schema_migrations` 最大 42，两张表都不存在；`settings.workspace_dir` 才是键名，简报里那个键名不存在）——因为 043/044 提交后**软件还没启动过**。本次界面自检启动应用时，迁移已按设计在真实库上跑到 **44**。

**验证**：
- typecheck 零错误；vitest **337/338 通过**（新增 3 项 `source-anchors` 单测；唯一失败仍是既有 watcher chokidar 环境项）；生产构建成功。
- **Migration 42 → 44 真实库副本演练**：`source_blocks`/`compilation_item_anchors` 各 0 行、`integrity_check=ok`、外键违规 0、**其它表行数零变化**（`schema_migrations` 自身多 2 行除外）、重复执行幂等。
- **真实年鉴端到端（同一副本，走生产同一条链路 `attachAnchors → pageTextsForSource → resolveSourceFilePath → pdfjs+cmaps`）**：《长乐年鉴2023（完整版）》614,116 字 → 块表 **1603 块全部有页码**；某真实汇编中该来源的 **24 段全部定位成功（0 段留空）**，含「2022 年，长乐区普通高中招生录取 4123 人。」的一段 = **第 216 页**（与 9.5 的独立实测一致）。
- 另一份真实汇编（119 段）整体跑一遍：**118/119 段有锚点**（唯一没有的那段是模型改写、原文里找不到逐字段）。
- **页码独立核对**：对《长乐年鉴2021》的 16 个已定位段，直接用 pdfjs 逐页文字（**不经过块表**）检查，**16/16 段的引文确实出现在所报页里**。

### 9.8 S4 实施记录（2026-10-03，完成）

**数据通路（不加 IPC）**：`getItemsByCompilation` 里 JOIN `listAnchorsForItems`，把 `anchors`（`sourceId` / `blockIndex` / `page` / `charStart` / `confidence`）随段落一起给渲染层（`CompilationItem.anchors`，[shared/types.ts](src/shared/types.ts)）；`listItemAnchorsWithPage`/`listAnchorsForItems` 的 SELECT 增加 `b.char_start`。

**界面**：
- 圆标（含并列来源圆标）点击时**按被点的那条来源挑锚点**（`anchorForItem`，Q5），把 `{kind:'page'|'paragraph'|'unknown'}` + 段号说明 + 快照高亮引文交给右栏；
- 定位条只报三件事（[source-locate.ts](src/renderer/src/lib/source-locate.ts) 的纯函数 `locateBarState` 判定，界面只套文案）：**「已定位到第 P 页」**（PDF，含扫描件）/ **「已定位到第 N 段」**（Word/WPS 等无页来源）/ **「该卡片未记录来源位置（重新生成汇编可获得页级定位）」**（老汇编，Q4）；网页来源仍不显示定位条（原网页实时加载，库里的段落位置对它没意义）；
- **PDF 定位改为按页跳转**：`PdfViewer` 新增 `targetPage`，越界夹取；**删掉**文内检索、命中高亮与进度回报（`PdfLocateState`/`onLocate`）；
- **删除句子级高亮与「第 i/n 处、上一处/下一处」**：[pdf-hit.ts](src/renderer/src/lib/pdf-hit.ts) 与 [locate.ts](src/renderer/src/lib/locate.ts) 整个删除（连内联单测）、`.source-viewer__hit*` / `.pdf-viewer__pdf-hit` / `.pdf-viewer__pdf-layer` / `.source-viewer__locate-host` 样式与 9 条旧 i18n 文案一并清理；`IncrementalContent` 去掉"定位优先"的 `needles`/`onReveal`；
- **保留**：表头「用系统默认程序打开」（Q2）、网页来源「查看本地快照」（其引文高亮仍在，改由段落证据/说法原文喂入）。

**两处实现中发现并当场修正的问题（都属"给错位置"这一类，必须记下）**：
1. **无页来源的"第 N 段"原本会报错段**：块表对 Word/WPS 也是"每 ~500 字一块"，同一块里的第 2、3 段都会被报成"第 1 段"（实测演示资料 5 段被压成 1 块）。现改为：**没有页概念的来源按段落切块**（新增 `splitByParagraphs`：块 = [本段起点, 下段起点)，超长段落再按句读细分），于是"块起点是第几段"**就等于**"这一块是第几段"（实测演示汇编 4 个已定位段 = 第 1/2/3/4 段，准确）。PDF 仍走"~500 字块 + 按页切开"（页级精度由"块不跨页"保证，不受影响）。
2. **`confidence` 不再当"位置存疑"显示**：确定性锚定下 `exact`/`weak` 只是"用证据引文定的位 / 用段落正文定的位"，两者都是**逐字命中**，可靠性没有差别（旧的"模型回报块号 + 引文交叉校验"路线已废弃）。若沿用旧口径，演示汇编会满屏"位置存疑"——**误报**。故 `confidence` 继续落库（记录用的是哪种文字），界面不再警示；连带删掉已成死代码的 `evidenceHitsBlock`。
   **顺带修掉一个既有 off-by-one**：定位条右侧的「本汇编第 N 段」原先直接用 0 起的 `position`，第 1 段显示成"第 0 段"、第 10 段显示成"第 9 段"；现 `position + 1`。
3. **PDF 没算出页码时不拿"第 N 段"糊弄**：有页的来源若页表对不上（`alignPageTexts` 返回 null），定位条报「未能确定页码（该 PDF 的逐页文字与正文对不上…）」，而不是把 PDF 的行当成"段"。

**验证**：typecheck 零错误；vitest **335/336 通过**（唯一失败仍是既有 watcher chokidar 环境项）；生产构建成功（CSS 130.22 kB / JS 4,216.55 kB；比改造前更小，因为删掉了高亮相关代码与样式）。测试数变化：新增 `source-anchors` 3 + `source-locate` 6 + page-map 3 + source-blocks 1，删除 `locate.ts` 6 + `pdf-hit.ts` 5 + `evidenceHitsBlock` 1 → 净 +1。
**真机自检（CDP：DOM + 截图，`--remote-debugging-port=9222`）**：
- 老汇编（119 段，真实数据、无锚点）+ PDF 来源 → 定位条「该卡片未记录来源位置（重新生成汇编可获得页级定位）｜本汇编第 10 段」，PDF **停在第 1 页不跳**、无任何高亮层（验收 4：绝不跳错页）；
- 临时写入锚点后同一段 → 「已定位到第 275 页」且 PDF 工具栏显示 **第 275 / 338 页**（`targetPage` 生效）；
- 无页来源（演示资料）→ 「已定位到第 2 段」「已定位到第 4 段」；并列来源圆标（该来源没有锚点）→ 如实「未记录来源位置」；
- 网页来源 → 不显示定位条；表头「用系统默认程序打开」「查看本地快照」都在。
- **演练痕迹已清理**：临时写入的锚点/块表行全部删除（两表恢复为 0 行，`integrity_check=ok`、外键违规 0、迁移版本仍是 44），临时用例与 CDP 脚本、截图均已删除。

**风险与遗留（须知）**：
- 现有 4 份真实汇编（含演示汇编）**仍无锚点**，必须**重新生成汇编**才有页级定位（Q4 已裁定，界面文案也这么写）；并列来源圆标**没有自己的锚点**（合并时被合并段只保留了文字，没保留它自己的区间），点它一律如实说"未记录来源位置"。
- `attachAnchorsQuietly` 是 fire-and-forget：生成完成后它在后台懒生成块表（首次每份年鉴约 2–4s），**生成汇总里看不到它的成败**，只有 `logMain('anchor', …)` 诊断日志。

## Last Phase（收尾阶段）: Acceptance & Packaging（待进行）
> **说明**：本阶段是**整个项目的收尾阶段**，在所有功能阶段（Phase 1–6.x）全部完成后才执行。此处保留「Phase 5」的旧编号仅为历史追溯，不代表其应在 Phase 6 之前完成；序号与执行顺序无关。

**Overall Goal:** 产出 Windows 安装包、完成端到端演示与项目文档。

- **Task Detail:**
  1. Windows 安装包构建与安装验证（electron-builder NSIS，GitHub Actions 已配置 tag 触发）。
  2. 核心闭环（收集 → 撰写 → 初稿完成）端到端演示。
  3. 整理演示数据、使用说明、开发文档与 Git 提交记录。
- **Affected Areas:** 打包发布、端到端验证、项目文档。
- **Verification:** 安装包可安装运行；全流程演示通过；数据全部本地保存，对外仅调用用户配置的大模型与用户提供的信源；已知限制被明确记录。

> **发布记录**：**v0.3.0（2026-09-12）** —— Phase 7 重构成型后的首个大版本：汇编连续文档化（7.1–7.2）、连续文档查看器与版本差异（7.3–7.4）、悬浮对话框人机协同编辑（7.5）、导出/第三步/回收站/左栏下线与 7.7 收尾清理，外加网页资料库三批并入（年份兜底/发布时间/向量索引/材料上限/材料集合落定/来源快照/伪矛盾收敛）与三项"静默错误"的修复（抓取上限 + 排序口径失效、模板页冒充正文、向量索引全库失效），以及索引重建提速 8 倍与可续跑。发布说明见 `docs/release-notes.md`；Windows NSIS 安装包由 `.github/workflows/release.yml` 在 `v*` tag 推送时构建并作为 Release 资产上传（`docs/release-notes.md` 作为 Release 正文）。

## Project Completion Criteria

- 收集 → 撰写 → 初稿完成的完整业务闭环可用。
- 初稿支持逐片段溯源（每个片段可查看原文来源）。
- 数据默认保存在本地；对外仅调用用户配置的大模型与用户提供的信源网址，无其他外联行为。
- 矛盾、文段修改两种人工审核场景均可完成（事件缺失补充已移出范围）。
- Windows 实机验证通过；每项任务可通过项目文档和提交历史追溯到验证结果。
