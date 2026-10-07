/**
 * B站 adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用 B站私有 API：
 *  1. checkLogin: GET https://api.bilibili.com/x/web-interface/nav
 *                 + 读 cookie bili_jct 作为 CSRF（发布/传图必需）
 *  2. 图片上传:   POST https://api.bilibili.com/x/article/creative/article/upcover（FormData）
 *  3. 存草稿:     POST https://api.bilibili.com/x/article/creative/draft/addupdate（save:'0'）
 *  4. 发布:       草稿语义——不自动直发，返回草稿编辑页链接。
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（member.bilibili.com），用完即删。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson, getCookie } from './api-client';
import { processImages, dataUriToBlob, pubResult } from './api-base';
import { md2html } from './md2html';
import { previewOf } from './utils';

const BILI_RULES = [
  {
    urlFilter: '*://api.bilibili.com/*',
    headers: { Origin: 'https://member.bilibili.com', Referer: 'https://member.bilibili.com/' },
  },
];

/** 读取 B站 CSRF（cookie bili_jct；兼容带/不带前导点两种 domain 写法） */
export async function getBiliCsrf(): Promise<string> {
  const v = (await getCookie('.bilibili.com', 'bili_jct')) || (await getCookie('bilibili.com', 'bili_jct'));
  return v || '';
}

/** 上传单张图片到 B站图床（FormData：binary + csrf） */
export async function uploadBiliImage(blob: Blob, csrf: string): Promise<string> {
  const form = new FormData();
  form.append('binary', blob, 'image.jpg');
  form.append('csrf', csrf);
  const res = await apiFetch('https://api.bilibili.com/x/article/creative/article/upcover', {
    method: 'POST',
    body: form,
  });
  const json = await parseJson<{ code?: number; message?: string; data?: { url?: string } }>(res, 'B站图片上传');
  if (json.code !== 0 || !json.data?.url) throw new Error(json.message || 'B站图片上传失败');
  return json.data.url;
}

export const bilibiliAdapter: PlatformAdapter = {
  id: 'bilibili',
  name: '哔哩哔哩',
  region: 'domestic',
  contentTypes: ['video', 'image', 'text', 'article'],
  route: 'session',
  stylePrompt: 'B站专栏风格：图文并茂，语气轻松活泼，善用小标题分段，可加"一键三连"式互动引导。注意：正文需在 200 字以上（过短会被平台拒收），不超过 20000 字。',
  mode: 'api',
  homepage: 'https://member.bilibili.com/platform/upload/text',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const res = await apiFetch('https://api.bilibili.com/x/web-interface/nav?build=0&mobi_app=web');
      const json = await parseJson<{
        code?: number;
        data?: { isLogin?: boolean; uname?: string; face?: string; mid?: number };
      }>(res, 'B站登录检测');
      if (json.code === 0 && json.data?.isLogin) {
        return { loggedIn: true, account: json.data.uname, username: json.data.uname, avatar: json.data.face };
      }
      return { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    const csrf = await getBiliCsrf();
    if (!csrf) throw new Error('B站 CSRF 未获取，请先登录 B 站');
    const blob = await dataUriToBlob(media.dataUrl || '');
    const url = await withHeaderRules(BILI_RULES, () => uploadBiliImage(blob, csrf));
    return { id: 'bili_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(BILI_RULES, async () => {
      const csrf = await getBiliCsrf();
      if (!csrf) throw new Error('B站 CSRF 未获取，请先登录 B 站');

      // 1. markdown → HTML；正文图片（data: 或远程）上传到 B站图床
      let content = md2html(article.body || '');
      content = await processImages(content, async (src) => {
        const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
        const url = await uploadBiliImage(blob, csrf);
        return { url };
      }, { skipPatterns: ['hdslb.com', 'bilibili.com', 'biliimg.com'] });

      // 2. 追加 uploadMedia 阶段已上传的本地媒体
      for (const ref of article.mediaRefs || []) {
        if (ref.url) content += `<p><img src="${ref.url}" /></p>`;
      }

      // 3. 保存草稿（save:'0' = 仅草稿不发布）
      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || 'B站专栏';
      const res = await apiFetch('https://api.bilibili.com/x/article/creative/draft/addupdate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          tid: '4',
          title: finalTitle,
          content,
          csrf,
          save: '0',
          pgc_id: '0',
        }),
      });
      const json = await parseJson<{ code?: number; message?: string; data?: { aid?: number } }>(res, 'B站保存草稿');
      if (json.code !== 0 || !json.data?.aid) throw new Error(json.message || 'B站保存草稿失败');
      const aid = json.data.aid;

      return {
        platformId: 'bilibili',
        draftId: String(aid),
        title: finalTitle,
        url: `https://member.bilibili.com/platform/upload/text/edit?aid=${aid}`,
        previewText: previewOf(article.body),
        body: content,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：addupdate 已存草稿，直接返回成功与草稿链接（不自动直发）
    return pubResult('bilibili', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
