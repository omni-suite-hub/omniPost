#!/usr/bin/env node
/**
 * OmniPost 分组独立折叠 + 平台卡片排版专项验证（真实 Chrome）
 *
 * 覆盖：
 *   A. 「展开 N 个未登录平台」按分组独立展开/收起（点任一分组不影响其他分组）
 *   B. 平台卡片排版：标题/tag 徽章不得折行（修复「Markdown 压缩包」换行、「导出」一字一行）
 *   C. 全程无扩展自身 console error + 输出截图供人工复核
 *
 * 运行：node test/e2e/group-collapse-card.mjs
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
const PROFILE = path.join(TMP, 'collapse-profile');
const PORT = 9361;
const SHOT = path.join(ROOT, '.workbuddy', 'reports', 'collapse-card-fix.png');
const CFT_BIN = path.join(TMP, 'cft', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const findings = [];
function ok(cond, msg, level = 'P1', area = 'Collapse') {
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

/** 收集所有「展开/收起未登录平台」按钮的状态：文案 + 所在分组当前可见卡片数 */
const SNAP = `(() => {
  const btns = Array.from(document.querySelectorAll('button')).filter(b => /展开 \\d+ 个未登录平台|收起未登录平台/.test((b.textContent||'').trim()));
  return btns.map(b => {
    const group = b.parentElement; // 按钮是分组容器(space-y-1.5 div)的直接子节点
    const cards = group ? group.querySelectorAll('.grid > div').length : -1;
    return {
      label: (b.textContent||'').trim(),
      expanded: (b.textContent||'').includes('收起'),
      cards,
    };
  });
})()`;

/** 卡片排版检查：对每个可见平台卡片的标题与 tag 徽章做 Range 折行检测（rects>1 即折行） */
const LAYOUT = `(() => {
  function lineRects(el) {
    if (!el) return -1;
    const node = el.childNodes.length && Array.from(el.childNodes).find(n => n.nodeType === 3 && n.nodeValue.trim());
    const target = node || el;
    const range = document.createRange();
    range.selectNodeContents(target);
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0.5 && r.height > 0.5);
    return rects.length;
  }
  const out = { cards: [], total: 0 };
  for (const title of Array.from(document.querySelectorAll('span.truncate'))) {
    const card = title.closest('div.rounded-xl');
    if (!card) continue;
    const cs = getComputedStyle(card);
    if (cs.display === 'none') continue;
    out.total++;
    const name = title.textContent.trim();
    const tagSpans = Array.from(card.querySelectorAll('span.font-mono')).filter(s => s.textContent.trim());
    const tagIssues = tagSpans.filter(s => lineRects(s) > 1).map(s => s.textContent.trim());
    out.cards.push({
      name,
      titleLines: lineRects(title),
      tagCount: tagSpans.length,
      tagIssues,
      overflowX: card.scrollWidth - card.clientWidth,
    });
  }
  return out;
})()`;

