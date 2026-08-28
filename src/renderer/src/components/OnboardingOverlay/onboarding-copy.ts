import type { PageKey } from '../SideNav'
import { DEMO_TASK_TITLE } from '../../../../shared/demo'

/**
 * 新手引导步骤定义与文案（2026-08-28 重写）。
 * 借鉴聚合拾遗（HaiDiXiaoZongDui）的"聚光引导"架构：每步通过 CSS 选择器定位界面元素，
 * 用遮罩挖洞 + 高亮框突出目标，配合提示卡片逐步讲解核心功能闭环。
 * 步骤顺序即推荐使用流程：配置大模型（手动 / 预设）→ 选择工作区 → 了解资料库 → 演示任务 → 三步生成初稿。
 */
export type OnboardingStepId = 'llm' | 'preset' | 'workspace' | 'library' | 'demoTask' | 'writingFlow'

export interface OnboardingStep {
  id: OnboardingStepId
  /** 该步骤需要切换到的功能区页面 */
  page: PageKey
  /** 定位目标元素的 CSS 选择器列表（对应各组件上的 data-onboarding 锚点）；一个步骤可同时高亮多个模块 */
  targets: string[]
  /** 高亮框在目标四周的额外留白（px） */
  padding: number
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  // 第 1 步文案同时讲了「LLM Provider 配置」与「步骤默认模型」，因此同时框选这两个模块
  { id: 'llm', page: 'settings', targets: ['[data-onboarding="settings-provider"]', '[data-onboarding="settings-step-models"]'], padding: 8 },
  { id: 'preset', page: 'settings', targets: ['[data-onboarding="settings-preset"]'], padding: 8 },
  { id: 'workspace', page: 'settings', targets: ['[data-onboarding="settings-workspace"]'], padding: 8 },
  { id: 'library', page: 'sources', targets: ['[data-onboarding="sources-library"]'], padding: 8 },
  { id: 'demoTask', page: 'writing', targets: ['[data-onboarding="writing-demo-task"]'], padding: 8 },
  { id: 'writingFlow', page: 'writing', targets: ['[data-onboarding="writing-stepper"]'], padding: 8 }
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
      title: '第 1 步：配置大模型（手动）',
      description:
        '在「设置 → 大模型」里点击「添加 Provider」，填写接口地址（apiBase）、模型名与 API Key。' +
        '也可在此为「第 1 步（资料汇编）」和「第 3 步（生成初稿）」分别指定默认大模型；所有 AI 能力都依赖它，因此这是使用软件的第一步。',
      hint: '请先完成此步；没有大模型时软件将退回本地降级（只能生成未细读的候选卡片）。'
    },
    preset: {
      title: '第 2 步：使用预设大模型参数',
      description:
        '不想手动填参数？在「设置 → 预设」里已经内置了 DeepSeek、通义千问、智谱等常用模型。' +
        '点击「使用」即可自动填入接口与模型名，再点「获取 API Key」查看该平台的注册/开通教程，拿到 Key 后填回并测试连接即可。',
      hint: '两种配置方式二选一即可，预设更省事；手动适合接入自定义接口。'
    },
    workspace: {
      title: '第 3 步：设置工作区文件夹',
      description:
        '指定一个本地文件夹作为「资料库」。软件会自动扫描其中的 Word / PDF / Excel / 纯文本等文档作为原始资料，' +
        '并在文件新增、修改、删除时自动同步入库；已导入的历史资料也可从这里一键迁移到工作区。',
      hint: '只读取你指定的文件夹，保证资料闭环与本地优先。'
    },
    library: {
      title: '第 4 步：了解资料库',
      description:
        '「资料」页集中管理全部原始资料：可手动导入文件、添加信源网址、注册网页资料库（生成时自动检索相关文章），' +
        '并打标签、搜索、预览全文与管理标签。生成资料汇编与初稿时，只会使用这里的资料，绝不引入外部知识。',
      hint: '新用户可先添加几篇相关材料；本教程的演示任务自带两份任务级演示材料。'
    },
    demoTask: {
      title: '演示任务（仅作为演示）',
      description:
        '为避免任务列表为空时无从下手，软件已为你预制一个「' + DEMO_TASK_TITLE + '」。' +
        '点击它即可打开：左侧对话历史、右侧三步工作台，并已预置「资料汇编（含矛盾与二次改动）」和「志书初稿」，' +
        '方便你逐个环节对照理解。',
      hint: '该任务仅供演示，可随意操作；不满意也可在右键菜单删除它。'
    },
    writingFlow: {
      title: '三步生成志书初稿',
      description:
        '撰写工作台分三步：① 生成「资料汇编」——AI 细读资料产出事实卡片，并根据需要进行矛盾标注（不同来源相左）与语义补全/修订，处理完矛盾后「确认汇编」；' +
        '② 指定「行文规范」——确认默认规范，也可参考范本；③ 生成「志书初稿」——基于已确认汇编与规范一键成稿，生成后仍可在编辑器继续修改、框选正文「询问来源」。',
      hint: '当前演示任务已走完三步，点击顶部 ①②③ 可来回查看每一阶段的成果。'
    }
  }
}
