import type { CacheBuildPlan, CacheBuildStartRes, CacheBuildStatus } from '../shared/types'

export interface ImportResult {
  path: string
  source?: { id: string; title: string; status: string; kind: string; createdAt: string }
  error?: string
}

export interface AppApi {
  getAppInfo(): Promise<{ ok: boolean; data?: { version: string; platform: string }; error?: { code: string; message: string } }>
  getPdfCmapsUrl(): Promise<{ ok: boolean; data?: { url: string }; error?: { code: string; message: string } }>
  openExternal(url: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  readClipboardText(): Promise<{ ok: boolean; data?: { text: string }; error?: { code: string; message: string } }>
  writeClipboardText(text: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  addUrl(url: string): Promise<{ ok: boolean; data?: { source: unknown }; error?: { code: string; message: string } }>
  /** 网页资料库站点列表（2026-08-11） */
  listWebSources(): Promise<{ ok: boolean; data?: { sites: unknown[] }; error?: { code: string; message: string } }>
  /** 注册网页资料库站点（生成初稿时自动检索该站点相关文章） */
  addWebSource(rootUrl: string, title?: string): Promise<{ ok: boolean; data?: { site: unknown }; error?: { code: string; message: string } }>
  /** 删除网页资料库站点 */
  removeWebSource(id: string): Promise<{ ok: boolean; data?: undefined; error?: { code: string; message: string } }>
  /** 修改网页资料库站点（名称/根网址） */
  updateWebSource(id: string, rootUrl: string, title: string): Promise<{ ok: boolean; data?: { site: unknown }; error?: { code: string; message: string } }>
  /** Phase 10 P3：年份区间预览（目录日期统计 + 抓取耗时估算，只读、不抓正文）
   *  2026-10-05：入口移到任务流程的年份控件（`ChatPanel`）。 */
  webSourceDateStats(fromYear: number, toYear: number): Promise<{ ok: boolean; data?: { stats: unknown }; error?: { code: string; message: string } }>
  /** Phase 10 P5：设置该任务的网页资料年份区间（null = 回退全局默认） */
  setTaskWebYears(taskId: string, fromYear: number | null, toYear: number | null): Promise<{ ok: boolean; data?: { task: unknown }; error?: { code: string; message: string } }>
  /* 2026-10-05 P6 已删除：webSourceCrawl / webSourceCrawlCancel / webSourceResetFetchState / onWebCrawlProgress */
  /** 2026-10-05：暂停 / 继续正在进行的抓取（暂停期间不发新请求，点继续从原处接着跑） */
  webSourceSetCrawlPaused(paused: boolean): Promise<{ ok: boolean; data?: { paused: boolean }; error?: { code: string; message: string } }>
  /** 2026-10-05：正文缓存占用（多少篇 / 多少字节 / 三态计数） */
  webSourceCacheStats(): Promise<{ ok: boolean; data?: { entries: number; bytes: number; byState: { ok: number; 'no-body': number; blocked: number } }; error?: { code: string; message: string } }>
  /** 2026-10-05：清空正文缓存（只删缓存） */
  webSourceClearCache(): Promise<{ ok: boolean; data?: { cleared: number }; error?: { code: string; message: string } }>
  /**
   * 2026-10-06（用户需求）：「建立缓存与索引」的**只读**规划——区间内共几篇 / 已有几篇 /
   * 还要建几篇 / 几篇永远建不了 + 本地待索引数 + 是否已建齐（`ready`）。
   * 省略年份时按默认区间 2005–2025；反向区间返回错误。
   */
  cacheBuildPlan(params?: { fromYear?: number; toYear?: number }): Promise<{ ok: boolean; data?: CacheBuildPlan; error?: { code: string; message: string } }>
  /**
   * 2026-10-06（用户需求，Phase 11 C）：**建立缓存与索引**（网页正文缓存 + 本地索引并行）。
   * `start` 后台跑，用 `cacheBuildStatus()` 轮询进度与 ETA；`stop` 只停止"抓新的"。
   */
  cacheBuildStart(params?: { fromYear?: number; toYear?: number; includeLocal?: boolean }): Promise<{ ok: boolean; data?: CacheBuildStartRes; error?: { code: string; message: string } }>
  cacheBuildStop(): Promise<{ ok: boolean; data?: { stopped: boolean }; error?: { code: string; message: string } }>
  cacheBuildStatus(): Promise<{ ok: boolean; data?: CacheBuildStatus; error?: { code: string; message: string } }>
  listSources(params?: { tagIds?: string[]; search?: string }): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  importFiles(paths: string[]): Promise<{ ok: boolean; data?: { results: ImportResult[] }; error?: { code: string; message: string } }>
  openFileDialog(): Promise<{ ok: boolean; data?: { paths: string[] }; error?: { code: string; message: string } }>
  openDirectoryDialog(): Promise<{ ok: boolean; data?: { path: string | null }; error?: { code: string; message: string } }>
  listTags(): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  createTag(name: string): Promise<{ ok: boolean; data?: { tag: unknown }; error?: { code: string; message: string } }>
  updateTag(id: string, name?: string): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  deleteTag(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  addTagToSource(sourceId: string, tagId: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  removeTagFromSource(sourceId: string, tagId: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  searchTags(query: string, limit?: number): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  batchAddTags(tagIds: string[], sourceIds: string[]): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  getTagSourceIds(tagId: string): Promise<{ ok: boolean; data?: { sourceIds: string[] }; error?: { code: string; message: string } }>
  listCompilations(taskId: string): Promise<{ ok: boolean; data?: { compilations: unknown[] }; error?: { code: string; message: string } }>
  getCompilation(compilationId: string): Promise<{ ok: boolean; data?: { compilation: unknown }; error?: { code: string; message: string } }>
  /** 生成资料汇编；`skipConvergence` = 第二组 ⑤ 的逃生门（本轮不做收敛、全量送入） */
  generateCompilation(taskId: string, title: string, skipConvergence?: boolean): Promise<{ ok: boolean; data?: { compilation: unknown; interrupted?: { stage: string; message: string; percent: number } }; error?: { code: string; message: string } }>
  continueCompilation(compilationId: string): Promise<{ ok: boolean; data?: { compilation: unknown; interrupted?: { stage: string; message: string; percent: number } }; error?: { code: string; message: string } }>
  /** 生成前的材料规模预检（只读，2026-10-05 用户要求 P1）：不落库、不抓网页、不调大模型，只提示不限制 */
  estimateCompilationMaterials(
    taskId: string,
    instruction: string
  ): Promise<{
    ok: boolean
    data?: {
      segments: number
      chars: number
      localSegments: number
      webSegments: number
      estimatedWindows: number
      estimatedMinutes: number
      /** 第二组 ⑤：「全量送入」（不做收敛）口径的规模 */
      fullSegments: number
      fullChars: number
      fullEstimatedWindows: number
      fullEstimatedMinutes: number
      droppedSegments: number
      droppedChars: number
      convergedSources: number
      noSignalSources: number
      converged: boolean
      contextRange: number
      reIncludedSegments: number
    }
    error?: { code: string; message: string }
  }>
  reorderCompilation(compilationId: string, direction: 'asc' | 'desc'): Promise<{ ok: boolean; data?: { compilation: unknown }; error?: { code: string; message: string } }>
  undoCompilation(compilationId: string): Promise<{ ok: boolean; data?: { compilation: unknown; undoAvailable: number; redoAvailable: number }; error?: { code: string; message: string } }>
  redoCompilation(compilationId: string): Promise<{ ok: boolean; data?: { compilation: unknown; undoAvailable: number; redoAvailable: number }; error?: { code: string; message: string } }>
  getCompilationUndoState(compilationId: string): Promise<{ ok: boolean; data?: { undoAvailable: number; redoAvailable: number }; error?: { code: string; message: string } }>
  /* Phase 7.4：版本列表（对话编辑的乐观锁基线；两版差异 / 版本恢复通道已随 Phase 7.7 删除） */
  listCompilationVersions(compilationId: string): Promise<{ ok: boolean; data?: { versions: unknown[] }; error?: { code: string; message: string } }>
  /* Phase 7.5：对话框内让大模型按段落 id 修改汇编正文 */
  editCompilationDoc(compilationId: string, instruction: string, baseVersionNo?: number): Promise<{ ok: boolean; data?: { compilation: unknown; reply: string; applied: number; rejected: { op: string; reason: string }[]; versionNo?: number; changedIds: string[]; changeSummary: { added: number; modified: number; removed: number }; diff: unknown; candidates: number; leakState: 'ok' | 'empty' | 'failed' | 'skipped'; addedFromCandidates: number }; error?: { code: string; message: string } }>
  listCompilationMessages(compilationId: string): Promise<{ ok: boolean; data?: { messages: unknown[] }; error?: { code: string; message: string } }>
  resolveCompilationContradiction(contradictionId: string, action: 'resolve' | 'ignore', chosenItemId?: string): Promise<{ ok: boolean; data?: { contradiction: unknown }; error?: { code: string; message: string } }>
  confirmCompilation(compilationId: string): Promise<{ ok: boolean; data?: { compilation: unknown }; error?: { code: string; message: string } }>
  listCompilationRecycleBin(compilationId: string): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  restoreCompilationRecycleBin(binId: string): Promise<{ ok: boolean; data?: { contradiction?: unknown }; error?: { code: string; message: string } }>
  exportCompilationDocx(compilationId: string): Promise<{ ok: boolean; data?: { path: string }; error?: { code: string; message: string } }>
  exportCompilationArchive(compilationId: string): Promise<{ ok: boolean; data?: { path: string }; error?: { code: string; message: string } }>
  importCompilationArchive(taskId: string, filePath: string): Promise<{ ok: boolean; data?: { compilation: unknown }; error?: { code: string; message: string } }>
  importCompilationFromTask(taskId: string, sourceCompilationId: string): Promise<{ ok: boolean; data?: { compilation: unknown }; error?: { code: string; message: string } }>
  listFinalizedCompilationsForImport(): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  listSourceRemovals(): Promise<{ ok: boolean; data?: { items: { sourceId: string; title: string; cardCount: number; sharedCount: number; contradictionCount: number; origin: 'workspace' | 'manual' }[] }; error?: { code: string; message: string } }>
  decideSourceRemoval(sourceId: string, action: 'delete' | 'keep'): Promise<{ ok: boolean; data?: { deletedItems: number; deletedContradictions: number; repointedItems: number }; error?: { code: string; message: string } }>
  onSourceRemoved(cb: (p: { sourceId: string; title: string; cardCount: number; sharedCount: number; contradictionCount: number; origin: 'workspace' | 'manual' }) => void): () => void
  listStyleGuides(): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  saveStyleGuide(input: { id?: string; name: string; content: string }): Promise<{ ok: boolean; data?: { styleGuide: unknown }; error?: { code: string; message: string } }>
  setDefaultStyleGuide(id: string): Promise<{ ok: boolean; data?: { styleGuide: unknown }; error?: { code: string; message: string } }>
  deleteStyleGuide(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  getSource(id: string): Promise<{ ok: boolean; data?: { source: unknown; tags: unknown[] }; error?: { code: string; message: string } }>
  renderSourceHtml(id: string): Promise<{ ok: boolean; data?: { html: string }; error?: { code: string; message: string } }>
  getSourceFileUrl(id: string): Promise<{ ok: boolean; data?: { url: string }; error?: { code: string; message: string } }>
  deleteSource(id: string): Promise<{ ok: boolean; data?: { pendingCascade: boolean }; error?: { code: string; message: string } }>
  deleteSources(ids: string[]): Promise<{ ok: boolean; data?: { pendingCascade: boolean }; error?: { code: string; message: string } }>
  updateSourceTitle(id: string, title: string): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  summarizeAll(): Promise<{ ok: boolean; data?: { processed: number; ok: number; failed: number }; error?: { code: string; message: string } }>
  getSourceSummary(id: string): Promise<{ ok: boolean; data?: { summary?: unknown }; error?: { code: string; message: string } }>
  listProviders(): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  saveProvider(input: { id?: string; name: string; apiBase: string; model: string; apiKey?: string; concurrency?: number }): Promise<{ ok: boolean; data?: { provider: unknown }; error?: { code: string; message: string } }>
  deleteProvider(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  testProvider(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  getSettings(): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  updateSettings(patch: { dataDir?: string; workspaceDir?: string; compilationProviderId?: string; draftProviderId?: string; keepAwake?: boolean; docScale?: 'small' | 'medium' | 'large'; onboardingDone?: boolean; webYearFrom?: number; webYearTo?: number }): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  getRagIndexStatus(): Promise<{ ok: boolean; data?: { total: number; ready: number; pending: number; indexing: number; failed: number; lastError: string | null; lastErrorAt: string | null; queued: number; rebuild: { status: 'running' | 'interrupted' | 'done'; startedAt: string | null; totalQueued: number; remaining: number; processed: number; percent: number; active: boolean }; engine?: { poolSize: number; livePool: number; workerThreads: number; workerErrors: number; directFallbacks: number; lastWorkerError: string | null } }; error?: { code: string; message: string } }>
  reindexRag(): Promise<{ ok: boolean; data?: { queued: number; reset: number }; error?: { code: string; message: string } }>
  getSourceSnapshot(id: string): Promise<{ ok: boolean; data?: { id: string; kind: 'file' | 'url'; title: string; url?: string; snapshotAt?: string; publishedAt?: string; text: string; totalChars: number; truncated: boolean; shortText: boolean }; error?: { code: string; message: string } }>
  /** 来源块表（只读，Phase 9 高亮补充）：锚点块号 → 字符区间 / 页码 */
  getSourceBlocks(id: string): Promise<{
    ok: boolean
    data?: { blocks: { blockIndex: number; charStart: number; charEnd: number; page: number | null }[] }
    error?: { code: string; message: string }
  }>
  /** 来源位置（锚点）统计（只读，Phase 9 / S4 补） */
  getAnchorStats(compilationId: string): Promise<{
    ok: boolean
    data?: { total: number; anchored: number; withPage: number; ambiguous: number }
    error?: { code: string; message: string }
  }>
  /** 「疑似超出范围」复核（只读，Phase 9 补充：界面兜底） */
  scopeCheck(compilationId: string): Promise<{
    ok: boolean
    data?: {
      flagged: { id: string; position: number; text: string; sourceTitle?: string; markers: string[] }[]
      checked: number
      available: boolean
      localities: string[]
    }
    error?: { code: string; message: string }
  }>
  /** 把"疑似超出范围"的段落移出汇编（kept=false：可撤销、不删数据） */
  excludeCompilationItems(
    compilationId: string,
    itemIds: string[]
  ): Promise<{ ok: boolean; data?: { compilation: unknown; excluded: number; message: string }; error?: { code: string; message: string } }>
  getWorkspaceStatus(): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  workspaceNavSync(): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  migrateLegacyWorkspace(): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  onWorkspaceProgress(cb: (p: { done: number; total: number; newFiles?: number; added?: number; changed?: number; removed?: number; moved?: number; errors?: number; finished?: boolean }) => void): () => void
  createTask(input?: { title?: string; mode?: 'compile' | 'draft'; scope?: { all: true } | { sourceIds: string[] } | { tagIds: string[] }; llmProviderId?: string }): Promise<{ ok: boolean; data?: { task: unknown }; error?: { code: string; message: string } }>
  listTasks(mode?: 'compile' | 'draft'): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  deleteTask(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  renameTask(taskId: string, title: string): Promise<{ ok: boolean; data?: { task: unknown }; error?: { code: string; message: string } }>
  updateTaskProvider(taskId: string, llmProviderId: string | null): Promise<{ ok: boolean; data?: { task: unknown }; error?: { code: string; message: string } }>
  getModelText(taskId: string): Promise<{ ok: boolean; data?: { text: string }; error?: { code: string; message: string } }>
  setModelText(taskId: string, text: string): Promise<{ ok: boolean; data?: { text: string }; error?: { code: string; message: string } }>
  chatWithTask(taskId: string, message: string, history?: { role: 'user' | 'assistant'; content: string }[]): Promise<{ ok: boolean; data?: { reply: string }; error?: { code: string; message: string } }>
  listTaskMessages(taskId: string): Promise<{ ok: boolean; data?: { items: { id: string; taskId: string; role: 'user' | 'assistant'; kind: 'chat' | 'instruction' | 'notice'; content: string; createdAt: string }[] }; error?: { code: string; message: string } }>
  addTaskMessage(taskId: string, role: 'user' | 'assistant', content: string, kind: 'chat' | 'instruction' | 'notice'): Promise<{ ok: boolean; data?: { message: unknown }; error?: { code: string; message: string } }>
  onDraftGenerateProgress(cb: (p: { taskId: string; stage: string; percent: number; etaSeconds?: number }) => void): () => void
  onCompilationProgress(cb: (p: { taskId: string; stage: string; percent: number; etaSeconds?: number; candidateChunks?: number; candidateSources?: number; fetch?: { active: boolean; paused: boolean } }) => void): () => void
  onCompilationAdvice(cb: (p: { taskId: string; kind: string }) => void): () => void
  onWritingStreamDelta(cb: (p: { taskId: string; text: string }) => void): () => void
  retrieveChunks(taskId: string): Promise<{ ok: boolean; data?: { chunks: unknown[] }; error?: { code: string; message: string } }>
  askSource(taskId: string, selection: string): Promise<{ ok: boolean; data?: { reply: string; refs: { index: number; sourceId: string; title: string; position?: string }[] }; error?: { code: string; message: string } }>
  generateDraft(taskId: string, instruction: string, compilationId: string): Promise<{ ok: boolean; data?: { draft: unknown; articleTitle: string | null; contradictions: unknown[] }; error?: { code: string; message: string } }>
  regenerateDraft(taskId: string, instruction: string, compilationId: string): Promise<{ ok: boolean; data?: { draft: unknown; articleTitle: string | null; contradictions: unknown[] }; error?: { code: string; message: string } }>
  getDraft(draftId: string): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  updateDraftContent(draftId: string, markdown: string): Promise<{ ok: boolean; data?: { draft: unknown }; error?: { code: string; message: string } }>
  getDraftContradictions(draftId: string): Promise<{ ok: boolean; data?: { contradictions: unknown[] }; error?: { code: string; message: string } }>
  resolveContradiction(contradictionId: string, action: 'adopt' | 'ignore' | 'revert', variantId?: string): Promise<{ ok: boolean; data?: { contradiction: unknown }; error?: { code: string; message: string } }>
  applyContradiction(draftId: string, contradictionId: string, variantId: string): Promise<{ ok: boolean; data?: { draft: unknown; contradiction: unknown }; error?: { code: string; message: string } }>
  openSourcePath(sourceId: string): Promise<{ ok: boolean; data?: { opened: boolean }; error?: { code: string; message: string } }>
  /** 内嵌网页浏览器（Phase 8 / S4）：打开 / 调整位置 / 关闭 / 导航 / 后退-前进-刷新 */
  webBrowserOpen(sourceId: string, rect: { x: number; y: number; width: number; height: number }): Promise<{ ok: boolean; data?: { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }; error?: { code: string; message: string } }>
  webBrowserSetBounds(rect: { x: number; y: number; width: number; height: number }): Promise<{ ok: boolean; data?: { ok: true }; error?: { code: string; message: string } }>
  webBrowserClose(): Promise<{ ok: boolean; data?: { ok: true }; error?: { code: string; message: string } }>
  webBrowserNavigate(url: string): Promise<{ ok: boolean; data?: { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }; error?: { code: string; message: string } }>
  webBrowserAction(action: 'back' | 'forward' | 'reload'): Promise<{ ok: boolean; data?: { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }; error?: { code: string; message: string } }>
  updateSegment(segmentId: string, content: string): Promise<{ ok: boolean; data?: { segment: unknown }; error?: { code: string; message: string } }>
  getLatestDraftByTask(taskId: string): Promise<{ ok: boolean; data?: { draft: unknown }; error?: { code: string; message: string } }>
  focusWindow(): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  /** 渲染进程上报诊断日志（2026-08-14） */
  appendLog(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', tag: string, message: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  /** 导出诊断日志文件（2026-08-14） */
  exportLog(): Promise<{ ok: boolean; data?: { path: string; fileName: string }; error?: { code: string; message: string } }>
}

declare global {
  interface Window {
    api: AppApi
  }
}
