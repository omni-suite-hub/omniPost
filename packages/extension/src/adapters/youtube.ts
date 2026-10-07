import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { store } from '../store';
import { previewOf } from './utils';
import { uploadResumable } from '../offscreen/client';
import {
  YoutubeConfig, ensureAccessToken, createResumableSession, updateVideo, fetchChannel, isTokenValid,
} from './youtube-oauth';

/**
 * YouTube 走 official 路线（YouTube Data API v3）：
 *  - OAuth2 (PKCE) 授权：设置面板填 Google Cloud OAuth Client ID/Secret → 点授权
 *  - uploadMedia：videos.insert resumable 上传（隐私为 private，即"草稿"）
 *  - createDraft：videos.update 补齐标题/描述（保持 private）
 *  - publish：videos.update 改为 public
 * 未授权/无视频时不伪造成功，一律明确报错。
 */
export const youtubeAdapter: PlatformAdapter = {
  id: 'youtube',
  name: 'YouTube',
  region: 'international',
  contentTypes: ['video'],
  route: 'official',
  mode: 'official',
  stylePrompt: 'YouTube 风格：视频描述，用英文（English）输出，标题简洁有力、含关键词，正文结构化（简介 / 章节时间戳 / 链接 / 话题标签），可带 emoji 分段，面向全球观众。',

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const settings = await store.getSettings();
      const yt = settings.youtube || {};
      if (!yt.clientId || !isTokenValid(yt)) {
        return { loggedIn: false };
      }
      const { token, updated } = await ensureAccessToken(yt);
      if (updated) await store.saveSettings({ youtube: { ...yt, ...updated } });
      const channel = await fetchChannel(token);
      return { loggedIn: true, account: channel.name, avatar: channel.avatar };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem, onProgress?: (p: number) => void): Promise<MediaRef> {
    const settings = await store.getSettings();
    const yt: YoutubeConfig = settings.youtube || {};
    if (!yt.clientId) {
      throw new Error('YouTube 未配置 OAuth Client，请到设置面板填写 Client ID/Secret 并授权');
    }
    if (!media.dataUrl) {
      throw new Error(`「${media.name}」缺少媒体数据，无法上传`);
    }

    const { token, updated } = await ensureAccessToken(yt);
    if (updated) await store.saveSettings({ youtube: { ...yt, ...updated } });

    // 1) 创建 resumable 上传会话（占位标题；真实标题/描述在 createDraft 阶段补齐）
    onProgress?.(5);
    const uploadUrl = await createResumableSession(token, { title: media.name, description: '' }, media.size, media.type);

    // 2) 分片上传（offscreen，长生命周期 + 真实进度）
    const res = await uploadResumable(uploadUrl, media.dataUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
      onProgress: (p) => onProgress?.(Math.min(95, 5 + p * 0.9)),
    });
    if (!res.ok) {
      throw new Error(`YouTube 视频上传失败: ${res.error || `HTTP ${res.status}`}`);
    }

    // 3) 解析 videoId
    let videoId = '';
    try {
      videoId = JSON.parse(res.responseText || '{}')?.id || '';
    } catch { /* ignore */ }
    if (!videoId) {
      throw new Error('YouTube 上传响应缺少 videoId');
    }
    onProgress?.(100);
    return {
      id: videoId,
      url: `https://youtu.be/${videoId}`,
      type: media.type
    };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    const settings = await store.getSettings();
    const yt: YoutubeConfig = settings.youtube || {};
    const mediaRef = article.mediaRefs?.[0];
    if (!mediaRef?.id) {
      throw new Error('YouTube 草稿需要先上传视频（请添加一个视频文件）');
    }
    const videoId = mediaRef.id;
    const { token, updated } = await ensureAccessToken(yt);
    if (updated) await store.saveSettings({ youtube: { ...yt, ...updated } });

    // 补齐标题/描述，保持 private（草稿状态）
    // YouTube 限制：标题 ≤100 字符，描述 ≤5000 字符（超限 API 报错），按码点截断
    const title = Array.from(article.title || 'OmniPost 视频').slice(0, 100).join('');
    const description = Array.from(article.body || '').slice(0, 5000).join('');
    await updateVideo(token, videoId, { title, description, privacyStatus: 'private' });

    return {
      platformId: 'youtube',
      draftId: videoId,
      title: article.title || 'YouTube 视频草稿',
      url: `https://youtu.be/${videoId}`,
      previewText: previewOf(article.body),
      body: article.body,
      createdAt: Date.now()
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    const settings = await store.getSettings();
    const yt: YoutubeConfig = settings.youtube || {};
    if (!draft.draftId) {
      return { platformId: 'youtube', ok: false, error: '缺少视频 ID，无法发布', timestamp: Date.now() };
    }
    try {
      const { token, updated } = await ensureAccessToken(yt);
      if (updated) await store.saveSettings({ youtube: { ...yt, ...updated } });
      // 草稿(私有) → 公开
      await updateVideo(token, draft.draftId, { privacyStatus: 'public' });
      return {
        platformId: 'youtube',
        ok: true,
        url: `https://youtu.be/${draft.draftId}`,
        draftId: draft.draftId,
        timestamp: Date.now()
      };
    } catch (e: any) {
      return {
        platformId: 'youtube',
        ok: false,
        error: e?.message || 'YouTube 发布异常',
        timestamp: Date.now()
      };
    }
  }
};
