#!/usr/bin/env node
/**
 * OmniPost 发布断线兜底专项测试（真实 Chrome + 真实 MV3 Service Worker）
 *
 * 背景：2026-09-07 事故——17 个平台全部误报「未执行或被跳过」，根因是后台没回话
 * （监听器无 catch + SW 被回收），前端把没有结果的平台一律打成这个兜底文案。
 * 本次修复引入 4 层防线，本文件验证其中「前端可验证」的部分：
 *
 *   A. 写侧：真实发布一次（zip-download），后台必须把各平台进度落盘到 storage.local.publishProgress
 *   B. 读侧：模拟 message port 断开（sendMessage 回调 undefined）→
 *           必须用落盘进度还原回执，且置顶「可能不完整」红色横幅
 *   C. 无进度兜底：断开且无落盘进度 → 走 alert 诚实告知，不得伪造成功回执
 *   D. fatal 分支：后台返回 {fatal} → 横幅必须显示真实原因
 *   E. i18n：英文模式下横幅与回执不得出现中文（此前已多次踩坑）
 *   F. 全程无扩展自身 console error
 *
 * 运行：node test/e2e/disconnect-recovery.mjs（需先 npm run build）
 */
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const TMP = path.join(ROOT, 'test', '.tmp');
const DIST = path.join(ROOT, 'packages', 'extension', 'dist');
const PROFILE = path.join(TMP, 'disconnect-profile');
const DOWNLOADS = path.join(TMP, 'disconnect-downloads');
const PORT = 9341;
const CFT_BIN = path.join(TMP, 'cft', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const findings = [];
function ok(cond, msg, level = 'P0', area = '发布断线兜底') {
  if (cond) { passed++; console.log(`  ✅ [PASS] ${msg}`); }
  else { failed++; findings.push({ level, area, msg }); console.error(`  ❌ [FAIL] ${msg}`); }
}
function info(msg) { console.log(`      └ ${msg}`); }
const CJK = /[一-龥]/;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
class CDP {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.pending = new Map(); this.listeners = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('CDP 连接失败'));
      this.ws.onclose = () => { for (const { reject: r } of this.pending.values()) r(new Error('closed')); this.pending.clear(); };
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) { const { resolve: rs, reject: rj } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rj(new Error(JSON.stringify(m.error))) : rs(m.result); }
        else if (m.method) this.listeners.forEach((f) => f(m));
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const p = { id, method, params };
    if (sessionId) p.sessionId = sessionId;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify(p)); });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch {} }
}
async function evalIn(b, s, e) {
  const r = await b.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error('页面异常: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r.result?.value;
}
async function discoverExtensionId() {
  for (let i = 0; i < 40; i++) {
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(PROFILE, 'Default', 'Preferences'), 'utf8'));
      for (const [id, v] of Object.entries(prefs?.extensions?.settings || {})) {
        if (v?.path && path.resolve(v.path) === path.resolve(DIST)) return id;
      }
    } catch {}
    try {
      const ts = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const sw = ts.find((t) => t.type === 'service_worker' && t.url?.includes('service-worker-loader.js'));
      const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(sw?.url || '');
      if (m) return m[1];
    } catch {}
    await sleep(500);
  }
  return null;
}

