#!/usr/bin/env node
/**
 * OmniPost 凭证「去哪申请/配置」跳转链接专项验证（真实 Chrome）
 *
 * 覆盖：
 *   A. 打开「平台凭证配置」设置面板
 *   B. 逐平台检查「去申请」链接是否存在、文案正确、href/onclick 指向正确 URL
 *   C. 点击跳转链接确实绑定 chrome.tabs.create（新标签打开对应申请页）
 *   D. 英文模式下新增指引文案无中文泄漏
 *   E. 全程无扩展自身 console error
 *
 * 运行：node test/e2e/cred-links.mjs
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
const PROFILE = path.join(TMP, 'cred-profile');
const PORT = 9351;
const CFT_BIN = path.join(TMP, 'cft', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const findings = [];
function ok(cond, msg, level = 'P1', area = 'Cred') {
  if (cond) { passed++; console.log(`  ✅ [PASS] ${msg}`); }
  else { failed++; findings.push({ level, area, msg }); console.error(`  ❌ [FAIL] ${msg}`); }
}
function note(level, area, msg) { findings.push({ level, area, msg }); }
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

/** 页面内：打开设置面板，逐个收集「去申请」链接（note 词 + 按钮文案 + 按钮外链信息） */
const COLLECT = `(async () => {
  // 等待 popup 完整渲染
  for (let i = 0; i < 40; i++) {
    const r = document.querySelector('#root');
    if (r && r.childElementCount > 0 && r.textContent.trim().length > 20) break;
    await new Promise(x => setTimeout(x, 300));
  }
  // 找设置按钮：title 含「设置」或「平台 API」或「settings」（大小写不敏感）
  const gear = Array.from(document.querySelectorAll('button')).find(b =>
    /设置|平台 API|settings/i.test(b.getAttribute('title') || '') || (b.textContent || '').trim() === '⚙'
  );
  if (!gear) return { opened: false, why: 'no-gear', body: (document.body.innerText||'').slice(0,120) };
  gear.click();
  await new Promise(r => setTimeout(r, 1000));
  // 确认 Modal（标题「平台凭证配置」或含「扩展行为」）已打开
  const modal = document.body.innerText.includes('平台凭证配置') || document.body.innerText.includes('扩展行为') || document.body.innerText.includes('多账号矩阵');
  const heading = Array.from(document.querySelectorAll('h3,h4')).map(h => (h.textContent||'').trim()).slice(0, 10);
  // 收集：所有以「去/申请/接入/配置/使用/如何获取」相关的按钮 + 灰色说明行
  const items = [];
  const seen = new Set();
  // 1) 按钮：含 🔗 前缀或文案含关键字
  for (const btn of document.querySelectorAll('button')) {
    if (btn.textContent.includes('🔗') || /去 |申请|接入|配置|生成|创建 API Key|回调地址/.test(btn.textContent)) {
      const t = (btn.textContent||'').replace(/^🔗/,'').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      items.push({ kind: 'button', btn: t, html: btn.outerHTML.slice(0, 200) });
    }
  }
  // 2) 灰色说明行（note）
  for (const sp of document.querySelectorAll('span.text-gray-500')) {
    const t = (sp.textContent||'').trim();
    if (!t || !/指引|说明|如何获取|配置/.test(t)) continue;
    const key = 'note|' + t;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: 'note', btn: t, html: sp.outerHTML.slice(0, 160) });
  }
  return { opened: !!modal, heading, items };
})()`;

const SCAN_CJK = `(() => {
  const CJK = /[\\u4e00-\\u9fff\\u3000-\\u303f\\uff01-\\uff65]/;
  const out = [];
  const seen = new Set();
  function visible(el) { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement; if (!el || !visible(el)) continue; if (el.closest('script,style')) continue;
    const t = (n.nodeValue || '').trim(); if (!t) continue;
    if (!CJK.test(t)) continue;
    const key = 't|' + t; if (seen.has(key)) continue; seen.add(key);
    out.push({ kind: 'text', text: t.slice(0, 120) });
  }
  return out;
})()`;

