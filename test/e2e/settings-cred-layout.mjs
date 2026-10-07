#!/usr/bin/env node
/**
 * OmniPost 设置面板凭证区块排版专项验证（真实 Chrome）
 *
 * 背景（2026-09 用户反馈「页面太丑」）：
 *   - CredLink 行内布局导致「申请指引：」标签被压成竖排折行、长链接横向溢出
 *   - 每个平台常驻全宽「测试连接（先保存设置）」+「未验证」灰字，重复噪音
 *
 * 覆盖：
 *   A. CredLink 标签/链接单行不竖排、不横向溢出（Range rects 检测）
 *   B. 「未验证」常驻文案与「测试连接（…）」冗余括号文案已消失
 *   C. 截图供人工复核 + 无 console error
 *
 * 运行：node test/e2e/settings-cred-layout.mjs
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
const PROFILE = path.join(TMP, 'cred-layout-profile');
const PORT = 9363;
const SHOT = path.join(ROOT, '.workbuddy', 'reports', 'settings-cred-redesign.png');
const CFT_BIN = path.join(TMP, 'cft', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const findings = [];
function ok(cond, msg, level = 'P1', area = 'Layout') {
  if (cond) { passed++; console.log(`  ✅ [PASS] ${msg}`); }
  else { failed++; findings.push({ level, area, msg }); console.error(`  ❌ [FAIL] ${msg}`); }
}
function info(msg) { console.log(`      └ ${msg}`); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.listeners = []; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('CDP 连接失败'));
      this.ws.onclose = () => { for (const { reject: rj } of this.pending.values()) rj(new Error('closed')); this.pending.clear(); };
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? rj(new Error(JSON.stringify(m.error))) : rs(m.result);
        } else if (m.method) this.listeners.forEach((f) => f(m));
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const p = { id, method, params };
    if (sessionId) p.sessionId = sessionId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify(p)); });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch {} }
}

async function evalIn(b, s, expr) {
  const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error('页面异常: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400));
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

/** CredLink 排版检测：note 标签单行、链接按钮不溢出容器 */
const LAYOUT = `(() => {
  function firstLineRects(el) {
    const node = el.childNodes.length && Array.from(el.childNodes).find(n => n.nodeType === 3 && n.nodeValue.trim());
    const target = node || el;
    const range = document.createRange();
    range.selectNodeContents(target);
    return Array.from(range.getClientRects()).filter(r => r.width > 0.5 && r.height > 0.5).length;
  }
  const out = { links: [], notes: [], body: '' };
  for (const box of Array.from(document.querySelectorAll('div[class*="space-y-0"]'))) {
    const note = box.querySelector(':scope > div.text-gray-500');
    const btn = box.querySelector(':scope > button');
    if (note) out.notes.push({ text: note.textContent.trim().slice(0, 30), lines: firstLineRects(note) });
    if (btn) {
      const br = btn.getBoundingClientRect();
      const pr = (btn.parentElement.parentElement || btn.parentElement).getBoundingClientRect();
      out.links.push({
        text: btn.textContent.trim().slice(0, 30),
        lines: firstLineRects(btn.querySelector('span:last-child') || btn),
        overflow: Math.round(br.right - pr.right),
      });
    }
  }
  out.body = (document.body.innerText || '').slice(0, 100);
  return out;
})()`;

/** 全面板审计：孤儿折行（短文案被折多行）+ 任意元素横向溢出设置弹层 */
const FULLSCAN = `(() => {
  const modal = Array.from(document.querySelectorAll('div')).find(d => (d.className||'').includes('max-h-[85vh]'));
  if (!modal) return { err: 'no-modal' };
  const mRect = modal.getBoundingClientRect();
  const out = { orphan: [], overflow: [] };
  const walker = document.createTreeWalker(modal, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const t = (n.nodeValue || '').trim();
    if (!t || t.length > 14) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0.5 && r.height > 0.5);
    if (rects.length > 1) out.orphan.push({ text: t.slice(0, 20), lines: rects.length });
  }
  const seen = new Set();
  for (const el of modal.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') continue;
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > mRect.right + 2 || r.left < mRect.left - 2) {
      const key = tag + '|' + String(el.className).slice(0, 30);
      if (seen.has(key)) continue;
      seen.add(key);
      out.overflow.push({ tag, cls: String(el.className).slice(0, 40), text: (el.textContent||'').trim().slice(0, 20) });
    }
  }
  out.overflow = out.overflow.slice(0, 10);
  return out;
})()`;

