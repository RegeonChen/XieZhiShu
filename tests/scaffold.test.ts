import { describe, expect, it } from 'vitest'

// Task 1.1 脚手架验证：确认测试运行器可用，作为后续各模块针对性测试的基础
describe('scaffold', () => {
  it('test runner works', () => {
    expect(1 + 1).toBe(2)
  })
})
