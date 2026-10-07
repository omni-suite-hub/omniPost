/**
 * 搜狐号 (sohu) adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用 mp.sohu.com 私有 API：
 *  1. checkLogin: GET /mpbp/bp/account/list → 取第一个子账号（搜狐号支持多子账号）
 *  2. sp-cm:      读 cookie .sohu.com/mp-cv，读不到则生成 100-{ts}-{devId}
 *  3. 图片上传:   下载 → FormData(file+accountId) → POST /commons/front/outerUpload/image/file
 *  4. 建草稿:     POST /mpbp/bp/news/v4/news/draft/v2（HTML 正文，channelId:24，dv-id/sp-cm 头）
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（mp.sohu.com）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson, getCookie } from './api-client';
import { processImages, dataUriToBlob, pubResult, compactHtml, ImageUploadResult } from './api-base';
import { md2html } from './md2html';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://mp.sohu.com/*', headers: { Origin: 'https://mp.sohu.com', Referer: 'https://mp.sohu.com/' } },
];

function generateDeviceId(): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

interface SohuAccountInfo {
  id: string;
  nickName: string;
  avatar: string;
}

let cachedAccount: SohuAccountInfo | null = null;
let cachedDeviceId = generateDeviceId();
let cachedSpCm = '';

async function fetchSpCm(): Promise<string> {
  if (cachedSpCm) return cachedSpCm;
  try {
    const cookieValue = await getCookie('.sohu.com', 'mp-cv');
    cachedSpCm = cookieValue || `100-${Date.now()}-${generateDeviceId()}`;
  } catch {
    cachedSpCm = `100-${Date.now()}-${generateDeviceId()}`;
  }
  return cachedSpCm;
}

async function ensureAccount(): Promise<SohuAccountInfo> {
  if (cachedAccount) return cachedAccount;
  const res = await apiFetch(`https://mp.sohu.com/mpbp/bp/account/list?_=${Date.now()}`);
  const data = await parseJson<{
    code?: number;
    data?: { data?: Array<{ accounts?: SohuAccountInfo[] }> };
  }>(res, '搜狐号登录检测');
  if (data.code !== 2000000 || !data.data?.data?.[0]?.accounts?.length) throw new Error('未登录搜狐号');
  const allAccounts = data.data.data.flatMap((g) => g.accounts || []);
  if (allAccounts.length === 0) throw new Error('搜狐号无可用子账号');
  cachedAccount = allAccounts[0];
  await fetchSpCm();
  return cachedAccount;
}

/** 上传图片到搜狐号 */
async function uploadSohuImage(blob: Blob): Promise<string> {
  const account = await ensureAccount();
  const form = new FormData();
  form.append('file', blob, 'image.jpg');
  form.append('accountId', account.id);
  const res = await apiFetch(`https://mp.sohu.com/commons/front/outerUpload/image/file?accountId=${account.id}`, {
    method: 'POST',
    body: form,
  });
  const data = await parseJson<{ url?: string; msg?: string }>(res, '搜狐号图片上传');
  if (!data.url) throw new Error(data.msg || '搜狐号图片上传失败');
  return data.url;
}

async function uploadBySrc(src: string): Promise<ImageUploadResult> {
  const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
  const url = await uploadSohuImage(blob);
  return { url };
}

export const sohuAdapter: PlatformAdapter = {
  id: 'sohu',
  name: '搜狐号',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '搜狐号风格：资讯化表达，标题吸引眼球，正文分段清晰，大众化。',
  mode: 'api',
  homepage: 'https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const account = await ensureAccount();
      return {
        loggedIn: true,
        account: account.nickName,
        username: account.nickName,
        avatar: account.avatar || undefined,
      };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('搜狐号图片缺少 dataUrl');
    const blob = await dataUriToBlob(media.dataUrl);
    const url = await withHeaderRules(HEADER_RULES, () => uploadSohuImage(blob));
    return { id: 'sohu_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      const account = await ensureAccount();

      // 搜狐号用 HTML 正文；markdown → 干净 HTML 后再统一处理图片
      let html = compactHtml(md2html(article.body || ''));
      html = await processImages(html, uploadBySrc, {
        skipPatterns: ['sohu.com', 'img.sohu.com', 'qianpic.com', 'qianp.com'],
      });
      for (const ref of article.mediaRefs || []) {
        if (ref.url) html += `<p><img src="${ref.url}" /></p>`;
      }

      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '搜狐号文章';
      const postData = {
        title: finalTitle,
        brief: '',
        content: html,
        channelId: 24,
        categoryId: -1,
        id: 0,
        userColumnId: 0,
        columnNewsIds: [],
        businessCode: 0,
        declareOriginal: false,
        cover: '',
        topicIds: [],
        isAd: 0,
        userLabels: '[]',
        reprint: false,
        customTags: '',
        infoResource: 0,
        sourceUrl: '',
        visibleToLoginedUsers: 0,
        attrIds: [],
        auto: true,
        accountId: Number(account.id),
      };
      const res = await apiFetch(`https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2?accountId=${account.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'dv-id': cachedDeviceId,
          'sp-cm': cachedSpCm,
        },
        body: JSON.stringify(postData),
      });
      const data = await parseJson<{ success?: boolean; data?: string | number; msg?: string }>(res, '搜狐号保存草稿');
      if (!data.success) throw new Error(data.msg || '搜狐号保存草稿失败');
      if (data.data === undefined || data.data === null) throw new Error('搜狐号保存草稿失败：响应缺少 id');
      const postId = String(data.data);

      return {
        platformId: 'sohu',
        draftId: postId,
        title: finalTitle,
        url: `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=2&id=${postId}`,
        previewText: previewOf(article.body),
        body: html,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：draft/v2 已存草稿，直接返回成功与草稿链接
    return pubResult('sohu', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