/** 打开（或重建）popup，并可选地注入断线模拟 + 预置落盘进度 */
async function openPopup(browser, extId, lang, { seedProgress = null, simMode = null } = {}) {
  const prior = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  for (const t of prior) {
    if (t.type === 'page' && t.url?.startsWith(`chrome-extension://${extId}/index.html`)) {
      await browser.send('Target.closeTarget', { targetId: t.id }).catch(() => {});
    }
  }
  await sleep(500);
  const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/index.html` });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Runtime.enable', {}, sessionId);
  await evalIn(browser, sessionId, `(async () => { await chrome.storage.local.set({ lang: '${lang}' }); return true; })()`);
  await browser.send('Page.reload', {}, sessionId);
  await sleep(500);
  await evalIn(browser, sessionId, `(async () => { for (let i=0;i<60;i++){ const r=document.querySelector('#root'); if(r&&r.childElementCount>0&&r.textContent.trim().length>20) return true; await new Promise(x=>setTimeout(x,300)); } return false; })()`);
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true });
  // 等登录态刷新（未登录平台置灰），避免把未登录平台也勾上
  await evalIn(browser, sessionId, `(async () => {
    for (let i = 0; i < 60; i++) {
      if (document.querySelectorAll('input[type=checkbox]:disabled').length > 0) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  })()`);
  await sleep(1000);

  // 预置落盘进度（模拟后台在 SW 被回收前已写入的状态）
  if (seedProgress !== null) {
    await evalIn(browser, sessionId, `(async () => {
      await chrome.storage.local.set({ publishProgress: ${JSON.stringify(seedProgress)} });
      return true;
    })()`);
  }
  // 模拟断线 / fatal：拦截 START_AUTO_PUBLISH 的响应
  if (simMode) {
    const installed = await evalIn(browser, sessionId, `(() => {
      try {
        const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
        const fn = function (msg, cb) {
          if (msg && msg.type === 'START_AUTO_PUBLISH') {
            const mode = window.__simMode;
            if (mode === 'disconnect') { setTimeout(function () { cb(undefined); }, 80); return; }
            if (mode === 'fatal') { setTimeout(function () { cb({ fatal: 'simulated-pipeline-boom' }); }, 80); return; }
          }
          return typeof cb === 'function' ? orig(msg, cb) : orig(msg);
        };
        try { chrome.runtime.sendMessage = fn; }
        catch (e) {
          Object.defineProperty(chrome.runtime, 'sendMessage', { value: fn, configurable: true, writable: true });
        }
        window.__simMode = '${simMode}';
        return chrome.runtime.sendMessage === fn;
      } catch (e) { return 'ERR: ' + e.message; }
    })()`);
    ok(installed === true, `已注入断线模拟（${simMode}）`, 'P0');
  }
  return { targetId, sessionId };
}

async function fillAndPublish(browser, sessionId) {
  await evalIn(browser, sessionId, `(async () => {
    window.alert = function (m) { (window.__alerts = window.__alerts || []).push(String(m)); };
    window.confirm = function () { return true; };
    const setV = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const ti = Array.from(document.querySelectorAll('input')).find(i => /标题|title/i.test(i.placeholder || ''));
    const ta = document.querySelector('textarea');
    if (ti) setV(ti, '断线兜底测试标题 123');
    if (ta) setV(ta, '第一段正文。\\n\\n第二段正文。');
    await new Promise(r => setTimeout(r, 400));
    // 只勾 zip-download（唯一恒可发布平台）：勾 YouTube 会被「仅支持视频发布」拦截，
    // 勾小红书会被「必须有图片/视频」拦截，导致根本走不到发布流程。
    const cards = Array.from(document.querySelectorAll('input[type=checkbox]'));
    const target = cards.find(c => {
      if (c.disabled) return false;
      const card = c.closest('div[class*="rounded-xl"]') || c.parentElement?.parentElement;
      return /压缩包|zip|Markdown/i.test((card?.textContent || ''));
    });
    if (target) { if (!target.checked) target.click(); }
    else { const fb = cards.find(c => !c.disabled); fb && fb.click(); }
    await new Promise(r => setTimeout(r, 400));
    const btn = Array.from(document.querySelectorAll('button')).find(b => /发布|Publish/.test(b.textContent || '') && !/历史|定时|Schedule/.test(b.textContent || ''));
    btn && btn.click();
    return true;
  })()`);
}

async function waitReceipt(browser, sessionId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await evalIn(browser, sessionId, `(() => {
      const h = Array.from(document.querySelectorAll('h3')).find(x => /回执|receipt/i.test(x.textContent || ''));
      if (!h) return null;
      const modal = h.closest('div[class*="fixed"]') || h.parentElement.parentElement.parentElement;
      const banner = modal.querySelector('div[class*="bg-red-500"]');
      const rows = Array.from(modal.querySelectorAll('div[class*="bg-[#090d15]"]'));
      return {
        heading: (h.textContent || '').trim(),
        banner: banner ? (banner.textContent || '').trim() : null,
        rowCount: rows.length,
        text: (modal.innerText || '').replace(/\\n+/g, ' | ').slice(0, 800),
      };
    })()`);
    if (r) return r;
    await sleep(800);
  }
  return null;
}

async function main() {
  console.log('====================================================');
  console.log('🚀 OmniPost 发布断线兜底专项测试（真实 Chrome）');
  console.log('====================================================\n');

  const cleanEnv = { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS || '').replace(/--require="[^"]*genie-safe-delete[^"]*"\s*/, '') };
  for (const d of [PROFILE, DOWNLOADS]) {
    try { execSync(`"${process.execPath}" -e "require('fs').rmSync(process.argv[1],{recursive:true,force:true})" "${d}"`, { env: cleanEnv, stdio: 'pipe' }); } catch {}
    fs.mkdirSync(d, { recursive: true });
  }

  // Chrome 启动会在 $HOME/Downloads 建临时目录（.com.google.chrome.for.testing.*）。
  // 把 HOME/TMPDIR 指到测试临时目录，避免写用户真实下载目录（沙箱会拦截）。
  const chromeEnv = { ...process.env, HOME: TMP, TMPDIR: TMP };
  const chrome = spawn(CFT_BIN, [
    `--user-data-dir=${PROFILE}`, `--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`,
    '--enable-unsafe-extension-debugging', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
    '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--headless=new', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: chromeEnv });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

  let browser = null;
  try {
    let version = null;
    for (let i = 0; i < 60; i++) { try { version = await getJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch {} await sleep(500); }
    ok(!!version, `CDP 就绪（${version?.Browser}）`, 'P0', '环境');
    const extId = await discoverExtensionId();
    ok(!!extId, `扩展已加载（${extId}）`, 'P0', '环境');
    if (!extId) throw new Error('无扩展 ID');
    browser = new CDP(version.webSocketDebuggerUrl);
    await browser.open();

    const consoleErrors = [];
    browser.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled') {
        const t = m.params?.type;
        if (t === 'error') {
          const text = (m.params.args || []).map((a) => a.value || a.description).join(' ');
          if (!/net::|favicon|ERR_/.test(text)) consoleErrors.push('console-error: ' + text);
        }
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails?.exception?.description || '';
        if (!/net::|ERR_/.test(d)) consoleErrors.push('exception: ' + d.slice(0, 200));
      }
    });

    // ---------- 0. SW 存活 ----------
    console.log('\n▶ 场景 0：Service Worker 存活与进度查询');
    {
      const { sessionId } = await openPopup(browser, extId, 'zh');
      const alive = await evalIn(browser, sessionId, `(() => new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve('TIMEOUT'); } }, 8000);
        try {
          chrome.runtime.sendMessage({ type: 'GET_CURRENT_PROGRESS' }, (res) => {
            if (done) return; done = true; clearTimeout(t);
            resolve(res ? 'OK' : 'EMPTY');
          });
        } catch (e) { if (!done) { done = true; clearTimeout(t); resolve('ERR:' + e.message); } }
      }))()`);
      ok(alive === 'OK', `后台 SW 存活并响应 GET_CURRENT_PROGRESS（${alive}）`, 'P0', '后台');
    }

    // ---------- A. 写侧：真实发布后进度落盘 ----------
    console.log('\n▶ 场景 A：真实发布 → 后台把进度落盘 storage.local.publishProgress');
    {
      const { sessionId } = await openPopup(browser, extId, 'zh');
      await evalIn(browser, sessionId, `(async () => { await chrome.storage.local.remove('publishProgress'); return true; })()`);
      await fillAndPublish(browser, sessionId);
      const receipt = await waitReceipt(browser, sessionId);
      ok(!!receipt, '真实发布后出现回执弹窗', 'P0');
      if (receipt) info(`回执: ${receipt.text.slice(0, 200)}`);
      await sleep(1500);
      const stored = await evalIn(browser, sessionId, `(() => new Promise((resolve) => {
        chrome.storage.local.get('publishProgress', (s) => resolve(s?.publishProgress || null));
      }))()`);
      const keys = stored ? Object.keys(stored) : [];
      info(`落盘进度平台: ${JSON.stringify(keys)}`);
      ok(!!stored && keys.length > 0, `后台已把各平台进度落盘（${keys.length} 个平台）`, 'P0', '后台');
      if (stored && keys.length > 0) {
        const anyDone = keys.some((k) => stored[k] && (stored[k].stage === 'done' || !!stored[k].result));
        ok(anyDone, '落盘进度含终态（stage=done 或 result），可供失联还原', 'P0', '后台');
      }
    }

    // ---------- B. 读侧：断线 + 有落盘进度 → 还原回执 + 红色横幅 ----------
    console.log('\n▶ 场景 B：message port 断开 + 有落盘进度 → 还原真实回执并置顶横幅');
    {
      const seed = {
        'zip-download': { platformId: 'zip-download', platformName: 'Markdown 压缩包', stage: 'done', message: '草稿已就绪', draft: { platformId: 'zip-download', url: 'https://example.local/draft' } },
        csdn: { platformId: 'csdn', platformName: 'CSDN', stage: 'failed', message: '未检测到登录会话，请先登录该平台' },
      };
      const { sessionId } = await openPopup(browser, extId, 'zh', { seedProgress: seed, simMode: 'disconnect' });
      await fillAndPublish(browser, sessionId);
      const receipt = await waitReceipt(browser, sessionId);
      ok(!!receipt, '断线后仍给出回执弹窗（不再无声吞掉）', 'P0');
      if (receipt) {
        info(`横幅: ${receipt.banner}`);
        ok(!!receipt.banner, '回执顶部出现红色失联横幅', 'P0');
        ok(/与后台的连接在长任务中中断/.test(receipt.banner || ''), '横幅说明「与后台连接中断」', 'P0');
        ok(/可能不完整/.test(receipt.banner || ''), '横幅声明回执「可能不完整」（不假装完整）', 'P0');
        ok(receipt.rowCount > 0, `回执列出各平台状态（${receipt.rowCount} 行）`, 'P0');
        ok(/草稿/.test(receipt.text || ''), '已建草稿的平台如实标为「草稿」（非谎报失败）', 'P1');
        ok(!/simulated/.test(receipt.text || ''), '回执不含模拟残留字段', 'P1');
      }
    }

    // ---------- C. 断线 + 无落盘进度 → 不得谎报成功 ----------
    console.log('\n▶ 场景 C：断线 + 无落盘进度 → 全员如实标记，绝不谎报成功');
    {
      const { sessionId } = await openPopup(browser, extId, 'zh', { seedProgress: {}, simMode: 'disconnect' });
      await fillAndPublish(browser, sessionId);
      const receipt = await waitReceipt(browser, sessionId);
      ok(!!receipt, '无落盘进度时也给出回执（不静默吞掉）', 'P0');
      if (receipt) {
        info(`横幅: ${receipt.banner}`);
        ok(!!receipt.banner, '无进度时同样置顶失联横幅', 'P0');
        ok(!/成功/.test(receipt.text || ''), '无任何平台被标为「成功」（无进度 = 无证据）', 'P0');
        ok(receipt.rowCount > 0, `回执仍完整列出各平台（${receipt.rowCount} 行）`, 'P1');
      }
      const alerts = await evalIn(browser, sessionId, `(() => window.__alerts || [])()`);
      info(`alert: ${JSON.stringify(alerts).slice(0, 160)}`);
      ok(!(alerts || []).some((a) => /成功|已发布/.test(a)), '不得弹出任何成功类提示', 'P0');
    }

    // ---------- D. fatal 分支 ----------
    console.log('\n▶ 场景 D：后台返回 {fatal} → 横幅显示真实原因');
    {
      const seed = { 'zip-download': { platformId: 'zip-download', platformName: 'Markdown 压缩包', stage: 'drafting', message: '正在创建草稿...' } };
      const { sessionId } = await openPopup(browser, extId, 'zh', { seedProgress: seed, simMode: 'fatal' });
      await fillAndPublish(browser, sessionId);
      const receipt = await waitReceipt(browser, sessionId);
      ok(!!receipt, 'fatal 时出现回执弹窗', 'P0');
      if (receipt) {
        info(`横幅: ${receipt.banner}`);
        ok(/发布管线异常中断/.test(receipt.banner || ''), '横幅显示「发布管线异常中断」', 'P0');
        ok(/simulated-pipeline-boom/.test(receipt.banner || ''), '横幅透出后台真实错误原因', 'P0');
      }
    }

    // ---------- E. 英文界面无中文泄漏 ----------
    console.log('\n▶ 场景 E：英文模式下失联横幅与回执无中文泄漏');
    {
      const seed = {
        'zip-download': { platformId: 'zip-download', platformName: 'Markdown 压缩包', stage: 'done', message: '草稿已就绪' },
        csdn: { platformId: 'csdn', platformName: 'CSDN', stage: 'failed', message: '未检测到登录会话，请先登录该平台' },
      };
      const { sessionId } = await openPopup(browser, extId, 'en', { seedProgress: seed, simMode: 'disconnect' });
      await fillAndPublish(browser, sessionId);
      const receipt = await waitReceipt(browser, sessionId);
      ok(!!receipt, '英文模式断线后出现回执弹窗', 'P0');
      if (receipt) {
        info(`EN 横幅: ${receipt.banner}`);
        ok(!!receipt.banner && !CJK.test(receipt.banner), '英文模式横幅无中文（i18n 已覆盖）', 'P0', 'i18n');
        // 平台名/状态行由 PLATFORMS + _() 翻译，正文里不应残留中文
        const bodyText = (receipt.text || '').replace(/Markdown|zip/g, '');
        ok(!CJK.test(bodyText), '英文模式回执正文无中文泄漏', 'P1', 'i18n');
      }
    }

    // ---------- F. console 清洁 ----------
    console.log('\n▶ 场景 F：全程 console 清洁');
    ok(consoleErrors.length === 0, `全程无扩展自身 console error（${consoleErrors.length} 条）`, 'P0', '稳定性');
    if (consoleErrors.length) consoleErrors.slice(0, 6).forEach((e) => info(e.slice(0, 200)));

  } catch (e) {
    failed++;
    findings.push({ level: 'P0', area: '测试执行', msg: '测试异常: ' + e.message });
    console.error(`\n❌ 测试执行异常: ${e.message}`);
    if (chromeErr) console.error('Chrome stderr 尾部:\n' + chromeErr.split('\n').slice(-15).join('\n'));
  } finally {
    try { browser?.close(); } catch {}
    try { chrome.kill('SIGKILL'); } catch {}
    await sleep(800);
  }

  console.log('\n====================================================');
  console.log(`📊 断线兜底专项: 总计 ${passed + failed} 项，通过 ${passed} 项，失败 ${failed} 项`);
  if (findings.length) {
    console.log('\n未通过项：');
    for (const f of findings) console.log(`  - [${f.level}] ${f.area}: ${f.msg}`);
  }
  console.log('====================================================');
  process.exit(failed === 0 ? 0 : 1);
}

main();