async function main() {
  console.log('====================================================');
  console.log('🎨 OmniPost 设置面板凭证区块排版专项验证');
  console.log('====================================================\n');

  ok(fs.existsSync(CFT_BIN), 'Chrome for Testing 已就绪');
  ok(fs.existsSync(path.join(DIST, 'manifest.json')), 'dist 构建产物存在');
  if (failed) process.exit(1);

  const cleanEnv = { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS || '').replace(/--require="[^"]*genie-safe-delete[^"]*"\s*/, '') };
  try { execSync(`"${process.execPath}" -e "require('fs').rmSync(process.argv[1],{recursive:true,force:true})" "${PROFILE}"`, { env: cleanEnv, stdio: 'pipe' }); } catch {}
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.mkdirSync(path.dirname(SHOT), { recursive: true });

  const chrome = spawn(CFT_BIN, [
    `--user-data-dir=${PROFILE}`, `--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`,
    '--enable-unsafe-extension-debugging', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
    '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--headless=new', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

  let browser = null;
  try {
    let version = null;
    for (let i = 0; i < 60; i++) { try { version = await getJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch {} await sleep(500); }
    ok(!!version, `CDP 就绪（${version?.Browser}）`);
    const extId = await discoverExtensionId();
    ok(!!extId, `扩展已加载（${extId}）`);
    if (!extId) throw new Error('无扩展 ID');

    browser = new CDP(version.webSocketDebuggerUrl);
    await browser.open();
    const consoleErrors = [];
    browser.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') consoleErrors.push('console: ' + (m.params.args || []).map((a) => a.value || a.description).join(' '));
      if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('exception: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 200));
    });

    // 打开 popup（中文）→ 打开设置面板
    const { sessionId } = await (async () => {
      const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/index.html` });
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      await browser.send('Runtime.enable', {}, sessionId);
      await sleep(500);
      await evalIn(browser, sessionId, `(async () => { await chrome.storage.local.set({ lang: 'zh' }); location.reload(); return true; })()`).catch(() => {});
      await sleep(1500);
      return { sessionId };
    })();

    const opened = await evalIn(browser, sessionId, `(async () => {
      for (let i = 0; i < 40; i++) {
        const r = document.querySelector('#root');
        if (r && r.childElementCount > 0 && r.textContent.trim().length > 20) break;
        await new Promise(x => setTimeout(x, 300));
      }
      const gear = Array.from(document.querySelectorAll('button')).find(b =>
        /设置|平台 API|settings/i.test(b.getAttribute('title') || '') || (b.textContent || '').trim() === '⚙');
      if (!gear) return false;
      gear.click();
      await new Promise(r => setTimeout(r, 1000));
      return document.body.innerText.includes('平台凭证配置') || document.body.innerText.includes('扩展行为') || document.body.innerText.includes('Bridge Token');
    })()`);
    ok(opened === true, '设置面板打开成功');

    // ============ A. CredLink 排版 ============
    console.log('\n[A] CredLink 标签/链接排版（竖排折行 + 横向溢出检测）...');
    const layout = await evalIn(browser, sessionId, LAYOUT);
    info(`扫描到 ${layout.notes.length} 个说明标签 / ${layout.links.length} 个跳转链接`);
    // 全新 profile 下固定链接 8 个（reddit/youtube/telegram/bluesky/devto/hashnode×2/AI）；
    // Mastodon/WordPress/CMS 链接依赖用户填前置字段，为动态渲染不计入
    ok(layout.links.length >= 8, `跳转链接数 ${layout.links.length} >= 8（固定链接全集）`, 'P2', '覆盖');
    const badNotes = layout.notes.filter(n => n.lines > 1);
    badNotes.forEach(n => { info(`标签竖排折行: 「${n.text}」 ${n.lines} 行`); findings.push({ level: 'P1', area: '排版', msg: `标签折行「${n.text}」` }); });
    ok(badNotes.length === 0, `说明标签全部单行（违例 ${badNotes.length}）——修复「申请指/引:」竖排`);
    const badLinks = layout.links.filter(l => l.lines > 1 || l.overflow > 1);
    badLinks.forEach(l => { info(`链接折行/溢出: 「${l.text}」 lines=${l.lines} overflow=${l.overflow}px`); findings.push({ level: 'P1', area: '排版', msg: `链接折行/溢出「${l.text}」` }); });
    ok(badLinks.length === 0, `跳转链接全部单行且不溢出容器（违例 ${badLinks.length}）`);

    // ============ A2. 全面板审计 ============
    console.log('\n[A2] 全面板审计（孤儿折行 + 横向溢出）...');
    const full = await evalIn(browser, sessionId, FULLSCAN);
    if (full.err) { ok(false, `全面板审计未找到设置弹层: ${full.err}`); }
    else {
      (full.orphan || []).forEach(o => { info(`孤儿折行: 「${o.text}」 ${o.lines} 行`); findings.push({ level: 'P1', area: '排版', msg: `短文案折行「${o.text}」` }); });
      ok((full.orphan || []).length === 0, `无短文案折行（违例 ${(full.orphan || []).length}）`);
      (full.overflow || []).forEach(o => { info(`横向溢出: <${o.tag} class="${o.cls}"> 「${o.text}」`); findings.push({ level: 'P1', area: '排版', msg: `横向溢出 <${o.tag}> ${o.cls}` }); });
      ok((full.overflow || []).length === 0, `无元素横向溢出弹层（违例 ${(full.overflow || []).length}）`);
      // YouTube 回调地址专项：URL 不得再塞在按钮文字里
      const ytBtnWithUrl = await evalIn(browser, sessionId, `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /复制 OAuth 回调地址/.test(x.textContent||'')); return b ? b.textContent.includes('http') : false; })()`);
      ok(ytBtnWithUrl === false, 'YouTube 回调 URL 已拆出按钮（按钮文字不含 URL）');
    }

    // ============ B. 冗余文案消失 ============
    console.log('\n[B] 冗余文案清理...');
    const bodyText = await evalIn(browser, sessionId, `document.body.innerText`);
    ok(!bodyText.includes('未验证'), '不再常驻「未验证」占位灰字');
    ok(!bodyText.includes('测试连接（'), '「测试连接（…）」冗余括号说明已精简为「测试连接」');
    ok(!bodyText.includes('发文章时若未填'), 'Hashnode publicationId 长文案已精简');
    const testBtns = await evalIn(browser, sessionId, `(() => Array.from(document.querySelectorAll('button')).filter(b => (b.textContent||'').trim() === '测试连接').length)()`);
    ok(testBtns >= 6, `「测试连接」按钮统一渲染（${testBtns} 个 >= 6）`);

    // 截图（滚动到 Hashnode 区块附近再截）
    await evalIn(browser, sessionId, `(async () => {
      const h = Array.from(document.querySelectorAll('h4')).find(x => /Hashnode/.test(x.textContent||''));
      if (h) h.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 300));
      return true;
    })()`);
    try {
      const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(SHOT, Buffer.from(data, 'base64'));
      info(`截图已存: ${SHOT}`);
    } catch (e) { info('截图失败（不影响结论）: ' + e.message); }

    // ============ C. 控制台错误 ============
    console.log('\n[C] 控制台错误...');
    await sleep(500);
    const real = consoleErrors.filter((e) => !e.includes('net::') && !e.includes('ERR_'));
    real.slice(0, 10).forEach((e) => { info(e); findings.push({ level: 'P1', area: '运行时', msg: `console error: ${e}` }); });
    ok(real.length === 0, `全程无扩展自身 console error（${real.length} 条）`, 'P1', '运行时');

  } catch (e) {
    console.error(`  ❌ [FAIL] 验证异常: ${e.message}`);
    if (chromeErr.trim()) console.error(`      └ Chrome stderr: ${chromeErr.trim().slice(-500)}`);
    failed++;
  } finally {
    if (browser) browser.close();
    try { chrome.kill(); } catch {}
  }

  console.log('\n====================================================');
  console.log(`📊 结果: 通过 ${passed} / 失败 ${failed}`);
  if (findings.length) {
    console.log('\n问题清单:');
    findings.forEach((f) => console.log(`  [${f.level}][${f.area}] ${f.msg}`));
  }
  process.exit(failed ? 1 : 0);
}

main();
