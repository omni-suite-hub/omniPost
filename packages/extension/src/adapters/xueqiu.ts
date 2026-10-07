/**
 * 雪球 (xueqiu) adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用 mp.xueqiu.com 私有 API：
 *  1. checkLogin: GET /writeV2 → 从 HTML 挖 window.UOM_CURRENTUSER（currentUser.id/screen_name/头像）
 *  2. 图片上传:   FormData(file) → POST /xq/photo/upload.json → url + filename 拼完整地址
 *  3. 正文渲染:   markdown → 雪球格式 HTML（标题统一 h4、strong→b、em→i、列表去包装、图片加 ke_img class）
 *  4. 建草稿:     POST /xq/statuses/draft/save.json（urlencoded）
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（mp.xueqiu.com）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson } from './api-client';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { md2html } from './md2html';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://mp.xueqiu.com/xq/*', headers: { Origin: 'https://mp.xueqiu.com', Referer: 'https://mp.xueqiu.com/' } },
];

interface XueqiuUser {
  id: string | number;
  screen_name?: string;
  photo_domain?: string;
  profile_image_url?: string;
}

let cachedUser: XueqiuUser | null = null;

/** 从 /writeV2 页面挖 window.UOM_CURRENTUSER */
async function ensureUser(): Promise<XueqiuUser> {
  if (cachedUser) return cachedUser;
  const res = await apiFetch('https://mp.xueqiu.com/writeV2');
  const html = await res.text();
  const match = html.match(/window\.UOM_CURRENTUSER\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!match) throw new Error('未登录雪球');
  let state: { currentUser?: XueqiuUser };
  try {
    state = JSON.parse(match[1]);
  } catch {
    throw new Error('雪球用户信息解析失败');
  }
  if (!state.currentUser?.id) throw new Error('未登录雪球');
  cachedUser = state.currentUser;
  return cachedUser;
}

/** markdown → 雪球格式 HTML（对标参考实现 Remarkable 自定义渲染规则） */
export function renderXueqiuHtml(markdown: string): string {
  let html = md2html(markdown);
  // 1) 所有标题统一为 h4
  html = html.replace(/<h[1-6]>/g, '<h4>').replace(/<\/h[1-6]>/g, '</h4>');
  // 2) strong → b，em → i
  html = html.replace(/<strong>/g, '<b>').replace(/<\/strong>/g, '</b>');
  html = html.replace(/<em>/g, '<i>').replace(/<\/em>/g, '</i>');
  // 3) 列表移除 ul/ol/li 包装（参考实现把开闭标签渲染为空）
  html = html.replace(/<\/?ul>/g, '').replace(/<\/?ol>/g, '');
  html = html.replace(/<li>/g, '').replace(/<\/li>/g, '\n');
  // 4) hr 移空
  html = html.replace(/<hr\/?>/g, '');
  // 5) 图片加 ke_img class
  html = html.replace(/<img ([^>]*)\/>/g, '<img $1 class="ke_img">');
  // 6) 清理空 <p> 与多余换行
  html = html.replace(/<p>\s*<\/p>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return html;
}

async function uploadBySrc(src: string): Promise<ImageUploadResult> {
  const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
  const form = new FormData();
  form.append('file', blob, 'image.jpg');
  const res = await apiFetch('https://mp.xueqiu.com/xq/photo/upload.json', { method: 'POST', body: form });
  const data = await parseJson<{ url?: string; filename?: string }>(res, '雪球图片上传');
  if (!data.url || !data.filename) throw new Error('雪球图片上传失败');
  // 雪球返回的 url 以 // 开头，需补 https: 并拼 filename
  const fullUrl = data.url.startsWith('//') ? `https:${data.url}/${data.filename}` : `${data.url}/${data.filename}`;
  return { url: fullUrl };
}

export const xueqiuAdapter: PlatformAdapter = {
  id: 'xueqiu',
  name: '雪球',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '雪球风格：投资分析，观点鲜明，善用数据与逻辑，面向投资者。',
  mode: 'api',
  homepage: 'https://mp.xueqiu.com/writeV2',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const user = await ensureUser();
      const avatar =
        user.photo_domain && user.profile_image_url
          ? `https:${user.photo_domain}${user.profile_image_url.split(',')[0]}`
          : '';
      return { loggedIn: true, account: user.screen_name, username: user.screen_name, avatar: avatar || undefined };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('雪球图片缺少 dataUrl');
    const result = await withHeaderRules(HEADER_RULES, () => uploadBySrc(media.dataUrl!));
    return { id: 'xueqiu_media_' + Date.now(), url: result.url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      await ensureUser();

      // 雪球正文走 markdown：先处理图片，再按雪球规则渲染 HTML
      let markdown = article.body || '';
      markdown = await processImages(markdown, uploadBySrc, {
        skipPatterns: ['xueqiu.com', 'imedao.com'],
      });
      for (const ref of article.mediaRefs || []) {
        if (ref.url) markdown += `\n![${ref.id}](${ref.url})\n`;
      }
      const content = renderXueqiuHtml(markdown);

      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '雪球专栏';
      const form = new URLSearchParams({
        text: content,
        title: finalTitle,
        cover_pic: '',
        flags: 'false',
        original_event: '',
        status_id: '',
        legal_user_visible: 'false',
        is_private: 'false',
      });
      const res = await apiFetch('https://mp.xueqiu.com/xq/statuses/draft/save.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const data = await parseJson<{ id?: string | number; error_description?: string }>(res, '雪球保存草稿');
      if (!data.id) throw new Error(data.error_description || '雪球保存草稿失败');
      const postId = String(data.id);

      return {
        platformId: 'xueqiu',
        draftId: postId,
        title: finalTitle,
        url: `https://mp.xueqiu.com/write/draft/${postId}`,
        previewText: previewOf(article.body),
        body: content,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：draft/save.json 已存草稿，直接返回成功与草稿链接
    return pubResult('xueqiu', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
