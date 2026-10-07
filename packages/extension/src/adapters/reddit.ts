/**
 * Reddit adapter —— session cookie 直连（official 路线，对标"文章同步助手"的 cookie 直发模式）。
 *
 * 不申请 OAuth，直接复用浏览器里已登录的 Reddit 会话（reddit_session cookie）：
 *   1. api/me.json：拿用户名 + modhash（发帖 CSRF token），无 name 即未登录
 *   2. api/submit：kind=self 文本帖发布到指定 subreddit（sr），带 uh=modhash
 *
 * 配置：设置面板填目标板块（subreddit，如 "test" 或 "u_用户名" 发个人主页）。
 * 文本帖（self）不支持内嵌图片（Reddit 图片需独立 media 上传），正文中图片以链接形式保留。
 */
import { PlatformAdapter, Article, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { store } from '../store';
import { pubResult } from './api-base';
import { previewOf } from './utils';

const REDDIT_BASE = 'https://www.reddit.com';
const MAX_TITLE_CHARS = 300;
const MAX_BODY_CHARS = 40000;

interface CachedRedditMe {
  data: { name: string; modhash: string };
  expiresAt: number;
}
let cachedRedditMe: CachedRedditMe | null = null;

/** 从 Reddit web API 拿登录态 + modhash */
async function fetchMe(forceRefresh = false): Promise<{ name: string; modhash: string }> {
  if (!forceRefresh && cachedRedditMe && Date.now() < cachedRedditMe.expiresAt) {
    return cachedRedditMe.data;
  }
  const res = await fetch(`${REDDIT_BASE}/api/me.json`, { credentials: 'include' });
  if (!res.ok) {
    cachedRedditMe = null;
    throw new Error(`Reddit 未登录（HTTP ${res.status}）`);
  }
  const json = await res.json();
  const name = json?.data?.name;
  if (!name) {
    cachedRedditMe = null;
    throw new Error('Reddit 未登录（无用户名）');
  }
  const data = { name, modhash: json?.data?.modhash || '' };
  cachedRedditMe = { data, expiresAt: Date.now() + 60 * 1000 };
  return data;
}

export const redditAdapter: PlatformAdapter = {
  id: 'reddit',
  name: 'Reddit',
  region: 'international',
  contentTypes: ['text'],
  route: 'official',
  stylePrompt: 'Reddit 风格：用英文（English）输出，标题直白有话题性，正文结构化，可带 markdown 列表，社区交流口吻。',
  mode: 'official',
  noRemoteDraft: true, // Reddit 无草稿概念：createDraft 仅本地暂存，半自动模式必须拦截

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const { name } = await fetchMe();
      return { loggedIn: true, account: `u/${name}`, username: name };
    } catch {
      return { loggedIn: false };
    }
  },

  // Reddit 文本帖无草稿/媒体上传：正文图片以链接形式保留在 text 中
  async createDraft(article: Article): Promise<DraftRef> {
    const s = await store.getSettings();
    if (!s.reddit?.subreddit) {
      throw new Error('Reddit 未配置：请先在设置面板填写目标板块（subreddit）');
    }
    const finalTitle = article.title?.trim() || previewOf(article.body, 30) || 'Reddit Post';
    return {
      platformId: 'reddit',
      draftId: 'reddit_' + Date.now(),
      title: finalTitle,
      previewText: previewOf(article.body),
      body: article.body,
      mediaRefs: [],
      createdAt: Date.now(),
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    try {
      const s = await store.getSettings();
      let subreddit = (s.reddit?.subreddit || '').trim().replace(/^r\//, '');

      const { name, modhash } = await fetchMe();
      if (!subreddit) {
        subreddit = `u_${name}`;
      }
      if (!subreddit) {
        return pubResult('reddit', false, { error: 'Reddit 未配置：请在设置面板填写目标板块（subreddit）' });
      }

      const title = Array.from(draft.title || 'Untitled').slice(0, MAX_TITLE_CHARS).join('');
      const text = Array.from(draft.body || '').slice(0, MAX_BODY_CHARS).join('');
      if (!title.trim()) return pubResult('reddit', false, { error: '帖子标题为空' });

      const form = new URLSearchParams();
      form.append('sr', subreddit);
      form.append('title', title);
      form.append('kind', 'self');
      form.append('text', text);
      form.append('api_type', 'json');
      form.append('resubmit', 'true');
      form.append('sendreplies', 'false');
      if (modhash) form.append('uh', modhash);

      const res = await fetch(`${REDDIT_BASE}/api/submit`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      if (!res.ok) {
        return pubResult('reddit', false, { error: `发帖失败（HTTP ${res.status}）` });
      }
      const json = await res.json();
      const errors = json?.json?.errors || [];
      if (errors.length > 0) {
        const msg = errors.map((e: any) => (Array.isArray(e) ? e[1] : String(e))).join('；');
        return pubResult('reddit', false, { error: msg || '发帖被拒' });
      }
      const url = json?.json?.data?.url || `https://www.reddit.com/r/${subreddit}`;
      return pubResult('reddit', true, { url });
    } catch (e: any) {
      return pubResult('reddit', false, { error: e?.message || 'Reddit 发帖失败' });
    }
  },
};
