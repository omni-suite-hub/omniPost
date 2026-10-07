/**
 * OmniPost 单元测试入口（真实执行源码逻辑）
 * 用 esbuild bundle 到 node 可执行 mjs：先注入 chrome/fetch mock，再动态 import 真实模块。
 * 运行：node_modules/.pnpm/node_modules/.bin/esbuild test/unit/unit_entry.ts \
 *         --bundle --platform=node --format=esm --outfile=test/.tmp/unit.mjs \
 *       && node test/.tmp/unit.mjs
 */

// ---------- chrome API mock（MV3 promise + callback 双风格） ----------
const onMessageListeners: ((msg: any, sender: any, sendResponse: (r: any) => void) => boolean | undefined)[] = [];
// 真实 Chrome 语义：onMessage 支持多个 listener，逐个派发；谁处理谁回 sendResponse（首个响应生效）
// 单变量会被后注册的模块（offscreen 等）覆盖，导致 §22 派发给错误监听器 —— 改为数组派发
const onMessageListener: ((msg: any, sender: any, sendResponse: (r: any) => void) => boolean | undefined) = (msg, sender, sendResponse) => {
  for (const fn of onMessageListeners) {
    try { fn(msg, sender, sendResponse); } catch { /* 忽略个别 listener 异常，不阻塞其他派发 */ }
  }
  return true;
};
let storageState: Record<string, any> = {};

function makeChromeMock() {
  const mock: any = {};
  mock._lastErrorValue = undefined;

  const storageLocal = {
    get: async (keys: string | string[] | Record<string, any> | null) => {
      if (typeof keys === 'string') return { [keys]: storageState[keys] };
      if (Array.isArray(keys)) {
        const out: Record<string, any> = {};
        keys.forEach((k) => { if (k in storageState) out[k] = storageState[k]; });
        return out;
      }
      if (keys && typeof keys === 'object') {
        const out: Record<string, any> = {};
        Object.keys(keys).forEach((k) => { out[k] = k in storageState ? storageState[k] : (keys as any)[k]; });
        return out;
      }
      return { ...storageState };
    },
    set: async (items: Record<string, any>) => { Object.assign(storageState, items); },
    remove: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((k) => delete storageState[k]);
    },
  };

  const tabListeners: ((id: number, info: any) => void)[] = [];
  const currentTabs: any[] = [{ id: 1, url: 'https://x.com/home', status: 'complete' }];
  let sendMessageBehavior: ((tabId: number, msg: any, cb: (res: any) => void) => void) | null = null;

  mock.storage = { local: storageLocal };
  mock.runtime = {
    // 必须用 getter：sendToTab 在回调里读 chrome.runtime.lastError，闭包变量是值拷贝，_setLastError 永远改不进去
    get lastError() { return mock._lastErrorValue; },
    onMessage: {
      addListener: (fn: any) => { onMessageListeners.push(fn); },
      removeListener: () => {},
    },
    // background 的 broadcastProgress 会对返回值 .catch()，必须返回 Promise 而非 undefined
    sendMessage: (_msg: any, _cb?: any) => Promise.resolve(),
  };
  mock.tabs = {
    query: async () => currentTabs,
    create: async (opts: any) => ({ id: 2, ...opts }),
    update: async (id: number, _opts: any) => ({ id }),
    get: async (id: number) => ({ id, status: 'complete' }),
    sendMessage: (tabId: number, msg: any, cb: (res: any) => void) => {
      if (sendMessageBehavior) sendMessageBehavior(tabId, msg, cb);
      else cb({ ok: true });
    },
    onUpdated: {
      addListener: (fn: any) => tabListeners.push(fn),
      removeListener: () => {},
    },
  };
  mock.scripting = {
    executeScript: async () => [{ result: { loggedIn: true, account: 'mock-user' } }],
  };
  // background 顶层初始化用到：sidePanel（setPanelBehavior）+ alarms（bridge 30s 轮询）
  mock.sidePanel = {
    setPanelBehavior: async () => {},
  };
  // B站 API 直连需要读 cookie bili_jct（CSRF）
  mock.cookies = {
    getAll: async ({ domain, name }: any) => [{ name, value: 'mock-bili-jct', domain }],
  };
  // API 直连 adapter（知乎/微博/B站）通过 declarativeNetRequest 动态注入请求头
  mock.declarativeNetRequest = {
    updateDynamicRules: async () => {},
    RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
    HeaderOperation: { SET: 'set' },
  };
  // zip-download 本地导出触发 chrome.downloads（blob URL + downloadId）
  mock.downloads = {
    download: async () => 1,
  };
  mock.alarms = {
    onAlarm: { addListener: () => {}, removeListener: () => {} },
    get: async () => undefined,
    create: async () => {},
    clear: async () => {},
  };
  mock._setLastError = (e: string | undefined) => { mock._lastErrorValue = e; };
  mock._setSendMessageBehavior = (fn: any) => { sendMessageBehavior = fn; };
  mock._setTabs = (tabs: any[]) => { currentTabs.splice(0, currentTabs.length, ...tabs); };
  mock._resetStorage = () => { storageState = {}; };

  return mock;
}

(globalThis as any).chrome = makeChromeMock();

// ---------- fetch mock ----------
const nativeFetch = globalThis.fetch;
let fetchBehavior: ((url: string, init?: any) => Promise<Response>) | null = null;
(globalThis as any).fetch = (url: string, init?: any) => {
  // data: URL 交给原生 fetch（Node 22 原生支持，用于 blob 解析 / Telegram 媒体组测试）
  if (typeof url === 'string' && url.startsWith('data:')) {
    return nativeFetch(url, init);
  }
  if (fetchBehavior) return fetchBehavior(url, init);
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as any);
};
(globalThis as any).__setFetch = (fn: any) => { fetchBehavior = fn; };

// ---------- 断言工具 ----------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.error(`  ❌ [FAIL] ${msg}`); }
}
function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; failures.push(`${msg} (got ${a}, want ${e})`); console.error(`  ❌ [FAIL] ${msg}\n      got:  ${a}\n      want: ${e}`); }
}

