/**
 * Phase 9 / S2（收尾）：PDF **逐页文字**提取，供"块 → 页"页表使用。
 *
 * 为什么要单独取逐页：库里存的正文是整篇拼起来的，没有页码信息；而本项目的页级定位靠
 * `source_blocks.page`，必须知道"第几页的文字从第几个字符开始"。这里的取法与库里的正文可能
 * 在空白/换行上略有差异（不同提取器口径不同），所以 `alignPageTexts` 用**去空白比对**对齐，
 * 对不上就整体放弃页表（如实降级，绝不猜页码）。
 */
export interface PdfPageTexts {
  pages: string[]
  numPages: number
}

type PdfjsModule = {
  getDocument: (opts: Record<string, unknown>) => PdfLoadingTask
}
/** pdfjs 的 `getDocument()` 返回的是**加载任务**：`promise` 拿文档，`destroy()` 在任务上（不在文档上） */
interface PdfLoadingTask {
  promise: Promise<PdfDocument>
  destroy?: () => Promise<void>
}
interface PdfDocument {
  numPages: number
  getPage: (n: number) => Promise<PdfPage>
  destroy: () => Promise<void>
}
interface PdfPage {
  getTextContent: () => Promise<{ items: unknown[] }>
  cleanup: () => void
}

/** 依次尝试 pdfjs 的 Node 版入口与主入口（不同版本/安装形态下可用路径不同） */
async function loadPdfjs(): Promise<PdfjsModule> {
  const candidates = ['pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist']
  const errors: string[] = []
  for (const spec of candidates) {
    try {
      const mod = (await import(/* @vite-ignore */ spec)) as unknown as PdfjsModule
      if (typeof mod?.getDocument === 'function') return mod
      errors.push(`${spec}: 没有 getDocument`)
    } catch (e) {
      errors.push(`${spec}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new Error(`无法加载 pdfjs（${errors.join('；')}）`)
}

/**
 * 逐页提取文字。返回的 `pages[i]` 是第 i+1 页的文字（**不保证**与库里正文逐字一致，仅保证顺序与页数正确）。
 * 扫描页（无文字层）返回空字符串——页码仍在，这正是"扫描件也能定位到页"的原因。
 */
export async function extractPdfPageTexts(data: Uint8Array, cmapsDir = ''): Promise<PdfPageTexts> {
  const pdfjs = await loadPdfjs()
  const opts: Record<string, unknown> = {
    // 传副本：pdfjs 可能转移/释放这块内存
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false
  }
  if (cmapsDir) {
    opts.cMapUrl = cmapsDir
    opts.cMapPacked = true
  }
  const task = pdfjs.getDocument(opts)
  const doc = await task.promise
  try {
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items) {
        const it = item as { str?: unknown }
        if (typeof it.str === 'string') text += it.str
      }
      pages.push(text)
      page.cleanup()
    }
    return { pages, numPages: doc.numPages }
  } finally {
    // 释放：destroy 在加载任务上；老版本可能没有 → 尽力而为，不让清理失败盖住真正的结果
    try {
      await task.destroy?.()
    } catch {
      /* 忽略 */
    }
  }
}
