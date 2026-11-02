/**
 * crawl-exclusion.test.ts —— **抓取独占**的入口级测试（2026-11-02 审查修复）。
 *
 * 场景（真实故障路径）：生成正在抓取时，用户去设置页点「建立」→ 旧实现只查自己的 `state.running`，
 * 于是两条抓取并行（同站并发翻倍、ETA 失真、互相抢限速名额）。
 * 现在 `runCacheBuild` 会检查抓取租约的归属，**生成期抓取在跑时直接拒绝并给出人话原因**。
 */
import { describe, expect, it } from 'vitest'
import { acquireCrawlFor, getCrawlOwner, releaseCrawlFrom, resetFetchControl } from './fetch-control'
import { runCacheBuild } from './cache-build'
import type { WebCrawlResult } from '../../shared/types'

/** 假抓取结果（本测试只关心"有没有真的开跑"，字段给最小可用值） */
const fakeResult = (): WebCrawlResult =>
  ({
    total: 0,
    done: 0,
    hits: 0,
    dropped: 0,
    failed: 0,
    chars: 0,
    cancelled: false,
    elapsedMs: 0,
    cacheWritten: 0,
    cacheHits: 0
  }) as WebCrawlResult

describe('抓取独占：生成期抓取进行中时，建立缓存必须被拒绝', () => {
  it('租约归 screen 时 runCacheBuild 返回 started=false，且不启动抓取/同步', async () => {
    resetFetchControl()
    expect(acquireCrawlFor('screen')).toBe(true)
    let crawled = false
    let synced = false
    try {
      const res = await runCacheBuild(
        { fromYear: 2020, toYear: 2021, includeLocal: false },
        {
          crawl: async () => {
            crawled = true
            return fakeResult()
          },
          syncAll: async () => {
            synced = true
            return { added: 0, failed: 0, notAttempted: 0, outcomes: [] }
          }
        }
      )
      expect(res.started).toBe(false)
      expect(res.message).toContain('正在生成汇编')
      // 必须**什么都没做**：既不抓取、也不同步清单
      expect(crawled).toBe(false)
      expect(synced).toBe(false)
    } finally {
      releaseCrawlFrom('screen')
      resetFetchControl()
    }
    expect(getCrawlOwner()).toBeNull()
  })

  it('租约空闲时照常开始（不把正常路径拦掉）', async () => {
    resetFetchControl()
    const res = await runCacheBuild(
      { fromYear: 2020, toYear: 2021, includeLocal: false },
      {
        crawl: async () => fakeResult(),
        syncAll: async () => ({ added: 0, failed: 0, notAttempted: 0, outcomes: [] })
      }
    )
    expect(res.started).toBe(true)
  })
})
