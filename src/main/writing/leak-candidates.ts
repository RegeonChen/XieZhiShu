/**
 * leak-candidates.ts —— 补漏候选（B 方案，2026-10-03 用户裁定）。
 *
 * 用户在汇编生成后说"我记得资料库里有……你好像漏了"时，**原链路只会改文档、不检索资料库**
 * （提示词里既没有来源正文，也没有检索能力），所以要么模型说做不到，要么凭空插一段（只有"数字"一道闸门）。
 *
 * B 方案给这条链路补上**检索 → 候选原文 → 只能照抄候选**的闭环：
 *  1. 本地检索（复用生成管线的召回口径 `recallCompilationCandidates`：任务范围内全部来源，
 *     词法 bigram + 向量语义）→ 按得分选出候选原文片段（本文件 `rankLeakCandidates`）；
 *  2. 候选片段作为**新增段落的唯一依据**附进提示词（`buildCandidateSection`）；
 *  3. 本地校验：带 `candidateKey` 的新增段落，其 `evidence` 必须**逐字**出自该候选原文
 *     （归一化后包含，≥ `EVIDENCE_MIN_CHARS` 字），正文里的数字也必须能在候选原文里找到
 *     （`checkInsertEvidence`）——模型无法凭空插入资料库里没有的内容。
 *
 * 本文件只放纯函数（不碰数据库、不联网），IO 编排在 `doc-edit-runner.ts`。
 */
import type { RetrievedChunk } from '../../shared/types'
import { normalizeForMatch } from '../parse/page-map'
import { numbersCoveredBy } from './compilation-document'
import type { DocEditOp } from './doc-edit-service'

/** 单条候选原文的长度上限（提示词预算） */
export const CANDIDATE_MAX_CHARS = 2000
/** 候选条目数上限 */
export const CANDIDATE_MAX_ITEMS = 12
/** 候选原文总字符预算 */
export const CANDIDATE_TOTAL_CHARS = 14000
/** 同一来源最多取几条候选（避免一份年鉴占满候选位） */
export const CANDIDATE_MAX_PER_SOURCE = 3
/** `evidence` 至少要有这么多字（归一化后），否则不算"逐字依据" */
export const EVIDENCE_MIN_CHARS = 12

export interface LeakCandidate {
  /** 提示词里的短标识：c1、c2… */
  key: string
  sourceId: string
  sourceTitle: string
  /** 该候选在来源里的位置标识（第 N 段 / 第 N 块） */
  position: string
  /** 原文片段（逐字，可能被截断到 `CANDIDATE_MAX_CHARS`） */
  text: string
  score: number
}

/** 检索结果状态：ok=有候选 · empty=检索正常但没找到 · failed=本地检索不可用 · skipped=本轮未触发检索 */
export type LeakSearchState = 'ok' | 'empty' | 'failed' | 'skipped'

export interface LeakSearchOutcome {
  candidates: LeakCandidate[]
  state: LeakSearchState
  /** 参与打分的分块数（诊断用） */
  scanned: number
}

/**
 * 意图闸门：只有"像是说资料库漏了/要求补材料"的消息才触发本地检索。
 * 理由：本地宽召回在大库上要几十秒（生成管线给这一阶段的预算是 60s），
 * **不能给每条普通编辑指令都加上这个代价**（"删掉幼儿园那段"不该等 20 秒）。
 * 纯粹的编辑指令走快路径，并在提示词里如实说明"本轮没有候选原文"。
 */
export const LEAK_REQUEST_HINTS = [
  '漏',
  '遗漏',
  '忘了',
  '忘记',
  '少了',
  '缺少',
  '缺了',
  '没有收录',
  '没收录',
  '未收录',
  '应该有',
  '我记得',
  '资料库里',
  '资料库中',
  '是不是没',
  '没有找到',
  '没找到',
  '补充',
  '补上',
  '补进',
  '补一段',
  '加上一段'
]

export function looksLikeLeakRequest(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  return LEAK_REQUEST_HINTS.some((h) => t.includes(h))
}

/**
 * 「需要回资料库找答案」的意图（2026-10-03 用户裁定：细节追问也要查资料库）。
 *
 * 旧闸门只认"漏了/补充"这类措辞，于是「2022 年…具体是哪 2 所？」这种**细节追问**完全不触发检索，
 * 模型只能拿已生成的汇编作答（用户实测反馈的正是这件事）。
 * 现在把"问句 / 要求细化"一并纳入；纯编辑指令（"把第 3 段改短"）仍然不触发，以免每条指令都等检索。
 *
 * 命中后走的是**大模型自主导航**（`source-navigator.ts`：目录 → 模型挑资料/挑章节 → 读正文），
 * 不做任何本地的词法/向量相关性判断。
 */
