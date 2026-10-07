import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { ensureEditorTab, sendToTab, TAB_PATTERNS, previewOf } from './utils';

export const twitterAdapter: PlatformAdapter = {
  id: 'twitter',
  name: 'X (Twitter)',
  region: 'international',
  contentTypes: ['text', 'image', 'video'],
  route: 'session',
  stylePrompt: 'X/Twitter 风格：用英文（English）输出，极度精炼（280 字内），观点犀利，善用短句与留白。纯文本，不支持 Markdown。',
  mode: 'session',

  async checkLogin(): Promise<PlatformAccount> {
    try {
      // 中英文界面都兼容：账号菜单按钮 / 侧栏账号切换按钮，二者任一存在即已登录
      // 注意：*://*.x.com/* 不匹配裸域 x.com，TAB_PATTERNS 已同时给出裸域与子域
      const tabs = await chrome.tabs.query({ url: TAB_PATTERNS.twitter });
      const twitterTabs = tabs.length > 0 ? tabs : await chrome.tabs.query({ url: TAB_PATTERNS.twitterAlt });
      if (twitterTabs.length > 0 && twitterTabs[0].id) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: twitterTabs[0].id },
          func: () => {
            const accountMenu = document.querySelector(
              '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AccountSwitcher_Button"], ' +
              'button[aria-label="Account menu"], button[aria-label="账号菜单"]',
            );
            const loggedOutPrompt = document.querySelector('[data-testid="loginButton"], [href="/login"][role="link"]');
            return {
              loggedIn: !!accountMenu && !loggedOutPrompt,
              account: accountMenu ? 'X 用户' : undefined
            };
          }
        });
        if (results?.[0]?.result?.loggedIn) {
          return results[0].result;
        }
      }

      // 2. 兜底探测：未打开标签页时，检查浏览器 x.com / twitter.com 域的关键鉴权 Cookie (auth_token)
      try {
        const cookiePromise = Promise.all([
          chrome.cookies.getAll({ domain: 'x.com' }),
          chrome.cookies.getAll({ domain: '.x.com' }),
          chrome.cookies.getAll({ domain: 'twitter.com' }),
          chrome.cookies.getAll({ domain: '.twitter.com' }),
        ]).then((lists) => lists.flat());
        const timeoutPromise = new Promise<chrome.cookies.Cookie[]>((resolve) => setTimeout(() => resolve([]), 3000));
        const cookies = await Promise.race([cookiePromise, timeoutPromise]);
        const hasAuth = cookies.some((c) => c.name === 'auth_token' && !!c.value);
        if (hasAuth) {
          return { loggedIn: true, account: 'X 用户' };
        }
      } catch { /* ignore cookie permission fallback */ }

      return { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem, onProgress?: (p: number) => void): Promise<MediaRef> {
    // 真实媒体管线：打开/复用 X 发帖页 → 注入 file input（浏览器接管上传）
    onProgress?.(10);
    const tab = await ensureEditorTab('*://x.com/compose/post*', 'https://x.com/compose/post', { active: false });
    if (!tab.id) throw new Error('X 标签页不可用');

    const res = await sendToTab<{ ok: boolean; injected?: number; error?: string }>(tab.id, {
      type: 'TWITTER_INJECT_MEDIA',
      payload: { media: [{ name: media.name, type: media.type, dataUrl: media.dataUrl }] }
    });
    if (!res?.ok) {
      throw new Error(res?.error || 'X 图片注入失败');
    }
    onProgress?.(100);
    return {
      id: 'tw_media_' + Date.now(),
      url: 'injected://twitter/' + encodeURIComponent(media.name),
      type: media.type
    };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    // 真实打开发帖页并注入（x.com/compose/post 支持直接打开发帖框）
    const tab = await ensureEditorTab('*://x.com/compose/post*', 'https://x.com/compose/post', { active: false });
    if (!tab.id) throw new Error('X 标签页不可用');

    const res = await sendToTab<{ ok: boolean; draftId?: string; error?: string }>(tab.id, {
      type: 'TWITTER_INJECT_DRAFT',
      payload: { title: article.title, body: article.body }
    });
    if (!res?.ok) {
      throw new Error(res?.error || 'X 内容注入失败');
    }

    return {
      platformId: 'twitter',
      draftId: res.draftId || ('tw_' + Date.now()),
      title: article.title || '推文草稿',
      url: 'https://x.com/compose/post',
      previewText: previewOf(article.body),
      body: article.body,
      tabId: tab.id,
      createdAt: Date.now()
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    let target: chrome.tabs.Tab | undefined;
    if (draft.tabId) {
      try {
        target = await chrome.tabs.get(draft.tabId);
      } catch {
        target = undefined;
      }
    }
    if (!target?.id) {
      const tabs = await chrome.tabs.query({ url: '*://x.com/compose/post*' });
      const fallback = await chrome.tabs.query({ url: TAB_PATTERNS.twitter });
      target = tabs[0] || fallback[0];
    }
    if (!target?.id) {
      return { platformId: 'twitter', ok: false, error: '未找到 X 页面，请先生成草稿', timestamp: Date.now() };
    }
    try {
      const res = await sendToTab<{ ok: boolean; url?: string; error?: string }>(target.id, {
        type: 'TWITTER_CONFIRM_PUBLISH',
        draftId: draft.draftId
      });
      if (!res?.ok) {
        return { platformId: 'twitter', ok: false, error: res?.error || 'X 发布失败', timestamp: Date.now() };
      }
      return { platformId: 'twitter', ok: true, url: res.url || 'https://x.com', timestamp: Date.now() };
    } catch (e: any) {
      return { platformId: 'twitter', ok: false, error: e?.message || 'X 发布异常', timestamp: Date.now() };
    }
  }
};
