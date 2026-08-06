/**
 * source-title-tags.ts —— 标签嵌入标题。
 * 格式：`[tag:标签名] [tag:标签名] ...  原标题`
 * 后端在 tag 增删改时重建 sources.title；前端解析标题直接渲染标签 chips。
 * 兼容旧格式 `[tag:标签名|颜色hex]`（颜色功能已移除，旧数据仅取标签名）。
 */
import type { Tag } from '../shared/types'

/* 匹配标题开头的连续 [tag:...] 前缀 */
const TAG_PREFIX_RE = /^(?:\[tag:[^\]\r\n]+\]\s*)+/

function encodeName(name: string): string {
  return name.replace(/%/g, '%25').replace(/\|/g, '%7C').replace(/\]/g, '%5D')
}

function decodeName(value: string): string {
  return value.replace(/%7C/gi, '|').replace(/%5D/gi, ']').replace(/%25/gi, '%')
}

/** 剥离标题中的标签前缀，返回纯净标题 */
export function stripSourceTitleTags(title: string): string {
  return title.replace(TAG_PREFIX_RE, '').trim()
}

/** 构建带标签前缀的标题 */
export function buildTaggedSourceTitle(title: string, tags: Tag[]): string {
  const clean = stripSourceTitleTags(title)
  if (tags.length === 0) return clean
  const prefix = tags
    .map((t) => `[tag:${encodeName(t.name)}]`)
    .join(' ')
  return `${prefix} ${clean}`
}

/** 前端解析标题中的标签 */
export interface ParsedSourceTag {
  name: string
}

export interface ParsedSourceTitle {
  tags: ParsedSourceTag[]
  cleanTitle: string
}

export function parseSourceTitleTags(title: string): ParsedSourceTitle {
  const match = title.match(TAG_PREFIX_RE)
  if (!match) return { tags: [], cleanTitle: title }

  const prefix = match[0]
  const tags: ParsedSourceTag[] = []
  const re = /\[tag:([^\]]+)\]/g
  let m = re.exec(prefix)
  while (m !== null) {
    const raw = m[1].trim()
    // 兼容旧格式 `[tag:name|color]`：仅取 `|` 之前的标签名
    const name = decodeName(raw.includes('|') ? raw.slice(0, raw.indexOf('|')) : raw)
    if (name) tags.push({ name })
    m = re.exec(prefix)
  }
  return { tags, cleanTitle: title.slice(prefix.length).trim() }
}
