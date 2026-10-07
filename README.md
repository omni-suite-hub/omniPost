# OmniPost - 一次撰写，全网多平台一键发布

> **本地优先 · 一键静默发布 · 无服务器 · 开源安全**  
> 风格参考 OmniPic 黑曜石奢华设计，支持国内外 8 大主流平台（P0）一键分发。

---

## 🌟 核心特性

- **仅 MV3**：严格遵循 Google Chrome Manifest V3 规范。
- **本地优先**：所有发布请求从用户本地浏览器发出，绝无任何第三方中转服务器，保护隐私。
- **复用浏览器 Session**：不需要输入平台账号密码，在浏览器正常登录后自动复用 Cookie 登录态。
- **一键静默发布**：勾选平台 → 点「一键生成并全网发布」→ 后台自动完成「建草稿 → 自动点发布 → 处理二次确认 → 关闭编辑页」，对标商店插件"文章同步助手"的一键发文体验（知乎等平台无开放 API，静默发布 = 后台模拟浏览器操作）。
- **失败降级**：某平台自动发布超时/弹验证码时，编辑页保留在前台供人工接管，回执明确标记失败原因（不静默假装成功）。
- **安全防封**：各平台间执行 ≥ 3s 行为拟真限速，避免短时并发触发平台风控。
- **OmniPic 暗黑风格**：继承 OmniPic 优雅的 Obsidian Dark 配色与侧边栏 (Side Panel) / 弹出面板双支持。

---

## 🎯 P0 支持平台清单

| 平台 | 技术路线 | 支持形态 | 说明 |
| :--- | :--- | :--- | :--- |
| **微博** | Session 注入 | 文 / 图 / 视 | 原生 setter 注入微博发布框，支持带图发博 |
| **小红书** | Session 创作者中心 | 图 / 视 / 文 | 适配创作者中心，标题+正文+草稿保存 |
| **哔哩哔哩** | Session 动态/专栏 | 视 / 图 / 文 | 支持动态文字与图片多合一发稿 |
| **知乎** | Session 专栏写作 | 文 / 专栏 / 图 | 适配知乎专栏草稿与一键发布 |
| **WordPress** | Official REST API | 长文 / 图 | 支持自建站与官方托管，凭证本地存储 |
| **X (Twitter)** | Session / Compose | 推文 / 图 / 视 | 自动组装 Thread 连推草稿 |
| **YouTube** | Official Data API v3 | 视频 / Shorts | 支持分片草稿上传与状态公开转换 |
| **Telegram** | Official Bot API | 频道 / 图 / 文 | 通过 Bot API 安全广播至私密/公开频道 |

---

## 📦 如何在 Chrome 中加载使用插件

> ⚠️ **关键说明（解决无法加载的问题）**：  
> Chrome 加载已解压扩展程序时，**必须选中包含 `manifest.json` 的打包目录 `packages/extension/dist`**，而**不能直接拖入整个代码仓库根目录**（根目录没有 manifest.json，会报 "Manifest file is missing"）。

### 步骤：
1. **执行构建**（如已构建可跳过）：
   ```bash
   npm run build
   ```
   构建产物输出到 **`packages/extension/dist/`**（不是仓库根目录）。

2. **在 Chrome 中加载**：
   - 打开 Chrome 浏览器，在地址栏输入 `chrome://extensions/` 回车。
   - 打开右上角的 **「开发者模式」 (Developer mode)** 开关。
   - **方式一（推荐直接拖拽）**：在 Finder (访达) 中将 **`packages/extension/dist` 文件夹** 拖入 `chrome://extensions` 页面中。
   - **方式二（点击加载）**：点击左上角的 **「加载已解压的扩展程序」 (Load unpacked)**，选择 **`~/workspace/omniPost/packages/extension/dist`** 文件夹。

3. **使用插件**：
   - 点击浏览器右上角插件栏的 OmniPost 图标（或通过右键菜单打开侧边栏，Side Panel 吸附浏览器右侧）。
   - 勾选你要发布的目标平台，填入标题和正文，点击 **「一键生成并全网发布」**。
   - 发布全程后台静默执行，完成后弹出「发布结果回执」：每平台成功（含链接）/ 失败（含原因），失败可一键重试，结果自动归档到「发布历史」。

---

## 🧪 自动化测试验证

本项目配有完整的测试套件（75 项自动化校验项全绿通过）：

```bash
# 运行全量单元与规范性测试
npm test
```

测试内容涵盖：
- ✅ Manifest V3 规范、权限最小化、Host 权限匹配与文件完整性校验。
- ✅ 8 大平台 Adapter 接口契约 (`checkLogin`, `createDraft`, `publish`, `route`) 校验。
- ✅ Content Scripts 注入逻辑与 React 受控组件输入事件派发校验。
- ✅ CLI 命令行工具参数与同步指令校验。
- ✅ MCP Server 协议与工具链实现校验。

### 浏览器内诊断工作台
加载插件后，可直接在浏览器访问以下页面执行端对端通讯诊断：
`chrome-extension://<你的插件ID>/test_driver.html`

---

## 💻 命令行 (CLI) 使用

```bash
# 查看所有支持平台
npm run cli -- platforms

# 同步 Markdown 文件
npm run cli -- sync test/sample.md
```

---

## 🤖 MCP Server (Claude Code / AI 助手接入)

```bash
npm run mcp
```
支持工具：`list_platforms`, `check_auth`, `sync_article`, `extract_article`, `upload_image`。
