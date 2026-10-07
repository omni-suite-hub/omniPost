/**
 * 知乎 adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 直接带 cookie 调用知乎私有 API：
 *  1. checkLogin:  GET  https://www.zhihu.com/api/v4/me
 *  2. 图片上传:    POST https://api.zhihu.com/images 取 OSS 凭证 → HMAC-SHA1 签名
 *                  PUT  https://zhihu-pics-upload.zhimg.com/{object_key}
 *  3. 建草稿:      POST https://zhuanlan.zhihu.com/api/articles/drafts
 *  4. 写内容:      PATCH https://zhuanlan.zhihu.com/api/articles/{id}/draft
 *  5. 直发（能直发就直发）: PUT https://www.zhihu.com/api/articles/{id}/publish
 *     —— 失败则保留草稿（草稿链接随结果返回，不丢稿）。
 *
 * 所有请求都经 declarativeNetRequest 动态注入 x-requested-with / Origin / Referer，
 * 规则只作用于扩展自身请求（initiatorDomains 限定），用完即删。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson, sleep } from './api-client';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { md2html } from './md2html';
import { md5Hex } from './md5';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://www.zhihu.com/api/*', headers: { 'x-requested-with': 'fetch' } },
  { urlFilter: '*://zhuanlan.zhihu.com/api/*', headers: { 'x-requested-with': 'fetch' } },
  { urlFilter: '*://api.zhihu.com/*', headers: { 'x-requested-with': 'fetch' } },
];

/** OSS 上传需要伪装成来自知乎写作页的请求 */
const OSS_HEADER_RULE = {
  urlFilter: '*://zhihu-pics-upload.zhimg.com/*',
  headers: { Origin: 'https://zhuanlan.zhihu.com', Referer: 'https://zhuanlan.zhihu.com/' },
};

interface ZhihuImageToken {
  upload_file?: { state?: number; image_id?: string; object_key?: string };
  upload_token?: { access_id?: string; access_key?: string; access_token?: string };
}

/** HMAC-SHA1 签名 → Base64（Web Crypto，SW 可用） */
async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** OSS V1 签名直传 */
async function ossUpload(
  objectKey: string,
  blob: Blob,
  token: { access_id: string; access_key: string; access_token: string },
): Promise<void> {
  const contentType = blob.type || 'application/octet-stream';
  const url = `https://zhihu-pics-upload.zhimg.com/${objectKey}`;
  const ossDate = new Date().toUTCString();
  const ossUserAgent = 'aliyun-sdk-js/6.8.0';

  const ossHeaders: Record<string, string> = {
    'x-oss-date': ossDate,
    'x-oss-security-token': token.access_token,
    'x-oss-user-agent': ossUserAgent,
  };
  // CanonicalizedOSSHeaders：key 按字母序、每行以 \n 结尾
  const canonicalizedOSSHeaders = Object.keys(ossHeaders)
    .sort()
    .map((k) => `${k}:${ossHeaders[k]}`)
    .join('\n');
  // bucket 名是 zhihu-pics（不是域名的 zhihu-pics-upload）
  const canonicalizedResource = `/zhihu-pics/${objectKey}`;
  const stringToSign = `PUT\n\n${contentType}\n${ossDate}\n${canonicalizedOSSHeaders}\n${canonicalizedResource}`;
  const signature = await hmacSha1Base64(token.access_key, stringToSign);
  const authorization = `OSS ${token.access_id}:${signature}`;

  const res = await apiFetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      Authorization: authorization,
      'x-oss-date': ossDate,
      'x-oss-security-token': token.access_token,
      'x-oss-user-agent': ossUserAgent,
    },
    body: blob,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OSS 上传失败：HTTP ${res.status} ${text.slice(0, 120)}`);
  }
}

/** 等待知乎图片处理完成（复用已有图时） */
async function waitForImageReady(imageId: string): Promise<{ original_hash: string }> {
  for (let i = 0; i < 10; i++) {
    const res = await apiFetch(`https://api.zhihu.com/images/${imageId}`, {
      headers: { 'x-requested-with': 'fetch' },
    });
    const data = await parseJson<{ status?: string; original_hash?: string }>(res, '查询知乎图片状态');
    if (data.status === 'completed' || data.original_hash) {
      return { original_hash: data.original_hash || '' };
    }
    await sleep(1000);
  }
  throw new Error('知乎图片处理超时');
}

/** 二进制上传知乎图床（本地图）：MD5 取凭证 → OSS 直传 */
export async function uploadZhihuImage(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const imageHash = md5Hex(new Uint8Array(buffer));

  const tokenRes = await apiFetch('https://api.zhihu.com/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_hash: imageHash, source: 'article' }),
  });
  const tokenData = await parseJson<ZhihuImageToken>(tokenRes, '知乎图片上传凭证');
  const uploadFile = tokenData.upload_file;
  if (!uploadFile || !tokenData.upload_token) {
    throw new Error('知乎图片上传凭证无效');
  }

  // 图床已有同 hash 图片：直接取地址
  if (uploadFile.state === 1 && uploadFile.image_id) {
    const detail = await waitForImageReady(uploadFile.image_id);
    return `https://pic4.zhimg.com/${detail.original_hash}`;
  }

  await ossUpload(uploadFile.object_key || '', blob, {
    access_id: tokenData.upload_token.access_id || '',
    access_key: tokenData.upload_token.access_key || '',
    access_token: tokenData.upload_token.access_token || '',
  });

  let objectKey = uploadFile.object_key || '';
  if (blob.type === 'image/gif') objectKey += '.gif';
  return `https://pic4.zhimg.com/${objectKey}`;
}

