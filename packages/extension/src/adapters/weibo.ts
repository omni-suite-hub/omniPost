/**
 * 微博 adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用微博私有 API：
 *  1. checkLogin: 解析 card.weibo.com/article/v5/editor 页面里的 config JSON → uid/nick
 *  2. 图片上传:    data: 走 picupload.weibo.com 直传；远程 URL 走 asyncuploadimg + 轮询
 *  3. 建草稿:      POST draft/create → POST draft/save（status:'0' 草稿）
 *  4. 发布:        草稿语义——不自动直发，返回草稿编辑页链接。
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer/SN-REQID，用完即删。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson, sleep } from './api-client';
import { dataUriToBlob, pubResult, compactHtml } from './api-base';
import { md2html } from './md2html';
import { previewOf } from './utils';

const WEIBO_RULES = [
  {
    urlFilter: '*://card.weibo.com/*',
    headers: { Origin: 'https://card.weibo.com', Referer: 'https://card.weibo.com/article/v5/editor' },
  },
  {
    urlFilter: '*://picupload.weibo.com/*',
    headers: { Origin: 'https://weibo.com', Referer: 'https://weibo.com/' },
  },
];

interface WeiboUserConfig {
  uid: string;
  nick: string;
  avatar_large: string;
}

let cachedConfig: WeiboUserConfig | null = null;
let cachedAt = 0;

/** 解析编辑器页面的 config JSON（uid 是后续所有写操作的凭证） */
export async function getWeiboUserConfig(): Promise<WeiboUserConfig | null> {
  if (cachedConfig && Date.now() - cachedAt < 5 * 60 * 1000) return cachedConfig;
  const res = await apiFetch('https://card.weibo.com/article/v5/editor');
  const html = await res.text();
  const m = html.match(/config:\s*JSON\.parse\('(.+?)'\)/);
  if (!m) return null;
  try {
    const configJson = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    const config = JSON.parse(configJson);
    if (!config.uid) return null;
    cachedConfig = {
      uid: String(config.uid),
      nick: config.nick || '',
      avatar_large: config.avatar_large || '',
    };
    cachedAt = Date.now();
    return cachedConfig;
  } catch {
    return null;
  }
}

/** 微博请求 id（43 位：uid&时间戳 base64 + 随机补齐） */
export function generateReqId(uid: string): string {
  const base64 = btoa(`${uid}&${Date.now()}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = base64;
  while (result.length < 43) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result.slice(0, 43);
}

/** data: 图片直传 picupload.weibo.com → 返回可用的 sinaimg URL */
export async function uploadWeiboDataUri(dataUri: string): Promise<string> {
  const blob = await dataUriToBlob(dataUri);
  const reqId = generateReqId('');
  const uploadUrl =
    `https://picupload.weibo.com/interface/pic_upload.php?app=miniblog&s=json&p=1&data=1&url=&markpos=1&logo=0&nick=&file_source=4&_rid=${reqId}`;
  const res = await apiFetch(uploadUrl, { method: 'POST', body: blob });
  const json = await parseJson<{ data?: { pics?: { pic_1?: { pid?: string } } } }>(res, '微博图片上传');
  const pid = json?.data?.pics?.pic_1?.pid;
  if (!pid) throw new Error('微博图片上传失败（未返回 pid）');
  return `https://wx3.sinaimg.cn/large/${pid}.jpg`;
}

/** 远程 URL：asyncuploadimg 触发转存 → 轮询 asyncimginfo 直到就绪 */
async function uploadWeiboRemote(src: string, uid: string): Promise<string> {
  const reqId = generateReqId(uid);
  try {
    await apiFetch(
      `https://card.weibo.com/article/v5/aj/editor/plugins/asyncuploadimg?uid=${uid}&_rid=${reqId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          accept: 'application/json, text/plain, */*',
          'SN-REQID': reqId,
        },
        body: new URLSearchParams({ 'urls[0]': src }),
      },
    );
  } catch {
    // 转存请求失败不致命，继续轮询（微博侧可能仍在处理）
  }
  for (let i = 0; i < 30; i++) {
    const pollReqId = generateReqId(uid);
    const res = await apiFetch(
      `https://card.weibo.com/article/v5/aj/editor/plugins/asyncimginfo?uid=${uid}&_rid=${pollReqId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          accept: 'application/json, text/plain, */*',
          'SN-REQID': pollReqId,
        },
        body: new URLSearchParams({ 'urls[0]': src }),
      },
    );
    const json = await parseJson<{ data?: Array<{ pid?: string; task_status_code?: number }> }>(res, '查询微博图片状态');
    const item = json.data?.[0];
    if (item?.task_status_code === 1 && item.pid) return `https://wx3.sinaimg.cn/large/${item.pid}.jpg`;
    if (item?.task_status_code === 2) throw new Error('微博图片上传失败');
    await sleep(1000);
  }
  throw new Error('微博图片上传超时');
}

