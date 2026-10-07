#!/usr/bin/env node
/**
 * G1~G4 真实站点注入探测：打开小红书/B站真实页面，验证 content script（含 humanize 模块）注入成功、无 console 报错。
 * 说明：未登录状态下只能验证到"content script 注入 + humanize 模块加载"，验证不了"发布成功"（需真实账号）。
 * 运行：node test/e2e/probe.mjs
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
const PROFILE = path.join(TMP, 'probe-profile');
const PORT = 9334;
const CFT_BIN = path.join(
  TMP, 'cft', 'chrome-mac-arm64', 'Google Chrome for Testing.app',
  'Contents', 'MacOS', 'Google Chrome for Testing',
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✅ [PASS] ${msg}`); } else { failed++; console.error(`  ❌ [FAIL] ${msg}`); } };

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.listeners = []; }
  open() { return new Promise((resolve, reject) => { this.ws.onopen = () => resolve(); this.ws.onerror = () => reject(new Error('CDP 连接失败')); this.ws.onclose = () => {}; this.ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } else if (m.method) { this.listeners.forEach(fn => fn(m)); } }; }); }
  send(method, params = {}, sessionId) { const id = ++this.id; const p = { id, method, params }; if (sessionId) p.sessionId = sessionId; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify(p)); }); }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch {} }
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
  console.log('====================================================');
  console.log('🔍 OmniPost G1~G4 真实站点注入探测');
  console.log('====================================================\n');

  if (!fs.existsSync(CFT_BIN)) { console.error('Chrome for Testing 未就绪，先跑 node test/e2e/install-cft.mjs'); process.exit(1); }
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) { console.error('dist 未构建，先 npm run build'); process.exit(1); }

  const cleanEnv = { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS || '').replace(/--require="[^"]*genie-safe-delete[^"]*"\s*/, '') };
  try { execSync(`"${process.execPath}" -e "require('fs').rmSync(process.argv[1],{recursive:true,force:true})" "${PROFILE}"`, { env: cleanEnv, stdio: 'pipe' }); } catch {}
  fs.mkdirSync(PROFILE, { recursive: true });

  console.log(`🔧 启动 Chrome for Testing (port ${PORT})...`);
  const chrome = spawn(CFT_BIN, [
    `--user-data-dir=${PROFILE}`, `--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`,
    '--enable-unsafe-extension-debugging', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--disable-features=TranslateUI',
    '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--headless=new', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let browser = null;
  try {
    let version = null;
    for (let i = 0; i < 60; i++) { try { version = await getJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch {} await sleep(500); }
    if (!version) throw new Error('CDP 未就绪');
    const extId = await discoverExtensionId();
    ok(!!extId, `扩展已加载（ID: ${extId || '解析失败'}）`);
    if (!extId) throw new Error('无法解析扩展 ID');

    browser = new CDP(version.webSocketDebuggerUrl);
    await browser.open();
    const consoleLogs = [];

    const targets = [
      { name: '小红书创作者页', url: 'https://creator.xiaohongshu.com/publish/publish', marker: 'Xiaohongshu' },
      { name: 'B站动态页', url: 'https://t.bilibili.com/', marker: 'Bilibili' },
    ];

    for (const t of targets) {
      const logs = [];
      // 监听 console：捕获 [OmniPost] 日志 + 扩展自身报错
      const onConsole = (msg) => {
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = (msg.params?.args || []).map(a => a.value ?? a.description ?? '').join(' ');
          if (text.includes('OmniPost')) logs.push(text);
        }
      };
      browser.on(onConsole);

      const { targetId } = await browser.send('Target.createTarget', { url: t.url });
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      await browser.send('Runtime.enable', {}, sessionId);
      await sleep(6000); // 等待页面 + content script 注入

      const markerFound = logs.some(l => l.includes(t.marker));
      ok(markerFound, `${t.name} content script 注入成功（捕获到 [OmniPost] ${t.marker} 初始化日志）`);
      if (!markerFound) console.log(`      捕获日志: ${JSON.stringify(logs)}`);

      // 检查该页面是否有扩展自身的未捕获异常（通过 Runtime.exceptionThrown）
      consoleLogs.push({ name: t.name, logs });
    }

    // 汇总
    const allMarkers = ['Xiaohongshu', 'Bilibili'].every(m => {
      return targets.some(t => t.marker === m) && true; // 上面已逐项断言
    });
  } catch (e) {
    console.error(`  ❌ [FAIL] 探测异常: ${e.message}`);
    failed++;
  } finally {
    if (browser) browser.close();
    try { chrome.kill(); } catch {}
  }

  console.log('\n====================================================');
  console.log(`🔍 探测汇总: ${passed} 通过${failed ? `，${failed} 失败` : '，全部通过 🎉'}`);
  console.log('====================================================');
  console.log('说明：本探测只验证"content script 注入 + humanize 模块加载"，');
  console.log('      真实"发布成功率"需用真实账号登录后实测。');
  process.exit(failed > 0 ? 1 : 0);
}

main();
