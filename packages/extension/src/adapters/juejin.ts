/**
 * 掘金 adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用掘金私有 API：
 *  1. checkLogin: GET api.juejin.cn/user_api/v1/user/get → data.user_id
 *  2. CSRF:       HEAD api.juejin.cn/user_api/v1/sys/token → 响应头 x-ware-csrf-token
 *                 （格式 "0,{token},86370000,success,{session_id}"，取第 2 段）
 *  3. 图片上传:   火山引擎 ImageX：gen_token → ApplyImageUpload(AWS4 签名) →
 *                 TOS PUT(Content-CRC32) → CommitImageUpload → get_img_url
 *  4. 建草稿:     POST api.juejin.cn/content_api/v1/article_draft/create（markdown 原文直传）
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（api.juejin.cn + imagex.bytedanceapi.com）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson } from './api-client';
import { processImages, dataUriToBlob, pubResult } from './api-base';
import { signAWS4, crc32 } from './aws4';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://api.juejin.cn/*', headers: { Origin: 'https://juejin.cn', Referer: 'https://juejin.cn/' } },
  { urlFilter: '*://imagex.bytedanceapi.com/*', headers: { Origin: 'https://juejin.cn', Referer: 'https://juejin.cn/' } },
];

const IMAGEX_AID = '2608';
const IMAGEX_SERVICE_ID = '73owjymdk6';

function generateUUID(): string {
  return (
    'xxxxxxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)) + Date.now().toString()
  );
}

let cachedCsrf: string | null = null;

async function getCsrfToken(): Promise<string> {
  if (cachedCsrf) return cachedCsrf;
  const res = await apiFetch('https://api.juejin.cn/user_api/v1/sys/token', {
    method: 'HEAD',
    headers: { 'x-secsdk-csrf-request': '1', 'x-secsdk-csrf-version': '1.2.10' },
  });
  const wareToken = res.headers.get('x-ware-csrf-token');
  if (!wareToken) throw new Error('获取掘金 CSRF token 失败');
  const parts = wareToken.split(',');
  if (parts.length < 2) throw new Error('掘金 CSRF token 格式无效');
  cachedCsrf = parts[1];
  return cachedCsrf;
}

// ---- ImageX 图床 ----
interface ImageXToken {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  ExpiredTime: number;
}
let cachedImageXToken: ImageXToken | null = null;

async function getImageXToken(): Promise<ImageXToken> {
  if (cachedImageXToken && Date.now() < cachedImageXToken.ExpiredTime - 60000) return cachedImageXToken;
  const url = `https://api.juejin.cn/imagex/v2/gen_token?aid=${IMAGEX_AID}&uuid=${generateUUID()}&client=web`;
  const res = await apiFetch(url, { headers: { 'Content-Type': 'application/json' } });
  const data = await parseJson<{
    data?: { token?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; ExpiredTime?: string } };
    err_no?: number;
    err_msg?: string;
  }>(res, '掘金 ImageX 凭证');
  if (data.err_no && data.err_no !== 0) throw new Error(data.err_msg || `掘金 ImageX 凭证错误 ${data.err_no}`);
  const t = data.data?.token;
  if (!t?.AccessKeyId || !t.SecretAccessKey) throw new Error('掘金 ImageX 凭证无效');
  cachedImageXToken = {
    AccessKeyId: t.AccessKeyId,
    SecretAccessKey: t.SecretAccessKey,
    SessionToken: t.SessionToken || '',
    ExpiredTime: new Date(t.ExpiredTime || 0).getTime(),
  };
  return cachedImageXToken;
}

async function applyImageUpload(token: ImageXToken): Promise<{
  StoreUri: string;
  Auth: string;
  UploadHosts: string[];
  SessionKey: string;
}> {
  const url = `https://imagex.bytedanceapi.com/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${IMAGEX_SERVICE_ID}`;
  const sign = await signAWS4({
    method: 'GET',
    url,
    accessKeyId: token.AccessKeyId,
    secretAccessKey: token.SecretAccessKey,
    securityToken: token.SessionToken,
    region: 'cn-north-1',
    service: 'imagex',
  });
  const res = await apiFetch(url, { headers: sign.headers });
  const data = await parseJson<{
    Result?: {
      UploadAddress?: {
        StoreInfos?: Array<{ StoreUri?: string; Auth?: string }>;
        UploadHosts?: string[];
        SessionKey?: string;
      };
    };
  }>(res, '掘金申请上传');
  const addr = data.Result?.UploadAddress;
  const store = addr?.StoreInfos?.[0];
  if (!addr || !store?.StoreUri || !addr.UploadHosts?.[0]) throw new Error('掘金申请上传失败');
  return { StoreUri: store.StoreUri, Auth: store.Auth || '', UploadHosts: addr.UploadHosts, SessionKey: addr.SessionKey || '' };
}

async function uploadToTOS(host: string, storeUri: string, auth: string, file: Blob): Promise<void> {
  const uploadUrl = `https://${host}/${storeUri}`;
  const arrayBuffer = await file.arrayBuffer();
  const crc32Value = crc32(new Uint8Array(arrayBuffer));
  const res = await apiFetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: auth,
      'Content-Type': file.type || 'application/octet-stream',
      'Content-CRC32': crc32Value,
    },
    body: file,
  });
  if (!res.ok) throw new Error(`掘金 TOS 上传失败：HTTP ${res.status}`);
}

async function commitImageUpload(token: ImageXToken, sessionKey: string): Promise<void> {
  const url = `https://imagex.bytedanceapi.com/?Action=CommitImageUpload&Version=2018-08-01&SessionKey=${encodeURIComponent(sessionKey)}&ServiceId=${IMAGEX_SERVICE_ID}`;
  const sign = await signAWS4({
    method: 'POST',
    url,
    accessKeyId: token.AccessKeyId,
    secretAccessKey: token.SecretAccessKey,
    securityToken: token.SessionToken,
    region: 'cn-north-1',
    service: 'imagex',
  });
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { ...sign.headers, 'Content-Length': '0' },
  });
  const data = await parseJson<{ Result?: { Results?: Array<{ UriStatus?: number }> } }>(res, '掘金提交上传');
  if (!data.Result) throw new Error('掘金提交上传失败');
}

async function getImageUrl(storeUri: string): Promise<string> {
  const url = `https://api.juejin.cn/imagex/v2/get_img_url?aid=${IMAGEX_AID}&uuid=${generateUUID()}&uri=${encodeURIComponent(storeUri)}&img_type=private`;
  const res = await apiFetch(url, { headers: { 'Content-Type': 'application/json' } });
  const data = await parseJson<{
    data?: { main_url?: string; backup_url?: string };
    err_no?: number;
    err_msg?: string;
  }>(res, '掘金图片 URL');
  if (data.err_no && data.err_no !== 0) throw new Error(data.err_msg || '掘金图片 URL 获取失败');
  const imageUrl = data.data?.main_url || data.data?.backup_url;
  if (!imageUrl) throw new Error('掘金图片 URL 无效');
  return imageUrl;
}

/** 上传单张图片（Blob）到掘金图床 */
export async function uploadJuejinImage(file: Blob): Promise<string> {
  const token = await getImageXToken();
  const address = await applyImageUpload(token);
  await uploadToTOS(address.UploadHosts[0], address.StoreUri, address.Auth, file);
  await commitImageUpload(token, address.SessionKey);
  return getImageUrl(address.StoreUri);
}

