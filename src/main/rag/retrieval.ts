/**
 * retrieval.ts —— 本地资料检索（RAG）。
 * 向量检索方案决策（2026-08-05）：本轮不引入向量数据库/外部嵌入依赖，
 * 采用"字符 bigram 相似度 + 全文子串命中"的词法打分检索，纯本地、无网络、
 * 对中文无需分词即可工作；后续可按需扩展向量索引。
 * 检索范围严格限定在用户导入的资料（sourceIds 白名单）内，不引入外部信息。
 */
import Database from 'better-sqlite3'
import type { RetrievedChunk, Source } from '../../shared/types'
import { setDb } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { getSourcesByIds } from '../db/sources'
import { stripStructureNoise } from '../parse/structure-noise'
import { vectorSearch } from './vector-store'
import { vectorToBuffer } from './indexer'

/** 单块最大字符数，超长段落按句切分 */
const CHUNK_MAX = 500

/**
 * 判定"标题行"（Task 3.4.4）：志书/年鉴正文中章节标题常独立成段（如"教育""学前教育""义务教育"），
 * 特征：短（≤12 字）、不以句末/句中标点结尾、不含数字。
 * 这类块只有标题、没有史实。检索查询词命中标题行会拿到极高词法分（短文本 bigram 重叠率满分），
 * 从而把实质正文段落全部挤出 TopN 配额，导致大模型拿到一堆标题、无米下锅（初稿只有寥寥几行）。
 * 分块与检索融合时均跳过，保证材料是真正有内容的正文。
 */
export function isTitleLikeLine(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/[。！？；：，,；]$/.test(t)) return false // 以标点结尾视为正文短句
  if (/[0-9０-９]/.test(t)) return false // 含数字可能是有效数据段
  // 纯标题/词组行：≤12 字的短语，或 ≤20 字且用空格分隔的标题词组（如"开放教育 成人教育 特殊教育"）
  if (t.length <= 12) return true
  if (t.length <= 20 && t.includes(' ')) return true
  return false
}

interface Chunk {
  text: string
  position: string
  /**
   * 该块在**来源正文（`sources.cleaned_text`）**里的字符区间（左闭右开；2026-10-05 用户裁定 P0-2）。
   *
   * 为什么要在**切块时**就算：切块本身就是对来源正文的一次切片，"这段文字在原文的哪个位置"在切的那一刻
   * 就已经确定了。事后拿段落的逐字证据去来源里 `indexOf` 回溯（旧做法）会因为页眉噪声/改写/重复出现而失败，
   * 实测约 2/86 段落拿不到来源位置、只能让用户自己翻页。带上区间后，"段落 → 块 → 页码"全程只做区间比较。
   * 这两字段与 `source_blocks.char_start/char_end` **同一坐标系**（都相对 `cleaned_text`），因此可以直接比较。
   */
  charStart: number
  charEnd: number
}

/**
 * chunkText 结果缓存（按 sourceId + contentHash 键控）：
 * 同一轮生成中 retrieveChunks 会被调用多次（正文检索 / 稳定主题词检索 / 检索预览），
 * 大资料（百万字 PDF）反复切分会造成不必要的 CPU 开销，这里按内容哈希缓存。
 * 无 contentHash 的存量资料不缓存（避免同长度不同内容的碰撞）。
 */
interface ChunkCacheEntry {
  hash: string
  chunks: Chunk[]
}

const chunkCache = new Map<string, ChunkCacheEntry>()

function chunkSourceText(source: Source): Chunk[] {
  if (!source.contentHash) return chunkText(source.cleanedText ?? '')
  const hit = chunkCache.get(source.id)
  if (hit && hit.hash === source.contentHash) return hit.chunks
  const chunks = chunkText(source.cleanedText ?? '')
  chunkCache.set(source.id, { hash: source.contentHash, chunks })
  return chunks
}

/**
 * 按段落切分；超长段落按句读（。！？；）折分成 ≤ CHUNK_MAX 的块。
 *
 * 每块都带上它在原文里的字符区间（见 `Chunk.charStart`）：行内位置由"物理行起点 + 去空白后的偏移"算出，
 * 句读折分时按累计字符数推进，**不做任何事后回溯匹配**。
 */
