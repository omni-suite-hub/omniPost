import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const TMP = path.join(ROOT, 'test', '.tmp');
const DIST = path.join(ROOT, 'packages', 'extension', 'dist');
const PROFILE = path.join(TMP, 'preview-profile');
const PORT = 9338;
const CFT_BIN = path.join(
  TMP, 'cft', 'chrome-mac-arm64', 'Google Chrome for Testing.app',
  'Contents', 'MacOS', 'Google Chrome for Testing',
);
const SHOT = './screenshot.png';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('CDP connect error'));
      this.ws.onclose = () => {
        for (const { reject: rj } of this.pending.values()) rj(new Error('closed'));
        this.pending.clear();
      };
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? rj(new Error(JSON.stringify(m.error))) : rs(m.result);
        } else if (m.method) {
          this.listeners.forEach((f) => f(m));
        }
      };
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evalIn(cdp, sessionId, expr) {
  const res = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (res.exceptionDetails) {
    throw new Error(JSON.stringify(res.exceptionDetails));
  }
  return res.result?.value;
}

async function discoverExtensionId() {
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
  try {
    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const sw = targets.find((t) => t.type === 'service_worker' && t.url?.includes('service-worker-loader.js'));
    const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(sw?.url || '');
    if (m) return m[1];
  } catch {}
  return null;
}

