/**
 * 东方财富 (eastmoney) adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用 caifuhao/emfront/gbapi 私有 API：
 *  1. checkLogin: GET caifuhaoapi.eastmoney.com/api/v2/getauthorinfo（读 .eastmoney.com 的 ct/ut cookie）
 *  2. 图片上传:   远程 URL → PUT gbapi.iimage/image/byLink；data URI → POST gbapi.iimage/image
 *  3. 建草稿:     两阶段——先建空草稿拿 draft_id，再更新正文（emfront Tran/GetData + parm 数组）
 *
 * 请求经 declarativeNetRequest 注入 Origin/HOST（mp.eastmoney.com → emfront.eastmoney.com）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson, getCookie } from './api-client';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { md2html } from './md2html';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://mp.eastmoney.com/*', headers: { Origin: 'https://mp.eastmoney.com', HOST: 'emfront.eastmoney.com' } },
];

/** 生成 32 位大写 hex deviceId（参考实现用持久化；此处模块级生成一次，生命周期内保持一致） */
function generateDeviceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('');
}

let cachedDeviceId = generateDeviceId();
let cachedCtoken = '';
let cachedUtoken = '';

/** 读取 .eastmoney.com 的 ct/ut cookie（登录凭证） */
async function fetchToken(): Promise<void> {
  if (cachedCtoken && cachedUtoken) return;
  const ctoken = await getCookie('.eastmoney.com', 'ct');
  const utoken = await getCookie('.eastmoney.com', 'ut');
  if (!ctoken || !utoken) throw new Error('未检测到登录信息，请先登录东方财富');
  cachedCtoken = ctoken;
  cachedUtoken = utoken;
}

async function checkLoggedIn(): Promise<{ accountId?: string; accountName?: string; portrait?: string } | null> {
  await fetchToken();
  const res = await apiFetch(
    `https://caifuhaoapi.eastmoney.com/api/v2/getauthorinfo?platform=&ctoken=${cachedCtoken}&utoken=${cachedUtoken}`,
    { headers: { 'x-requested-with': 'fetch' } },
  );
  const data = await parseJson<{ Success?: number; Result?: { accountId?: string; accountName?: string; portrait?: string } }>(
    res,
    '东方财富登录检测',
  );
  if (data.Success === 1 && data.Result?.accountId) return data.Result;
  return null;
}

interface DraftResult {
  error_code?: number;
  draft_id?: string;
  me?: string;
}

/** 构造 SaveDraft 的 parm 数组（字段顺序与参考实现一致） */
function buildParm(params: { draftid?: string; title: string; text: string }): object[] {
  return [
    { ip: '$IP$' },
    { deviceid: cachedDeviceId },
    { version: '100' },
    { plat: 'web' },
    { product: 'CFH' },
    { ctoken: cachedCtoken },
    { utoken: cachedUtoken },
    { draftid: params.draftid ?? '' },
    { drafttype: '0' },
    { type: '0' },
    { title: encodeURIComponent(params.title) },
    { text: encodeURIComponent(params.text) },
    { columns: '2' },
    { cover: '' },
    { issimplevideo: '0' },
    { videos: '' },
    { vods: '' },
    { isoriginal: '0' },
    { tgProduct: '' },
    { spcolumns: '' },
    { textsource: '0' },
    { replyauthority: '' },
    { modules: encodeURIComponent('[]') },
  ];
}

/** 调用草稿 API（两阶段共用：createDraft 空稿拿 id，updateDraft 回填正文） */
async function callDraftApi(parm: object[], draftId?: string): Promise<DraftResult> {
  const pageUrl = draftId
    ? `https://mp.eastmoney.com/collect/pc_article/index.html#/?id=${draftId}`
    : 'https://mp.eastmoney.com/collect/pc_article/index.html#/';

  const res = await apiFetch('https://emfront.eastmoney.com/apifront/Tran/GetData?platform=', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageUrl, path: 'draft/api/Article/SaveDraft', parm: JSON.stringify(parm) }),
  });
  const raw = await parseJson<{ RRquestSuccess?: boolean; RCode?: number; RMsg?: string; RData?: string }>(res, '东方财富草稿 API');
  if (!raw.RRquestSuccess || raw.RCode !== 200) throw new Error(`草稿 API 错误: ${raw.RMsg || '未知错误'}`);
  let inner: DraftResult;
  try {
    inner = JSON.parse(raw.RData || '{}');
  } catch {
    throw new Error('无法解析草稿响应数据');
  }
  if (inner.error_code !== 0) throw new Error(`草稿业务错误: ${inner.me || '未知错误'}`);
  return inner;
}

