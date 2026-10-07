/**
 * Adapter 公共工具：真实 Tab 定位、加载等待、带超时与 lastError 检查的消息发送。
 * 核心原则：不再有任何"假装成功"——找不到 Tab、没有接收端、超时都返回明确错误。
 */

/** 发送消息到指定 tab，检查 lastError 并带超时（避免回调永久挂起）。 */
export function sendToTab<T = any>(tabId: number, message: any, timeoutMs = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`发送消息超时（${timeoutMs}ms），页面可能未响应`));
    }, timeoutMs);

    try {
      chrome.tabs.sendMessage(tabId, message, (res) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(`页面无响应: ${err.message}`));
          return;
        }
        resolve(res as T);
      });
    } catch (e: any) {
      clearTimeout(timer);
      reject(new Error(`发送消息异常: ${e?.message || e}`));
    }
  });
}

/** 等待 tab 完成加载（替代固定 sleep 的可靠方式）。 */
export function waitForTabComplete(tabId: number, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`等待页面加载超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // 若 tab 已在 complete 状态（query 命中的已有 tab），立即通过
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => { /* ignore */ });
  });
}

/**
 * 确保编辑器 tab 存在：优先复用匹配的 tab，否则新建并等待真实加载完成。
 * opts.active=false 时全程后台操作（不抢焦点），供静默自动发布链路使用。
 */
export async function ensureEditorTab(
  queryUrl: string | string[],
  injectUrl: string,
  opts?: { active?: boolean; extraBufferMs?: number },
): Promise<chrome.tabs.Tab> {
  const active = opts?.active ?? true;
  const extraBufferMs = opts?.extraBufferMs ?? 2500;
  const tabs = await chrome.tabs.query({ url: queryUrl });
  if (tabs[0]?.id) {
    // 已有编辑页：静默模式不抢焦点
    if (active) {
      await chrome.tabs.update(tabs[0].id, { active: true });
    }
    return tabs[0];
  }

  const tab = await chrome.tabs.create({ url: injectUrl, active });
  if (!tab.id) {
    throw new Error('无法创建新标签页');
  }
  // 等待真实加载完成 + 缓冲（SPA 首屏渲染）
  await waitForTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, extraBufferMs));
  return tab;
}

/**
 * tabs.query 的 URL 模式必须是同款（避免 checkLogin/createDraft/publish 各写各的导致误开新 tab）。
 * 注意 Chrome match pattern 陷阱：`*://*.x.com/*` 不匹配裸域 `x.com`，必须显式同时给出裸域与子域。
 */
export const TAB_PATTERNS: Record<string, string | string[]> = {
  weibo: ['*://weibo.com/*', '*://*.weibo.com/*'],
  xiaohongshu: '*://creator.xiaohongshu.com/*',
  bilibili: '*://t.bilibili.com/*',
  zhihu: '*://zhuanlan.zhihu.com/write*',
  twitter: ['*://x.com/*', '*://*.x.com/*'],
  twitterAlt: ['*://twitter.com/*', '*://*.twitter.com/*'],
  douban: ['*://douban.com/*', '*://*.douban.com/*'],
  douyin: '*://creator.douyin.com/*',
};

/**
 * 生成正文摘要/兜底标题（供各平台 title 缺省时截取）。
 * 必须先按 Markdown 语法语义清理（图片整体剔除、链接只留文字、代码块剔除），
 * 再剥离标记字符——否则正文以 ![图](url) 或 [文](url) 开头时会把 URL 残片拼进标题（乱码）。
 */
export function previewOf(body: string, max = 80): string {
  const plain = (body || '')
    .replace(/```[\s\S]*?```/g, ' ') // 围栏代码块整体剔除
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片：整体剔除（URL 不应进入标题）
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接：只保留链接文字
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题井号
    .replace(/^\s*[-*+]\s+/gm, '') // 列表项标记
    .replace(/^\s*>\s?/gm, '') // 引用标记
    .replace(/[*_`~]/g, '') // 行内样式标记
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, max);
}
