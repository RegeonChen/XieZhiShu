import { useEffect, useRef, useState } from 'react'
import { getDocument } from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
// 在主线程加载 worker 模块：其末尾会执行 globalThis.pdfjsWorker = { WorkerMessageHandler }。
// pdf.js 检测到该全局对象后，使用 LoopbackPort 在主线程运行 worker —— 无需真实 Worker 构造，
// 也无需动态 import，dev(http) 与生产(file://) 环境下均稳定。
import 'pdfjs-dist/build/pdf.worker.min.mjs'

// 渲染像素密度：canvas 以 2x 渲染，通过 CSS 100% 宽度自适应容器，实时随面板缩放
const RENDER_SCALE = 2

// 缩放范围：1 = 适应容器宽度；可放大/缩小查看
const ZOOM_MIN = 0.25
const ZOOM_MAX = 4
const ZOOM_STEP = 0.8

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
}

interface PdfViewerProps {
  url: string
}

export default function PdfViewer({ url }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [rendered, setRendered] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const renderTasksRef = useRef<RenderTask[]>([])

  // 加载文档
  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setNumPages(0)
    setRendered(0)
    setError(null)

    try {
      const loadingTask = getDocument({ url })
      loadingTaskRef.current = loadingTask
      loadingTask.promise
        .then((d) => {
          if (cancelled) return
          setDoc(d)
          setNumPages(d.numPages)
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }

    return () => {
      cancelled = true
      loadingTaskRef.current?.destroy().catch(() => {})
      loadingTaskRef.current = null
    }
  }, [url])

  // 渲染全部页面到 canvas（canvas 通过 CSS 100% 宽度实时自适应）
  useEffect(() => {
    const container = containerRef.current
    if (!doc || !container) return

    let cancelled = false
    container.innerHTML = ''
    setRendered(0)

    const renderAll = async () => {
      try {
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return
          const page = await doc.getPage(i)
          if (cancelled) return

          const viewport = page.getViewport({ scale: RENDER_SCALE })
          const canvas = document.createElement('canvas')
          canvas.className = 'pdf-viewer__canvas'
          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)
          container.appendChild(canvas)

          const task = page.render({ canvas, viewport })
          renderTasksRef.current.push(task)
          await task.promise
          if (cancelled) return
          setRendered((n) => n + 1)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }

    renderAll()

    return () => {
      cancelled = true
      container.innerHTML = ''
      renderTasksRef.current.forEach((t) => t.cancel())
      renderTasksRef.current = []
    }
  }, [doc])

  return (
    <div className="pdf-viewer">
      <div className="pdf-viewer__toolbar">
        {numPages > 0 && (
          <span className="pdf-viewer__info">
            {rendered < numPages ? `正在渲染 ${rendered} / ${numPages} 页...` : `共 ${numPages} 页`}
          </span>
        )}
        <button type="button" className="pdf-viewer__btn" onClick={() => setZoom((z) => clampZoom(z * ZOOM_STEP))} title="缩小">缩小</button>
        <span className="pdf-viewer__zoom-label">{Math.round(zoom * 100)}%</span>
        <button type="button" className="pdf-viewer__btn" onClick={() => setZoom((z) => clampZoom(z / ZOOM_STEP))} title="放大">放大</button>
        <button type="button" className="pdf-viewer__btn" onClick={() => setZoom(1)} title="适应窗口宽度">适应宽度</button>
      </div>
      {error ? (
        <div className="source-viewer__status" style={{ color: '#dc2626' }}>PDF 加载失败：{error}</div>
      ) : (
        <div className="pdf-viewer__pages" ref={containerRef} style={{ zoom }} />
      )}
    </div>
  )
}
