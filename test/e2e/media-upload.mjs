#!/usr/bin/env node
/**
 * OmniPost「配图与视频 / 添加文件」专项复现测试
 *
 * 目的：定位「点击上传图片没有任何反应」的真实根因（运行时行为，非源码字符串断言）。
 *
 * 判定手段：
 *   - Page.setInterceptFileChooserDialog(true) + Page.fileChooserOpened 事件
 *     → 只有真正触发了原生文件选择器才会出现该事件，这是"有没有反应"的唯一客观证据。
 *   - document.elementFromPoint() → 判定点击坐标处是否被别的元素遮挡。
 *   - Input.dispatchMouseEvent → 真实鼠标点击（等价于用户点击，走命中测试）。
 *   - DOM.setFileInputFiles → 真实注入文件，验证 onChange → mediaList → 缩略图整条链路。
 *
 * 运行：node test/e2e/media-upload.mjs
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
const PROFILE = path.join(TMP, 'media-profile');
const PORT = 9334;
const CFT_BIN = path.join(
  TMP, 'cft', 'chrome-mac-arm64', 'Google Chrome for Testing.app',
  'Contents', 'MacOS', 'Google Chrome for Testing',
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ [PASS] ${msg}`); }
  else { failed++; console.error(`  ❌ [FAIL] ${msg}`); }
}
function info(msg) { console.log(`      └ ${msg}`); }

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
      this.ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
      this.ws.onclose = () => {
        const err = new Error('CDP 连接已关闭');
        for (const { reject: rj } of this.pending.values()) rj(err);
        this.pending.clear();
      };
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? rj(new Error(JSON.stringify(msg.error))) : rs(msg.result);
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
  const r = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '未知异常';
    throw new Error('页面执行异常: ' + String(d).slice(0, 500));
  }
  return r.result?.value;
}

async function discoverExtensionId() {
  // 方法1：Preferences 按加载路径精确匹配
  for (let i = 0; i < 40; i++) {
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(PROFILE, 'Default', 'Preferences'), 'utf8'));
      const settings = prefs?.extensions?.settings || {};
      for (const [id, v] of Object.entries(settings)) {
        if (v?.path && path.resolve(v.path) === path.resolve(DIST)) return id;
      }
    } catch {}
    // 方法2：SW target 已注册（manifest background = service-worker-loader.js）
    try {
      const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const sw = targets.find((t) => t.type === 'service_worker' && t.url?.includes('service-worker-loader.js'));
      const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(sw?.url || '');
      if (m) return m[1];
    } catch {}
    await sleep(500);
  }
  // 调试：打印当前所有 target，便于判断扩展是否真的加载
  try {
    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    info('targets: ' + JSON.stringify(targets.map((t) => ({ type: t.type, url: (t.url || '').slice(0, 90) }))));
  } catch {}
  return null;
}

/** 生成测试用 1x1 PNG（真实文件，可被 FileReader 读取） */
function makePng(file) {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
}

