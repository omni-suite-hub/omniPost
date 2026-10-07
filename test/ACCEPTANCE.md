# OmniPost MVP 人工验收清单

> 对应 PRD（`omnipost-mvp-prd.md`）§5 功能清单 / §9 验收标准。
> 自动化测试（`npm test` 201 项 + `npm run test:e2e` 真实 Chrome 冒烟 14 项）已覆盖的项标 🔵，**需要人工在真实浏览器 + 真实登录态下验证的项标 🟢**。
> 验收环境：Chrome（建议 137+），加载 `packages/extension/dist`（开发者模式 → 加载已解压的扩展程序）。

---

## 0. 安装与加载

- [ ] 🔵 构建产物存在：`npm run build` 生成 `packages/extension/dist`（manifest.json + service-worker-loader.js + index.html + assets/）
- [ ] 🟢 Chrome 加载 `packages/extension/dist` 无报错，扩展卡片显示「OmniPost MVP」
- [ ] 🟢 点击工具栏扩展图标 → **浏览器右侧打开 Side Panel**（不再弹 popup 弹窗）
- [ ] 🟢 地址栏访问 `chrome://extensions` 确认「Service Worker」状态为活跃/可唤醒

## 1. 撰写区（一次撰写）

- [ ] 🔵 编辑器可输入标题 + 正文（Markdown 双模式：编辑 / 预览 toggle）
- [ ] 🔵 Markdown 预览：`# 标题`、`**加粗**`、`*斜体*`、`- 列表`、`> 引用`、` ```` ``` ```` 代码块均正确渲染；含 `<script>` 的正文被转义（不弹窗、不执行）
- [ ] 🔵 媒体拖拽：将图片拖到编辑区出现占位；点「添加文件」可选择本地图片/视频（单文件 ≤ 15MB 有前端校验）
- [ ] 🔵 字数预警：输入正文后底部显示「N 字 / 平台上限（剩余 M）」，取**已勾选平台**中最小上限（微博 2000 / X 280 / 小红书 1000 / B站 2000 / Telegram 4096）
- [ ] 🟢 草稿持久化：输入内容后**关闭 Side Panel 再重新打开**，草稿仍在（chrome.storage.local）

## 2. 平台选择与登录态

- [ ] 🔵 平台面板列出 8 平台：微博 / 小红书 / B站 / 知乎 / WordPress / X / YouTube / Telegram，带品牌色圆点与左条
- [ ] 🔵 打开面板自动触发登录态检测（checkLogin），已登录显示账号名，未登录显示「未登录」且**勾选框置灰不可选**
- [ ] 🟢 未登录平台点「去登录」→ 打开该平台登录页，手动登录后返回复检变为已登录
- [ ] 🟢 至少实测一个 session 平台登录态识别准确（如微博已登录 ≠ 小红书已登录，互不串台）

## 3. 发布流程（一键静默自动发布）

> **对标商店插件体验**：知乎等平台无开放发布 API，静默发布 = 后台模拟浏览器操作（后台打开编辑页 → 填内容 → 自动点发布 → 处理二次确认 → 关闭编辑页）。

- [ ] 🔵 勾选平台 → 点「**一键生成并全网发布**」→ 后台逐平台执行（全程不抢焦点、不弹窗）：建草稿 → 自动发布 → 关闭编辑页 → Side Panel 弹出「发布结果回执」（每平台成功含链接 / 失败含原因），单平台失败不阻塞其他
- [ ] 🔵 失败重试：失败平台出现「重试」按钮，仅重发失败平台，不重复已成功平台
- [ ] 🟢 发布历史：点头部「发布历史」弹出面板，显示每次发布的时间、平台、成功/失败标记（发布结束自动归档）
- [ ] 🟢 **session 平台**（微博/小红书/B站/知乎/X）：后台打开平台编辑页（不抢焦点）→ 正文/标题填入对应编辑器（React 受控组件也生效）→ 媒体注入 file input → 自动点击发布按钮 → 自动处理二次确认弹窗（发布设置/原创声明等）→ 发布成功后自动关闭编辑页
- [ ] 🟢 **发布失败降级**：某平台自动发布超时/弹验证码时，编辑页保留在前台供人工接管，回执标记失败原因（不静默假装成功）
- [ ] 🟢 **official 平台**（WordPress/Telegram）：不经页面，直接 API 建草稿/发消息

