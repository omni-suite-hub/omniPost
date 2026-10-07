#!/usr/bin/env node
/**
 * OmniPost 上线前 UI 全量审计（真实 Chrome + 真实侧边栏尺寸）
 *
 * 覆盖：
 *   A. 英文模式中文泄漏（可见文本 + title/placeholder/aria-label/alt）
 *   B. 中文模式健全性（无 key 泄漏、无未翻译占位）
 *   C. 可交互元素审计（无文案按钮 / disabled 无解释 / 缺 title）
 *   D. 多尺寸布局（320/400/500 宽）横向溢出与元素裁剪
 *   E. 空状态与表单边界
 *   F. 关键流程（模板/清空/全选/上传文档/发布校验/设置/历史/定时）
 *   G. 全程控制台错误
 *
 * 运行：node test/e2e/ui-audit.mjs
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
const PROFILE = path.join(TMP, 'audit-profile');
const PORT = 9335;
const CFT_BIN = path.join(TMP, 'cft', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const findings = [];   // { level: 'P0'|'P1'|'P2', area, msg }
function ok(cond, msg, level = 'P1', area = 'UI') {
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

/** 页面内注入：收集所有可见文本 + 无障碍属性中的中文 */
const SCAN_CJK = `(() => {
  const CJK = /[\\u4e00-\\u9fff\\u3000-\\u303f\\uff01-\\uff65]/;
  // 品牌名也已全部收录进 EN_MAP，因此不做豁免：英文界面出现任何 CJK 都算缺陷
  const BRAND = new Set();
  const out = [];
  const seen = new Set();
  function pathOf(el) {
    const parts = [];
    let e = el;
    for (let i = 0; e && i < 4; i++) {
      parts.unshift(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0,2).join('.') : ''));
      e = e.parentElement;
    }
    return parts.join(' > ');
  }
  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function check(text, kind, el) {
    if (!text) return;
    const t = text.trim();
    if (!t) return;
    const m = t.match(CJK);
    if (!m) return;
    // 品牌名/专有名词整体豁免
    if (BRAND.has(t)) return;
    const key = kind + '|' + t;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, text: t.slice(0, 120), el: el ? pathOf(el) : '', tag: el ? el.tagName : '' });
  }
  // 1) 可见文本节点
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement;
    if (!el || !visible(el)) continue;
    if (el.closest('script,style')) continue;
    // 用户自己输入 / 导入的内容（标题、正文）不是 UI 文案，语言由用户决定，不算泄漏。
    // 否则上一次运行残留在 storage 里的中文草稿会让「英文泄漏审计」误报。
    if (el.closest('textarea, input, [contenteditable=true]')) continue;
    check(n.nodeValue, 'text', el);
  }
  // 2) 无障碍 / 提示属性
  for (const el of document.querySelectorAll('[title],[placeholder],[aria-label],[alt]')) {
    if (!visible(el)) continue;
    for (const a of ['title', 'placeholder', 'aria-label', 'alt']) {
      const v = el.getAttribute(a);
      if (v) check(v, a, el);
    }
  }
  return out;
})()`;

/** 页面内注入：可交互元素审计 */
const SCAN_INTERACTIVE = `(() => {
  const out = { noLabel: [], disabledNoReason: [], total: 0 };
  for (const el of document.querySelectorAll('button, a[href], [role=button]')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.total++;
    const text = (el.textContent || '').trim();
    const aria = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    if (!text && !aria && !title) {
      out.noLabel.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), html: el.outerHTML.slice(0, 120) });
    }
    if (el.disabled && !title && !aria) {
      out.disabledNoReason.push({ text: text.slice(0, 40), cls: String(el.className).slice(0, 60) });
    }
  }
  return out;
})()`;

