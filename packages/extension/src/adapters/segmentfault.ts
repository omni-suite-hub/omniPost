/**
 * 思否 (SegmentFault) adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用思否 gateway API：
 *  1. checkLogin: GET /user/settings → HTML 中挖 /u/{username} 与头像
 *  2. session token: GET /write → HTML 中挖 serverData.Token（兼容旧版 window.g_initialProps）
 *  3. 图片上传:   下载 → FormData(image) → POST /gateway/image（header: token）
 *  4. 建草稿:     POST /gateway/draft（markdown 直传，响应可能是裸字符串或数组格式，需先 text 再 parse）
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（segmentfault.com）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules } from './api-client';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://segmentfault.com/gateway/*', headers: { Origin: 'https://segmentfault.com', Referer: 'https://segmentfault.com/' } },
];

let cachedToken: string | null = null;

/** 从 /write 页面 HTML 中提取 session token（新版 serverData 优先，旧版 g_initialProps 兜底） */
async function getSessionToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const res = await apiFetch('https://segmentfault.com/write', { credentials: 'include' });
  const html = await res.text();

  // 新版: serverData":{"Token":"xxx"
  const newMatch = html.match(/serverData":\s*\{\s*"Token"\s*:\s*"([^"]+)"/);
  if (newMatch?.[1]) {
    const token = newMatch[1];
    cachedToken = token;
    return token;
  }

  // 旧版: window.g_initialProps = {...}; → global.sessionInfo.key
  const markStr = 'window.g_initialProps = ';
  const authIndex = html.indexOf(markStr);
  if (authIndex !== -1) {
    const endIndex = html.indexOf(';\n\t</script>', authIndex);
    if (endIndex !== -1) {
      const configStr = html.substring(authIndex + markStr.length, endIndex);
      try {
        const config = JSON.parse(configStr);
        const token = config?.global?.sessionInfo?.key;
        if (token) {
          cachedToken = token;
          return token;
        }
      } catch {
        // 落入下方统一报错
      }
    }
  }
  throw new Error('获取思否 session token 失败（请先登录思否）');
}

/** 上传图片到思否（响应可能是裸字符串/数组/对象，先 text 再 parse） */
export async function uploadSegmentfaultImage(blob: Blob): Promise<{ url: string }> {
  const token = await getSessionToken();
  const form = new FormData();
  form.append('image', blob, 'image.jpg');
  const res = await apiFetch('https://segmentfault.com/gateway/image', {
    method: 'POST',
    headers: { token },
    body: form,
  });
  const text = await res.text();
  if (text === 'Unauthorized') throw new Error('思否未授权（登录已过期）');
  if (text.includes('禁言') || text.includes('锁定')) throw new Error(text);

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`思否图片上传失败: ${text.slice(0, 120)}`);
  }
  // 新版 { url, result }；旧版数组 [0, url, id] / [1, error]
  const imageUrl =
    data?.result ||
    (Array.isArray(data)
      ? data[0] === 1
        ? null
        : data[1] || `https://image-static.segmentfault.com/${data[2]}`
      : null);
  if (!imageUrl) {
    const errMsg = Array.isArray(data) ? data[1] : data?.message || '图片上传失败';
    throw new Error(errMsg);
  }
  return { url: imageUrl };
}

async function uploadBySrc(src: string): Promise<ImageUploadResult> {
  const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
  return uploadSegmentfaultImage(blob);
}

export const segmentfaultAdapter: PlatformAdapter = {
  id: 'segmentfault',
  name: '思否',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '思否风格：技术文章，聚焦技术细节，专业简洁。',
  mode: 'api',
  homepage: 'https://segmentfault.com/write',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const res = await apiFetch('https://segmentfault.com/user/settings');
      const html = await res.text();
      const userLinkMatch = html.match(/href="\/u\/([^"]+)"/);
      if (!userLinkMatch) return { loggedIn: false };
      const avatarMatch = html.match(/src="(https:\/\/avatar-static\.segmentfault\.com\/[^"]+)"/);
      return {
        loggedIn: true,
        account: userLinkMatch[1],
        username: userLinkMatch[1],
        avatar: avatarMatch?.[1],
      };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('思否图片缺少 dataUrl');
    const blob = await dataUriToBlob(media.dataUrl);
    const { url } = await withHeaderRules(HEADER_RULES, () => uploadSegmentfaultImage(blob));
    return { id: 'sf_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      const token = await getSessionToken();

      let markdown = article.body || '';
      markdown = await processImages(markdown, uploadBySrc, {
        skipPatterns: ['segmentfault.com', 'image-static.segmentfault.com'],
      });
      for (const ref of article.mediaRefs || []) {
        if (ref.url) markdown += `\n![${ref.id}](${ref.url})\n`;
      }

      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '思否文章';
      const postData = {
        title: finalTitle,
        tags: [],
        text: markdown,
        object_id: '',
        type: 'article',
      };
      const res = await apiFetch('https://segmentfault.com/gateway/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token, accept: '*/*' },
        body: JSON.stringify(postData),
      });

      // 响应可能不是 JSON（Unauthorized / 空串），先 text 再 parse
      const text = await res.text();
      if (text === 'Unauthorized') throw new Error('思否未授权（登录已过期）');
      if (text.includes('禁言') || text.includes('锁定')) throw new Error(text);

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`思否创建草稿失败: ${text.slice(0, 120)}`);
      }

      // 数组格式 [0, data] 成功 / [1, error] 失败
      let draftId: string | undefined;
      if (Array.isArray(data)) {
        if (data[0] === 1) throw new Error(data[1] || '思否创建草稿失败');
        draftId = data[1]?.id;
      } else {
        draftId = data?.id;
      }
      if (!draftId) {
        const errMsg = data?.message || data?.msg || data?.error || data?.errMsg || JSON.stringify(data);
        throw new Error(errMsg);
      }

      return {
        platformId: 'segmentfault',
        draftId,
        title: finalTitle,
        url: `https://segmentfault.com/write?draftId=${draftId}`,
        previewText: previewOf(article.body),
        body: markdown,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：/gateway/draft 已存草稿，直接返回成功与草稿链接
    return pubResult('segmentfault', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
