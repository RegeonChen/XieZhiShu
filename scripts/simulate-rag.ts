/**
 * scripts/simulate-rag.ts —— RAG 全链路本地模拟验证脚本。
 *
 * 模拟真实业务闭环：
 *   1. 导入一批资料（内存库，直接写入 sources 行，等价于 importFiles/addUrl 成功后的落库状态）
 *   2. 自动触发向量化（indexAllPending，等价于主进程导入成功后的自动 indexSource）
 *   3. 新任务下达 → 本地粗筛（retrieveForTask，真实 BGE-small-zh-v1.5 WASM 推理 + 词法/向量 RRF 融合）
 *
 * 用法：npx vite-node scripts/simulate-rag.ts
 * 无痕保证：全程使用 :memory: 内存数据库，不写盘、不改动模型目录、不产生任何模拟数据痕迹。
 */
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { setDb } from '../src/main/db/connection'
import { runMigrations } from '../src/main/db/migrate'
import { configureEmbedModel } from '../src/main/rag/embed'
import { indexAllPending } from '../src/main/rag/indexer'
import { retrieveChunks } from '../src/main/rag/retrieval'
import { createTask } from '../src/main/db/tasks'
import { retrieveForTask } from '../src/main/writing/generate'

interface MockSource {
  id: string
  title: string
  text: string
}

/** 模拟导入的一批资料（贴近志书门类） */
const MOCK_SOURCES: MockSource[] = [
  {
    id: 's-edu',
    title: '某县小学教育发展',
    text: [
      '全县适龄儿童入学率逐年提升，2023年达到99.2%。',
      '教师队伍建设持续加强，专任教师学历达标率稳步提高。',
      '学校办学条件不断改善，多媒体教室实现全覆盖。'
    ].join('\n')
  },
  {
    id: 's-health',
    title: '某县卫生健康事业',
    text: [
      '乡镇卫生院标准化建设覆盖全部乡镇。',
      '适龄儿童免疫规划疫苗接种率保持在95%以上。',
      '县医院与上级医院建立医联体合作，分级诊疗体系初步形成。'
    ].join('\n')
  },
  {
    id: 's-econ',
    title: '某县经济发展综述',
    text: [
      '地区生产总值保持平稳增长，2023年实现地区生产总值168亿元。',
      '招商引资项目陆续落地，主导产业规模持续扩大。',
      '三次产业结构不断优化，第三产业占比逐年上升。'
    ].join('\n')
  },
  {
    id: 's-trans',
    title: '某县交通运输建设',
    text: [
      '高速公路通车里程稳步增加，县城与周边地市实现快速连通。',
      '城乡公交一体化加快推进，行政村通客车率保持100%。',
      '农村公路养护体系不断完善。'
    ].join('\n')
  },
  {
    id: 's-water',
    title: '某县水利设施建设',
    text: [
      '农田水利设施不断完善，有效灌溉面积逐年扩大。',
      '防汛抗旱体系持续健全，中小河流治理工程按期完成。',
      '农村饮水安全巩固提升工程惠及全县群众。'
    ].join('\n')
  },
  {
    id: 's-cul',
    title: '某县文化体育事业',
    text: [
      '公共文化服务体系日益完善，县文化馆、图书馆全部达标。',
      '全民健身活动广泛开展，乡镇体育场地实现全覆盖。',
      '非物质文化遗产保护传承工作有序推进。'
    ].join('\n')
  }
]

/** 模拟"新任务下达"的粗筛验证用例 */
interface VerifyCase {
  taskTitle: string
  scopeIds: string[]
  expectSourceId: string
  note: string
}

const VERIFY_CASES: VerifyCase[] = [
  { taskTitle: '适龄儿童教育事业发展综述', scopeIds: MOCK_SOURCES.map((s) => s.id), expectSourceId: 's-edu', note: '词法+向量均应优先召回教育资料' },
  { taskTitle: '义务教育普及情况', scopeIds: MOCK_SOURCES.map((s) => s.id), expectSourceId: 's-edu', note: '词面与"入学率"差异较大，重点验证向量路' },
  { taskTitle: '地区经济社会发展概况', scopeIds: MOCK_SOURCES.map((s) => s.id), expectSourceId: 's-econ', note: '应优先召回经济资料' },
  { taskTitle: '农村水利与防汛能力建设', scopeIds: MOCK_SOURCES.map((s) => s.id), expectSourceId: 's-water', note: '应优先召回水利资料' },
  { taskTitle: '地区经济发展', scopeIds: ['s-edu', 's-trans'], expectSourceId: '', note: '范围外（不含 s-econ）不得返回经济资料，验证白名单约束' }
]

let failed = 0

function check(ok: boolean, label: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed += 1
}

function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n)
}

