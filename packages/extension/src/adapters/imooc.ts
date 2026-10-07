/**
 * 慕课手记 (imooc) adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用 www.imooc.com 私有 API：
 *  1. checkLogin: GET /u/card → JSONP 剥壳（jsonpcallback(...)）→ result.data.uid/nickname
 *  2. 图片上传:   FormData(photo) → POST /article/ajaxuploadimg → data.imgpath（// 开头补 https:）
 *  3. 建草稿:     POST /article/savedraft（urlencoded），markdown 直传
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（www.imooc.com）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson } from './api-client';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://www.imooc.com/article/*', headers: { Origin: 'https://www.imooc.com', Referer: 'https://www.imooc.com/' } },
];

let cachedUid = '';
let cachedNick = '';
let cachedAvatar = '';

/** JSONP 剥壳：jsonpcallback({...}) */
async function parseJsonp<T>(res: Response, ctx: string): Promise<T> {
  let text = await res.text();
  text = text.replace(/^jsonpcallback\(/, '').replace(/\)$/, '');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${ctx}：响应不是有效 JSON — ${text.slice(0, 120)}`);
  }
}

/** 验证登录态并缓存用户信息 */
async function ensureAuth(): Promise<void> {
  if (cachedUid) return;
  const res = await apiFetch('https://www.imooc.com/u/card');
  const data = await parseJsonp<{ result?: number; msg?: string; data?: { uid?: number | string; nickname?: string; img?: string } }>(
    res,
    '慕课网登录检测',
  );
  if (data.result !== 0 || !data.data?.uid) throw new Error(data.msg || '未登录慕课网');
  cachedUid = String(data.data.uid);
  cachedNick = data.data.nickname || '';
  cachedAvatar = data.data.img || '';
}

async function uploadImoocImage(blob: Blob): Promise<string> {
  const form = new FormData();
  const filename = `${Date.now()}.jpg`;
  form.append('photo', blob, filename);
  form.append('type', blob.type || 'image/jpeg');
  form.append('id', 'WU_FILE_0');
  form.append('name', filename);
  form.append('lastModifiedDate', new Date().toString());
  form.append('size', String(blob.size));
  const res = await apiFetch('https://www.imooc.com/article/ajaxuploadimg', { method: 'POST', body: form });
  const data = await parseJson<{ result?: number; msg?: string; data?: { imgpath?: string } }>(res, '慕课网图片上传');
  if (data.result !== 0 || !data.data?.imgpath) throw new Error(data.msg || '图片上传失败');
  let imgUrl = data.data.imgpath;
  if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
  return imgUrl;
}

async function uploadBySrc(src: string): Promise<ImageUploadResult> {
  const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
  const url = await uploadImoocImage(blob);
  return { url };
}

export const imoocAdapter: PlatformAdapter = {
  id: 'imooc',
  name: '慕课手记',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '慕课手记风格：技术学习笔记，步骤清晰，善用代码与示例。',
  mode: 'api',
  homepage: 'https://www.imooc.com/article',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      await withHeaderRules(HEADER_RULES, () => ensureAuth());
      return { loggedIn: true, account: cachedNick || cachedUid, username: cachedNick || cachedUid, avatar: cachedAvatar || undefined };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('慕课网图片缺少 dataUrl');
    const blob = await dataUriToBlob(media.dataUrl);
    const url = await withHeaderRules(HEADER_RULES, () => uploadImoocImage(blob));
    return { id: 'imooc_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      await ensureAuth();

      // 慕课网用 markdown 正文；先处理图片
      let markdown = article.body || '';
      markdown = await processImages(markdown, uploadBySrc);
      for (const ref of article.mediaRefs || []) {
        if (ref.url) markdown += `\n![${ref.id}](${ref.url})\n`;
      }

      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '慕课手记';
      const form = new URLSearchParams({
        editor: '1',  // 1 = markdown 模式（之前用 0 = 富文本，导致 markdown 内容被当 HTML 解析失败、显示为纯文本）
        draft_id: '0',
        title: finalTitle,
        content: markdown,
      });
      const res = await apiFetch('https://www.imooc.com/article/savedraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const data = await parseJson<{ result?: number; msg?: string; data?: string | number }>(res, '慕课网保存草稿');
      if (!data.data) throw new Error(data.msg || '保存草稿失败');
      const draftId = String(data.data);

      return {
        platformId: 'imooc',
        draftId,
        title: finalTitle,
        url: `https://www.imooc.com/article/draft/id/${draftId}`,
        previewText: previewOf(article.body),
        body: markdown,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：savedraft 已存草稿，直接返回成功与草稿链接
    return pubResult('imooc', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
