/**
 * compilation-export.ts —— 资料汇编导出（生成汇编功能区，2026-09）。
 * 1) 导出 .docx：用 jszip 手工生成最小合法 OOXML 文档（无第三方 docx 依赖）。
 * 2) 导出 .xzsc：软件专用格式（JSON，可被「撰写初稿」导入）。
 */
import JSZip from 'jszip'
import type { Compilation } from '../../shared/types'

const XZSC_MAGIC = 'XieZhiShuCompilation'

/**
 * `.xzsc` 归档的当前格式版本。
 * - v1（历史）：`{ magic, version:1, compilation }`——整份 `Compilation` 原样 dump，材料仍是"卡片"形态。
 * - v2（Phase 7.6）：显式分层——`document`（段落数组，含时间与来源标题）+ `sources`（编号表）
 *   + `versions`（版本摘要，**可裁剪**：只导摘要不导每版全文快照，正文即当前版本）
 *   + `messages`（对话历史）+ `contradictions`。
 */
const XZSC_VERSION = 2

/** 段落数组里的一段（导出用；含时间与来源标题，便于外部工具直接阅读） */
interface ArchiveParagraph {
  ordinal: number
  timeLabel?: string
  year?: number
  month?: number
  text: string
  sourceOrdinal?: number
  sourceTitle?: string
  evidence?: string
}

