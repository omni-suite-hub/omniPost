import { Article, DraftRef, ExtractedArticle, MediaRef, PlatformId, PublishProgress, PublishResult, ScheduledItem } from '@omnipost/core';
import { adapters } from '../adapters';
import { store } from '../store';
import { humanDelay, clearAllDynamicRules } from '../adapters/api-client';

let bgLang: Lang = 'zh';
import { authorizeYoutube, YoutubeTokens } from '../adapters/youtube-oauth';
import { rewriteForPlatform, getProvider, generateArticle } from '../adapters/ai-client';
import { getPlatformFormat, markdownToPlainText } from '../adapters/markdown-utils';
import { t, Lang } from '../lib/i18n';
import { installDownloadNaming } from '../lib/download-naming';

/**
 * 平台正文字数硬上限（仅在有真实官方依据时收录）。
 * 仅在「AI 适配各平台」开启时用作改写约束；未列入 = 长文不限。
 * 母稿本身不再做前端字数限制，由 AI 按各平台上限压缩。
 *
 * 注意（2026-09 官方口径核实）：
 *  - 微博头条文章正文上限 90000（官方开放接口文档），是长文平台，切勿按短微博 2000 压缩
 *  - B站专栏正文 200~20000 字，非 2000
 */
const PLATFORM_CHAR_LIMITS: Partial<Record<PlatformId, number>> = {
  xiaohongshu: 1000,   // 小红书笔记正文上限
  bilibili: 20000,     // B站专栏正文上限（下限 200）
  twitter: 280,        // X 免费账号单帖
  telegram: 4096,      // 注：有媒体时实际为 1024，发布前会按媒体情况动态覆盖
  bluesky: 300,        // 300 字素
  mastodon: 500,       // 默认实例上限
  douyin: 1000,        // 抖音图文笔记描述（含标签）
  reddit: 40000,       // Reddit 正文上限
};

/**
 * 平台标题字数硬上限（含标点，仅收录有官方/多来源佐证的值）。
 * 仅在「AI 适配各平台」开启时用作改写约束；未列入 = 标题不限或平台编辑器自理。
 */
const PLATFORM_TITLE_LIMITS: Partial<Record<PlatformId, number>> = {
  xiaohongshu: 20,  // 小红书标题
  douyin: 20,       // 抖音图文标题
  youtube: 100,     // YouTube 视频标题（官方 API）
  reddit: 300,      // Reddit 帖子标题（官方 API）
  weibo: 32,        // 微博头条文章标题（官方使用手册）
  bilibili: 40,     // B站专栏标题
  toutiao: 30,      // 今日头条文章标题（5-30 字）
  weixin: 64,       // 微信公众号标题
  baijiahao: 40,    // 百家号标题
};

// 启动时清理历史残留的 declarativeNetRequest 动态规则，防止配额泄漏
clearAllDynamicRules().catch(() => {});

// data: URL 下载会被 Chrome 固定命名为 download.zip（忽略 filename），这里修正为文章标题
installDownloadNaming();

// 点击扩展图标 → 在浏览器右侧打开 Side Panel（替代弹窗，侧边栏更适合长表单撰写）
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} catch (e) {
  console.warn('[OmniPost] sidePanel 不可用，将回退为弹窗模式:', e);
}

// ---- Local Bridge 轮询（CLI / MCP 经 127.0.0.1:18432 与扩展通信） ----
// 通信模型：CLI/MCP 把命令注册到 bridge server → 扩展用 alarms 每 30s 轮询取走 →
//           处理（checkLogin / 建草稿）后 POST 回写结果 → bridge resolve 等待中的调用方。
const BRIDGE_BASE = 'http://127.0.0.1:18432';
const BRIDGE_POLL_ALARM = 'omnipost-bridge-poll';
const SCHEDULER_ALARM = 'omnipost-scheduler';

async function ensureSchedulerAlarm() {
  try {
    const existing = await chrome.alarms.get(SCHEDULER_ALARM);
    if (!existing) {
      await chrome.alarms.create(SCHEDULER_ALARM, { periodInMinutes: 0.5 });
    }
  } catch (e) {
    console.warn('[OmniPost] alarms 不可用，定时发布将停止:', e);
  }
}

