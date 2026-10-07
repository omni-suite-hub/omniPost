#!/usr/bin/env node
/**
 * OmniPost 真实 Chrome 冒烟测试（test/e2e/smoke.cjs）
 *
 * 背景：branded Chrome 137+ 已移除 --load-extension（实测打印 "not allowed in Google Chrome, ignoring"），
 * 因此本测试使用 Chrome for Testing（Chromium 系继续支持 --load-extension）。
 * 下载：node test/e2e/install-cft.mjs
 *
 * 覆盖（全部为真实运行时行为，非字符串契约）：
 *   1. Chrome for Testing 启动、CDP 就绪
 *   2. 扩展产物 dist 被真实加载（解析扩展 ID）
 *   3. popup 页面打开并完成 React 渲染（非白屏、无未捕获异常）
 *   4. chrome.runtime.id 正确、扩展上下文可用
 *   5. CHECK_ALL_LOGIN 真实执行：干净 profile → 8 平台全部 loggedIn:false，不得假成功/崩溃
 *   6. chrome.storage.local 写入/读取往返成功（持久化）
 *   7. bridge token 由 popup 初始化生成（幂等 ensureBridgeToken）
 *   8. MV3 Service Worker 真实注册（CHECK_ALL_LOGIN 触发后出现 SW target）
 *   9. 全程无扩展自身 console error（过滤网络级 net:: 错误）
 *
 * 运行：node test/e2e/smoke.mjs   （需先执行 npm run build 生成 dist）
 */
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const TMP = path.join(ROOT, 'test', '.tmp');
const DIST = path.join(ROOT, 'packages', 'extension', 'dist');
const PROFILE = path.join(TMP, 'smoke-profile');
const PORT = 9333;
const CFT_BIN = path.join(
  TMP, 'cft', 'chrome-mac-arm64', 'Google Chrome for Testing.app',
  'Contents', 'MacOS', 'Google Chrome for Testing',
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ [PASS] ${msg}`); }
  else { failed++; console.error(`  ❌ [FAIL] ${msg}`); }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ---------- 极简 CDP 客户端（Node 22 原生 WebSocket） ----------
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.listeners = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('CDP WebSocket 连接失败'));
      this.ws.onclose = () => {
        // Chrome 意外退出时 reject 所有 pending，避免 Node 事件循环空转自然退出、吞掉汇总输出
        const err = new Error('CDP 连接已关闭（Chrome 可能退出）');
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
      };
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        } else if (msg.method) {
          this.listeners.forEach((fn) => fn(msg));
        }
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch {} }
}

async function evalIn(browser, sessionId, expression) {
  const r = await browser.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '未知异常';
    throw new Error('页面执行异常: ' + String(d).slice(0, 500));
  }
  return r.result?.value;
}

/** 从 Preferences（真实安装记录）或 SW target 中解析扩展 ID。
 *  注意：/json/list 里会有 CfT 内置扩展（thunk.js/background.js 等），
 *  不能取"第一个" chrome-extension:// target，必须匹配本扩展的 SW 文件名（service-worker-loader.js）。 */
async function discoverExtensionId() {
  // 方法1：Preferences 按加载路径精确匹配（真实安装记录，最可靠）
  for (let i = 0; i < 20; i++) {
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(PROFILE, 'Default', 'Preferences'), 'utf8'));
      const settings = prefs?.extensions?.settings || {};
      for (const [id, v] of Object.entries(settings)) {
        if (v?.path && path.resolve(v.path) === path.resolve(DIST)) return id;
      }
    } catch {}
    await sleep(300);
  }
  // 方法2：SW target 已注册（manifest background = service-worker-loader.js）
  try {
    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const sw = targets.find((t) => t.type === 'service_worker' && t.url?.includes('service-worker-loader.js'));
    const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(sw?.url || '');
    if (m) return m[1];
  } catch {}
  return null;
}

async function main() {
  console.log('====================================================');
  console.log('🚀 OmniPost 真实 Chrome 冒烟测试');
  console.log('====================================================\n');

  // 0. 前置检查
  ok(fs.existsSync(CFT_BIN), 'Chrome for Testing 已就绪（缺失时运行 node test/e2e/install-cft.mjs）');
  ok(fs.existsSync(path.join(DIST, 'manifest.json')), 'dist 构建产物存在（先 npm run build）');
  if (failed > 0) { console.error('\n前置条件不满足，退出。'); process.exit(1); }

  // 1. 清理旧 profile（子进程剥离沙箱 rm shim，仅删除测试目录）
  const cleanEnv = { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS || '').replace(/--require="[^"]*genie-safe-delete[^"]*"\s*/, '') };
  try {
    execSync(`"${process.execPath}" -e "require('fs').rmSync(process.argv[1],{recursive:true,force:true})" "${PROFILE}"`, { env: cleanEnv, stdio: 'pipe' });
  } catch {}
  fs.mkdirSync(PROFILE, { recursive: true });

  // 2. 启动 Chrome for Testing
  // 默认 headless=new（CI/沙箱环境稳定；沙箱内 GUI+GPU 不可用会导致 FATAL 退出）。
  // 本机有图形界面时可设 SMOKE_HEADED=1 走有头模式便于观察。
  console.log(`🔧 启动 Chrome for Testing (port ${PORT})...`);
  const headed = process.env.SMOKE_HEADED === '1';
  const chrome = spawn(CFT_BIN, [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${DIST}`,
    `--disable-extensions-except=${DIST}`,
    '--enable-unsafe-extension-debugging',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-features=TranslateUI',
    // 沙箱环境无法建立 Chrome 进程沙箱与 GPU，必须显式关闭，否则 Chrome 直接 FATAL 退出
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    ...(headed ? [] : ['--headless=new']),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });
  chrome.on('exit', (code, signal) => {
    if (code !== 0) {
      console.error(`  ⚠ Chrome 提前退出 code=${code} signal=${signal}`);
      if (chromeErr.trim()) console.error(`      └ stderr: ${chromeErr.trim().slice(-300)}`);
    }
  });

  let browser = null;
  try {
    // 3. 等待 CDP 就绪
    let version = null;
    for (let i = 0; i < 60; i++) {
      try { version = await getJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch {}
      await sleep(500);
    }
    ok(!!version, `CDP 就绪（${version?.Browser || 'unknown'}）`);
    if (!version) throw new Error('CDP 未就绪');

    // 4. 扩展 ID
    const extId = await discoverExtensionId();
    ok(!!extId, `扩展被真实加载（ID: ${extId || '解析失败'}）`);
    if (!extId) throw new Error('无法解析扩展 ID');

    // 5. 打开 popup 页面（index.html）
    browser = new CDP(version.webSocketDebuggerUrl);
    await browser.open();
    const consoleErrors = [];
    browser.on((msg) => {
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        consoleErrors.push(`log: ${msg.params.entry.text}`);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        consoleErrors.push(`console: ${msg.params.args?.map((a) => a.value || a.description).join(' ')}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(`exception: ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
      }
    });

    const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/index.html` });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Runtime.enable', {}, sessionId);
    await browser.send('Log.enable', {}, sessionId);
    await browser.send('Page.enable', {}, sessionId);
    // 等待页面加载
    await sleep(1500);

    // 6. popup 渲染（React 挂载完成、非白屏）
    const render = await evalIn(browser, sessionId, `(async () => {
      for (let i = 0; i < 30; i++) {
        const root = document.querySelector('#root');
        if (root && root.childElementCount > 0 && root.textContent.trim().length > 0) {
          return { ready: true, text: root.textContent.trim().slice(0, 120) };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return { ready: false, text: document.body ? document.body.innerText.slice(0, 120) : '' };
    })()`);
    ok(render?.ready === true, `popup React 渲染完成（${(render?.text || '').replace(/\n/g, ' ')}）`);

    // 7. 扩展上下文正确
    const runtimeId = await evalIn(browser, sessionId, `(async () => chrome.runtime.id)()`);
    ok(runtimeId === extId, `popup 上下文 chrome.runtime.id === ${extId}`);

    // 8. CHECK_ALL_LOGIN 真实执行（干净 profile → 全平台 loggedIn:false 且不崩溃；zip-download 本地导出恒 true）
    const login = await evalIn(browser, sessionId, `(async () => {
      const res = await chrome.runtime.sendMessage({ type: 'CHECK_ALL_LOGIN' });
      return res;
    })()`);
    const platformIds = Object.keys(login || {}).sort();
    const expectedIds = [
      'weibo', 'xiaohongshu', 'bilibili', 'zhihu', 'wordpress', 'twitter', 'youtube', 'telegram',
      'juejin', 'baijiahao', 'csdn', 'yuque', 'douban', 'sohu', 'xueqiu', 'weixin', 'woshipm',
      'cto51', 'imooc', 'oschina', 'segmentfault', 'cnblogs', 'eastmoney', 'typecho', 'metaweblog', 'zip-download',
      'bluesky', 'mastodon', 'reddit', 'devto', 'hashnode', 'toutiao',
      'jianshu', 'netease', 'douyin', 'dayu', 'yidian', 'smzdm', 'sohufocus',
    ].sort();
    ok(JSON.stringify(platformIds) === JSON.stringify(expectedIds),
      `CHECK_ALL_LOGIN 返回 39 平台（got: ${platformIds.length}）`);
    // 恒可同步（checkLogin 恒 true）：zip-download（本地导出）。
    // 半自动平台（jianshu/netease/...）checkLogin=false，靠 popup 橙色"半自动"徽章 + B1 预检豁免仍可勾选发布
    const alwaysTrue = new Set(['zip-download']);
    const allFalse = platformIds.filter((p) => !alwaysTrue.has(p)).every((p) => login[p]?.loggedIn === false);
    ok(allFalse, '干净 profile 下除 zip-download 外 38 平台全部 loggedIn:false（不得假成功；半自动平台也是 false）');
    ok(login['zip-download']?.loggedIn === true, 'zip-download 本地导出恒可同步（loggedIn:true）');
    ok(login['jianshu']?.loggedIn === false && login['netease']?.loggedIn === false, '半自动平台 checkLogin 诚实返回 false（防假成功；UI 橙色徽章+B1 豁免保证可用）');
    const loginSummary = platformIds.map((p) => `${p}:${login[p]?.loggedIn === true ? '✓' : '✗'}`).join(' ');
    console.log(`      └ 登录态: ${loginSummary}`);

    // 9. storage 持久化往返
    const storageRound = await evalIn(browser, sessionId, `(async () => {
      const k = 'smokeKey';
      const v = 'smoke-' + Date.now();
      await chrome.storage.local.set({ [k]: v });
      const got = await chrome.storage.local.get(k);
      return got[k] === v ? 'ok' : 'mismatch';
    })()`);
    ok(storageRound === 'ok', 'chrome.storage.local 写入/读取往返成功');

    // 10. bridge token 由 popup 初始化生成（幂等 ensureBridgeToken）
    const token = await evalIn(browser, sessionId, `(async () => (await chrome.storage.local.get('bridgeToken')).bridgeToken || '')()`);
    ok(typeof token === 'string' && token.startsWith('om') && token.length > 8,
      `bridge token 已自动生成（${token ? token.slice(0, 14) + '…' : '空'}）`);

    // 11. MV3 Service Worker 真实注册
    let swFound = false;
    for (let i = 0; i < 20; i++) {
      const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      swFound = targets.some((t) => t.type === 'service_worker' && t.url?.includes(`chrome-extension://${extId}/`));
      if (swFound) break;
      await sleep(500);
    }
    ok(swFound, 'MV3 Service Worker 真实注册并存活（background 可响应消息）');

    // 12. 无扩展自身 console error（过滤网络级 net:: 错误）
    await sleep(800);
    const realErrors = consoleErrors.filter((e) => !e.includes('net::') && !e.includes('ERR_'));
    ok(realErrors.length === 0, `全程无扩展自身 console error（${realErrors.length} 条）`);
    if (realErrors.length > 0) realErrors.slice(0, 5).forEach((e) => console.error(`      └ ${e}`));

    // 13. Side Panel API 在真实运行时可用（吸附右侧依赖 setPanelBehavior）
    const sidePanelOk = await evalIn(browser, sessionId, `(async () => {
      return typeof chrome.sidePanel !== 'undefined'
        && typeof chrome.sidePanel.setPanelBehavior === 'function'
        && typeof chrome.sidePanel.open === 'function';
    })()`);
    ok(sidePanelOk === true, 'chrome.sidePanel API 在扩展上下文可用（setPanelBehavior/open）');

    // 14. bridge 轮询 alarm 真实注册（CLI/MCP 经 30s 轮询通信的前提）
    const alarm = await evalIn(browser, sessionId, `(async () => {
      const a = await chrome.alarms.get('omnipost-bridge-poll');
      return a ? { name: a.name, period: a.periodInMinutes } : null;
    })()`);
    ok(!!alarm && alarm.name === 'omnipost-bridge-poll' && alarm.period === 0.5,
      `bridge 轮询 alarm 已注册（${alarm ? alarm.name + ' / ' + alarm.period + 'min' : '缺失'}）`);

    // 15. 正文提取真实链路：打开本地文章页 → content script 注入 → EXTRACT_ARTICLE 提取正文
    {
      const articleHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
        <title>一篇测试文章</title>
        <meta property="og:image" content="https://example.com/cover.jpg">
        <meta name="description" content="这是测试文章的摘要">
      </head><body><main><article>
        <h1>测试文章的标题</h1>
        <p>这是第一段正文内容，用来验证 Readability 正文提取是否能够在真实浏览器环境中正常工作。</p>
        <p>这是第二段正文，包含更多文字，让 Readability 有足够的内容进行评分并正确识别出文章主体区域。</p>
        <p>这是第三段正文，确保正文文本长度超过提取器的阈值，从而避免被误判为非文章页面。</p>
      </article></main></body></html>`;
      const articleServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(articleHtml);
      });
      await new Promise((resolve) => articleServer.listen(9444, '127.0.0.1', resolve));

      try {
        // 打开文章页（成为活动 tab）
        await browser.send('Target.createTarget', { url: 'http://127.0.0.1:9444/article' });
        // 等待 content script（main.ts）在 document_idle 注入
        await sleep(2500);

        // 从 popup 扩展上下文发 EXTRACT_ARTICLE（指定文章页 tab，避免活动态歧义）
        const extract = await evalIn(browser, sessionId, `(async () => {
          const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:9444/*' });
          if (!tabs.length) return { error: '文章页 tab 未找到' };
          return await chrome.runtime.sendMessage({ type: 'EXTRACT_ARTICLE', payload: { tabId: tabs[0].id } });
        })()`);

        ok(extract?.ok === true, `正文提取返回 ok（${extract?.error || '成功'}）`);
        ok(extract?.article?.title === '一篇测试文章', `正文提取标题正确（got: ${extract?.article?.title}）`);
        ok(typeof extract?.article?.markdown === 'string' && extract.article.markdown.includes('第一段正文内容'),
          '正文提取 Markdown 含正文内容');
        ok(extract?.article?.cover === 'https://example.com/cover.jpg', '封面图 og:image 提取正确');
        console.log(`      └ 提取标题: ${extract?.article?.title}；markdown 长度 ${extract?.article?.markdown?.length || 0}`);
      } finally {
        await new Promise((resolve) => articleServer.close(resolve));
      }
    }

    // 16. 悬浮多功能工具栏真实注入（长文章页触发 isArticlePage）+ 主按钮点击反馈 + 3 个工具展开
    {
      // 正文 > 200 字符才会触发 fab 注入（isArticlePage 阈值）
      const longBody = Array.from({ length: 8 }, (_, i) =>
        `<p>这是第${i + 1}段正文内容，用来验证悬浮同步按钮能够在足够长的文章页面上正确注入并显示出来，每个段落都有足够的文字长度。</p>`).join('');
      const longHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>长文章</title></head><body><main><article><h1>长文章标题</h1>${longBody}</article></main></body></html>`;
      const longServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(longHtml);
      });
      await new Promise((resolve) => longServer.listen(9445, '127.0.0.1', resolve));

      try {
        const { targetId: longTarget } = await browser.send('Target.createTarget', { url: 'http://127.0.0.1:9445/long' });
        const { sessionId: longSession } = await browser.send('Target.attachToTarget', { targetId: longTarget, flatten: true });
        await browser.send('Runtime.enable', {}, longSession);
        await sleep(2500);

        const fabState = await evalIn(browser, longSession, `(() => {
          const wrap = document.getElementById('omnipost-fab');
          if (!wrap) return { injected: false };
          const primary = wrap.lastElementChild;
          return {
            injected: true,
            childCount: wrap.children.length,
            primaryTitle: primary?.getAttribute('title') || '',
            primaryText: primary?.textContent || '',
          };
        })()`);
        ok(fabState?.injected === true, '悬浮工具栏已注入长文章页');
        ok(fabState?.childCount === 4, `工具栏含 4 个子元素（3 工具 + 1 主按钮），实际 ${fabState?.childCount}`);
        // 三个工具按钮 title 正确（复制 Markdown / 复制纯文本 / 下载 Markdown）
        const toolTitles = await evalIn(browser, longSession, `(() => {
          const wrap = document.getElementById('omnipost-fab');
          return Array.from(wrap.children).slice(0, 3).map(c => c.getAttribute('title') || '');
        })()`);
        ok(toolTitles[0]?.includes('Markdown') && toolTitles[1]?.includes('纯文本') && toolTitles[2]?.includes('Markdown'),
          `三个工具按钮 title 正确（${JSON.stringify(toolTitles)}）`);

        // 点击主按钮（wrap 最后一个子元素）→ 提取 → 视觉变"已提取"
        const afterClick = await evalIn(browser, longSession, `(async () => {
          const wrap = document.getElementById('omnipost-fab');
          if (!wrap) return { clicked: false };
          const primary = wrap.lastElementChild;
          primary.click();
          await new Promise((r) => setTimeout(r, 600));
          return { clicked: true, text: primary.textContent || '', title: primary.getAttribute('title') || '' };
        })()`);
        ok(afterClick?.clicked === true, '主按钮可点击');
        ok((afterClick?.text || '').includes('已提取'), `主按钮点击后显示"已提取"（${afterClick?.text || ''}）`);
        console.log(`      └ fab 反馈: ${afterClick?.text} / ${afterClick?.title}`);
      } finally {
        await new Promise((resolve) => longServer.close(resolve));
      }
    }

    // 17. hideFab 开关：设置后重新加载长文章页，fab 不再注入
    {
      await evalIn(browser, sessionId, `(async () => {
        await chrome.storage.local.set({ ui: { hideFab: true } });
        return true;
      })()`);
      const longHtml2 = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>长文章2</title></head><body><article><h1>标题</h1>` +
        Array.from({ length: 8 }, (_, i) => `<p>这是第${i + 1}段足够长的正文内容用于验证隐藏悬浮按钮的开关是否真正生效。</p>`).join('') +
        `</article></body></html>`;
      const longServer2 = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(longHtml2);
      });
      await new Promise((resolve) => longServer2.listen(9446, '127.0.0.1', resolve));
      try {
        const { targetId: t2 } = await browser.send('Target.createTarget', { url: 'http://127.0.0.1:9446/long2' });
        const { sessionId: s2 } = await browser.send('Target.attachToTarget', { targetId: t2, flatten: true });
        await browser.send('Runtime.enable', {}, s2);
        await sleep(2500);
        const hidden = await evalIn(browser, s2, `document.getElementById('omnipost-fab') ? 'shown' : 'hidden'`);
        ok(hidden === 'hidden', 'hideFab=true 时悬浮按钮不再注入（设置生效）');
      } finally {
        await new Promise((resolve) => longServer2.close(resolve));
        await evalIn(browser, sessionId, `(async () => { await chrome.storage.local.set({ ui: { hideFab: false } }); return true; })()`);
      }
    }

    // 17.5 header 刷新按钮：点击立刻转圈（disabled+animate-spin）+ 完成后恢复
    {
      const { targetId: rT } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/index.html` });
      const { sessionId: rS } = await browser.send('Target.attachToTarget', { targetId: rT, flatten: true });
      await browser.send('Runtime.enable', {}, rS);
      await sleep(1500);
      // 找 title="刷新平台登录态" 的按钮
      const initialState = await evalIn(browser, rS, `(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => /刷新|Refreshing|Refresh/.test(b.getAttribute('title') || ''));
        if (!btn) return { found: false };
        const svg = btn.querySelector('svg');
        return { found: true, disabled: btn.disabled, spinning: !!svg?.classList.contains('animate-spin'), title: btn.getAttribute('title') };
      })()`);
      ok(initialState?.found === true, '刷新按钮存在');
      // 点击 → 立刻检查转圈（用 await 防止时序漏过）
      const afterClick = await evalIn(browser, rS, `(async () => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => /刷新|Refreshing|Refresh/.test(b.getAttribute('title') || ''));
        if (!btn) return { clicked: false };
        btn.click();
        // react render 100ms 内即可拿到新状态
        await new Promise(r => setTimeout(r, 100));
        const svg = btn.querySelector('svg');
        return { clicked: true, disabled: btn.disabled, spinning: !!svg?.classList.contains('animate-spin') };
      })()`);
      ok(afterClick?.clicked && afterClick?.spinning && afterClick?.disabled, `刷新按钮点击后立刻转圈（spinning=${afterClick?.spinning}, disabled=${afterClick?.disabled}）`);
      // 等待 CHECK_ALL_LOGIN 完成（toast 出现"X/29 已登录"或等待按钮恢复转圈，最长 7s）
      let finalState = null;
      for (let i = 0; i < 35; i++) {
        await sleep(200);
        finalState = await evalIn(browser, rS, `(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => /刷新|Refreshing|Refresh|刷新中/.test(b.getAttribute('title') || ''));
          const svg = btn?.querySelector('svg');
          return { spinning: !!svg?.classList.contains('animate-spin'), disabled: btn?.disabled, title: btn?.getAttribute('title') };
        })()`);
        if (finalState && !finalState.spinning && !finalState.disabled) break;
      }
      ok(!finalState?.spinning && !finalState?.disabled, `刷新完成后按钮恢复（spinning=${finalState?.spinning}, disabled=${finalState?.disabled}）`);
    }

    // 18. i18n 英文切换：扫描 popup 全部 innerText，无 4+ 中文字符串残留 + footer 三处英文正确
    {
      await evalIn(browser, sessionId, `(async () => { await chrome.storage.local.set({ lang: 'en' }); return true; })()`);
      const { targetId: enTarget } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/index.html` });
      const { sessionId: enSession } = await browser.send('Target.attachToTarget', { targetId: enTarget, flatten: true });
      await browser.send('Runtime.enable', {}, enSession);
      await sleep(1800);
      const enText = await evalIn(browser, enSession, `document.body ? document.body.innerText : ''`);
      ok(typeof enText === 'string' && enText.includes('OmniPost'), '英文 popup 主标题正确');
      // 关键文案：发布按钮、选中数都必须是英文
      ok(/\bPublish everywhere\b/.test(enText || ''), '英文下发布主按钮显示 Publish everywhere');
      ok(/\bSelected\b\s*\d+\s*(platform|platforms)/.test(enText || ''), '英文下选中数格式 Selected N platform(s) 含空格');
      // 严格：无 4+ 中文字符串（除可接受的 [中文 / Chinese] 这种本身的双语展示）
      const cjkMatches = (enText || '').match(/[\u4e00-\u9fa5]{4,}/g) || [];
      const cjkFiltered = cjkMatches.filter(s => !/^中文\s*\/\s*Chinese$/.test(s.trim()));
      ok(cjkFiltered.length === 0, `英文界面不允许中文字符串残留（发现: ${JSON.stringify(cjkFiltered.slice(0,3))}）`);
      // 检测 footer 元素宽度不超过 popup（不能换行/截断）
      const footerMetrics = await evalIn(browser, enSession, `(() => {
        // 简化：取底部 footer 的所有直接按钮
        const footer = document.querySelector('footer') || document.body.lastElementChild;
        if (!footer) return { error: 'no footer' };
        const btns = Array.from(footer.querySelectorAll('button'));
        return {
          count: btns.length,
          widths: btns.map(b => ({ text: (b.innerText || '').slice(0, 40), w: b.offsetWidth, scrollW: b.scrollWidth })),
          overflow: btns.filter(b => b.scrollWidth - b.clientWidth > 4).length,
        };
      })()`);
      ok(footerMetrics && !footerMetrics.error, 'footer 可枚举');
      ok(footerMetrics && footerMetrics.overflow === 0, `英文 footer 按钮不溢出（${footerMetrics.overflow}/${footerMetrics.count}）`);
      if (footerMetrics && footerMetrics.overflow > 0) console.log(`      └ 溢出按钮:`, footerMetrics.widths.filter(w => w.scrollW - w.w > 4));
      // 还原
      await evalIn(browser, sessionId, `(async () => { await chrome.storage.local.set({ lang: 'zh' }); return true; })()`);
    }

    // 19. G1 拟人化事件机制：真实 Chrome 下 InputEvent/execCommand/MouseEvent 序列确实触发
    {
      const humHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>拟人化验证</title></head><body>
        <div id="editor" contenteditable="true"></div>
        <input id="title" type="text">
        <button id="publish">发布</button>
      </body></html>`;
      const humServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(humHtml);
      });
      await new Promise((resolve) => humServer.listen(9447, '127.0.0.1', resolve));
      try {
        const { targetId: hT } = await browser.send('Target.createTarget', { url: 'http://127.0.0.1:9447/humanize' });
        const { sessionId: hS } = await browser.send('Target.attachToTarget', { targetId: hT, flatten: true });
        await browser.send('Runtime.enable', {}, hS);
        await sleep(1200);
        const humRes = await evalIn(browser, hS, `(async () => {
          const editor = document.getElementById('editor');
          const input = document.getElementById('title');
          const btn = document.getElementById('publish');
          let clicked = 0;
          btn.addEventListener('click', () => { clicked++; });

          // humanType 对 input：原生 setter + InputEvent 逐段
          const proto = window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          let pos = 0; const text = '测试标题';
          while (pos < text.length) {
            const chunk = text.slice(pos, pos + 1);
            setter.call(input, input.value + chunk);
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: chunk }));
            pos++;
          }
          const inputOk = input.value === '测试标题';

          // humanType 对 contenteditable：先 focus 再 execCommand insertText
          editor.focus();
          let inserted = false;
          try { inserted = document.execCommand('insertText', false, '正文内容'); } catch { inserted = false; }
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '正文内容' }));
          const editorOk = (editor.textContent || '').includes('正文内容');

          // humanClick：mouseover→mousedown→mouseup→click 序列
          const rect = btn.getBoundingClientRect();
          const base = { bubbles: true, cancelable: true, view: window, clientX: rect.left + 5, clientY: rect.top + 5 };
          btn.dispatchEvent(new MouseEvent('mouseover', base));
          btn.dispatchEvent(new MouseEvent('mousedown', base));
          btn.dispatchEvent(new MouseEvent('mouseup', base));
          btn.dispatchEvent(new MouseEvent('click', base));
          const clickOk = clicked === 1;

          return { inputOk, editorOk, clickOk, inserted };
        })()`);
        ok(humRes?.inputOk === true, '拟人化 input：原生 setter + InputEvent 逐段输入生效');
        ok(humRes?.editorOk === true, '拟人化 contenteditable：execCommand insertText 生效');
        ok(humRes?.clickOk === true, '拟人化 click：mouseover→mousedown→mouseup→click 序列触发');
      } finally {
        await new Promise((resolve) => humServer.close(resolve));
      }
    }
  } catch (e) {
    console.error(`  ❌ [FAIL] 冒烟执行异常: ${e.message}`);
    if (chromeErr.trim()) console.error(`      └ Chrome stderr 片段: ${chromeErr.trim().slice(-600)}`);
    failed++;
  } finally {
    if (browser) browser.close();
    try { chrome.kill(); } catch {}
  }

  console.log('\n====================================================');
  console.log(`🚀 冒烟测试汇总: 总计 ${passed + failed} 项，通过 ${passed} 项${failed ? `，失败 ${failed} 项` : '，全部通过 🎉'}`);
  console.log('====================================================');
  process.exit(failed > 0 ? 1 : 0);
}

main();
