import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { ensureEditorTab, sendToTab, TAB_PATTERNS, previewOf } from './utils';

export const xiaohongshuAdapter: PlatformAdapter = {
  id: 'xiaohongshu',
  name: '小红书',
  region: 'domestic',
  contentTypes: ['image', 'video', 'text'],
  route: 'session',
  stylePrompt: '小红书风格：口语化种草口吻，多用 emoji，分段短，结尾加 3~5 个 #话题标签。注意：小红书不支持 Markdown，严禁出现 # 标题或 **加粗** 等 Markdown 标记，用空行和 emoji 排版。',
  mode: 'session',

  async checkLogin(): Promise<PlatformAccount> {
    try {
      // 1. 优先从已打开的创作者标签页注入脚本获取真实用户名
      const tabs = await chrome.tabs.query({ url: TAB_PATTERNS.xiaohongshu });
      if (tabs.length > 0 && tabs[0].id) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => {
            const nameEl = document.querySelector('.user-name') || document.querySelector('.name-box');
            const hasLoginForm = !!document.querySelector('input[placeholder*="手机号"], input[type="password"]');
            // 头像/用户名存在且无登录框 → 已登录
            return {
              loggedIn: !!nameEl && !hasLoginForm,
              account: nameEl?.textContent?.trim() || undefined
            };
          }
        });
        if (results?.[0]?.result?.loggedIn) {
          return results[0].result;
        }
      }

      // 2. 兜底探测：未打开标签页时，检查浏览器小红书域的关键 Session Cookie (web_session)
      try {
        const cookiePromise = chrome.cookies.getAll({ domain: 'xiaohongshu.com' });
        const timeoutPromise = new Promise<chrome.cookies.Cookie[]>((resolve) => setTimeout(() => resolve([]), 500));
        const cookies = await Promise.race([cookiePromise, timeoutPromise]);
        const hasSession = cookies.some((c) => (c.name === 'web_session' || c.name === 'websectoken') && !!c.value);
        if (hasSession) {
          return { loggedIn: true, account: '小红书创作者' };
        }
      } catch { /* ignore cookie permission fallback */ }

      return { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem, onProgress?: (p: number) => void): Promise<MediaRef> {
    // 真实媒体管线：打开/复用小红书创作者后台 → 注入 file input（浏览器接管上传）
    onProgress?.(10);
    const tab = await ensureEditorTab(TAB_PATTERNS.xiaohongshu, 'https://creator.xiaohongshu.com/publish/publish', { active: false });
    if (!tab.id) throw new Error('小红书标签页不可用');

    const res = await sendToTab<{ ok: boolean; injected?: number; error?: string }>(tab.id, {
      type: 'XHS_INJECT_MEDIA',
      payload: { media: [{ name: media.name, type: media.type, dataUrl: media.dataUrl }] }
    });
    if (!res?.ok) {
      throw new Error(res?.error || '小红书图片注入失败');
    }
    onProgress?.(100);
    return {
      id: 'xhs_media_' + Date.now(),
      url: 'injected://xiaohongshu/' + encodeURIComponent(media.name),
      type: media.type
    };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    const tab = await ensureEditorTab(TAB_PATTERNS.xiaohongshu, 'https://creator.xiaohongshu.com/publish/publish', { active: false });
    if (!tab.id) throw new Error('小红书标签页不可用');

    const res = await sendToTab<{ ok: boolean; draftId?: string; error?: string }>(tab.id, {
      type: 'XHS_INJECT_DRAFT',
      payload: { title: article.title, body: article.body }
    });
    if (!res?.ok) {
      throw new Error(res?.error || '小红书内容注入失败');
    }

    return {
      platformId: 'xiaohongshu',
      draftId: res.draftId || ('xhs_' + Date.now()),
      title: article.title || '小红书笔记草稿',
      url: 'https://creator.xiaohongshu.com/publish/publish',
      previewText: previewOf(article.body),
      body: article.body,
      tabId: tab.id,
      createdAt: Date.now()
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    let tabId = draft.tabId;
    if (!tabId) {
      const tabs = await chrome.tabs.query({ url: TAB_PATTERNS.xiaohongshu });
      tabId = tabs[0]?.id;
    }
    if (!tabId) {
      return { platformId: 'xiaohongshu', ok: false, error: '未找到小红书页面，请先生成草稿', timestamp: Date.now() };
    }
    try {
      const res = await sendToTab<{ ok: boolean; url?: string; error?: string }>(tabId, {
        type: 'XHS_CONFIRM_PUBLISH',
        draftId: draft.draftId
      });
      if (!res?.ok) {
        return { platformId: 'xiaohongshu', ok: false, error: res?.error || '小红书发布失败', timestamp: Date.now() };
      }
      return {
        platformId: 'xiaohongshu',
        ok: true,
        url: res.url || 'https://creator.xiaohongshu.com/publish/publish',
        timestamp: Date.now()
      };
    } catch (e: any) {
      return { platformId: 'xiaohongshu', ok: false, error: e?.message || '小红书发布异常', timestamp: Date.now() };
    }
  }
};