/** 检查定时队列：到期任务逐个发布（复用 handleAutoPublishPipeline，含 P0 AI 适配 + 周期重排） */
async function runDueScheduled() {
  try {
    const queue = await store.getScheduledQueue();
    const now = Date.now();
    const due = queue.filter((i) => i.scheduledAt <= now);
    if (due.length === 0) return;

    for (const item of due) {
      try {
        // 内容来源：ai 模式到点按主题现生成（内容每次不同）；fixed 模式用固定内容
        let publishArticle = item.article;
        if (item.contentMode === 'ai' && item.topic) {
          try {
            const ai = await store.getAiSettings();
            const provider = getProvider(ai.provider);
            const config = {
              baseUrl: ai.baseUrl || provider?.baseUrl || '',
              apiKey: ai.apiKey,
              model: ai.model || provider?.defaultModel || '',
            };
            if (config.baseUrl && config.model && config.apiKey) {
              broadcastProgress({ platformId: item.platformIds[0] || ('weibo' as PlatformId), platformName: t('定时发布', bgLang), stage: 'drafting', message: t('AI 正在生成新内容...', bgLang) });
              const gen = await generateArticle({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, prompt: item.topic });
              publishArticle = { ...item.article, title: gen.title || item.article.title, body: gen.body || item.article.body };
            }
          } catch {
            // AI 生成失败 → 回退固定内容（不阻塞发布）
          }
        }

        const { results } = await handleAutoPublishPipeline(publishArticle, item.platformIds, item.aiRewrite, false);

        // 周期重排：daily/weekly 发布后不删除，重置下次时间；once 出队
        if (item.repeat === 'daily' || item.repeat === 'weekly') {
          const step = item.repeat === 'daily' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
          let next = item.scheduledAt + step;
          // 若任务已严重过期，从当前时间向后推，避免连续补发
          if (next <= now) next = now + step;
          await store.saveScheduledQueue(
            (await store.getScheduledQueue()).map((i) => (i.id === item.id ? { ...i, scheduledAt: next, lastError: undefined } : i)),
          );
        } else {
          await store.removeScheduled(item.id);
        }

        const failed = results.filter((r) => !r.ok).length;
        const okCount = results.length - failed;
        // 定时发布历史已在 handleAutoPublishPipeline 中统一记录，此处不再二次写入
        broadcastProgress({
          platformId: item.platformIds[0] || ('weibo' as PlatformId),
          platformName: t('定时发布', bgLang),
          stage: 'done',
          message: `${t('定时发布完成', bgLang)}：${okCount} ${t('成功', bgLang)}${failed ? `，${failed} ${t('失败', bgLang)}` : ''}${item.repeat === 'daily' ? t('（已排期下次）', bgLang) : item.repeat === 'weekly' ? t('（已排期下周）', bgLang) : ''}`,
        });
      } catch (e: any) {
        // 发布失败：保留队列并记录错误，供用户重试
        await store.saveScheduledQueue(
          (await store.getScheduledQueue()).map((i) => (i.id === item.id ? { ...i, lastError: e?.message || '发布失败' } : i)),
        );
      }
    }
  } catch (e) {
    console.warn('[OmniPost] 定时队列检查失败:', e);
  }
}

async function ensureBridgeAlarm() {
  try {
    const existing = await chrome.alarms.get(BRIDGE_POLL_ALARM);
    if (!existing) {
      await chrome.alarms.create(BRIDGE_POLL_ALARM, { periodInMinutes: 0.5 });
    }
  } catch (e) {
    console.warn('[OmniPost] alarms 不可用，CLI/MCP bridge 轮询将停止:', e);
  }
}

