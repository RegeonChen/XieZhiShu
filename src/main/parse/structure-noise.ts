/**
 * structure-noise.ts —— **结构性排版垃圾剔除**（第一组 ④，2026-10-05）。
 *
 * 用户口径：删的不是材料，是**排版噪声**；"**宁可漏剔、不可错剔**"。因此本模块的每一类规则都要求
 * "成块、强特征"，且**只按整行删除**（绝不逐段改写、绝不删库里的原始文本——调用方拿返回的 `text` 用，
 * 库里 `sources.cleaned_text` 一字不动）。
 *
 * 四类规则（真实库实测的样本与收益见 `.dbg/backtest.test.ts` 的 G 段）：
 *   ① **年鉴目录行**：连续 ≥3 行"标题…页码"（页码 1–2000）。实测年鉴 2023/2024/2025 分别命中
 *      1472 / 1466 / 1586 行、共约 12.2 万字。现有 `isTitleLikeLine` 判据要求"无数字"，
 *      而目录行**含页码数字**，所以整块逃过了旧判据（这就是它一直留在材料里的原因）。
 *   ② **版权页 / 编委会 / 编写人员名单**：`书名/编者/主编/审/社址/邮编/ISBN/印张/开本/版次/定价` 等版记特征，
 *      以及"人名 + 职务后缀"式名单行。
 *      ⚠ 口径曾经过一次收紧：初版按"行内含关键词"匹配，结果把年鉴正文里的**任命/免职时间线**
 *      （`同日 \t省人大常委会副主任`、`9 日 \t市人大常委会主任张忠带队`）误剔——关键词必须**位于行首**
 *      （前 4 个非空白字符内）才算版记。这正是"宁可漏剔"的体现。
 *   ③ **网页尾部导航块**：`相关新闻 / 相关推荐 / 热门阅读 / 猜你喜欢 / 更多>>` —— 从该处**整段截断**。
 *      实测 10,876 篇缓存正文里 6,911 篇（63.5%）带这类尾部，共 682 万字（占 39%）；
 *      抽查确认截断点之后**全部是侧栏列表**（相关新闻 + 各栏目"更多>>"标题串），正文都在它之前。
 *   ④ **页眉页脚残留**：`【字号：大 中 小】`、`来源：/发布时间：/责任编辑：` 等短行；
 *      以及**纯短标题串**（连续 ≥3 行、无句末标点、无数字）——只对网页套用（年鉴的短行多为章节层级，已有旧判据处理）。
 *
 * 返回的 `removedLines` 是**原始行号集合**，供调用方在切块时保持 `charStart/charEnd` 与来源正文同坐标系
 * （`chunkByParagraphsFromBase`，见 `rag/retrieval.ts`）——这也是本模块**不自己改写文本区间**的原因。
 */

/** 材料类别：年鉴/本地文件与网页的噪声形态不同，规则集不同 */
export type StructureNoiseKind = 'web' | 'file'

export interface StructureNoiseRemoval {
  kind: 'toc' | 'imprint' | 'nav-tail' | 'page-chrome' | 'bare-title-run' | 'masthead-run'
  reason: string
  /** 被删的**原始物理行**内容（供诊断与"删掉了什么"取证） */
  lines: string[]
}

export interface StructureNoiseResult {
  /** 剔除后的文本（行以 `\n` 连接；只删整行，不改写任何一行） */
  text: string
  /** 删除字符数（= 原文字数 − 剔除后字数；含被删行的换行符，用于统计收益） */
  removedChars: number
  /**
   * 剔除后的每一行在**原文**里的起点下标（与 `text` 按 `\n` 切开的行一一对应）。
   * 为什么需要它：段落/来源定位（`source_blocks`、锚点）都按"来源正文字符区间"工作，
   * 剔掉若干行以后 `chunkByParagraphs` 自己算出来的区间会整体前移；带上这个基准数组，
   * `chunkByParagraphsFromBase` 就能给出**仍然指向来源原文**的准确区间。
   */
  keptLineStarts: number[]
  removals: StructureNoiseRemoval[]
}

