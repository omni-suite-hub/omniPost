/**
 * 人人都是产品经理 (woshipm) adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用 www.woshipm.com 私有 API：
 *  1. checkLogin: GET /writing → 挖 "jltoken" 与 userSettings.uid → GET /api2/user/profile?uid= 验证
 *  2. 图片上传:   FormData(files) → POST /tensorflow/upyun/upload（jlstar: Bearer 头）
 *  3. 建草稿:     POST /wp-admin/admin-ajax.php（action=add_draft，urlencoded）
 *
 * 请求经 declarativeNetRequest 注入 X-Requested-With: XMLHttpRequest。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson } from './api-client';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { md2html } from './md2html';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://woshipm.com/wp-admin/admin-ajax.php*', headers: { 'X-Requested-With': 'XMLHttpRequest' } },
  { urlFilter: '*://woshipm.com/api2/*', headers: { 'X-Requested-With': 'XMLHttpRequest' } },
  { urlFilter: '*://woshipm.com/tensorflow/upyun/upload*', headers: { 'X-Requested-With': 'XMLHttpRequest' } },
];

let cachedUid = '';
let cachedNick = '';
let cachedAvatar = '';
let cachedJltoken = '';

/** 从 /writing 页面挖 jltoken + uid，并验证登录态 */
async function ensureAuth(): Promise<void> {
  if (cachedUid) return;
  const pageRes = await apiFetch('https://www.woshipm.com/writing');
  const pageText = await pageRes.text();

  const jltokenMatch = pageText.match(/"jltoken"\s*:\s*"([^"]+)"/);
  if (jltokenMatch) cachedJltoken = jltokenMatch[1];

  const uidMatch = pageText.match(/var\s+userSettings\s*=\s*\{[^}]*"uid"\s*:\s*"(\d+)"/);
  if (!uidMatch) throw new Error('未登录人人都是产品经理');
  const uid = uidMatch[1];

  const res = await apiFetch(`https://www.woshipm.com/api2/user/profile?uid=${uid}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  const data = await parseJson<{ CODE?: number; RESULT?: { userInfoVo?: { uid?: number; nickName?: string; avartar?: string } } }>(
    res,
    '人人都是产品经理登录检测',
  );
  if (data.CODE !== 200 || !data.RESULT?.userInfoVo?.uid) throw new Error('未登录人人都是产品经理');
  cachedUid = String(data.RESULT.userInfoVo.uid);
  cachedNick = data.RESULT.userInfoVo.nickName || '';
  cachedAvatar = data.RESULT.userInfoVo.avartar || '';
}

/** 上传图片到 upyun */
async function uploadWoshipmImage(blob: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append('action', 'wpuf_insert_image');
  form.append('name', filename);
  form.append('files', blob, filename);

  const headers: Record<string, string> = { Origin: 'https://www.woshipm.com', Referer: 'https://www.woshipm.com/writing' };
  if (cachedJltoken) headers['jlstar'] = `Bearer ${cachedJltoken}`;

  const res = await apiFetch('https://www.woshipm.com/tensorflow/upyun/upload', { method: 'POST', headers, body: form });
  const data = await parseJson<{ data?: Array<{ url?: string }>; error?: string }>(res, '人人都是产品经理图片上传');
  if (data.data && data.data.length > 0 && data.data[0].url) return data.data[0].url;
  throw new Error(data.error || '图片上传失败');
}

async function uploadBySrc(src: string): Promise<ImageUploadResult> {
  const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
  let filename = 'image.png';
  try {
    filename = new URL(src).pathname.split('/').pop() || filename;
  } catch {
    /* 保持默认名 */
  }
  const url = await uploadWoshipmImage(blob, filename);
  return { url };
}

export const woshipmAdapter: PlatformAdapter = {
  id: 'woshipm',
  name: '人人都是产品经理',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '人人都是产品经理风格：产品分析/方法论，结构化（背景/分析/结论），专业。',
  mode: 'api',
  homepage: 'https://www.woshipm.com',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      await ensureAuth();
      return { loggedIn: true, account: cachedNick || cachedUid, username: cachedNick || cachedUid, avatar: cachedAvatar || undefined };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('人人都是产品经理图片缺少 dataUrl');
    await ensureAuth();
    const blob = await dataUriToBlob(media.dataUrl);
    const url = await withHeaderRules(HEADER_RULES, () => uploadWoshipmImage(blob, 'image.png'));
    return { id: 'woshipm_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      await ensureAuth();

      // 人人都是产品经理用 HTML 正文；markdown → 干净 HTML 后再统一处理图片
      let html = md2html(article.body || '');
      html = await processImages(html, uploadBySrc, {
        skipPatterns: ['woshipm.com', 'image.woshipm.com'],
      });
      for (const ref of article.mediaRefs || []) {
        if (ref.url) html += `<p><img src="${ref.url}" /></p>`;
      }

      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '人人都是产品经理草稿';
      const form = new URLSearchParams({
        action: 'add_draft',
        post_title: finalTitle,
        post_content: html,
      });
      const res = await apiFetch('https://www.woshipm.com/wp-admin/admin-ajax.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: form,
      });
      const data = await parseJson<{ post_id?: string | number; url?: string; success?: boolean; error?: string }>(
        res,
        '人人都是产品经理保存草稿',
      );
      if (!data.post_id) throw new Error(data.error || '创建草稿失败: 无效响应');
      const draftId = String(data.post_id);
      const draftUrl = data.url || `https://www.woshipm.com/writing?pid=${draftId}`;

      return {
        platformId: 'woshipm',
        draftId,
        title: finalTitle,
        url: draftUrl,
        previewText: previewOf(article.body),
        body: html,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：add_draft 已存草稿，直接返回成功与草稿链接
    return pubResult('woshipm', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
