/**
 * CSDN adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用 CSDN 私有 API：
 *  1. 签名:   每个请求带 x-ca-key/x-ca-nonce/x-ca-signature（HMAC-SHA256，密钥硬编码于官方编辑器）
 *  2. checkLogin: GET bizapi.csdn.net/blog-console-api/v3/editor/getBaseInfo
 *  3. 图片上传: 下载 → POST /resource-api/v1/image/direct/upload/signature 取华为云 OBS 凭证 →
 *              FormData 直传 OBS host
 *  4. 建草稿:  POST /blog-console-api/v3/mdeditor/saveArticle（markdown + html 双格式，status:2 草稿）
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（bizapi.csdn.net + OBS）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson } from './api-client';
import { processImages, dataUriToBlob, pubResult } from './api-base';
import { md2html } from './md2html';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://bizapi.csdn.net/*', headers: { Origin: 'https://editor.csdn.net', Referer: 'https://editor.csdn.net/' } },
  { urlFilter: '*://imgservice.csdn.net/*', headers: { Origin: 'https://editor.csdn.net', Referer: 'https://editor.csdn.net/' } },
  {
    urlFilter: '*://csdn-img-blog.obs.cn-north-4.myhuaweicloud.com/*',
    headers: { Origin: 'https://editor.csdn.net', Referer: 'https://editor.csdn.net/' },
  },
];

const API_KEY = '203803574';
const API_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba';

async function hmacSha256Base64(message: string, secret: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function createUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 生成 CSDN API 签名头（对齐官方编辑器） */
async function signRequest(apiPath: string, method: 'GET' | 'POST' = 'POST'): Promise<Record<string, string>> {
  const nonce = createUuid();
  const signStr =
    method === 'GET'
      ? `GET\n*/*\n\n\n\nx-ca-key:${API_KEY}\nx-ca-nonce:${nonce}\n${apiPath}`
      : `POST\n*/*\n\napplication/json\n\nx-ca-key:${API_KEY}\nx-ca-nonce:${nonce}\n${apiPath}`;
  const signature = await hmacSha256Base64(signStr, API_SECRET);
  const headers: Record<string, string> = {
    accept: '*/*',
    'x-ca-key': API_KEY,
    'x-ca-nonce': nonce,
    'x-ca-signature': signature,
    'x-ca-signature-headers': 'x-ca-key,x-ca-nonce',
  };
  if (method === 'POST') headers['content-type'] = 'application/json';
  return headers;
}

/** 上传图片到 CSDN 图床（下载 → OBS 签名 → 直传） */
export async function uploadCsdnImage(blob: Blob): Promise<string> {
  const ext = (blob.type?.split('/')[1] || 'jpg').toLowerCase();
  const validExt = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? ext : 'jpg';

  const signatureRes = await apiFetch('https://bizapi.csdn.net/resource-api/v1/image/direct/upload/signature', {
    method: 'POST',
    headers: await signRequest('/resource-api/v1/image/direct/upload/signature', 'POST'),
    body: JSON.stringify({ imageTemplate: '', appName: 'direct_blog_markdown', imageSuffix: validExt }),
  });
  const signatureData = await parseJson<{
    code?: number;
    data?: {
      filePath?: string;
      host?: string;
      accessId?: string;
      policy?: string;
      signature?: string;
      callbackUrl?: string;
      callbackBody?: string;
      callbackBodyType?: string;
      customParam?: {
        rtype?: string;
        filePath?: string;
        isAudit?: number;
        'x-image-app'?: string;
        type?: string;
        'x-image-suffix'?: string;
        username?: string;
      };
    };
  }>(signatureRes, 'CSDN 图片签名');
  if (signatureData.code !== 200 || !signatureData.data) throw new Error('CSDN 图片签名失败');

  const d = signatureData.data;
  const cp = d.customParam;
  const form = new FormData();
  form.append('key', d.filePath || '');
  form.append('policy', d.policy || '');
  form.append('signature', d.signature || '');
  form.append('callbackBody', d.callbackBody || '');
  form.append('callbackBodyType', d.callbackBodyType || '');
  form.append('callbackUrl', d.callbackUrl || '');
  form.append('AccessKeyId', d.accessId || '');
  if (cp) {
    form.append('x:rtype', cp.rtype || '');
    form.append('x:filePath', cp.filePath || '');
    form.append('x:isAudit', String(cp.isAudit ?? 0));
    form.append('x:x-image-app', cp['x-image-app'] || '');
    form.append('x:type', cp.type || '');
    form.append('x:x-image-suffix', cp['x-image-suffix'] || '');
    form.append('x:username', cp.username || '');
  }
  form.append('file', blob, `image.${validExt}`);

  const obsRes = await apiFetch(d.host || '', { method: 'POST', body: form });
  const obsJson = await parseJson<{ code?: number; data?: { imageUrl?: string } }>(obsRes, 'CSDN OBS 上传');
  if (obsJson.code !== 200 || !obsJson.data?.imageUrl) throw new Error('CSDN OBS 上传失败');
  return obsJson.data.imageUrl;
}