/** 目录行：可选前导空白 + 标题（≤40 字）+ 引导符/空白 + 页码（1–2000） */
const TOC_LINE_RE = /^[\s\S]{1,40}?[\s\u3000]*(\d{1,4})[\s\u3000]*$/
/** 目录行的"引导符"：点线 / 制表符 / 全角空格 / 连续半角空格 / PDF 抽出来的退格填充 */
const TOC_LEADER_RE = /[.·…⋯\t\u3000\b]{2,}|\s{2,}/
/** 目录块最少连续行数（单行"标题 + 页码"在正文里可能是"数据行"，3 行连续才判为目录） */
const TOC_MIN_RUN = 3
/** 页码合理范围 */
const TOC_PAGE_MIN = 1
const TOC_PAGE_MAX = 2000

/** 强特征：行首命中即判为版记 */
const IMPRINT_HEAD_STRONG = ['社址', '邮编', '印张', '开本', '版次', '印次', '定价', '出版发行', '字数', '书号', '书名', '编者', '编审', 'ISBN']
/** 弱特征：既可能是版记（`主 编：陈学林`），也可能是正文（`委员…`、`主任…`），需要第二个信号 */
const IMPRINT_HEAD_WEAK = ['主编', '主任', '委员', '编纂', '出版']
/** 版记行里出现的标点（关键词被制表符/空格拆开时会带上这些） */
const IMPRINT_HEAD_SEP_RE = /[\s\u3000:：.、]+/
/** 正文句末标点：带它的行是材料，不是版记 */
const SENTENCE_END_RE = /[。！？；]/
/** 正文特征：年份、条目号【】——`副主任：陈 禺` 是版记，`同日 \t省人大常委会副主任` 是正文时间线 */
const NARRATIVE_RE = /(\d{4}\s*年|[【〔［])/

/** 网页尾部导航块的**独占行**（整行就是这几个词才算，避免"相关新闻"出现在正文句子里被误截断） */
const NAV_TAIL_RE = /^\s*(相关新闻|相关推荐|相关阅读|相关文章|相关链接|热门阅读|猜你喜欢|推荐阅读|热文排行|更多\s*>>)\s*[:：]?\s*$/
/** 页眉页脚 / 站点残留：整行短特征 */
const PAGE_CHROME_LINE_RE = /^\s*(【?\s*字号\s*[:：][^】]*】?|来源\s*[:：].{0,40}|发布时间\s*[:：].{0,30}|责任编辑\s*[:：].{0,20}|作者\s*[:：].{0,20}|分享到\s*[:：]?.{0,20}|打印本页|关闭窗口)\s*$/
/** 人名 + 职务后缀（名单行）：`李 旭 \t长乐区委区直机关工委常务副书记` */
const TITLE_SUFFIX_RE = /(书记|区长|主任|主席|常委|委员|部长|局长|镇长|乡长|校长|院长|检察长|庭长|科长|处长|主编|编审|总编辑|社长|秘书长|队长|站长|所长|厂长|经理|董事长|理事长|组长|股长|馆长|台长|村长)$/
/** 名单行长度上限 / 连续行数下限 */
const MASTHEAD_MAX_CHARS = 34
const MASTHEAD_MIN_RUN = 3
/**
 * 纯短标题串：单行长度上限（`BARE_TITLE_MAX_CHARS`）与**连续行数下限**（`BARE_TITLE_MIN_RUN`）。
 *
 * ⚠ `BARE_TITLE_MIN_RUN` 的**语义范围**（2026-10-05 用户裁定后放宽）：
 * 它**只对"导航尾部区"（`nav-tail` 命中点及其之后）生效**——正文区（导航尾部之前）**一律不套用**这条规则。
 * 原因：真实库实测，正文区里有 **324 行 / 5,196 字**会命中它（图片说明、报刊式短行，如"　　记者 蒋升阳 颜 珂 刘晓宇"），
 * 那些是**材料**；用户硬前提是"**有关的不被筛掉**"，口径按"宁可漏剔、不可错剔"取。
 * 因为导航尾部区本来就会被 `nav-tail` 整段丢弃，这条规则在生产上**不会让正文少一个字**，
 * 它的作用是"安全网 + 可审计"（若将来 nav-tail 改成"只标记不删"，这里已把尾部标题串标出来）。
 */
