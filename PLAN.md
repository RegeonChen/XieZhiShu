# Project Plan

本计划基于 `AGENTS.md` 制定。本项目为**单人开发**，`Team Responsibilities` 中的模块划分是代码组织边界，不涉及多人协作。设计文档位于 `docs/`（数据模型 `data-model.md`、共享契约 `shared-contracts.md`、UI 架构 `ui-architecture.md`），与代码同步维护。

> **2026-08-19 文档整理说明**：原文件按时间追加了大量已完成任务的详细记录（含多次修订过程），本版将已完成阶段的冗杂过程合并为「已完成阶段摘要」，保留对后续开发仍有价值的方案结论与根因；详细历史仍可在 Git 提交记录中回溯。**未完成的 Phase 5 保持完整规划。**

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

### Phase 6.6 初稿编辑器升级（深改 TipTap）

- 目标观感接近成熟文档软件：正文衬线（宋体）排版、最大阅读宽度、标题层级、页边距、目录/页脚字数统计、撤销重做、打印友好工具栏。
- 保留：Markdown 存储、800ms 防抖整稿保存、`draft:updateContent`、右键菜单（复制/粘贴/全选等）。
- 由于“仅汇编层溯源”，正文不再需矛盾/来源节点，可移除矛盾标注相关扩展（按需保留旧数据兼容）。

### Phase 6.7 测试、文档与发布

- 更新 `docs/{data-model,shared-contracts,ui-architecture}.md`、`PLAN.md`（本阶段标记完成）、`README.md`、`agents.md`（决策与近期记录）。
- 全量验证：typecheck 零错误 / 单测（预计 150+）/ 生产构建；端到端演示：选工作区 → ① 生成汇编（召回+细读+矛盾）→ 审阅取舍 → 确认 → ② 规范（预留）→ ③ 生成初稿（流式）→ 编辑保存。
- 视达成度发布新版本（如 `v0.2.0`），配置 GitHub Actions release（沿用 v* tag 触发）。

### 验收标准汇总

- **6.0**：迁移可重复、级联删除正确；类型/IPC/preload/main 对齐；typecheck 零错误、新增 ≥4 项单测、构建成功。
- **6.1**：给定真实标题（如“学前教育中的园所设置”）产出按时间排序的卡片列表，每张含来源+位置+时间标签；**召回不丢相关材料**（用含近期数据/无字面重叠的样例验证仍能召回）；矛盾分组正确；无 Provider 时降级返回本地候选不阻断；typecheck/单测（新增 ≥5 项）/构建通过。
- **6.2**：卡片按时间返回、来源可打开；编辑/删除持久化、重启保持；矛盾取舍后解锁下一步；存在未处理矛盾时确认被阻止并提示；typecheck/单测（新增 ≥3 项）/构建通过；端到端可审阅并确认。
- **6.3**：用已确认汇编生成连贯初稿；材料与汇编完全一致（无库外内容）；流式输出 + 进度可见；重生成不重检；缺标题等必要信息时大模型详细报错；typecheck/单测（generate 相关 ≥6 项）/构建通过。
- **6.4**：规范页仅显示通用规范；生成仅注入通用规范；任务无部类细则选择；迁移后无 section 残留；typecheck/单测/构建通过。
- **6.5**：UI 预览 2–3 套交付并选定风格；三步向导状态正确；各步过程可见（进度+流式）；无死链；typecheck/构建通过；端到端走完三步。
- **6.6**：编辑器观感达到选定样板；Markdown 存储/防抖保存/撤销重做正常；typecheck/构建通过。
- **6.7**：文档与代码一致；三项验证通过；端到端闭环可用；发布产物可安装。

## Phase 5: Acceptance & Packaging（待进行）

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
