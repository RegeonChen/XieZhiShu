/**
 * migrate-fk.test.ts —— 迁移失败时**外键必须恢复**（2026-11-02 审查修复的回归测试）。
 *
 * 旧实现：`foreign_keys = OFF` → 跑迁移事务 → `ON`，**没有 try/finally**。
 * 迁移一抛错，`ON` 永远执行不到 —— 之后整个进程的外键约束全部失效（账本外键、级联触发器依赖的
 * 引用完整性都不再生效），而且没人知道。这条测试锁住"失败也要恢复 + 版本不记账 + 语句回滚"。
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, runMigrations } from './migrate'

describe('migrate：迁移失败时的安全边界', () => {
  it('抛错的迁移：外键恢复为 ON、版本不记账、已执行的语句回滚', () => {
    const db = new Database(':memory:')
    try {
      // 先跑到最新（顺带验证"整批迁移在内存库上可执行"）
      runMigrations(db)
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

      /*
       * 注入一条**必然失败**的迁移：同一段 SQL 里建两次同名表。
       * 故意让它在第二条语句失败，这样能同时验证"批次内已成功的语句也要回滚"。
       */
      MIGRATIONS.push({ version: 9999, sql: 'CREATE TABLE migrate_probe (id INTEGER); CREATE TABLE migrate_probe (id INTEGER);' })
      expect(() => runMigrations(db)).toThrow()

      // ① 外键必须已经恢复（旧实现会永久留在 0）
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      // ② 失败的版本不能记账（否则下次启动会跳过它，永远补不上）
      expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 9999').get()).toMatchObject({ c: 0 })
      // ③ 事务回滚：失败迁移里第一条成功的建表也不该留下
      expect(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='migrate_probe'").get()).toMatchObject({
        c: 0
      })
    } finally {
      MIGRATIONS.pop()
      db.close()
    }
  })
})