/** 上传图片（data: 或远程 URL 两条路径） */
async function uploadJuejinImageBySrc(src: string): Promise<{ url: string }> {
  const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
  const url = await uploadJuejinImage(blob);
  return { url };
}

export const juejinAdapter: PlatformAdapter = {
  id: 'juejin',
  name: '掘金',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '掘金风格：技术干货，结论先行，善用小标题与代码块，面向开发者，务实。',
  mode: 'api',
  homepage: 'https://juejin.cn',
  capabilities: ['article', 'draft', 'image_upload', 'categories', 'tags', 'cover'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const res = await withHeaderRules(HEADER_RULES, () =>
        apiFetch('https://api.juejin.cn/user_api/v1/user/get'),
      );
      const json = await parseJson<{ data?: { user_id?: string; user_name?: string; avatar_large?: string } }>(
        res,
        '掘金登录检测',
      );
      if (json.data?.user_id) {
        return { loggedIn: true, account: json.data.user_name, username: json.data.user_name, avatar: json.data.avatar_large };
      }
      return { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('掘金图片缺少 dataUrl');
    const blob = await dataUriToBlob(media.dataUrl);
    const url = await withHeaderRules(HEADER_RULES, () => uploadJuejinImage(blob));
    return { id: 'juejin_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      const csrfToken = await getCsrfToken();

      // 掘金使用 Markdown 原文，图片上传到掘金图床
      let markdown = article.body || '';
      markdown = await processImages(markdown, uploadJuejinImageBySrc, {
        skipPatterns: ['juejin.cn', 'p1-juejin', 'p3-juejin', 'p6-juejin', 'p9-juejin', 'byteimg.com'],
      });

      // 追加 uploadMedia 阶段已上传的本地媒体
      for (const ref of article.mediaRefs || []) {
        if (ref.url) markdown += `\n![${ref.id}](${ref.url})\n`;
      }

      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '掘金草稿';
      const createRes = await apiFetch('https://api.juejin.cn/content_api/v1/article_draft/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-secsdk-csrf-token': csrfToken },
        body: JSON.stringify({
          brief_content: '',
          category_id: '0',
          cover_image: '',
          edit_type: 10,        // 10 = markdown 模式
          html_content: '',       // markdown 模式传空字符串（之前误传 'deprecated' 导致掘金切到废弃模式、忽略 mark_content、编辑器清空）
          link_url: '',
          mark_content: markdown,
          tag_ids: [],
          title: finalTitle,
        }),
      });
      const createData = await parseJson<{ data?: { id?: string }; err_no?: number; err_msg?: string }>(
        createRes,
        '掘金创建草稿',
      );
      if (createData.err_no && createData.err_no !== 0) throw new Error(createData.err_msg || `掘金创建草稿失败 ${createData.err_no}`);
      if (!createData.data?.id) throw new Error(createData.err_msg || '掘金创建草稿失败：响应缺少 id');
      const draftId = createData.data.id;

      return {
        platformId: 'juejin',
        draftId,
        title: finalTitle,
        url: `https://juejin.cn/editor/drafts/${draftId}`,
        previewText: previewOf(article.body),
        body: markdown,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：article_draft/create 已存草稿，直接返回成功与草稿链接
    return pubResult('juejin', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