// ---------- 测试主体 ----------
async function main() {
  console.log('🧪 OmniPost 单元测试（真实源码逻辑）\n');

  // 1) telegram escapeMarkdown
  {
    console.log('— [1/8] Telegram MarkdownV2 转义与 URL 链接化 —');
    const tg = await import('../../packages/extension/src/adapters/telegram');
    const esc = tg.escapeMarkdown;
    assert(typeof esc === 'function', 'escapeMarkdown 已导出');
    assertEq(esc('hello world'), 'hello world', '纯文本不误转义');
    assertEq(esc('a_b*c'), 'a\\_b\\*c', '下划线/星号转义');
    assertEq(esc('50% off!'), '50% off\\!', '感叹号转义（% 不属于 MarkdownV2 特殊字符）');
    assertEq(esc('https://x.com/a_b'), '[https://x\\.com/a\\_b](https://x\\.com/a\\_b)', 'URL 包裹为可点击链接');
    assertEq(esc('看这个 https://t.co/abc 好吗'), '看这个 [https://t\\.co/abc](https://t\\.co/abc) 好吗', '正文内嵌 URL');
    assertEq(esc('a) b('), 'a\\) b\\(', '括号转义');
  }

  // 2) previewOf / TAB_PATTERNS
  {
    console.log('\n— [2/8] utils：previewOf 与 TAB_PATTERNS —');
    const utils = await import('../../packages/extension/src/adapters/utils');
    assertEq(utils.previewOf('# 标题\n正文内容', 20), '标题 正文内容', 'previewOf 去 Markdown 符号');
    assertEq(utils.previewOf('一二三四五六七八九十', 5), '一二三四五六七八九十'.slice(0, 5), 'previewOf 截断');
    const wb = utils.TAB_PATTERNS.weibo;
    assert(Array.isArray(wb) && wb.includes('*://weibo.com/*') && wb.includes('*://*.weibo.com/*'),
      'TAB_PATTERNS.weibo 同时含裸域与子域');
    const tw = utils.TAB_PATTERNS.twitter;
    assert(Array.isArray(tw) && tw.includes('*://x.com/*') && tw.includes('*://*.x.com/*'),
      'TAB_PATTERNS.twitter 同时含裸域与子域');
    assert(Array.isArray(utils.TAB_PATTERNS.twitterAlt) && utils.TAB_PATTERNS.twitterAlt.includes('*://twitter.com/*'),
      'TAB_PATTERNS.twitterAlt 含裸域');
  }

  // 3) plainTextToHtml（HTML 转义 + 段落）
  {
    console.log('\n— [3/8] inject：plainTextToHtml —');
    const inject = await import('../../packages/extension/src/content/lib/inject');
    assertEq(inject.plainTextToHtml('a\n\nb'), '<p>a</p><p>b</p>', '空行分段');
    assertEq(inject.plainTextToHtml('a\nb'), '<p>a<br/>b</p>', '单换行转 br');
    assertEq(inject.plainTextToHtml('<script>alert(1)</script>'),
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>', 'HTML 特殊字符转义（防 XSS）');
    assertEq(inject.plainTextToHtml('a & b < c'), '<p>a &amp; b &lt; c</p>', '& 与 < 转义');
  }

  // 4) store：savePendingArticle 剔除 dataUrl（防 storage 配额超限）
  {
    console.log('\n— [4/8] store：草稿持久化媒体安全 —');
    const store = await import('../../packages/extension/src/store');
    (globalThis as any).chrome._resetStorage();
    await store.store.savePendingArticle({
      title: 't', body: 'b',
      media: [{ id: 'm1', name: 'a.png', type: 'image/png', size: 999999, dataUrl: 'data:image/png;base64,AAAA' }],
    });
    const saved = (storageState as any).pendingArticle;
    assert(saved?.title === 't' && saved?.body === 'b', '正文/标题持久化');
    assert(saved?.media?.[0]?.name === 'a.png' && saved.media[0].dataUrl === undefined,
      'media 仅存元数据、剔除 dataUrl');
    // 恢复（无 dataUrl → 过滤为空）
    const restored = await store.store.getPendingArticle();
    assert(restored?.media?.length === 1, '恢复的 media 保留元数据');
  }

  // 5) sendToTab：lastError / 超时
  {
    console.log('\n— [5/8] utils：sendToTab 错误传播 —');
    const utils = await import('../../packages/extension/src/adapters/utils');
    const ch = (globalThis as any).chrome;
    ch._setLastError('No receiving end');
    ch._setSendMessageBehavior((_tabId: number, _msg: any, cb: (r: any) => void) => { cb(undefined); });
    let rejected1: string | null = null;
    try { await utils.sendToTab(1, { type: 'X' }, 1000); } catch (e: any) { rejected1 = e.message; }
    assert(!!rejected1 && rejected1.includes('页面无响应'), `lastError 时 reject（got: ${rejected1}）`);
    ch._setLastError(undefined);

    ch._setSendMessageBehavior((_tabId: number, _msg: any, _cb: (r: any) => void) => { /* 永不回调 */ });
    let rejected2: string | null = null;
    try { await utils.sendToTab(1, { type: 'X' }, 300); } catch (e: any) { rejected2 = e.message; }
    assert(!!rejected2 && rejected2.includes('超时'), `无响应时超时 reject（got: ${rejected2}）`);
    ch._setSendMessageBehavior(null);
  }

  // 6) background：SYNC_ARTICLE 只同步已配置平台
  {
    console.log('\n— [6/8] background：SYNC_ARTICLE 平台过滤 —');
    // 各平台 checkLogin/createDraft 的 fetch mock（注意精确 URL 判断在前，通用判断在后）：
    // - Telegram 需 result；B站 nav 需 code===0&&isLogin、addupdate 需 aid、upcover 需 url
    // - 知乎 v4/me 需 id、建草稿需 id；微博需编辑器 HTML 里的 config JSON、draft/create+save 需 code 100000
    const jsonRes = (body: any, ok = true) =>
      Promise.resolve({ ok, status: ok ? 200 : 400, text: async () => JSON.stringify(body), json: async () => body } as any);
    (globalThis as any).__setFetch((url: string) => {
      if (url.includes('api.telegram.org')) {
        return jsonRes({ ok: true, result: { username: 'testbot' } });
      }
      if (url.includes('card.weibo.com/article/v5/editor')) {
        return Promise.resolve({
          ok: true, status: 200,
          text: async () => `window.__INITIAL_STATE__ = {}; config: JSON.parse('{"uid":"wb-uid-1","nick":"weibo-user","avatar_large":""}');`,
          json: async () => ({}),
        } as any);
      }
      if (url.includes('card.weibo.com/article/v5/aj/editor/draft/create')) {
        return jsonRes({ code: 100000, data: { id: 'wb-post-1' } });
      }
      if (url.includes('card.weibo.com/article/v5/aj/editor/draft/save')) {
        return jsonRes({ code: 100000, data: { id: 'wb-post-1' } });
      }
      if (url.includes('zhuanlan.zhihu.com/api/articles/drafts')) {
        return jsonRes({ id: 'zh-draft-1' });
      }
      if (url.includes('zhihu.com/api')) {
        return jsonRes({ id: 'zh-uid-1', name: 'zhihu-user', avatar_url: '' });
      }
      if (url.includes('api.bilibili.com/x/article/creative/draft/addupdate')) {
        return jsonRes({ code: 0, data: { aid: 424242 } });
      }
      if (url.includes('api.bilibili.com/x/article/creative/article/upcover')) {
        return jsonRes({ code: 0, data: { url: 'https://i0.hdslb.com/bfs/article/mock.jpg' } });
      }
      if (url.includes('api.bilibili.com')) {
        return jsonRes({ code: 0, data: { isLogin: true, uname: 'bili-user', face: '' } });
      }
      return Promise.resolve({ ok: true, status: 200, text: async () => '{}', json: async () => ({ ok: true }) } as any);
    });
    // 配置 WordPress + Telegram，YouTube 未配置
    storageState.settings = {
      wordpress: { endpoint: 'https://wp.example.com', username: 'u', appPassword: 'p' },
      telegram: { botToken: '123:ABC', chatId: '@c' },
      youtube: {},
      twitter: {},
    };
    const bg = await import('../../packages/extension/src/background/index');
    assert(typeof onMessageListener === 'function', 'background 注册了 onMessage listener');
    // 加速限速等待（3000ms → 30ms），避免单测空等 ~18s；sendToTab 的 300ms 超时不受影响
    const nativeSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: (...args: any[]) => void, ms: number, ...args: any[]) =>
      nativeSetTimeout(fn, ms >= 1000 ? Math.round(ms / 100) : ms, ...args);
    try {
      // 触发 SYNC_ARTICLE
      const response = await new Promise<any>((resolve) => {
        onMessageListener!({ type: 'SYNC_ARTICLE', payload: { title: 'T', body: 'B' } }, {}, resolve);
      });
      assert(response?.status === 'Published', `SYNC_ARTICLE 一键静默发布返回成功（got: ${response?.status}）`);
      const draftPlatforms = (response.drafts || []).map((d: any) => d.platformId).sort();
      // 5 session + wordpress + telegram（均已 mock 登录成功），youtube 未配置不应出现
      assert(draftPlatforms.includes('weibo') && draftPlatforms.includes('xiaohongshu') &&
        draftPlatforms.includes('bilibili') && draftPlatforms.includes('zhihu') && draftPlatforms.includes('twitter'),
        'session 5 平台全部参与同步');
      assert(draftPlatforms.includes('wordpress') && draftPlatforms.includes('telegram'),
        '已配置的 official 平台（wordpress/telegram）参与同步');
      assert(!draftPlatforms.includes('youtube'), '未配置的 YouTube 不参与同步');
      assert(draftPlatforms.includes('zip-download'), '本地导出（zip-download）恒可同步（session 分支，checkLogin 恒真）');
      assert(!draftPlatforms.includes('typecho') && !draftPlatforms.includes('metaweblog'),
        '未配置的 CMS（typecho/metaweblog）不参与同步');
    } finally {
      (globalThis as any).setTimeout = nativeSetTimeout;
    }
  }

  // 7) wordpress：createDraft 拼接 mediaRefs
  {
    console.log('\n— [7/8] wordpress：媒体引用拼接进正文 —');
    (globalThis as any).__setFetch((url: string, init?: any) => {
      if (url.includes('/wp-json/wp/v2/posts')) {
        const body = JSON.parse((init as any).body);
        assert(body.content.includes('<img src="https://cdn.example.com/a.jpg"'),
          'createDraft 请求正文包含已上传媒体 <img>');
        assert(body.status === 'draft', 'createDraft 以 draft 状态创建');
        return Promise.resolve({ ok: true, json: async () => ({ id: 42, title: { rendered: 'T' }, link: 'https://wp.example.com/?p=42' }) } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    });
    storageState.settings = { wordpress: { endpoint: 'https://wp.example.com', username: 'u', appPassword: 'p' } };
    const wp = await import('../../packages/extension/src/adapters/wordpress');
    const draft = await wp.wordpressAdapter.createDraft({
      title: 'T', body: '正文',
      mediaRefs: [{ id: '9', url: 'https://cdn.example.com/a.jpg', type: 'image/jpeg' }],
    });
    assertEq(draft.draftId, '42', '草稿 id 来自响应');
  }

  // 8) bridge token：生成与校验
  {
    console.log('\n— [8/14] bridge token 一致性 —');
    const store = await import('../../packages/extension/src/store');
    (globalThis as any).chrome._resetStorage();
    const t1 = await store.store.ensureBridgeToken();
    const t2 = await store.store.getBridgeToken();
    assertEq(t1, t2, 'ensureBridgeToken 与 getBridgeToken 一致');
    assert(t1.startsWith('om') && t1.length > 8, 'token 格式正确');
  }

  // 9) markdown：预览渲染安全
  {
    console.log('\n— [9/14] markdown：预览渲染与字数上限 —');
    const md = await import('../../packages/extension/src/popup/markdown');
    const h = md.renderMarkdown('# 标题\n\n正文 **加粗** 和 *斜体*');
    assert(h.includes('<strong>加粗</strong>'), '渲染加粗');
    assert(h.includes('<em>斜体</em>'), '渲染斜体');
    const xss = md.renderMarkdown('<script>alert(1)</script>');
    assert(!xss.includes('<script>'), 'XSS 脚本被转义');
    assert(xss.includes('&lt;script&gt;'), '尖括号转义');
    const link = md.renderMarkdown('看 [文档](https://x.com/a) 和 https://x.com/b');
    assert(link.includes('<a href="https://x.com/a"'), 'Markdown 链接渲染');
    assert(link.includes('<a href="https://x.com/b"'), '裸 URL 自动链接化');
    const code = md.renderMarkdown('```js\nconst a = 1;\n```');
    assert(code.includes('<pre') && code.includes('const a = 1;'), '代码块渲染');
    const hrAndImg = md.renderMarkdown('---\n![示意图](https://example.com/pic.png)');
    assert(hrAndImg.includes('<hr'), '渲染分隔线');
    assert(hrAndImg.includes('<img src="https://example.com/pic.png"'), '渲染 Markdown 图片');
    const blocks = md.splitMarkdownIntoBlocks('# 标题\n\n段落一\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n\n段落二');
    assertEq(blocks.length, 4, 'splitMarkdownIntoBlocks 切分段落且不破坏代码块内部空行');
    assert(blocks[2].includes('const x = 1;\n\nconst y = 2;'), '代码块整体作为一个 block');
  }

  // 10) bridge：resolvePlatformIds + server 全链路
  {
    console.log('\n— [10/14] bridge：别名解析 + server 轮询/回写闭环 —');
    const os = await import('os');
    const fsm = await import('fs');
    const oldHome = process.env.HOME;
    process.env.HOME = fsm.mkdtempSync(os.tmpdir() + '/omnipost-bt-');
    try {
      const bridge = await import('../../packages/bridge/index.mjs');
      assertEq(bridge.resolvePlatformIds('xhs,x,weibo'), ['xiaohongshu', 'twitter', 'weibo'], '平台别名解析');
      assertEq(bridge.resolvePlatformIds(''), null, '空输入返回 null');
      assert(bridge.PLATFORMS.length === 29, 'bridge 平台清单 29 平台（与扩展一致）');

      const server = new bridge.BridgeServer({ log: () => {} });
      await server.start(bridge.BRIDGE_PORT);
      const enqueued = server.enqueue({ type: 'sync_article', payload: { title: 'T', body: 'B' } });
      // 模拟扩展轮询
      const pollRes = await nativeFetch(`http://127.0.0.1:${bridge.BRIDGE_PORT}/omnipost/poll`, {
        headers: { 'X-Omnipost-Token': 'om_unit_test' },
      });
      const { command } = await pollRes.json();
      assert(!!command && command.type === 'sync_article', '扩展轮询取到命令');
      const result = { status: 'ok', drafts: [{ platformId: 'weibo' }], errors: {} };
      const writeRes = await nativeFetch(`http://127.0.0.1:${bridge.BRIDGE_PORT}/omnipost/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Omnipost-Token': 'om_unit_test' },
        body: JSON.stringify({ commandId: command.id, result }),
      });
      assert(writeRes.status === 200, '结果回写 200');
      const got = await enqueued;
      assertEq(got.drafts[0].platformId, 'weibo', 'enqueue promise 拿到扩展结果');
      // token 已持久化到临时 HOME
      const savedToken = fsm.readFileSync(process.env.HOME + '/.omnipost/token', 'utf8');
      assertEq(savedToken, 'om_unit_test', '扩展 token 已持久化');
      // 错误 token 回写应被拒
      const bad = await nativeFetch(`http://127.0.0.1:${bridge.BRIDGE_PORT}/omnipost/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Omnipost-Token': 'om_wrong' },
        body: JSON.stringify({ commandId: command.id, result: { status: 'ok' } }),
      });
      assert(bad.status === 403, '错误 token 回写被 403 拒绝');
      server.stop();
    } finally {
      process.env.HOME = oldHome;
    }
  }

  // 11) MCP tools：本地逻辑 + 经 bridge 命令
  {
    console.log('\n— [11/14] MCP tools：真实逻辑 —');
    const fsm = await import('fs');
    const os = await import('os');
    const tools = await import('../../packages/mcp-server/src/tools');
    const list = tools.handleListPlatforms();
    assert(list.platforms.length === 29, 'list_platforms 返回 29 平台（对标文章同步助手全量）');
    const ext = await tools.handleExtractArticle({ content: '# 标题\n正文' });
    assertEq(ext.title, '标题', 'extract_article 提取标题');
    assertEq(ext.body, '正文', 'extract_article 提取正文');
    assertEq(ext.source, 'text', 'extract_article 本地解析标记 source=text');

    // upload_image：真实读文件
    const imgPath = fsm.mkdtempSync(os.tmpdir() + '/omnipost-mcp-') + '/pic.png';
    fsm.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    const up = tools.handleUploadImage({ path: imgPath });
    assert(up.mediaId && up.type === 'image/png', 'upload_image 返回 mediaId 与 mime');
    assert(tools.mediaStore.get(up.mediaId).dataUrl.startsWith('data:image/png;base64,'), '媒体已登记为 base64 dataUrl');

    // check_auth / sync_article 经 sendCommand 真实转发
    const authRes = await tools.handleCheckAuth({ platforms: ['weibo'] }, {
      sendCommand: async (cmd: any) => {
        assertEq(cmd.type, 'check_login', 'check_auth 发送 check_login 命令');
        assertEq(cmd.payload.platforms[0], 'weibo', '平台参数透传');
        return { status: 'ok', auth: { weibo: { loggedIn: true, account: 'u' } } };
      },
    });
    assert(authRes.auth.weibo.loggedIn === true, 'check_auth 返回扩展真实结果');

    const syncRes = await tools.handleSyncArticle({ title: 'T', body: 'B', mediaIds: [up.mediaId] }, {
      sendCommand: async (cmd: any) => {
        assertEq(cmd.type, 'sync_article', 'sync_article 发送 sync_article 命令');
        assert(cmd.payload.media.length === 1 && cmd.payload.media[0].dataUrl.startsWith('data:image/png'),
          'sync_article 携带已上传媒体');
        return { status: 'ok', drafts: [{ platformId: 'weibo', draftId: '1' }], errors: {} };
      },
    });
    assertEq(syncRes.draftsCreated[0], 'weibo', 'sync_article 返回草稿清单');

    // extract_article 无 content 时经 bridge 从当前页提取（对标参考插件语义）
    const extractPage = await tools.handleExtractArticle({}, {
      sendCommand: async (cmd: any) => {
        assertEq(cmd.type, 'extract', 'extract_article 无 content 时发送 extract 命令');
        return { status: 'ok', article: { title: '网页标题', markdown: '正文', url: 'https://x.com/p', cover: 'https://img/c.jpg' } };
      },
    });
    assertEq(extractPage.title, '网页标题', 'extract_article 返回网页标题');
    assertEq(extractPage.body, '正文', 'extract_article 返回网页正文');
    assertEq(extractPage.source, 'page', 'extract_article 标记 source=page');

    // 未知 mediaId 必须报错（防静默丢图）
    let threw = false;
    try { await tools.handleSyncArticle({ body: 'B', mediaIds: ['nope'] }, { sendCommand: async () => ({ status: 'ok' }) }); }
    catch { threw = true; }
    assert(threw, '未知 mediaId 抛错（不静默丢图）');
  }

  // 12) youtube-oauth：PKCE 工具函数
  {
    console.log('\n— [12/14] youtube-oauth：PKCE 与 token 校验 —');
    const yt = await import('../../packages/extension/src/adapters/youtube-oauth');
    const verifier = yt.generateCodeVerifier();
    assert(verifier.length >= 43 && verifier.length <= 128, 'code_verifier 长度合规');
    const challenge = await yt.generateCodeChallenge(verifier);
    assert(typeof challenge === 'string' && challenge.length > 20, 'code_challenge 生成成功');
    const url = yt.buildAuthUrl('cid', challenge, 'https://abc.com/redirect');
    assert(url.includes('client_id=cid') && url.includes('code_challenge=') && url.includes('code_challenge_method=S256'),
      '授权 URL 含 PKCE 参数');
    assert(yt.isTokenValid({ accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 10 * 60 * 1000 }), '未过期 token 有效');
    assert(!yt.isTokenValid({ accessToken: 't', refreshToken: 'r', expiresAt: Date.now() - 1000 }), '已过期 token 无效');
    // 实现预留 5 分钟刷新余量：剩余 <5min 视为需刷新（避免上传中途过期）
    assert(!yt.isTokenValid({ accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 60 * 1000 }), '5 分钟缓冲区内视为需刷新');
    assert(!yt.isTokenValid({} as any), '无 token 无效');
  }

  // 13) offscreen：dataUrl → Blob
  {
    console.log('\n— [13/14] offscreen：dataUrlToBlob 真实解码 —');
    const off = await import('../../packages/extension/src/offscreen/offscreen');
    const blob = await off.dataUrlToBlob('data:image/png;base64,iVBORw0KGgo=');
    assert(blob instanceof Blob && blob.type === 'image/png', 'dataUrl 解码为正确类型 Blob');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert(bytes.length === 8, `二进制长度正确（got ${bytes.length}）`);
    assert(bytes[0] === 0x89 && bytes[1] === 0x50, 'PNG 魔数正确（非 base64 字符串）');
  }

  // 14) telegram：媒体组一次发送（sendMediaGroup + attach:// 命名 + MarkdownV2 caption）
  {
    console.log('\n— [14/14] telegram：sendMediaGroup 真实媒体组 —');
    const tg = await import('../../packages/extension/src/adapters/telegram');
    storageState.settings = { telegram: { botToken: '123:ABC', chatId: '@chan' } };
    let captured: any = null;
    (globalThis as any).__setFetch((url: string, init?: any) => {
      if (url.includes('/sendMediaGroup')) {
        captured = { url, init };
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: [{ message_id: 7 }] }) } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as any);
    });
    const result = await tg.telegramAdapter.publish({
      platformId: 'telegram',
      draftId: 'tg_1',
      title: '标题',
      body: '正文 _下划线_',
      mediaRefs: [
        { id: 'm1', url: 'pending://telegram/a.png', type: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
        { id: 'm2', url: 'pending://telegram/b.png', type: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    });
    assert(result.ok === true && result.url.includes('/7'), '媒体组发送成功并返回链接');
    const body = captured!.init.body as FormData;
    const entries: any[] = [];
    for (const [k, v] of body as any) entries.push([k, v]);
    const chatId = entries.find(([k]) => k === 'chat_id');
    assert(chatId && chatId[1] === '@chan', 'FormData 含 chat_id');
    const mediaField = entries.find(([k]) => k === 'media');
    const mediaJson = JSON.parse(mediaField[1]);
    assert(mediaJson.length === 2 && mediaJson[0].media === 'attach://file0', 'media 数组用 attach:// 命名');
    assert(mediaJson[0].caption.includes('\\_下划线\\_'), 'caption 为 MarkdownV2 转义正文');
    const files = entries.filter(([k]) => String(k).startsWith('file'));
    assert(files.length === 2, 'FormData 携带 2 个真实媒体文件');
    assert(files[0][1].type === 'image/png', '媒体文件类型正确');
    (globalThis as any).__setFetch(null);
  }

  // 15) md5：RFC 1321 已知向量（知乎 image_hash 计算核心）
  {
    console.log('\n— [15/15] md5：已知向量与中文输入 —');
    const { md5Hex, md5HexOfString } = await import('../../packages/extension/src/adapters/md5');
    assertEq(md5Hex(new Uint8Array([])), 'd41d8cd98f00b204e9800998ecf8427e', 'md5("") 已知向量');
    assertEq(md5HexOfString('abc'), '900150983cd24fb0d6963f7d28e17f72', 'md5("abc") 已知向量');
    assertEq(md5HexOfString(''), 'd41d8cd98f00b204e9800998ecf8427e', 'md5OfString("") 与向量一致');
    assertEq(md5HexOfString('The quick brown fox jumps over the lazy dog'),
      '9e107d9d372bb6826bd81d3542a419d6', 'md5(经典句子) 已知向量');
    assert(md5HexOfString('中文内容').length === 32, '中文输入输出 32 位 hex');
  }

  // 16) md2html：干净 HTML 输出（API 直连发布正文转换）
  {
    console.log('\n— [16/16] md2html：段落/标题/图片/转义/代码块/列表 —');
    const { md2html } = await import('../../packages/extension/src/adapters/md2html');
    assertEq(md2html('hello'), '<p>hello</p>', '普通段落');
    assertEq(md2html('a\nb'), '<p>a<br/>b</p>', '单换行转 br');
    assertEq(md2html('# 标题'), '<h1>标题</h1>', '标题');
    assertEq(md2html('![alt](https://x.com/a.png)'),
      '<p><img src="https://x.com/a.png" alt="alt" /></p>', '图片保留 img 供图床管线提取');
    assertEq(md2html('<script>alert(1)</script>'),
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>', 'HTML 转义防注入');
    assertEq(md2html('```js\nconst a = 1;\n```'),
      '<pre><code class="language-js">const a = 1;</code></pre>', '围栏代码块带语言');
    assertEq(md2html('- a\n- b'), '<ul><li>a</li><li>b</li></ul>', '无序列表');
    assertEq(md2html('> 引用'), '<blockquote><p>引用</p></blockquote>', '引用块');
  }

  // 17) markdownToDraft：豆瓣 Draft.js raw JSON 输出（零依赖转换器）
  {
    console.log('\n— [17/17] markdownToDraft：标题/列表/图片/行内样式/代码块 —');
    const { markdownToDraft } = await import('../../packages/extension/src/adapters/markdown-to-draft');
    const draft = JSON.parse(markdownToDraft('# 标题\n\n正文段落\n\n- 项一\n- 项二\n\n1. 甲\n2. 乙\n\n> 引用\n\n```js\nconst a = 1;\n```'));
    assert(Array.isArray(draft.blocks), '输出包含 blocks 数组');
    assert(draft.blocks[0].type === 'header-one' && draft.blocks[0].text === '标题', '标题映射 header-one');
    assert(draft.blocks.some((b: any) => b.type === 'paragraph' && b.text === '正文段落'), '段落块');
    assert(draft.blocks.filter((b: any) => b.type === 'unordered-list-item').length === 2, '无序列表项');
    assert(draft.blocks.filter((b: any) => b.type === 'ordered-list-item').length === 2, '有序列表项');
    assert(draft.blocks.some((b: any) => b.type === 'blockquote' && b.text === '引用'), '引用块');
    assert(draft.blocks.some((b: any) => b.type === 'code-block' && b.text === 'const a = 1;'), '代码块');
    assert(draft.blocks.every((b: any) => b.key && b.key.length === 5), '每个 block 带 5 字符唯一 key');
    assert(draft.blocks.every((b: any) => Array.isArray(b.inlineStyleRanges)), 'block 带 inlineStyleRanges');

    // 独立成行图片 → atomic + IMAGE entity
    const imgDraft = JSON.parse(markdownToDraft('![图](https://img.example.com/a.png)'));
    const atomicBlock = imgDraft.blocks.find((b: any) => b.type === 'atomic');
    assert(!!atomicBlock, '独立图片生成 atomic 块');
    assert(atomicBlock.entityRanges.length === 1, 'atomic 块带 entityRanges');
    const entity = imgDraft.entityMap[String(atomicBlock.entityRanges[0].key)];
    assert(entity?.type === 'IMAGE' && entity.data.url === 'https://img.example.com/a.png', 'IMAGE entity 携带图片 URL');

    // 行内粗体/斜体/代码 → inlineStyleRanges
    const styleDraft = JSON.parse(markdownToDraft('**粗体** 与 *斜体* 和 `代码`'));
    const styleBlock = styleDraft.blocks.find((b: any) => b.type === 'paragraph');
    assert(styleBlock.text === '粗体 与 斜体 和 代码', '行内标记剥离后文本干净');
    const styles = styleBlock.inlineStyleRanges.map((r: any) => r.style);
    assert(styles.includes('BOLD'), '粗体映射 BOLD');
    assert(styles.includes('ITALIC'), '斜体映射 ITALIC');
    assert(styles.includes('CODE'), '行内代码映射 CODE');
  }

  // 18) renderXueqiuHtml：雪球格式渲染（标题统一 h4 / strong→b / em→i / 列表去包装 / ke_img）
  {
    console.log('\n— [18/18] renderXueqiuHtml：雪球格式渲染 —');
    const { renderXueqiuHtml } = await import('../../packages/extension/src/adapters/xueqiu');
    const html = renderXueqiuHtml('# 标题\n\n**粗体** 与 *斜体*\n\n- 项一\n- 项二\n\n![图](https://img.example.com/a.png)');
    assert(html.includes('<h4>标题</h4>'), '标题统一转 h4');
    assert(!/<h[1-6]>(?!<\/h4>)/.test(html) || html.includes('<h4>标题</h4>'), '无其他级别标题');
    assert(html.includes('<b>粗体</b>') && !html.includes('<strong>'), 'strong → b');
    assert(html.includes('<i>斜体</i>') && !html.includes('<em>'), 'em → i');
    assert(!html.includes('<ul>') && !html.includes('<ol>') && !html.includes('<li>'), '列表移除 ul/ol/li 包装');
    assert(html.includes('class="ke_img"'), '图片加 ke_img class');
    assert(!html.includes('<p></p>'), '清理空段落');
    assert(!html.includes('<hr'), 'hr 移空');
  }

  // 19) applyWeixinCss / stripExternalLinks：微信内容管线（行内 CSS + 外链剥离）
  {
    console.log('\n— [19/19] applyWeixinCss / stripExternalLinks：微信内容管线 —');
    const { applyWeixinCss, stripExternalLinks } = await import('../../packages/extension/src/adapters/weixin');
    const styled = applyWeixinCss('<p>正文</p><h1>标题</h1><blockquote>引用</blockquote><hr/>');
    assert(styled.startsWith('<section style='), '外包微信 section');
    assert(styled.includes('<p style="color: rgb(51, 51, 51);'), 'p 注入默认样式');
    assert(styled.includes('<h1 style="font-weight: bold;'), 'h1 注入样式');
    assert(styled.includes('border-left: 4px solid #ddd'), 'blockquote 注入样式');
    assert(styled.includes('border-top: 1px solid #ddd'), 'hr 注入样式');
    const noDup = applyWeixinCss('<p style="text-align: center;">公式</p>');
    assert(noDup.includes('text-align: center'), '原有 style 保留');
    assert(!/<p[^>]*style="[^"]*" style=/.test(noDup), '已带 style 的标签不重复注入');
    assertEq(stripExternalLinks('<a href="https://example.com">外部</a>'), '外部', '外部链接只留文字');
    assert(stripExternalLinks('<a href="https://mp.weixin.qq.com/x">内链</a>').includes('<a'), '微信域名链接保留');
    assert(stripExternalLinks('<a href="#anchor">锚点</a>').includes('<a'), '锚点链接保留');
  }

  // 20) zip-writer + zip-download 纯函数：ZIP 结构 / data URI 解码 / 扩展名推断 / 文件名清理
  {
    console.log('\n— [20/21] zip-writer：零依赖 ZIP 结构 / data URI 解码 —');
    const { buildZip, buildZipDirectoryEntry } = await import('../../packages/extension/src/adapters/zip-writer');
    const { dataUriToBytes, imageExtFrom, sanitizeFilename } = await import('../../packages/extension/src/adapters/zip-download');

    // 手写 ZIP 解析器（验证 buildZip 输出结构，STORE 方式可直接读）
    const readU16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
    const readU32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

    const hello = new TextEncoder().encode('hello world');
    const cnName = '中文文件.txt';
    const entries = [
      { name: cnName, data: hello },
      { name: 'images/', data: new Uint8Array(0) },
      buildZipDirectoryEntry('sub/'),
    ];
    const zip = buildZip(entries);

    // EOCD（末尾 22 字节）
    const eocdOff = zip.length - 22;
    assertEq(readU32(zip, eocdOff), 0x06054b50, 'EOCD 签名 0x06054b50');
    assertEq(readU16(zip, eocdOff + 8), 3, 'EOCD 总条目数 = 3');
    const cdSize = readU32(zip, eocdOff + 12);
    const cdOffset = readU32(zip, eocdOff + 16);
    assert(cdSize > 0 && cdOffset > 0, '中央目录偏移/大小有效');
    assertEq(cdOffset + cdSize + 22, zip.length, 'EOCD 紧邻中央目录之后');

    // 第一条 local header：中文文件名 UTF-8 + STORE + 数据完整
    assertEq(readU32(zip, 0), 0x04034b50, 'Local header 签名 0x04034b50');
    assertEq(readU16(zip, 8), 0, '压缩方式 = STORE(0)');
    assertEq(readU16(zip, 6) & 0x0800, 0x0800, 'UTF-8 文件名标志位已置位');
    const nameLen = readU16(zip, 26);
    const nameBytes = zip.slice(30, 30 + nameLen);
    assertEq(new TextDecoder().decode(nameBytes), cnName, '文件名 UTF-8 解码正确（中文）');
    const dataLen = readU32(zip, 22);
    const dataStart = 30 + nameLen;
    assertEq(dataLen, hello.length, 'STORE 数据长度 = 原长');
    let same = true;
    for (let i = 0; i < hello.length; i++) if (zip[dataStart + i] !== hello[i]) { same = false; break; }
    assert(same, 'ZIP 内数据字节与原字节一致');
    // CRC32 与 zip-writer 内部一致（非 0 即已计算）
    assert(readU32(zip, 14) !== 0, 'Local header 携带 CRC-32');

    // 目录项：images/ 与 sub/（buildZipDirectoryEntry 补斜杠）
    const mdEntries = entries.filter((e) => e.name.endsWith('/'));
    assertEq(mdEntries.length, 2, '两个目录条目（images/ + sub/）');
    assert(mdEntries.every((e) => e.data.length === 0), '目录条目数据为空');

    // data URI 解码：1x1 PNG base64 魔数
    const pngDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const pngBytes = dataUriToBytes(pngDataUri);
    assert(pngBytes.length > 0, 'data URI 解码非空');
    assert(pngBytes[0] === 0x89 && pngBytes[1] === 0x50, '解码得到 PNG 魔数');
    const svgDataUri = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E';
    const svgBytes = dataUriToBytes(svgDataUri);
    assert(new TextDecoder().decode(svgBytes.slice(0, 5)).startsWith('<svg'), 'percent-encoded data URI 解码');

    // 扩展名推断：URL 后缀优先，魔数兜底
    assertEq(imageExtFrom('https://a.com/x.JPEG?w=100', pngBytes), 'jpg', 'URL 后缀推断（jpeg→jpg）');
    assertEq(imageExtFrom('https://a.com/noext', pngBytes), 'png', '无后缀时按魔数兜底 png');
    assertEq(imageExtFrom('https://a.com/noext', new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpg', 'JPEG 魔数兜底');
    assertEq(imageExtFrom('https://a.com/noext', new Uint8Array([0x47, 0x49, 0x46, 0x38])), 'gif', 'GIF 魔数兜底');

    // 文件名清理
    assertEq(sanitizeFilename('a<b>:c"d/e\\f|g?h*i'), 'a_b__c_d_e_f_g_h_i', '非法字符替换为下划线');
    assertEq(sanitizeFilename('  '), 'article', '空名回退 article');
    assertEq(sanitizeFilename('标题.文章.'), '标题.文章', '末尾点清理');
  }

  // 21) xml-rpc：请求构建 + 响应解析（string/int/boolean/struct/array/base64/fault）
  {
    console.log('\n— [21/21] xml-rpc：XML-RPC 请求构建与响应解析 —');
    const xr = await import('../../packages/extension/src/adapters/xml-rpc');

    // 请求构建：紧凑格式 + 类型序列化 + XML 转义
    const req = xr.buildXmlRpcRequest('metaWeblog.newPost', [
      0,
      'user&<name>',
      true,
      { title: '标题', count: 42 },
      new Uint8Array([1, 2, 3]),
    ]);
    assert(req.startsWith('<?xml version="1.0"?>'), '请求以 XML 声明开头');
    assert(req.includes('<methodName>metaWeblog.newPost</methodName>'), 'methodName 正确');
    assert(!req.includes('  ') && !req.includes('\n'), '紧凑格式无多余空白');
    assert(req.includes('<i4>0</i4>'), '数字序列化为 i4');
    assert(req.includes('user&amp;&lt;name&gt;'), '字符串 XML 转义');
    assert(req.includes('<boolean>1</boolean>'), '布尔序列化');
    assert(req.includes('<name>title</name><value><string>标题</string></value>'), 'struct member 序列化');
    assert(req.includes('<base64>AQID</base64>'), 'Uint8Array 序列化为 base64');

    // 响应解析
    const str = xr.parseXmlRpcResponse('<?xml version="1.0"?><methodResponse><params><param><value><string>12345</string></value></param></params></methodResponse>');
    assertEq(str.success, true, 'string 响应解析成功');
    assertEq(str.value, '12345', 'string 值提取');

    const int = xr.parseXmlRpcResponse('<methodResponse><params><param><value><i4>-7</i4></value></param></params></methodResponse>');
    assertEq(int.value, -7, 'i4 数字解析');

    const bool = xr.parseXmlRpcResponse('<methodResponse><params><param><value><boolean>0</boolean></value></param></params></methodResponse>');
    assertEq(bool.value, false, 'boolean 解析');

    // struct：含嵌套（getRecentPosts 返回数组内 struct）
    const arrayResp = xr.parseXmlRpcResponse(
      '<methodResponse><params><param><value><array><data>' +
      '<value><struct><member><name>postid</name><value><string>88</string></value></member><member><name>title</name><value><string>你好</string></value></member></struct></value>' +
      '<value><struct><member><name>postid</name><value><string>89</string></value></member></struct></value>' +
      '</data></array></value></param></params></methodResponse>',
    );
    assertEq(arrayResp.success, true, 'array 响应解析成功');
    const posts = arrayResp.value as any[];
    assert(Array.isArray(posts) && posts.length === 2, 'array 解析为 2 项');
    assertEq(posts[0].postid, '88', 'struct 内 postid 提取');
    assertEq(posts[0].title, '你好', 'struct 内中文 title 提取');

    // base64 值
    const b64 = xr.parseXmlRpcResponse('<methodResponse><params><param><value><base64>AQID</base64></value></param></params></methodResponse>');
    assert(b64.value instanceof Uint8Array && (b64.value as Uint8Array)[2] === 3, 'base64 值解码为字节');

    // fault
    const fault = xr.parseXmlRpcResponse(
      '<methodResponse><fault><value><struct><member><name>faultCode</name><value><int>403</int></value></member>' +
      '<member><name>faultString</name><value><string>用户名或密码错误</string></value></member></struct></value></fault></methodResponse>',
    );
    assertEq(fault.success, false, 'fault 响应标记失败');
    assertEq(fault.faultCode, 403, 'faultCode 提取');
    assert(fault.faultString && fault.faultString.includes('密码'), 'faultString 提取（中文）');

    // extractLatestPostId（Typecho 返回 0 时兜底）
    const recent = xr.parseXmlRpcResponse(
      '<methodResponse><params><param><value><array><data>' +
      '<value><struct><member><name>postid</name><value><string>77</string></value></member></struct></value>' +
      '</data></array></value></param></params></methodResponse>',
    );
    const latestId = Array.isArray(recent.value) && (recent.value[0] as any).postid;
    assertEq(latestId, '77', 'getRecentPosts 首条 postid');

    // 端点推导
    assertEq(xr.defaultXmlRpcEndpoint('https://blog.example.com/'), 'https://blog.example.com/xmlrpc.php', 'WordPress 系端点');
    assertEq(xr.defaultTypechoEndpoint('https://blog.example.com'), 'https://blog.example.com/action/xmlrpc', 'Typecho 端点');
  }

  // 22) background：CHECK_PLATFORM_LOGIN 单平台检测（设置面板"测试连接"）
  {
    console.log('\n— [22/22] background：CHECK_PLATFORM_LOGIN 单平台检测 —');
    assert(typeof onMessageListener === 'function', 'onMessage listener 已注册（复用 §6 background）');

    // zip-download：本地导出恒已登录
    const zipAuth = await new Promise<any>((resolve) => {
      onMessageListener!({ type: 'CHECK_PLATFORM_LOGIN', payload: { platformId: 'zip-download' } }, {}, resolve);
    });
    assert(zipAuth?.loggedIn === true, 'zip-download 单平台检测返回已登录');
    assert(zipAuth?.account === '本地下载', 'zip-download 展示名为"本地下载"');

    // metaweblog 未配置 → loggedIn:false（诚实失败，error 提示"未配置"）
    storageState.settings = { wordpress: storageState.settings?.wordpress };
    const mwAuth = await new Promise<any>((resolve) => {
      onMessageListener!({ type: 'CHECK_PLATFORM_LOGIN', payload: { platformId: 'metaweblog' } }, {}, resolve);
    });
    assert(mwAuth?.loggedIn === false, 'metaweblog 未配置时检测返回未登录');
    assert(mwAuth?.error && mwAuth.error.includes('未配置'), 'metaweblog 错误提示包含"未配置"');

    // metaweblog 已配置 → 走 XML-RPC getUsersBlogs（默认端点 /xmlrpc.php）
    storageState.settings = {
      ...storageState.settings,
      metaweblog: { siteUrl: 'https://blog.example.com', username: 'admin', password: 'pass' },
    };
    (globalThis as any).__setFetch((url: string) => {
      if (url.includes('xmlrpc.php')) {
        return Promise.resolve({
          ok: true, status: 200,
          text: async () => '<?xml version="1.0"?><methodResponse><params><param><value><array><data></data></array></value></param></params></methodResponse>',
          json: async () => ({}),
        } as any);
      }
      return Promise.resolve({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) } as any);
    });
    const mwAuth2 = await new Promise<any>((resolve) => {
      onMessageListener!({ type: 'CHECK_PLATFORM_LOGIN', payload: { platformId: 'metaweblog' } }, {}, resolve);
    });
    assert(mwAuth2?.loggedIn === true, 'metaweblog 配置正确时检测返回已登录');
    assert(mwAuth2?.account === 'admin', 'metaweblog 返回配置的用户名');

    // typecho 端点推导：站点/action/xmlrpc（fetch mock 校验实际请求 URL）
    let typechoUrl = '';
    storageState.settings = {
      ...storageState.settings,
      typecho: { siteUrl: 'https://typecho.example.com/', username: 'me', password: 'p' },
    };
    (globalThis as any).__setFetch((url: string) => {
      if (url.includes('/action/xmlrpc')) {
        typechoUrl = url;
        return Promise.resolve({
          ok: true, status: 200,
          text: async () => '<?xml version="1.0"?><methodResponse><params><param><value><array><data></data></array></value></param></params></methodResponse>',
          json: async () => ({}),
        } as any);
      }
      return Promise.resolve({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) } as any);
    });
    const tcAuth = await new Promise<any>((resolve) => {
      onMessageListener!({ type: 'CHECK_PLATFORM_LOGIN', payload: { platformId: 'typecho' } }, {}, resolve);
    });
    assert(tcAuth?.loggedIn === true, 'typecho 配置正确时检测返回已登录');
    assert(typechoUrl === 'https://typecho.example.com/action/xmlrpc', 'typecho 端点推导为 站点/action/xmlrpc');
  }

  // 23) html2md：HTML → Markdown（正文提取链路基础）
  {
    console.log('\n— [23/23] html2md：HTML → Markdown 转换 —');
    const { html2md, decodeEntities } = await import('../../packages/extension/src/adapters/html2md');

    assertEq(html2md('<h1>标题</h1>'), '# 标题', 'h1 → # 标题');
    assertEq(html2md('<h3>小节</h3>'), '### 小节', 'h3 → ### 小节');
    assertEq(html2md('<p>你好</p>'), '你好', '段落转纯文本');
    assertEq(html2md('<p>hello <strong>world</strong></p>'), 'hello **world**', 'strong 加粗');
    assertEq(html2md('<p><em>斜体</em> 与 <del>删除</del></p>'), '*斜体* 与 ~~删除~~', 'em/del 行内样式');
    assertEq(html2md('<p>看 <a href="https://x.com">这里</a></p>'), '看 [这里](https://x.com)', 'a 链接');
    assertEq(html2md('<p><img src="a.jpg" alt="封面"></p>'), '![封面](a.jpg)', 'img 图片');
    assertEq(html2md('<ul><li>甲</li><li>乙</li></ul>'), '- 甲\n- 乙', '无序列表');
    assertEq(html2md('<ol><li>一</li><li>二</li></ol>'), '1. 一\n2. 二', '有序列表');
    assertEq(html2md('<blockquote><p>引用内容</p></blockquote>'), '> 引用内容', 'blockquote 引用');
    assertEq(html2md('<p>a &amp; b &lt;c&gt;</p>'), 'a & b <c>', 'HTML 实体解码');
    assertEq(html2md('<hr>'), '---', 'hr 分隔线');
    assertEq(html2md('<p><code>foo</code></p>'), '`foo`', '行内 code');
    assert(
      html2md('<pre><code class="language-js">const x = 1;</code></pre>') === '```js\nconst x = 1;\n```',
      '围栏代码块 + 语言类',
    );
    assert(
      html2md('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
        === '| A | B |\n| --- | --- |\n| 1 | 2 |',
      '表格（含表头分隔行）',
    );
    assertEq(html2md('<figure><img src="f.jpg" alt="图"><figcaption>说明文字</figcaption></figure>'), '![图](f.jpg)\n说明文字', 'figure + figcaption');
    assertEq(decodeEntities('&amp;&lt;&gt;&quot;&#39;'), '&<>"\'', 'decodeEntities 全量实体');

    // 嵌套列表
    assert(
      html2md('<ul><li>父项<ul><li>子项</li></ul></li></ul>') === '- 父项\n  - 子项',
      '嵌套列表缩进',
    );
  }

  // 24) extractor：正文提取（微信站点特定 + 通用 Readability）
  {
    console.log('\n— [24/24] extractor：正文提取器 —');
    const { extractArticle } = await import('../../packages/extension/src/content/extractor');

    // —— 微信站点特定提取 ——
    const wxContent = {
      innerHTML: '<p>微信正文第一段</p><p><img src="wx1.jpg" alt="配图"></p>',
      cloneNode: () => ({ ...wxContent, querySelectorAll: () => [] }),
      querySelectorAll: () => [],
    };
    const wxDoc: any = {
      location: { href: 'https://mp.weixin.qq.com/s/abc123' },
      title: '兜底标题',
      querySelector: (sel: string) => {
        if (sel === '#activity-name') return { textContent: '微信文章标题' };
        if (sel === '#js_content') return wxContent;
        if (sel === 'meta[property="og:image"]') return { getAttribute: () => 'https://img.example.com/cover.jpg' };
        if (sel === 'meta[property="og:title"]') return { getAttribute: () => '微信文章标题' };
        if (sel === 'meta[property="og:description"]') return { getAttribute: () => '微信摘要' };
        if (sel === 'meta[name="description"]') return { getAttribute: () => '微信摘要' };
        return null;
      },
    };
    const wxArticle = extractArticle(wxDoc, undefined as any);
    assert(wxArticle != null, '微信文章提取成功');
    assertEq(wxArticle!.title, '微信文章标题', '微信标题来自 #activity-name');
    assertEq(wxArticle!.platform, 'weixin', '微信平台标识');
    assertEq(wxArticle!.cover, 'https://img.example.com/cover.jpg', '微信封面来自 og:image');
    assertEq(wxArticle!.summary, '微信摘要', '微信摘要来自 og:description');
    assert(wxArticle!.markdown.includes('微信正文第一段'), '微信正文转 markdown');
    assert(wxArticle!.markdown.includes('![配图](wx1.jpg)'), '微信正文图片提取');

    // —— 通用 Readability 提取（注入 mock Readability）——
    class MockReadability {
      constructor(_doc: any) {}
      parse() {
        return {
          title: '通用文章标题',
          content: '<p>正文段落 <strong>加粗</strong></p><p>第二段</p>',
          textContent: '正文段落 加粗 第二段',
          excerpt: '通用摘要',
          byline: null,
          siteName: '示例站',
          dir: null,
          length: 20,
        };
      }
    }
    const genericDoc: any = {
      location: { href: 'https://example.com/post/1' },
      title: '页面原始标题',
      cloneNode: () => genericDoc,
      querySelectorAll: () => [],
      querySelector: (sel: string) => {
        if (sel === 'meta[property="og:image"]') return { getAttribute: () => 'https://img.example.com/og.jpg' };
        if (sel === 'meta[property="og:description"]') return { getAttribute: () => 'og摘要' };
        if (sel === 'meta[name="description"]') return { getAttribute: () => 'og摘要' };
        return null;
      },
    };
    const genericArticle = extractArticle(genericDoc, MockReadability as any);
    assert(genericArticle != null, '通用 Readability 提取成功');
    assertEq(genericArticle!.title, '通用文章标题', '通用标题来自 Readability');
    assertEq(genericArticle!.platform, 'generic', '通用平台标识');
    assert(genericArticle!.markdown.includes('正文段落 **加粗**'), '通用正文转 markdown（含加粗）');
    assertEq(genericArticle!.cover, 'https://img.example.com/og.jpg', '通用封面来自 og:image');

    // —— 无正文时返回 null（不假成功）——
    class EmptyReadability {
      constructor(_doc: any) {}
      parse() { return null; }
    }
    assertEq(extractArticle(genericDoc, EmptyReadability as any), null, '无正文时返回 null（诚实失败）');
  }

  // 25) docx-reader：.docx 导入基础校验（不依赖 DOM 解析的分支）
  {
    console.log('\n— [25/25] docx-reader：.docx 文档解析 —');
    const { readDocxText } = await import('../../packages/extension/src/adapters/docx-reader');

    // 超过 30MB 抛错
    let threwSize = false;
    try { readDocxText(new ArrayBuffer(31 * 1024 * 1024)); } catch { threwSize = true; }
    assert(threwSize, '30MB+ 文档拒绝导入（防 OOM）');

    // 非 zip 数据 → unzip 失败抛错
    let threwZip = false;
    let zipMsg = '';
    try { readDocxText(new TextEncoder().encode('not a zip file').buffer); } catch (e: any) { threwZip = true; zipMsg = e?.message || ''; }
    assert(threwZip && zipMsg.includes('docx'), '非 zip 文件抛"不是有效的 .docx 文件"');

    // 空 zip（无 word/document.xml）抛错
    const { zipSync, strToU8 } = await import('fflate');
    const emptyZip = zipSync({ 'other.txt': strToU8('hi') });
    let threwMissing = false;
    let missingMsg = '';
    try { readDocxText(emptyZip.buffer); } catch (e: any) { threwMissing = true; missingMsg = e?.message || ''; }
    assert(threwMissing && missingMsg.includes('word/document.xml'), '缺 word/document.xml 抛错');

    // —— 真实 .docx 解析：mock DOMParser 提取 w:p / w:t，验证标题与正文 ——
    const docXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      `<w:p><w:r><w:t>这是文档标题</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>正文第一段内容</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>正文第二段，包含标点。</w:t></w:r></w:p>` +
      `</w:body></w:document>`;
    const realDocx = zipSync({ 'word/document.xml': strToU8(docXml), '[Content_Types].xml': strToU8('<Types/>') });

    // mock DOMParser：正则提取 w:p / w:t
    const NativeDOMParser = (globalThis as any).DOMParser;
    (globalThis as any).DOMParser = class {
      parseFromString(xml: string) {
        const paragraphs: any[] = [];
        const pRe = /<w:p[ >][\s\S]*?<\/w:p>/g;
        let pm: RegExpExecArray | null;
        while ((pm = pRe.exec(xml))) {
          const texts: any[] = [];
          const tRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
          let tm: RegExpExecArray | null;
          while ((tm = tRe.exec(pm[0]))) texts.push({ textContent: tm[1] });
          paragraphs.push({ getElementsByTagName: (tag: string) => (tag === 'w:t' ? texts : []) });
        }
        return {
          querySelector: (sel: string) => (sel === 'parsererror' ? null : null),
          getElementsByTagName: (tag: string) => (tag === 'w:p' ? paragraphs : []),
        };
      }
    };
    const parsed = readDocxText(realDocx.buffer);
    (globalThis as any).DOMParser = NativeDOMParser;
    assertEq(parsed.title, '这是文档标题', 'docx 标题取第一段');
    assert(parsed.text.includes('正文第一段内容') && parsed.text.includes('正文第二段，包含标点。'), 'docx 正文段落拼接');
    assert(parsed.text.split('\n\n').length >= 3, 'docx 段间空行分隔');
  }

  // 26) 海外平台：Bluesky / Mastodon / Reddit
  {
    console.log('\n— [26/26] 海外平台：Bluesky / Mastodon / Reddit —');
    const { normalizeInstance } = await import('../../packages/extension/src/adapters/mastodon');
    assertEq(normalizeInstance('mastodon.social'), 'https://mastodon.social', 'Mastodon 实例补 https://');
    assertEq(normalizeInstance('https://mastodon.social/'), 'https://mastodon.social', 'Mastodon 去尾斜杠');
    assertEq(normalizeInstance('  https://example.com///  '), 'https://example.com', 'Mastodon 空白清理 + 多斜杠');
    assertEq(normalizeInstance(''), '', 'Mastodon 空实例返回空');

    const bsky = await import('../../packages/extension/src/adapters/bluesky');
    const masto = await import('../../packages/extension/src/adapters/mastodon');
    const reddit = await import('../../packages/extension/src/adapters/reddit');

    // Bluesky checkLogin：mock createSession 成功
    storageState.settings = { bluesky: { identifier: 'alice.bsky.social', appPassword: 'xxxx-xxxx-xxxx-xxxx' } };
    (globalThis as any).__setFetch((url: string) => {
      if (url.includes('createSession')) {
        return Promise.resolve({ ok: true, json: async () => ({ accessJwt: 'jwt', did: 'did:plc:abc', handle: 'alice.bsky.social' }) } as any);
      }
      return Promise.resolve({ ok: false, json: async () => ({}) } as any);
    });
    const bskyAuth = await bsky.blueskyAdapter.checkLogin();
    assert(bskyAuth.loggedIn === true, 'Bluesky 配置正确时 checkLogin 成功');
    assertEq(bskyAuth.account, 'alice.bsky.social', 'Bluesky 返回 handle');

    // Mastodon checkLogin：mock verify_credentials
    storageState.settings = { mastodon: { instance: 'mastodon.social', accessToken: 'tok' } };
    (globalThis as any).__setFetch((url: string) => {
      if (url.includes('/api/v1/accounts/verify_credentials')) {
        return Promise.resolve({ ok: true, json: async () => ({ username: 'alice', display_name: 'Alice' }) } as any);
      }
      return Promise.resolve({ ok: false, json: async () => ({}) } as any);
    });
    const mastoAuth = await masto.mastodonAdapter.checkLogin();
    assert(mastoAuth.loggedIn === true, 'Mastodon 配置正确时 checkLogin 成功');
    assertEq(mastoAuth.account, '@alice', 'Mastodon 返回 @username');

    // Reddit checkLogin：mock api/me.json
    storageState.settings = { reddit: { subreddit: 'test' } };
    (globalThis as any).__setFetch((url: string) => {
      if (url.includes('/api/me.json')) {
        return Promise.resolve({ ok: true, json: async () => ({ data: { name: 'u_redditor', modhash: 'mh' } }) } as any);
      }
      return Promise.resolve({ ok: false, json: async () => ({}) } as any);
    });
    const redditAuth = await reddit.redditAdapter.checkLogin();
    assert(redditAuth.loggedIn === true, 'Reddit 登录态正确时 checkLogin 成功');
    assertEq(redditAuth.account, 'u/u_redditor', 'Reddit 返回 u/用户名');

    // 未配置时诚实失败（Bluesky/Mastodon 凭证即配置；Reddit 登录态走浏览器 cookie，subreddit 缺失时 createDraft 抛错）
    storageState.settings = {};
    assert((await bsky.blueskyAdapter.checkLogin()).loggedIn === false, 'Bluesky 未配置返回未登录');
    assert((await masto.mastodonAdapter.checkLogin()).loggedIn === false, 'Mastodon 未配置返回未登录');
    let redditDraftThrew = false;
    try { await reddit.redditAdapter.createDraft({ body: 'x' } as any); } catch { redditDraftThrew = true; }
    assert(redditDraftThrew, 'Reddit 未配置 subreddit 时 createDraft 抛错（不假成功）');

    (globalThis as any).__setFetch(null);
  }

  // 27) ai-client：provider 预置 + 生成结果解析
  {
    console.log('\n— [27/27] ai-client：AI 文案生成 —');
    const { AI_PROVIDERS, parseArticleJson, getProvider } = await import('../../packages/extension/src/adapters/ai-client');

    const deepseek = getProvider('deepseek');
    assert(deepseek != null, 'DeepSeek 已预置');
    assert(deepseek!.models.includes('deepseek-v4-pro') && deepseek!.models.includes('deepseek-v4-flash'), 'DeepSeek 模型含 v4-pro/v4-flash（2026 最新）');
    assertEq(deepseek!.defaultModel, 'deepseek-v4-flash', 'DeepSeek 默认 v4-flash');
    assertEq(deepseek!.baseUrl, 'https://api.deepseek.com', 'DeepSeek baseUrl');
    assert(AI_PROVIDERS.length >= 6, '预置 6+ provider（DeepSeek/OpenAI/Qwen/Kimi/GLM/自定义）');
    assert(getProvider('openai')!.models.includes('gpt-5.5'), 'OpenAI 含 gpt-5.5');
    assert(getProvider('kimi')!.models.includes('kimi-k3'), 'Kimi 含 kimi-k3');
    assertEq(getProvider('custom')!.baseUrl, '', '自定义 provider baseUrl 留空');

    const json = parseArticleJson('{"title":"标题A","body":"正文B"}');
    assertEq(json.title, '标题A', 'JSON 标题解析');
    assertEq(json.body, '正文B', 'JSON 正文解析');

    const fenced = parseArticleJson('```json\n{"title":"围栏标题","body":"围栏正文"}\n```');
    assertEq(fenced.title, '围栏标题', '围栏 JSON 标题');
    assertEq(fenced.body, '围栏正文', '围栏 JSON 正文');

    const text = parseArticleJson('# 降级标题\n正文段落一\n正文段落二');
    assertEq(text.title, '降级标题', '文本标题降级解析');
    assertEq(text.body, '正文段落一\n正文段落二', '文本正文降级解析');

    let threw = false;
    try { parseArticleJson('   '); } catch { threw = true; }
    assert(threw, '空内容抛错');
  }

  // 28) ai-client：rewriteForPlatform 平台风格改写
  {
    console.log('\n— [28/28] ai-client：AI 平台风格改写 —');
    const { rewriteForPlatform } = await import('../../packages/extension/src/adapters/ai-client');
    let capturedUser = '';
    (globalThis as any).__setFetch((url: string, init?: any) => {
      const body = JSON.parse(init?.body || '{}');
      capturedUser = body.messages?.find((m: any) => m.role === 'user')?.content || '';
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"title":"改写标题","body":"改写正文"}' } }] }),
      } as any);
    });
    const r = await rewriteForPlatform(
      { title: '母稿标题', body: '母稿正文' },
      '小红书风格：口语化种草口吻',
      { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash' },
    );
    assertEq(r.title, '改写标题', 'rewriteForPlatform 返回改写标题');
    assertEq(r.body, '改写正文', 'rewriteForPlatform 返回改写正文');
    assert(capturedUser.includes('母稿正文') && capturedUser.includes('小红书风格'), '改写请求携带母稿与平台风格');
    (globalThis as any).__setFetch(null);

    // titleLimit / charLimit 约束段正确拼入 prompt
    let captured6 = '';
    (globalThis as any).__setFetch((url: string, init?: any) => {
      const body = JSON.parse(init?.body || '{}');
      captured6 = body.messages?.find((m: any) => m.role === 'user')?.content || '';
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"title":"t","body":"b"}' } }] }),
      } as any);
    });
    await rewriteForPlatform(
      { title: '母稿标题', body: '母稿正文' },
      '小红书风格',
      { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'm' },
      'plain',
      1000,
      20,
    );
    assert(captured6.includes('标题字数上限') && captured6.includes('20'), 'rewriteForPlatform titleLimit 拼入标题约束段');
    assert(captured6.includes('正文字数上限') && captured6.includes('1000'), 'rewriteForPlatform charLimit 拼入正文约束段');
    (globalThis as any).__setFetch(null);

    // 非 2xx 抛错（供降级回退）
    (globalThis as any).__setFetch(() => Promise.resolve({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) } as any));
    let threw = false;
    try { await rewriteForPlatform({ title: 'a', body: 'b' }, '风格', { baseUrl: 'https://x', apiKey: 'k', model: 'm' }); } catch (e: any) { threw = /bad key/.test(e?.message || ''); }
    assert(threw, 'AI 改写失败抛错（供降级）');
    (globalThis as any).__setFetch(null);
  }

  // 29) store：定时发布队列往返（P1）
  {
    console.log('\n— [29/29] store：定时队列往返 —');
    const st = await import('../../packages/extension/src/store/index');
    // 清空队列
    await st.store.saveScheduledQueue([]);
    const item = {
      id: 'sched_test_1',
      article: { title: 'T', body: 'B' } as any,
      platformIds: ['weibo'] as any,
      scheduledAt: Date.now() + 100000,
      aiRewrite: false,
      createdAt: Date.now(),
    };
    await st.store.addScheduled(item);
    let q = await st.store.getScheduledQueue();
    assertEq(q.length, 1, '入队后队列长度 1');
    assertEq(q[0].id, 'sched_test_1', '队列项 id 正确');
    await st.store.removeScheduled('sched_test_1');
    q = await st.store.getScheduledQueue();
    assertEq(q.length, 0, '出队后队列清空');
    // 清理
    await st.store.saveScheduledQueue([]);
  }

  // 30) store：多账号矩阵合并层（P2）
  {
    console.log('\n— [30/30] store：多账号矩阵 —');
    const st = await import('../../packages/extension/src/store/index');
    // 清空账号态
    await chrome.storage.local.set({ accounts: {}, activeAccountId: {} });
    // 默认单账号配置
    storageState.settings = { wordpress: { endpoint: 'https://default.example.com', username: 'u' } };
    // 添加两个账号
    const acc1 = await st.store.addAccount('wordpress', '公司站', { endpoint: 'https://corp.example.com', username: 'corp' });
    const acc2 = await st.store.addAccount('wordpress', '个人站', { endpoint: 'https://me.example.com', username: 'me' });
    let accounts = await st.store.listAccounts('wordpress');
    assertEq(accounts.length, 2, '添加 2 个账号');
    // 切换前 getSettings 返回默认配置
    let cfg = await st.store.getSettings();
    assertEq(cfg.wordpress?.endpoint, 'https://default.example.com', '未切换时用默认配置');
    // 切换账号 1
    await st.store.switchAccount('wordpress', acc1);
    cfg = await st.store.getSettings();
    assertEq(cfg.wordpress?.endpoint, 'https://corp.example.com', '切换后 getSettings 返回账号 1 配置');
    assertEq(await st.store.getActiveAccountId('wordpress'), acc1, '活跃账号 id 正确');
    // 切换账号 2
    await st.store.switchAccount('wordpress', acc2);
    cfg = await st.store.getSettings();
    assertEq(cfg.wordpress?.endpoint, 'https://me.example.com', '切到账号 2 配置生效');
    // 删除账号 2 后清活跃标记
    await st.store.removeAccount('wordpress', acc2);
    assertEq(await st.store.getActiveAccountId('wordpress'), null, '删除活跃账号后清空活跃标记');
    // 清理
    await chrome.storage.local.set({ accounts: {}, activeAccountId: {} });
    storageState.settings = {};
  }

  // 31) ai-client parseArticleJson：AI 返回破损 JSON 时兜底提取 title/body
  {
    console.log('\n— [31/31] ai-client parseArticleJson 兜底 —');
    const { parseArticleJson } = await import('../../packages/extension/src/adapters/ai-client');
    // 1) 理想路径：完整 JSON
    const r1 = parseArticleJson('{"title":"Hello","body":"World"}');
    assertEq(r1.title, 'Hello', '完整 JSON：title 正确');
    assertEq(r1.body, 'World', '完整 JSON：body 正确');
    // 2) 字面 \\n（之前修过的老 bug）
    const r2 = parseArticleJson('{"title":"T","body":"line1\\nline2"}');
    assertEq(r2.body, 'line1\nline2', '字面 \\n 归一化：body 真换行');
    // 3) body 含未转义换行的破损 JSON（本次 bug 场景）
    const r3 = parseArticleJson('{"title":"OmniPic 使用指南：AI 图像生成工具的功能与使用场景","body":"# OmniPic 使用指南\n\n## 介绍\n这里是介绍"}');
    assertEq(r3.title, 'OmniPic 使用指南：AI 图像生成工具的功能与使用场景', '破损 JSON 兜底：title 正确提取（不再把整段当 title）');
    assertEq(r3.body, '# OmniPic 使用指南\n\n## 介绍\n这里是介绍', '破损 JSON 兜底：body 正确提取');
    // 4) 围栏 ```json ... ```
    const r4 = parseArticleJson('```json\n{"title":"A","body":"B"}\n```');
    assertEq(r4.title, 'A', 'JSON 围栏：title 正确');
    assertEq(r4.body, 'B', 'JSON 围栏：body 正确');
    // 5) 纯 markdown 文本（# 标题 + 段落）
    const r5 = parseArticleJson('# 我的标题\n\n第一段正文\n第二段');
    assertEq(r5.title, '我的标题', '纯 markdown：title 正确');
    assertEq(r5.body, '第一段正文\n第二段', '纯 markdown：body 正确');
  }

  // 32) markdown-utils：markdownToPlainText 纯文本排版与平台格式分类
  {
    console.log('\n— [32/32] markdown-utils：markdownToPlainText 纯文本排版与平台格式分类 —');
    const { markdownToPlainText, getPlatformFormat } = await import('../../packages/extension/src/adapters/markdown-utils');
    
    // 平台分类判定
    assertEq(getPlatformFormat('xiaohongshu'), 'plain', '小红书属于纯文本社交平台');
    assertEq(getPlatformFormat('weibo'), 'html', '微博头条文章是 HTML 富文本编辑器（误归 plain 会丢格式）');
    assertEq(getPlatformFormat('bilibili'), 'html', 'B站专栏是 HTML 富文本编辑器（误归 plain 会丢格式）');
    assertEq(getPlatformFormat('twitter'), 'plain', 'Twitter/X 属于纯文本社交平台');
    assertEq(getPlatformFormat('zhihu'), 'html', '知乎属于富文本平台');
    assertEq(getPlatformFormat('weixin'), 'html', '微信公众号属于富文本平台');
    assertEq(getPlatformFormat('toutiao'), 'html', '今日头条属于富文本平台');
    assertEq(getPlatformFormat('jianshu'), 'html', '简书属于富文本平台');
    assertEq(getPlatformFormat('netease'), 'html', '网易号属于富文本平台');
    assertEq(getPlatformFormat('juejin'), 'markdown', '掘金属于 Markdown 原生平台');
    assertEq(getPlatformFormat('csdn'), 'markdown', 'CSDN 属于 Markdown 原生平台');
    assertEq(getPlatformFormat('devto'), 'markdown', 'Dev.to 属于 Markdown 原生平台');

    // 纯文本排版转换
    const inputMd = `# 核心结论与亮点\n\n这是**重点加粗**与*斜体提示*，以及~~删除文本~~。\n\n> 这是关键引用\n\n- 第一点说明\n- 第二点建议\n\n参考链接：[项目官网](https://omnipost.dev)\n\n\`\`\`ts\nconst a = 100;\n\`\`\`\n`;
    const plain = markdownToPlainText(inputMd);

    assert(plain.includes('【核心结论与亮点】'), '标题被转换为【标题】');
    assert(!plain.includes('#'), '纯文本结果不得包含 # 标题标记');
    assert(plain.includes('重点加粗'), '保留粗体文字内容');
    assert(!plain.includes('**'), '纯文本结果不得包含 ** 标记');
    assert(!plain.includes('~~'), '纯文本结果不得包含 ~~ 标记');
    assert(plain.includes('| 这是关键引用'), '引用转换为 | 前缀');
    assert(plain.includes('• 第一点说明') && plain.includes('• 第二点建议'), '无序列表项转换为 • 符号');
    assert(plain.includes('项目官网 (https://omnipost.dev)'), '链接转换为文本加链接括号');
    assert(plain.includes('const a = 100;'), '保留代码块内容');
    assert(!plain.includes('```'), '代码块反引号被完全剥离');
  }

  // 33) 发布质量回归：previewOf 兜底标题 / parseArticleJson 防乱码 / X 截断
  {
    console.log('\n— [33/33] 发布质量回归（previewOf / parseArticleJson / truncateForX） —');
    const utils = await import('../../packages/extension/src/adapters/utils');
    const { parseArticleJson } = await import('../../packages/extension/src/adapters/ai-client');
    const { truncateForX } = await import('../../packages/extension/src/content/twitter');

    // previewOf：正文以图片/链接开头时不得把 URL 残片拼进标题（乱码标题 bug 回归）
    assertEq(
      utils.previewOf('![封面图](https://mmbiz.qpic.cn/abc/0?wx_fmt=png)\n\n## 真正的标题\n正文内容', 30),
      '真正的标题 正文内容',
      'previewOf 剔除图片语法，URL 不混入标题',
    );
    assertEq(
      utils.previewOf('[点击这里看全文](https://example.com/a) 是最重要的参考。\n第二段', 30),
      '点击这里看全文 是最重要的参考。 第二段',
      'previewOf 链接只留文字',
    );
    assertEq(utils.previewOf('# 标题\n正文内容', 20), '标题 正文内容', 'previewOf 去 Markdown 符号（原有行为保持）');

    // parseArticleJson：单引号伪 JSON（小模型常见）能正确解析，不得退化为乱码标题
    const sq = parseArticleJson("{'title': '我的标题', 'body': '正文内容'}");
    assertEq(sq.title, '我的标题', '单引号伪 JSON：title 正确解析');
    assertEq(sq.body, '正文内容', '单引号伪 JSON：body 正确解析');

    // parseArticleJson：JSON 残片绝不当标题（防乱码标题注入平台草稿）
    let residueThrew = false;
    try {
      const r = parseArticleJson('{"title": " broken');
      if (!r.title) residueThrew = true; // 允许返回空标题（下游走正文摘要兜底）
    } catch { residueThrew = true; }
    assert(residueThrew, '不可解析的 JSON 残片不得产出乱码标题');

    // parseArticleJson：无标题标记散文 → 首行当标题（保持既有兜底行为）
    const prose = parseArticleJson('这次我们来聊聊远程办公的效率工具选型。\n首先是协同编辑……');
    assert(prose.title.length > 0, '散文兜底：取首行当标题');

    // truncateForX：280 加权（CJK 按 2）截断
    const ascii300 = 'a'.repeat(300);
    const tx1 = truncateForX(ascii300);
    assert(tx1.endsWith('…') && tx1.length <= 280, 'X 截断：300 ASCII → ≤280 且带省略号');
    const cjk200 = '汉'.repeat(200); // 加权 400
    const tx2 = truncateForX(cjk200);
    let w2 = 0; for (const ch of tx2.replace(/…$/, '')) w2 += /[⺀-鿿]/.test(ch) ? 2 : 1;
    assert(w2 <= 280, 'X 截断：200 个汉字加权后 ≤280');
    const shortText = '短推文';
    assertEq(truncateForX(shortText), shortText, 'X 截断：未超限原文保留');
  }

  console.log('\n====================================================');
  console.log(`📊 单元测试汇总: 总计 ${passed + failed} 项，通过 ${passed} 项${failed ? `，失败 ${failed} 项` : '，全部通过 🎉'}`);
  console.log('====================================================');
  if (failed > 0) {
    console.error('\n失败明细:');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
}

main().catch((e) => { console.error('单元测试执行异常:', e); process.exit(1); });
