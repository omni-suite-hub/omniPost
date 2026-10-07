/**
 * 豆瓣 adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调豆瓣笔记私有 API：
 *  1. checkLogin: GET /note/create → HTML 挖 _USER_NAME / note_id / ck / _POST_PARAMS.siteCookie.value
 *  2. 图片上传:   下载 → FormData(note_id+image_file+ck+upload_auth_token) → POST /j/note/add_photo
 *  3. 建草稿:     Markdown → Draft.js JSON → POST /j/note/autosave（urlencoded）
 *
 * 注意：豆瓣笔记正文是 Draft.js raw JSON（note_text），必须经 markdownToDraft 转换；
 * 图片需完整数据（id/thumb/width/height）嵌入 IMAGE entity，因此上传时收集 imageDataMap。
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（www.douban.com）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson } from './api-client';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { markdownToDraft, DoubanImageData } from './markdown-to-draft';
import { previewOf, TAB_PATTERNS } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://www.douban.com/*', headers: { Origin: 'https://www.douban.com', Referer: 'https://www.douban.com' } },
];

interface DoubanFormData {
  note_id: string;
  ck: string;
}

let cachedFormData: DoubanFormData | null = null;
let cachedUsername = '';
let cachedAvatar = '';
let cachedUploadAuthToken = '';

/** 从 /note/create 页面 HTML 挖凭证（note_id / ck / upload_auth_token） */
async function ensureAuth(): Promise<{ form: DoubanFormData; uploadAuthToken: string }> {
  if (cachedFormData && cachedUploadAuthToken) {
    return { form: cachedFormData, uploadAuthToken: cachedUploadAuthToken };
  }
  const res = await withHeaderRules(HEADER_RULES, () => apiFetch('https://www.douban.com/note/create'));
  const html = await res.text();

  const userNameMatch = html.match(/_USER_NAME\s*=\s*['"]([^'"]+)['"]/);
  const userAvatarMatch = html.match(/_USER_AVATAR\s*=\s*['"]([^'"]+)['"]/);
  const postParamsMatch = html.match(/_POST_PARAMS\s*=\s*(\{[\s\S]*?\});/);

  const noteIdMatch =
    html.match(/name="note_id"\s+value="(\d+)"/) ||
    html.match(/name=['"]note_id['"][^>]*value=['"](\d+)['"]/i) ||
    html.match(/value=['"](\d+)['"][^>]*name=['"]note_id['"]/i) ||
    html.match(/['"]note_id['"]\s*:\s*['"]?(\d+)['"]?/) ||
    (postParamsMatch ? postParamsMatch[1].match(/['"]?note_id['"]?\s*:\s*['"]?(\d+)['"]?/) : null);

  let ck =
    html.match(/name="ck"\s+value="([^"]+)"/)?.[1] ||
    html.match(/name=['"]ck['"][^>]*value=['"]([^'"]+)['"]/i)?.[1] ||
    html.match(/value=['"]([^'"]+)['"][^>]*name=['"]ck['"]/i)?.[1] ||
    html.match(/['"]ck['"]\s*:\s*['"]([^'"]+)['"]/)?.[1] ||
    (postParamsMatch ? postParamsMatch[1].match(/['"]?ck['"]?\s*:\s*['"]([^'"]+)['"]/)?.[1] : '') || '';

  if (!ck) {
    try {
      const ckCookies = await Promise.all([
        chrome.cookies.getAll({ domain: 'douban.com', name: 'ck' }),
        chrome.cookies.getAll({ domain: '.douban.com', name: 'ck' }),
      ]).then(([c1, c2]) => [...c1, ...c2]);
      if (ckCookies[0]?.value) ck = ckCookies[0].value.replace(/"/g, '');
    } catch {}
  }

  const noteId = noteIdMatch ? noteIdMatch[1] : '';

  if (!noteId || !ck) throw new Error('未登录豆瓣（无法获取笔记凭证）');

  let uploadAuthToken = '';
  if (postParamsMatch) {
    const siteCookieMatch = postParamsMatch[1].match(/siteCookie[^}]*value\s*:\s*['"]([^'"]+)['"]/);
    uploadAuthToken = siteCookieMatch?.[1] || '';
  }

  cachedUsername = userNameMatch?.[1] || '';
  cachedAvatar = userAvatarMatch?.[1] || '';
  cachedFormData = { note_id: noteId, ck };
  cachedUploadAuthToken = uploadAuthToken;
  return { form: cachedFormData, uploadAuthToken };
}

// URL → 完整图片数据（uploadMedia 阶段上传的图片，createDraft 里要复用完整数据）
const uploadedImageData = new Map<string, DoubanImageData>();

/** 上传单张图片到豆瓣并返回完整图片数据 */
async function uploadDoubanImage(blob: Blob): Promise<DoubanImageData> {
  const { form, uploadAuthToken } = await ensureAuth();
  if (!uploadAuthToken) throw new Error('豆瓣上传凭证缺失（upload_auth_token）');
  const formData = new FormData();
  formData.append('note_id', form.note_id);
  formData.append('image_file', blob, 'image.jpg');
  formData.append('ck', form.ck);
  formData.append('upload_auth_token', uploadAuthToken);
  const res = await apiFetch('https://www.douban.com/j/note/add_photo', {
    method: 'POST',
    body: formData,
  });
  const data = await parseJson<{
    photo?: {
      id?: string;
      url?: string;
      thumb?: string;
      width?: number;
      height?: number;
      file_name?: string;
      file_size?: number;
    };
  }>(res, '豆瓣图片上传');
  const p = data.photo;
  if (!p?.url) throw new Error('豆瓣图片上传失败');
  const imgData: DoubanImageData = {
    id: p.id || '',
    url: p.url,
    thumb: p.thumb || p.url,
    width: p.width,
    height: p.height,
    file_name: p.file_name,
    file_size: p.file_size,
  };
  uploadedImageData.set(imgData.url, imgData);
  return imgData;
}

async function uploadBySrc(src: string): Promise<ImageUploadResult & { imageData?: DoubanImageData }> {
  const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
  const imgData = await uploadDoubanImage(blob);
  return { url: imgData.url, imageData: imgData };
}

export const doubanAdapter: PlatformAdapter = {
  id: 'douban',
  name: '豆瓣',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '豆瓣风格：文艺生活化，个人视角，真诚有温度，避免商业腔。',
  mode: 'api',
  homepage: 'https://www.douban.com/note/create',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      // 1. 优先从已打开的豆瓣标签页读取真实账号昵称
      try {
        const tabs = await chrome.tabs.query({ url: TAB_PATTERNS.douban });
        if (tabs.length > 0 && tabs[0].id) {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: () => {
              // 顶栏个人中心：.nav-user-account 包含 "xxx的账号"，或 a.bn-more span
              const accountEl = document.querySelector('.nav-user-account .bn-more span') ||
                document.querySelector('.nav-user-account') ||
                document.querySelector('#db-global-nav .top-nav-info a[href*="/people/"]');
              const hasLogout = !!document.querySelector('a[href*="accounts.douban.com/passport/login"]');
              const text = accountEl?.textContent?.trim() || '';
              if (text && !hasLogout) {
                return {
                  loggedIn: true,
                  account: text.replace(/的账号$/, '').trim(),
                };
              }
              return { loggedIn: false };
            },
          });
          if (results?.[0]?.result?.loggedIn && results[0].result.account) {
            const nickname = results[0].result.account;
            // 尝试预热 ensureAuth（静默不抛错）
            ensureAuth().catch(() => {});
            return {
              loggedIn: true,
              account: nickname,
              username: nickname,
              avatar: cachedAvatar || undefined,
            };
          }
        }
      } catch {
        /* ignore tab scripting error */
      }

      // 2. Cookie 探查：读取关键会话凭证 dbcl2（存在代表用户已登录）
      let cookieUid = '';
      try {
        const cookiePromise = Promise.all([
          chrome.cookies.getAll({ domain: 'douban.com' }),
          chrome.cookies.getAll({ domain: '.douban.com' }),
        ]).then(([c1, c2]) => [...c1, ...c2]);
        const timeoutPromise = new Promise<chrome.cookies.Cookie[]>((resolve) => setTimeout(() => resolve([]), 3000));
        const cookies = await Promise.race([cookiePromise, timeoutPromise]);
        const dbcl2 = cookies.find((c) => c.name === 'dbcl2' && !!c.value);
        if (dbcl2) {
          // dbcl2 格式通常为 "uid:token"
          const raw = dbcl2.value.replace(/"/g, '');
          cookieUid = raw.split(':')[0] || '';
        }
      } catch {
        /* ignore cookie error */
      }

      // 3. API 直连探测（携带 Header 规则）
      try {
        await ensureAuth();
        return {
          loggedIn: true,
          account: cachedUsername || (cookieUid ? `豆瓣用户_${cookieUid}` : '豆瓣用户'),
          username: cachedUsername || (cookieUid ? `豆瓣用户_${cookieUid}` : '豆瓣用户'),
          avatar: cachedAvatar || undefined,
        };
      } catch {
        return { loggedIn: false };
      }
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('豆瓣图片缺少 dataUrl');
    const blob = await dataUriToBlob(media.dataUrl);
    const imgData = await withHeaderRules(HEADER_RULES, () => uploadDoubanImage(blob));
    return { id: 'douban_media_' + Date.now(), url: imgData.url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      const { form } = await ensureAuth();

      let markdown = article.body || '';
      const imageDataMap = new Map<string, DoubanImageData>();
      markdown = await processImages(markdown, async (src) => {
        const result = await uploadBySrc(src);
        if (result.imageData) imageDataMap.set(result.imageData.url, result.imageData);
        return { url: result.url };
      }, {
        skipPatterns: ['doubanio.com', 'douban.com'],
      });

      // uploadMedia 阶段已上传的媒体：URL 已在 uploadedImageData 中，直接引用完整数据
      for (const ref of article.mediaRefs || []) {
        if (ref.url && !ref.url.startsWith('data:')) {
          markdown += `\n![${ref.id}](${ref.url})\n`;
          const existing = uploadedImageData.get(ref.url);
          if (existing) imageDataMap.set(existing.url, existing);
        }
      }

      const draftContent = markdownToDraft(markdown, imageDataMap);
      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '豆瓣日记';

      const body = new URLSearchParams({
        is_rich: '1',
        note_id: form.note_id,
        note_title: finalTitle,
        note_text: draftContent,
        introduction: '',
        note_privacy: 'P',
        cannot_reply: '',
        author_tags: '',
        accept_donation: '',
        donation_notice: '',
        is_original: '',
        ck: form.ck,
      });
      const res = await apiFetch('https://www.douban.com/j/note/autosave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = await parseJson<{ url?: string; r?: number; msg?: string }>(res, '豆瓣保存草稿');
      // autosave 成功时返回 r=0 或 url；失败通常带 msg
      if (data?.msg && data?.r !== 0) throw new Error(data.msg);
      if (data?.r !== undefined && data.r !== 0) throw new Error(`豆瓣保存草稿失败（r=${data.r}）`);

      return {
        platformId: 'douban',
        draftId: form.note_id,
        title: finalTitle,
        url: 'https://www.douban.com/note/create',
        previewText: previewOf(article.body),
        body: draftContent,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：autosave 已存草稿（note_privacy=P 私有），返回成功与草稿页链接
    return pubResult('douban', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
