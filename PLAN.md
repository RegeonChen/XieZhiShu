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
