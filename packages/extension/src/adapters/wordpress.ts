import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { store } from '../store';
import { uploadMultipart } from '../offscreen/client';
import { md2html } from './md2html';
import { processImages, dataUriToBlob, ImageUploadResult } from './api-base';
import { previewOf } from './utils';

/** WordPress  REST /wp/v2/media 上传单张图片（正文内嵌图转存用） */
async function uploadWpImage(endpoint: string, authHeader: string, blob: Blob): Promise<string> {
  const form = new FormData();
  form.append('file', blob, `image_${Date.now()}.jpg`);
  const res = await fetch(`${endpoint}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: { Authorization: authHeader },
    body: form,
  });
  if (!res.ok) throw new Error(`WordPress 图片上传失败：HTTP ${res.status}`);
  const json = await res.json().catch(() => null);
  if (!json?.source_url) throw new Error('WordPress 图片上传响应缺少 source_url');
  return json.source_url;
}

export const wordpressAdapter: PlatformAdapter = {
  id: 'wordpress',
  name: 'WordPress',
  region: 'domestic',
  contentTypes: ['article', 'text', 'image'],
  route: 'official',
  stylePrompt: '博客风格：通用博客，结构清晰，正式得体。',
  mode: 'official',

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const settings = await store.getSettings();
      const wp = settings.wordpress;
      if (!wp?.endpoint || !wp?.username) {
        return { loggedIn: false };
      }

      const cleanUrl = wp.endpoint.replace(/\/+$/, '');
      const authHeader = 'Basic ' + btoa(`${wp.username}:${wp.appPassword || ''}`);
      const res = await fetch(`${cleanUrl}/wp-json/wp/v2/users/me`, {
        headers: {
          'Authorization': authHeader
        }
      });

      if (res.ok) {
        const json = await res.json();
        return {
          loggedIn: true,
          account: json.name || wp.username,
          avatar: json.avatar_urls?.['96']
        };
      }
      return { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem, onProgress?: (p: number) => void): Promise<MediaRef> {
    const settings = await store.getSettings();
    const wp = settings.wordpress;
    if (!wp?.endpoint) throw new Error('WordPress not configured');

    const cleanUrl = wp.endpoint.replace(/\/+$/, '');
    const authHeader = 'Basic ' + btoa(`${wp.username}:${wp.appPassword || ''}`);

    onProgress?.(10);
    if (!media.dataUrl) throw new Error(`「${media.name}」缺少媒体数据，无法上传`);

    // 经 offscreen 上传（长生命周期 + 真实进度），避免 SW 休眠中断
    const res = await uploadMultipart(
      `${cleanUrl}/wp-json/wp/v2/media`,
      [{ name: 'file', filename: media.name, type: media.type, dataUrl: media.dataUrl }],
      {
        headers: { 'Authorization': authHeader },
        onProgress,
        timeoutMs: 300000
      },
    );

    if (!res.ok) {
      throw new Error(`WordPress media upload failed: ${res.error || `HTTP ${res.status}`}`);
    }

    let json: any;
    try {
      json = JSON.parse(res.responseText || '{}');
    } catch {
      json = {};
    }
    onProgress?.(100);
    return {
      id: String(json.id || Date.now()),
      url: json.source_url || '',
      type: media.type
    };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    const settings = await store.getSettings();
    const wp = settings.wordpress;
    if (!wp?.endpoint) throw new Error('WordPress endpoint not configured');

    const cleanUrl = wp.endpoint.replace(/\/+$/, '');
    const authHeader = 'Basic ' + btoa(`${wp.username}:${wp.appPassword || ''}`);

    // WordPress REST content 是 HTML（不是 Markdown）：md2html 转换后再统一转存正文图片，
    // 否则裸 Markdown 原样发布，前台显示 ## / ** 等原始标记
    let content = md2html(article.body || '');
    content = await processImages(
      content,
      async (src): Promise<ImageUploadResult> => {
        const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await fetch(src).then((r) => r.blob());
        const url = await uploadWpImage(cleanUrl, authHeader, blob);
        return { url };
      },
      { skipPatterns: [new URL(cleanUrl).hostname] },
    );
    // 将已上传媒体引用追加到正文（媒体管线：uploadMedia → mediaRefs → 草稿内容）
    if (article.mediaRefs?.length) {
      content += '\n' + article.mediaRefs
        .filter((m) => m.url)
        .map((m) => `<img src="${m.url}" alt="" />`)
        .join('\n');
    }

    const finalTitle = article.title?.trim() || previewOf(article.body, 30) || 'WordPress 文章';
    const res = await fetch(`${cleanUrl}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: finalTitle,
        content,
        status: 'draft'
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to create WP draft: ${err}`);
    }

    const json = await res.json();
    return {
      platformId: 'wordpress',
      draftId: String(json.id),
      title: json.title?.rendered || finalTitle,
      url: json.link,
      previewText: article.body.slice(0, 80)
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    const settings = await store.getSettings();
    const wp = settings.wordpress;
    if (!wp?.endpoint) throw new Error('WordPress endpoint not configured');

    const cleanUrl = wp.endpoint.replace(/\/+$/, '');
    const authHeader = 'Basic ' + btoa(`${wp.username}:${wp.appPassword || ''}`);

    const res = await fetch(`${cleanUrl}/wp-json/wp/v2/posts/${draft.draftId}`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        status: 'publish'
      })
    });

    if (!res.ok) {
      const err = await res.text();
      return {
        platformId: 'wordpress',
        ok: false,
        error: `Publish failed: ${err}`,
        timestamp: Date.now()
      };
    }

    const json = await res.json();
    return {
      platformId: 'wordpress',
      ok: true,
      url: json.link,
      draftId: draft.draftId,
      timestamp: Date.now()
    };
  }
};
