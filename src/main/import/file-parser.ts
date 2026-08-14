/**
 * file-parser.ts —— 多格式文档解析器。
 * 支持 PDF / Word(.docx / .doc / .wps) / Excel(.xls / .xlsx) / TXT / Markdown / 图片 OCR。
 * 每种解析器返回 string，异常时抛出带稳定错误码的 Error。
 */
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'

export interface ParseResult {
  text: string
  format: 'pdf' | 'docx' | 'doc' | 'wps' | 'xls' | 'xlsx' | 'txt' | 'md' | 'image'
  pageCount?: number
}

const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.doc', '.wps', '.xls', '.xlsx', '.txt', '.md', '.png', '.jpg', '.jpeg', '.bmp'])

export function getSupportedExtensions(): string[] {
  return Array.from(SUPPORTED_EXTS)
}

export function isSupported(path: string): boolean {
  return SUPPORTED_EXTS.has(extname(path).toLowerCase())
}

export async function parseFile(filePath: string): Promise<ParseResult> {
  const ext = extname(filePath).toLowerCase()
  const raw = await readFile(filePath) // 异步读取，避免批量导入阻塞主进程

  switch (ext) {
    case '.pdf':
      return parsePdf(raw, filePath)
    case '.docx':
      return parseDocx(raw, filePath)
    case '.doc':
      return parseDoc(raw, filePath)
    case '.wps':
      return parseWps(raw, filePath)
    case '.xls':
    case '.xlsx':
      return parseXls(raw, ext.slice(1) as 'xls' | 'xlsx')
    case '.txt':
    case '.md':
      return parseText(raw, ext as 'txt' | 'md')
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.bmp':
      return parseImage(filePath)
    default:
      throw Object.assign(new Error(`不支持的文件格式: ${ext}`), { code: 'PARSE_UNSUPPORTED' })
  }
}

async function parsePdf(buffer: Buffer, _path: string): Promise<ParseResult> {
  try {
    // pdf-parse v11 ESM: PDFParse is a class; call load() then getText()
    const { PDFParse } = await import('pdf-parse')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const instance = new (PDFParse as any)(new Uint8Array(buffer)) as { load(): Promise<unknown>; getText(): Promise<{ text: string; numpages: number }> }
    await instance.load()
    const data = await instance.getText()
    return { text: data.text, format: 'pdf', pageCount: data.numpages }
  } catch (err) {
    throw Object.assign(
      new Error(`PDF 解析失败: ${(err as Error).message}`),
      { code: 'PARSE_FAILED' }
    )
  }
}

async function parseDocx(buffer: Buffer, _path: string): Promise<ParseResult> {
  try {
    return { text: await extractDocxText(buffer), format: 'docx' }
  } catch (err) {
    throw Object.assign(
      new Error(`Word 解析失败: ${(err as Error).message}`),
      { code: 'PARSE_FAILED' }
    )
  }
}

// 旧版 Word(.doc 二进制格式)：word-extractor 纯 JS 解析
async function parseDoc(buffer: Buffer, _path: string): Promise<ParseResult> {
  try {
    return { text: await extractOleText(buffer), format: 'doc' }
  } catch (err) {
    throw Object.assign(
      new Error(`Word(.doc) 解析失败: ${(err as Error).message}`),
      { code: 'PARSE_FAILED' }
    )
  }
}

// WPS 文字(.wps)：现代 WPS Office 保存的 .wps 实为 OOXML(zip) 容器（同 .docx）→ mammoth；
// 兼容旧版保存的 .wps 为 OLE 复合文档（同 .doc）→ word-extractor；老版私有二进制无公开文档，无法纯 JS 解析。
async function parseWps(buffer: Buffer, _path: string): Promise<ParseResult> {
  try {
    if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
      // PK\x03\x04：OOXML zip 容器
      return { text: await extractDocxText(buffer), format: 'wps' }
    }
    if (buffer.length >= 8 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
      // D0 CF 11 E0：OLE 复合文档
      return { text: await extractOleText(buffer), format: 'wps' }
    }
    throw Object.assign(
      new Error('无法识别的 .wps 文件（仅支持由 WPS Office 保存的 .wps 文档，老版私有二进制格式暂无法解析）'),
      { code: 'PARSE_UNSUPPORTED' }
    )
  } catch (err) {
    if ((err as Error & { code?: string }).code) throw err
    throw Object.assign(
      new Error(`WPS 解析失败: ${(err as Error).message}`),
      { code: 'PARSE_FAILED' }
    )
  }
}

/** OOXML(zip) 文档正文文本：mammoth */
async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

/** OLE 复合文档正文文本：word-extractor */
async function extractOleText(buffer: Buffer): Promise<string> {
  const WordExtractor = (await import('word-extractor')).default
  const extractor = new WordExtractor()
  const extracted = await extractor.extract(buffer)
  return extracted.getBody() ?? ''
}

