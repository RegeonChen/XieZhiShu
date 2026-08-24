// 界面文案集中管理（后续本地化以本文件为基线）
export const zhCN = {
  appTitle: '志书撰写工具',
  common: {
    cancel: '取消',
    deleting: '删除中...',
    loading: '加载中...',
    confirm: '确认操作'
  },
  contextMenu: {
    copy: '复制',
    cut: '剪切',
    paste: '粘贴',
    selectAll: '全选'
  },
  nav: {
    sources: '资料库',
    writing: '撰写',
    skills: '规范',
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
      listTitle: '写作规范',
      listEmpty: '',
      detailTitle: '写作规范',
      detailHint: '管理志书写作规范（通用规范 + 部类细则），生成初稿时自动注入相应规范。'
    },
    writing: {
      listTitle: '撰写任务',
      listEmpty: '暂无任务',
      detailTitle: '请选择或新建一个撰写任务以开始您的工作',
      detailHint: ''
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
    platform: '平台',
    hideCenter: '隐藏中栏',
    showCenter: '显示中栏'
  },
  sourceMenu: {
    tooltip: '功能菜单',
    tagManage: '标签管理',
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
    deleteTitle: '删除选中资料',
    confirmDelete: '确定要删除选中的 {count} 项资料吗？删除后无法恢复。'
  },
  sourceContext: {
    delete: '删除该资料',
    deleteTitle: '删除资料',
    confirmDelete: '确定要删除「{title}」吗？删除后无法恢复。'
  },
  sourceList: {
    importing: '导入中...',
    emptyHint: '暂无资料。导入文件，或在下方「网页资料库」注册网站。',
    summarizeBtn: '整理资料',
    summarizing: '整理中...',
    summarizeDone: '整理完成：成功 {ok} 篇，失败 {failed} 篇',
    summarizeEmpty: '没有需要整理的资料',
    summarizeFailed: '整理失败：{message}',
    workspaceStatus: '工作区：{dir}',
    workspaceUnset: '未设置工作区（可在设置页指定本地文件夹作为资料库）',
    syncingProgress: '正在同步 {done}/{total} ...',
    preprocessHint: '正在预处理新添加的文件…由于后台进程正在处理，软件可能存在短暂卡顿',
    reconcileDone: '同步完成：新增 {added}、变更 {changed}、移除 {removed}、移动 {moved}、失败 {errors}',
    infoImport: '将本地文件导入资料库，作为撰写志书的资料来源；也可在下方「网页资料库」中注册网站，生成初稿时自动检索相关文章。',
    infoSummarize: '对工作区内所有资料逐篇生成预处理信息，供撰写初稿时的资料粗筛使用；后续的撰写任务中，已整理过的资料不会重复整理，如果您想提升之后撰写初稿的效率，可以先进行此操作'
  },
  webSource: {
    title: '网页资料库',
    hint: '注册网站后，每次生成初稿时会自动检索该网站中与撰写要求相关的文章并抓取正文，与本地文件同等参与资料粗筛、矛盾检测与来源溯源。',
    urlPlaceholder: '输入网站首页网址（如 https://fzxq.fuzhou.gov.cn/）',
    titlePlaceholder: '站点名称（可选）',
    add: '注册',
    adding: '注册中...',
    empty: '尚未注册网页资料库',
    sync: '同步',
    syncing: '同步中...',
    remove: '删除',
    removeConfirm: '确定删除网页资料库「{title}」吗？已抓取的文章资料会保留。',
    syncDone: '同步完成，发现 {added} 篇新文章',
    added: '注册成功',
    syncedAt: '上次同步：{time}',
    neverSynced: '尚未同步',
    operationFailed: '操作失败：{message}'
  },
  skills: {
    title: '写作规范',
    hint: '固化志书写作规范：通用规范默认注入所有生成，部类细则按小节标题匹配注入。预设规范可修改，也可自建。',
    nav: {
      title: '规范导航',
      hint: '点击条目快速跳转到对应规范区块',
      overview: '总览',
      general: '通用规范',
      section: '部类细则'
    },
    overview: {
      title: '写作规范库',
      hint: '通用规范默认注入所有生成任务；部类细则按撰写标题自动匹配，也可智能匹配或手动选择。预设规范可修改，也可自建。',
      generalCount: '通用规范 {count} 条',
      sectionCount: '部类细则 {count} 条',
      presetCount: '预设 {count} 条'
    },
    generalHint: '默认注入所有生成任务（文体文风与行文规则等）',
    sectionHint: '按撰写标题匹配 / 智能匹配 / 手动选择',
    noGeneral: '暂无通用规范',
    noSection: '暂无部类细则规范',
    searchClear: '清空搜索',
    newBtn: '新建规范',
    loading: '加载中...',
    empty: '暂无规范',
    searchPlaceholder: '搜索规范（名称/关键词，支持模糊匹配）',
    noMatch: '无匹配的规范',
    general: '通用规范',
    section: '部类细则',
    preset: '预设',
    edit: '编辑',
    remove: '删除',
    removeConfirm: '确定删除规范「{name}」吗？',
    newTitle: '新建写作规范',
    editTitle: '编辑写作规范',
    nameLabel: '名称',
    namePlaceholder: '如：学前教育',
    categoryLabel: '类型',
    tagsLabel: '匹配关键词（逗号分隔）',
    tagsPlaceholder: '如：学前教育,幼儿园,保育',
    contentLabel: '规范内容',
    contentPlaceholder: '蒸馏后的写作规范要点（该小节记什么、按什么结构、避免什么）',
    cancel: '取消',
    save: '保存',
    saving: '保存中...',
    loadFailed: '加载失败',
    emptyFields: '请填写名称与规范内容',
    saveFailed: '保存失败',
    deleteFailed: '删除失败'
  },
  sourceViewer: {
    summaryTitle: '资料摘要',
    keywords: '主题词',
    entities: '关键实体',
    back: '返回',
    copyText: '复制全文',
    copied: '已复制'
  },
  sourceStatus: {
    ready: '已就绪',
    failed: '失败',
    pending: '排队中',
    processing: '处理中'
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
      deleteTitle: '删除标签',
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
    subtitle: '配置本地工作区与模型服务，所有数据仅保存在本机。',
    onboardingBtn: '新手教程',
    nav: {
      title: '设置导航',
      hint: '点击条目快速跳转到对应设置区块',
      overview: '总览',
      workspace: '工作区资料库',
      preset: '预设大模型',
      provider: '模型服务（Provider）'
    },
    overview: {
      title: '欢迎使用志书撰写工具',
      hint: '完成以下配置即可开始撰写：选择工作区资料库 → 配置大模型 → 新建撰写任务。所有用户数据均保存在本地。',
      providerLabel: '当前大模型',
      providerNone: '未选择',
      workspaceLabel: '工作区',
      workspaceNone: '未设置'
    },
    exportLog: {
      btn: '导出日志',
      exporting: '导出中...',
      done: '日志已导出：{path}',
      failed: '导出失败：{message}'
    },
    preset: {
      title: '预设大模型',
      hint: '无需手动查找地址：选择一个预设模型，点击「使用此模型」自动填充配置；点击「获取 API key」查看该模型的注册与密钥获取教程。',
      useBtn: '使用此模型',
      getKeyBtn: '获取 API key',
      getKeyFailed: '打开注册页失败：{message}'
    },
    presetGuide: {
      title: '获取 API key 教程',
      hint: '获取密钥后回到「设置」页，点击该模型的「使用此模型」并填入密钥，即可开始调用。',
      closeBtn: '关闭',
      openSignupBtn: '打开注册页'
    },
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
      deleteTitle: '删除 Provider',
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
    },
    workspace: {
      title: '工作区资料库',
      hint: '指定一个本地文件夹作为资料库：文件夹内（含多级子目录）的支持文件会被自动读取、解析与理解并同步到软件；软件内对资料的删除/改名也会同步回该文件夹。',
      current: '当前工作区',
      notSet: '尚未设置工作区',
      configured: '已配置',
      notConfigured: '未设置',
      chooseBtn: '选择文件夹',
      clearBtn: '清除工作区',
      migrateBtn: '迁移旧资料到工作区',
      migrating: '迁移中...',
      migrateHint: '将此前通过「导入文件」存入的旧资料一次性移动到工作区。',
      migrateDone: '迁移完成：成功 {migrated} 项，失败 {failed} 项，跳过 {skipped} 项',
      migrateFailed: '迁移失败：{message}',
      saving: '保存中...',
      saved: '工作区已更新',
      failed: '操作失败：{message}'
    }
  },
  writingTasks: {
    empty: '暂无撰写任务，点击上方「新建任务」开始。',
    newBtn: '新建任务',
    loadFailed: '加载失败：{message}',
    loading: '加载中...',
    deleteBtn: '删除该任务',
    deleteTitle: '删除撰写任务',
    deleteConfirm: '确定要删除撰写任务「{title}」吗？该任务下的全部志稿与片段将一并删除，且无法恢复。',
    deleteFailed: '删除失败：{message}',
    renameBtn: '重命名',
    renameTitle: '重命名撰写任务',
    renameLabel: '任务标题（仅显示在中栏列表中；文章标题由大模型从撰写要求中提取）',
    renameFailed: '重命名失败：{message}'
  },
  writingEmpty: {
    title: '还没有撰写任务',
    hint: '新建撰写任务并生成初稿后，将在这里展示志稿片段与审核操作。',
    createBtn: '新建任务',
    createFailed: '创建失败：{message}'
  },
  writingChat: {
    inputPlaceholder: '输入本次撰写的标题与要求，或与助手对话…',
    sendBtn: '发送',
    generateBtn: '生成初稿',
    generating: '正在整理资料摘要并生成初稿（资料较多时可能需要数分钟，请耐心等待）...',
    regenerating: '正在整理资料摘要并重新生成初稿（资料较多时可能需要数分钟，请耐心等待）...',
    generated: '初稿《{title}》已生成。',
    generateFailed: '生成失败：{message}',
    chatFailed: '对话失败：{message}',
    regenerateBtn: '重新生成初稿',
    regenerateConfirmTitle: '重新生成初稿',
    regenerateConfirmMessage: '将丢弃当前第 0 稿（含你的修改），按当前要求与资料重新生成。确定继续？',
    regenerateConfirmBtn: '重新生成',
    skillLabel: '写作规范',
    skillAuto: '未手动选定（生成时自动匹配）',
    suggestBtn: '智能匹配',
    suggesting: '匹配中...',
    suggestNeedEmpty: '请先在下方输入撰写要求，再进行智能匹配',
    pickBtn: '手动选择',
    providerLabel: '大模型',
    providerNone: '跟随全局设置',
    providerLockHint: '（请先在「设置」页配置大模型）',
    noDraftHint: '在下方对话框中输入本次撰写的标题与要求（如"这次撰写任务的标题为……"），点击「生成初稿」开始。',
    emptyChat: '还没有对话。在下方输入撰写要求，点击「生成初稿」开始。',
    /** 生成进度剩余时间（2026-08-11：进度条旁展示） */
    etaText: '预计还需 {time}',
    copyReply: '复制该回复',
    copied: '已复制',
    openSourceHint: '打开来源文件：《{title}》',
    thinking: '正在思考',
    emptyHintTitle: '开始你的第一篇志稿',
    emptyHintSteps: '1. 在下方输入本次撰写的标题与要求\n2. 可先「智能匹配」或「手动选择」写作规范\n3. 点击「生成初稿」，等待初稿完成'
  },
  skillPicker: {
    title: '手动选择写作规范',
    searchPlaceholder: '搜索规范（名称/关键词，支持模糊匹配）',
    noMatch: '无匹配的规范',
    selected: '已选 {count} 项',
    confirm: '确定',
    cancel: '取消'
  },
  writingWorkspace: {
    taskTitle: '撰写任务：{title}',
    articleTitle: '文章标题：《{title}》',
    loading: '加载中...',
    loadFailed: '加载失败：{message}'
  },
  draftEditor: {
    saving: '保存中...',
    saved: '已保存',
    saveFailed: '保存失败',
    copyAll: '复制全文',
    copied: '已复制',
    askSource: '询问文段来源',
    charCount: '{count} 字',
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
      redo: '重做',
      contradictions: '矛盾 {count}',
      contradictionsNone: '矛盾',
      contradictionsTitle: '查看矛盾清单（{count} 项待处理）',
      warnings: '警告 {count}',
      warningsNone: '警告',
      warningsTitle: '查看资料矛盾警告（{count} 项待处理）'
    }
  },
  contradiction: {
    dialogTitle: '矛盾清单',
    singleTitle: '矛盾 #{seq}',
    warningsDialogTitle: '资料矛盾警告',
    warningSingleTitle: '警告 #{seq}',
    warningTag: '警告',
    empty: '当前初稿没有检测到材料矛盾。',
    emptyWarnings: '没有不在正文中的资料矛盾警告。',
    kindLabel: '类型',
    kinds: {
      data: '数据',
      time: '时间',
      place: '地点',
      fact: '事实经过',
      other: '其他'
    },
    statusPending: '待处理',
    statusAdopted: '已采纳',
    statusIgnored: '已忽略',
    draftQuoteLabel: '正文定位',
    noQuote: '（未能定位到正文）',
    variantsLabel: '相左说法',
    sourceLabel: '来源文件',
    adopt: '采纳该说法',
    ignore: '忽略该矛盾',
    back: '返回清单',
    mergedHint: '⚠ 正文疑似将相左说法合并/折中，请人工核对原文',
    warningNotInDraft: '该矛盾点未出现在当前初稿正文中，仅作为资料库潜在风险提示，不影响正文。',
    applying: '正在更新正文…',
    applied: '已采纳该说法并同步更新正文',
    operationFailed: '操作失败',
    openFailed: '打开来源文件失败：{message}'
  }
} as const

export type AppLocale = typeof zhCN
