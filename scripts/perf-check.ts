/**
 * scripts/perf-check.ts —— 工作区对账性能验证脚本（可复用回归脚本）。
 * 模拟批量录入 300 个文件，检测对账期间主进程事件循环是否被阻塞（UI 卡死的根因）。
 * 为免去 300 次真实向量推理的等待，将 embed 模型指向不存在目录（indexSource 会快速失败并被吞掉），
 * 专注于验证"扫描/指纹/解析/入库"链路的异步化效果。
 * 用法：npx vite-node scripts/perf-check.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { setDb } from '../src/main/db/connection'
import { runMigrations } from '../src/main/db/migrate'
import { updateSettings } from '../src/main/db/settings'
import { configureEmbedModel } from '../src/main/rag/embed'
import { reconcileWorkspace, reconcilePaths } from '../src/main/workspace/reconcile'

const FILE_COUNT = 300

async function main(): Promise<void> {
  const db = new Database(':memory:')
  setDb(db)
  runMigrations(db)
  // 模型目录指向不存在路径 → indexSource 快速失败并被吞掉，验证不跑真实推理
  configureEmbedModel({ modelPath: join(process.cwd(), 'resources', 'models-not-exist') })

  const tmp = mkdtempSync(join(tmpdir(), 'perf-ws-'))
  updateSettings({ workspaceDir: tmp })
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(
      join(tmp, `f${i}.txt`),
      `第 ${i} 篇资料：这里是地方志资料正文，涉及教育发展、经济建设、交通设施、医疗卫生等主题内容。`.repeat(6)
    )
  }

  // 事件循环健康度：每 100ms 检查一次心跳，统计最大间隔（>500ms 说明被阻塞）
  let maxGap = 0
  let last = Date.now()
  const heartbeat = setInterval(() => {
    const now = Date.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
  }, 100)

  const t0 = Date.now()
  const res = await reconcileWorkspace()
  const fullMs = Date.now() - t0

  // 增量：单文件修改
  const t1 = Date.now()
  writeFileSync(join(tmp, 'f0.txt'), '内容已被修改。'.repeat(20))
  const inc = await reconcilePaths(['f0.txt'])
  const incMs = Date.now() - t1

  clearInterval(heartbeat)

  console.log(`[全量对账] ${FILE_COUNT} 个文件：耗时 ${(fullMs / 1000).toFixed(1)}s，结果 ${JSON.stringify(res)}`)
  console.log(`[增量对账] 修改 1 个文件：耗时 ${incMs}ms，结果 ${JSON.stringify(inc)}`)
  console.log(`[事件循环] 最大心跳间隔 ${maxGap}ms → ${maxGap > 500 ? '❌ 曾被长时间阻塞（异常）' : '✅ 保持响应（UI 不卡）'}`)

  rmSync(tmp, { recursive: true, force: true })
  db.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