export const DETAIL_REQUEST_HINTS = [
  '哪几',
  '哪一',
  '哪些',
  '是哪',
  '具体是',
  '具体有',
  '分别',
  '各自',
  '名单',
  '列出',
  '列一下',
  '有哪',
  '叫什么',
  '几所',
  '几个',
  '几人',
  '多少',
  '是否',
  '有没有',
  '是不是',
  '查一下',
  '查查',
  '找一下',
  '找找',
  '确认一下',
  '具体',
  '细化',
  '详细说明',
  '展开说',
  '展开讲',
  '详述',
  '出处',
  '依据',
  '来源是'
]

export function needsLibraryLookup(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  if (looksLikeLeakRequest(t)) return true
  // 问句本身就值得查（含问号，或"请/帮我 + 查/找/确认"）
  if (/[?？]/.test(t) && t.length >= 6) return true
  return DETAIL_REQUEST_HINTS.some((h) => t.includes(h))
}

/**
 * 归一化后 `evidence` 是否是 `text` 的连续片段，且长度达标（新增段落"逐字有据"的判定）
 */
export function evidenceInText(evidence: string, text: string): boolean {
  const e = normalizeForMatch(evidence ?? '').text
  if (e.length < EVIDENCE_MIN_CHARS) return false
  return normalizeForMatch(text ?? '').text.includes(e)
}

/**
 * 逐字校验新增段落（B 方案的核心防线）：
 * - 带 `candidateKey`：候选必须存在；`evidence` 必须逐字出自该候选原文；正文数字也必须在候选原文里；
 * - 不带 `candidateKey`：`evidence` 必须逐字出自**当前文档的段落文本**或**该来源原文**（重排/搬运已有内容）。
 * 返回 null = 通过；否则返回拒绝原因（直接显示给用户）。
 */
export function checkInsertEvidence(
  op: DocEditOp,
  candidates: LeakCandidate[],
  docTexts: string[],
  sourceTextByOrdinal: Map<number, string>
): string | null {
  if (op.op !== 'insertAfter') return null
  const evidence = (op.evidence ?? '').trim()
  const short = '新增段落的 evidence 太短：至少要 ' + EVIDENCE_MIN_CHARS + ' 字的逐字原文'
  const numbersBad = '新增段落里的数字在依据原文中找不到（疑似编造）'
  /**
   * 用户**点名**要某个数值时（`allowNewNumbers`，2026-09-10 用户裁定"大模型和软件都照做"），
   * 数字校验一律让路——否则"把在校生数改成 5000 人"这种正常要求会被这条新规则挡回去。
   * 逐字 evidence 仍然要求：新增段落总得有原文依据。
   */
  const numbersOkIn = (text: string | undefined, source: string): boolean =>
    op.allowNewNumbers === true || numbersCoveredBy(text ?? '', source)

  if (op.candidateKey) {
    const cand = candidates.find((c) => c.key === op.candidateKey)
    if (!cand) return '引用的候选原文编号不存在（' + op.candidateKey + '）'
    if (!evidence) return '新增段落缺少 evidence（必须从候选原文里逐字摘出）'
    if (normalizeForMatch(evidence).text.length < EVIDENCE_MIN_CHARS) return short
    if (!evidenceInText(evidence, cand.text)) return '新增段落的 evidence 不是候选原文里的逐字片段'
    if (!numbersOkIn(op.text, cand.text)) return numbersBad
    return null
  }

  if (!evidence) {
    return '新增段落必须有原文依据：请给出 evidence（从当前汇编段落或该来源原文里逐字摘出的片段，≥' + EVIDENCE_MIN_CHARS + ' 字）'
  }
  if (normalizeForMatch(evidence).text.length < EVIDENCE_MIN_CHARS) return short
  // 依据一：当前汇编里的某个段落（重排/搬运已有内容）→ 数字对着这段依据校验
  const docHit = docTexts.find((t) => evidenceInText(evidence, t))
  if (docHit) return numbersOkIn(op.text, docHit) ? null : numbersBad
  // 依据二：该段所属来源的原文
  const source = op.sourceOrdinal != null ? sourceTextByOrdinal.get(op.sourceOrdinal) ?? '' : ''
  if (source && evidenceInText(evidence, source)) {
    return numbersOkIn(op.text, source) ? null : numbersBad
  }
  return '新增段落的 evidence 在汇编段落与该来源原文里都找不到（不得凭空新增）'
}

