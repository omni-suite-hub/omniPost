/**
 * Mastodon adapter —— 开放 REST API 直连（official 路线）。
 *
 * Mastodon 无"草稿"概念：createDraft 本地保存，publish 阶段真实发帖。
 *   1. verify_credentials：access token 校验登录（拿用户名）
 *   2. media：图片二进制上传 → media_id
 *   3. statuses：发 toot（status + media_ids[]）
 *
 * 配置：设置面板填实例地址（如 mastodon.social）+ access token
 * （在 Mastodon「设置→开发→新应用」创建，勾选 write:statuses / write:media 权限）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { store } from '../store';
import { dataUriToBlob, pubResult } from './api-base';
import { previewOf } from './utils';

const MAX_TOOT_CHARS = 500; // Mastodon 默认 500 字（实例可配，先按默认）

/** 规范化实例地址：补 https://、去尾斜杠 */
export function normalizeInstance(instance: string): string {
  let u = (instance || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

/** 上传单张图片，返回 media_id */
async function uploadMediaFile(instance: string, accessToken: string, dataUrl: string): Promise<string> {
  const blob = await dataUriToBlob(dataUrl);
  const form = new FormData();
  form.append('file', blob, 'upload');
  const res = await fetch(`${instance}/api/v1/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`图片上传失败（HTTP ${res.status}）`);
  const json = await res.json();
  if (!json?.id) throw new Error('图片上传响应缺少 id');
  return String(json.id);
}

/** 截断到 N 码点 */
function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

export const mastodonAdapter: PlatformAdapter = {
  id: 'mastodon',
  name: 'Mastodon',
  region: 'international',
  contentTypes: ['text', 'image'],
  route: 'official',
  stylePrompt: 'Mastodon 风格：用英文（English）输出，联邦宇宙社区口吻，友善克制，500 字内，可带 #话题。',
  mode: 'official',
  capabilities: ['image_upload'],
  noRemoteDraft: true, // Mastodon 无草稿概念：createDraft 仅本地暂存，半自动模式必须拦截

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const s = await store.getSettings();
      const m = s.mastodon;
      const instance = normalizeInstance(m?.instance || '');
      if (!instance || !m?.accessToken) return { loggedIn: false };
      const res = await fetch(`${instance}/api/v1/accounts/verify_credentials`, {
        headers: { Authorization: `Bearer ${m.accessToken}` },
      });
      if (!res.ok) return { loggedIn: false };
      const json = await res.json();
      return { loggedIn: true, account: `@${json.username}`, username: json.display_name || json.username };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem, onProgress?: (p: number) => void): Promise<MediaRef> {
    onProgress?.(100);
    return { id: 'mastodon_media_' + Date.now(), url: 'pending://mastodon/' + encodeURIComponent(media.name), type: media.type, dataUrl: media.dataUrl };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    const s = await store.getSettings();
    const instance = normalizeInstance(s.mastodon?.instance || '');
    if (!instance || !s.mastodon?.accessToken) {
      throw new Error('Mastodon 未配置：请先在设置面板填写实例地址与 access token');
    }
    return {
      platformId: 'mastodon',
      draftId: 'mastodon_' + Date.now(),
      title: article.title || 'Mastodon 帖子',
      previewText: previewOf(article.body),
      body: article.body,
      mediaRefs: article.mediaRefs,
      createdAt: Date.now(),
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    try {
      const s = await store.getSettings();
      const instance = normalizeInstance(s.mastodon?.instance || '');
      const token = s.mastodon?.accessToken || '';
      if (!instance || !token) {
        return pubResult('mastodon', false, { error: 'Mastodon 未配置：请先在设置面板填写实例地址与 access token' });
      }

      const status = truncateChars(draft.body || '', MAX_TOOT_CHARS);
      if (!status.trim()) return pubResult('mastodon', false, { error: '帖子内容为空' });

      // 先传图拿 media_id，再发 status
      const mediaRefs = (draft.mediaRefs || []).filter((m) => m.dataUrl);
      const mediaIds: string[] = [];
      for (const m of mediaRefs) {
        mediaIds.push(await uploadMediaFile(instance, token, m.dataUrl!));
      }

      const form = new URLSearchParams();
      form.append('status', status);
      for (const id of mediaIds) form.append('media_ids[]', id);

      const res = await fetch(`${instance}/api/v1/statuses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      if (!res.ok) {
        let msg = `发帖失败（HTTP ${res.status}）`;
        try { const j = await res.json(); msg = j?.error || msg; } catch { /* ignore */ }
        return pubResult('mastodon', false, { error: msg });
      }
      const json = await res.json();
      return pubResult('mastodon', true, { url: json?.url || `${instance}/@${json?.account?.username}` });
    } catch (e: any) {
      return pubResult('mastodon', false, { error: e?.message || 'Mastodon 发帖失败' });
    }
  },
};
