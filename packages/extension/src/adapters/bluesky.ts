/**
 * Bluesky adapter —— AT Protocol API 直连（official 路线）。
 *
 * Bluesky 无"草稿"概念，语义同 Telegram：createDraft 本地保存，publish 阶段真实发帖。
 * 发帖走 com.atproto 三件套：
 *   1. createSession：identifier（handle/email）+ appPassword 换 accessJwt + did
 *   2. uploadBlob：图片二进制 → blob ref（发帖 embed.images 用）
 *   3. createRecord：collection app.bsky.feed.post 发布正文（+ embed 图）
 *
 * 配置：设置面板填 handle/email + app password（在 Bluesky「设置→应用密码」生成，非登录密码）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { store } from '../store';
import { dataUriToBlob, pubResult } from './api-base';
import { previewOf } from './utils';

const BSKY_BASE = 'https://bsky.social';
const MAX_POST_GRAPHEMES = 300; // Bluesky 单帖 300 字素上限

interface BskySession {
  accessJwt: string;
  did: string;
  handle: string;
}

/** 用 app password 建立会话 */
async function createSession(identifier: string, appPassword: string): Promise<BskySession> {
  const res = await fetch(`${BSKY_BASE}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: appPassword }),
  });
  if (!res.ok) {
    let msg = `登录失败（HTTP ${res.status}）`;
    try {
      const j = await res.json();
      msg = j?.message || j?.error || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const json = await res.json();
  if (!json?.accessJwt || !json?.did) throw new Error('Bluesky 会话响应缺少 accessJwt/did');
  return { accessJwt: json.accessJwt, did: json.did, handle: json.handle || identifier };
}

interface CachedBskySession {
  identifier: string;
  session: BskySession;
  expiresAt: number;
}
let cachedSession: CachedBskySession | null = null;

async function getOrRenewSession(identifier: string, appPassword: string): Promise<BskySession> {
  if (cachedSession && cachedSession.identifier === identifier && Date.now() < cachedSession.expiresAt) {
    return cachedSession.session;
  }
  const session = await createSession(identifier, appPassword);
  cachedSession = { identifier, session, expiresAt: Date.now() + 30 * 60 * 1000 };
  return session;
}


/** 上传单张图片，返回 blob ref */
async function uploadBlob(accessJwt: string, dataUrl: string): Promise<any> {
  const blob = await dataUriToBlob(dataUrl);
  const res = await fetch(`${BSKY_BASE}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: {
      'Content-Type': blob.type || 'image/jpeg',
      Authorization: `Bearer ${accessJwt}`,
    },
    body: blob,
  });
  if (!res.ok) throw new Error(`图片上传失败（HTTP ${res.status}）`);
  const json = await res.json();
  if (!json?.blob) throw new Error('图片上传响应缺少 blob');
  return json.blob;
}

/** 发帖：正文 + 可选 embed 图片 */
async function createPost(session: BskySession, text: string, mediaRefs: MediaRef[]): Promise<string> {
  const record: Record<string, any> = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
  };

  // 图片 embed（最多 4 张，Bluesky 单帖上限）
  const images = mediaRefs.filter((m) => m.dataUrl).slice(0, 4);
  if (images.length > 0) {
    const imgs = [];
    for (const m of images) {
      const blob = await uploadBlob(session.accessJwt, m.dataUrl!);
      imgs.push({ image: blob, alt: m.type || '' });
    }
    record.embed = { $type: 'app.bsky.embed.images', images: imgs };
  }

  const res = await fetch(`${BSKY_BASE}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record,
    }),
  });
  if (!res.ok) {
    let msg = `发帖失败（HTTP ${res.status}）`;
    try { const j = await res.json(); msg = j?.message || j?.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const json = await res.json();
  if (!json?.uri) throw new Error('发帖响应缺少 uri');
  return json.uri;
}

/** 从 at:// URI 推导帖子可点击链接 */
function postUrlFromUri(uri: string, handle: string): string {
  const rkey = uri.split('/').pop() || '';
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

/** 截断到 300 字素（用码点计数近似，避免破坏代理对） */
function truncateToGraphemes(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join('');
}

export const blueskyAdapter: PlatformAdapter = {
  id: 'bluesky',
  name: 'Bluesky',
  region: 'international',
  contentTypes: ['text', 'image'],
  route: 'official',
  stylePrompt: 'Bluesky 风格：用英文（English）输出，300 字素内精炼表达，社区友好，去中心化口吻，可带简短观点。',
  mode: 'official',
  capabilities: ['image_upload'],
  noRemoteDraft: true, // Bluesky 无草稿概念：createDraft 仅本地暂存，半自动模式必须拦截

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const s = await store.getSettings();
      const b = s.bluesky;
      if (!b?.identifier || !b?.appPassword) return { loggedIn: false };
      const session = await getOrRenewSession(b.identifier, b.appPassword);
      return { loggedIn: true, account: session.handle, username: session.handle };
    } catch {
      cachedSession = null;
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem, onProgress?: (p: number) => void): Promise<MediaRef> {
    // Bluesky 无草稿：媒体登记引用保留 dataUrl，publish 阶段 uploadBlob + createRecord 一起真实发
    onProgress?.(100);
    return { id: 'bsky_media_' + Date.now(), url: 'pending://bluesky/' + encodeURIComponent(media.name), type: media.type, dataUrl: media.dataUrl };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    const s = await store.getSettings();
    if (!s.bluesky?.identifier || !s.bluesky?.appPassword) {
      throw new Error('Bluesky 未配置：请先在设置面板填写 handle/email 与 app password');
    }
    return {
      platformId: 'bluesky',
      draftId: 'bsky_' + Date.now(),
      title: article.title || 'Bluesky 帖子',
      previewText: previewOf(article.body),
      body: article.body,
      mediaRefs: article.mediaRefs,
      createdAt: Date.now(),
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    try {
      const s = await store.getSettings();
      const b = s.bluesky;
      if (!b?.identifier || !b?.appPassword) {
        return pubResult('bluesky', false, { error: 'Bluesky 未配置：请先在设置面板填写 handle/email 与 app password' });
      }

      let session: BskySession;
      try {
        session = await getOrRenewSession(b.identifier, b.appPassword);
      } catch {
        cachedSession = null;
        session = await createSession(b.identifier, b.appPassword);
        cachedSession = { identifier: b.identifier, session, expiresAt: Date.now() + 30 * 60 * 1000 };
      }

      const text = truncateToGraphemes(draft.body || '', MAX_POST_GRAPHEMES);
      if (!text.trim()) return pubResult('bluesky', false, { error: '帖子内容为空' });

      const mediaRefs = (draft.mediaRefs || []).filter((m) => m.dataUrl);
      const uri = await createPost(session, text, mediaRefs);
      return pubResult('bluesky', true, { url: postUrlFromUri(uri, session.handle) });
    } catch (e: any) {
      cachedSession = null;
      return pubResult('bluesky', false, { error: e?.message || 'Bluesky 发帖失败' });
    }
  },
};