async function uploadCsdnImageBySrc(src: string): Promise<{ url: string }> {
  if (src.startsWith('data:')) {
    const blob = await dataUriToBlob(src);
    return { url: await uploadCsdnImage(blob) };
  }
  const imageRes = await apiFetch(src);
  if (!imageRes.ok) throw new Error('CSDN 图片下载失败');
  const blob = await imageRes.blob();
  return { url: await uploadCsdnImage(blob) };
}

export const csdnAdapter: PlatformAdapter = {
  id: 'csdn',
  name: 'CSDN',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: 'CSDN 风格：技术博客，结构清晰（背景/方案/实现/总结），善用代码块与步骤列表。',
  mode: 'api',
  homepage: 'https://editor.csdn.net/md/',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const apiPath = '/blog-console-api/v3/editor/getBaseInfo';
      const headers = await signRequest(apiPath, 'GET');
      const res = await withHeaderRules(HEADER_RULES, () =>
        apiFetch(`https://bizapi.csdn.net${apiPath}`, { headers }),
      );
      const json = await parseJson<{ code?: number; data?: { name?: string; nickname?: string; avatar?: string } }>(
        res,
        'CSDN 登录检测',
      );
      if (json.code === 200 && json.data?.name) {
        return {
          loggedIn: true,
          account: json.data.nickname || json.data.name,
          username: json.data.nickname || json.data.name,
          avatar: json.data.avatar,
        };
      }
      return { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('CSDN 图片缺少 dataUrl');
    const blob = await dataUriToBlob(media.dataUrl);
    const url = await withHeaderRules(HEADER_RULES, () => uploadCsdnImage(blob));
    return { id: 'csdn_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      // CSDN 用 markdown 正文；HTML 用于编辑器渲染（两栏都要）
      let markdown = article.body || '';
      markdown = await processImages(markdown, uploadCsdnImageBySrc, {
        skipPatterns: ['csdnimg.cn', 'csdn.net'],
      });

      for (const ref of article.mediaRefs || []) {
        if (ref.url) markdown += `\n![${ref.id}](${ref.url})\n`;
      }

      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || 'CSDN草稿';
      const htmlContent = md2html(markdown);
      const apiPath = '/blog-console-api/v3/mdeditor/saveArticle';
      const headers = await signRequest(apiPath, 'POST');

      const res = await apiFetch(`https://bizapi.csdn.net${apiPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: finalTitle,
          markdowncontent: markdown,
          content: htmlContent,
          readType: 'public',
          level: 0,
          tags: '',
          status: 2,
          categories: '',
          type: 'original',
          original_link: '',
          authorized_status: false,
          not_auto_saved: '1',
          source: 'pc_mdeditor',
          cover_images: [],
          cover_type: 1,
          is_new: 1,
          vote_id: 0,
          resource_id: '',
          pubStatus: 'draft',
          creator_activity_id: '',
        }),
      });
      const data = await parseJson<{ code?: number; message?: string; msg?: string; data?: { id?: string } }>(
        res,
        'CSDN 保存草稿',
      );
      if (data.code !== 200 || !data.data?.id) throw new Error(data.msg || data.message || 'CSDN 保存草稿失败');
      const postId = data.data.id;

      return {
        platformId: 'csdn',
        draftId: postId,
        title: finalTitle,
        url: `https://editor.csdn.net/md?articleId=${postId}`,
        previewText: previewOf(article.body),
        body: markdown,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：saveArticle 已存草稿，直接返回成功与草稿链接
    return pubResult('csdn', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
