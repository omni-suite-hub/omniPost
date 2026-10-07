/**
 * typecho adapter —— Typecho 博客（走 MetaWeblog XML-RPC，对标"文章同步助手"）。
 *
 * 机制：official 路线，用户在设置中配置 siteUrl / username / password：
 *  - 端点默认 {siteUrl}/action/xmlrpc（Typecho 的 MetaWeblog 端点，与 WordPress 的
 *    xmlrpc.php 不同，可手动覆盖）
 *  - checkLogin: metaWeblog.getUsersBlogs 测试连接
 *  - createDraft: metaWeblog.newPost(publish=false) 存草稿；
 *    Typecho 的 newPost 可能返回 0 → getRecentPosts 兜底查最新一篇真实 ID
 *  - publish: metaWeblog.editPost(publish=true) 真发布，失败保留草稿链接
 *
 * 与 metaweblog.ts 共享底层（XML-RPC 构建/解析、newMediaObject 图片上传），
 * 仅端点推导与 URL 语义不同。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { store } from '../store';
import {
  buildXmlRpcRequest,
  parseXmlRpcResponse,
  defaultTypechoEndpoint,
  XmlRpcStruct,
} from './xml-rpc';
import { processImages, dataUriToBlob, pubResult } from './api-base';
import { md2html } from './md2html';
import { previewOf } from './utils';
import {
  ResolvedCfg,
  resolveMetaweblogCfg,
  callXmlRpc,
  uploadImageBytes,
  uploadBySrc,
  MIME_TO_EXT,
  MetaweblogSettings,
} from './metaweblog';

export type TypechoSettings = MetaweblogSettings;

/** Typecho 的 newPost 可能返回 0，用 getRecentPosts 查最新一篇的真实 postid */
export async function getLatestPostId(cfg: ResolvedCfg): Promise<string | null> {
  try {
    const value = await callXmlRpc(cfg, 'metaWeblog.getRecentPosts', [0, cfg.username, cfg.password, 1], '查询最新文章');
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0] as XmlRpcStruct;
      if (first && typeof first.postid !== 'undefined' && String(first.postid) !== '0') {
        return String(first.postid);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export const typechoAdapter: PlatformAdapter = {
  id: 'typecho',
  name: 'Typecho',
  region: 'domestic',
  contentTypes: ['article', 'text', 'image'],
  route: 'official',
  stylePrompt: '博客风格：通用博客，结构清晰。',
  mode: 'official',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const settings = await store.getSettings();
      const cfg = resolveMetaweblogCfg(settings.typecho, 'Typecho', defaultTypechoEndpoint);
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: buildXmlRpcRequest('metaWeblog.getUsersBlogs', ['', cfg.username, cfg.password]),
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
    if (!media.dataUrl) throw new Error('Typecho 图片缺少 dataUrl');
    const settings = await store.getSettings();
    const cfg = resolveMetaweblogCfg(settings.typecho, 'Typecho', defaultTypechoEndpoint);
    const blob = await dataUriToBlob(media.dataUrl);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mime = media.type || blob.type || 'image/jpeg';
    const ext = MIME_TO_EXT[mime] || 'png';
    const url = await uploadImageBytes(cfg, bytes, media.name || `image_${Date.now()}.${ext}`, mime);
    return { id: 'typecho_media_' + Date.now(), url, type: mime };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    const settings = await store.getSettings();
    const cfg = resolveMetaweblogCfg(settings.typecho, 'Typecho', defaultTypechoEndpoint);

    // MetaWeblog description 是 HTML（不是 Markdown）：md2html 转换后再统一转存正文图片，
    // 否则裸 Markdown 原样发布，前台显示 ## / ** 等原始标记
    let content = md2html(article.body || '');
    content = await processImages(
      content,
      async (src) => uploadBySrc(cfg, src),
      { skipPatterns: cfg.hostname ? [cfg.hostname] : [] },
    );
    for (const ref of article.mediaRefs || []) {
      if (ref.url && !ref.url.startsWith('data:')) {
        content += `\n<img src="${ref.url}" alt="" />`;
      }
    }

    // Typecho 的 MetaWeblog 实现较老：post 只需 title/description
    const finalTitle = article.title?.trim() || previewOf(article.body, 30) || 'Typecho 草稿';
    const post = { title: finalTitle, description: content.trim() };
    const value = await callXmlRpc(cfg, 'metaWeblog.newPost', [0, cfg.username, cfg.password, post, false], '保存草稿');
    let postId = String(value ?? '');

    // Typecho 的 newPost 可能返回 0：兜底查最新一篇真实 ID
    if (!postId || postId === '0') {
      const latest = await getLatestPostId(cfg);
      if (latest) postId = latest;
    }

    return {
      platformId: 'typecho',
      draftId: postId,
      title: finalTitle,
      url: `${cfg.siteUrl}/admin/write-post.php?cid=${postId}`,
      previewText: previewOf(article.body),
      body: content,
      createdAt: Date.now(),
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    try {
      const settings = await store.getSettings();
      const cfg = resolveMetaweblogCfg(settings.typecho, 'Typecho', defaultTypechoEndpoint);
      let postId = draft.draftId;
      // 防御：draftId 缺失或为 0 时兜底查最新
      if (!postId || postId === '0') {
        const latest = await getLatestPostId(cfg);
        if (latest) postId = latest;
      }
      const post = { title: draft.title || '', description: draft.body || '' };
      await callXmlRpc(cfg, 'metaWeblog.editPost', [postId, cfg.username, cfg.password, post, true], '发布');
      return pubResult('typecho', true, {
        draftId: postId,
        url: `${cfg.siteUrl}/archives/${postId}/`,
      });
    } catch (e: any) {
      return pubResult('typecho', false, {
        draftId: draft.draftId,
        url: draft.url,
        error: e?.message || '发布失败',
      });
    }
  },
};