const BARE_TITLE_MAX_CHARS = 30
const BARE_TITLE_MIN_RUN = 3

/** 去掉空白后的前 `n` 个字符（判断"关键词是否位于行首"用） */
function headOf(line: string, n: number): string {
  return line.replace(/[\s\u3000]+/g, '').slice(0, n)
}

/** 目录行判定（纯函数、可测试） */
export function isTocLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  const m = TOC_LINE_RE.exec(t)
  if (!m) return false
  const pageNo = Number(m[1])
  if (!(pageNo >= TOC_PAGE_MIN && pageNo <= TOC_PAGE_MAX)) return false
  return TOC_LEADER_RE.test(t)
}

/**
 * 版记行判定（纯函数、可测试）。**必须行首命中关键词**——这是被真实数据逼出来的收紧：
 * 按"行内含关键词"匹配会把年鉴正文里的任命/免职时间线删掉。
 */
export function isImprintLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (SENTENCE_END_RE.test(t)) return false
  const head = headOf(t, 4)
  const strongHead = IMPRINT_HEAD_STRONG.some((k) => head.includes(k))
  const weakHead = IMPRINT_HEAD_WEAK.some((k) => head.includes(k))
  if (!strongHead && !weakHead) return false
  // 强关键词行首命中（`社 址`/`印 张`/`ISBN 978-…`）已经足够——**不再看正文特征**：
  // 这类行本身可能含数字（ISBN）或年份（版次 `2024 年 1 月第 1 版`），按 NARRATIVE_RE 会自相矛盾地放行。
  if (strongHead) return true
  // 单个**弱**关键词（主编/主任/委员/编纂/出版）必须凑齐第二个信号，并排除正文特征
  if (NARRATIVE_RE.test(t)) return false
  return t.includes('\t') || /[:：]/.test(t.replace(IMPRINT_HEAD_SEP_RE, ''))
}

/** 名单行判定（纯函数、可测试）：人名 + 职务后缀；需**连续 ≥3 行**才成块剔除 */
export function isMastheadLine(line: string): boolean {
  const t = line.trim()
  if (!t || t.length > MASTHEAD_MAX_CHARS) return false
  if (/[0-9０-９A-Za-z]/.test(t)) return false
  if (/[。！？；]$/.test(t)) return false
  if (NARRATIVE_RE.test(t)) return false
  return TITLE_SUFFIX_RE.test(t.replace(/[\s\u3000]+/g, ''))
}

/** 纯短标题行判定（网页用）：短、无句末标点、无数字/拉丁；**含制表符的列式行不算**（那是名单/表格，不是标题串） */
export function isBareTitleLine(line: string): boolean {
  const t = line.trim()
  if (!t || t.length > BARE_TITLE_MAX_CHARS) return false
  if (t.includes('\t')) return false
  if (/[。！？；：，,、]$/.test(t)) return false
  if (/[0-9０-９A-Za-z]/.test(t)) return false
  if (isTocLine(t)) return false
  if (PAGE_CHROME_LINE_RE.test(t)) return false
  return true
}

/** 网页尾部导航块的起始行（返回行号，找不到返回 -1）。纯函数、可测试。 */
export function findNavTailStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (NAV_TAIL_RE.test(lines[i])) return i
  }
  return -1
}

/**
 * 剔除结构性垃圾（纯函数、可测试；只删整行，不改写文本）。
 */
