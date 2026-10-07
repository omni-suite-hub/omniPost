/**
 * metaweblog adapter —— 通用 MetaWeblog XML-RPC 发布（对标"文章同步助手"）。
 *
 * 机制：official 路线，用户在设置中配置 siteUrl / endpoint / username / password：
 *  - checkLogin: blogger.getUsersBlogs 测试连接
 *  - uploadMedia: metaWeblog.newMediaObject（bits/bytes 双发，Typecho 兼容）
 *  - createDraft: metaWeblog.newPost(publish=false) 真实存草稿
 *  - publish:     metaWeblog.editPost(publish=true) 真发布，失败保留草稿链接
 *
 * 正文图片：HTML <img> 与 Markdown ![]() 均会下载并上传（跳过站点同域图），
 * 复用 api-base 的 processImages（单图失败不阻塞整篇）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { store } from '../store';
import {
  buildXmlRpcRequest,
  parseXmlRpcResponse,
  defaultXmlRpcEndpoint,
  XmlRpcValue,
  XmlRpcStruct,
} from './xml-rpc';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { md2html } from './md2html';
import { previewOf } from './utils';

export interface MetaweblogSettings {
  /** 博客站点地址，如 https://blog.example.com（用于推断端点与生成文章/编辑链接） */
  siteUrl: string;
  /** XML-RPC 端点，默认 {siteUrl}/xmlrpc.php */
  endpoint?: string;
  username: string;
  password: string;
}

export interface ResolvedCfg {
  endpoint: string;
  username: string;
  password: string;
  siteUrl: string;
  hostname: string;
}

export function resolveMetaweblogCfg(
  s?: MetaweblogSettings,
  label = 'MetaWeblog',
  endpointFallback: (siteUrl: string) => string = defaultXmlRpcEndpoint,
): ResolvedCfg {
  if (!s?.siteUrl || !s?.username) throw new Error(`${label} 未配置（siteUrl / username 必填）`);
  const siteUrl = s.siteUrl.replace(/\/+$/, '');
  let hostname = '';
  try {
    hostname = new URL(siteUrl).hostname;
  } catch {
    // 非法站点地址不阻塞（链接展示可能不准确），但保留原始串
  }
  return {
    endpoint: (s.endpoint || endpointFallback(siteUrl)).replace(/\/+$/, ''),
    username: s.username,
    password: s.password || '',
    siteUrl,
    hostname,
  };
}

/** 调 XML-RPC 方法，非 2xx 或 fault 均抛错（真实失败不假成功） */
export async function callXmlRpc(cfg: ResolvedCfg, method: string, params: unknown[], ctx: string): Promise<XmlRpcValue> {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: buildXmlRpcRequest(method, params),
  });
  if (!res.ok) throw new Error(`${ctx}：HTTP ${res.status}`);
  const parsed = parseXmlRpcResponse(await res.text());
  if (!parsed.success) {
    throw new Error(`${ctx}：${parsed.faultString || `faultCode ${parsed.faultCode}`}`);
  }
  return parsed.value ?? '';
}

/** MIME → 扩展名（typecho.ts 复用） */
export const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

/** 上传二进制图片 → 返回平台图床 URL（metaWeblog.newMediaObject） */
export async function uploadImageBytes(cfg: ResolvedCfg, bytes: Uint8Array, filename: string, mimeType: string): Promise<string> {
  const mediaObject = {
    name: filename,
    type: mimeType,
    bits: bytes,
    bytes, // Typecho 兼容双发（bits 与 bytes 同名数据）
  };
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: buildXmlRpcRequest('metaWeblog.newMediaObject', [0, cfg.username, cfg.password, mediaObject]),
  });
  if (!res.ok) throw new Error(`图片上传失败：HTTP ${res.status}`);
  const parsed = parseXmlRpcResponse(await res.text());
  if (!parsed.success) throw new Error(`图片上传失败：${parsed.faultString || 'XML-RPC fault'}`);
  const struct = parsed.value as XmlRpcStruct;
  if (typeof struct?.url !== 'string' || !struct.url) throw new Error('图片上传失败：响应缺少 url');
  return struct.url;
}