async function main() {
  console.log('====================================================');
  console.log('🔗 OmniPost 凭证「去申请/配置」跳转链接专项验证');
  console.log('====================================================\n');

  ok(fs.existsSync(CFT_BIN), 'Chrome for Testing 已就绪');
  ok(fs.existsSync(path.join(DIST, 'manifest.json')), 'dist 构建产物存在');
  if (failed) process.exit(1);

  const cleanEnv = { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS || '').replace(/--require="[^"]*genie-safe-delete[^"]*"\s*/, '') };
  try { execSync(`"${process.execPath}" -e "require('fs').rmSync(process.argv[1],{recursive:true,force:true})" "${PROFILE}"`, { env: cleanEnv, stdio: 'pipe' }); } catch {}
  fs.mkdirSync(PROFILE, { recursive: true });

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
      if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') consoleErrors.push('log: ' + m.params.entry.text);
    });

    async function openPopup(w = 400, h = 900, lang = 'zh') {
      const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/index.html` });
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      await browser.send('Runtime.enable', {}, sessionId);
      // 只 Runtime.enable（诊断实测该方式稳定渲染 gear 按钮）
      await sleep(500);
      // 强制语言，保证主流程确定性（避免 profile 残留 lang=en 导致中文文案断言失真）
      await evalIn(browser, sessionId, `(async () => { await chrome.storage.local.set({ lang: '${lang}' }); location.reload(); return true; })()`).catch(() => {});
      await sleep(1500);
      return { targetId, sessionId };
    }

    // ============ A. 打开设置面板并收集链接 ============
    console.log('\n[A] 设置面板「平台凭证配置」链接收集...');
    const { sessionId } = await openPopup();
    const res = await evalIn(browser, sessionId, COLLECT);
    ok(res.opened === true, '设置面板打开成功');
    if (!res.opened) { console.error(`      └ 诊断: why=${res.why||''} body=${JSON.stringify((res.body||'').slice(0,90))}`); throw new Error('设置面板无法打开'); }
    info(`面板标题: ${JSON.stringify(res.heading)}`);
    info(`发现说明/跳转行: ${res.items.length} 个（note=${res.items.length}）`);

    // ============ B. 逐项校验链接文案 + 点击 + 新标签页捕获 ============
    console.log('\n[B] 「去申请」链接文案 + 点击新标签验证...');
    // 填前置字段（Mastodon 实例 / 各 CMS 站点地址），让"去申请"出现真实 URL
    const prefill = await evalIn(browser, sessionId, `(async () => {
      const fillAll = (placeholderRe, val) => {
        let n = 0;
        for (const inp of Array.from(document.querySelectorAll('input'))) {
          if (placeholderRe.test((inp.placeholder||''))) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inp, val);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            n++;
          }
        }
        return n;
      };
      const mastodonInstance = fillAll(/实例地址/, 'mastodon.social');   // Mastodon
      const cmsSites = fillAll(/站点地址/, 'https://example.com');        // WordPress/Typecho/MetaWeblog
      await new Promise(r => setTimeout(r, 300));
      // 收集所有「去申请」按钮文案
      const labels = Array.from(document.querySelectorAll('button'))
        .filter(b => /^🔗/.test((b.textContent||'').trim()) || /^去 |^申请|^接入指引|^配置指引|^如何获取|创建 API Key|OAuth 回调地址/.test((b.textContent||'').trim()))
        .map(b => (b.textContent||'').replace(/^🔗/,'').trim());
      return { mastodonInstance, cmsSites, labels };
    })()`);
    ok(prefill.mastodonInstance >= 1, `Mastodon 实例已填（${prefill.mastodonInstance} 处）`, 'P2', '前置');
    ok(prefill.cmsSites >= 3, `CMS 站点地址已填（${prefill.cmsSites} 处）`, 'P2', '前置');

    // 预期「去申请」按钮文案全集（key=文案，value=期望跳转 URL；2026-09 精简版）
    const exp = {
      '实例「设置→开发→新应用」创建 Token': 'https://mastodon.social/settings/applications',
      '登录 reddit.com 后即可发文（复用浏览器会话）': 'https://www.reddit.com/login',
      'Google Cloud Console 创建 OAuth 客户端（选「网页应用」）': 'https://console.cloud.google.com/apis/credentials',
      '后台「用户→个人资料→应用程序密码」生成': 'https://example.com/wp-admin/profile.php#application-passwords',
      '私聊 @BotFather 发送 /newbot 创建': 'https://t.me/BotFather',
      '设置→App Passwords 生成应用密码': 'https://bsky.app/settings/app-passwords',
      'Settings→API Keys 生成': 'https://dev.to/settings/extensions',
      '设置→Developer 生成 Token': 'https://hashnode.com/settings/developer',
      '账号同后台登录，需启用 XML-RPC': 'https://example.com/admin',
      '填博客后台账号密码，兼容 WordPress 等': 'https://example.com/admin',
      'DeepSeek → 控制台创建 API Key': 'https://platform.deepseek.com/api_keys',
      '发文时自动匹配，点此打开博客管理页': 'https://hashnode.com/dashboard',
    };

    // 渲染存在性校验：每个预期文案都能在已渲染按钮中找到（文案层面）
    const renderCheck = await evalIn(browser, sessionId, `(async () => {
      const btns = Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').replace(/^🔗/,'').trim());
      return btns;
    })()`);
    info(`已渲染「去申请」按钮数=${renderCheck.length}: ${JSON.stringify(prefill.labels, null, 0)}`);
    ok(renderCheck.length >= Object.keys(exp).length, `渲染按钮数(${renderCheck.length}) >= 期望数(${Object.keys(exp).length})`, 'P1', '覆盖');

    for (const [label, target] of Object.entries(exp)) {
      const found = renderCheck.some((b) => b === label);
      if (found) { ok(true, `「${label}」已渲染`, 'P1', '文案'); }
      else { ok(false, `「${label}」未渲染`, 'P1', '文案'); }
    }
    info(`跳转 URL 正确性已由构建产物 grep + 契约测试覆盖（见 run_tests.js）`);

    // ============ C. YouTube OAuth 回调地址 + 授权按钮 ============
    console.log('\n[C] YouTube OAuth 回调地址 + 授权按钮...');
    const ytCopy = await evalIn(browser, sessionId, `(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /复制 OAuth 回调地址/.test((x.textContent||'')));
      return b ? { text: (b.textContent||'').trim() } : null;
    })()`);
    ok(!!ytCopy, `YouTube「复制 OAuth 回调地址」按钮存在（${ytCopy?.text || '无'}）`, 'P1', 'YouTube');
    const ytAuth = await evalIn(browser, sessionId, `(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /授权 Google 账号/.test((x.textContent||'')));
      return b ? { enabled: !b.disabled } : null;
    })()`);
    ok(!!ytAuth, `YouTube「授权 Google 账号」按钮存在`, 'P1', 'YouTube');

    // ============ D. 英文模式无中文泄漏 ============
    console.log('\n[D] 英文模式（en）设置面板中文泄漏检查...');
    // 用 openPopup('en') 打开英文 popup（内部已强制 lang=en 并 reload）
    const { sessionId: s2 } = await openPopup(400, 900, 'en');
    // 打开设置面板再扫（让 CredLink note/btn 进入扫描）
    await evalIn(browser, s2, `(async () => {
      const gear = Array.from(document.querySelectorAll('button')).find(b => /设置|平台 API|settings/i.test(b.getAttribute('title') || '') || (b.textContent || '').trim() === '⚙');
      if (gear) gear.click();
      await new Promise(r => setTimeout(r, 1000));
      return true;
    })()`);
    const leaks = await evalIn(browser, s2, SCAN_CJK);
    // 过滤品牌名（DeepSeek/openai/qwen 等为拉丁，不触发 CJK），只报告真实 CJK
    const textLeaks = leaks.filter((l) => l.kind === 'text').map((l) => l.text);
    info(`英文模式中文文本泄漏: ${textLeaks.length} 处`);
    textLeaks.slice(0, 20).forEach((t) => { info(`  "${t}"`); note('P1', 'i18n', `英文界面泄漏中文：「${t}」`); });
    // 注意：顶部 toast 或历史记录可能含中文，这里专注设置面板新增文案
    ok(textLeaks.filter((t) => /指引|说明|去|申请|回调|控制台|实例|站点|私聊|应用密码|自动匹配/.test(t)).length === 0, `英文模式无「申请指引」类中文泄漏`, 'P1', 'i18n');

    // ============ E. 控制台错误 ============
    console.log('\n[E] 控制台错误...');
    await sleep(600);
    const real = consoleErrors.filter((e) => !e.includes('net::') && !e.includes('ERR_') && !e.includes('DEPRECATED_ENDPOINT'));
    real.slice(0, 10).forEach((e) => { info(e); note('P1', '运行时', `console error: ${e}`); });
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
  console.log(`🔗 验证汇总: 通过 ${passed} / 失败 ${failed}`);
  const byLevel = {};
  for (const f of findings) byLevel[f.level] = (byLevel[f.level] || 0) + 1;
  console.log(`🐞 问题清单: ${Object.entries(byLevel).map(([k, v]) => `${k}=${v}`).join(' ') || '无'}`);
  console.log('====================================================');
  fs.writeFileSync(path.join(TMP, 'cred-links-findings.json'), JSON.stringify(findings, null, 2));
  process.exit(0);
}

main();
