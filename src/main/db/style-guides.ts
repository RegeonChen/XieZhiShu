/**
 * style-guides.ts —— 规范文档库（Phase 6.4.1：第二步「指定行文规范」）。
 * 多篇规范文档持久化 + 全局唯一默认（is_default）；生成初稿时读取默认规范注入。
 */
import Database from 'better-sqlite3'
import type { StyleGuide } from '../../shared/types'
import { DEFAULT_STYLE_GUIDE } from '../../shared/style-guide'
import { getDb, setDb } from './connection'
import { runMigrations } from './migrate'

interface StyleGuideRow {
  id: string
  name: string
  content: string
  is_default: number
  created_at: string
  updated_at: string
}

function rowToGuide(row: StyleGuideRow): StyleGuide {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listStyleGuides(): StyleGuide[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM style_guides ORDER BY is_default DESC, created_at ASC').all() as StyleGuideRow[]
  return rows.map(rowToGuide)
}

export function getStyleGuideById(id: string): StyleGuide | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM style_guides WHERE id = ?').get(id) as StyleGuideRow | undefined
  return row ? rowToGuide(row) : null
}

export function getDefaultStyleGuide(): StyleGuide | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM style_guides WHERE is_default = 1 LIMIT 1').get() as StyleGuideRow | undefined
  return row ? rowToGuide(row) : null
}

/** 新建（无 id）或覆盖（有 id）。新建时若无任何默认规范，则自动设为默认。 */
export function saveStyleGuide(input: { id?: string; name: string; content: string }): StyleGuide {
  const db = getDb()
  const now = new Date().toISOString()
  const name = input.name.trim() || '未命名规范'
  const content = input.content.trim()
  if (input.id) {
    db.prepare('UPDATE style_guides SET name = ?, content = ?, updated_at = ? WHERE id = ?').run(name, content, now, input.id)
    const row = db.prepare('SELECT * FROM style_guides WHERE id = ?').get(input.id) as StyleGuideRow
    return rowToGuide(row)
  }
  const id = crypto.randomUUID()
  const hasDefault = db.prepare('SELECT 1 FROM style_guides WHERE is_default = 1 LIMIT 1').get() !== undefined
  const isDefault = hasDefault ? 0 : 1
  db.prepare('INSERT INTO style_guides (id, name, content, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, content, isDefault, now, now)
  return rowToGuide(db.prepare('SELECT * FROM style_guides WHERE id = ?').get(id) as StyleGuideRow)
}

export function setDefaultStyleGuide(id: string): StyleGuide | null {
  const db = getDb()
  if (!getStyleGuideById(id)) return null
  db.prepare('UPDATE style_guides SET is_default = 0, updated_at = ? WHERE is_default = 1').run(new Date().toISOString())
  db.prepare('UPDATE style_guides SET is_default = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
  return getStyleGuideById(id)
}

export function deleteStyleGuide(id: string): void {
  const db = getDb()
  const guide = getStyleGuideById(id)
  if (!guide) return
  db.prepare('DELETE FROM style_guides WHERE id = ?').run(id)
  if (guide.isDefault) {
    // 删除的是默认规范 → 回退到剩余第一篇作为默认
    const next = db.prepare('SELECT * FROM style_guides ORDER BY created_at ASC LIMIT 1').get() as StyleGuideRow | undefined
    if (next) db.prepare('UPDATE style_guides SET is_default = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), next.id)
  }
}

/** 启动时若规范库为空，写入默认规范（合并后的「志书文体文风与行文规则」） */
export function ensureDefaultStyleGuide(): void {
  const db = getDb()
  const count = db.prepare('SELECT count(*) n FROM style_guides').get() as { n: number }
  if (count.n === 0) {
    const now = new Date().toISOString()
    db.prepare('INSERT INTO style_guides (id, name, content, is_default, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run(crypto.randomUUID(), '志书文体文风与行文规则', DEFAULT_STYLE_GUIDE, now, now)
  }
}

export const STYLE_GUIDE_FALLBACK = DEFAULT_STYLE_GUIDE

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

  describe('style-guides store (Phase 6.4.1)', () => {
    beforeAll(() => { ensureDefaultStyleGuide() })

    it('ensureDefaultStyleGuide seeds a single default guide', () => {
      expect(listStyleGuides()).toHaveLength(1)
      expect(getDefaultStyleGuide()!.isDefault).toBe(true)
      expect(getDefaultStyleGuide()!.content).toContain('文体')
      expect(getDefaultStyleGuide()!.name).toContain('志书')
    })

    it('saveStyleGuide creates new (first non-default becomes default) and updates', () => {
      const a = saveStyleGuide({ name: 'A 规范', content: '甲内容' })
      expect(a.isDefault).toBe(false)
      expect(listStyleGuides()).toHaveLength(2)
      const a2 = saveStyleGuide({ id: a.id, name: 'A 规范改', content: '甲内容改' })
      expect(a2.name).toBe('A 规范改')
      expect(a2.content).toBe('甲内容改')
    })

    it('setDefaultStyleGuide switches default', () => {
      const list = listStyleGuides()
      const target = list.find((g) => !g.isDefault)!
      setDefaultStyleGuide(target.id)
      expect(getDefaultStyleGuide()!.id).toBe(target.id)
      expect(listStyleGuides().filter((g) => g.isDefault)).toHaveLength(1)
    })

    it('deleteStyleGuide removes; deleting default falls back to remaining', () => {
      const def = getDefaultStyleGuide()!
      const other = listStyleGuides().find((g) => g.id !== def.id)!
      deleteStyleGuide(def.id)
      expect(getDefaultStyleGuide()!.id).toBe(other.id)
      expect(listStyleGuides()).toHaveLength(1)
    })
  })
}