export interface CompilationArchivePayload {
  magic: string
  version: number
  exportedAt: string
  document: {
    title: string
    status: string
    createdAt: string
    updatedAt: string
    paragraphs: ArchiveParagraph[]
  }
  sources: { ordinal: number; title: string }[]
  /** 版本摘要（不含每版全文快照——正文即当前版本，避免归档体积翻倍） */
  versions: { versionNo: number; origin: string; createdAt: string; changeSummary?: unknown }[]
  messages: { role: string; content: string; versionNo?: number; createdAt: string }[]
  contradictions: Compilation['contradictions']
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 一个 run（Word 的最小文本单元）：支持加粗、字号与**上标**（来源编号用） */
interface DocxRun {
  text: string
  bold?: boolean
  size?: number
  superscript?: boolean
}

function runXml(r: DocxRun): string {
  const props: string[] = []
  if (r.bold) props.push('<w:b/>')
  if (r.size) props.push(`<w:sz w:val="${r.size}"/>`)
  if (r.superscript) props.push('<w:vertAlign w:val="superscript"/>')
  const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : ''
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`
}

/** 由若干 run 组成一段（空 run 跳过；全空的段落仍是合法的空行） */
function paraRuns(runs: DocxRun[]): string {
  const body = runs.filter((r) => r.text !== '').map(runXml).join('')
  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${body}</w:p>`
}

function para(text: string, opts: { bold?: boolean; size?: number } = {}): string {
  return paraRuns([{ text, bold: opts.bold, size: opts.size }])
}

/** 来源标题：优先用 JOIN 出来的标题，缺失时退回 sourceId */
function sourceTitleOf(item: { sourceId: string; sourceTitle?: string }): string {
  return item.sourceTitle && item.sourceTitle !== item.sourceId ? item.sourceTitle : item.sourceId
}

/**
 * 生成 .docx 的 word/document.xml 正文（纯函数，便于单测）。
 *
 * Phase 7.6：从"一卡两头两段"改为**连续文档**——
 * 标题 + 正文（每段 = 段首时间 + 正文 + **上标来源编号**）+ 附：来源清单（编号 ↔《标题》）+ 矛盾说明。
 * 上标编号与附录清单的编号一致，对应 `compilation_sources` 的 `ordinal`（本汇编内首次引用顺序 1..N）。
 */
export function compilationDocxXml(comp: Compilation): string {
  const items = (comp.items ?? []).filter((it) => it.kept !== false)
  /** 来源编号 → 标题（与查看器「来源小卡」同口径：直接取段落上 JOIN 出来的标题） */
  const sourceTitles = new Map<number, string>()
  for (const it of items) {
    if (it.sourceOrdinal == null) continue
    if (!sourceTitles.has(it.sourceOrdinal)) sourceTitles.set(it.sourceOrdinal, sourceTitleOf(it))
  }

  const paras: string[] = []
  paras.push(para(`资料汇编：${comp.title}`, { bold: true, size: 36 }))
  paras.push(
    para(
      `生成时间：${comp.updatedAt || comp.createdAt}｜状态：${comp.status === 'finalized' ? '已确认' : comp.status}` +
        `｜共 ${items.length} 段 / ${sourceTitles.size} 篇来源`
    )
  )
  paras.push(para(''))

  if (items.length === 0) {
    paras.push(para('（本汇编暂无可导出的段落）'))
  } else {
    paras.push(para('一、正文', { bold: true, size: 30 }))
    for (const it of items) {
      // 段首时间（志书体例要求含年份；确无依据时明确标注「时间待核」，不编造）
      const time = it.ts && it.ts.trim() ? it.ts.trim() : '时间待核'
      const runs: DocxRun[] = [{ text: time + '　', bold: true }, { text: it.excerpt }]
      if (it.sourceOrdinal != null) runs.push({ text: String(it.sourceOrdinal), superscript: true })
      else runs.push({ text: '（来源待补）' })
      paras.push(paraRuns(runs))
    }
  }

  if (sourceTitles.size > 0) {
    paras.push(para(''))
    paras.push(para(`二、附：来源清单（共 ${sourceTitles.size} 篇）`, { bold: true, size: 30 }))
    for (const [ordinal, title] of [...sourceTitles.entries()].sort((a, b) => a[0] - b[0])) {
      paras.push(para(`来源 ${ordinal}：《${title}》`))
    }
  }

  const contradictions = comp.contradictions ?? []
  if (contradictions.length > 0) {
    paras.push(para(''))
    paras.push(para(`三、矛盾说明（共 ${contradictions.length} 组）`, { bold: true, size: 30 }))
    contradictions.forEach((c, i) => {
      const variants = c.variants.map((v) => `「${v.variantText}」（《${sourceTitleOf(v)}》）`).join('；')
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

/**
 * 导出资料汇编为软件专用格式 .xzsc（JSON 文本，v2）。
 * `versions` / `messages` 由调用方从库里取（`Compilation` 本身不含这两张表），缺省则导出为空数组。
 */
export function serializeCompilationArchive(
  comp: Compilation,
  extra?: {
    versions?: { versionNo: number; origin: string; createdAt: string; changeSummary?: unknown }[]
    messages?: { role: string; content: string; versionNo?: number; createdAt: string }[]
  }
): string {
  return serializeCompilationArchiveV2(comp, extra)
}

/** v2 归档对象（导出成文本或直接在测试里断言都走这里） */
export function buildCompilationArchive(
  comp: Compilation,
  extra?: {
    versions?: { versionNo: number; origin: string; createdAt: string; changeSummary?: unknown }[]
    messages?: { role: string; content: string; versionNo?: number; createdAt: string }[]
  }
): CompilationArchivePayload {
  const items = (comp.items ?? []).filter((it) => it.kept !== false)
  const paragraphs: ArchiveParagraph[] = items.map((it, i) => ({
    ordinal: i,
    timeLabel: it.ts,
    year: it.year,
    month: it.month,
    text: it.excerpt,
    sourceOrdinal: it.sourceOrdinal,
    sourceTitle: it.sourceTitle,
    evidence: it.evidence
  }))
  const sources = new Map<number, string>()
  for (const it of items) {
    if (it.sourceOrdinal == null) continue
    if (!sources.has(it.sourceOrdinal)) sources.set(it.sourceOrdinal, sourceTitleOf(it))
  }
  return {
    magic: XZSC_MAGIC,
    version: XZSC_VERSION,
    exportedAt: new Date().toISOString(),
    document: {
      title: comp.title,
      status: comp.status,
      createdAt: comp.createdAt,
      updatedAt: comp.updatedAt,
      paragraphs
    },
    sources: [...sources.entries()].sort((a, b) => a[0] - b[0]).map(([ordinal, title]) => ({ ordinal, title })),
    versions: extra?.versions ?? [],
    messages: extra?.messages ?? [],
    contradictions: comp.contradictions ?? []
  }
}

function serializeCompilationArchiveV2(
  comp: Compilation,
  extra?: {
    versions?: { versionNo: number; origin: string; createdAt: string; changeSummary?: unknown }[]
    messages?: { role: string; content: string; versionNo?: number; createdAt: string }[]
  }
): string {
  return JSON.stringify(buildCompilationArchive(comp, extra), null, 2)
}

/**
 * 解析 .xzsc 内容，返回可用于导入的 `Compilation`；失败或格式不符返回 null。
 * **读取兼容**：v1（`{magic, version:1, compilation}`）直接取原对象；v2 由 `document.paragraphs` 还原段落。
 */
export function parseCompilationArchive(data: string): Compilation | null {
  try {
    const raw = JSON.parse(data) as {
      magic?: string
      version?: number
      compilation?: unknown
      document?: { title?: string; status?: string; createdAt?: string; updatedAt?: string; paragraphs?: unknown }
      sources?: { ordinal?: number; title?: string }[]
      contradictions?: unknown
    }
    if (raw.magic !== XZSC_MAGIC) return null
    // v1：整份 Compilation
    if (typeof raw.compilation === 'object' && raw.compilation !== null) return raw.compilation as Compilation
    // v2：由 document 还原
    const doc = raw.document
    if (!doc || !Array.isArray(doc.paragraphs)) return null
    const titleByOrdinal = new Map<number, string>()
    for (const s of raw.sources ?? []) {
      if (typeof s?.ordinal === 'number' && typeof s.title === 'string') titleByOrdinal.set(s.ordinal, s.title)
    }
    const items = (doc.paragraphs as Partial<ArchiveParagraph>[]).map((p, i) => {
      const sourceOrdinal = typeof p.sourceOrdinal === 'number' ? p.sourceOrdinal : undefined
      return {
        id: 'imported-' + i,
        compilationId: '',
        position: i,
        sourceId: '',
        excerpt: typeof p.text === 'string' ? p.text : '',
        ts: typeof p.timeLabel === 'string' ? p.timeLabel : undefined,
        year: typeof p.year === 'number' ? p.year : undefined,
        month: typeof p.month === 'number' ? p.month : undefined,
        sourceOrdinal,
        sourceTitle: sourceOrdinal != null ? titleByOrdinal.get(sourceOrdinal) : undefined,
        evidence: typeof p.evidence === 'string' ? p.evidence : undefined,
        extraTags: [],
        kept: true,
        createdAt: doc.createdAt ?? new Date().toISOString()
      }
    })
    return {
      id: '',
      taskId: '',
      title: typeof doc.title === 'string' ? doc.title : '',
      status: doc.status === 'finalized' ? 'finalized' : doc.status === 'reviewing' ? 'reviewing' : 'drafting',
      createdAt: doc.createdAt ?? new Date().toISOString(),
      updatedAt: doc.updatedAt ?? new Date().toISOString(),
      items,
      contradictions: Array.isArray(raw.contradictions) ? (raw.contradictions as Compilation['contradictions']) : []
    }
  } catch {
    return null
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  const makeComp = (over: Partial<Compilation> = {}): Compilation => ({
    id: 'c1',
    taskId: 't1',
    title: '高中教育',
    status: 'finalized',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
    items: [
      { id: 'i1', compilationId: 'c1', position: 0, sourceId: 's1', excerpt: '全区普通中学 30 所。', ts: '2018 年', sourceOrdinal: 2, sourceTitle: '长乐年鉴2019', extraTags: [], kept: true, createdAt: '2026-01-01' },
      { id: 'i2', compilationId: 'c1', position: 1, sourceId: 's2', excerpt: '全区教职工 900 人。', ts: '2019 年', sourceOrdinal: 1, sourceTitle: '教育发展报告', extraTags: [], kept: true, createdAt: '2026-01-01' },
      { id: 'i3', compilationId: 'c1', position: 2, sourceId: '', excerpt: '时间不明的段落。', sourceOrdinal: undefined, extraTags: [], kept: true, createdAt: '2026-01-01' },
      { id: 'i4', compilationId: 'c1', position: 3, sourceId: 's1', excerpt: '已排除的段落。', ts: '2020 年', sourceOrdinal: 2, extraTags: [], kept: false, createdAt: '2026-01-01' }
    ],
    contradictions: [
      {
        id: 'g1',
        compilationId: 'c1',
        topic: '2018 年普通中学数量',
        kind: 'data',
        status: 'resolved',
        chosenItemId: 'i1',
        createdAt: '2026-01-01',
        variants: [
          { id: 'v1', contradictionId: 'g1', itemId: 'i1', variantText: '30 所', sourceId: 's1', sourceTitle: '长乐年鉴2019', createdAt: '2026-01-01' },
          { id: 'v2', contradictionId: 'g1', itemId: 'i2', variantText: '32 所', sourceId: 's2', sourceTitle: '教育发展报告', createdAt: '2026-01-01' }
        ]
      }
    ],
    ...over
  })

  describe('compilation docx export (Phase 7.6：连续文档 + 上标编号 + 来源清单)', () => {
    it('exports one paragraph per kept item: time prefix, body, superscript source ordinal', () => {
      const xml = compilationDocxXml(makeComp())
      // 段首时间（加粗）+ 正文 + 上标编号
      expect(xml).toContain('<w:t xml:space="preserve">2018 年　</w:t>')
      expect(xml).toContain('<w:t xml:space="preserve">全区普通中学 30 所。</w:t>')
      expect(xml).toContain('<w:vertAlign w:val="superscript"/>')
      // 编号取自 source_ordinal（本汇编内首次引用顺序），不是位置序号
      expect(xml).toMatch(/全区普通中学 30 所。<\/w:t><\/w:r><w:r><w:rPr><w:vertAlign w:val="superscript"\/><\/w:rPr><w:t xml:space="preserve">2<\/w:t>/)
      expect(xml).toMatch(/全区教职工 900 人。<\/w:t><\/w:r><w:r><w:rPr><w:vertAlign w:val="superscript"\/><\/w:rPr><w:t xml:space="preserve">1<\/w:t>/)
      // 软删除（kept=false）的段落不导出；不再出现旧的"卡片"表述
      expect(xml).not.toContain('已排除的段落')
      expect(xml).not.toContain('资料卡片')
      expect(xml).toContain(`一、正文`)
    })

    it('marks a paragraph without a timestamp as pending and one without a source explicitly', () => {
      const xml = compilationDocxXml(makeComp())
      expect(xml).toContain('<w:t xml:space="preserve">时间待核　</w:t>')
      expect(xml).toContain('（来源待补）')
    })

    it('appends the source list keyed by ordinal, sorted, and the contradiction notes', () => {
      const xml = compilationDocxXml(makeComp())
      expect(xml).toContain('二、附：来源清单（共 2 篇）')
      expect(xml).toContain('来源 1：《教育发展报告》')
      expect(xml).toContain('来源 2：《长乐年鉴2019》')
      // 编号顺序按 ordinal 升序排列（1 在 2 之前）
      expect(xml.indexOf('来源 1：《教育发展报告》')).toBeLessThan(xml.indexOf('来源 2：《长乐年鉴2019》'))
      expect(xml).toContain('三、矛盾说明（共 1 组）')
      expect(xml).toContain('「30 所」（《长乐年鉴2019》）')
      // 统计行给出段数与来源篇数
      expect(xml).toContain('共 3 段 / 2 篇来源')
    })

    it('escapes XML special characters in paragraph text', () => {
      const xml = compilationDocxXml(
        makeComp({
          items: [
            { id: 'x', compilationId: 'c1', position: 0, sourceId: 's1', excerpt: 'A & B <C> "D"', ts: '2018 年', sourceOrdinal: 1, sourceTitle: 's1', extraTags: [], kept: true, createdAt: '2026-01-01' }
          ]
        })
      )
      expect(xml).toContain('A &amp; B &lt;C&gt; &quot;D&quot;')
      expect(xml).not.toContain('A & B <C>')
    })

    it('writes a v2 archive with paragraphs, sources, version summaries and messages', () => {
      const payload = buildCompilationArchive(makeComp(), {
        versions: [{ versionNo: 1, origin: 'generate', createdAt: '2026-01-01', changeSummary: { added: 3 } }],
        messages: [{ role: 'user', content: '删掉幼儿园那段', createdAt: '2026-01-02' }]
      })
      expect(payload.magic).toBe('XieZhiShuCompilation')
      expect(payload.version).toBe(2)
      // 段落数组：只含 kept 段，且带上时间与来源标题（外部工具可直接读）
      expect(payload.document.title).toBe('高中教育')
      expect(payload.document.paragraphs).toHaveLength(3)
      expect(payload.document.paragraphs[0]).toMatchObject({ ordinal: 0, timeLabel: '2018 年', text: '全区普通中学 30 所。', sourceOrdinal: 2, sourceTitle: '长乐年鉴2019' })
      // 来源编号表按 ordinal 升序
      expect(payload.sources).toEqual([
        { ordinal: 1, title: '教育发展报告' },
        { ordinal: 2, title: '长乐年鉴2019' }
      ])
      // 版本只导摘要（可裁剪），不带每版全文快照
      expect(payload.versions).toEqual([{ versionNo: 1, origin: 'generate', createdAt: '2026-01-01', changeSummary: { added: 3 } }])
      expect(payload.messages).toHaveLength(1)
      expect(payload).not.toHaveProperty('compilation')
    })

    it('round-trips a v2 archive back into a Compilation and still reads v1 archives', () => {
      const text = serializeCompilationArchive(makeComp())
      const back = parseCompilationArchive(text)!
      expect(back).not.toBeNull()
      expect(back.title).toBe('高中教育')
      expect(back.items).toHaveLength(3)
      expect(back.items[0]).toMatchObject({ excerpt: '全区普通中学 30 所。', ts: '2018 年', sourceOrdinal: 2, sourceTitle: '长乐年鉴2019' })
      // 无来源编号的段不编造来源标题
      expect(back.items[2].sourceTitle).toBeUndefined()
      // v1（历史格式）仍能读：整份 Compilation 原样取回
      const v1 = JSON.stringify({ magic: 'XieZhiShuCompilation', version: 1, compilation: makeComp() })
      expect(parseCompilationArchive(v1)!.items).toHaveLength(4)
      // 非本软件格式 / 坏 JSON → null
      expect(parseCompilationArchive(JSON.stringify({ magic: 'other' }))).toBeNull()
      expect(parseCompilationArchive('{ not json')).toBeNull()
    })
  })
}
