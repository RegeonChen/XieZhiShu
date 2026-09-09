/**
 * compilation-export.ts —— 资料汇编导出（生成汇编功能区，2026-09）。
 * 1) 导出 .docx：用 jszip 手工生成最小合法 OOXML 文档（无第三方 docx 依赖）。
 * 2) 导出 .xzsc：软件专用格式（JSON，可被「撰写初稿」导入）。
 */
import JSZip from 'jszip'
import type { Compilation } from '../../shared/types'

const XZSC_MAGIC = 'XieZhiShuCompilation'
const XZSC_VERSION = 1

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function para(text: string, opts: { bold?: boolean; size?: number } = {}): string {
  const rPr =
    opts.bold || opts.size
      ? `<w:rPr>${opts.bold ? '<w:b/>' : ''}${opts.size ? `<w:sz w:val="${opts.size}"/>` : ''}</w:rPr>`
      : ''
  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
}

/** 生成 .docx 的 word/document.xml 正文（纯函数，便于单测）。 */
export function compilationDocxXml(comp: Compilation): string {
  const items = (comp.items ?? []).filter((it) => it.kept !== false)
  const refText = (sourceId: string, sourceTitle?: string): string => {
    const title = sourceTitle && sourceTitle !== sourceId ? sourceTitle : sourceId
    return title ? `《${title}》` : ''
  };

  const paras: string[] = []
  paras.push(para(`资料汇编：${comp.title}`, { bold: true, size: 36 }))
  paras.push(para(`生成时间：${comp.updatedAt || comp.createdAt}｜状态：${comp.status === 'finalized' ? '已确认' : comp.status}`))
  paras.push(para(''))

  if (items.length === 0) {
    paras.push(para('（本汇编暂无可导出卡片）'))
  } else {
    paras.push(para(`一、资料卡片（共 ${items.length} 张）`, { bold: true, size: 30 }))
    items.forEach((it, i) => {
      const time = it.ts ? `【${it.ts}】` : ''
      const src = refText(it.sourceId, it.sourceTitle)
      paras.push(para(`${i + 1}. ${time}${src}`, { bold: true }))
      paras.push(para(it.excerpt))
    })
  }

  const contradictions = comp.contradictions ?? []
  if (contradictions.length > 0) {
    paras.push(para(''))
    paras.push(para(`二、矛盾说明（共 ${contradictions.length} 组）`, { bold: true, size: 30 }))
    contradictions.forEach((c, i) => {
      const variants = c.variants.map((v) => `「${v.variantText}」（${refText(v.sourceId, v.sourceTitle)}）`).join('；')
      paras.push(para(`${i + 1}. ${c.topic}（${c.kind}）：${variants}`))
    })
  }

  paras.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join('')}</w:body></w:document>`
}

/** 导出资料汇编为 .docx（返回 Buffer，由主进程写盘）。 */
export async function renderCompilationDocx(comp: Compilation): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  )
  zip.file('_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  )
  zip.file('word/document.xml', compilationDocxXml(comp))
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** 导出资料汇编为软件专用格式 .xzsc（JSON 文本）。 */
export function serializeCompilationArchive(comp: Compilation): string {
  return JSON.stringify(
    { magic: XZSC_MAGIC, version: XZSC_VERSION, exportedAt: new Date().toISOString(), compilation: comp },
    null,
    2
  )
}

/** 解析 .xzsc 内容；失败或格式不符返回 null（供未来外部导入，当前导入为占位）。 */
export function parseCompilationArchive(data: string): Compilation | null {
  try {
    const raw = JSON.parse(data) as { magic?: string; version?: number; compilation?: unknown }
    if (raw.magic !== XZSC_MAGIC) return null
    if (typeof raw.compilation !== 'object' || raw.compilation === null) return null
    return raw.compilation as Compilation
  } catch {
    return null
  }
}