/** 轮询 bridge server：取走一条命令 → 处理 → POST 回写结果。任何失败静默跳过（server 未启动属常态）。 */
async function pollBridge() {
  try {
    const token = await store.ensureBridgeToken();
    const res = await fetch(`${BRIDGE_BASE}/omnipost/poll`, {
      headers: { 'X-Omnipost-Token': token },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const { command } = await res.json();
    if (!command?.type || !command.id) return;

    let result: any;
    try {
      if (command.type === 'check_login') {
        const auth = await handleCheckAllLogin();
        const wanted: string[] = command.payload?.platforms || [];
        if (wanted.length > 0) {
          const filtered: Record<string, any> = {};
          for (const pid of wanted) {
            if (auth[pid]) filtered[pid] = auth[pid];
          }
          result = { status: 'ok', auth: filtered };
        } else {
          result = { status: 'ok', auth };
        }
      } else if (command.type === 'sync_article') {
        const payload = command.payload || {};
        let platforms = await getSyncablePlatforms();
        const wanted: string[] = payload.platforms || [];
        if (wanted.length > 0) {
          platforms = platforms.filter((p) => wanted.includes(p));
        }
        const article: Article = {
          title: payload.title || '',
          body: payload.body || '',
          media: payload.media || [],
          tags: payload.tags || [],
        };
        const { drafts, results, errors } = await handleAutoPublishPipeline(article, platforms, false, false);
        result = { status: 'ok', drafts, results, errors };
      } else if (command.type === 'extract') {
        const resp = await extractFromTab();
        if (resp?.ok && resp.article) {
          result = { status: 'ok', article: resp.article };
        } else {
          result = { status: 'error', error: resp?.error || '当前页面未识别到文章正文' };
        }
      } else {
        result = { status: 'error', error: `未知命令类型: ${command.type}` };
      }
    } catch (e: any) {
      result = { status: 'error', error: e?.message || '命令处理失败' };
    }

    await fetch(`${BRIDGE_BASE}/omnipost/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Omnipost-Token': token },
      body: JSON.stringify({ commandId: command.id, result }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // bridge server 未启动 / 网络失败：静默跳过，等下一轮
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BRIDGE_POLL_ALARM) pollBridge();
  if (alarm.name === SCHEDULER_ALARM) runDueScheduled();
});

// SW 每次启动都确保轮询报警存在（幂等），并立即补一轮轮询
ensureBridgeAlarm();
pollBridge();
ensureSchedulerAlarm();
store.getLang().then((l) => { bgLang = l; }).catch(() => {});

// Keep track of active tasks
let currentProgress: Record<PlatformId, PublishProgress> = {} as any;

/**
 * 长任务中把每个平台的最新状态落盘：SW 一旦被 Chrome 回收，内存里的 currentProgress 会随之消失，
 * 前端就只能把所有平台一律标成「未执行或被跳过」。落盘后失联时仍可还原真实进度。
 */
const PUB_PROGRESS_KEY = 'publishProgress';
function persistProgress() {
  try {
    const p = chrome.storage.local.set({ [PUB_PROGRESS_KEY]: currentProgress }) as unknown as Promise<void> | undefined;
    if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
  } catch {
    // storage 不可用时不影响主流程
  }
}

function broadcastProgress(progress: PublishProgress) {
  currentProgress[progress.platformId] = progress;
  persistProgress();
  chrome.runtime.sendMessage({
    type: 'PROGRESS_UPDATE',
    payload: progress
  }).catch(() => {
    // Popup or sidepanel might be closed, which is normal
  });
}

/** 计算可同步的平台：session 路线全部参与（checkLogin 会兜底），official 路线仅当配置了凭证。 */
async function getSyncablePlatforms(): Promise<PlatformId[]> {
  const settings = await store.getSettings();
  const result: PlatformId[] = [];
  for (const [id, adapter] of Object.entries(adapters)) {
    if (!adapter) continue; // 尚未实现的新平台（Partial 注册表）
    const pid = id as PlatformId;
    if (adapter.route === 'official') {
      const configured =
        (pid === 'wordpress' && !!settings.wordpress?.endpoint) ||
        (pid === 'telegram' && !!settings.telegram?.botToken) ||
        (pid === 'youtube' && !!settings.youtube?.accessToken) ||
        (pid === 'twitter' && !!settings.twitter?.accessToken) ||
        // Phase C C3：CMS（MetaWeblog XML-RPC 通道，配置了站点与账号才同步）
        (pid === 'typecho' && !!settings.typecho?.siteUrl && !!settings.typecho?.username) ||
        (pid === 'metaweblog' && !!settings.metaweblog?.siteUrl && !!settings.metaweblog?.username) ||
        // 海外社交平台与技术社区（API 直连，配置凭证后才同步）
        (pid === 'bluesky' && !!settings.bluesky?.identifier && !!settings.bluesky?.appPassword) ||
        (pid === 'mastodon' && !!settings.mastodon?.instance && !!settings.mastodon?.accessToken) ||
        (pid === 'reddit' && !!settings.reddit?.subreddit) ||
        (pid === 'devto' && !!settings.devto?.apiKey) ||
        (pid === 'hashnode' && !!settings.hashnode?.apiKey);
      if (configured) result.push(pid);
    } else {
      result.push(pid);
    }
  }
  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CHECK_ALL_LOGIN') {
    handleCheckAllLogin(message.payload?.platformIds)
      .then(sendResponse)
      .catch(() => sendResponse({})); // 预检失败不等同于未登录：返回空对象让前端按"未知"放行
    return true;
  }

  if (message.type === 'CHECK_PLATFORM_LOGIN') {
    // 单平台检测（设置面板"测试连接"）：只对该平台跑 checkLogin 并落盘，避免全平台扫描
    const { platformId } = message.payload as { platformId: PlatformId };
    const adapter = adapters[platformId];
    if (!adapter) {
      sendResponse({ loggedIn: false, error: '平台未实现' });
      return true;
    }
    adapter.checkLogin().then(async (auth) => {
      await store.setAuth(platformId, auth);
      sendResponse(auth);
    }).catch((e: any) => {
      sendResponse({ loggedIn: false, error: e?.message || '检测失败' });
    });
    return true;
  }

  if (message.type === 'START_DRAFT_PIPELINE') {
    const { article, platformIds, aiRewrite } = message.payload as { article: Article; platformIds: PlatformId[]; aiRewrite?: boolean };
    handleDraftPipeline(article, platformIds, !!aiRewrite).then(sendResponse);
    return true;
  }

  if (message.type === 'START_AUTO_PUBLISH') {
    // 一键静默发布：建草稿 → 自动发布 → 关闭编辑页（对标商店插件"一键发文"体验）
    // semiAuto=true 时只建草稿不调 publish API（绕开 API 直连平台风控）
    const { article, platformIds, aiRewrite, semiAuto } = message.payload as { article: Article; platformIds: PlatformId[]; aiRewrite?: boolean; semiAuto?: boolean };
    handleAutoPublishPipeline(article, platformIds, !!aiRewrite, !!semiAuto)
      .then(sendResponse)
      .catch((e: any) => {
        // 管线级异常必须有响应，否则 message port 关闭 → 前端收到 undefined → 全部平台误报"未执行或被跳过"
        console.error('[OmniPost] 发布管线异常中断:', e);
        sendResponse({
          drafts: [],
          results: [],
          errors: {},
          warnings: {},
          // 只回传技术性原因，前端负责拼接本地化前缀（避免英文界面漏中文）
          fatal: e?.message || 'unknown error',
        });
      });
    return true;
  }

  if (message.type === 'START_PUBLISH_PIPELINE') {
    const { drafts } = message.payload as { drafts: DraftRef[] };
    handlePublishPipeline(drafts)
      .then(sendResponse)
      .catch((e: any) => {
        console.error('[OmniPost] 发布管线异常中断:', e);
        sendResponse([]);
      });
    return true;
  }

  if (message.type === 'GET_CURRENT_PROGRESS') {
    sendResponse({ progress: currentProgress });
    return true;
  }

  if (message.type === 'YOUTUBE_AUTHORIZE') {
    (async () => {
      const settings = await store.getSettings();
      const yt = settings.youtube || {};
      if (!yt.clientId || !yt.clientSecret) {
        sendResponse({ ok: false, error: '请先填写 YouTube Client ID 与 Client Secret' });
        return;
      }
      try {
        const tokens: YoutubeTokens = await authorizeYoutube(yt.clientId, yt.clientSecret);
        await store.saveSettings({ youtube: { ...yt, ...tokens } });
        sendResponse({ ok: true });
      } catch (e: any) {
        sendResponse({ ok: false, error: e?.message || 'YouTube 授权失败' });
      }
    })();
    return true;
  }

  if (message.type === 'SYNC_ARTICLE') {
    // Direct sync for bridge / CLI / window.syncPost：只同步"已配置"的平台，避免向未配置的官方平台轰炸
    const article = message.payload as Article;
    getSyncablePlatforms().then((platforms) => {
      return handleAutoPublishPipeline(article, platforms, false, false);
    }).then(({ drafts, results, errors, warnings }) => {
      sendResponse({ status: 'Published', drafts, results, errors, warnings });
    }).catch((e: any) => {
      sendResponse({ status: 'error', error: e?.message || '同步失败' });
    });
    return true;
  }

  if (message.type === 'EXTRACT_ARTICLE') {
    // 从活动/指定 tab 提取正文（content script extractor 响应），供 popup「从当前页提取」与 MCP 复用
    (async () => {
      try {
        const { tabId } = (message.payload || {}) as { tabId?: number };
        const resp = await extractFromTab(tabId);
        sendResponse(resp);
      } catch (e: any) {
        sendResponse({ ok: false, error: e?.message || '正文提取失败' });
      }
    })();
    return true;
  }

  if (message.type === 'OPEN_PANEL_WITH_ARTICLE') {
    // fab 悬浮按钮点击：提取的文章落盘 → 打开 Side Panel（异步链可能丢失 user gesture），
    // 同时给扩展图标加 badge 提醒用户已提取（即使 sidePanel 没自动开，用户也能从图标看到）
    (async () => {
      try {
        const { article } = (message.payload || {}) as { article?: any };
        await store.saveExtractedArticle(article || null);
        // 扩展图标 badge：提取成功显示"已"，失败显示"!"（popup 打开时清掉）
        try {
          if (chrome.action?.setBadgeText && article) {
            await chrome.action.setBadgeText({ text: '已' });
            if (chrome.action.setBadgeBackgroundColor) {
              await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
            }
          }
        } catch { /* badge 设置失败不影响主流程 */ }
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.windowId != null) {
            await chrome.sidePanel.open({ windowId: tab.windowId });
          }
        } catch {
          // sidePanel.open 可能因用户手势丢失被拒；文章已落盘+badge 提示，用户手动点图标也能看到
        }
        sendResponse({ ok: true });
      } catch (e: any) {
        sendResponse({ ok: false, error: e?.message || '打开面板失败' });
      }
    })();
    return true;
  }

  if (message.type === 'SCHEDULE_PUBLISH') {
    // P1 定时发布：入队，到点自动发布（支持周期 repeat + AI 按主题生成 contentMode=ai）
    (async () => {
      try {
        const { article, platformIds, scheduledAt, aiRewrite, repeat, contentMode, topic } = message.payload as {
          article: Article; platformIds: PlatformId[]; scheduledAt: number; aiRewrite?: boolean;
          repeat?: 'once' | 'daily' | 'weekly'; contentMode?: 'fixed' | 'ai'; topic?: string;
        };
        if (!scheduledAt || scheduledAt <= Date.now()) {
          sendResponse({ ok: false, error: '请选择未来的发布时间' });
          return;
        }
        if (contentMode === 'ai' && !topic?.trim()) {
          sendResponse({ ok: false, error: 'AI 生成模式需要填写主题/选题' });
          return;
        }
        // 定时发布不持久化本地媒体文件（dataUrl base64 易超 storage 10MB 配额，blob URL 会话失效）
        // 剥离 media，仅发文字 + 正文内嵌图片（外链，发布时 processImages 转存）
        const safeArticle: Article = { ...article, media: [] };
        // 记录入队时各目标平台的活跃账号 ID，防串发
        const activeAccounts: Partial<Record<PlatformId, string>> = {};
        for (const pid of platformIds) {
          const actId = await store.getActiveAccountId(pid);
          if (actId) activeAccounts[pid] = actId;
        }

        const item: ScheduledItem = {
          id: 'sched_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          article: safeArticle,
          platformIds,
          scheduledAt,
          aiRewrite: !!aiRewrite,
          createdAt: Date.now(),
          repeat: repeat || 'once',
          contentMode: contentMode || 'fixed',
          topic: topic?.trim() || undefined,
          activeAccounts,
        };
        await store.addScheduled(item);
        sendResponse({ ok: true, id: item.id });
      } catch (e: any) {
        sendResponse({ ok: false, error: e?.message || '加入定时队列失败' });
      }
    })();
    return true;
  }

  if (message.type === 'GET_SCHEDULED') {
    store.getScheduledQueue().then((queue) => sendResponse({ queue })).catch(() => sendResponse({ queue: [] }));
    return true;
  }

  if (message.type === 'REMOVE_SCHEDULED') {
    const { id, publishNow } = message.payload as { id: string; publishNow?: boolean };
    (async () => {
      try {
        if (publishNow) {
          // 立即发布：找到该项 → 出队 → 立即走管线
          const queue = await store.getScheduledQueue();
          const item = queue.find((i) => i.id === id);
          await store.removeScheduled(id);
          if (item) {
            await handleAutoPublishPipeline(item.article, item.platformIds, item.aiRewrite, false);
          }
        } else {
          await store.removeScheduled(id);
        }
        sendResponse({ ok: true });
      } catch (e: any) {
        sendResponse({ ok: false, error: e?.message || '操作失败' });
      }
    })();
    return true;
  }

  return false;
});

/** 从活动 tab（或指定 tab）提取正文：向 extractor content script 发 EXTRACT_ARTICLE 消息 */
async function extractFromTab(tabId?: number): Promise<{ ok: boolean; article?: ExtractedArticle; error?: string }> {
  let targetId = tabId;
  if (!targetId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetId = tab?.id;
  }
  if (!targetId) return { ok: false, error: '未找到活动标签页' };
  const resp = await new Promise<any>((resolve) => {
    chrome.tabs.sendMessage(targetId!, { type: 'EXTRACT_ARTICLE' }, (r) => {
      void chrome.runtime.lastError; // 吞掉 "Could not establish connection"（页面未注入脚本属常态）
      resolve(r);
    });
  });
  if (!resp) return { ok: false, error: '当前页面未注入提取脚本（非 http/https 文章页）' };
  return resp;
}

async function handleCheckAllLogin(targetPlatformIds?: PlatformId[]) {
  // 26 个平台串行扫描最坏 26×30s 超时不可接受 → 6 并发池（同平台仅 1 个请求，无风控风险）；
  // 单平台失败不影响其他平台，未实现的平台（Partial 注册表）跳过。
  const results: Record<string, any> = {};
  let entries = Object.entries(adapters).filter(([, a]) => !!a) as [string, typeof adapters[keyof typeof adapters]][];
  if (targetPlatformIds && targetPlatformIds.length > 0) {
    const targetSet = new Set(targetPlatformIds);
    entries = entries.filter(([id]) => targetSet.has(id as PlatformId));
  }
  let cursor = 0;
  const CONCURRENCY = 6;
  // 单平台超时兜底：某平台 checkLogin 若 fetch 无超时/注入 tab 挂起，8s 后强制判为未登录，避免刷新按钮永远转圈。
  const PER_PLATFORM_TIMEOUT = 8000;
  const checkWithTimeout = async (adapter: { checkLogin: () => Promise<any> }) => {
    return Promise.race([
      adapter.checkLogin(),
      new Promise<any>((_, reject) => setTimeout(() => reject(new Error('checkLogin timeout')), PER_PLATFORM_TIMEOUT)),
    ]);
  };
  const workers = Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
    while (cursor < entries.length) {
      const [id, adapter] = entries[cursor++];
      try {
        const auth = await checkWithTimeout(adapter!);
        await store.setAuth(id as PlatformId, auth);
        results[id] = auth;
      } catch {
        results[id] = { loggedIn: false };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// Stage 1: Create drafts for selected platforms with rate limiting
async function handleDraftPipeline(article: Article, platformIds: PlatformId[], aiRewrite: boolean): Promise<{ drafts: DraftRef[]; errors: Record<string, string>; warnings: Record<string, string> }> {
  const drafts: DraftRef[] = [];
  const errors: Record<string, string> = {};
  // 非致命告警（如 AI 适配未配置/失败回退原文）：不阻塞发布，但必须透出让用户知情
  const warnings: Record<string, string> = {};

  for (let i = 0; i < platformIds.length; i++) {
    const pid = platformIds[i];
    const adapter = adapters[pid];
    if (!adapter) continue;

    // Rate limiting: wait 3s between platforms if not the first one
    if (i > 0) {
      broadcastProgress({
        platformId: pid,
        platformName: t(adapter.name, bgLang),
        stage: 'checking',
        message: t('安全限速等待中...', bgLang)
      });
      await humanDelay(2000, 5000);
    }

    try {
      broadcastProgress({
        platformId: pid,
        platformName: t(adapter.name, bgLang),
        stage: 'checking',
        message: t('正在检查登录状态...', bgLang)
      });

      // 半自动平台（无公开 API，直接建跳转草稿）豁免登录态强校验，直接进入草稿生成与一键跳转
      const isSemiAuto = !!adapter.semiAuto || ['jianshu', 'netease', 'douyin', 'dayu', 'yidian', 'smzdm', 'sohufocus'].includes(pid);

      if (!isSemiAuto) {
        const auth = await adapter.checkLogin();
        await store.setAuth(pid, auth);

        if (!auth.loggedIn) {
          throw new Error(t('未检测到登录会话，请先登录该平台', bgLang));
        }
      }

      broadcastProgress({
        platformId: pid,
        platformName: t(adapter.name, bgLang),
        stage: 'drafting',
        message: t('正在创建草稿...', bgLang)
      });

      // Handle media upload if adapter supports it and article has media
      // 上传成功的 MediaRef 必须传给 createDraft（媒体管线闭环）
      let mediaRefs: MediaRef[] = [];
      if (article.media && article.media.length > 0 && adapter.uploadMedia) {
        for (const media of article.media) {
          broadcastProgress({
            platformId: pid,
            platformName: t(adapter.name, bgLang),
            stage: 'uploading',
            message: `${t('上传媒体', bgLang)}: ${media.name}...`
          });
          const ref = await adapter.uploadMedia(media);
          if (ref) mediaRefs.push(ref);
        }
        // 防假成功：session 平台的 uploadMedia 目前仅"登记引用"（url 为 dataUrl 而非平台真实地址），
        // 若草稿内容里不会真正包含该媒体，必须明确报错而不是静默丢图。
        const fakeRef = mediaRefs.find((m) => m.url.startsWith('data:'));
        if (fakeRef) {
          throw new Error(
            `${t(adapter.name, bgLang)} ${t('的自动媒体上传尚未实现，为避免发布后图片丢失，请先去掉媒体后再试（纯文本发布不受影响）', bgLang)}`,
          );
        }
      }

      // P0：AI 多平台风格自适应——开启且平台有风格描述时，改写母稿；
      // 未配置/失败不再静默：记录 warning 透传到回执，让用户知道该平台发的是原文
      let targetArticle = article;
      const targetFormat = getPlatformFormat(pid);
      if (aiRewrite && adapter.stylePrompt) {
        try {
          const ai = await store.getAiSettings();
          const provider = getProvider(ai.provider);
          const config = {
            baseUrl: ai.baseUrl || provider?.baseUrl || '',
            apiKey: ai.apiKey,
            model: ai.model || provider?.defaultModel || '',
          };
          if (config.baseUrl && config.model && config.apiKey) {
            broadcastProgress({ platformId: pid, platformName: t(adapter.name, bgLang), stage: 'drafting', message: t('AI 适配平台风格中...', bgLang) });
            // Telegram 有媒体时正文上限降为 1024（caption 限制），无媒体时 4096
            let bodyLimit = PLATFORM_CHAR_LIMITS[pid];
            if (pid === 'telegram' && mediaRefs.length > 0) bodyLimit = 1024;
            const rewritten = await rewriteForPlatform(
              { title: article.title || '', body: article.body },
              adapter.stylePrompt,
              config,
              targetFormat,
              bodyLimit,
              PLATFORM_TITLE_LIMITS[pid],
            );
            targetArticle = { ...article, title: rewritten.title || article.title, body: rewritten.body || article.body };
          } else {
            warnings[pid] = t('AI 未配置 API Key，已跳过风格适配（发布的是原文）', bgLang);
          }
        } catch (e: any) {
          // 改写失败 → 用原文，不阻塞发布，但透出告警
          warnings[pid] = `${t('AI 适配失败，已回退原文', bgLang)}：${e?.message || '未知错误'}`;
        }
      }

      // 若目标平台为纯文本/社交平台（小红书、微博、X、B站动态等），且正文仍含 Markdown 语法，
      // 统一自动转化为排版自然的纯文本，杜绝裸 # 标题、**加粗** 泄漏到发布草稿中
      if (targetFormat === 'plain' && targetArticle.body) {
        targetArticle = {
          ...targetArticle,
          title: targetArticle.title ? markdownToPlainText(targetArticle.title) : targetArticle.title,
          body: markdownToPlainText(targetArticle.body),
        };
      }

      const draft = await adapter.createDraft({ ...targetArticle, mediaRefs });
      drafts.push(draft);
      broadcastProgress({
        platformId: pid,
        platformName: t(adapter.name, bgLang),
        stage: 'done',
        message: t('草稿已就绪', bgLang),
        draft
      });
    } catch (err: any) {
      const errMsg = err?.message || '草稿创建失败';
      errors[pid] = errMsg;
      broadcastProgress({
        platformId: pid,
        platformName: t(adapter.name, bgLang),
        stage: 'failed',
        message: errMsg
      });
    }
  }

  return { drafts, errors, warnings };
}

// Stage 2: Publish confirmed drafts with rate limiting
async function handlePublishPipeline(drafts: DraftRef[], saveHistory = true): Promise<PublishResult[]> {
  const results: PublishResult[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i];
    const adapter = adapters[draft.platformId];
    if (!adapter) continue;

    if (i > 0) {
      broadcastProgress({
        platformId: draft.platformId,
        platformName: t(adapter.name, bgLang),
        stage: 'publishing',
        message: t('安全限速间隔...', bgLang)
      });
      await humanDelay(2000, 5000);
    }

    try {
      broadcastProgress({
        platformId: draft.platformId,
        platformName: t(adapter.name, bgLang),
        stage: 'publishing',
        message: t('正在正式发布...', bgLang)
      });

      const result = await adapter.publish(draft);
      results.push(result);

      broadcastProgress({
        platformId: draft.platformId,
        platformName: t(adapter.name, bgLang),
        stage: result.ok ? 'done' : 'failed',
        message: result.ok ? t('发布成功！', bgLang) : (result.error || t('发布失败', bgLang)),
        result
      });
    } catch (err: any) {
      const res: PublishResult = {
        platformId: draft.platformId,
        ok: false,
        error: err?.message || '发布异常',
        timestamp: Date.now()
      };
      results.push(res);
      broadcastProgress({
        platformId: draft.platformId,
        platformName: t(adapter.name, bgLang),
        stage: 'failed',
        message: res.error,
        result: res
      });
    }
  }

  // Save to history（防 drafts 为空导致的 crash）
  if (saveHistory && results.length > 0 && drafts[0]) {
    await store.addHistory({
      id: 'pub_' + Date.now(),
      title: drafts.map((d) => d.title).filter(Boolean).join(' / ') || '多平台发布',
      body: drafts[0]?.previewText || '',
      timestamp: Date.now(),
      results
    });
  }

  return results;
}

/** 发布成功后关闭本次注入的编辑页（仅 session 平台）。按 draft.tabId 精准关闭，绝不误关用户其他标签页。 */
async function closeEditorTab(draft: DraftRef): Promise<void> {
  if (!draft.tabId) return;
  try {
    await chrome.tabs.remove(draft.tabId);
  } catch {
    // tab 已被用户手动关闭，忽略
  }
}

/**
 * MV3 Service Worker 保活心跳：多平台发布管线可达数分钟（每平台限速 2-5s + 登录检查 + 建草稿/发布），
 * 期间若连续 30s 没有任何扩展 API 调用，SW 会被 Chrome 空闲回收 → message port 关闭 →
 * 前端收到 undefined → 全部平台误报"未执行或被跳过"。每 20s 调一次扩展 API 重置空闲计时器。
 */
let publishKeepAliveTimer: ReturnType<typeof setInterval> | null = null;
function startPublishKeepAlive() {
  if (publishKeepAliveTimer) return;
  publishKeepAliveTimer = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch { /* ignore */ }
  }, 20000);
}
function stopPublishKeepAlive() {
  if (publishKeepAliveTimer) {
    clearInterval(publishKeepAliveTimer);
    publishKeepAliveTimer = null;
  }
}

/**
 * 一键静默发布（对标商店插件"一键发文"体验）：
 * 1) 草稿管线：后台打开各平台编辑页并注入内容（active:false，不抢焦点）
 * 2) 发布管线：自动点击发布，处理二次确认
 * 3) 收尾：发布成功的平台关闭对应编辑页
 * 返回草稿、发布结果与各阶段错误，供 UI / CLI / MCP 展示。
 */
async function runAutoPublishPipeline(article: Article, platformIds: PlatformId[], aiRewrite: boolean, semiAuto: boolean): Promise<{
  drafts: DraftRef[];
  results: PublishResult[];
  errors: Record<string, string>;
  warnings: Record<string, string>;
}> {
  const { drafts, errors, warnings } = await handleDraftPipeline(article, platformIds, aiRewrite);
  // 半自动模式：跳过 publish API（绕开 API 直连平台风控），草稿即"结果"，用户手动点发布
  // 三种例外必须如实标记，杜绝假成功：
  //  - semiAuto 平台（简书/抖音等）：平台侧没有真实草稿 → manualOnly（待粘贴发布）
  //  - noRemoteDraft 平台（Telegram/Bluesky/Mastodon/Reddit）：无草稿概念 → 直接判失败并提示改用自动模式
  //  - draftIsPublished 平台（Hashnode）：createDraft 已真实发布 → 按发布成功处理，不标草稿
  let publishResults: PublishResult[];
  if (semiAuto) {
    publishResults = [];
    for (const d of drafts) {
      const ad = adapters[d.platformId];
      if (ad?.noRemoteDraft) {
        publishResults.push({
          platformId: d.platformId,
          ok: false,
          error: t('该平台无草稿功能，半自动模式不支持；请切换到「自动」模式直接发布', bgLang),
          timestamp: Date.now(),
        });
        continue;
      }
      if (ad?.draftIsPublished) {
        publishResults.push({
          platformId: d.platformId,
          ok: true,
          url: d.url,
          draftId: d.draftId,
          timestamp: Date.now(),
        });
        continue;
      }
      publishResults.push({
        platformId: d.platformId,
        ok: true,
        url: d.url,
        draftId: d.draftId,
        draftOnly: true,
        manualOnly: ad?.semiAuto ? true : undefined,
        timestamp: Date.now(),
      });
    }
  } else {
    publishResults = await handlePublishPipeline(drafts, false);
  }

  // 关键兜底：草稿创建阶段失败的平台（落在 errors 中），转换为 failed PublishResult 合并进 results，
  // 确保所有选中的平台在回执弹窗与历史记录中全部呈现，绝不漏掉任何平台
  const results: PublishResult[] = [...publishResults];
  for (const [pid, errMsg] of Object.entries(errors)) {
    if (!results.some((r) => r.platformId === pid)) {
      const adapter = adapters[pid as PlatformId];
      results.push({
        platformId: pid as PlatformId,
        ok: false,
        url: adapter?.homepage || (adapter as any)?.publishUrl,
        error: errMsg || '草稿创建失败',
        timestamp: Date.now(),
      });
    }
  }

  // 再次兜底：如果有些平台因未执行或未知原因既不在 drafts 也不在 errors 中，补全为失败
  for (const pid of platformIds) {
    if (!results.some((r) => r.platformId === pid)) {
      const adapter = adapters[pid as PlatformId];
      results.push({
        platformId: pid,
        ok: false,
        url: adapter?.homepage || (adapter as any)?.publishUrl,
        error: '未执行发布流程',
        timestamp: Date.now(),
      });
    }
  }

  // 统一落盘发布历史（含全成功、部分失败、全失败、半自动等所有场景，单点收敛保证不漏不重）
  // body 存完整正文（manifest 已声明 unlimitedStorage）：内容库「再次使用/复制」需要全文，
  // 之前只存 100 字摘要会导致再次使用时正文被静默截断
  if (results.length > 0) {
    await store.addHistory({
      id: 'pub_' + Date.now(),
      title: article.title || drafts.map((d) => d.title).filter(Boolean).join(' / ') || '多平台发布',
      body: article.body || drafts[0]?.previewText || '',
      timestamp: Date.now(),
      results,
    }).catch(() => {});
  }

  // 发布成功的 session 平台：关闭本次注入的编辑页（静默收尾，不打扰用户）；半自动模式不关（保留草稿编辑页供用户手动发布）
  if (!semiAuto) {
    for (const r of results) {
      if (!r.ok) continue;
      const draft = drafts.find((d) => d.platformId === r.platformId);
      if (draft) await closeEditorTab(draft);
    }
  }
  return { drafts, results, errors, warnings };
}

/** 对外入口：带 SW 保活心跳的发布管线（防长任务中途被 Chrome 空闲回收） */
async function handleAutoPublishPipeline(article: Article, platformIds: PlatformId[], aiRewrite: boolean, semiAuto: boolean): Promise<{
  drafts: DraftRef[];
  results: PublishResult[];
  errors: Record<string, string>;
  warnings: Record<string, string>;
}> {
  // 每轮发布先清空进度（内存 + 落盘），避免上一轮的残留进度被误当成本次结果
  currentProgress = {} as any;
  try {
    const p = chrome.storage.local.remove(PUB_PROGRESS_KEY) as unknown as Promise<void> | undefined;
    if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
  } catch { /* ignore */ }
  startPublishKeepAlive();
  try {
    return await runAutoPublishPipeline(article, platformIds, aiRewrite, semiAuto);
  } finally {
    stopPublishKeepAlive();
  }
}