/** 远程 URL 走知乎 URL 转存接口 */
async function uploadZhihuImageByUrl(src: string): Promise<string> {
  const res = await apiFetch('https://zhuanlan.zhihu.com/api/uploaded_images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-requested-with': 'fetch' },
    body: new URLSearchParams({ url: src, source: 'article' }),
  });
  const data = await parseJson<{ src?: string }>(res, '知乎远程图片上传');
  if (!data.src) throw new Error('知乎远程图片上传失败');
  return data.src;
}

export const zhihuAdapter: PlatformAdapter = {
  id: 'zhihu',
  name: '知乎',
  region: 'domestic',
  contentTypes: ['text', 'article', 'image'],
  route: 'session',
  stylePrompt: '知乎风格：深度论述，有理有据，段落充实，结论先行，专业可信，避免口语化。',
  mode: 'api',
  homepage: 'https://www.zhihu.com',
  capabilities: ['article', 'draft', 'image_upload', 'tags', 'cover'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const res = await withHeaderRules(HEADER_RULES, () =>
        apiFetch('https://www.zhihu.com/api/v4/me', { headers: { 'x-requested-with': 'fetch' } }),
      );
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json?.id) {
          return { loggedIn: true, account: json.name, username: json.name, avatar: json.avatar_url };
        }
      }
      return { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    const src = media.dataUrl;
    if (!src) throw new Error('知乎图片缺少 dataUrl');
    const blob = await dataUriToBlob(src);
    const url = await withHeaderRules([...HEADER_RULES, OSS_HEADER_RULE], () => uploadZhihuImage(blob));
    return { id: 'zhihu_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules([...HEADER_RULES, OSS_HEADER_RULE], async () => {
      // 1. markdown → HTML，正文图片上传到知乎图床
      let content = md2html(article.body || '');
      content = await processImages(content, (src): Promise<ImageUploadResult> => {
        if (src.startsWith('data:')) {
          return dataUriToBlob(src).then((blob) => uploadZhihuImage(blob).then((url) => ({ url })));
        }
        return uploadZhihuImageByUrl(src).then((url) => ({ url }));
      }, { skipPatterns: ['zhimg.com'] });

      // 2. 追加 uploadMedia 阶段已上传的本地媒体
      for (const ref of article.mediaRefs || []) {
        if (ref.url) content += `<figure><img src="${ref.url}" /></figure>`;
      }

      // 3. 创建草稿
      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '知乎文章';
      const createRes = await apiFetch('https://zhuanlan.zhihu.com/api/articles/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-requested-with': 'fetch' },
        body: JSON.stringify({ title: finalTitle, content: '', delta_time: 0 }),
      });
      const createData = await parseJson<{ id?: string }>(createRes, '创建知乎草稿');
      if (!createData.id) throw new Error('创建知乎草稿失败：响应缺少 id');
      const draftId = createData.id;

      // 4. 写入内容（知乎编辑器的 Draft.js 后端接受普通 HTML）
      const updateRes = await apiFetch(`https://zhuanlan.zhihu.com/api/articles/${draftId}/draft`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-requested-with': 'fetch' },
        body: JSON.stringify({ title: finalTitle, content }),
      });
      if (!updateRes.ok) throw new Error(`更新知乎草稿失败：HTTP ${updateRes.status}`);

      return {
        platformId: 'zhihu',
        draftId,
        title: finalTitle,
        url: `https://zhuanlan.zhihu.com/p/${draftId}/edit`,
        previewText: previewOf(article.body),
        body: content,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    const draftUrl = draft.url || `https://zhuanlan.zhihu.com/p/${draft.draftId}/edit`;
    try {
      const res = await withHeaderRules(HEADER_RULES, () =>
        apiFetch(`https://www.zhihu.com/api/articles/${draft.draftId}/publish`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-requested-with': 'fetch' },
          body: JSON.stringify({ disable_comment: false }),
        }),
      );
      if (res.ok) {
        return pubResult('zhihu', true, {
          draftId: draft.draftId,
          url: `https://zhuanlan.zhihu.com/p/${draft.draftId}`,
        });
      }
      // 直发失败 → 草稿保留，并透出草稿链接供用户在回执中一键打开手动补发
      const text = await res.text().catch(() => '');
      return pubResult('zhihu', false, {
        draftId: draft.draftId,
        url: draftUrl,
        error: `知乎直发未成功（草稿已保存：${draftUrl}）— HTTP ${res.status} ${text.slice(0, 120)}`,
      });
    } catch (e: any) {
      return pubResult('zhihu', false, {
        draftId: draft.draftId,
        url: draftUrl,
        error: `知乎直发未成功（草稿已保存：${draftUrl}）— ${e?.message || e}`,
      });
    }
  },
};