## 4. 媒体管线

- [ ] 🟢 图片：附带图片发布 → 平台侧草稿中出现图片（非占位、非空引用）
- [ ] 🟢 视频（Telegram 等支持渠道）：附带视频发送 → 以媒体组形式发出（attach:// 命名正确）
- [ ] 🟢 超过 15MB 的文件被拒绝并有明确提示（不做静默截断）
- [ ] 🔵 大文件走 offscreen 分片/Blob 解码路径无崩溃（dataUrlToBlob 真实解码）

## 5. YouTube OAuth（official 路线）

- [ ] 🔵 设置面板出现 YouTube OAuth 配置区（Client ID / Client Secret 输入 + 授权按钮）
- [ ] 🟢 填 Client ID/Secret → 点授权 → 弹出 Google 授权页（PKCE S256）→ 授权后回跳，token 状态显示已授权
- [ ] 🟢 视频发布：走 resumable 分片上传，草稿保持 private，确认发布后转 public；token 过期（<5min 余量）自动刷新

## 6. Local Bridge / CLI / MCP（AI 桥接）

- [ ] 🔵 设置面板展示 Bridge Token（`om` 前缀，幂等生成，重装扩展后以扩展侧为准）
- [ ] 🔵 CLI 真实执行：`npm run cli -- auth` 返回各平台真实登录态（非占位文案）
- [ ] 🔵 CLI 真实执行：`npm run cli -- sync test/sample.md -p telegram` → 扩展收到命令 → 静默自动发布 → 回写结果
- [ ] 🟢 **CLI → 扩展全链路**（Chrome 保持打开且已加载扩展）：运行 sync 命令，30s 内扩展轮询取走并自动发布，CLI 打印真实回执（含各平台成功/失败）
- [ ] 🟢 **MCP 全链路**：stdio 启动 `npm run mcp`，用 MCP 客户端调 `list_platforms` / `check_auth` / `sync_article` / `upload_image`，失败时返回 `isError`（不静默假成功）

## 7. 安全与卫生

- [ ] 🔵 全程无扩展自身 console error（e2e 冒烟自动断言 0 条）
- [ ] 🔵 bridge 轮询带 token 头，错误 token 被 403 拒绝（单测覆盖）
- [ ] 🟢 网络面板确认：发布请求只发往平台官方域名 + 127.0.0.1:18432（本地 bridge），无任何第三方服务器
- [ ] 🟢 `window.syncPost(article)` 在任意页面调用：一次 token 校验 + 45s 超时，失败返回 `{status:'error'}` 不假成功

## 8. 自动化回归（CI 一键）

- [ ] 🔵 `npm test` → **215/215 通过**（构建 + dist 契约 + adapter 防假成功 + content script 注入/二次确认 + background 数据流 + CLI/MCP/bridge 契约 + Side Panel 状态 + 构建卫生）
- [ ] 🔵 `npm run test:e2e` → **14/14 通过**（真实 Chrome for Testing：扩展加载、React 渲染、CHECK_ALL_LOGIN 全 false、storage 往返、bridge token、SW 注册、sidePanel API、bridge 轮询 alarm、零 console error）
- [ ] 🔵 `npm run test:all` 一键全量（两者串联）

---

## 验收结论记录

| 日期 | 验收人 | 人工项通过/总人工项 | 阻塞问题 | 结论 |
|---|---|---|---|---|
|  |  |  /  |  |  |
