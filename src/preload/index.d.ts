export interface ImportResult {
  path: string
  source?: { id: string; title: string; status: string; kind: string; createdAt: string }
  error?: string
}

export interface AppApi {
  getAppInfo(): Promise<{ ok: boolean; data?: { version: string; platform: string }; error?: { code: string; message: string } }>
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
  /** 同步站点文章清单（发现新文章，返回新增数） */
  syncWebSource(id: string): Promise<{ ok: boolean; data?: { articles: number }; error?: { code: string; message: string } }>
  /** 配置站点用户关键词（E11，逗号/顿号/空格分隔，参与该站点召回） */
  updateWebSourceKeywords(id: string, keywords: string): Promise<{ ok: boolean; data?: { site: unknown }; error?: { code: string; message: string } }>
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
  generateCompilation(taskId: string, title: string): Promise<{ ok: boolean; data?: { compilation: unknown }; error?: { code: string; message: string } }>
  adjustCompilation(taskId: string, compilationId: string, instruction: string): Promise<{ ok: boolean; data?: { compilation: unknown; explain?: string; removedCards?: number; addedCards?: number; updatedCards?: number }; error?: { code: string; message: string } }>
  reorderCompilation(compilationId: string, direction: 'asc' | 'desc'): Promise<{ ok: boolean; data?: { compilation: unknown }; error?: { code: string; message: string } }>
  undoCompilation(compilationId: string): Promise<{ ok: boolean; data?: { compilation: unknown; undoAvailable: number; redoAvailable: number }; error?: { code: string; message: string } }>
  redoCompilation(compilationId: string): Promise<{ ok: boolean; data?: { compilation: unknown; undoAvailable: number; redoAvailable: number }; error?: { code: string; message: string } }>
  getCompilationUndoState(compilationId: string): Promise<{ ok: boolean; data?: { undoAvailable: number; redoAvailable: number }; error?: { code: string; message: string } }>
  updateCompilationItem(itemId: string, patch: { excerpt?: string; ts?: string | null; note?: string | null; extraTags?: string[]; kept?: boolean }): Promise<{ ok: boolean; data?: { item: unknown }; error?: { code: string; message: string } }>
  deleteCompilationItem(itemId: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  resolveCompilationContradiction(contradictionId: string, action: 'resolve' | 'ignore', chosenItemId?: string): Promise<{ ok: boolean; data?: { contradiction: unknown }; error?: { code: string; message: string } }>
  confirmCompilation(compilationId: string): Promise<{ ok: boolean; data?: { compilation: unknown }; error?: { code: string; message: string } }>
  listCompilationRecycleBin(compilationId: string): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  restoreCompilationRecycleBin(binId: string): Promise<{ ok: boolean; data?: { contradiction?: unknown; repair?: unknown; item?: unknown; card?: unknown }; error?: { code: string; message: string } }>
  scanCompilationRepairs(compilationId: string): Promise<{ ok: boolean; data?: { repairs: unknown[] }; error?: { code: string; message: string } }>
  listCompilationRepairs(compilationId: string): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  decideCompilationRepair(repairId: string, action: 'accept' | 'reject'): Promise<{ ok: boolean; data?: { item: unknown; repair: unknown }; error?: { code: string; message: string } }>
  listSourceRemovals(): Promise<{ ok: boolean; data?: { items: { sourceId: string; title: string; cardCount: number; contradictionCount: number; repairCount: number; origin: 'workspace' | 'manual' }[] }; error?: { code: string; message: string } }>
  decideSourceRemoval(sourceId: string, action: 'delete' | 'keep'): Promise<{ ok: boolean; data?: { deletedItems: number; deletedContradictions: number; deletedRepairs: number }; error?: { code: string; message: string } }>
  onSourceRemoved(cb: (p: { sourceId: string; title: string; cardCount: number; contradictionCount: number; repairCount: number; origin: 'workspace' | 'manual' }) => void): () => void
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
  saveProvider(input: { id?: string; name: string; apiBase: string; model: string; apiKey?: string }): Promise<{ ok: boolean; data?: { provider: unknown }; error?: { code: string; message: string } }>
  deleteProvider(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  testProvider(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  getSettings(): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  updateSettings(patch: { dataDir?: string; workspaceDir?: string; compilationProviderId?: string; draftProviderId?: string }): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  getWorkspaceStatus(): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  workspaceNavSync(): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  migrateLegacyWorkspace(): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  onWorkspaceProgress(cb: (p: { done: number; total: number; newFiles?: number; added?: number; changed?: number; removed?: number; moved?: number; errors?: number; finished?: boolean }) => void): () => void
  createTask(input?: { title?: string; scope?: { all: true } | { sourceIds: string[] } | { tagIds: string[] }; llmProviderId?: string }): Promise<{ ok: boolean; data?: { task: unknown }; error?: { code: string; message: string } }>
  listTasks(): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  deleteTask(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  renameTask(taskId: string, title: string): Promise<{ ok: boolean; data?: { task: unknown }; error?: { code: string; message: string } }>
  updateTaskProvider(taskId: string, llmProviderId: string | null): Promise<{ ok: boolean; data?: { task: unknown }; error?: { code: string; message: string } }>
  getModelText(taskId: string): Promise<{ ok: boolean; data?: { text: string }; error?: { code: string; message: string } }>
  setModelText(taskId: string, text: string): Promise<{ ok: boolean; data?: { text: string }; error?: { code: string; message: string } }>
  chatWithTask(taskId: string, message: string, history?: { role: 'user' | 'assistant'; content: string }[]): Promise<{ ok: boolean; data?: { reply: string }; error?: { code: string; message: string } }>
  listTaskMessages(taskId: string): Promise<{ ok: boolean; data?: { items: { id: string; taskId: string; role: 'user' | 'assistant'; kind: 'chat' | 'instruction' | 'notice'; content: string; createdAt: string }[] }; error?: { code: string; message: string } }>
  addTaskMessage(taskId: string, role: 'user' | 'assistant', content: string, kind: 'chat' | 'instruction' | 'notice'): Promise<{ ok: boolean; data?: { message: unknown }; error?: { code: string; message: string } }>
  onDraftGenerateProgress(cb: (p: { taskId: string; stage: string; percent: number; etaSeconds?: number }) => void): () => void
  onCompilationProgress(cb: (p: { taskId: string; stage: string; percent: number; etaSeconds?: number; candidateChunks?: number; candidateSources?: number }) => void): () => void
  onWritingStreamDelta(cb: (p: { taskId: string; text: string }) => void): () => void
  retrieveChunks(taskId: string): Promise<{ ok: boolean; data?: { chunks: unknown[] }; error?: { code: string; message: string } }>
  askSource(taskId: string, selection: string): Promise<{ ok: boolean; data?: { reply: string; refs: { index: number; sourceId: string; title: string; position?: string }[] }; error?: { code: string; message: string } }>
  generateDraft(taskId: string, instruction: string, compilationId?: string): Promise<{ ok: boolean; data?: { draft: unknown; articleTitle: string | null; contradictions: unknown[] }; error?: { code: string; message: string } }>
  regenerateDraft(taskId: string, instruction: string, compilationId?: string): Promise<{ ok: boolean; data?: { draft: unknown; articleTitle: string | null; contradictions: unknown[] }; error?: { code: string; message: string } }>
  getDraft(draftId: string): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  updateDraftContent(draftId: string, markdown: string): Promise<{ ok: boolean; data?: { draft: unknown }; error?: { code: string; message: string } }>
  getDraftContradictions(draftId: string): Promise<{ ok: boolean; data?: { contradictions: unknown[] }; error?: { code: string; message: string } }>
  resolveContradiction(contradictionId: string, action: 'adopt' | 'ignore' | 'revert', variantId?: string): Promise<{ ok: boolean; data?: { contradiction: unknown }; error?: { code: string; message: string } }>
  applyContradiction(draftId: string, contradictionId: string, variantId: string): Promise<{ ok: boolean; data?: { draft: unknown; contradiction: unknown }; error?: { code: string; message: string } }>
  openSourcePath(sourceId: string): Promise<{ ok: boolean; data?: { opened: boolean }; error?: { code: string; message: string } }>
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