/** 提示词片段：候选原文清单（由 `source-navigator` 的**大模型导航**产出，不是本地检索排序） */
export function buildCandidateSection(candidates: LeakCandidate[]): string {
  if (candidates.length === 0) {
    return [
      '【资料库原文】',
      '（本轮没有资料库原文：要么这条要求不需要查资料库，要么导航后没有选出可读的小节。）',
      '因此**不要新增段落**——除非依据是当前汇编已有段落或该来源原文（此时必须给出 evidence）。'
    ].join('\n')
  }
  const list = candidates
    .map(
      (c) =>
        '[' + c.key + '] 来源《' + c.sourceTitle + '》' + (c.position ? '（' + c.position + '）' : '') + '\n原文：\n' + c.text
    )
    .join('\n\n')
  return [
    '【资料库原文（已按来源与年份口径标出；是**新增段落的唯一依据**）】',
    list,
    '用法：① **先用这些原文回答用户的问题**，回答里要写清"哪一年口径、来自哪份资料"；',
    '② 若答案里有值得写进汇编的具体事实，**同时**用 `insertAfter` 新增一段（必须给 `candidateKey` 与逐字 `evidence`，',
    '   正文数字也必须能在该候选原文里找到）；③ 这些原文里没有答案时，如实回答"资料库里没有检索到"，**不要新增**。'
  ].join('\n')
}