export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = []
  let lineStart = 0
  let paraIndex = 0
  // 逐物理行扫描：自己在行里取偏移，因此不需要事后 text.indexOf（重复段落也不会串位）
  for (const line of text.split(/\r?\n/)) {
    const raw = line
    const nextLineStart = lineStart + raw.length + 1
    let from = 0
    let to = raw.length
    while (from < to && /\s/.test(raw[from])) from += 1
    while (to > from && /\s/.test(raw[to - 1])) to -= 1
    const base = lineStart
    lineStart = nextLineStart
    if (from >= to) continue
    const p = raw.slice(from, to)
    paraIndex += 1
    const pos = `第${paraIndex}段`
    // 跳过标题行：志书/年鉴中章节标题独立成段，无实质内容（Task 3.4.4）
    if (isTitleLikeLine(p)) continue
    if (p.length <= CHUNK_MAX) {
      chunks.push({ text: p, position: pos, charStart: base + from, charEnd: base + to })
      continue
    }
    // 按句切分
    const sentences = p.split(/(?<=[。！？；;])/).map((s) => s.trim()).filter(Boolean)
    let buf = ''
    let sub = 1
    let cursor = base + from
    let bufStart = cursor
    const flush = (): void => {
      if (buf) {
        chunks.push({ text: buf, position: `${pos}（片段${sub}）`, charStart: bufStart, charEnd: cursor })
        sub += 1
        buf = ''
        bufStart = cursor // 下一块从当前游标起（切分点正好落在句末标点之后）
      }
    }
    for (const s of sentences) {
      // 先判"加上这一句会超限"→ 先把已有内容成块，再让这一句自己起一块
      if (buf.length > 0 && buf.length + s.length > CHUNK_MAX) flush()
      buf += s
      cursor += s.length
    }
    flush()
  }
  return chunks
}

/**
 * 按原始换行划分的粗粒度段落块（Phase 6.1 资料汇编用）：
 * 不再按句/字数做二次切分，避免把一句话从中间截断；超长整段直接保留为一块，
 * 由 AI 细读时再按时间/事实/条目等做更细的切分。仅剔除标题行。
 */
export function chunkParagraphs(text: string): Chunk[] {
  const chunks: Chunk[] = []
  let lineStart = 0
  let paraIndex = 0
  for (const line of text.split(/\r?\n/)) {
    const raw = line
    const nextLineStart = lineStart + raw.length + 1
    let from = 0
    let to = raw.length
    while (from < to && /\s/.test(raw[from])) from += 1
    while (to > from && /\s/.test(raw[to - 1])) to -= 1
    const base = lineStart
    lineStart = nextLineStart
    if (from >= to) continue
    const p = raw.slice(from, to)
    paraIndex += 1
    const pos = `第${paraIndex}段`
    if (isTitleLikeLine(p)) continue
    chunks.push({ text: p, position: pos, charStart: base + from, charEnd: base + to })
  }
  return chunks
}

/** 整段化切片（Phase A/B，方案 C C2）：
 *  先把“被换行打断的物理行”按句合并回逻辑句/段（处理 PDF 排版逐行文本），并过滤明确噪声（页标记/纯页码/目录点线；索引/数据行不滤，交给细读模型）。
 *  段 ≤ maxChars（默认 1000）→ 一块；超长段按句（。！？；;）折成 ≤maxChars 的子块，共享同一 paragraphIndex（“段级保留/剔除”）。
 *  位置记 “第N段” 或 “第N段（片段M）”。 */
export const CHUNK_PARAGRAPH_MAX = 1000
export interface ParagraphChunk {
  text: string
  position: string
  paragraphIndex: number
  /** 该块在来源正文里的字符区间（左闭右开）：与 `source_blocks.char_start/char_end` 同一坐标系（2026-10-05 P0-2） */
  charStart: number
  charEnd: number
}
export function chunkByParagraphs(text: string, maxChars: number = CHUNK_PARAGRAPH_MAX): ParagraphChunk[] {
  return chunkByParagraphsInner(text, maxChars, null)
}

/**
 * 与 `chunkByParagraphs` 完全同口径，但**行起点用调用方给的基准下标**（`baseLineStarts`）。
 *
 * 用途（第一组 ④，2026-10-05）：`stripStructureNoise` 先剔掉目录/版权页/导航尾部等**整行**噪声，
 * 再由本函数切段。如果仍按"剔除后文本"自己算偏移，返回的 `charStart/charEnd` 就不再指向**来源正文**
 * （`sources.cleaned_text` / `source_blocks` 的坐标系），段落定位会整体前移。
 * `baseLineStarts[i]` = 剔除后第 i 行在**来源原文**里的起点（`stripStructureNoise` 返回值里现成带出）。
 */
export function chunkByParagraphsFromBase(
  text: string,
  baseLineStarts?: number[],
  maxChars: number = CHUNK_PARAGRAPH_MAX
): ParagraphChunk[] {
  return chunkByParagraphsInner(text, maxChars, baseLineStarts ?? null)
}

/**
 * **剔结构噪声 + 切段**（第一组 ④，2026-10-05）：本地文件与网页共用一条入口。
 * `kind` 取 `file` / `web`（与 `stripStructureNoise` 同口径）；`charStart/charEnd` 仍指向**来源正文**。
 */
export function chunkByParagraphsNoiseStripped(
  text: string,
  kind: 'file' | 'web',
  maxChars: number = CHUNK_PARAGRAPH_MAX
): { chunks: ParagraphChunk[]; removedChars: number; removals: ReturnType<typeof stripStructureNoise>['removals'] } {
  const stripped = stripStructureNoise(text ?? '', kind)
  return {
    chunks: chunkByParagraphsInner(stripped.text, maxChars, stripped.keptLineStarts),
    removedChars: stripped.removedChars,
    removals: stripped.removals
  }
}

