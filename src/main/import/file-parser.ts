/**
 * file-parser.ts —— 多格式文档解析器。
 * 支持 PDF / Word(.docx) / TXT / Markdown / 图片 OCR。
 * 每种解析器返回 string，异常时抛出带稳定错误码的 Error。
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

export interface ParseResult {
  text: string
  format: 'pdf' | 'docx' | 'txt' | 'md' | 'image'
  pageCount?: number
}

const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.txt', '.md', '.png', '.jpg', '.jpeg', '.bmp'])

export function getSupportedExtensions(): string[] {
  return Array.from(SUPPORTED_EXTS)
}

export function isSupported(path: string): boolean {
  return SUPPORTED_EXTS.has(extname(path).toLowerCase())
}

export async function parseFile(filePath: string): Promise<ParseResult> {
  const ext = extname(filePath).toLowerCase()
  const raw = readFileSync(filePath)

  switch (ext) {
    case '.pdf':
      return parsePdf(raw, filePath)
    case '.docx':
      return parseDocx(raw, filePath)
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
    const instance = new (PDFParse as any)(buffer) as { load(): Promise<unknown>; getText(): Promise<{ text: string; numpages: number }> }
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
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer })
    return { text: result.value, format: 'docx' }
  } catch (err) {
    throw Object.assign(
      new Error(`Word 解析失败: ${(err as Error).message}`),
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