/* ------------------------------ 单测 ------------------------------ */

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  const chunk = (over: Partial<RetrievedChunk>): RetrievedChunk => ({
    sourceId: 's1',
    sourceTitle: '长乐年鉴2023',
    position: '第3段',
    text: '某校新建教学综合楼项目，总投资约 1200 万元，建筑面积 8000 平方米，2021 年 9 月开工。',
    score: 1,
    ...over
  })

  describe('leak candidates (B 方案：查漏补段)', () => {
    it('意图闸门：只有"提到漏了/要求补充"的消息才触发本地检索', () => {
      expect(looksLikeLeakRequest('我记得有长乐三中恢复高中办学的部分在资料库中出现过，但你好像将其漏了')).toBe(true)
      expect(looksLikeLeakRequest('资料库里还有关于五中的材料吧，补充一下')).toBe(true)
      // 普通编辑指令不触发（否则每条消息都要等几十秒的本地宽召回）
      expect(looksLikeLeakRequest('把校区建设相关的内容都删掉')).toBe(false)
      expect(looksLikeLeakRequest('把时间标签都改成 2018 年')).toBe(false)
    })

    it('细节追问闸门（2026-10-03 用户裁定）：问句/要求细化也要回资料库找', () => {
      // 用户实测那条：旧闸门不认，导致只拿汇编作答
      expect(needsLibraryLookup('2022年，全区有省一级达标高中2所，具体是哪2所？')).toBe(true)
      expect(needsLibraryLookup('长乐区有哪些高中？')).toBe(true)
      expect(needsLibraryLookup('这几所学校的出处是什么？')).toBe(true)
      expect(needsLibraryLookup('我记得资料库里有五中的材料')).toBe(true) // 老闸门也命中
      // 纯编辑指令仍然走快路径（不检索）
      expect(needsLibraryLookup('把第 3 段改短一点')).toBe(false)
      expect(needsLibraryLookup('删掉幼儿园相关内容')).toBe(false)
      expect(needsLibraryLookup('把时间标签都改成 2018 年')).toBe(false)
    })

    it('资料库原文进提示词（带编号/来源/年份口径），没有原文时明确"不要新增"', () => {
      const cands: LeakCandidate[] = [{ ...chunk({ score: 2 }), key: 'c1' }]
      const section = buildCandidateSection(cands)
      expect(section).toContain('[c1] 来源《长乐年鉴2023》')
      expect(section).toContain('1200 万元')
      expect(section).toContain('新增段落的唯一依据')
      expect(section).toContain('先用这些原文回答用户的问题')
      const empty = buildCandidateSection([])
      expect(empty).toContain('本轮没有资料库原文')
      expect(empty).toContain('不要新增段落')
    })

    it('逐字校验：evidence 必须≥12 字且是候选原文的连续片段', () => {
      const cands: LeakCandidate[] = [{ ...chunk({ score: 2 }), key: 'c1' }]
      const doc = ['2018 年，全区普通中学 30 所。']
      const sources = new Map<number, string>()
      // 通过：evidence 逐字来自候选（允许空白差异，且 ≥12 字），数字也在候选里
      expect(
        checkInsertEvidence(
          {
            op: 'insertAfter',
            afterId: 'p1',
            candidateKey: 'c1',
            evidence: '总投资约1200万元，建筑面积',
            text: '2021 年，某校新建教学综合楼项目，总投资约 1200 万元，建筑面积 8000 平方米。'
          },
          cands,
          doc,
          sources
        )
      ).toBeNull()
      // 拒绝：候选编号不存在
      expect(
        checkInsertEvidence({ op: 'insertAfter', afterId: 'p1', candidateKey: 'c9', evidence: 'x'.repeat(20), text: 'a' }, cands, doc, sources)
      ).toContain('候选原文编号不存在')
      // 拒绝：evidence 缺失或太短（<12 字不算"逐字依据"）
      expect(
        checkInsertEvidence({ op: 'insertAfter', afterId: 'p1', candidateKey: 'c1', evidence: '总投资约1200万元', text: 'a' }, cands, doc, sources)
      ).toContain('太短')
      expect(checkInsertEvidence({ op: 'insertAfter', afterId: 'p1', candidateKey: 'c1', text: 'a' }, cands, doc, sources)).toContain(
        '缺少 evidence'
      )
      // 拒绝：evidence 不在候选原文里（模型自己编的话）
      expect(
        checkInsertEvidence(
          { op: 'insertAfter', afterId: 'p1', candidateKey: 'c1', evidence: '该校总投资约 5000 万元，建筑面积', text: 'a' },
          cands,
          doc,
          sources
        )
      ).toContain('不是候选原文里的逐字片段')
      // 拒绝：数字不在候选原文里
      expect(
        checkInsertEvidence(
          {
            op: 'insertAfter',
            afterId: 'p1',
            candidateKey: 'c1',
            evidence: '总投资约1200万元，建筑面积',
            text: '总投资约 5000 万元，建筑面积 9000 平方米。'
          },
          cands,
          doc,
          sources
        )
      ).toContain('数字在依据原文中找不到')
    })

    it('没有候选时新增段落必须逐字出自已有段落或该来源原文（堵住"凭空插一段"）', () => {
      const doc = ['2018 年，全区普通中学 30 所，其中独立高中 1 所，在校学生 1.2 万人。']
      const sources = new Map<number, string>([[1, '长乐三中恢复高中办学，2022 年秋季开始招生，首年招生 6 个班。']])
      // 通过：来自当前文档（evidence ≥12 字）
      expect(
        checkInsertEvidence(
          { op: 'insertAfter', afterId: 'p1', evidence: '全区普通中学 30 所，其中独立高中', text: '全区普通中学 30 所，其中独立高中 1 所。' },
          [],
          doc,
          sources
        )
      ).toBeNull()
      // 通过：来自该来源原文
      expect(
        checkInsertEvidence(
          {
            op: 'insertAfter',
            afterId: 'p1',
            sourceOrdinal: 1,
            evidence: '长乐三中恢复高中办学，2022年秋季',
            text: '长乐三中恢复高中办学，2022 年秋季开始招生。'
          },
          [],
          doc,
          sources
        )
      ).toBeNull()
      // 拒绝：编造（evidence 在汇编段落与该来源原文里都不存在）
      expect(
        checkInsertEvidence(
          { op: 'insertAfter', afterId: 'p1', sourceOrdinal: 1, evidence: '长乐五中扩建了新的实验楼', text: '长乐五中扩建了新的实验楼。' },
          [],
          doc,
          sources
        )
      ).toContain('不得凭空新增')
      // 拒绝：数字不在依据原文里
      expect(
        checkInsertEvidence(
          { op: 'insertAfter', afterId: 'p1', sourceOrdinal: 1, evidence: '长乐三中恢复高中办学，2022年秋季', text: '长乐三中 2022 年秋季招生 20 个班。' },
          [],
          doc,
          sources
        )
      ).toContain('数字在依据原文中找不到')
      // 用户点名要某个数值（allowNewNumbers）→ 数字校验让路，但仍必须有逐字依据
      expect(
        checkInsertEvidence(
          {
            op: 'insertAfter',
            afterId: 'p1',
            sourceOrdinal: 1,
            evidence: '长乐三中恢复高中办学，2022年秋季',
            text: '长乐三中 2022 年秋季招生 20 个班。',
            allowNewNumbers: true
          },
          [],
          doc,
          sources
        )
      ).toBeNull()
      // 拒绝：没有 evidence
      expect(checkInsertEvidence({ op: 'insertAfter', afterId: 'p1', sourceOrdinal: 1, text: '某段新正文。' }, [], doc, sources)).toContain(
        '必须有原文依据'
      )
      // 非 insertAfter 的 op 不受这条约束（改写走数字校验）
      expect(checkInsertEvidence({ op: 'replace', id: 'p1', text: '改写' }, [], doc, sources)).toBeNull()
    })
  })
}