/** 微博专用图片处理：提取 figure/img，跳过 sinaimg 域，替换为 <figure class="image"> 包裹 */
async function processWeiboImages(content: string, uid: string): Promise<string> {
  const figureImgRegex = /<figure[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]*>[\s\S]*?<\/figure>/gi;
  const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
  const matches: { full: string; src: string; hasFigure: boolean }[] = [];
  const figureSrcs = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = figureImgRegex.exec(content)) !== null) {
    matches.push({ full: m[0], src: m[1], hasFigure: true });
    figureSrcs.add(m[1]);
  }
  while ((m = imgRegex.exec(content)) !== null) {
    if (!figureSrcs.has(m[1])) matches.push({ full: m[0], src: m[1], hasFigure: false });
  }
  if (matches.length === 0) return content;

  let result = content;
  const uploadedMap = new Map<string, string>();
  for (const { full, src, hasFigure } of matches) {
    if (!src) continue;
    if (src.includes('sinaimg.cn') || src.includes('weibo.com')) continue;
    try {
      let url = uploadedMap.get(src);
      if (!url) {
        url = src.startsWith('data:') ? await uploadWeiboDataUri(src) : await uploadWeiboRemote(src, uid);
        uploadedMap.set(src, url);
      }
      const pid = url.match(/\/([^/]+)\.jpg$/)?.[1] || '';
      const imgTag = `<img src="${url}"${pid ? ` data-pid="${pid}"` : ''} />`;
      if (hasFigure) {
        result = result.replace(full, full.replace(/<img[^>]+src="[^"]+"[^>]*>/i, imgTag));
      } else {
        result = result.replace(full, `<figure class="image">${imgTag}</figure>`);
      }
    } catch {
      // 单图失败不阻塞整篇，保留原引用
    }
    await sleep(300);
  }
  return result;
}

export const weiboAdapter: PlatformAdapter = {
  id: 'weibo',
  name: '微博',
  region: 'domestic',
  contentTypes: ['text', 'image', 'video'],
  route: 'session',
  stylePrompt: '微博头条文章风格：资讯化长文，标题吸睛，正文分段清晰、可有小标题与加粗重点，口语与信息密度兼顾。',
  mode: 'api',
  homepage: 'https://card.weibo.com/article/v5/editor',
  capabilities: ['article', 'draft', 'image_upload', 'cover'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const config = await getWeiboUserConfig();
      if (config?.uid) {
        return { loggedIn: true, account: config.nick, username: config.nick, avatar: config.avatar_large };
      }
      return { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('微博图片缺少 dataUrl');
    const url = await withHeaderRules(WEIBO_RULES, () => uploadWeiboDataUri(media.dataUrl as string));
    return { id: 'weibo_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(WEIBO_RULES, async () => {
      const config = await getWeiboUserConfig();
      if (!config?.uid) throw new Error('请先登录微博');

      // 1. markdown → HTML → 压缩标签间空白（微博编辑器要求紧凑 HTML）
      let content = compactHtml(md2html(article.body || ''));
      content = await processWeiboImages(content, config.uid);

      // 2. 追加 uploadMedia 阶段已上传的本地媒体
      for (const ref of article.mediaRefs || []) {
        if (ref.url) content += `<figure class="image"><img src="${ref.url}" /></figure>`;
      }

      // 3. 创建草稿
      const createReqId = generateReqId(config.uid);
      const createRes = await apiFetch(
        `https://card.weibo.com/article/v5/aj/editor/draft/create?uid=${config.uid}&_rid=${createReqId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            accept: 'application/json, text/plain, */*',
            'SN-REQID': createReqId,
          },
          body: new URLSearchParams(),
        },
      );
      const createJson = await parseJson<{ code?: number; msg?: string; data?: { id?: string } }>(createRes, '微博创建草稿');
      if (createJson.code !== 100000 || !createJson.data?.id) {
        throw new Error(createJson.msg || '微博创建草稿失败');
      }
      const postId = createJson.data.id;

      // 4. 保存草稿内容（status:'0' = 草稿）
      const saveReqId = generateReqId(config.uid);
      const saveRes = await apiFetch(
        `https://card.weibo.com/article/v5/aj/editor/draft/save?uid=${config.uid}&id=${postId}&_rid=${saveReqId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            accept: 'application/json, text/plain, */*',
            'SN-REQID': saveReqId,
          },
          body: new URLSearchParams({
            id: postId,
            title: (article.title?.trim() || previewOf(article.body, 30) || '微博文章').slice(0, 30),
            subtitle: '',
            type: '',
            status: '0',
            publish_at: '',
            error_msg: '',
            error_code: '0',
            collection: '[]',
            free_content: '',
            content,
            cover: '',
            summary: '',
            writer: '',
            extra: 'null',
            is_word: '0',
            article_recommend: '[]',
            follow_to_read: '1',
            isreward: '1',
            pay_setting: '{"ispay":0,"isvclub":0}',
            source: '0',
            action: '1',
            content_type: '0',
            save: '1',
          }),
        },
      );
      const saveJson = await parseJson<{ code?: string | number; msg?: string }>(saveRes, '微博保存草稿');
      if (String(saveJson.code) !== '100000') {
        throw new Error(saveJson.msg || `微博保存草稿失败（错误码 ${saveJson.code}）`);
      }

      return {
        platformId: 'weibo',
        draftId: postId,
        title: article.title || '',
        url: `https://card.weibo.com/article/v5/editor#/draft/${postId}`,
        previewText: previewOf(article.body),
        body: content,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：draft/save 已存草稿，直接返回成功与草稿链接（不自动直发）
    return pubResult('weibo', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