async function main() {
  console.log('🚀 运行 PreviewModal 真实预览与截图测试...');
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  // 与其余 e2e 保持一致的启动参数：本沙箱无显示服务，必须 --headless=new + --no-sandbox，
  // 否则扩展加载不进来（discoverExtensionId 会一直拿不到扩展 ID）
  const chrome = spawn(CFT_BIN, [
    '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--user-data-dir=' + PROFILE,
    '--disable-extensions-except=' + DIST,
    '--load-extension=' + DIST,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--headless=new',
    '--window-size=960,850',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let closed = false;
  const cleanup = () => {
    if (!closed) {
      closed = true;
      try { chrome.kill('SIGKILL'); } catch {}
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  try {
    let version;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      try {
        version = await getJson('http://127.0.0.1:' + PORT + '/json/version');
        if (version?.webSocketDebuggerUrl) break;
      } catch {}
    }
    if (!version) throw new Error('CDP 未就绪');

    const browser = new CDP(version.webSocketDebuggerUrl);
    await browser.open();

    const extId = await discoverExtensionId();
    if (!extId) throw new Error('扩展未成功加载');
    console.log('已定位扩展 ID:', extId);

    const popupUrl = 'chrome-extension://' + extId + '/index.html';
    const { targetId } = await browser.send('Target.createTarget', { url: popupUrl });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

    await browser.send('Page.enable', {}, sessionId);
    await browser.send('Runtime.enable', {}, sessionId);
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 468,
      height: 700,
      deviceScaleFactor: 2,
      mobile: false,
    }, sessionId);

    await sleep(1500);

    // 写入 pendingArticle 到 chrome.storage.local
    await evalIn(browser, sessionId, `(async () => {
      const sampleImg1 = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240" viewBox="0 0 600 240"><defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="%234338ca"/><stop offset="100%" stop-color="%236366f1"/></linearGradient></defs><rect width="600" height="240" rx="16" fill="url(%23g1)"/><circle cx="300" cy="100" r="50" fill="white" opacity="0.15"/><text x="300" y="110" fill="white" font-family="system-ui,-apple-system,sans-serif" font-size="24" font-weight="bold" text-anchor="middle">OmniPost 架构设计图</text><text x="300" y="145" fill="%23c7d2fe" font-family="system-ui,-apple-system,sans-serif" font-size="14" text-anchor="middle">本地沙箱 · API 平台直连 · 拟人自动化注入</text></svg>';
      const sampleImg2 = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240" viewBox="0 0 600 240"><defs><linearGradient id="g2" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="%23065f46"/><stop offset="100%" stop-color="%2310b981"/></linearGradient></defs><rect width="600" height="240" rx="16" fill="url(%23g2)"/><rect x="180" y="55" width="240" height="100" rx="12" fill="white" opacity="0.15"/><text x="300" y="110" fill="white" font-family="system-ui,-apple-system,sans-serif" font-size="24" font-weight="bold" text-anchor="middle">全网智能一键分发流</text><text x="300" y="145" fill="%23a7f3d0" font-family="system-ui,-apple-system,sans-serif" font-size="14" text-anchor="middle">39 大平台矩阵 · 毫秒级发布队列</text></svg>';

      const mdText = [
        '# 一、Manifest V3 时代的范式重构与运行模型\\n\\n1.1 为什么告别 Manifest V2: 安全、性能与隐私的博弈\\n\\nChrome 团队推进 Manifest V3 (MV3) 绝非一次简单的 API 版本递增，而是一场对浏览器扩展运行环境的底层重构。在传统的 Manifest V2 架构中，扩展享有极高的自由度，但也留下了严重的架构隐患。\\n\\n1. 持久化常驻后台（Persistent Background Pages）导致的内存泄露与功耗浪费：在 MV2 中，一个插件的后台页面可以拥有完整的 DOM 环境，且与浏览器进程同生共死。当用户安装了 20 个插件，哪怕没有任何交互，内存中也常驻着 20 个隐形的前端渲染进程，严重侵蚀系统资源。',
        '### 1.2 MV3 核心运行环境全景拆解\\n\\n一个设计精良的现代插件不是由单一文件构成的脚本，而是一个运行在多个独立环境中的分布式系统。每个环境在沙箱权限、生命周期和 API 访问能力上均存在明确边界：\\n\\n\`\`\`\\n+------------------------------------+\\n| Chrome Browser Process             |\\n+------------------------------------+\\n| Extensions Service Worker (后台沙箱)|\\n+------------------------------------+\\n\`\`\`\\n\\n在架构设计上，我们将业务逻辑与 UI 层严格解耦。',
        '### 1.3 多平台拟人化发布流水线\\n\\n分发到知乎、掘金、微信公众号与海外 X/Bluesky 成为现代创作者的刚需。\\n\\n\`\`\`ts\\n// 图片混排段落插槽算法\\nconst slotIndex = Math.min(blocks.length, userSlot);\\nconsole.log("图片成功插入到段落槽位:", slotIndex);\\n\`\`\`\\n\\n> 💡 架构亮点：支持图片任意拖拽换位、快捷置顶封面、置底文末，并在弹窗内直接微调改写。',
        '### 1.4 本地沙箱与安全隐私保证\\n\\nOmniPost 采用纯本地沙箱与浏览器真实会话通道，不经过任何第三方中心服务器，从根本上杜绝 Cookie 与创作文案泄漏。所有凭证存储在本地 chrome.storage 中，发布操作完全由用户本地驱动。',
        '### 1.5 体验总结与发布实测\\n\\n全新的独立排版预览弹窗让创作者在最终分发前对格式、图片比例与排版质感了如指掌！双向同步滚动更让对照编辑修改如行云流水。'
      ].join('\\n\\n');

      await new Promise((resolve) => {
        chrome.storage.local.set({
          pendingArticle: {
            title: '2026 年新一代内容全网分发引擎 OmniPost 深度实测',
            body: mdText,
            media: [
              { id: 'm1', name: 'omnipost-arch.svg', type: 'image/svg+xml', size: 1024, dataUrl: sampleImg1 },
              { id: 'm2', name: 'dispatch-flow.svg', type: 'image/svg+xml', size: 2048, dataUrl: sampleImg2 }
            ]
          }
        }, resolve);
      });
    })()`);

    // 重新加载页面使 state 初始化
    await browser.send('Page.reload', {}, sessionId);
    await sleep(1800);

    // 点击「真实排版预览」按钮
    const opened = await evalIn(browser, sessionId, `(async () => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('真实排版预览'));
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    })()`);
    console.log('点击打开预览弹窗:', opened);
    await sleep(1200);

    // 截屏保存到 artifact 目录 (沉浸预览)
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(SHOT, Buffer.from(data, 'base64'));
    console.log('📸 真实预览弹窗截图已成功保存至:', SHOT);

    // 切换到「对照润色」分栏模式并截图
    await evalIn(browser, sessionId, `(() => {
      const splitBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('对照润色'));
      if (splitBtn) splitBtn.click();
    })()`);
    await sleep(600);

    const SHOT_SPLIT = './screenshot.png';
    const { data: splitData } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(SHOT_SPLIT, Buffer.from(splitData, 'base64'));
    console.log('📸 对照润色分栏弹窗截图已成功保存至:', SHOT_SPLIT);

    // 测试滚动左侧 textarea 并验证右侧是否精准对齐
    const scrollAlignment = await evalIn(browser, sessionId, `(async () => {
      const allTas = Array.from(document.querySelectorAll('textarea'));
      const ta = allTas.find(t => t.placeholder && t.placeholder.includes('排版效果实时预览')) || allTas[allTas.length - 1];
      const right = Array.from(document.querySelectorAll('div')).find(d => d.getAttribute('data-block-idx') !== null)?.parentElement;
      if (!ta || !right) return { error: '未找到 textarea 或 right pane', foundTas: allTas.length };

      const mirror = Array.from(document.querySelectorAll('[data-mirror-idx]'));
      const rightBlocks = Array.from(document.querySelectorAll('[data-block-idx]'));
      
      const maxLeft = ta.scrollHeight - ta.clientHeight;
      const maxRight = right.scrollHeight - right.clientHeight;

      // 滚动到第 4 个块 (索引 3: ### 1.2 MV3 核心运行环境全景拆解)
      const targetIdx = Math.min(3, mirror.length - 1);
      const targetTop = mirror[targetIdx].offsetTop - 16;
      ta.scrollTop = targetTop;
      ta.dispatchEvent(new Event('scroll', { bubbles: true }));

      await new Promise(r => setTimeout(r, 600));

      const targetEl = document.querySelector('[data-block-idx="' + targetIdx + '"]');
      const tRect = targetEl ? targetEl.getBoundingClientRect() : null;
      const rRect = right.getBoundingClientRect();
      const visualDistanceToTop = tRect ? tRect.top - rRect.top : -1;

      return {
        taScrollHeight: ta.scrollHeight,
        taClientHeight: ta.clientHeight,
        maxLeft,
        maxRight,
        targetIdx,
        targetTop,
        leftScrollTop: ta.scrollTop,
        rightScrollTop: right.scrollTop,
        visualDistanceToTop,
        scrollLog: window.__scrollLog,
        mirrorCount: mirror.length,
        rightBlockCount: rightBlocks.length,
        isAligned: Math.abs(visualDistanceToTop - 16) <= 5
      };
    })()`);
    console.log('🎯 真实滚动对齐测试结果:', scrollAlignment);

    const SHOT_SCROLLED = './screenshot.png';
    const { data: scrolledData } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(SHOT_SCROLLED, Buffer.from(scrolledData, 'base64'));
    console.log('📸 滚动后对齐截图已成功保存至:', SHOT_SCROLLED);

    browser.close();
    cleanup();
    console.log('🎉 验证成功，测试完毕！');
  } catch (err) {
    cleanup();
    console.error('❌ 执行失败:', err);
    process.exit(1);
  }
}

main();