// Excel(.xls 二进制 / .xlsx OOXML)：SheetJS 统一解析，按单元格逐行展开（含行列标记，信息不丢失）
async function parseXls(buffer: Buffer, format: 'xls' | 'xlsx'): Promise<ParseResult> {
  try {
    const mod = await import('xlsx')
    const XLSX = (mod.default ?? mod) as typeof import('xlsx')
    const wb = XLSX.read(buffer, { type: 'buffer' })
    const lines: string[] = []
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name]
      if (!ws || !ws['!ref']) continue
      lines.push(`【工作表：${name}】`)
      const range = XLSX.utils.decode_range(ws['!ref'])
      for (let r = range.s.r; r <= range.e.r; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })]
          if (!cell || cell.v === undefined || cell.v === null) continue
          const text = String(cell.w ?? cell.v).trim()
          if (!text) continue
          lines.push(`第${r + 1}行第${c + 1}列：${text}`)
        }
      }
    }
    return { text: lines.join('\n'), format }
  } catch (err) {
    throw Object.assign(
      new Error(`Excel 解析失败: ${(err as Error).message}`),
      { code: 'PARSE_FAILED' }
    )
  }
}

function parseText(buffer: Buffer, ext: 'txt' | 'md'): ParseResult {
  try {
    const text = buffer.toString('utf-8')
    return { text, format: ext }
  } catch (err) {
    throw Object.assign(
      new Error(`文本解析失败: ${(err as Error).message}`),
      { code: 'PARSE_FAILED' }
    )
  }
}

async function parseImage(filePath: string): Promise<ParseResult> {
  try {
    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker('chi_sim')
    const result = await worker.recognize(filePath)
    await worker.terminate()
    return { text: result.data.text, format: 'image' }
  } catch (err) {
    throw Object.assign(
      new Error(`OCR 识别失败: ${(err as Error).message}`),
      { code: 'PARSE_FAILED' }
    )
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('file-parser Excel (.xls/.xlsx, 按单元格逐行展开)', () => {
    it('parses .xlsx via parseFile with row/col markers', async () => {
      const XLSX = (await import('xlsx')).default as typeof import('xlsx')
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['年份', '产值'],
        ['2022', 12345]
      ]), '统计')
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
      const p = join(tmpdir(), `_test_${Date.now()}.xlsx`)
      await writeFile(p, buf)
      try {
        const res = await parseFile(p)
        expect(res.format).toBe('xlsx')
        expect(res.text).toContain('【工作表：统计】')
        expect(res.text).toContain('第1行第1列：年份')
        expect(res.text).toContain('第2行第2列：12345')
      } finally {
        await unlink(p).catch(() => {})
      }
    })

    it('parses .xls (binary) via parseFile with row/col markers', async () => {
      const XLSX = (await import('xlsx')).default as typeof import('xlsx')
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['年份', '产值'],
        ['2022', 12345]
      ]), '统计')
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xls' })
      const p = join(tmpdir(), `_test_${Date.now()}.xls`)
      await writeFile(p, buf)
      try {
        const res = await parseFile(p)
        expect(res.format).toBe('xls')
        expect(res.text).toContain('【工作表：统计】')
        expect(res.text).toContain('第1行第1列：年份')
        expect(res.text).toContain('第2行第2列：12345')
      } finally {
        await unlink(p).catch(() => {})
      }
    })
  })

  describe('file-parser WPS 文字 (.wps, 按文件头签名识别)', () => {
    it('parses .wps (OOXML zip 容器, 现代 WPS Office 保存) via parseFile', async () => {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body><w:p><w:r><w:t>WPS测试正文内容</w:t></w:r></w:p></w:body></w:document>')
      const buf = await zip.generateAsync({ type: 'nodebuffer' })
      const p = join(tmpdir(), `_test_${Date.now()}.wps`)
      await writeFile(p, buf)
      try {
        const res = await parseFile(p)
        expect(res.format).toBe('wps')
        expect(res.text).toContain('WPS测试正文内容')
      } finally {
        await unlink(p).catch(() => {})
      }
    })

    it('rejects unrecognized .wps (老版私有二进制) with PARSE_UNSUPPORTED', async () => {
      const p = join(tmpdir(), `_test_${Date.now()}.wps`)
      await writeFile(p, Buffer.from([0x57, 0x50, 0x53, 0x00, 0x01, 0x02, 0x03]))
      try {
        await expect(parseFile(p)).rejects.toMatchObject({ code: 'PARSE_UNSUPPORTED' })
      } finally {
        await unlink(p).catch(() => {})
      }
    })
  })
}
