// 界面文案集中管理（后续本地化以本文件为基线）
export const zhCN = {
  appTitle: '志书撰写工具',
  nav: {
    sources: '资料库',
    writing: '撰写',
    versions: '版本管理',
    templates: '范本',
    settings: '设置'
  },
  panes: {
    sources: {
      listTitle: '全部资料',
      listEmpty: '暂无资料',
      detailTitle: '还没有资料',
      detailHint: '导入文件或添加信源网址后，将在这里展示与管理资料。'
    },
    templates: {
      listTitle: '范本管理',
      listEmpty: '',
      detailTitle: '范本管理',
      detailHint: '上传历年成品志书作为范本，供撰写任务参照体例。'
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
  },
  sourceMenu: {
    tooltip: '功能菜单',
    manage: '资料管理'
  },
  sourceBulk: {
    title: '资料管理',
    selectAll: '全选',
    deselectAll: '取消全选',
    deleteSelected: '删除选中',
    exit: '取消',
    selectedCount: '已选 {count} 项',
    empty: '暂无资料',
    confirmDelete: '确定要删除选中的 {count} 项资料吗？删除后无法恢复。'
  },
  sourceContext: {
    delete: '删除该资料',
    confirmDelete: '确定要删除「{title}」吗？删除后无法恢复。'
  },
  sourceDelete: {
    success: '删除成功',
    failed: '删除失败：{message}'
  },
  tagManager: {
    title: '标签管理',
    tabs: ['新建标签', '添加标签', '删除标签', '按标签检索'],
    create: {
      namePlaceholder: '输入新标签名称...',
      createBtn: '创建',
      similarTitle: '已有的相似标签：',
      empty: '暂无匹配的相似标签',
      created: '标签「{name}」已创建',
      existed: '标签「{name}」已存在',
      failed: '创建失败：{message}'
    },
    add: {
      selectTagHint: '请先选择一个标签',
      selectTagTitle: '选择要添加的标签：',
      selectSourcesTitle: '为以下资料添加该标签：',
      selectAll: '全选',
      deselectAll: '取消全选',
      confirmAdd: '确认添加',
      adding: '添加中...',
      added: '已为 {count} 项资料添加标签',
      empty: '暂无标签或资料',
      count: '已选 {count} 项',
      noSources: '暂无资料'
    },
    remove: {
      selectTagTitle: '选择一个要删除的标签：',
      deleteBtn: '删除该标签',
      confirmDelete: '确定要删除标签「{name}」吗？所有资料上的该标签关联将一并清除。',
      deleted: '标签已删除',
      noTags: '暂无标签',
      selectHint: '请先选择一个标签'
    },
    search: {
      title: '选择标签（支持多选，取交集）：',
      resultTitle: '检索结果：',
      noSelection: '请选择至少一个标签',
      empty: '没有同时具有所选标签的资料',
      count: '共 {count} 项',
      noTags: '暂无标签'
    }
  },
  settingsPage: {
    title: '设置',
    provider: {
      title: 'LLM Provider 配置',
      hint: '配置 OpenAI-compatible 模型服务（兼容 DeepSeek、通义等），密钥仅加密保存在本地。',
      addBtn: '新建 Provider',
      empty: '暂无 Provider，点击上方按钮添加模型服务。',
      currentBadge: '当前使用',
      currentAction: '设为当前',
      keySet: '已设置',
      keyUnset: '未设置',
      testBtn: '测试连接',
      editBtn: '编辑',
      deleteBtn: '删除',
      deleteConfirm: '确定要删除 Provider「{name}」吗？',
      testing: '测试中...',
      testSuccess: '连接成功',
      testFailed: '连接失败：{message}',
      loading: '加载中...',
      loadFailed: '加载失败：{message}',
      saveFailed: '保存失败：{message}',
      deleteFailed: '删除失败：{message}',
      setCurrentFailed: '设置当前 Provider 失败：{message}',
      createTitle: '新建 Provider',
      editTitle: '编辑 Provider',
      saveBtn: '保存',
      cancelBtn: '取消',
      fields: {
        name: '名称',
        namePlaceholder: '如：DeepSeek',
        apiBase: 'API 地址',
        apiBasePlaceholder: 'https://api.deepseek.com/v1',
        model: '模型名',
        modelPlaceholder: '如：deepseek-chat',
        apiKey: 'API 密钥',
        apiKeyPlaceholder: '请输入 API 密钥',
        apiKeyHint: '已设置密钥，留空保持不变'
      }
    }
  },
  writingTasks: {
    empty: '暂无撰写任务，点击上方「新建任务」开始。',
    newBtn: '新建任务',
    version: '第 {version} 稿',
    loadFailed: '加载失败：{message}',
    loading: '加载中...',
    deleteBtn: '删除该任务',
    deleteConfirm: '确定要删除撰写任务「{title}」吗？该任务下的全部志稿与片段将一并删除，且无法恢复。',
    deleteFailed: '删除失败：{message}'
  },
  writingPage: {
    createTitle: '新建撰写任务',
    createHint: '填写标题并选择文件范围（手动勾选资料或按标签选择），可选用范本。',
    submitBtn: '创建任务',
    cancelBtn: '取消',
    createFailed: '创建失败：{message}',
    scopeRequired: '请至少选择一项资料或标签作为文件范围',
    fields: {
      title: '撰写标题',
      titlePlaceholder: '如：新区教育事业发展',
      scope: '文件范围',
      scopeSource: '手动选择资料',
      scopeTag: '按标签选择',
      template: '参照范本（可选）',
      templateNone: '不使用范本',
      sourceSelected: '已选 {count} 项资料',
      tagSelected: '已选 {count} 个标签',
      selectAll: '全选',
      deselectAll: '取消全选'
    },
    loadSourcesFailed: '加载资料失败：{message}',
    loadTagsFailed: '加载标签失败：{message}',
    loadTemplatesFailed: '加载范本失败：{message}'
  },
  writingWorkspace: {
    taskTitle: '撰写任务：{title}',
    scopeCount: '文件范围：共 {count} 项资料',
    scopeTagCount: '文件范围：{count} 个标签',
    noDraft: '尚未生成初稿。先「检索预览」确认将引用的资料片段，再生成初稿。',
    generateBtn: '生成初稿',
    generating: '正在检索资料并生成初稿（可能需要数十秒）...',
    generateFailed: '生成失败：{message}',
    generateSuccess: '初稿已生成',
    retrieveBtn: '检索预览',
    retrieving: '检索中...',
    retrieveEmpty: '未检索到与标题相关的资料片段',
    retrieveFailed: '检索失败：{message}',
    retrievalTitle: '检索到的相关资料片段（{count}）',
    draftTitle: '第 {version} 稿',
    segmentSources: '来源（{count}）',
    segmentSourceLine: '《{title}》 {position}',
    segmentQuote: '原文摘句：{quote}',
    loading: '加载中...',
    loadFailed: '加载失败：{message}'
  },
  draftEditor: {
    saving: '保存中...',
    saved: '已保存',
    saveFailed: '保存失败',
    toolbar: {
      bold: '粗体',
      italic: '斜体',
      underline: '下划线',
      heading: '标题',
      paragraph: '正文',
      bulletList: '无序列表',
      orderedList: '有序列表',
      insertTable: '插入表格',
      addRow: '下方插入行',
      deleteRow: '删除行',
      addColumn: '右侧插入列',
      deleteColumn: '删除列',
      deleteTable: '删除表格',
      undo: '撤销',
      redo: '重做'
    }
  }
} as const

export type AppLocale = typeof zhCN
