/**
 * OmniPost Local Bridge —— CLI / MCP 与扩展之间的本地 HTTP 通道（真实实现）
 *
 * 通信模型：
 *   1. CLI 命令 / MCP 工具调用 注册命令 → bridge server（127.0.0.1:18432）挂起等待
 *   2. 扩展 background 用 alarms 每 30s 轮询 GET /omnipost/poll 取走命令
 *   3. 扩展处理（checkLogin / 建草稿等）后 POST /omnipost/result 回写
 *   4. bridge server resolve 等待中的调用方（CLI 打印 / MCP 回给客户端）
 *
 * 安全：
 *   - 仅监听 127.0.0.1（本机回环）
 *   - token 首次交换：扩展轮询带头 X-Omnipost-Token → server 持久化到 ~/.omnipost/token
 *   - POST /omnipost/result 必须携带匹配 token，防止任意进程伪造结果
 *   - 命令只触发"建草稿/查状态"，不直接发布，风险可控
 *
 * 纯 Node ESM，零依赖；单元测试可直接真实起 server 验证。
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const BRIDGE_PORT = 18432;
export const HOME_DIR = path.join(os.homedir(), '.omnipost');
export const TOKEN_FILE = path.join(HOME_DIR, 'token');

/** 与扩展侧一致的 26 平台清单（CLI platforms / MCP list_platforms 共用）。 */
export const PLATFORMS = [
  // —— 国内主流 ——
  { id: 'weibo', name: '微博', region: 'domestic', route: 'session', types: ['text', 'image', 'video'] },
  { id: 'xiaohongshu', name: '小红书', region: 'domestic', route: 'session', types: ['image', 'video', 'text'] },
  { id: 'bilibili', name: '哔哩哔哩', region: 'domestic', route: 'session', types: ['video', 'image', 'text'] },
  { id: 'zhihu', name: '知乎', region: 'domestic', route: 'session', types: ['article', 'text', 'image'] },
  { id: 'juejin', name: '掘金', region: 'domestic', route: 'session', types: ['article', 'image'] },
  { id: 'csdn', name: 'CSDN', region: 'domestic', route: 'session', types: ['article', 'image'] },
  { id: 'yuque', name: '语雀', region: 'domestic', route: 'session', types: ['article', 'image'] },
  { id: 'segmentfault', name: '思否', region: 'domestic', route: 'session', types: ['article'] },
  { id: 'cnblogs', name: '博客园', region: 'domestic', route: 'session', types: ['article', 'image'] },
  { id: 'oschina', name: '开源中国', region: 'domestic', route: 'session', types: ['article'] },
  { id: 'douban', name: '豆瓣', region: 'domestic', route: 'session', types: ['text', 'image'] },
  { id: 'sohu', name: '搜狐号', region: 'domestic', route: 'session', types: ['article', 'image'] },
  // —— 垂直平台 ——
  { id: 'baijiahao', name: '百家号', region: 'domestic', route: 'session', types: ['article', 'image'] },
  { id: 'eastmoney', name: '东方财富', region: 'domestic', route: 'session', types: ['article', 'image'] },
  { id: 'xueqiu', name: '雪球', region: 'domestic', route: 'session', types: ['article', 'image'] },
  { id: 'weixin', name: '微信公众号', region: 'domestic', route: 'session', types: ['article', 'image'] },
  { id: 'woshipm', name: '人人都是产品经理', region: 'domestic', route: 'session', types: ['article'] },
  { id: 'cto51', name: '51CTO', region: 'domestic', route: 'session', types: ['article', 'image'] },
  { id: 'imooc', name: '慕课手记', region: 'domestic', route: 'session', types: ['article'] },
  // —— 国际平台 ——
  { id: 'twitter', name: 'X / Twitter', region: 'international', route: 'session', types: ['text', 'image', 'video'] },
  { id: 'youtube', name: 'YouTube', region: 'international', route: 'official', types: ['video'] },
  { id: 'telegram', name: 'Telegram', region: 'international', route: 'official', types: ['text', 'image', 'video'] },
  { id: 'bluesky', name: 'Bluesky', region: 'international', route: 'official', types: ['text', 'image'] },
  { id: 'mastodon', name: 'Mastodon', region: 'international', route: 'official', types: ['text', 'image'] },
  { id: 'reddit', name: 'Reddit', region: 'international', route: 'official', types: ['text'] },
  // —— CMS 自建站 ——
  { id: 'wordpress', name: 'WordPress', region: 'domestic', route: 'official', types: ['article', 'text', 'image'] },
  { id: 'typecho', name: 'Typecho', region: 'domestic', route: 'official', types: ['article', 'image'] },
  { id: 'metaweblog', name: 'MetaWeblog', region: 'domestic', route: 'official', types: ['article', 'image'] },
  // —— 本地导出 ——
  { id: 'zip-download', name: 'Markdown 压缩包', region: 'domestic', route: 'session', types: ['article', 'image'] },
];

