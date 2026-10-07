/**
 * 博客园 (cnblogs) adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用博客园私有 API：
 *  1. XSRF-TOKEN: 先 GET /posts/edit 触发 cookie 写入，再按三个域依次读 cookie
 *  2. checkLogin: GET home.cnblogs.com/user/CurrentUserInfo → HTML 挖 /u/{uid}
 *  3. 图片上传:   下载 → FormData(image+app+uploadType) → POST upload.cnblogs.com/v2/images/cors-upload
 *  4. 建草稿:     POST i.cnblogs.com/api/posts（全字段，isMarkdown:true / isDraft:true）
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（i.cnblogs.com + upload.cnblogs.com）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, getCookie } from './api-client';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://i.cnblogs.com/*', headers: { Origin: 'https://i.cnblogs.com', Referer: 'https://i.cnblogs.com/' } },
  { urlFilter: '*://upload.cnblogs.com/*', headers: { Origin: 'https://i.cnblogs.com', Referer: 'https://i.cnblogs.com/' } },
];

let cachedXsrf: string | null = null;

/** 获取 XSRF-TOKEN：先访问编辑页触发 cookie，再按三个域格式读取 */
async function getXsrfToken(): Promise<string | null> {
  if (cachedXsrf) return cachedXsrf;
  try {
    await apiFetch('https://i.cnblogs.com/posts/edit');
    // 优先通过完整 url 读取 cookie
    try {
      const urlCookies = await chrome.cookies.getAll({ url: 'https://i.cnblogs.com', name: 'XSRF-TOKEN' });
      if (urlCookies.length > 0 && urlCookies[0].value) {
        cachedXsrf = urlCookies[0].value;
        return cachedXsrf;
      }
    } catch {
      /* fallback */
    }

    const domains = ['i.cnblogs.com', '.cnblogs.com', 'cnblogs.com'];
    for (const domain of domains) {
      const value = await getCookie(domain, 'XSRF-TOKEN');
      if (value) {
        cachedXsrf = value;
        return cachedXsrf;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 上传图片到博客园（CORS 直传接口） */
async function uploadCnblogsImage(blob: Blob): Promise<string> {
  const xsrf = await getXsrfToken();
  if (!xsrf) throw new Error('获取博客园 XSRF-TOKEN 失败，请先登录');
  const form = new FormData();
  form.append('image', blob, 'image.png');
  form.append('app', 'blog');
  form.append('uploadType', 'Select');
  const res = await apiFetch('https://upload.cnblogs.com/v2/images/cors-upload', {
    method: 'POST',
    headers: { 'x-xsrf-token': xsrf },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`博客园图片上传失败: HTTP ${res.status} - ${text.slice(0, 120)}`);
  const data = JSON.parse(text);
  const imageUrl = data?.data || data?.url || data?.imageUrl || data?.src;
  if (typeof imageUrl !== 'string') throw new Error(`博客园图片上传失败: ${text.slice(0, 120)}`);
  return imageUrl;
}

async function uploadBySrc(src: string): Promise<ImageUploadResult> {
  const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
  const url = await uploadCnblogsImage(blob);
  return { url };
}

export const cnblogsAdapter: PlatformAdapter = {
  id: 'cnblogs',
  name: '博客园',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '博客园风格：技术博客，朴实直接，结构清晰，重代码与原理。',
  mode: 'api',
  homepage: 'https://i.cnblogs.com/posts/edit',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const res = await apiFetch('https://home.cnblogs.com/user/CurrentUserInfo');
      const html = await res.text();
      const linkMatch = html.match(/href="\/u\/([^/]+)\/"/);
      if (!linkMatch) return { loggedIn: false };
      const avatarMatch = html.match(/<img[^>]+class="pfs"[^>]+src="([^"]+)"/);
      return {
        loggedIn: true,
        account: linkMatch[1],
        username: linkMatch[1],
        avatar: avatarMatch?.[1],
      };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('博客园图片缺少 dataUrl');
    const blob = await dataUriToBlob(media.dataUrl);
    const url = await withHeaderRules(HEADER_RULES, () => uploadCnblogsImage(blob));
    return { id: 'cnblogs_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      const xsrf = await getXsrfToken();
      if (!xsrf) throw new Error('获取博客园 XSRF-TOKEN 失败，请先登录');

      let markdown = article.body || '';
      markdown = await processImages(markdown, uploadBySrc, {
        skipPatterns: ['cnblogs.com', 'img2024.cnblogs.com', 'img2023.cnblogs.com'],
      });
      for (const ref of article.mediaRefs || []) {
        if (ref.url) markdown += `\n![${ref.id}](${ref.url})\n`;
      }

      const res = await apiFetch('https://i.cnblogs.com/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-xsrf-token': xsrf },
        body: JSON.stringify({
          id: null,
          postType: 2, // 2 = 文章
          accessPermission: 0,
          title: (article.title?.trim() || previewOf(article.body, 30) || '博客园随笔').slice(0, 100),
          url: null,
          postBody: markdown,
          categoryIds: null,
          categories: null,
          collectionIds: [],
          inSiteCandidate: false,
          inSiteHome: false,
          siteCategoryId: null,
          blogTeamIds: null,
          isPublished: false,
          displayOnHomePage: false,
          isAllowComments: true,
          includeInMainSyndication: false,
          isPinned: false,
          showBodyWhenPinned: false,
          isOnlyForRegisterUser: false,
          isUpdateDateAdded: false,
          entryName: null,
          description: null,
          featuredImage: null,
          tags: null,
          password: null,
          publishAt: null,
          datePublished: new Date().toISOString(),
          dateUpdated: null,
          isMarkdown: true,
          isDraft: true,
          autoDesc: null,
          changePostType: false,
          blogId: 0,
          author: null,
          removeScript: false,
          clientInfo: null,
          changeCreatedTime: false,
          canChangeCreatedTime: false,
          isContributeToImpressiveBugActivity: false,
          usingEditorId: 5,
          sourceUrl: null,
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new Error('未登录或登录已过期，请重新登录博客园');
        throw new Error(`博客园创建草稿失败: HTTP ${res.status} - ${text.slice(0, 120)}`);
      }
      let data: { id?: number; error?: string };
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`博客园创建草稿失败: 响应不是 JSON - ${text.slice(0, 120)}`);
      }
      if (!data.id) throw new Error(data.error || '博客园创建草稿失败：响应缺少 id');
      const postId = String(data.id);

      return {
        platformId: 'cnblogs',
        draftId: postId,
        title: article.title || '',
        url: `https://i.cnblogs.com/articles/edit;postId=${postId}`,
        previewText: previewOf(article.body),
        body: markdown,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：/api/posts 已存草稿（isDraft:true），直接返回成功与草稿链接
    return pubResult('cnblogs', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
