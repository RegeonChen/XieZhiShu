import type { PageKey } from '../SideNav'

/**
 * 新手引导步骤定义与文案（2026-08-14）。
 * 借鉴聚合拾遗（HaiDiXiaoZongDui）的"聚光引导"架构：每步通过 CSS 选择器定位界面元素，
 * 用遮罩挖洞 + 高亮框突出目标，配合提示卡片逐步讲解核心功能闭环。
 * 步骤顺序即推荐使用流程：配置大模型 → 选择工作区 → 添加网页资料库 → 管理规范 → 新建撰写任务。
 */
export type OnboardingStepId = 'llm' | 'workspace' | 'webSource' | 'skills' | 'task'

export interface OnboardingStep {
  id: OnboardingStepId
  /** 该步骤需要切换到的功能区页面 */
  page: PageKey
  /** 定位目标元素的 CSS 选择器（对应各组件上的 data-onboarding 锚点） */
  target: string
  /** 高亮框在目标四周的额外留白（px） */
  padding: number
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  { id: 'llm', page: 'settings', target: '[data-onboarding="settings-provider"]', padding: 8 },
  { id: 'workspace', page: 'settings', target: '[data-onboarding="settings-workspace"]', padding: 8 },
  { id: 'webSource', page: 'sources', target: '[data-onboarding="web-source"]', padding: 8 },
  { id: 'skills', page: 'templates', target: '[data-onboarding="skills"]', padding: 8 },
  { id: 'task', page: 'writing', target: '[data-onboarding="writing-new-task"]', padding: 8 }
]

export const ONBOARDING_COPY = {
  eyebrow: '志书撰写工具 · 快速上手',
  progress: (current: number, total: number): string => `第 ${current} / ${total} 步`,
  previous: '上一步',
  next: '下一步',
  finish: '开始使用',
  skip: '跳过引导',
  locating: '正在定位界面…',
  reopenHint: '以后可在「设置」页重新打开新手引导。',
  steps: {
    llm: {
      title: '配置大模型',
      description: '在这里添加并选择一个大模型服务（如 DeepSeek、通义千问等），填写 API Key 即可。生成初稿、矛盾扫描、智能匹配规范都依赖它，这是使用本软件的第一步。',
      hint: '可从下方的预设中一键填入常用模型，再补上 API Key。'
    },
    workspace: {
      title: '选择工作区文件夹',
      description: '指定一个本地文件夹作为资料库，软件会自动扫描其中的 Word / PDF 等文档，作为撰写志书的原始资料。',
      hint: '之前已导入的资料可在此一键迁移到工作区。'
    },
    webSource: {
      title: '添加网页资料库',
      description: '注册一个网站（如地方志网站），生成初稿时软件会自动检索该网站中与撰写要求相关的文章，并抓取正文参与写作与矛盾检测。',
      hint: '网页文章作为任务临时缓存，删除任务后自动清理。'
    },
    skills: {
      title: '管理写作规范',
      description: '这里固化了志书写作规范（通用规范 + 部类细则）。生成初稿时会自动注入匹配的规范，你也可以新建、修改或搜索所需规范。',
      hint: '撰写时支持「智能匹配」或「手动选择」规范。'
    },
    task: {
      title: '新建撰写任务',
      description: '在「撰写」页新建任务，输入撰写要求并生成初稿。软件会自动完成资料粗筛、矛盾扫描，最终生成一篇规范的志书初稿。',
      hint: '生成后的正文可继续编辑，矛盾与警告会标注在正文中。'
    }
  }
}