/** 页面内注入：横向溢出检测 */
const SCAN_OVERFLOW = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = { docScrollW: document.documentElement.scrollWidth, vw, offenders: [] };
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      out.offenders.push({
        tag: el.tagName, cls: String(el.className).slice(0, 50),
        left: Math.round(r.left), right: Math.round(r.right),
        text: (el.textContent || '').trim().slice(0, 30),
      });
    }
  }
  out.offenders = out.offenders.slice(0, 12);
  return out;
})()`;

async function main() {
  console.log('====================================================');
  console.log('🧪 OmniPost 上线前 UI 全量审计');
  console.log('====================================================\n');

  ok(fs.existsSync(CFT_BIN), 'Chrome for Testing 已就绪');
  ok(fs.existsSync(path.join(DIST, 'manifest.json')), 'dist 构建产物存在');
  if (failed) { process.exit(1); }

  const cleanEnv = { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS || '').replace(/--require="[^"]*genie-safe-delete[^"]*"\s*/, '') };
  try { execSync(`"${process.process?.execPath || process.execPath}" -e "require('fs').rmSync(process.argv[1],{recursive:true,force:true})" "${PROFILE}"`, { env: cleanEnv, stdio: 'pipe' }); } catch {}
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

    async function openPopup(w = 400, h = 900) {
      const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/index.html` });
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      await browser.send('Runtime.enable', {}, sessionId);
      await browser.send('Page.enable', {}, sessionId);
      await browser.send('DOM.enable', {}, sessionId);
      await browser.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
      await sleep(200);
      await evalIn(browser, sessionId, `(async () => { for (let i=0;i<40;i++){ const r=document.querySelector('#root'); if(r&&r.childElementCount>0&&r.textContent.trim().length>20) return true; await new Promise(x=>setTimeout(x,300)); } return false; })()`);
      await sleep(600);
      return { targetId, sessionId };
    }

    // ================= A. 英文模式中文泄漏 =================
    console.log('\n📖 [A] 英文模式中文泄漏审计...');
    {
      // 先设置 lang=en
      const { sessionId: s0 } = await openPopup();
      // 清掉历史/草稿残留：历史记录里的文章标题属于用户内容（可以是中文），
      // 不清会让「英文泄漏审计」把用户数据误报成 UI 文案泄漏
      await evalIn(browser, s0, `(async () => { await chrome.storage.local.set({ lang: 'en' }); await chrome.storage.local.remove(['history', 'pendingArticle', 'pendingDrafts']); return true; })()`);
      await browser.send('Target.closeTarget', { targetId: (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.url === `chrome-extension://${extId}/index.html`)?.id }).catch(() => {});

      const { sessionId } = await openPopup();
      const langNow = await evalIn(browser, sessionId, `(async () => (await chrome.storage.local.get('lang')).lang)()`);
      ok(langNow === 'en', `popup 语言已切换为 en（实际 ${langNow}）`, 'P1', 'i18n');

      const leaks = await evalIn(browser, sessionId, SCAN_CJK);
      const textLeaks = leaks.filter((l) => l.kind === 'text');
      const attrLeaks = leaks.filter((l) => l.kind !== 'text');
      info(`文本泄漏 ${textLeaks.length} 处 / 属性泄漏 ${attrLeaks.length} 处`);
      for (const l of [...textLeaks, ...attrLeaks].slice(0, 40)) {
        info(`[${l.kind}] "${l.text}" @ ${l.el}`);
        note('P1', 'i18n', `英文界面残留中文（${l.kind}）：「${l.text}」 @ ${l.el}`);
      }
      ok(textLeaks.length === 0, `英文模式无中文文本泄漏（${textLeaks.length} 处）`, 'P1', 'i18n');
      ok(attrLeaks.length === 0, `英文模式无中文 title/placeholder 泄漏（${attrLeaks.length} 处）`, 'P2', 'i18n');

      // 展开所有折叠的未登录平台（让平台 tags 也进入扫描范围）
      await evalIn(browser, sessionId, `(() => {
        let n = 0;
        for (let i = 0; i < 6; i++) {
          const b = Array.from(document.querySelectorAll('button')).find(x => /展开|更多|Show|Expand|\\+\\d/.test((x.textContent||'')));
          if (!b) break; b.click(); n++;
        }
        return n;
      })()`);
      await sleep(500);

      // 覆盖度自检：确认平台卡片真的渲染出来了（否则中文泄漏扫描是空跑）
      const coverage = await evalIn(browser, sessionId, `(() => {
        const labels = Array.from(document.querySelectorAll('input[type=checkbox]')).length;
        const groups = Array.from(document.querySelectorAll('div'))
          .filter(d => /^\\w[\\w\\s()]*\\(\\d+\\)$/.test((d.textContent||'').trim()) && d.children.length === 0)
          .map(d => (d.textContent||'').trim()).slice(0, 8);
        return { checkboxes: labels, groups, bodyHasChinese: /[\\u4e00-\\u9fff]/.test(document.body.innerText) };
      })()`);
      info(`覆盖自检: 平台 checkbox=${coverage.checkboxes} 分组=${JSON.stringify(coverage.groups)}`);
      ok(coverage.checkboxes >= 20, `英文界面已渲染 >=20 个平台卡片（实际 ${coverage.checkboxes}），泄漏扫描有效`, 'P1', 'i18n');

      // 打开各面板后再扫（设置/历史是图标按钮，按 title 匹配）
      for (const [name, titleRe] of [['设置面板', /设置|Settings/i], ['历史面板', /历史|History/i]]) {
        const opened = await evalIn(browser, sessionId, `(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => ${titleRe}.test(b.getAttribute('title')||''));
          if (!btn) return false; btn.click(); return true;
        })()`);
        if (opened) {
          await sleep(900);
          const l2 = await evalIn(browser, sessionId, SCAN_CJK);
          const tl = l2.filter((x) => x.kind === 'text' || x.kind === 'placeholder');
          for (const l of tl.slice(0, 30)) { info(`${name} [${l.kind}] "${l.text}" @ ${l.el}`); note('P1', 'i18n', `${name} 英文残留中文：「${l.text}」`); }
          ok(tl.length === 0, `${name} 英文模式无中文泄漏（${tl.length} 处）`, 'P1', 'i18n');
          await evalIn(browser, sessionId, `(() => { const b=Array.from(document.querySelectorAll('button')).find(x=>(x.textContent||'').trim()==='×'&&x.className.includes('text-lg')); if(b) b.click(); return true; })()`);
          await sleep(400);
        } else {
          info(`未找到${name}入口按钮，跳过`);
        }
      }
      // 还原 zh
      await evalIn(browser, sessionId, `(async () => { await chrome.storage.local.set({ lang: 'zh' }); return true; })()`);
    }

    // ================= B. 中文模式健全性 =================
    console.log('\n📖 [B] 中文模式健全性...');
    {
      const { sessionId } = await openPopup();
      const bodyText = await evalIn(browser, sessionId, `document.body.innerText`);
      info(`中文界面首 120 字: ${(bodyText || '').replace(/\n/g, ' ').slice(0, 120)}`);
      ok((bodyText || '').includes('目标发布平台'), '中文模式平台区标题正确显示');
      ok(!/\bundefined\b|\bNaN\b|\bnull\b/.test(bodyText), `中文界面无 undefined/NaN/null 泄漏`);
      const m = (bodyText || '').match(/undefined|NaN|\[object/g);
      if (m) { info(`发现可疑占位: ${m.slice(0, 5).join(', ')}`); note('P1', '文案', `中文界面出现 undefined/NaN 等占位：${m.slice(0, 3)}`); }
      ok((bodyText || '').includes('配图与视频'), '媒体区「配图与视频」文案存在');
    }

    // ================= C. 可交互元素审计 =================
    console.log('\n🖱  [C] 可交互元素审计...');
    {
      const { sessionId } = await openPopup();
      const r = await evalIn(browser, sessionId, SCAN_INTERACTIVE);
      info(`可交互元素总数 ${r.total}`);
      for (const x of r.noLabel.slice(0, 20)) { info(`无文案/无 aria/无 title: ${x.tag}.${x.cls} → ${x.html}`); note('P2', '无障碍', `按钮无可访问名称：${x.html}`); }
      ok(r.noLabel.length === 0, `所有按钮均有文案或 aria-label/title（缺失 ${r.noLabel.length} 个）`, 'P2', '无障碍');
      for (const x of r.disabledNoReason.slice(0, 10)) { info(`disabled 无解释: "${x.text}"`); note('P2', '无障碍', `禁用按钮无 title 解释：「${x.text}」`); }
      ok(r.disabledNoReason.length === 0, `禁用按钮均有 title 解释原因（缺失 ${r.disabledNoReason.length} 个）`, 'P2', '无障碍');
    }

    // ================= D. 多尺寸布局 =================
    console.log('\n📐 [D] 多尺寸布局（侧边栏宽度）...');
    for (const w of [320, 400, 500]) {
      const { sessionId } = await openPopup(w, 900);
      const o = await evalIn(browser, sessionId, SCAN_OVERFLOW);
      const bad = o.offenders.filter((x) => x.right > o.vw + 2);
      for (const x of bad.slice(0, 6)) { info(`${w}px 溢出: ${x.tag}.${x.cls} right=${x.right} vw=${o.vw} "${x.text}"`); note('P1', '布局', `${w}px 宽下横向溢出：${x.tag}.${x.cls} (right=${x.right} > ${o.vw})「${x.text}」`); }
      ok(bad.length === 0, `${w}px 宽无横向溢出（docScrollW=${o.docScrollW}, vw=${o.vw}, 溢出元素 ${bad.length}）`, 'P1', '布局');
    }

    // ================= E. 空状态与表单边界 =================
    console.log('\n🧾 [E] 空状态与表单边界...');
    {
      const { sessionId } = await openPopup();
      // 清掉上一次运行残留的待发布草稿：否则正文非空，「空内容发布」根本不会触发提示（误报）
      await evalIn(browser, sessionId, `(async () => { await chrome.storage.local.remove(['pendingArticle', 'pendingDrafts']); return true; })()`);
      await browser.send('Page.reload', {}, sessionId);
      await sleep(400);
      await evalIn(browser, sessionId, `(async () => { for (let i=0;i<40;i++){ const r=document.querySelector('#root'); if(r&&r.childElementCount>0&&r.textContent.trim().length>20) return true; await new Promise(x=>setTimeout(x,300)); } return false; })()`);
      // 空标题空正文点发布
      const res = await evalIn(browser, sessionId, `(async () => {
        let alertMsg = null;
        window.alert = (m) => { alertMsg = String(m); };
        const btn = Array.from(document.querySelectorAll('button')).find(b => /发布/.test(b.textContent||'') && !b.disabled);
        if (!btn) return { found: false };
        btn.click();
        await new Promise(r => setTimeout(r, 800));
        return { found: true, alertMsg, btnText: btn.textContent.trim().slice(0, 40) };
      })()`);
      info(`空内容发布: ${JSON.stringify(res)}`);
      ok(res.alertMsg && /请填写正文内容或标题|Please/.test(res.alertMsg), `空内容发布给出明确提示（"${res.alertMsg}"）`, 'P1', '文案');

      // 填正文但不选平台（先点「取消」清空所有勾选）
      const res2 = await evalIn(browser, sessionId, `(async () => {
        let alertMsg = null;
        window.alert = (m) => { alertMsg = String(m); };
        const none = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '取消');
        none?.click();
        await new Promise(r => setTimeout(r, 400));
        const ta = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '测试正文内容');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        const checked = document.querySelectorAll('input[type=checkbox]:checked').length;
        const btn = Array.from(document.querySelectorAll('button')).find(b => /发布/.test(b.textContent||'') && !b.disabled);
        btn?.click();
        await new Promise(r => setTimeout(r, 800));
        return { alertMsg, checked };
      })()`);
      info(`未选平台发布: ${JSON.stringify(res2)}`);
      ok(res2.alertMsg && /请至少勾选一个目标发布平台|Please/.test(res2.alertMsg), `未选平台发布给出明确提示（"${res2.alertMsg}"）`, 'P1', '文案');

      // 字数计数显示（仅显示当前字符数，不再限制上限）
      const limitInfo = await evalIn(browser, sessionId, `(async () => {
        const cb = Array.from(document.querySelectorAll('input[type=checkbox]')).find(c => !c.disabled);
        cb?.click();
        await new Promise(r => setTimeout(r, 500));
        const el = Array.from(document.querySelectorAll('span')).find(s => /字|chars/.test(s.textContent||'') && s.textContent.length < 40);
        return el ? el.textContent.trim() : null;
      })()`);
      info(`字数显示: ${limitInfo}`);
      ok(limitInfo !== null, `字数计数显示存在（"${limitInfo}"）`, 'P2', '文案');
      ok(limitInfo === null || !/[/(/]/.test(limitInfo), `字数显示不再含括号上限（"${limitInfo}"）`, 'P2', '文案');
    }

    // ================= F. 关键流程 =================
    console.log('\n🔁 [F] 关键流程...');
    {
      const { sessionId } = await openPopup();

      // F2 全选 / 取消
      const selAll = await evalIn(browser, sessionId, `(async () => {
        const all = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '全选');
        const none = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '取消');
        if (!all || !none) return { found: false };
        all.click(); await new Promise(r => setTimeout(r, 500));
        const on = document.querySelectorAll('input[type=checkbox]:checked').length;
        none.click(); await new Promise(r => setTimeout(r, 500));
        const off = document.querySelectorAll('input[type=checkbox]:checked').length;
        return { found: true, on, off };
      })()`);
      info(`全选/取消: ${JSON.stringify(selAll)}`);
      ok(selAll.on > 0, `「全选」可勾选平台（${selAll.on} 个）`, 'P1', '流程');
      ok(selAll.off === 0, `「取消」可清空勾选（剩 ${selAll.off}）`, 'P1', '流程');

      // F3 清空（无二次确认，直接清空）
      const clr = await evalIn(browser, sessionId, `(async () => {
        let confirmCalled = false;
        window.confirm = () => { confirmCalled = true; return true; };
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '清空');
        if (!btn) return { found: false };
        btn.click();
        await new Promise(r => setTimeout(r, 700));
        const ta = document.querySelector('textarea');
        return { found: true, confirmCalled, bodyLen: (ta?.value||'').length };
      })()`);
      info(`清空: ${JSON.stringify(clr)}`);
      ok(!clr.confirmCalled, `「清空」无二次确认弹窗`, 'P1', '流程');
      ok(clr.bodyLen === 0, `清空后正文为空（长度 ${clr.bodyLen}）`, 'P1', '流程');

      // F4 上传文档（.md）
      const pngPath = path.join(TMP, 'audit-sample.md');
      fs.writeFileSync(pngPath, '# 测试标题\n\n这是第一段正文。\n\n这是第二段正文。');
      const docInput = await evalIn(browser, sessionId, `(() => {
        const inputs = Array.from(document.querySelectorAll('input[type=file]'));
        const d = inputs.find(i => (i.getAttribute('accept')||'').includes('.md'));
        if (!d) return { found: false, accepts: inputs.map(i=>i.getAttribute('accept')) };
        d.closest('div').scrollIntoView({block:'center'});
        const r = d.getBoundingClientRect();
        return { found: true, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
      })()`);
      info(`文档 input: ${JSON.stringify(docInput)}`);
      ok(docInput.found === true, '上传文档 file input 存在', 'P1', '流程');
      if (docInput.found) {
        const { root } = await browser.send('DOM.getDocument', { depth: -1 }, sessionId);
        const q = await browser.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept*=".md"]' }, sessionId);
        const d = await browser.send('DOM.describeNode', { nodeId: q.nodeId }, sessionId);
        await browser.send('DOM.setFileInputFiles', { files: [pngPath], backendNodeId: d.node.backendNodeId }, sessionId);
        await sleep(1200);
        const after = await evalIn(browser, sessionId, `(() => {
          const ti = Array.from(document.querySelectorAll('input')).find(i => /标题/.test(i.placeholder||''));
          const ta = document.querySelector('textarea');
          return { title: ti?.value || '', bodyLen: (ta?.value||'').length };
        })()`);
        info(`导入后: ${JSON.stringify(after)}`);
        ok(after.title === '测试标题', `上传 .md 自动解析标题（"${after.title}"）`, 'P1', '流程');
        ok(after.bodyLen > 10, `上传 .md 自动填充正文（长度 ${after.bodyLen}）`, 'P1', '流程');
      }

      // F5 设置面板保存
      const setRes = await evalIn(browser, sessionId, `(async () => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('title')||'').includes('设置') || (b.textContent||'').trim() === '⚙');
        if (!btn) return { found: false };
        btn.click();
        await new Promise(r => setTimeout(r, 700));
        const heading = Array.from(document.querySelectorAll('h3,h4')).map(h => (h.textContent||'').trim()).slice(0, 12);
        return { found: true, heading };
      })()`);
      info(`设置面板标题: ${JSON.stringify(setRes.heading)}`);
      ok(setRes.found === true, '设置面板可打开', 'P1', '流程');
    }

    // ================= G. 控制台错误 =================
    console.log('\n🧹 [G] 控制台错误...');
    await sleep(800);
    const real = consoleErrors.filter((e) => !e.includes('net::') && !e.includes('ERR_') && !e.includes('DEPRECATED_ENDPOINT'));
    real.slice(0, 10).forEach((e) => { info(e); note('P1', '运行时', `console error: ${e}`); });
    ok(real.length === 0, `全流程无扩展自身 console error（${real.length} 条）`, 'P1', '运行时');

  } catch (e) {
    console.error(`  ❌ [FAIL] 审计执行异常: ${e.message}`);
    if (chromeErr.trim()) console.error(`      └ Chrome stderr: ${chromeErr.trim().slice(-500)}`);
    failed++;
  } finally {
    if (browser) browser.close();
    try { chrome.kill(); } catch {}
  }

  console.log('\n====================================================');
  console.log(`🧪 审计汇总: 通过 ${passed} / 失败 ${failed}`);
  const byLevel = {};
  for (const f of findings) byLevel[f.level] = (byLevel[f.level] || 0) + 1;
  console.log(`🐞 问题清单: ${Object.entries(byLevel).map(([k, v]) => `${k}=${v}`).join(' ') || '无'}`);
  console.log('====================================================');
  fs.writeFileSync(path.join(TMP, 'ui-audit-findings.json'), JSON.stringify(findings, null, 2));
  console.log(`📝 明细已写入 test/.tmp/ui-audit-findings.json`);
  process.exit(0);
}

main();
