/**
 * template-parser.ts —— 解析范本的篇目层级结构。
 * 支持 TXT/Markdown（按标题行 # ## ### 提取），也复用 mammoth 解析 Word。
 * 输出层级 JSON。
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

export interface OutlineItem {
  level: number   // 1 = 篇, 2 = 章, 3 = 节 ...
  title: string
  children?: OutlineItem[]
}

/**
 * 解析范本文件，返回篇目层级结构。
 */
export async function parseTemplate(filePath: string): Promise<OutlineItem[]> {
  const ext = extname(filePath).toLowerCase()

  if (ext === '.txt' || ext === '.md') {
    return parseFromText(readFileSync(filePath, 'utf-8'))
  }

  if (ext === '.docx') {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer: readFileSync(filePath) })
    return parseFromText(result.value)
  }

  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse')
    const instance = new (PDFParse as any)(readFileSync(filePath))
    await instance.load()
    const data = await instance.getText()
    return parseFromText(data.text)
  }

  throw new Error('范本仅支持 .txt / .md / .docx / .pdf')
}

/**
 * 从纯文本按 Markdown 标题行提取层级。
 * # → level 1, ## → level 2, ### → level 3, 以此类推。
 */
function parseFromText(text: string): OutlineItem[] {
  const lines = text.split('\n')
  const root: OutlineItem[] = []
  const stack: OutlineItem[] = []

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/)
    if (!match) continue

    const level = match[1].length
    const title = match[2].trim()

    // 限制最多 4 层
    if (level > 4) continue

    const item: OutlineItem = { level, title }

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop()
    }

    if (stack.length === 0) {
      root.push(item)
    } else {
      const parent = stack[stack.length - 1]
      if (!parent.children) parent.children = []
      parent.children.push(item)
    }

    stack.push(item)
  }

  return root
}