function chunkByParagraphsInner(text: string, maxChars: number, baseLineStarts: number[] | null): ParagraphChunk[] {
  // 方案 C（上下文感知）：两类合并——①【/条目起始行里，把同一条目的多句/多行合并为整条（保留主语/上文，避免“其中…”缺上下文）；
  // ②非【 的普通文本仍按句末标点断段（保证“保守本地闸门”能按段剔除无关内容）。过滤明确噪声（页标记/纯页码/目录点线）。
  // 索引/数据行（如“高中 个 183”）不在此过滤，保留交给细读模型判断。
  //
  // 位置口径（2026-10-05 P0-2）：逐物理行自己算偏移（行起点 + 行内去空白偏移），合并出来的段取首行起点、
  // 末行终点——**不做任何事后 text.indexOf 回溯**，重复段落也不会串位。
  // 2026-10-05 第一组 ④：`baseLineStarts` 提供时，行起点改用它（见 `chunkByParagraphsFromBase`）。
  const lines: string[] = []
  const lineStarts: number[] = []
  /** 每行**去掉首尾空白后**的终点（原文下标；用它算区间就不必反推 joinLine 插进来的空格） */
  const lineEnds: number[] = []
  /** 逐行扫描游标（上一段换行之后的第一个字符） */
  let scan = 0
  let lineNo = 0
  const pushLine = (segFrom: number, segTo: number, segment: string, base: number): void => {
    lines.push(segment.slice(segFrom, segTo))
    lineStarts.push(base + segFrom)
    lineEnds.push(base + segTo)
  }
  for (const m of text.matchAll(/\r?\n+/g)) {
    const at = m.index ?? 0
    const segment = text.slice(scan, at)
    let segFrom = 0
    let segTo = segment.length
    while (segFrom < segTo && /\s/.test(segment[segFrom])) segFrom += 1
    while (segTo > segFrom && /\s/.test(segment[segTo - 1])) segTo -= 1
    pushLine(segFrom, segTo, segment, baseLineStarts ? (baseLineStarts[lineNo] ?? scan) : scan)
    /*
     * 行号必须按**换行符个数**前进，不能按"分段次数"前进（2026-10-06 修，⑤ 落地时用真实库抽查发现）：
     * `stripStructureNoise` 的 `keptLineStarts` 是**逐行**记账的——空行也是一个"保留行"、也占一个下标；
     * 而本函数的 `/\r?\n+/` 会把连续换行（正文里极常见的空行分段）**并成一次匹配**。
     * 旧实现每次只 +1，于是每遇到一处空行，`lineNo` 就比真实行号小 1，`baseLineStarts[lineNo]` 取到**上一行**
     * 的起点 → `charStart` 一路向前漂（实测某网页来源抽查 8 段只有 1 段坐标正确、第 2 段直接指到上一行的
     * "申报条件"）。按换行符个数前进即与 `keptLineStarts` 的记账完全一致。
     */
    lineNo += Math.max(1, m[0].match(/\n/g)?.length ?? 0)
    scan = at + m[0].length
  }
  {
    const segment = text.slice(scan)
    let segFrom = 0
    let segTo = segment.length
    while (segFrom < segTo && /\s/.test(segment[segFrom])) segFrom += 1
    while (segTo > segFrom && /\s/.test(segment[segTo - 1])) segTo -= 1
    pushLine(segFrom, segTo, segment, baseLineStarts ? (baseLineStarts[lineNo] ?? scan) : scan)
  }
  const merged: { text: string; charStart: number; charEnd: number }[] = []
  let buf = ''
  let bufStart = 0
  let bufEnd = 0
  let inEntry = false
  /**
   * 本条目的**正文**已经合并了几行（不含【…】标题行本身）。
   *
   * 为什么需要这个计数：条目首行常以句末标点结尾（`【华侨中学新疆高中班】…预科班 39 人。`），
   * 而它的正文往往还有下一行（`在 2014 年高考中，首届 37 位新疆班毕业生全部被录取。`）。
   * 只按"`buf` 以句末标点结尾就不再合并"会把这条正文切掉（旧实现就是这样，与"整条合并"的设计意图不符）。
   * 允许再合并**一行**，既保住条目的完整上下文，又不会把后面独立成段的句子吞进来。
   */
  let entryMerged = 0
  const flush = (): void => {
    if (buf) {
      merged.push({ text: buf, charStart: bufStart, charEnd: bufEnd })
      buf = ''
    }
    entryMerged = 0
  }
  lines.forEach((L, li) => {
    if (!L) { flush(); inEntry = false; return }        // 空行 = 段边界
    if (isPdfNoiseLine(L)) return                       // 噪声直接跳过
    if (startsNewEntry(L)) {                            // 新条目：保留头部并整段合并
      flush()
      buf = L
      bufStart = lineStarts[li]
      bufEnd = lineEnds[li]
      inEntry = true
      return
    }
    if (isTitleLikeLine(L)) { flush(); inEntry = false; return }       // 副标题/章节标题 = 段边界（丢弃）
    if (!buf) { buf = L; bufStart = lineStarts[li]; bufEnd = lineEnds[li]; inEntry = false; return }
    if (inEntry && entryMerged < 1) {                   // 条目正文（最多再一行）
      buf = joinLine(buf, L)
      bufEnd = lineEnds[li]
      entryMerged += 1
      if (endsSentencePunct(buf)) flush()
      return
    }
    if (endsSentencePunct(buf)) {                       // 普通文本：句末标点处断段（保留闸门粒度）
      flush()
      buf = L
      bufStart = lineStarts[li]
      bufEnd = lineEnds[li]
    } else {
      buf = joinLine(buf, L)
      bufEnd = lineEnds[li]
    }
  })
  flush()

  const out: ParagraphChunk[] = []
  merged.forEach((p, i) => {
    const pos = `第${i + 1}段`
    if (p.text.length <= maxChars) {
      out.push({ text: p.text, position: pos, paragraphIndex: i, charStart: p.charStart, charEnd: p.charEnd })
      return
    }
    const sentences = p.text.split(/(?<=[。！？；;])/).map((s) => s.trim()).filter(Boolean)
    let b = ''
    let sub = 1
    let cursor = p.charStart
    let bStart = cursor
    const flushSub = (): void => {
      if (b) {
        out.push({ text: b, position: `第${i + 1}段（片段${sub}）`, paragraphIndex: i, charStart: bStart, charEnd: cursor })
        sub += 1
        b = ''
        bStart = cursor
      }
    }
    for (const s of sentences) {
      // 先判"加上这一句会超限"→ 先把已有内容成块，再让这一句自己起一块（与旧行为一致）
      if (b.length > 0 && b.length + s.length > maxChars) flushSub()
      b += s
      cursor += s.length
    }
    flushSub()
  })
  return out
}