export function stripStructureNoise(text: string, kind: StructureNoiseKind): StructureNoiseResult {
  const src = text ?? ''
  const lines = src.split(/\r?\n/)
  // 每行在原文里的起点：累加（行长 + 1 个换行符）——CRLF 时略偏 1 个字符，但我们只删整行，误差不会累积到"跨行错位"
  const lineStarts: number[] = []
  {
    let at = 0
    for (const l of lines) {
      lineStarts.push(at)
      at += l.length + 1
    }
  }
  const removals: StructureNoiseRemoval[] = []
  /**
   * 收集一个连续块（从 `start` 起、满足 `pred` 的行；空行不打断 run，也被一并删掉）。
   * `scope` 是**作用域内的行数组**（正文区或导航尾部区），因此返回的下标相对该作用域——
   * 正文区作用域就是 `lines` 的前缀，下标与 `lines` 一致；调用方只在正文区写 `removedIdx`。
   */
  const collectRun = (
    start: number,
    pred: (l: string) => boolean,
    minRun: number,
    scope: string[]
  ): { end: number; lines: string[] } => {
    let end = start
    let count = 0
    while (end < scope.length) {
      const l = scope[end]
      if (!l.trim()) {
        end++
        continue
      }
      if (!pred(l)) break
      count++
      end++
    }
    return { end, lines: count >= minRun ? scope.slice(start, end) : [] }
  }

  /*
   * ③ 网页尾部导航块：从独占的"相关新闻/更多>>"行起整段截断。
   * 这一步同时决定了**④「纯短标题串」的作用范围**（2026-10-05 口径放宽）：
   * 导航尾部会被整段丢弃，所以正文区（`navAt` 之前）**一律不套用** `bare-title-run`——
   * 正文里的图片说明、报刊式短行（实测 324 行 / 5,196 字）属于材料，按"有关的不被筛掉"必须保留。
   */
  let navAt = -1
  if (kind === 'web') {
    navAt = findNavTailStart(lines)
    if (navAt >= 0) {
      const tail = lines.slice(navAt).filter((l) => l.trim())
      removals.push({
        kind: 'nav-tail',
        reason: '从"相关新闻/更多>>"独占行起整段截断（其后是侧栏列表，不是本文正文）',
        lines: tail
      })
    }
  }
  /** 正文区（网页 = 导航尾部之前；本地文件 = 全文）——**这里只跑 toc / imprint / masthead-run / page-chrome** */
  const bodyLines = navAt >= 0 ? lines.slice(0, navAt) : lines
  /** 导航尾部区（只可能存在于网页、且已经会被整段丢弃）——**只有这里才套用 bare-title-run** */
  const tailLines = navAt >= 0 ? lines.slice(navAt) : []

  /**
   * 正文区待删行下标（**相对 `bodyLines`，也就是相对 `lines` 的前缀**，可直接用于 `lines`）。
   */
  const bodyRemovedIdx = new Set<number>()
  let i = 0
  while (i < bodyLines.length) {
    // ① 目录块（连续 ≥3 行"标题…页码"）
    if (isTocLine(bodyLines[i])) {
      const run = collectRun(i, isTocLine, TOC_MIN_RUN, bodyLines)
      if (run.lines.length > 0) {
        removals.push({
          kind: 'toc',
          reason: `连续 ${run.lines.filter((l) => l.trim()).length} 行"标题…页码"（年鉴目录）`,
          lines: run.lines.filter((l) => l.trim())
        })
        for (let k = i; k < run.end; k++) bodyRemovedIdx.add(k)
        i = run.end
        continue
      }
    }
    // ② 名单块（连续 ≥3 行"人名 + 职务"，仅本地文件）
    if (kind === 'file' && isMastheadLine(bodyLines[i])) {
      const run = collectRun(i, isMastheadLine, MASTHEAD_MIN_RUN, bodyLines)
      if (run.lines.length > 0) {
        removals.push({
          kind: 'masthead-run',
          reason: `连续 ${run.lines.filter((l) => l.trim()).length} 行"人名 + 职务"名单（编委会/编写人员）`,
          lines: run.lines.filter((l) => l.trim())
        })
        for (let k = i; k < run.end; k++) bodyRemovedIdx.add(k)
        i = run.end
        continue
      }
    }
    // ② 版记行
    if (isImprintLine(bodyLines[i])) {
      removals.push({ kind: 'imprint', reason: '版权页/版记特征（关键词位于行首）', lines: [bodyLines[i]] })
      bodyRemovedIdx.add(i)
      i++
      continue
    }
    // ④ 页眉页脚残留
    if (PAGE_CHROME_LINE_RE.test(bodyLines[i])) {
      removals.push({ kind: 'page-chrome', reason: '页眉页脚残留（来源/字号/责任编辑等短行）', lines: [bodyLines[i]] })
      bodyRemovedIdx.add(i)
      i++
      continue
    }
    // ⚠ 这里**刻意没有** `bare-title-run`：正文区的短标题行不再剔（见上方口径说明）
    i++
  }

  /*
   * ④ 纯短标题串（**只对导航尾部之后套用**，`BARE_TITLE_MIN_RUN` 只在这里生效）：
   * 这些行本来就会随 nav-tail 一起被丢弃，所以这一步在生产上**不会让正文少一个字**，
   * 它的作用是"**安全网 + 可审计**"：① 万一将来 nav-tail 改成"只标记不删"，这里已经把尾部标题串标出来；
   * ② 诊断输出里能如实说明"尾部那串短标题是被这条规则认出来的"。
   */
  if (tailLines.length > 0) {
    let j = 0
    while (j < tailLines.length) {
      if (isBareTitleLine(tailLines[j])) {
        const run = collectRun(j, isBareTitleLine, BARE_TITLE_MIN_RUN, tailLines)
        if (run.lines.length > 0) {
          removals.push({
            kind: 'bare-title-run',
            reason: `连续 ${run.lines.filter((l) => l.trim()).length} 行纯短标题（仅导航尾部区；正文区不套用）`,
            lines: run.lines.filter((l) => l.trim())
          })
          j = run.end
          continue
        }
      }
      j++
    }
  }

  /**
   * 全局待删行下标（相对 `lines`）：正文区那批已在同一坐标系里；导航尾部**整段**都删（含空行）。
   * ⚠ 不要去"只删尾部区里被 `bare-title-run` 认出的行"——会让 `removedChars` 漏算空行、与实际文本长度不自洽
   *（`removedChars` 是按逐行累加算出来的）。
   */
  const removedIdx = new Set<number>(bodyRemovedIdx)
  if (navAt >= 0) for (let k = navAt; k < lines.length; k++) removedIdx.add(k)

  // 末尾没有换行符时，原 `src` 里就没有那一个字符 → removedChars 少算 1（与旧实现一致）
  const trailingNewline = src.endsWith('\n') ? 0 : 1
  const keptIdx = new Set<number>()
  for (let k = 0; k < lines.length; k++) if (!removedIdx.has(k)) keptIdx.add(k)
  const res = finish(keptIdx, lines, lineStarts, src, removals)
  return { ...res, removedChars: Math.max(0, res.removedChars - trailingNewline) }
}