async function uploadBySrc(cfg: ResolvedCfg, src: string): Promise<ImageUploadResult> {
  let bytes: Uint8Array;
  let mime = 'image/jpeg';
  if (src.startsWith('data:')) {
    const blob = await dataUriToBlob(src);
    bytes = new Uint8Array(await blob.arrayBuffer());
    mime = blob.type || mime;
  } else {
    const res = await fetch(src, { credentials: 'omit' });
    if (!res.ok) throw new Error(`图片下载失败：HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    const blobType = res.headers.get('content-type') || '';
    if (blobType) mime = blobType.split(';')[0];
  }
  const ext = MIME_TO_EXT[mime] || 'png';
  const url = await uploadImageBytes(cfg, bytes, `image_${Date.now()}.${ext}`, mime);
  return { url };
}

/** 供 typecho.ts 复用：下载 data URI / 远程图 → newMediaObject 上传 */
export { uploadBySrc };

export const metaweblogAdapter: PlatformAdapter = {
  id: 'metaweblog',
  name: 'MetaWeblog',
  region: 'international',
  contentTypes: ['article', 'text', 'image'],
  route: 'official',
  stylePrompt: '博客风格：通用博客，结构清晰。',
  mode: 'official',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const settings = await store.getSettings();
      const cfg = resolveMetaweblogCfg(settings.metaweblog);
      // blogger.getUsersBlogs：绝大多数 MetaWeblog 实现（WordPress/Typecho/独立实现）均支持
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: buildXmlRpcRequest('blogger.getUsersBlogs', ['', cfg.username, cfg.password]),
      });
      if (!res.ok) return { loggedIn: false, error: `HTTP ${res.status}` };
      const parsed = parseXmlRpcResponse(await res.text());
      if (!parsed.success) return { loggedIn: false, error: parsed.faultString };
      return { loggedIn: true, account: cfg.username, username: cfg.username };
    } catch (e: any) {
      return { loggedIn: false, error: e?.message || '连接失败' };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('MetaWeblog 图片缺少 dataUrl');
    const settings = await store.getSettings();
    const cfg = resolveMetaweblogCfg(settings.metaweblog);
    const blob = await dataUriToBlob(media.dataUrl);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mime = media.type || blob.type || 'image/jpeg';
    const ext = MIME_TO_EXT[mime] || 'png';
    const url = await uploadImageBytes(cfg, bytes, media.name || `image_${Date.now()}.${ext}`, mime);
    return { id: 'mw_media_' + Date.now(), url, type: mime };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    const settings = await store.getSettings();
    const cfg = resolveMetaweblogCfg(settings.metaweblog);

    // MetaWeblog description 是 HTML（不是 Markdown）：md2html 转换后再统一转存正文图片（单图失败不阻塞）
    let content = md2html(article.body || '');
    content = await processImages(
      content,
      async (src) => uploadBySrc(cfg, src),
      { skipPatterns: cfg.hostname ? [cfg.hostname] : [] },
    );
    // uploadMedia 阶段已上传的媒体：追加 HTML img 引用
    for (const ref of article.mediaRefs || []) {
      if (ref.url && !ref.url.startsWith('data:')) {
        content += `\n<img src="${ref.url}" alt="" />`;
      }
    }

    const finalTitle = article.title?.trim() || previewOf(article.body, 30) || 'CMS 文章';
    const post = { title: finalTitle, description: content, categories: [] };
    const value = await callXmlRpc(cfg, 'metaWeblog.newPost', [0, cfg.username, cfg.password, post, false], '保存草稿');
    const postId = String(value ?? '');

    return {
      platformId: 'metaweblog',
      draftId: postId,
      title: finalTitle,
      url: `${cfg.siteUrl}/admin/manage-posts.php?cid=${postId}`,
      previewText: previewOf(article.body),
      body: content,
      createdAt: Date.now(),
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    try {
      const settings = await store.getSettings();
      const cfg = resolveMetaweblogCfg(settings.metaweblog);
      const post = { title: draft.title || '', description: draft.body || '', categories: [] };
      await callXmlRpc(cfg, 'metaWeblog.editPost', [draft.draftId, cfg.username, cfg.password, post, true], '发布');
      return pubResult('metaweblog', true, {
        draftId: draft.draftId,
        url: `${cfg.siteUrl}/archives/${draft.draftId}/`,
      });
    } catch (e: any) {
      // 发布失败：保留草稿与编辑链接，诚实返回失败
      return pubResult('metaweblog', false, {
        draftId: draft.draftId,
        url: draft.url,
        error: e?.message || '发布失败',
      });
    }
  },
};