/** 明确噪声：PDF 页标记 / 纯数字页码 / 目录点线。索引/数据行（含文本+数字）不在此过滤。 */
function isPdfNoiseLine(text: string): boolean {
  const t = text.trim()
  if (/^--\s*\d+(\s+of\s+\d+)?\s*--$/.test(t)) return true
  if (/^[\s0-9０-９]+$/.test(t)) return true
  if (/[⋯…·]{3,}/.test(t)) return true
  return false
}

/** 是否以句末标点收尾（视为一句完整）。 */
function endsSentencePunct(text: string): boolean {
  return /[。！？；]$/.test(text.trim())
}

/** 拼接相邻行：边界涉及数字/拉丁字母时补一个空格（避免 “2人”“2014年”粘连），否则直接拼接。 */
function joinLine(cur: string, next: string): string {
  if (/[0-9A-Za-z]$/.test(cur) || /^[0-9A-Za-z]/.test(next)) return cur + ' ' + next
  return cur + next
}

/** 是否为新条目/章节起点（决定在“整条目合并”时断段）：【、〔、［、（、《、◆、■，或 “一、/二、”/“1、/1.)” 等编号式小标题。 */
function startsNewEntry(text: string): boolean {
  const t = text.trim()
  if (/^[【〔［（《◆■]/.test(t)) return true
  if (/^[一二三四五六七八九十]+、/.test(t)) return true
  return /^\d+[、.)．]/.test(t)
}

/** 字符 bigram（中文无需分词，用相邻字符对近似文本相似度） */
export function bigrams(s: string): string[] {
  const chars = Array.from(s.replace(/\s+/g, ''))
  const out: string[] = []
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1])
  return out
}

export function dice(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const common = a.filter((x) => b.includes(x)).length
  return (2 * common) / (a.length + b.length)
}

/** 块与查询的相似度打分（queryBigrams/queryTerms 为预计算缓存，缺省时自行计算，保证纯函数可测） */
export function scoreChunk(
  query: string,
  chunk: string,
  sourceTitle: string,
  queryBigrams?: string[],
  queryTerms?: string[]
): number {
  const q = query.trim().toLowerCase()
  const t = chunk.trim().toLowerCase()
  if (!q || !t) return 0

  const qBigrams = queryBigrams ?? bigrams(q)
  const terms = queryTerms ?? q.split(/\s+/).filter(Boolean)

  let score = 0
  if (t.includes(q)) score += 100 + q.length // 完整查询命中
  // 查询含空格时按词分别命中
  for (const term of terms) {
    if (term.length > 1 && t.includes(term)) score += 20
  }
  score += dice(qBigrams, bigrams(t)) * 60 // bigram 重叠
  if (sourceTitle.toLowerCase().includes(q)) score += 20 // 标题相关加成
  return Math.round(score)
}

export interface RetrieveParams {
  sourceIds: string[]
  query: string
  /** 查询向量（由 embedding 模型生成）；提供时启用语义补充检索 */
  queryVector?: number[]
  /** 向量余弦保留阈值（Task 3.4.7）：低于视为"非常确定无关"；词法 score>0 的块不受此限制 */
  vecMinScore?: number
}