async function main(): Promise<void> {
  console.log('='.repeat(72))
  console.log('RAG 全链路本地模拟验证（真实 BGE-small-zh-v1.5 · onnxruntime-web WASM）')
  console.log('='.repeat(72))

  // ---- 1. 内存数据库（无痕） + 真实模型配置 ----
  const db = new Database(':memory:')
  setDb(db)
  runMigrations(db)
  configureEmbedModel({ modelPath: join(process.cwd(), 'resources', 'models') })

  // ---- 2. 模拟导入 ----
  const insert = db.prepare(
    `INSERT INTO sources (id, kind, title, cleaned_text, status) VALUES (?, 'file', ?, ?, 'ready')`
  )
  for (const s of MOCK_SOURCES) insert.run(s.id, s.title, s.text)
  console.log(`\n[模拟导入] 已导入 ${MOCK_SOURCES.length} 篇资料：`)
  for (const s of MOCK_SOURCES) console.log(`  - ${s.title}`)

  // ---- 3. 自动触发向量化 ----
  console.log('\n[自动向量化] 正在索引（真实模型推理，请稍候）…')
  const t0 = Date.now()
  const result = await indexAllPending()
  const indexSeconds = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`  完成：${result.indexed} 篇就绪，${result.failed} 篇失败，耗时 ${indexSeconds}s`)

  const indexRows = db
    .prepare(
      `SELECT s.id, s.title, s.index_state, s.indexed_at, COUNT(c.id) AS n
       FROM sources s LEFT JOIN chunk_embeddings c ON c.source_id = s.id
       GROUP BY s.id ORDER BY s.id`
    )
    .all() as { id: string; title: string; index_state: string; indexed_at: string | null; n: number }[]
  for (const r of indexRows) {
    console.log(`  - ${pad(r.title, 18)} state=${pad(r.index_state, 7)} chunks=${r.n} indexed_at=${r.indexed_at ?? '-'}`)
  }

  const totalChunks = indexRows.reduce((a, r) => a + r.n, 0)
  check(result.indexed === MOCK_SOURCES.length, `全部资料自动索引就绪（${result.indexed}/${MOCK_SOURCES.length}）`)
  check(result.failed === 0, '索引失败数为 0')
  check(totalChunks > 0, `chunk_embeddings 已写入 ${totalChunks} 个向量块`)

  // 幂等：重复触发不再重复索引
  const again = await indexAllPending()
  check(again.indexed === 0, '重复触发幂等（再次索引 0 篇新增）')

  // ---- 4. 新任务下达 → 本地粗筛 ----
  console.log('\n[粗筛验证] 每个任务标题 → 检索 Top5（真实推理）')
  for (const v of VERIFY_CASES) {
    const task = createTask({ title: v.taskTitle, scope: { sourceIds: v.scopeIds } })

    // 词法对照（不带向量，便于对比）
    const lex = retrieveChunks({ sourceIds: v.scopeIds, query: v.taskTitle, limit: 5 })

    const tq = Date.now()
    const hits = await retrieveForTask(task.id)
    const qSeconds = ((Date.now() - tq) / 1000).toFixed(1)

    console.log(`\n◆ 任务《${v.taskTitle}》(${v.note})  [${qSeconds}s]`)
    console.log(`  - 纯词法 Top: ${lex.length === 0 ? '（无）' : lex.map((c) => `${c.sourceTitle}[${c.position}]`).join(' / ')}`)
    console.log(`  - 混合 Top:   ${hits.length === 0 ? '（无）' : hits.map((c) => `${c.sourceTitle}[${c.position}](分${c.score})`).join(' / ')}`)

    if (v.expectSourceId) {
      const expectTitle = MOCK_SOURCES.find((s) => s.id === v.expectSourceId)?.title ?? v.expectSourceId
      const pos = hits.findIndex((c) => c.sourceId === v.expectSourceId)
      const lexHit = lex.some((c) => c.sourceId === v.expectSourceId)
      check(pos >= 0, `预期来源《${expectTitle}》被召回（Top${hits.length} 内第 ${pos >= 0 ? pos + 1 : '-'} 位）`)
      if (pos >= 0 && !lexHit) {
        console.log('        ▲ 纯词法未召回该来源，由向量路补充召回（向量粗筛的增量价值）')
      }
    } else {
      // 白名单约束：范围外来源绝不出现
      const outOfScope = hits.some((c) => !v.scopeIds.includes(c.sourceId))
      check(!outOfScope && hits.every((c) => v.scopeIds.includes(c.sourceId)), '检索结果严格限定在任务范围内')
      check(!hits.some((c) => c.sourceId === 's-econ'), '范围外的经济资料未被召回')
    }
  }

  // ---- 5. 清理与汇总 ----
  db.close()
  console.log('\n' + '='.repeat(72))
  console.log(failed === 0 ? '✅ 全部验证通过' : `❌ ${failed} 项验证未通过`)
  console.log('已清理：内存数据库已销毁，未写盘、未改动模型目录、未留下任何模拟资料痕迹。')
  console.log('='.repeat(72))
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('脚本执行失败：', err)
  process.exitCode = 1
})