/** CLI 平台简称 → PlatformId 映射（xhs=小红书 等）。 */
export function resolvePlatformIds(input) {
  if (!input) return null;
  const alias = { xhs: 'xiaohongshu', twitter: 'twitter', x: 'twitter', bili: 'bilibili', bilibili: 'bilibili', sf: 'segmentfault', os: 'oschina', jj: 'juejin' };
  return String(input)
    .split(/[,，\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => alias[s] || s);
}

export function ensureDir() {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
}

export function loadToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

export function saveToken(token) {
  ensureDir();
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

export class BridgeServer {
  constructor({ log = console.error, commandTimeoutMs = 120000 } = {}) {
    this.log = log;
    this.commandTimeoutMs = commandTimeoutMs;
    /** commandId -> { command, state: 'pending'|'consumed', resolve, reject, timer } */
    this.commands = new Map();
    this.token = loadToken();
    this.server = null;
  }

  start(port = BRIDGE_PORT) {
    if (this.server) return this;
    this.server = http.createServer((req, res) => this.#handle(req, res));
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => resolve(this));
    });
  }

  stop() {
    if (!this.server) return;
    for (const [, c] of this.commands) {
      clearTimeout(c.timer);
      c.reject({ status: 'error', error: 'bridge server 已停止' });
    }
    this.commands.clear();
    this.server.close();
    this.server = null;
  }

  /** 注册命令（CLI 直通或 MCP 工具调用）。返回 Promise<result>（standalone 模式直接 await）。 */
  enqueue(command) {
    return new Promise((resolve, reject) => {
      const id = command.id || 'cmd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const timer = setTimeout(() => {
        this.commands.delete(id);
        reject({ status: 'error', error: `命令等待扩展响应超时（${this.commandTimeoutMs}ms）` });
      }, this.commandTimeoutMs);
      // state: pending -> consumed（扩展已取走）-> resolved（结果已产生）；result 缓存防止
      // "扩展先回写、调用方 /wait 后到达"的竞态；waiter 为挂起的 /wait 长轮询连接。
      this.commands.set(id, {
        command: { ...command, id },
        state: 'pending',
        result: null,
        waiter: null,
        resolve,
        reject,
        timer,
      });
      this.log(`[bridge] 命令已注册: ${command.type} (${id})，等待扩展轮询...`);
    });
  }

  /** 扩展侧回写结果。返回是否成功。 */
  resolveCommand(commandId, result, token) {
    if (this.token && token !== this.token) return false;
    const entry = this.commands.get(commandId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.state = 'resolved';
    entry.resolve(result);
    if (entry.waiter) {
      // 有调用方正在 /wait 挂起 → 立即投递并清理
      const w = entry.waiter;
      entry.waiter = null;
      this.commands.delete(commandId);
      w.respond(result);
    } else {
      // 调用方尚未到达 /wait → 缓存结果，等它来取
      entry.result = result;
    }
    return true;
  }

  #json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  #readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch {
          resolve({});
        }
      });
    });
  }

  #handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
    const route = url.pathname;
    const headerToken = String(req.headers['x-omnipost-token'] || '');

    if (route === '/health') {
      return this.#json(res, 200, { ok: true, port: BRIDGE_PORT });
    }

    // 扩展轮询：取走一条 pending 命令；同时完成 token 首交换 / 续期。
    // token 以扩展携带的为准：扩展是 token 唯一权威来源（重装扩展会轮换 token），
    // 若不一致则更新持久化，避免旧 token 文件导致 bridge 永久死锁。
    if (route === '/omnipost/poll') {
      if (headerToken && headerToken.startsWith('om')) {
        if (this.token !== headerToken) {
          this.token = headerToken;
          saveToken(headerToken);
          this.log('[bridge] 已接收/更新扩展 token 并持久化');
        }
      }
      for (const [, entry] of this.commands) {
        if (entry.state === 'pending') {
          entry.state = 'consumed';
          return this.#json(res, 200, { command: entry.command });
        }
      }
      return this.#json(res, 200, { command: null });
    }

    // CLI 直通注册命令（已有一个 server 在跑，例如 MCP 常驻）。
    // 只登记、立即回 accepted；调用方随后用 /omnipost/wait/{id} 长轮询取结果。
    if (route === '/omnipost/command' && req.method === 'POST') {
      this.#readBody(req).then((body) => {
        const p = this.enqueue(body);
        if (p && typeof p.catch === 'function') p.catch(() => {}); // 无人 await 时吞掉超时 rejection
        const id = body?.id || [...this.commands.keys()].pop() || '';
        this.#json(res, 200, { accepted: true, commandId: id });
      });
      return;
    }

    // 扩展回写结果
    if (route === '/omnipost/result' && req.method === 'POST') {
      this.#readBody(req).then((body) => {
        const ok = this.resolveCommand(body?.commandId, body?.result, headerToken);
        this.#json(res, ok ? 200 : (this.token && headerToken !== this.token ? 403 : 404), { ok });
      });
      return;
    }

    // 调用方等待命令结果（长轮询）。扩展可能已先回写 → 直接返回缓存结果。
    const waitMatch = route.match(/^\/omnipost\/wait\/([\w-]+)$/);
    if (waitMatch) {
      const id = waitMatch[1];
      const entry = this.commands.get(id);
      if (!entry) {
        return this.#json(res, 200, { status: 'error', error: '未知命令 id' });
      }
      if (entry.result !== null) {
        this.commands.delete(id);
        return this.#json(res, 200, entry.result);
      }
      const timeout = Math.min(Number(url.searchParams.get('timeout') || 60000), this.commandTimeoutMs);
      const timer = setTimeout(() => {
        if (entry.waiter) {
          entry.waiter = null;
          clearTimeout(entry.timer);
          this.commands.delete(id);
          entry.reject({ status: 'error', error: '等待扩展响应超时' });
          this.#json(res, 200, { status: 'error', error: '等待扩展响应超时' });
        }
      }, timeout);
      entry.waiter = {
        respond: (result) => {
          clearTimeout(timer);
          this.#json(res, 200, result);
        },
      };
      return;
    }

    return this.#json(res, 404, { error: `未知端点: ${route}` });
  }
}