/** 组装结果（`removedChars` 按"被删行的字数 + 各自的换行符"累加，不受首尾空白影响） */
function finish(
  keptIdx: Set<number>,
  lines: string[],
  lineStarts: number[],
  src: string,
  removals: StructureNoiseRemoval[]
): StructureNoiseResult {
  const kept: string[] = []
  const keptLineStarts: number[] = []
  let removedChars = 0
  for (let i = 0; i < lines.length; i++) {
    if (keptIdx.has(i)) {
      kept.push(lines[i])
      keptLineStarts.push(lineStarts[i])
    } else {
      removedChars += lines[i].length + 1
    }
  }
  return {
    text: kept.join('\n'),
    removedChars: Math.max(0, Math.min(removedChars, src.length)),
    keptLineStarts,
    removals
  }
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('structure-noise 结构性垃圾剔除（第一组 ④）', () => {
    it('① 连续 ≥3 行"标题…页码"整块剔除（年鉴目录，含页码数字，逃过旧"标题行无数字"判据）', () => {
      const text = [
        '自然地理\b\b\b\b\b\b 14',
        '位置面积\b\b\b\b\b\b 14',
        '地形地貌\b\b\b\b\b\b 14',
        '气候\b\b\b\b\b\b 15',
        '长乐区持续推进城乡建设，全年完成投资若干亿元。',
        '教育\t\t\t\t 120'
      ].join('\n')
      const r = stripStructureNoise(text, 'file')
      expect(r.removals.some((x) => x.kind === 'toc')).toBe(true)
      expect(r.text).not.toContain('地形地貌')
      expect(r.text).toContain('长乐区持续推进城乡建设') // 正文毫发无损
      // 单行"标题 + 页码"（可能是数据行）不剔
      expect(stripStructureNoise('高中 个 183', 'file').text).toBe('高中 个 183')
      const two = ['概况 24', '体育 25'].join('\n')
      expect(stripStructureNoise(two, 'file').text).toBe(two)
      // 无引导符的"标题 + 页码"不剔（避免命中"项目 42 个"这类数据行）
      const dataRow = ['学校 42', '班级 183', '教师 22'].join('\n')
      expect(stripStructureNoise(dataRow, 'file').text).toBe(dataRow)
    })

    it('② 版权页/版记行剔除，但**不得误剔正文时间线**（口径收紧的真实教训）', () => {
      const text = [
        '书 \t名 \t长乐年鉴 2023',
        '编 \t者 \t中共福州市长乐区委党史和地方志研究室',
        '社 \t址 \t福州市华林路 205 号',
        '邮 \t编 \t350011',
        'ISBN 978-7-5467-0616-0',
        '主 \t编：陈学林',
        '主 \t任：张 \t帆 \t福州新区党工委副书记、长乐区委书记',
        // ↓ 以下都是**年鉴正文**（任命/免职时间线），绝不能被剔
        '同日 \t省人大常委会法制委主任',
        '9 日 \t市人大常委会主任张忠带队开展执法检查。',
        '一百零四次会议 11 月 23 日 \t研究召开区委全体委员会议有关事宜',
        '【委员工作】 \t2022 年，政协长乐区委员会组织委员开展调研。'
      ].join('\n')
      const r = stripStructureNoise(text, 'file')
      expect(r.text).not.toContain('长乐年鉴 2023')
      expect(r.text).not.toContain('华林路 205 号')
      expect(r.text).not.toContain('ISBN')
      expect(r.text).not.toContain('陈学林')
      expect(r.text).toContain('同日 \t省人大常委会法制委主任')
      expect(r.text).toContain('市人大常委会主任张忠带队')
      expect(r.text).toContain('【委员工作】')
      expect(r.text).toContain('区委全体委员会议')
    })

    it('② 连续 ≥3 行"人名 + 职务"名单块剔除（编委会/编写人员），两行不成块、网页不套用', () => {
      const text = [
        '李 \t旭 \t长乐区委区直机关工委常务副书记',
        '陈学林 \t长乐区委党史和地方志研究室主任',
        '郑 \t清 \t长乐区财政局局长',
        '长乐区某中学新建项目开工，规划 60 个班。'
      ].join('\n')
      const r = stripStructureNoise(text, 'file')
      expect(r.removals.some((x) => x.kind === 'masthead-run')).toBe(true)
      expect(r.text).not.toContain('长乐区财政局局长')
      expect(r.text).toContain('长乐区某中学新建项目开工')
      // 两行不成块（宁可漏剔）
      const two = ['李 \t旭 \t长乐区委区直机关工委常务副书记', '陈学林 \t长乐区委党史和地方志研究室主任'].join('\n')
      expect(stripStructureNoise(two, 'file').text).toBe(two)
      // 网页不套用名单规则（网页里"人名 + 职务"很可能就是正文）
      expect(stripStructureNoise(text, 'web').text).toContain('长乐区财政局局长')
    })

    it('③ 网页尾部导航块整段截断；正文里的"相关新闻"四个字（非独占行）不触发', () => {
      const text = [
        '长乐新闻网讯 12月30日，区长廖海军带队赴古槐镇召开反馈会。',
        '相关新闻',
        '长乐新闻20221230 (2022-12-30 21:01:32)',
        '要闻 更多>>',
        '兰文赴金峰镇调研'
      ].join('\n')
      const r = stripStructureNoise(text, 'web')
      expect(r.text).toBe('长乐新闻网讯 12月30日，区长廖海军带队赴古槐镇召开反馈会。')
      expect(r.removals[0].kind).toBe('nav-tail')
      // 非独占行：正文里出现"相关新闻"不截断
      const inline = '会上通报了相关新闻宣传工作的情况，要求加强引导。'
      expect(stripStructureNoise(inline, 'web').text).toBe(inline)
    })

    it('④ 页眉页脚残留被剔；**正文区的纯短标题行不被剔**（2026-10-05 放宽：有关的不被筛掉）', () => {
      const text = [
        '【字号：大 中 小】',
        '来源：长乐新闻网',
        '区人大常委会开展城市内涝整治工作调研',
        '区政协党组（扩大）会议召开',
        '区政府党组会议和常务会议召开',
        '正文段落：视察组要求各相关部门提高思想认识。'
      ].join('\n')
      const r = stripStructureNoise(text, 'web')
      expect(r.text).not.toContain('【字号')
      expect(r.text).not.toContain('来源：长乐新闻网')
      expect(r.removals.map((x) => x.kind)).toContain('page-chrome')
      // ⚠ 放宽点：**没有 nav-tail 的网页 = 全部算"正文区"** → 三行短标题一律保留（它们可能是图片说明/报刊式短行）
      expect(r.removals.map((x) => x.kind)).not.toContain('bare-title-run')
      expect(r.text).toContain('区人大常委会开展城市内涝整治工作调研')
      expect(r.text).toContain('区政协党组（扩大）会议召开')
      expect(r.text).toContain('区政府党组会议和常务会议召开')
      expect(r.text).toContain('正文段落：')
    })

    it('④ 纯短标题串**只对导航尾部之后**套用：正文区同种短行保留，尾部仍被整体截断/识别', () => {
      const text = [
        '视察组一行先后来到长乐区高级中学新校区，现场了解项目进展情况。',
        // ↓ 正文区的短标题行（模拟图片说明/报刊式短行）——**必须保留**
        '　　记者 蒋升阳 颜 珂 刘晓宇',
        '　　核心阅读',
        '　　擦亮一张金色名片',
        '相关新闻',
        '要闻 更多>>',
        '兰文赴金峰镇调研',
        '区政协党组（扩大）会议召开'
      ].join('\n')
      const r = stripStructureNoise(text, 'web')
      const kinds = r.removals.map((x) => x.kind)
      expect(kinds).toContain('nav-tail')
      // 正文区的三行短标题**留在结果里**
      expect(r.text).toContain('记者 蒋升阳')
      expect(r.text).toContain('核心阅读')
      expect(r.text).toContain('擦亮一张金色名片')
      // 导航尾部整段丢弃
      expect(r.text).not.toContain('相关新闻')
      expect(r.text).not.toContain('兰文赴金峰镇调研')
      // 尾部区里那串短标题（无句末标点、无数字、连续 ≥3 行）由 bare-title-run 标注出来（安全网/可审计）
      const bare = r.removals.find((x) => x.kind === 'bare-title-run')
      expect(bare).toBeTruthy()
      // 尾部区前 4 行都满足"短、无句末标点、无数字" → 被这条规则认出来（安全网/可审计）
      expect(bare!.lines).toContain('要闻 更多>>')
      expect(bare!.lines).toContain('兰文赴金峰镇调研')
      expect(bare!.lines).toContain('区政协党组（扩大）会议召开')
      // 不足 `BARE_TITLE_MIN_RUN` 行时不标注（宁可漏剔）
      const shortTail = ['正文一句。', '相关新闻', '只有一行短标题'].join('\n')
      expect(stripStructureNoise(shortTail, 'web').removals.map((x) => x.kind)).not.toContain('bare-title-run')
    })

    it('空输入、无噪声输入原样返回（幂等、无副作用）', () => {
      expect(stripStructureNoise('', 'web').text).toBe('')
      const clean = '长乐区某中学新建项目开工。\n规划 60 个班。'
      expect(stripStructureNoise(clean, 'file').text).toBe(clean)
    })
  })
}