/** 上传图片（data URI → 二进制上传；远程 URL → byLink 中转） */
async function uploadBySrc(src: string): Promise<ImageUploadResult> {
  if (src.startsWith('data:')) {
    const blob = await dataUriToBlob(src);
    return uploadEastmoneyBlob(blob);
  }
  const res = await apiFetch('https://gbapi.eastmoney.com/iimage/image/byLink?platform=', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ noinlist: '1', linkUrl: src, ctoken: cachedCtoken, utoken: cachedUtoken }),
  });
  const data = await parseJson<{ code?: number; message?: string; data?: { url?: string } }>(res, '东方财富图片上传');
  if (data.code === 200 && data.data?.url) return { url: data.data.url };
  throw new Error(`图片上传失败: ${data.message || '未知错误'} (code: ${data.code})`);
}

async function uploadEastmoneyBlob(file: Blob): Promise<ImageUploadResult> {
  const ext = file.type.split('/')[1] || 'png';
  const filename = `${Date.now()}.${ext}`;
  const form = new FormData();
  form.append('file', file, filename);
  form.append('noinlist', '1');
  form.append('utoken', cachedUtoken);
  form.append('ctoken', cachedCtoken);
  const res = await apiFetch('https://gbapi.eastmoney.com/iimage/image?platform=', { method: 'POST', body: form });
  const data = await parseJson<{ code?: number; message?: string; data?: { url?: string } }>(res, '东方财富图片上传');
  if (data.code === 200 && data.data?.url) return { url: data.data.url };
  throw new Error(`图片上传失败: ${data.message || '未知错误'} (code: ${data.code})`);
}

export const eastmoneyAdapter: PlatformAdapter = {
  id: 'eastmoney',
  name: '东方财富',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '东方财富风格：财经资讯，数据说话，客观专业，关注投资价值。',
  mode: 'api',
  homepage: 'https://mp.eastmoney.com',
  capabilities: ['article', 'draft', 'image_upload', 'cover'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const info = await checkLoggedIn();
      if (!info) return { loggedIn: false };
      return { loggedIn: true, account: info.accountName, username: info.accountName, avatar: info.portrait || undefined };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('东方财富图片缺少 dataUrl');
    await fetchToken();
    const blob = await dataUriToBlob(media.dataUrl);
    const result = await withHeaderRules(HEADER_RULES, () => uploadEastmoneyBlob(blob));
    return { id: 'eastmoney_media_' + Date.now(), url: result.url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      await fetchToken();

      // 1. 创建空草稿，获取 draft_id
      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '东方财富文章';
      const createParm = buildParm({ title: finalTitle, text: '<div class="xeditor_content cfh_web"></div>' });
      const createResult = await callDraftApi(createParm);
      if (!createResult.draft_id) throw new Error('创建草稿失败: 响应缺少 draft_id');
      const draftId = createResult.draft_id;

      // 2. 处理图片（基于 md2html 的干净 HTML）
      let html = md2html(article.body || '');
      html = await processImages(html, uploadBySrc, { skipPatterns: ['gbres.dfcfw.com'] });
      for (const ref of article.mediaRefs || []) {
        if (ref.url) html += `<p><img src="${ref.url}" /></p>`;
      }

      // 3. 更新草稿正文
      const updateParm = buildParm({
        draftid: draftId,
        title: finalTitle,
        text: `<div class="xeditor_content cfh_web">${html}</div>`,
      });
      await callDraftApi(updateParm, draftId);

      return {
        platformId: 'eastmoney',
        draftId,
        title: finalTitle,
        url: `https://mp.eastmoney.com/collect/pc_article/index.html#/?id=${draftId}`,
        previewText: previewOf(article.body),
        body: html,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：两阶段 SaveDraft 已存草稿，直接返回成功与草稿链接
    return pubResult('eastmoney', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