/** 简易 HTTP 客户端（Node 18+ 全局 fetch）。 */

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * 发送命令到 bridge。若 18432 已有 server（MCP 常驻）→ 直通；
 * 否则临时起一个 server 注册命令并等待扩展处理。
 */
export async function sendCommand(command, { timeoutMs = 120000, log = console.error } = {}) {
  // 预生成稳定 id：POST 注册与 /wait 取结果必须用同一个 id
  const id = command.id || 'cmd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const full = { ...command, id };

  // 1) 尝试直通已监听端口的 server
  try {
    const health = await fetchJson(`http://127.0.0.1:${BRIDGE_PORT}/health`, { signal: AbortSignal.timeout(800) });
    if (health.status === 200) {
      await fetchJson(`http://127.0.0.1:${BRIDGE_PORT}/omnipost/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(full),
      });
      const waitRes = await fetchJson(`http://127.0.0.1:${BRIDGE_PORT}/omnipost/wait/${id}`, {
        signal: AbortSignal.timeout(timeoutMs + 5000),
      });
      return waitRes.body;
    }
  } catch {
    // 端口未监听 → 走 standalone
  }

  // 2) standalone：自己起 server
  const server = new BridgeServer({ log });
  await server.start();
  let timer;
  try {
    const promise = server.enqueue(full);
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject({ status: 'error', error: `等待扩展响应超时（${timeoutMs}ms）` }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    server.stop();
  }
}