/**
 * 过滤式检索（Task 3.4.7）：不做 TopN 截断、不做每资料配额，只剔除"非常确定无关"的段落。
 * 保留规则：词法相关（scoreChunk > 0，即与标题有任何字面/字符对关联）或 向量相关（余弦 ≥ vecMinScore）的段落全部保留，
 * 标题行一律剔除。输出按来源、原文顺序组织（向量补充块追加在后）。
 * 目的：把粗筛后资料中尽可能多的有效内容完整供给大模型，篇幅由材料内容自然决定。
 */
export function retrieveChunks(params: RetrieveParams): RetrievedChunk[] {
  const { sourceIds, query, queryVector, vecMinScore = 0.3 } = params
  const q = query.trim()
  if (!q || sourceIds.length === 0) return []

  const sources = getSourcesByIds(sourceIds)
  const sourceById = new Map(sources.map((s) => [s.id, s]))
  const out: RetrievedChunk[] = []
  const seen = new Set<string>()
  // 查询侧 bigram/词条只算一次，供全部块复用（大资料量下显著省时）
  const qBigrams = bigrams(q)
  const qTerms = q.split(/\s+/).filter(Boolean)

  // 词法路：score > 0 保留（score === 0 = 与标题完全无字面/字符对关联 → 非常确定无关，剔除）
  // 顺手登记"position → 字符区间"：向量路的块来自历史索引，没有区间时可据此按位置回填（只在本次已切出的块里查，不查库）
  const rangeByPosition = new Map<string, { charStart: number; charEnd: number }>()
  for (const s of sources) {
    for (const c of chunkSourceText(s)) {
      const score = scoreChunk(q, c.text, s.title, qBigrams, qTerms)
      const key = `${s.id}|${c.position}`
      if (!rangeByPosition.has(key)) rangeByPosition.set(key, { charStart: c.charStart, charEnd: c.charEnd })
      if (score <= 0) continue
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        sourceId: s.id,
        sourceTitle: s.title,
        position: c.position,
        text: c.text,
        score,
        sourceKind: s.kind,
        sourcePublishedAt: s.publishedAt,
        charStart: c.charStart,
        charEnd: c.charEnd
      })
    }
  }

  // 向量路：全量余弦，≥ vecMinScore 的块并入（补充"字面无关但语义相关"的段落）
  if (queryVector && queryVector.length > 0) {
    const hits = vectorSearch(queryVector, sourceIds, 0)
    for (const h of hits) {
      if (h.score < vecMinScore) continue
      if (isTitleLikeLine(h.text)) continue
      const key = `${h.sourceId}|${h.position}`
      if (seen.has(key)) continue
      seen.add(key)
      const srcTitle = sourceById.get(h.sourceId)?.title ?? ''
      const src = sourceById.get(h.sourceId)
      const range = rangeByPosition.get(key)
      out.push({
        sourceId: h.sourceId,
        sourceTitle: srcTitle,
        position: h.position,
        text: h.text,
        score: Math.round(h.score * 100), // 向量补入块的展示分（0-100 量纲）
        sourceKind: src?.kind,
        sourcePublishedAt: src?.publishedAt,
        // 历史索引块与当前切块对得上就带上区间；对不上就如实缺省（落锚点时回退逐字匹配）
        charStart: range?.charStart,
        charEnd: range?.charEnd
      })
    }
  }

  return out
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it, beforeAll, afterAll } = import.meta.vitest

  let db: Database.Database
  beforeAll(() => {
    db = new Database(':memory:')
    setDb(db)
    runMigrations(db)
  })
  afterAll(() => db.close())

  function insertSource(id: string, title: string, cleanedText: string): void {
    db.prepare(
      `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', ?, ?, 'ready')`
    ).run(id, title, cleanedText)
  }

  describe('RAG retrieval (Task 3.2)', () => {
    it('chunks text by paragraphs', () => {
      const chunks = chunkText('第一段内容。\n\n第二段内容，这一段很长' + '。'.repeat(600))
      expect(chunks[0].text).toContain('第一段')
      expect(chunks[0].position).toBe('第1段')
      expect(chunks.length).toBeGreaterThanOrEqual(2)
    })

    /*
     * 2026-10-05 用户裁定（P0-2）：切块时**就算出字符区间**，作为"这一段在来源正文的哪里"的生成期依据。
     * 不变量：区间取回原文 = 块文字（补上块内被 joinLine 插进的分隔空格），且与 `source_blocks` 同坐标系。
     */
    it('chunkText 给每块带上字符区间：区间取回原文与块文字一致（含句中折分）', () => {
      const text = '前言。\n\n' + '甲'.repeat(501) + '。乙。\n\n后记。'
      const chunks = chunkText(text)
      const a = chunks.find((c) => c.text.startsWith('甲'))!
      // 首块：从"甲"开始，到第一句句末标点为止（500 字上限 + 句读吸附）
      expect(text.slice(a.charStart, a.charEnd)).toBe(a.text)
      expect(a.charStart).toBe(text.indexOf('甲'))
      // 第二块（片段）：起点接着上一块的终点，取回原文同样一致
      const b = chunks.find((c) => c.text.includes('乙'))!
      expect(b.charStart).toBe(a.charEnd)
      expect(text.slice(b.charStart, b.charEnd)).toBe(b.text)
      expect(b.text).toContain('乙。')
    })

    it('chunkText / chunkParagraphs 的区间跳过行首空白且与段落一一对应', () => {
      const text = '  第一段。  \n第二段。\n\n第三段。'
      const lineChunks = chunkText(text)
      expect(lineChunks.map((c) => [c.position, c.text])).toEqual([
        ['第1段', '第一段。'],
        ['第2段', '第二段。'],
        ['第3段', '第三段。']
      ])
      for (const c of lineChunks) expect(text.slice(c.charStart, c.charEnd)).toBe(c.text)
      expect(lineChunks[0].charStart).toBe(text.indexOf('第一段'))
    })

    /*
     * 2026-10-06（⑤ 落地时用**真实库**抽查发现的既有坐标缺陷，回归用例）：
     * `stripStructureNoise` 的 `keptLineStarts` 逐行记账（空行也占一个下标），而切段器用 `/\r?\n+/`
     * 一次吃掉整串换行——旧实现按"分段次数"递增行号，于是**每遇到一处空行，行号就少 1**、
     * `baseLineStarts[lineNo]` 取到上一行的起点，`charStart` 一路向前漂（真实网页抽查 8 段仅 1 段正确）。
     * 不变量：给的 `baseLineStarts` 正确时，`charStart/charEnd` 取回**原文**必须等于段文字（忽略 joinLine 插入的空格）。
     */
    it('chunkByParagraphsFromBase 遇空行后行号仍与 baseLineStarts 对齐（坐标不向前漂）', () => {
      const src = ['甲甲甲甲甲甲甲甲甲甲。', '', '乙乙乙乙乙乙乙乙乙乙。', '丙丙丙丙丙丙丙丙丙丙。'].join('\n')
      const st = stripStructureNoise(src, 'web')
      const chunks = chunkByParagraphsFromBase(st.text, st.keptLineStarts)
      expect(chunks.map((c) => c.text)).toEqual(['甲甲甲甲甲甲甲甲甲甲。', '乙乙乙乙乙乙乙乙乙乙。', '丙丙丙丙丙丙丙丙丙丙。'])
      for (const c of chunks) expect(src.slice(c.charStart, c.charEnd)).toBe(c.text)
      // 第二段起点必须落在"乙"上——旧实现在这里会指到上一段的尾部（空行使行号少 1）
      expect(chunks[1].charStart).toBe(src.indexOf('乙'))
      expect(chunks[2].charStart).toBe(src.indexOf('丙'))
    })

    it('chunkByParagraphs 合并行时区间覆盖整段（首行起点 → 末行终点）', () => {      const text = '【概况】普通高中录取 2599 人，参加\n高考学生 2940 人。\n\n第二段内容。'
      const chunks = chunkByParagraphs(text)
      const first = chunks[0]
      // 合并后的段：区间从"【"起，到"人。"之后止（不含换行与段间空行）
      expect(text.slice(first.charStart, first.charEnd)).toBe('【概况】普通高中录取 2599 人，参加\n高考学生 2940 人。')
      expect(first.text).toBe('【概况】普通高中录取 2599 人，参加高考学生 2940 人。')
      const second = chunks[1]
      expect(text.slice(second.charStart, second.charEnd)).toBe('第二段内容。')
    })

    it('chunkByParagraphs 超长段落折分：子块区间首尾相接、取回原文一致', () => {      const sentence = '园所数量逐年增加。'
      const long = sentence.repeat(30) // 240 字，按 100 字上限折成 3 块
      const full = '教育\n\n' + long
      const chunks = chunkByParagraphs(full, 100)
      expect(chunks.length).toBe(3)
      // 区间取回**全文**必须与块文字逐字一致（这就是"生成期记录的区间"的可信度来源）
      for (const c of chunks) expect(full.slice(c.charStart, c.charEnd)).toBe(c.text)
      // 第一块从正文首字起（标题行"教育"被丢弃，但它的 4 个字符仍占着原文位置）
      expect(chunks[0].charStart).toBe(full.indexOf('园所'))
      for (let i = 1; i < chunks.length; i++) expect(chunks[i].charStart).toBe(chunks[i - 1].charEnd)
      // 每块都是整句，不把句子切一半
      for (const c of chunks) expect(c.text.endsWith('。')).toBe(true)
    })

    it('chunkParagraphs keeps whole original paragraphs without splitting sentences (Phase 6.1)', () => {
      const paras = ['第一段完整的一句话，很长很长也不截断。', '教育', '', '第二段也完整，包含超过 500 字的连续文字。' + '何况这是一句。'.repeat(300)]
      const chunks = chunkParagraphs(paras.join('\n'))
      // 跳过标题行
      expect(chunks.some((c) => c.text === '教育')).toBe(false)
      // 原始段落作为一整块返回，不按句/字数截断
      expect(chunks.some((c) => c.text.startsWith('第一段完整的一句话'))).toBe(true)
      expect(chunks.some((c) => c.text.endsWith('何况这是一句。'))).toBe(true)
      expect(chunks.some((c) => c.position.includes('片段'))).toBe(false)
    })

    it('chunkByParagraphs splits over-long paragraph into pieces sharing paragraphIndex (Phase A/B 整段化)', () => {
      const long = '学前教育蓬勃发展。' + '园所数量逐年增加，师资队伍不断壮大，办园质量稳步提升。'.repeat(30)
      const chunks = chunkByParagraphs('教育\n\n' + long, 100)
      // 跳过标题行
      expect(chunks.some((c) => c.text === '教育')).toBe(false)
      // 每一块长度 ≤ 上限
      expect(chunks.every((c) => c.text.length <= 100)).toBe(true)
      // 超长段被拆成多块，且都共享同一个 paragraphIndex（同一段）
      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.every((c) => c.paragraphIndex === chunks[0].paragraphIndex)).toBe(true)
      // 位置含“片段M”
      expect(chunks.every((c) => c.position.includes('片段'))).toBe(true)
    })

    it('chunkByParagraphs merges line-broken fragments and filters page/number noise (方案 C C2)', () => {
      const text = [
        '-- 1 of 371 --',
        '12',
        '【概况】普通高中录取 2599 人，参加',
        '高考学生 2940 人（含复读生及职专生），其中本一上线 527 人，被清华大学录取 2',
        '人，被香港中文大学录取 1 人，保送复旦大学等重点名校 17 人。',
        '【达标高中建设】长乐二中、七中晋级“省二级达标校”。'
      ].join('\n')
      const chunks = chunkByParagraphs(text)
      // 明确噪声被过滤
      expect(chunks.some((c) => c.text.includes('-- 1 of 371 --'))).toBe(false)
      expect(chunks.some((c) => /^\d+$/.test(c.text))).toBe(false)
      // 被换行打断的句子还原为完整内容（不再有“被普通高/录取 2”这类句中截断）
      const first = chunks.find((c) => c.text.includes('普通高中录取'))!
      expect(first.text).toContain('被清华大学录取 2 人，被香港中文大学录取 1 人')
      expect(first.text).toContain('重点名校 17 人。')
      // 条目起始（【达标高中建设】）开启新段
      const second = chunks.find((c) => c.text.includes('达标高中建设'))!
      expect(second.text).not.toContain('普通高中录取')
    })

    it('chunkByParagraphs keeps index/data rows (不滤索引/数据行，交给模型)', () => {
      const text = ['【数据】2015 年全区普通高中招生。', '高中个 183', '高中个 2645'].join('\n')
      const chunks = chunkByParagraphs(text)
      const joined = chunks.map((c) => c.text).join('\n')
      expect(joined).toContain('高中个 183')
      expect(joined).toContain('高中个 2645')
    })

    it('chunkByParagraphs keeps a whole entry even with sentence-final punctuation inside (方案C整段上下文)', () => {      const text = [
        '【华侨中学新疆高中班】2014 年，长乐华侨中学新疆高中班有 4 个班级，学生 146 人，其中预科班 39 人。',
        '在 2014 年高考中，首届 37 位新疆班毕业生全部被录取。',
        '【达标高中建设】长乐二中、七中晋级“省二级达标校”。'
      ].join('\n')
      const chunks = chunkByParagraphs(text)
      // 第一条目（含两句、句中有句号）保持为一个整段，不因句号被拆开
      const entry = chunks.find((c) => c.text.includes('华侨中学新疆高中班'))!
      expect(entry.text).toContain('其中预科班 39 人。在 2014 年高考中')
      expect(entry.text).toContain('全部被录取。')
      // 第二条目独立成段
      const second = chunks.find((c) => c.text.includes('达标高中建设'))!
      expect(second.text).toContain('长乐二中、七中晋级')
      expect(second.text).not.toContain('华侨中学')
    })

    it('keeps all lexically related paragraphs and drops definitely-unrelated ones (Task 3.4.7)', () => {
      insertSource(
        's1',
        '新区经济发展概况',
        '2019年，新区实现地区生产总值120亿元。\n招商引资项目落地，产业规模持续扩大。'
      )
      insertSource(
        's2',
        '某区教育发展报告',
        '小学教育适龄儿童入学率达到99%。\n教师队伍建设不断加强。'
      )

      const chunks = retrieveChunks({ sourceIds: ['s1', 's2'], query: '新区经济发展' })
      // s2 与"新区经济发展"无任何字面/字符对关联 → 非常确定无关，整份剔除
      expect(chunks.every((c) => c.sourceId === 's1')).toBe(true)
      // s1 的两段全部保留（score > 0），按原文顺序，不受 TopN 截断
      expect(chunks.map((c) => c.position)).toEqual(['第1段', '第2段'])
      expect(chunks[0].sourceTitle).toBe('新区经济发展概况')
    })

    it('returns nothing when no paragraph is related (no external info)', () => {
      const chunks = retrieveChunks({ sourceIds: ['s2'], query: '新区经济发展' })
      // 无关材料的所有段落都被过滤 → 无候选
      expect(chunks).toHaveLength(0)
    })

    it('returns empty for empty query or empty scope', () => {
      expect(retrieveChunks({ sourceIds: ['s1'], query: '' })).toHaveLength(0)
      expect(retrieveChunks({ sourceIds: [], query: 'x' })).toHaveLength(0)
    })

    it('vector path supplements semantically related paragraphs missed lexically (Task 3.4.7)', () => {
      insertSource('s3', '某年度报告', '适龄儿童入学率稳步提升，教师队伍不断壮大，教学设施持续改善。')
      // 预置向量索引（queryVector 与之高度相似）
      db.prepare(
        `INSERT INTO chunk_embeddings (id, source_id, chunk_text, position, embedding, model_id, created_at)
         VALUES ('c3', 's3', '适龄儿童入学率稳步提升，教师队伍不断壮大，教学设施持续改善。', '第1段', ?, 'test', datetime('now'))`
      ).run(vectorToBuffer([1, 0, 0, 0]))

      // 纯词法：标题与正文均无"教育"字样 → 词法分 0，无候选
      const lexOnly = retrieveChunks({ sourceIds: ['s3'], query: '教育事业发展' })
      expect(lexOnly).toHaveLength(0)
      // 向量路：余弦 1 ≥ vecMinScore → 语义相关的段落被补充保留
      const hybrid = retrieveChunks({ sourceIds: ['s3'], query: '教育事业发展', queryVector: [1, 0, 0, 0] })
      expect(hybrid).toHaveLength(1)
      expect(hybrid[0].sourceId).toBe('s3')
      expect(hybrid[0].text).toContain('入学率')
    })

    it('skips title-like lines in chunking so headings never fill material quota (Task 3.4.4)', () => {
      const chunks = chunkText('教育\n\n学前教育。\n\n义务教育\n\n开放教育 成人教育 特殊教育\n\n2021年，全区共有各级各类学校212所，在校生117679人。')
      const texts = chunks.map((c) => c.text)
      // 无句末标点的短标题行与空格分隔的标题词组行被过滤
      expect(texts).not.toContain('教育')
      expect(texts).not.toContain('义务教育')
      expect(texts).not.toContain('开放教育 成人教育 特殊教育')
      // 带句号的短句与有内容的正文保留
      expect(texts).toContain('学前教育。')
      expect(texts).toContain('2021年，全区共有各级各类学校212所，在校生117679人。')
    })

    it('excludes vector-only title-like hits in retrieval (Task 3.4.4)', () => {
      // 历史向量库中残留标题行块"教育"（词法路已无该块）
      insertSource('s4', '某教育报告', '2021年，全区共有各级各类学校212所。')
      db.prepare(
        `INSERT INTO chunk_embeddings (id, source_id, chunk_text, position, embedding, model_id, created_at)
         VALUES ('c4', 's4', '教育', '第1段', ?, 'test', datetime('now'))`
      ).run(vectorToBuffer([1, 0, 0, 0]))
      const hits = retrieveChunks({ sourceIds: ['s4'], query: '教育事业发展', queryVector: [1, 0, 0, 0] })
      expect(hits.some((c) => c.text === '教育')).toBe(false)
      expect(hits.every((c) => !isTitleLikeLine(c.text))).toBe(true)
    })

    it('keeps all related paragraphs without TopN cap (Task 3.4.7)', () => {
      // 一个资料内多个段落均与标题相关 → 全部保留，不设数量上限
      insertSource(
        's5',
        '教育事业发展综述',
        '第一段涉及教育工作概况。\n第二段继续安排教育工作。\n第三段落实教育经费。\n第四段推进教师队伍建设。\n第五段部署秋季开学工作。'
      )
      const chunks = retrieveChunks({ sourceIds: ['s5'], query: '教育' })
      expect(chunks).toHaveLength(5)
      expect(chunks.map((c) => c.position)).toEqual(['第1段', '第2段', '第3段', '第4段', '第5段'])
    })

    it('drops vector hits below vecMinScore (definitely unrelated, Task 3.4.7)', () => {
      insertSource('s6', '无关文档', '与主题完全无关的内容，讲的是天气变化。')
      db.prepare(
        `INSERT INTO chunk_embeddings (id, source_id, chunk_text, position, embedding, model_id, created_at)
         VALUES ('c6', 's6', '与主题完全无关的内容，讲的是天气变化。', '第1段', ?, 'test', datetime('now'))`
      ).run(vectorToBuffer([0, 1, 0, 0]))
      // 词法分 0（无"教育"字样），向量余弦 0 < 0.3 → 非常确定无关，剔除
      const hits = retrieveChunks({ sourceIds: ['s6'], query: '教育', queryVector: [1, 0, 0, 0] })
      expect(hits).toHaveLength(0)
    })
  })
}
