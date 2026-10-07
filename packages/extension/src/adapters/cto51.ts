/**
 * 51CTO (cto51) adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用 blog.51cto.com 私有 API：
 *  1. checkLogin: GET /blogger/publish → 从用户栏挖 uid/avatar，从 <meta> 挖 csrf-token
 *  2. 图片上传:   三步——POST /getUploadSign → POST /getUploadConfig（腾讯云 COS 凭证）
 *                → 按固定字段顺序 POST COS URL（key/policy/x-amz-*）→ https://s2.51cto.com/{key}
 *  3. 建草稿:     POST /blogger/draft（urlencoded，_csrf 头），markdown 直传
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（blog.51cto.com）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson } from './api-client';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://blog.51cto.com/*', headers: { Origin: 'https://blog.51cto.com', Referer: 'https://blog.51cto.com/blogger/publish' } },
];

let cachedUid = '';
let cachedAvatar = '';
let cachedCsrf = '';

/** 从发布页挖 uid/avatar/csrf，验证登录态 */
async function ensureAuth(): Promise<void> {
  if (cachedUid) return;
  const res = await apiFetch('https://blog.51cto.com/blogger/publish');
  const html = await res.text();

  const imgMatch = html.match(/<li class="more user">\s*<a[^>]*href="([^"]+)"[^>]*>\s*<img[^>]*src="([^"]+)"/);
  if (!imgMatch) throw new Error('未登录 51CTO');
  cachedUid = imgMatch[1].split('/').filter(Boolean).pop() || '';
  cachedAvatar = imgMatch[2];

  const csrfMatch = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
  if (csrfMatch) cachedCsrf = csrfMatch[1];
}

/** 步骤 1：获取上传签名 */
async function getUploadSign(): Promise<string> {
  const res = await apiFetch('https://blog.51cto.com/getUploadSign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: 'upload_type=image',
  });
  const data = await parseJson<{ code?: number; msg?: string; data?: { sign?: string } }>(res, '51CTO 获取上传签名');
  if (data.code !== 0 || !data.data?.sign) throw new Error(data.msg || '获取上传签名失败');
  return data.data.sign;
}

interface CosFields {
  key: string;
  policy: string;
  'x-amz-algorithm': string;
  'x-amz-signature': string;
  'x-amz-credential': string;
  'X-Amz-Date': string;
}

/** 步骤 2：获取上传配置（腾讯云 COS 凭证） */
async function getUploadConfig(uploadSign: string, ext: string, filename: string): Promise<{ url: string; fields: CosFields }> {
  const res = await apiFetch('https://blog.51cto.com/getUploadConfig', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: new URLSearchParams({ upload_type: 'image', upload_sign: uploadSign, ext, name: filename }).toString(),
  });
  const data = await parseJson<{ code?: number; msg?: string; data?: { url?: string; fields?: CosFields } }>(
    res,
    '51CTO 获取上传配置',
  );
  if (data.code !== 0 || !data.data?.url || !data.data.fields) throw new Error(data.msg || '获取上传配置失败');
  return { url: data.data.url, fields: data.data.fields };
}

/** 步骤 3：上传到腾讯云 COS（字段顺序固定） */
async function uploadToCos(cosUrl: string, fields: CosFields, file: Blob): Promise<string> {
  const form = new FormData();
  form.append('key', fields.key);
  form.append('policy', fields.policy);
  form.append('x-amz-algorithm', fields['x-amz-algorithm']);
  form.append('x-amz-signature', fields['x-amz-signature']);
  form.append('x-amz-credential', fields['x-amz-credential']);
  form.append('X-Amz-Date', fields['X-Amz-Date']);
  form.append('Content-Type', file.type);
  form.append('file', file);
  const res = await apiFetch(cosUrl, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`上传到 COS 失败: ${res.status}`);
  return `https://s2.51cto.com/${fields.key}`;
}

async function uploadBySrc(src: string): Promise<ImageUploadResult> {
  const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
  const mimeType = blob.type || 'image/jpeg';
  const ext = mimeType.split('/')[1] || 'jpeg';
  const filename = `${Date.now()}.${ext}`;
  const sign = await getUploadSign();
  const config = await getUploadConfig(sign, mimeType, filename);
  const url = await uploadToCos(config.url, config.fields, blob);
  return { url };
}

export const cto51Adapter: PlatformAdapter = {
  id: 'cto51',
  name: '51CTO',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '51CTO 风格：技术文章，面向 IT 从业者，结构清晰，重实践与步骤。',
  mode: 'api',
  homepage: 'https://blog.51cto.com/blogger/publish',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      await ensureAuth();
      return { loggedIn: true, account: cachedUid, username: cachedUid, avatar: cachedAvatar || undefined };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('51CTO 图片缺少 dataUrl');
    const result = await withHeaderRules(HEADER_RULES, () => uploadBySrc(media.dataUrl!));
    return { id: 'cto51_media_' + Date.now(), url: result.url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      await ensureAuth();

      // 51CTO 用 markdown 正文；先处理图片
      let markdown = article.body || '';
      markdown = await processImages(markdown, uploadBySrc);
      for (const ref of article.mediaRefs || []) {
        if (ref.url) markdown += `\n![${ref.id}](${ref.url})\n`;
      }

      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '51CTO博客';
      const postData: Record<string, string> = {
        title: finalTitle,
        content: markdown,
        pid: '',
        cate_id: '',
        custom_id: '0',
        tag: '',
        abstract: '',
        banner_type: '0',
        blog_type: '1',
        copy_code: '1',
        is_hide: '0',
        top_time: '0',
        is_comment: '0',
        is_old: '0', // markdown 直传
        blog_id: '',
        did: '',
        work_id: '',
        class_id: '',
        subjectId: '',
        import_type: '-1',
        invite_code: '',
        raffle: '',
        orig: '',
        _csrf: cachedCsrf || '',
      };
      const res = await apiFetch('https://blog.51cto.com/blogger/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams(postData).toString(),
      });
      const data = await parseJson<{ status?: number; msg?: string; data?: { did?: string | number } }>(res, '51CTO 保存草稿');
      if (data.status !== 1 || !data.data?.did) throw new Error(data.msg || '51CTO 保存草稿失败');
      const draftId = String(data.data.did);

      return {
        platformId: 'cto51',
        draftId,
        title: finalTitle,
        url: `https://blog.51cto.com/blogger/draft/${draftId}`,
        previewText: previewOf(article.body),
        body: markdown,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：/blogger/draft 已存草稿，直接返回成功与草稿链接
    return pubResult('cto51', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
