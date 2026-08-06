export interface ImportResult {
  path: string
  source?: { id: string; title: string; status: string; kind: string; createdAt: string }
  error?: string
}

export interface AppApi {
  getAppInfo(): Promise<{ ok: boolean; data?: { version: string; platform: string }; error?: { code: string; message: string } }>
  addUrl(url: string): Promise<{ ok: boolean; data?: { source: unknown }; error?: { code: string; message: string } }>
  listSources(params?: { tagIds?: string[]; search?: string }): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  importFiles(paths: string[]): Promise<{ ok: boolean; data?: { results: ImportResult[] }; error?: { code: string; message: string } }>
  openFileDialog(): Promise<{ ok: boolean; data?: { paths: string[] }; error?: { code: string; message: string } }>
  listTags(): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  createTag(name: string): Promise<{ ok: boolean; data?: { tag: unknown }; error?: { code: string; message: string } }>
  updateTag(id: string, name?: string): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  deleteTag(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  addTagToSource(sourceId: string, tagId: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  removeTagFromSource(sourceId: string, tagId: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  searchTags(query: string, limit?: number): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  batchAddTags(tagIds: string[], sourceIds: string[]): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  getTagSourceIds(tagId: string): Promise<{ ok: boolean; data?: { sourceIds: string[] }; error?: { code: string; message: string } }>
  listTemplates(): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  importTemplate(path: string): Promise<{ ok: boolean; data?: { template: unknown }; error?: { code: string; message: string } }>
  deleteTemplate(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  getSource(id: string): Promise<{ ok: boolean; data?: { source: unknown; tags: unknown[] }; error?: { code: string; message: string } }>
  renderSourceHtml(id: string): Promise<{ ok: boolean; data?: { html: string }; error?: { code: string; message: string } }>
  getSourceFileUrl(id: string): Promise<{ ok: boolean; data?: { url: string }; error?: { code: string; message: string } }>
  deleteSource(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  deleteSources(ids: string[]): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  listProviders(): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  saveProvider(input: { id?: string; name: string; apiBase: string; model: string; apiKey?: string }): Promise<{ ok: boolean; data?: { provider: unknown }; error?: { code: string; message: string } }>
  deleteProvider(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  testProvider(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  getSettings(): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  updateSettings(patch: { currentLlmProviderId?: string; dataDir?: string }): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  createTask(input: { title: string; scope: { sourceIds: string[] } | { tagIds: string[] }; templateBookId?: string }): Promise<{ ok: boolean; data?: { task: unknown }; error?: { code: string; message: string } }>
  listTasks(): Promise<{ ok: boolean; data?: { items: unknown[] }; error?: { code: string; message: string } }>
  deleteTask(id: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  retrieveChunks(taskId: string): Promise<{ ok: boolean; data?: { chunks: unknown[] }; error?: { code: string; message: string } }>
  generateDraft(taskId: string): Promise<{ ok: boolean; data?: { draft: unknown }; error?: { code: string; message: string } }>
  getDraft(draftId: string): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  updateSegment(segmentId: string, content: string): Promise<{ ok: boolean; data?: { segment: unknown }; error?: { code: string; message: string } }>
  listVersions(taskId: string): Promise<{ ok: boolean; data?: { versions: unknown[] }; error?: { code: string; message: string } }>
}

declare global {
  interface Window {
    api: AppApi
  }
}
