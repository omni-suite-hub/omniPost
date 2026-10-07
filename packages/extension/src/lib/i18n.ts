/**
 * 轻量 i18n：仅支持中文 / 英文。
 *
 * 设计：以「中文原文」作为 key，`t(zh, lang)` 在英文模式下查 EN_MAP 返回英文，
 * 未收录时回退中文（保证不因漏翻而显示空白或 key）。默认语言取浏览器语言。
 *
 * 约定：所有展示到页面的文字必须经 t() 翻译；新增文案时同步补 EN_MAP。
 */
export type Lang = 'zh' | 'en';

/** 中文原文 → 英文 */
export const EN_MAP: Record<string, string> = {
  // —— header ——
  '一次撰写 · 全网一键分发': 'Write once · Publish everywhere',
  '打开 OmniPost 发布助手（右侧面板）': 'Open OmniPost publishing assistant (side panel)',
  '刷新平台登录态': 'Refresh platform login status',
  '发布历史': 'Publish history',
  '平台 API 与账号设置': 'Platform API & account settings',

  // —— 内容来源 Tab ——
  'AI 生成': 'AI Generate',
  '手动编辑': 'Manual edit',
  '一句话生成文案': 'Generate copy in one sentence',
  '提取 / 上传 / 手动': 'Extract / Upload / Manual',

  // —— AI 生成区 ——
  '描述你要生成的内容，例如：写一篇 800 字关于「2026 年 AI 编程助手横向对比」的文章，面向技术博主':
    'Describe the content you want, e.g. "Write an 800-word article comparing AI coding assistants in 2026 for tech bloggers"',
  '一键生成文案': 'Generate copy',
  '生成中…': 'Generating…',
  '生成后自动填入标题与正文，可预览/编辑后一键发布到已选平台。API Key 在设置面板（⚙）配置。':
    'The generated title and body will be auto-filled; preview/edit then publish to selected platforms. Configure the API key in Settings (⚙).',

  // —— 编辑区 ——
  '文章 / 动态标题（可选）': 'Article / post title (optional)',
  '从当前页提取': 'Extract from current page',
  '提取中…': 'Extracting…',
  '从当前标签页提取文章正文与标题': 'Extract article body and title from the current tab',
  '编辑': 'Edit',
  '预览': 'Preview',
  '点击返回编辑': 'Click to return to edit',
  '暂无内容，点击此处返回编辑…': 'No content yet, click here to return to edit…',
  '在此撰写正文或 Markdown 内容，将自动适配各平台排版...（可直接拖拽图片/视频到此处）':
    'Write the body or Markdown here; it will auto-adapt to each platform… (drag images/videos here)',
  '模板：': 'Templates:',
  '已填入「': 'Filled "',
  '」模板，请补充内容': '" template, please complete the content',
  '清空': 'Clear',
  '清空标题、正文与媒体（保留平台选择与设置）': 'Clear title, body and media (keep platform selection & settings)',
  '上传文档': 'Upload doc',
  '导入本地文档作为正文（支持 .md / .markdown / .txt / .docx）':
    'Import a local document as the body (.md / .markdown / .txt / .docx)',
  '支持 .md / .txt / .docx': 'Supports .md / .txt / .docx',
  '配图与视频': 'Images & videos',
  '添加文件': 'Add file',
  // 与 MAX_MEDIA_MB 拼接的后半段：必须收录，否则英文界面会漏出「MB）」这个中文全角括号
  'MB）': 'MB)',
  // zip-download 的 previewText 模板（进历史记录，{file}/{n} 运行时替换）
  '已下载 {file}（{n} 张图片）': 'Downloaded {file} ({n} images)',
  '支持拖拽图片 / 视频到上方编辑区，或点击「添加文件」选择（单文件 ≤':
    'Drag images/videos into the editor above, or click "Add file" (single file ≤',
  // —— 真实排版预览弹窗 (PreviewModal) ——
  '真实排版预览': 'Real layout preview',
  '沉浸预览': 'Immersive preview',
  '对照润色': 'Split-edit & polish',
  '分钟阅读': 'min read',
  '文章标题（点击编辑）': 'Article title (click to edit)',
  '输入文章标题…': 'Enter article title…',
  '暂无正文内容，请在主界面或左侧编辑区输入正文…': 'No content yet; enter text in the main or left editor…',
  '文章封面 / 开头放置区': 'Article cover / intro placement area',
  '释放图片放置在此（文章开头封面）': 'Drop image here (article cover)',
  '释放图片放置在此（第 ': 'Drop image here (after paragraph ',
  ' 段后）': ')',
  '拖拽图片至此槽位': 'Drag image to this slot',
  '配图 #': 'Image #',
  '上移一段': 'Move up',
  '下移一段': 'Move down',
  '置顶封面': 'Set as cover',
  '置底文末': 'Move to end',
  '移出正文': 'Remove from body',
  '拖拽调整位置': 'Drag to reorder',
  '已上传媒体图库': 'Uploaded media gallery',
  '可将图片拖拽至上方各段落槽位，或使用右侧快捷排版': 'Drag images to paragraph slots above, or use quick layout tools on the right',
  '一键均分插入正文': 'Distribute evenly across body',
  '全部移至文末': 'Move all to end',
  '全部移出正文': 'Remove all from body',
  '暂无已上传媒体文件，可在主界面上传图片': 'No media uploaded yet; upload images in the main editor',
  '未放置（点击或拖拽插入）': 'Unplaced (click or drag to insert)',
  '位于封面': 'At cover',
  '位于第 ': 'After paragraph ',
  ' 段后': '',
  '位于文末': 'At end of article',
  '保存时将图片排版转为 Markdown 语法 (![图片](...))': 'Convert image placement to Markdown syntax (![img](...)) on save',
  '保存并应用': 'Save & apply',
  '编辑本段': 'Edit paragraph',
  '保存修改': 'Save changes',
  'Markdown 正文源码': 'Markdown source',
  '在此编辑 Markdown 正文，排版效果实时预览…': 'Edit Markdown source here; preview layout updates in real time…',
  '排版与图片混排视图': 'Layout & image mix preview',
  '关闭预览窗口': 'Close preview window',
  '🎬 视频素材': '🎬 Video asset',
  '点击插入到文末': 'Click to insert at end',
  '点击插入到封面': 'Click to insert as cover',
  '已保存并同步正文修改': 'Saved and synced article changes',
  '点击打开真实预览弹窗': 'Click to open real preview modal',
  '打开真实排版预览弹窗（支持图片拖拽与文案修改）': 'Open real layout preview modal (drag images & edit text)',
  '同步滚动': 'Sync scroll',
  '独立滚动': 'Independent scroll',
  '切换两栏同步滚动': 'Toggle dual-pane sync scroll',
  '同步滚动中': 'Scroll synced',

  // —— 平台区 ——
  '目标发布平台': 'Target platforms',
  '全选': 'Select all',
  '取消全选': 'Deselect all',
  '已登录': 'signed in',
  '未配置 (去设置)': 'Not configured (settings)',
  '未登录 (去登录)': 'Not signed in (login)',
  '本地导出 (无需登录)': 'Local export (no login)',
  '展开': 'Expand',
  '个未登录平台': ' signed-out platforms',
  '收起未登录平台': 'Collapse signed-out platforms',

  // —— footer ——
  '已勾选': 'Selected',
  'Selected': 'Selected',
  'platform': 'platform',
  'platforms': 'platforms',
  '平台': 'platforms',
  '一键生成并全网发布': 'Generate & publish everywhere',
  '静默自动': 'Silent auto',
  '正在静默发布...': 'Publishing silently…',
  'AI 适配各平台风格': 'AI-adapt to each platform style',
  '✨ AI 适配各平台风格': '✨ AI-adapt to each platform style',
  '（按知乎/小红书/X 等调性改写后发布）': '(rewrite per-platform tone before publishing)',
  '（需先在设置配置 AI Key）': '(configure an AI key in Settings first)',
  '定时': 'Schedule',
  '定时发布': 'Schedule publish',

  // —— 定时 modal ——
  '周期': 'Repeat',
  '一次': 'Once',
  '每天': 'Daily',
  '每周': 'Weekly',
  '内容': 'Content',
  '固定内容': 'Fixed content',
  'AI 按主题生成': 'AI by topic',
  '填写主题/选题，例如：每天一篇 AI 编程工具评测': 'Enter a topic, e.g. "A daily AI coding tool review"',
  '到点后扩展在后台自动发布（无需打开面板）；「每天/每周」会循环执行，「AI 生成」模式每次生成全新内容；结果见「发布历史」。':
    'The extension publishes automatically in the background (no panel needed). "Daily/Weekly" repeats; "AI" mode generates fresh content each time. See Publish History for results.',
  '待发队列': 'Scheduled queue',
  '未命名': 'Untitled',
  '移除': 'Remove',
  '确认定时': 'Confirm schedule',
  '取消': 'Cancel',
  '1 小时后': 'In 1 hour',
  '今晚 20:00': 'Today 20:00',
  '明早 08:00': 'Tomorrow 08:00',
  '已加入定时队列，到点自动发布': 'Added to schedule; will publish automatically',
  '已加入定时队列（本地媒体不随定时发布，仅发文字+正文图片）': 'Added to schedule (local media is skipped; text & inline images only)',
  '加入定时队列失败': 'Failed to add to schedule',
  '请选择未来的发布时间': 'Please pick a future time',
  '请先填写内容': 'Please fill in content first',
  '请至少勾选一个目标平台': 'Please select at least one target platform',
  '固定内容模式请先填写正文/标题': 'Please fill in body/title for fixed content mode',
  'AI 生成模式请填写主题/选题': 'Please enter a topic for AI mode',

  // —— 设置面板 ——
  '平台凭证配置': 'Platform credentials',
  '扩展行为': 'Extension behavior',
  '隐藏网页悬浮「同步」按钮': 'Hide the floating "Sync" button on web pages',
  '已隐藏悬浮同步按钮': 'Floating sync button hidden',
  '已恢复悬浮同步按钮': 'Floating sync button restored',
  '关闭后，文章页右下角的蓝色「同步」胶囊不再显示；不影响从扩展图标 / popup 「从当前页提取」。':
    'When off, the blue "Sync" pill in the bottom-right of article pages is hidden; extraction from the extension icon / popup is unaffected.',
  'AI 文案生成': 'AI copy generation',
  'API Key': 'API Key',
  '模型名（留空用默认）': 'Model (leave empty for default)',
  'Base URL（留空用所选服务默认）': 'Base URL (leave empty for provider default)',
  '支持 DeepSeek / OpenAI / 通义千问 / Kimi / 智谱 及任意 OpenAI 兼容服务。Key 仅存本机浏览器。':
    'Supports DeepSeek / OpenAI / Qwen / Kimi / GLM and any OpenAI-compatible service. The key is stored locally only.',
  '多账号矩阵': 'Multi-account matrix',
  '该平台暂无多账号。填好下方凭证后，点「保存当前配置为新账号」即可创建第一个账号。':
    'No extra accounts yet. Fill in the credentials below, then click "Save current config as new account".',
  '当前': 'current',
  '切换': 'Switch',
  '删除': 'Delete',
  '新账号名称（如 公司号 / 个人号）': 'New account name (e.g. Company / Personal)',
  '保存当前配置为新账号': 'Save current config as new account',
  '切回默认配置': 'Back to default config',
  '仅支持填凭证的平台（WordPress/Telegram/Bluesky 等）；微博、小红书等 cookie 登录平台一浏览器一账号，不支持多账号。':
    'Only credential-based platforms (WordPress/Telegram/Bluesky, etc.). Cookie-login platforms (Weibo, Xiaohongshu, etc.) support one account per browser.',
  '测试连接': 'Test connection',
  '发布中断': 'Publishing interrupted',
  '发布管线异常中断': 'Publishing pipeline crashed',
  '请重试；若反复出现，请减少一次勾选的平台数。': 'Please retry; if it keeps happening, select fewer platforms per run.',
  '与后台的连接在长任务中中断（Service Worker 可能被 Chrome 回收），本次发布未执行。请重试；若反复出现，请减少一次勾选的平台数。':
    'The connection to the background was interrupted during the long task (the Service Worker may have been recycled by Chrome). This run was not executed. Please retry; if it keeps happening, select fewer platforms per run.',
  '与后台的连接在长任务中中断（Service Worker 可能被 Chrome 回收），以下为中断前记录到的最后状态，可能不完整。':
    'The connection to the background was interrupted during the long task (the Service Worker may have been recycled by Chrome). Below is the last state recorded before the interruption, which may be incomplete.',
  '保存设置': 'Save settings',
  '语言': 'Language',
  '中文': '中文',
  'English': 'English',

  // —— 内容库 modal ——
  '内容库': 'Content library',
  '刷新': 'Refresh',
  '搜索标题 / 正文关键词': 'Search title / body keywords',
  '暂无发布记录': 'No publish records yet',
  '发布成功后会自动归档到这里': 'Successful publishes are archived here',
  '无匹配内容': 'No matching content',
  '复制': 'Copy',
  '再次使用': 'Reuse',
  '关闭': 'Close',
  '已复制到剪贴板': 'Copied to clipboard',
  '标题与正文已复制，去新页面 Ctrl+V 粘贴': 'Title & body copied, paste with Ctrl+V in the new tab',
  '打开草稿详情页（标题+正文已复制到剪贴板，可直接粘贴）': 'Open draft page (title & body already copied to clipboard, just paste)',
  '已载入内容，可编辑后发布': 'Content loaded; edit then publish',
  '未命名发布': 'Untitled publish',

  // —— 结果 modal ——
  '发布结果': 'Publish results',
  '已成功发布到': 'Published to',
  '个平台': 'platforms',
  '部分失败': 'Partially failed',

  // —— toast / 提示 ——
  '已提取正文与封面（封面图可在发布时自动上传）': 'Extracted body & cover (cover auto-uploads on publish)',
  '已从当前页提取正文': 'Extracted body from current page',
  '提取失败：请先打开文章页面': 'Extraction failed: open an article page first',
  'AI 已生成文案，可预览/编辑后一键发布': 'AI generated copy; preview/edit then publish',
  'AI 生成失败': 'AI generation failed',
  '请先在设置面板配置 AI 的 API Key': 'Please configure an AI API key in Settings first',
  '请输入要生成的内容需求（主题 / 要点）': 'Please enter the content requirement (topic / key points)',
  '已恢复草稿正文；媒体文件需重新添加': 'Draft restored; media files need to be re-added',
  '检测到': 'Detected',
  '个未完成发布的草稿，可对失败平台重试': 'unfinished drafts; retry failed platforms',
  '本地下载': 'Local download',
  '本地导出': 'Local export',
  '已从网页提取正文，确认后一键发布': 'Extracted body from page; review then publish',
  '已清空': 'Cleared',
  '暂不支持 .': 'Unsupported extension .',
  '（仅支持 .md / .markdown / .txt / .docx）': '(only .md / .markdown / .txt / .docx)',
  '文档导入失败': 'Document import failed',
  '已从当前页提取正文与标题': 'Extracted body & title from current page',
  '已导入 ': 'Imported ',
  '已从 Word 导入 ': 'Imported from Word ',

  // —— AI 生成区 ——
  '使用默认': 'Using default: ',
  '在设置中修改': 'Change in Settings',
  '正在刷新': 'Refreshing',
  '个平台登录态...': 'platforms login status...',
  '刷新失败': 'Refresh failed',
  '刷新中…': 'Refreshing…',
  '刷新超时': 'Refresh timed out',
  '安全限速等待中...': 'Rate-limit wait...',
  '安全限速间隔...': 'Rate-limit interval...',

  // —— 半自动发布模式 ——
  '已存草稿，未发布': 'Saved as draft, not published',
  '在文章页显示悬浮「同步」按钮': 'Show floating "Sync" button on article pages',
  '待粘贴发布（打开后 Ctrl+V）': 'Paste to publish (open & Ctrl+V)',
  '待粘贴': 'to paste',
  '该平台无草稿功能，半自动模式不支持；请切换到「自动」模式直接发布': 'This platform has no draft feature; semi-auto mode is not supported. Switch to Auto mode to publish directly',
  'AI 未配置 API Key，已跳过风格适配（发布的是原文）': 'AI API key not configured; style adaptation skipped (original text published)',
  'AI 适配失败，已回退原文': 'AI adaptation failed, fell back to original text',
  '半自动': 'Semi-auto',
  '半自动（未登录也可一键跳转）': 'Semi-auto (works even when not logged in)',
  '半自动（一键跳转·需网页端登录）': 'Semi-auto (one-click jump, requires web login)',
  '半自动平台：扩展将为您生成草稿并带入剪贴板，点击「打开草稿」直达后台，在网页中登录后即可一键粘贴发布': 'Semi-auto platform: the extension generates drafts and copies formatted content to your clipboard. Click "Open Draft" to open the creator portal and paste after logging in.',
  '打开草稿': 'Open draft',
  '打开草稿详情页（可手动点发布）': 'Open draft page (publish manually)',
  '发布模式': 'Publish mode',
  '自动发布': 'Auto publish',
  '半自动（仅建草稿）': 'Semi-auto (draft only)',
  '半自动：只自动建草稿，不调发布接口（绕开知乎/掘金等平台风控），发布结果回执点「打开草稿」手动点发布，成功率最高。': 'Semi-auto: only auto-creates drafts, skips the publish API (bypasses Zhihu/Juejin anti-bot). Click "Open draft" in the receipt to publish manually — highest success rate.',
  '自动：建草稿后自动点发布。API 直连平台（知乎/掘金等）可能因风控被 403，失败时可点「打开草稿」手动补发。': 'Auto: auto-publishes after drafting. API-connected platforms (Zhihu/Juejin etc.) may return 403 due to anti-bot; on failure click "Open draft" to publish manually.',
  '勾选的平台都未登录，请先在浏览器里登录对应平台，再回来发布。': 'None of the selected platforms are logged in. Please log in to them in the browser first, then return to publish.',
  '本次跳过': 'Skipped this time',
  '未登录，已跳过': 'Not logged in, skipped',
  '去登录后重试': 'Log in and retry',
  '以下平台未登录，本次将跳过：': 'These platforms are not logged in and will be skipped:',
  '是否继续发布已登录的平台？': 'Continue publishing to the logged-in platforms?',

  // —— content script (fab) ——
  '同步': 'Sync',
  '同步文章': 'Sync article',
  '点击同步文章到多平台': 'Click to sync this article to multiple platforms',
  '同步文章到多平台': 'Sync article to multiple platforms',
  '同步此页': 'Sync this page',
  '同步此页：提取正文并一键发布到多平台': 'Sync this page: extract and publish to multiple platforms',
  '复制 Markdown': 'Copy Markdown',
  '复制纯文本': 'Copy plain text',
  '下载 Markdown': 'Download Markdown',
  '已提取正文：请点扩展图标打开 Side Panel 自动填充': 'Extracted: click the extension icon to open the Side Panel',
  '已提取': 'Extracted',
  '未识别': 'Not recognized',
  '已提取正文：请点扩展图标打开 Side Panel 自动填充（也可能是从当前页提取失败，请打开 Side Panel 查看）':
    'Extracted: click the extension icon to open the Side Panel (or extraction failed — open the Side Panel to check)',
  '当前页面未识别到文章正文': 'No article body recognized on this page',
  '正文提取失败': 'Article extraction failed',

  'YouTube 仅支持视频发布，请先添加至少一个视频文件再发布': 'YouTube only supports video posts. Please add at least one video file before publishing.',
  '小红书仅支持图文或视频发布，请先添加至少一张图片或视频再发布': 'Xiaohongshu only supports photo or video posts. Please add at least one image or video before publishing.',

  // —— 平台分组 ——
  '国内主流': 'Domestic mainstream',
  '垂直平台': 'Vertical platforms',
  '国际平台': 'International',
  'CMS 自建站': 'CMS / self-hosted',
  // —— 平台名 ——
  '微博': 'Weibo',
  '小红书': 'Xiaohongshu',
  '哔哩哔哩': 'Bilibili',
  '知乎': 'Zhihu',
  '掘金': 'Juejin',
  '语雀': 'Yuque',
  '思否': 'SegmentFault',
  '博客园': 'CNBlogs',
  '开源中国': 'OSChina',
  '豆瓣': 'Douban',
  '搜狐号': 'Sohu',
  '百家号': 'Baijiahao',
  '东方财富': 'Eastmoney',
  '雪球': 'Xueqiu',
  '微信公众号': 'WeChat Official',
  '人人都是产品经理': 'Woshipm',
  '51CTO': '51CTO',
  '慕课手记': 'Imooc',
  '今日头条': 'Toutiao',
  '今日头条号': 'Toutiao Author',
  '简书': 'Jianshu',
  '网易号': 'NetEase',
  '抖音图文': 'Douyin',
  '大鱼号': 'Dayu',
  '一点号': 'Yidian',
  '什么值得买': 'SMZDM',
  '搜狐焦点': 'Sohu Focus',
  'X / Twitter': 'X / Twitter',
  'WordPress': 'WordPress',
  'Typecho': 'Typecho',
  'MetaWeblog': 'MetaWeblog',
  'Markdown 压缩包': 'Markdown ZIP',

  // —— 平台 tags ——
  '文': 'Text',
  '图': 'Image',
  '视': 'Video',
  '图文': 'Photo+Text',
  '推文': 'Post',
  '视频': 'Video',
  '专栏': 'Column',
  '频道': 'Channel',
  '消息': 'Message',
  '帖子': 'Post',
  '文本': 'Text',
  '长文': 'Article',
  '技术': 'Tech',
  'CMS': 'CMS',
  '博客': 'Blog',
  '导出': 'Export',
  'ZIP': 'ZIP',

  // —— 其他 ——
  '未知': 'unknown',
  '字': 'chars',

  // —— sourceTabs/schedule 数据标签（P0-P1 多语言） ——
  '✨ AI 生成': '✨ AI Generate',
  '📝 手动编辑': '📝 Manual Edit',
  '配置好 AI Key 可对各平台调性改写。开启后，每个平台会按自身风格重新生成内容再发布。': 'With an AI key configured, content can be rewritten per-platform style. When on, each platform regenerates content in its own voice before publishing.',
  // —— 模板骨架 ——
  '## 活动背景\n\n（一句话说明为什么要做这个活动）\n\n## 活动内容\n\n- 亮点一：\n- 亮点二：\n- 亮点三：\n\n## 时间与地点\n\n- 时间：\n- 地点 / 线上入口：\n\n## 参与方式\n\n（如何报名 / 参与步骤）': '## Background\n\n(One sentence on why this event)\n\n## Event details\n\n- Highlight 1:\n- Highlight 2:\n- Highlight 3:\n\n## Time & venue\n\n- When:\n- Where / online:\n\n## How to join\n\n(How to sign up / steps)',
  '## 开箱与初印象\n\n（外观 / 包装 / 第一感受）\n\n## 核心优缺点\n\n- 优点：\n- 缺点：\n\n## 实际使用体验\n\n（场景化描述，用了多久、真实感受）\n\n## 购买建议\n\n（适合谁 / 值不值得买）': '## Unboxing & first impression\n\n(Look / packaging / first feel)\n\n## Key pros & cons\n\n- Pros:\n- Cons:\n\n## Real-world experience\n\n(Scenario-based; how long used, honest feel)\n\n## Buying advice\n\n(Who it is for / worth buying?)',
  '## 一句话引入\n\n（用生活场景引出概念）\n\n## 原理讲解\n\n（通俗讲清原理，避免堆术语）\n\n## 一个例子\n\n（用案例加深理解）\n\n## 总结\n\n（一句话收束，点明价值）': '## Hook\n\n(Lead into the concept with a real-life scene)\n\n## How it works\n\n(Explain simply, avoid jargon)\n\n## An example\n\n(One case to deepen understanding)\n\n## Summary\n\n(One-line takeaway and value)',
  '## 我的观点\n\n（一句话亮明立场）\n\n## 为什么这么看\n\n（2~3 个论据支撑）\n\n## 反驳与边界\n\n（可能的不同意见 + 适用边界）\n\n## 结论\n\n（收束，可加行动建议）': '## My take\n\n(State your stance in one sentence)\n\n## Why I think so\n\n(2-3 supporting arguments)\n\n## Counterpoints & limits\n\n(Possible objections + scope)\n\n## Conclusion\n\n(Close; optional action suggestion)',


  // —— 定时发布 ——
  '已加入定时队列：': 'Added to scheduled queue: ',
  '到点 AI 按主题自动生成并发布': 'AI generates from the topic and publishes at the scheduled time',
  '🕐 定时发布': '🕐 Schedule',
  '主题': 'Topic',

  // —— 多账号 ——
  '账号': 'Account',
  '已切换账号': 'Account switched',
  '已切回默认配置': 'Reverted to default config',
  '已新增账号并切换': 'Account added and switched',
  '请先填写该平台的凭证': 'Please fill in the credentials for this platform first',
  '（当前）': ' (current)',

  // —— 媒体上传提示 ——
  '超过': 'exceeds',
  '上限，已跳过（大文件上传将在后续版本通过后台分片支持）': 'MB limit, skipped (large files will be supported via background chunking in a later version)',
  '约': 'about',
  '，视频较大可能上传较慢，仍要添加吗？': ', the video is large and may upload slowly. Add it anyway?',

  // —— 发布校验与结果 ——
  '请填写正文内容或标题': 'Please enter the body content or a title',
  '请至少勾选一个目标发布平台': 'Please select at least one target platform',
  '以下平台未登录，本次将跳过：\n': 'The following platforms are not signed in and will be skipped:\n',
  '\n\n是否继续发布已登录的平台？': '\n\nContinue publishing to the signed-in platforms?',
  '草稿创建失败': 'Failed to create draft',
  '未执行或被跳过': 'Not run / skipped',
  '未能完成任何平台发布。\n': 'No platform was published successfully.\n',
  '未知错误': 'Unknown error',
  '没有失败的平台需要重试': 'No failed platforms to retry',
  '发布结果回执': 'Publish receipt',
  '共': 'Total',
  '成功': 'succeeded',
  '草稿': 'drafted',
  '发布成功': 'Published',
  '查看 ↗': 'View ↗',
  '重试': 'Retry',
  '个未登录': 'not signed in',
  '完成': 'Done',
  '已连接': 'Connected',
  '已完成': 'Done',
  '失败': 'Failed',

  // —— 模板 / 内容库 ——
  '✨ 一键生成文案': '✨ Generate copy',
  '已填入': 'Filled in ',
  '模板，请补充内容': ' template, please complete the content',
  '🎬 视频': '🎬 Video',
  '📚 内容库': '📚 Library',
  '🔍 搜索标题 / 正文关键词': '🔍 Search title / body keywords',
  '📋 复制': '📋 Copy',
  '↺ 再次使用': '↺ Reuse',

  // —— CMS / 凭证表单 ——
  '站点地址 (例如 https://example.com)': 'Site URL (e.g. https://example.com)',
  '站点地址 (例如 https://blog.example.com)': 'Site URL (e.g. https://blog.example.com)',
  '用户名': 'Username',
  '密码': 'Password',
  '应用程序密码 (Application Password)': 'Application Password',
  'XML-RPC 端点（可选，默认 站点/action/xmlrpc）': 'XML-RPC endpoint (optional, default site/action/xmlrpc)',
  'XML-RPC 端点（可选，默认 站点/xmlrpc.php）': 'XML-RPC endpoint (optional, default site/xmlrpc.php)',
  'MetaWeblog (通用 XML-RPC)': 'MetaWeblog (generic XML-RPC)',
  'Bot Token (例如 123456:ABC-DEF)': 'Bot Token (e.g. 123456:ABC-DEF)',
  'Chat ID / Channel (例如 @mychannel)': 'Chat ID / Channel (e.g. @mychannel)',
  'Handle / Email (例如 alice.bsky.social)': 'Handle / Email (e.g. alice.bsky.social)',
  'App Password (Bluesky 设置→应用密码 生成)': 'App Password (Bluesky Settings → App Passwords)',
  'API Key (dev.to/settings/extensions 生成)': 'API Key (generate at dev.to/settings/extensions)',
  'Personal Access Token (需 Pro 订阅)': 'Personal Access Token (Pro subscription required)',
  'publicationId (博客的 GraphQL id)': 'publicationId (GraphQL id of the blog)',
  'Mastodon (联邦宇宙)': 'Mastodon (Fediverse)',
  '实例地址 (例如 mastodon.social)': 'Instance URL (e.g. mastodon.social)',
  'Access Token (设置→开发→新应用 创建)': 'Access Token (Settings → Development → New application)',
  'Reddit (已登录浏览器会话)': 'Reddit (signed-in browser session)',
  '目标板块 subreddit (例如 test 或 u_用户名)': 'Target subreddit (e.g. test or u_username)',
  '需先在浏览器登录 www.reddit.com（复用会话 Cookie 直发）': 'Sign in to www.reddit.com in the browser first (posts via session cookie)',
  '检测中...': 'Checking...',
  '连接成功': 'Connected',
  '连接失败': 'Connection failed',
  '（请检查站点地址与凭证）': ' (check the site URL and credentials)',

  // —— YouTube / Bridge ——
  '🔗 授权 Google 账号（上传视频）': '🔗 Authorize Google account (video upload)',
  '正在打开 Google 授权页，请完成登录...': 'Opening the Google consent page, please sign in...',
  '✅ 授权成功，Access Token 已保存': '✅ Authorized, access token saved',
  '授权失败': 'Authorization failed',
  '✅ 已授权（token 有效期至': '✅ Authorized (token valid until ',
  '，过期自动刷新）': ', auto-refreshed on expiry)',
  '网页同步 Bridge Token': 'Web sync bridge token',
  '（首次打开自动生成）': ' (auto-generated on first open)',
  '网页调用 window.syncPost({ title, body }) 时需携带该 token，防止任意网站触发同步。':
    'Web pages must pass this token when calling window.syncPost({ title, body }) to stop any site from triggering a sync.',

  // —— 发布进度（background 推送到 popup 的阶段文案）——
  'AI 正在生成新内容...': 'AI is generating new content...',
  '定时发布完成': 'Scheduled publish complete',
  '（已排期下次）': ' (next run scheduled)',
  '（已排期下周）': ' (next week scheduled)',
  '正在检查登录状态...': 'Checking sign-in status...',
  '未检测到登录会话，请先登录该平台': 'No signed-in session found; please sign in to this platform first',
  '正在创建草稿...': 'Creating draft...',
  '上传媒体': 'Uploading media',
  'AI 适配平台风格中...': 'Adapting to platform style with AI...',
  '草稿已就绪': 'Draft ready',
  '正在正式发布...': 'Publishing...',
  '发布成功！': 'Published!',
  '发布失败': 'Publish failed',
  '的自动媒体上传尚未实现，为避免发布后图片丢失，请先去掉媒体后再试（纯文本发布不受影响）':
    'does not support automatic media upload yet. To avoid losing images after publishing, please remove the media and try again (text-only publishing is unaffected)',

  // —— 凭证申请指引（去哪个页面申请/配置） ——
  '接入指引：': 'How to get it: ',
  '申请指引：': 'How to get it: ',
  '使用说明：': 'How to use: ',
  '配置指引：': 'How to configure: ',
  'publicationId 可留空：': 'publicationId optional: ',

  // Mastodon
  '实例「设置→开发→新应用」创建 Token':
    'Create a token in your instance under Settings → Development → New application',
  // Reddit
  '登录 reddit.com 后即可发文（复用浏览器会话）':
    'Sign in to reddit.com to post (reuses the browser session)',
  // YouTube
  'Google Cloud Console 创建 OAuth 客户端（选「网页应用」）':
    'Create an OAuth client in Google Cloud Console (type: Web application)',
  '复制 OAuth 回调地址': 'Copy OAuth redirect URL',
  '回调地址已复制，请粘贴到 Google Cloud Console 授权回调 URL':
    'Redirect URL copied, paste it into the authorized redirect URL in Google Cloud Console',
  // WordPress
  '后台「用户→个人资料→应用程序密码」生成':
    'Generate under site admin → Users → Profile → Application Passwords',
  // Telegram
  '私聊 @BotFather 发送 /newbot 创建':
    'Message @BotFather with /newbot to create a bot',
  // Bluesky
  '设置→App Passwords 生成应用密码':
    'Create one under Settings → App Passwords',
  // Dev.to
  'Settings→API Keys 生成':
    'Generate under Settings → API Keys',
  // Hashnode
  '设置→Developer 生成 Token':
    'Generate under Settings → Developer',
  '发文时自动匹配，点此打开博客管理页':
    'Auto-matched on publish; click to open your blog dashboard',
  // Typecho / MetaWeblog
  '账号同后台登录，需启用 XML-RPC':
    'Same credentials as your blog admin sign-in; XML-RPC must be enabled',
  '填博客后台账号密码，兼容 WordPress 等':
    'Use your blog admin username/password; works with WordPress and more',
  // AI 文案生成
  '→ 控制台创建 API Key': '→ open console to create an API Key',
};


/** 翻译：lang=zh 返回原文，lang=en 查 EN_MAP，缺失回退原文 */
export function t(zh: string, lang: Lang): string {
  if (lang === 'zh') return zh;
  return EN_MAP[zh] ?? zh;
}

/** 从浏览器语言推断默认语言（zh* → 中文，其余 → 英文） */
export function detectBrowserLang(): Lang {
  const l = (typeof navigator !== 'undefined' ? navigator.language : '') || '';
  return l.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
