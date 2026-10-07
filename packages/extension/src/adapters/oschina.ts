/**
 * 开源中国 (oschina) adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用 apiv1.oschina.net：
 *  1. checkLogin: GET /oschinapi/user/myDetails → { success, result.userId }
 *  2. 图片上传:   下载 → FormData(file) → POST /oschinapi/ai/creation/project/uploadDetail
 *  3. 建草稿:     POST /oschinapi/api/draft/save_draft（privacy:true 私有草稿）
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（my.oschina.net）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson } from './api-client';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://apiv1.oschina.net/oschinapi/*', headers: { Origin: 'https://my.oschina.net', Referer: 'https://my.oschina.net/' } },
];

let cachedUserId: string | null = null;
let cachedUser: { name?: string; portraitUrl?: string } | null = null;

async function ensureUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const res = await apiFetch('https://apiv1.oschina.net/oschinapi/user/myDetails');
  const data = await parseJson<{
    success?: boolean;
    result?: { userId?: number; userVo?: { name?: string; portraitUrl?: string } };
  }>(res, '开源中国登录检测');
  if (!data.success || !data.result?.userId) throw new Error('未登录开源中国');
  cachedUserId = String(data.result.userId);
  cachedUser = data.result.userVo || null;
  return cachedUserId;
}

/** 上传图片到开源中国 */
async function uploadOschinaImage(blob: Blob): Promise<string> {
  const userId = await ensureUserId();
  void userId; // 上传接口不强制带 user，仅确保已登录
  const form = new FormData();
  form.append('file', blob, 'image.jpg');
  const res = await apiFetch('https://apiv1.oschina.net/oschinapi/ai/creation/project/uploadDetail', {
    method: 'POST',
    body: form,
  });
  const data = await parseJson<{ success?: boolean; result?: string; message?: string }>(res, '开源中国图片上传');
  if (!data.success || !data.result) throw new Error(data.message || '开源中国图片上传失败');
  return data.result;
}

async function uploadBySrc(src: string): Promise<ImageUploadResult> {
  const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
  const url = await uploadOschinaImage(blob);
  return { url };
}

export const oschinaAdapter: PlatformAdapter = {
  id: 'oschina',
  name: '开源中国',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '开源中国风格：技术社区文章，关注开源与技术实践，务实专业。',
  mode: 'api',
  homepage: 'https://my.oschina.net',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const res = await apiFetch('https://apiv1.oschina.net/oschinapi/user/myDetails');
      const data = await parseJson<{
        success?: boolean;
        result?: { userId?: number; userVo?: { name?: string; portraitUrl?: string } };
      }>(res, '开源中国登录检测');
      if (!data.success || !data.result?.userId) return { loggedIn: false };
      cachedUserId = String(data.result.userId);
      cachedUser = data.result.userVo || null;
      return {
        loggedIn: true,
        account: cachedUser?.name || cachedUserId,
        username: cachedUser?.name || cachedUserId,
        avatar: cachedUser?.portraitUrl,
      };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('开源中国图片缺少 dataUrl');
    const blob = await dataUriToBlob(media.dataUrl);
    const url = await withHeaderRules(HEADER_RULES, () => uploadOschinaImage(blob));
    return { id: 'oschina_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      const userId = await ensureUserId();

      let markdown = article.body || '';
      markdown = await processImages(markdown, uploadBySrc, {
        skipPatterns: ['oschina.net', 'oscimg.oschina.net'],
      });
      for (const ref of article.mediaRefs || []) {
        if (ref.url) markdown += `\n![${ref.id}](${ref.url})\n`;
      }

      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '开源中国草稿';
      const res = await apiFetch('https://apiv1.oschina.net/oschinapi/api/draft/save_draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: finalTitle,
          user: Number(userId),
          content: markdown,
          contentType: 1, // 1 = markdown
          catalog: 0,
          originUrl: '',
          privacy: true,
          disableComment: false,
        }),
      });
      const data = await parseJson<{
        success?: boolean;
        message?: string;
        result?: { id?: number };
      }>(res, '开源中国保存草稿');
      if (!data.success || !data.result?.id) throw new Error(data.message || '开源中国保存草稿失败');
      const draftId = String(data.result.id);

      return {
        platformId: 'oschina',
        draftId,
        title: finalTitle,
        url: `https://my.oschina.net/u/${userId}/blog/write/draft/${draftId}`,
        previewText: previewOf(article.body),
        body: markdown,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：save_draft 已存私有草稿，直接返回成功与草稿链接
    return pubResult('oschina', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
