// 界面文案集中管理（后续本地化以本文件为基线）
export const zhCN = {
  appTitle: '志书撰写工具',
  nav: {
    sources: '资料库',
    writing: '撰写',
    versions: '版本管理',
    settings: '设置'
  },
  panes: {
    sources: {
      listTitle: '全部资料',
      listEmpty: '暂无资料',
      detailTitle: '还没有资料',
      detailHint: '导入文件或添加信源网址后，将在这里展示与管理资料。'
    },
    writing: {
      listTitle: '撰写任务',
      listEmpty: '暂无任务',
      detailTitle: '还没有撰写任务',
      detailHint: '新建撰写任务并生成初稿后，将在这里展示志稿片段与审核操作。'
    },
    versions: {
      listTitle: '版本列表',
      listEmpty: '暂无版本',
      detailTitle: '暂无版本记录',
      detailHint: '完成撰写任务的版本确认后，将在这里查看、对比、回滚版本。'
    },
    settings: {
      listTitle: '设置项',
      listEmpty: '',
      detailTitle: '设置',
      detailHint: 'LLM Provider 配置与通用设置将在后续开发阶段提供。'
    }
  },
  topbar: {
    version: '版本',
    platform: '平台'
  }
} as const

export type AppLocale = typeof zhCN
