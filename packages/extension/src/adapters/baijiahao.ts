/**
 * 百家号 (baijiahao) adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用 baijiahao.baidu.com 私有 API：
 *  1. checkLogin: GET /builder/app/appinfo → { errmsg:'success', data.user }
 *  2. authToken:  从 /builder/rc/edit 页面 HTML 挖 window.__BJH__INIT__AUTH__
 *  3. 图片上传:   FormData(media) → POST /pcui/picture/uploadproxy → ret.https_url
 *  4. 建草稿:     POST /pcui/article/save?callback=bjhdraft（JSONP 剥壳），token 头
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（baijiahao.baidu.com）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson } from './api-client';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { md2html } from './md2html';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://baijiahao.baidu.com/*', headers: { Origin: 'https://baijiahao.baidu.com', Referer: 'https://baijiahao.baidu.com/' } },
];

interface BaijiahaoUser {
  userid: string;
  name: string;
  avatar: string;
}

let cachedUser: BaijiahaoUser | null = null;
let cachedAuthToken = '';

/** 从 /builder/rc/edit 页面挖会话 token（页面会话级，登录态失效需重新获取） */
async function fetchAuthToken(): Promise<string> {
  if (cachedAuthToken) return cachedAuthToken;
  const res = await apiFetch('https://baijiahao.baidu.com/builder/rc/edit');
  const html = await res.text();
  const match = html.match(/window\.__BJH__INIT__AUTH__\s*=\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error('登录失效，请重新登录百家号');
  cachedAuthToken = match[1];
  return cachedAuthToken;
}

async function ensureUser(): Promise<BaijiahaoUser> {
  if (cachedUser) return cachedUser;
  const res = await apiFetch(`https://baijiahao.baidu.com/builder/app/appinfo?_=${Date.now()}`);
  const data = await parseJson<{ errmsg?: string; data?: { user?: BaijiahaoUser } }>(res, '百家号登录检测');
  if (data.errmsg !== 'success' || !data.data?.user) throw new Error('未登录百家号');
  cachedUser = data.data.user;
  return cachedUser;
}

/** 上传图片到百家号 */
async function uploadBaijiahaoImage(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append('media', blob, 'image.jpg');
  form.append('type', 'image');
  form.append('app_id', '1589639493090963');
  form.append('is_waterlog', '1');
  form.append('save_material', '1');
  form.append('no_compress', '0');
  form.append('is_events', '');
  form.append('article_type', 'news');
  const res = await apiFetch('https://baijiahao.baidu.com/pcui/picture/uploadproxy', { method: 'POST', body: form });
  const data = await parseJson<{ errno?: number; errmsg?: string; ret?: { https_url?: string } }>(res, '百家号图片上传');
  if (data.errmsg !== 'success' || !data.ret?.https_url) throw new Error(data.errmsg || '百家号图片上传失败');
  return data.ret.https_url;
}

async function uploadBySrc(src: string): Promise<ImageUploadResult> {
  const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
  const url = await uploadBaijiahaoImage(blob);
  return { url };
}

export const baijiahaoAdapter: PlatformAdapter = {
  id: 'baijiahao',
  name: '百家号',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '百家号风格：自媒体文，标题抓人，正文口语化，善用分段与小结。',
  mode: 'api',
  homepage: 'https://baijiahao.baidu.com/',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const user = await ensureUser();
      return { loggedIn: true, account: user.name, username: user.name, avatar: user.avatar || undefined };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('百家号图片缺少 dataUrl');
    const blob = await dataUriToBlob(media.dataUrl);
    const url = await withHeaderRules(HEADER_RULES, () => uploadBaijiahaoImage(blob));
    return { id: 'baijiahao_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      await ensureUser();
      const token = await fetchAuthToken();

      // 百家号用 HTML 正文；markdown → 干净 HTML 后再统一处理图片
      let html = md2html(article.body || '');
      html = await processImages(html, uploadBySrc, {
        skipPatterns: ['baijiahao.baidu.com', 'bdstatic.com', 'bcebos.com'],
      });
      for (const ref of article.mediaRefs || []) {
        if (ref.url) html += `<p><img src="${ref.url}" /></p>`;
      }

      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '百家号文章';
      const form = new URLSearchParams({
        title: finalTitle,
        content: html,
        feed_cat: '1',
        len: String(html.length),
        activity_list: JSON.stringify([{ id: 408, is_checked: 0 }]),
        source_reprinted_allow: '0',
        original_status: '0',
        original_handler_status: '1',
        isBeautify: 'false',
        subtitle: '',
        bjhtopic_id: '',
        bjhtopic_info: '',
        type: 'news',
      });
      const res = await apiFetch('https://baijiahao.baidu.com/pcui/article/save?callback=bjhdraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', token },
        body: form,
      });
      // 响应可能是裸字符串（Unauthorized）或 JSONP bjhdraft({...})：先 text() 再手工剥壳
      const text = await res.text();
      const jsonStr = text.replace(/^bjhdraft\(/, '').replace(/\)\s*$/, '');
      let data: { errno?: number; errmsg?: string; ret?: { article_id?: string } };
      try {
        data = JSON.parse(jsonStr);
      } catch {
        throw new Error(`百家号保存草稿：响应不是有效 JSON — ${text.slice(0, 120)}`);
      }
      if (data.errmsg !== 'success' || !data.ret?.article_id) {
        throw new Error(data.errmsg || '百家号保存草稿失败');
      }
      const postId = data.ret.article_id;

      return {
        platformId: 'baijiahao',
        draftId: postId,
        title: finalTitle,
        url: `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${postId}`,
        previewText: previewOf(article.body),
        body: html,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：/pcui/article/save 已存草稿，直接返回成功与草稿链接
    return pubResult('baijiahao', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
