/// <reference types="vitest/importMeta" />
/**
 * llm-presets.ts —— 内置主流大模型预设配置（Phase 3.6）。
 * 纯数据、无 node 依赖，前后端共用；用于设置页"预设模型"快捷接入：
 * 点「使用此模型」自动填充 name/apiBase/model，点「获取 API key」弹出各模型专属教程。
 */
export interface LlmPresetStep {
  /** 步骤标题，如 "注册账号" */
  title: string
  /** 步骤说明 */
  text: string
}

export interface LlmPreset {
  id: string
  /** 厂商，如 DeepSeek / 智谱 AI */
  vendor: string
  /** 显示名，如 "DeepSeek v4 Flash" */
  name: string
  /** 模型名，如 deepseek-v4-flash */
  model: string
  /** API 地址（OpenAI 兼容，chat 层自动拼 /chat/completions） */
  apiBase: string
  /** 价格标签（含"免费"字样时前端用绿色标签） */
  pricing: string
  /** 官方注册/开放平台地址 */
  signupUrl: string
  /** 该模型专属的"注册 → 获取 API key"教程步骤 */
  guide: LlmPresetStep[]
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'deepseek-v4-flash',
    vendor: 'DeepSeek',
    name: 'DeepSeek v4 Flash',
    model: 'deepseek-v4-flash',
    apiBase: 'https://api.deepseek.com',
    pricing: '付费（按量·低价）',
    signupUrl: 'https://platform.deepseek.com',
    guide: [
      { title: '注册账号', text: '打开 DeepSeek 开放平台 platform.deepseek.com，点击右上角「注册」，使用手机号或邮箱完成注册并登录。' },
      { title: '创建 API Key', text: '登录后进入「API Keys」页面，点击「创建 API Key」。若提示需实名认证，按页面指引完成（手机号 + 身份证验证）。' },
      { title: '复制 API Key', text: '创建成功后复制以 sk- 开头的密钥。注意：该密钥只完整显示一次，请立即保存到安全位置。' },
      { title: '充值开通', text: '该模型为按量付费，需在「费用中心」充值后才可调用（新注册用户通常有少量免费体验额度）。' },
      { title: '填入软件', text: '回到本软件设置页，点击该预设的「使用此模型」，在「API 密钥」处粘贴 Key，点击「保存」后即可「测试连接」。' }
    ]
  },
  {
    id: 'deepseek-v4-pro',
    vendor: 'DeepSeek',
    name: 'DeepSeek v4 Pro',
    model: 'deepseek-v4-pro',
    apiBase: 'https://api.deepseek.com',
    pricing: '付费（按量）',
    signupUrl: 'https://platform.deepseek.com',
    guide: [
      { title: '注册账号', text: '打开 DeepSeek 开放平台 platform.deepseek.com，点击「注册」，使用手机号或邮箱完成注册并登录。' },
      { title: '创建 API Key', text: '登录后进入「API Keys」页面，点击「创建 API Key」，按指引完成实名认证。' },
      { title: '复制 API Key', text: '复制以 sk- 开头的密钥并立即保存（仅完整显示一次）。' },
      { title: '充值开通', text: 'v4 Pro 为按量付费，需在「费用中心」充值后调用。' },
      { title: '填入软件', text: '回到软件设置页，点「使用此模型」→ 粘贴 Key → 保存 → 「测试连接」。' }
    ]
  },
  {
    id: 'zhipu-glm-4-flash',
    vendor: '智谱 AI',
    name: '智谱 GLM-4-Flash',
    model: 'glm-4-flash',
    apiBase: 'https://open.bigmodel.cn/api/paas/v4',
    pricing: '免费（永久）',
    signupUrl: 'https://open.bigmodel.cn',
    guide: [
      { title: '注册账号', text: '打开智谱 AI 开放平台 open.bigmodel.cn，使用手机号注册并登录。' },
      { title: '完成实名认证', text: '进入「控制台 → 账户管理 → 实名认证」，完成个人实名认证（手机号验证即可）。' },
      { title: '创建 API Key', text: '进入「控制台 → API Key」，点击右上角「新建 API Key」，填写名称后生成。' },
      { title: '复制 API Key', text: '复制生成的 API Key 并立即保存（仅显示一次）。' },
      { title: '填入软件', text: '回到软件设置页，点「使用此模型」→ 粘贴 Key → 保存 → 「测试连接」。GLM-4-Flash 永久免费，无需充值。' }
    ]
  }
]

/** 按 id 查找预设，未找到返回 undefined */
export function findLlmPreset(id: string): LlmPreset | undefined {
  return LLM_PRESETS.find((p) => p.id === id)
}

// ---- vitest inline test ----
if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('llm presets (Task 3.6)', () => {
    it('preset fields are non-empty and unique', () => {
      const ids = LLM_PRESETS.map((p) => p.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const p of LLM_PRESETS) {
        expect(p.name.length).toBeGreaterThan(0)
        expect(p.vendor.length).toBeGreaterThan(0)
        expect(p.model.length).toBeGreaterThan(0)
        expect(p.pricing.length).toBeGreaterThan(0)
        expect(p.apiBase).toMatch(/^https?:\/\//)
        expect(p.signupUrl).toMatch(/^https?:\/\//)
        expect(p.guide.length).toBeGreaterThan(0)
        for (const step of p.guide) {
          expect(step.title.length).toBeGreaterThan(0)
          expect(step.text.length).toBeGreaterThan(0)
        }
      }
    })

    it('covers the required three presets with expected models', () => {
      expect(findLlmPreset('deepseek-v4-flash')?.model).toBe('deepseek-v4-flash')
      expect(findLlmPreset('deepseek-v4-pro')?.model).toBe('deepseek-v4-pro')
      expect(findLlmPreset('zhipu-glm-4-flash')?.model).toBe('glm-4-flash')
    })

    it('return undefined for unknown id', () => {
      expect(findLlmPreset('no-such-id')).toBeUndefined()
    })
  })
}