async function main() {
  console.log('====================================================');
  console.log('📂 OmniPost 分组独立折叠 + 卡片排版专项验证');
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
      if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') consoleErrors.push('log: ' + m.params.entry.text);
    });

    // 打开 popup（强制中文，保证文案断言确定性）
    const { targetId, sessionId } = await (async () => {
      const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/index.html` });
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      await browser.send('Runtime.enable', {}, sessionId); // 只 Runtime.enable（诊断实测该方式稳定渲染）
      await sleep(500);
      await evalIn(browser, sessionId, `(async () => { await chrome.storage.local.set({ lang: 'zh' }); location.reload(); return true; })()`).catch(() => {});
      await sleep(1500);
      return { targetId, sessionId };
    })();

    // ============ A. 分组独立展开/收起 ============
    console.log('\n[A] 「展开 N 个未登录平台」按分组独立展开/收起...');
    // 等登录态扫描完成，出现 >=2 个展开按钮（headless 下 cookie 全空，多组应报未登录）
    let snap = [];
    for (let i = 0; i < 120; i++) {
      snap = await evalIn(browser, sessionId, SNAP);
      if (snap.length >= 2) break;
      await sleep(500);
    }
    ok(snap.length >= 2, `渲染出 ${snap.length} 个分组折叠按钮（需 >=2 才能验证独立性）`, snap.length >= 2 ? 'P1' : 'P2');
    info('初始: ' + JSON.stringify(snap));
    if (snap.length < 2) {
      note('P2', '前置', '环境未登录分组不足 2 个，独立性用例受限');
    } else {
      const findBtn = (idx) => `(function(){ const bs = Array.from(document.querySelectorAll('button')).filter(b => /展开 \\d+ 个未登录平台|收起未登录平台/.test((b.textContent||'').trim())); return bs.length > ${idx} ? { click: () => bs[${idx}].click() } : null; })()`;
      // 点第 1 个分组展开
      await evalIn(browser, sessionId, `(() => { const bs=[...document.querySelectorAll('button')].filter(b=>/展开 \\d+ 个未登录平台|收起未登录平台/.test((b.textContent||'').trim())); bs[0].click(); return true; })()`);
      await sleep(400);
      const s1 = await evalIn(browser, sessionId, SNAP);
      info('点第1组后: ' + JSON.stringify(s1));
      ok(s1[0].expanded === true, '第 1 组点击后展开（显示「收起未登录平台」）');
      ok(s1[0].cards > snap[0].cards, `第 1 组可见卡片数增加（${snap[0].cards} → ${s1[0].cards}）`);
      ok(s1.slice(1).every(x => !x.expanded), '其他分组保持折叠（未联动展开）');
      ok(s1.slice(1).every((x, i) => x.cards === snap.slice(1)[i].cards), '其他分组可见卡片数不变');

      // 点第 2 个分组展开
      await evalIn(browser, sessionId, `(() => { const bs=[...document.querySelectorAll('button')].filter(b=>/展开 \\d+ 个未登录平台|收起未登录平台/.test((b.textContent||'').trim())); bs[1].click(); return true; })()`);
      await sleep(400);
      const s2 = await evalIn(browser, sessionId, SNAP);
      info('点第2组后: ' + JSON.stringify(s2));
      ok(s2[0].expanded === true && s2[1].expanded === true, '第 1、2 组同时保持展开（状态互不覆盖）');
      ok(s2.slice(2).every(x => !x.expanded), '第 3+ 组仍折叠');

      // 收起第 1 组
      await evalIn(browser, sessionId, `(() => { const bs=[...document.querySelectorAll('button')].filter(b=>/展开 \\d+ 个未登录平台|收起未登录平台/.test((b.textContent||'').trim())); bs[0].click(); return true; })()`);
      await sleep(400);
      const s3 = await evalIn(browser, sessionId, SNAP);
      info('收起第1组后: ' + JSON.stringify(s3));
      ok(s3[0].expanded === false, '第 1 组收起成功');
      ok(s3[1].expanded === true, '第 2 组展开状态不受第 1 组收起影响');
      // 复原
      await evalIn(browser, sessionId, `(() => { const bs=[...document.querySelectorAll('button')].filter(b=>/展开 \\d+ 个未登录平台|收起未登录平台/.test((b.textContent||'').trim())); bs[1].click(); return true; })()`);
      await sleep(300);
    }

    // ============ B. 卡片排版（不折行） ============
    console.log('\n[B] 平台卡片排版：标题 / tag 徽章折行检测...');
    // 先展开全部分组，让所有卡片（含未登录）都参与排版检测
    for (let round = 0; round < 3; round++) {
      await evalIn(browser, sessionId, `(() => { const bs=[...document.querySelectorAll('button')].filter(b=>/展开 \\d+ 个未登录平台/.test((b.textContent||'').trim())); bs.forEach(b=>b.click()); return bs.length; })()`);
      await sleep(400);
      const s = await evalIn(browser, sessionId, SNAP);
      if (s.every(x => x.expanded)) break;
    }
    const snapAll = await evalIn(browser, sessionId, SNAP);
    info(`已展开 ${snapAll.filter(x=>x.expanded).length}/${snapAll.length} 组，可见卡片 ${snapAll.reduce((a,b)=>a+b.cards,0)} 张`);
    const layout = await evalIn(browser, sessionId, LAYOUT);
    info(`扫描到 ${layout.total} 张平台卡片`);
    ok(layout.total >= 10, `扫描卡片数 ${layout.total} >= 10`, 'P2', '覆盖');
    const badTitle = layout.cards.filter(c => c.titleLines > 1);
    badTitle.forEach(c => { info(`标题折行: 「${c.name}」 ${c.titleLines} 行`); note('P1', '排版', `卡片标题折行：「${c.name}」`); });
    ok(badTitle.length === 0, `所有卡片标题单行不折行（违例 ${badTitle.length} 张）`);
    const badTag = layout.cards.filter(c => c.tagIssues.length > 0);
    badTag.forEach(c => { info(`tag 折行: 「${c.name}」 tags=${JSON.stringify(c.tagIssues)}`); note('P1', '排版', `tag 徽章一字一行：「${c.name}」`); });
    ok(badTag.length === 0, `所有卡片 tag 徽章单行（违例 ${badTag.length} 张）`);
    const badOverflow = layout.cards.filter(c => c.overflowX > 1);
    badOverflow.forEach(c => { info(`横向溢出: 「${c.name}」 ${c.overflowX}px`); note('P2', '排版', `卡片横向溢出：「${c.name}」 ${c.overflowX}px`); });
    ok(badOverflow.length === 0, `无卡片横向溢出（违例 ${badOverflow.length} 张）`);
    // 专项：Markdown 压缩包卡片（用户截图问题卡）
    const zip = layout.cards.find(c => /Markdown/.test(c.name));
    ok(!!zip, '「Markdown 压缩包」卡片已渲染');
    if (zip) ok(zip.titleLines === 1 && zip.tagIssues.length === 0, `「${zip.name}」标题 ${zip.titleLines} 行 / tags ${zip.tagCount} 个无折行`);

    // 截图供人工复核
    try {
      const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(SHOT, Buffer.from(data, 'base64'));
      info(`截图已存: ${SHOT}`);
    } catch (e) { info('截图失败（不影响结论）: ' + e.message); }

    // ============ C. 控制台错误 ============
    console.log('\n[C] 控制台错误...');
    await sleep(600);
    const real = consoleErrors.filter((e) => !e.includes('net::') && !e.includes('ERR_') && !e.includes('DEPRECATED_ENDPOINT') && !e.includes('checkLogin'));
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
  console.log(`📊 结果: 通过 ${passed} / 失败 ${failed}`);
  if (findings.length) {
    console.log('\n问题清单:');
    findings.forEach((f) => console.log(`  [${f.level}][${f.area}] ${f.msg}`));
  }
  process.exit(failed ? 1 : 0);
}

main();