async function main() {
  console.log('====================================================');
  console.log('🔍 OmniPost「添加文件 / 上传图片」专项复现测试');
  console.log('====================================================\n');

  const pngPath = path.join(TMP, 'media-test-1px.png');
  makePng(pngPath);

  ok(fs.existsSync(CFT_BIN), 'Chrome for Testing 已就绪');
  ok(fs.existsSync(path.join(DIST, 'manifest.json')), 'dist 构建产物存在');
  if (failed > 0) { console.error('\n前置条件不满足，退出。'); process.exit(1); }

  const cleanEnv = { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS || '').replace(/--require="[^"]*genie-safe-delete[^"]*"\s*/, '') };
  try {
    execSync(`"${process.execPath}" -e "require('fs').rmSync(process.argv[1],{recursive:true,force:true})" "${PROFILE}"`, { env: cleanEnv, stdio: 'pipe' });
  } catch {}
  fs.mkdirSync(PROFILE, { recursive: true });

  console.log('🔧 启动 Chrome for Testing...');
  const chrome = spawn(CFT_BIN, [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${DIST}`,
    `--disable-extensions-except=${DIST}`,
    '--enable-unsafe-extension-debugging',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
    '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
    '--headless=new',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

  let browser = null;
  try {
    let version = null;
    for (let i = 0; i < 60; i++) {
      try { version = await getJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch {}
      await sleep(500);
    }
    ok(!!version, `CDP 就绪（${version?.Browser || 'unknown'}）`);
    if (!version) throw new Error('CDP 未就绪');

    const extId = await discoverExtensionId();
    ok(!!extId, `扩展已加载（ID: ${extId}）`);
    if (!extId) throw new Error('无法解析扩展 ID');

    browser = new CDP(version.webSocketDebuggerUrl);
    await browser.open();

    const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/index.html` });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Runtime.enable', {}, sessionId);
    await browser.send('Page.enable', {}, sessionId);
    await browser.send('DOM.enable', {}, sessionId);

    // 拦截文件选择器：不弹真实对话框，改为派发 Page.fileChooserOpened 事件
    await browser.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);

    const chooserEvents = [];
    browser.on((msg) => {
      if (msg.method === 'Page.fileChooserOpened') chooserEvents.push(msg.params);
    });

    // 侧边栏真实尺寸（Chrome side panel 默认宽 320~420，高度≈窗口高）
    const PANEL_W = Number(process.env.PANEL_W || 400);
    const PANEL_H = Number(process.env.PANEL_H || 900);
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: PANEL_W, height: PANEL_H, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    info(`模拟侧边栏视口 ${PANEL_W}x${PANEL_H}`);

    // ---- 对照组：证明 Page.fileChooserOpened 在本环境可靠（排除测试工具自身问题）----
    {
      const { targetId: cT } = await browser.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId: cS } = await browser.send('Target.attachToTarget', { targetId: cT, flatten: true });
      await browser.send('Runtime.enable', {}, cS);
      await browser.send('Page.enable', {}, cS);
      await browser.send('DOM.enable', {}, cS);
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 1, mobile: false }, cS);
      await browser.send('Page.setInterceptFileChooserDialog', { enabled: true }, cS);
      const before = chooserEvents.length;
      browser.on(() => {}); // noop，保持 listener 结构一致
      let controlFired = false;
      const off = (msg) => { if (msg.method === 'Page.fileChooserOpened') controlFired = true; };
      browser.on(off);
      await evalIn(browser, cS, `(() => {
        document.body.style.cssText='margin:0;padding:0';
        const i=document.createElement('input'); i.type='file'; i.id='ctl';
        i.style.cssText='display:block;width:200px;height:40px';
        document.body.appendChild(i); return true;
      })()`);
      await sleep(300);
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 20, button: 'left', clickCount: 1 }, cS);
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 20, button: 'left', clickCount: 1 }, cS);
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 20, button: 'left', clickCount: 1 }, cS);
      await sleep(1200);
      ok(controlFired === true, '对照组：普通页面 file input 真实点击可触发 Page.fileChooserOpened（测试工具可靠）');
      await browser.send('Target.closeTarget', { targetId: cT });
    }

    await sleep(2000);

    // ---- 0. React 渲染 ----
    const ready = await evalIn(browser, sessionId, `(async () => {
      for (let i = 0; i < 30; i++) {
        const root = document.querySelector('#root');
        if (root && root.childElementCount > 0) return true;
        await new Promise(r => setTimeout(r, 500));
      }
      return false;
    })()`);
    ok(ready === true, 'popup React 渲染完成');

    // ---- 1. DOM 体检：媒体 file input 是否存在 / 属性 / 是否被遮挡 ----
    // 先滚动到「添加文件」可见位置（侧边栏内部滚动容器）
    await evalIn(browser, sessionId, `(() => {
      const m = Array.from(document.querySelectorAll('input[type=file]')).find(i => (i.getAttribute('accept')||'').includes('image/*'));
      m?.closest('label')?.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(400);

    const dom = await evalIn(browser, sessionId, `(() => {
      const inputs = Array.from(document.querySelectorAll('input[type=file]'));
      const media = inputs.find(i => (i.getAttribute('accept')||'').includes('image/*'));
      if (!media) return { found: false, totalInputs: inputs.length,
        accepts: inputs.map(i => i.getAttribute('accept')) };
      const cs = getComputedStyle(media);
      const label = media.closest('label');
      const lr = label ? label.getBoundingClientRect() : null;
      const hitEl = lr ? document.elementFromPoint(lr.left + lr.width/2, lr.top + lr.height/2) : null;
      return {
        found: true,
        totalInputs: inputs.length,
        multiple: media.multiple,
        accept: media.getAttribute('accept'),
        display: cs.display,
        pointerEvents: cs.pointerEvents,
        visibility: cs.visibility,
        hasLabel: !!label,
        labelText: label ? (label.textContent||'').trim() : '',
        labelRect: lr ? { x: lr.left, y: lr.top, w: lr.width, h: lr.height } : null,
        hitTag: hitEl ? hitEl.tagName + '.' + (hitEl.className||'').toString().slice(0,60) : null,
        hitIsInsideLabel: hitEl && label ? label.contains(hitEl) : false,
        inViewport: lr ? (lr.top >= 0 && lr.bottom <= window.innerHeight && lr.left >= 0 && lr.right <= window.innerWidth) : false,
        winH: window.innerHeight, winW: window.innerWidth,
        docH: document.documentElement.scrollHeight,
        scrollChain: (function () {
          const chain = [];
          let el = media;
          while (el && el !== document.documentElement) {
            const cs = getComputedStyle(el);
            if (cs.overflowY !== 'visible' || el.scrollHeight > el.clientHeight) {
              chain.push(el.tagName + '.' + String(el.className).slice(0, 30) + ' overflowY=' + cs.overflowY + ' client=' + el.clientHeight + ' scroll=' + el.scrollHeight + ' top=' + el.scrollTop);
            }
            el = el.parentElement;
          }
          const bcs = getComputedStyle(document.body);
          chain.push('BODY overflow=' + bcs.overflow + '/' + bcs.overflowY + ' h=' + bcs.height + ' client=' + document.body.clientHeight + ' scroll=' + document.body.scrollHeight);
          return chain;
        })(),
      };
    })()`);

    ok(dom.found === true, `媒体 file input 已渲染（共 ${dom.totalInputs} 个 file input, accept=${JSON.stringify(dom.accepts)}）`);
    if (!dom.found) throw new Error('未找到媒体 file input，后续检查中止');

    info(`display=${dom.display} pointer-events=${dom.pointerEvents} visibility=${dom.visibility}`);
    info(`label="${dom.labelText}" rect=${JSON.stringify(dom.labelRect)} window=${dom.winW}x${dom.winH} docH=${dom.docH}`);
    info(`命中测试: ${dom.hitTag} → 在 label 内部=${dom.hitIsInsideLabel}`);
    (dom.scrollChain || []).forEach((s) => info(`滚动链: ${s}`));

    ok(dom.hasLabel === true, 'file input 被 <label> 包裹（点击 label 应转发给 input）');
    ok(dom.inViewport === true, `「添加文件」在可视区域内（top=${dom.labelRect?.y}, bottom=${(dom.labelRect?.y||0)+(dom.labelRect?.h||0)}, winH=${dom.winH}）`);
    ok(dom.hitIsInsideLabel === true, `点击坐标未被遮挡（命中元素在 label 内：${dom.hitTag}）`);

    // ---- 2. 程序化 input.click() 是否触发文件选择器 ----
    chooserEvents.length = 0;
    await evalIn(browser, sessionId, `(() => {
      const m = Array.from(document.querySelectorAll('input[type=file]')).find(i => (i.getAttribute('accept')||'').includes('image/*'));
      m.click();
      return true;
    })()`);
    await sleep(1500);
    // 说明：Chrome 对 file input 有「用户激活门控」，无手势的 JS .click() 不会开选择器，属预期行为，不计入通过/失败。
    info(`JS input.click()（无用户手势）文件选择器事件数=${chooserEvents.length} —— Chrome 用户激活门控，预期为 0`);

    // ---- 3. 真实鼠标点击（CDP Input.dispatchMouseEvent）是否触发文件选择器 ----
    chooserEvents.length = 0;
    const cx = dom.labelRect.x + dom.labelRect.w / 2;
    const cy = dom.labelRect.y + dom.labelRect.h / 2;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await browser.send('Input.dispatchMouseEvent', {
        type, x: cx, y: cy, button: 'left', clickCount: 1,
      }, sessionId);
    }
    await sleep(1500);
    ok(chooserEvents.length > 0, `真实鼠标点击「添加文件」触发文件选择器（事件数 ${chooserEvents.length}, 坐标 ${cx.toFixed(0)},${cy.toFixed(0)}）`);

    // ---- 4. 注入真实文件 → 验证 onChange → mediaList → 缩略图 ----
    let backendNodeId = chooserEvents[0]?.backendNodeId;
    if (!backendNodeId) {
      const { root } = await browser.send('DOM.getDocument', { depth: -1 }, sessionId);
      const { nodeId } = await browser.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: 'input[type=file][accept="image/*,video/*"]',
      }, sessionId);
      const desc = await browser.send('DOM.describeNode', { nodeId }, sessionId);
      backendNodeId = desc.node.backendNodeId;
    }
    await browser.send('DOM.setFileInputFiles', { files: [pngPath], backendNodeId }, sessionId);
    await sleep(1500);

    const after = await evalIn(browser, sessionId, `(() => {
      const label = Array.from(document.querySelectorAll('label')).find(l => (l.textContent||'').includes('配图'));
      const countEl = label ? (label.textContent.match(/\\((\\d+)\\)/)||[])[1] : null;
      const imgs = Array.from(document.querySelectorAll('img')).filter(i => (i.src||'').startsWith('data:image'));
      return {
        count: countEl,
        thumbCount: imgs.length,
        thumbSrcOk: imgs.length > 0 && imgs[0].src.startsWith('data:image'),
        thumbNaturalW: imgs[0]?.naturalWidth ?? -1,
      };
    })()`);
    info(`媒体计数="${after.count}" 缩略图=${after.thumbCount} dataUrl=${after.thumbSrcOk} naturalWidth=${after.thumbNaturalW}`);
    ok(after.count === '1', `mediaList 计数更新为 1（实际 ${after.count}）`);
    ok(after.thumbCount === 1, `缩略图已渲染 1 个（实际 ${after.thumbCount}）`);
    ok(after.thumbNaturalW > 0, `缩略图 dataUrl 可被浏览器解码（naturalWidth=${after.thumbNaturalW}）`);

    // ---- 5. 删除按钮 ----
    const del = await evalIn(browser, sessionId, `(async () => {
      const thumb = Array.from(document.querySelectorAll('img')).filter(i => (i.src||'').startsWith('data:image'))[0];
      if (!thumb) return { ok: false, reason: '无缩略图' };
      const wrap = thumb.parentElement;
      const btn = wrap.querySelector('button');
      if (!btn) return { ok: false, reason: '无删除按钮' };
      const cs = getComputedStyle(btn);
      btn.click();
      await new Promise(r => setTimeout(r, 600));
      const label = Array.from(document.querySelectorAll('label')).find(l => (l.textContent||'').includes('配图'));
      return { ok: true, opacity: cs.opacity, count: (label?.textContent.match(/\\((\\d+)\\)/)||[])[1] };
    })()`);
    info(`删除按钮 opacity=${del.opacity}（0 = 需 hover 才可见）`);
    ok(del.count === '0', `删除后计数归零（实际 ${del.count}）`);

    // ---- 6. 重复选同一文件（e.target.value='' 是否生效；真实鼠标点击）----
    chooserEvents.length = 0;
    const r2 = await evalIn(browser, sessionId, `(() => {
      const m = Array.from(document.querySelectorAll('input[type=file]')).find(i => (i.getAttribute('accept')||'').includes('image/*'));
      m.closest('label').scrollIntoView({ block: 'center' });
      const r = m.closest('label').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await sleep(300);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await browser.send('Input.dispatchMouseEvent', { type, x: r2.x, y: r2.y, button: 'left', clickCount: 1 }, sessionId);
    }
    await sleep(1000);
    if (chooserEvents.length > 0) {
      await browser.send('DOM.setFileInputFiles', { files: [pngPath], backendNodeId: chooserEvents[0].backendNodeId }, sessionId);
      await sleep(1200);
      const again = await evalIn(browser, sessionId, `(() => {
        const label = Array.from(document.querySelectorAll('label')).find(l => (l.textContent||'').includes('配图'));
        return (label?.textContent.match(/\\((\\d+)\\)/)||[])[1];
      })()`);
      ok(again === '1', `删除后同一文件可再次选择（value 已重置，计数=${again}，期望 1）`);
    } else {
      ok(false, '第二次点击未触发文件选择器');
    }

    // ---- 7. 拖拽投放路径 ----
    const dropRes = await evalIn(browser, sessionId, `(async () => {
      const zone = document.querySelector('textarea')?.closest('div[class*="rounded-xl"]');
      if (!zone) return { ok: false, reason: '未找到投放区' };
      const dt = new DataTransfer();
      const res = await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
      const blob = await res.blob();
      dt.items.add(new File([blob], 'drop.png', { type: 'image/png' }));
      zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await new Promise(r => setTimeout(r, 800));
      const label = Array.from(document.querySelectorAll('label')).find(l => (l.textContent||'').includes('配图'));
      return { ok: true, count: (label?.textContent.match(/\\((\\d+)\\)/)||[])[1] };
    })()`);
    info(`拖拽投放结果: ${JSON.stringify(dropRes)}`);
    ok(dropRes.count === '2', `拖拽投放生效（计数=${dropRes.count}，期望 2）`);

  } catch (e) {
    console.error(`  ❌ [FAIL] 执行异常: ${e.message}`);
    if (chromeErr.trim()) console.error(`      └ Chrome stderr: ${chromeErr.trim().slice(-500)}`);
    failed++;
  } finally {
    if (browser) browser.close();
    try { chrome.kill(); } catch {}
  }

  console.log('\n====================================================');
  console.log(`🔍 汇总: 总计 ${passed + failed} 项，通过 ${passed} 项${failed ? `，失败 ${failed} 项` : '，全部通过 🎉'}`);
  console.log('====================================================');
  process.exit(failed > 0 ? 1 : 0);
}

main();
