import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { store } from '../store';
import { previewOf } from './utils';

/** Telegram Markdown 特殊字符（MarkdownV2：_ * [ ] ( ) ~ ` > # + - = | { } . !） */
const TG_SPECIAL = /([_*[\]()~`>#+\-=|{}.!])/g;
const TG_URL = /(https?:\/\/[^\s<>"'()]+)/g;

function escapeChars(text: string): string {
  return text.replace(TG_SPECIAL, '\\$1');
}

/**
 * MarkdownV2 安全转义：裸 URL 会破坏 MarkdownV2 渲染（且不会被自动链接化），
 * 因此先按 URL 切分，URL 段转义后显式包裹成 [url](url) 保持可点击，其余字符照常转义。
 * （export 供单元测试直接执行真实逻辑）
 */
export function escapeMarkdown(text: string): string {
  return text
    .split(TG_URL)
    .map((part, i) => {
      if (i % 2 === 1) {
        // URL 段：转义后包裹成 Telegram 链接语法（保持可点击与 MarkdownV2 规范）
        const esc = escapeChars(part);
        return `[${esc}](${esc})`;
      }
      return escapeChars(part);
    })
    .join('');
}

/** Telegram 限制：纯文本消息 4096 字符；图文 caption 1024 字符（超限 API 直接报错） */
const TG_TEXT_LIMIT = 4096;
const TG_CAPTION_LIMIT = 1024;

/** 按码点截断（防截断代理对） */
function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** 组装 caption/text：先按预算截断原始正文再转义（避免截断转义序列与链接语法） */
function buildTelegramText(title: string | undefined, body: string, hasMedia: boolean): string {
  const limit = hasMedia ? TG_CAPTION_LIMIT : TG_TEXT_LIMIT;
  const titlePart = title ? `**${escapeMarkdown(title)}**\n\n` : '';
  const budget = Math.max(0, limit - titlePart.length - 16); // 预留转义膨胀余量
  const bodyTrunc = truncateChars(body, budget);
  let text = titlePart + escapeMarkdown(bodyTrunc);
  // 转义后仍超长的极端兜底：硬截断并修掉末尾孤立反斜杠（防截断 \X 序列）
  if (Array.from(text).length > limit) {
    text = Array.from(text).slice(0, limit).join('');
    if (/\\$/.test(text)) text = text.slice(0, -1);
  }
  return text;
}

export const telegramAdapter: PlatformAdapter = {
  id: 'telegram',
  name: 'Telegram',
  region: 'international',
  contentTypes: ['text', 'image', 'video'],
  route: 'official',
  stylePrompt: 'Telegram 风格：简洁结构化，善用短段落与要点，可直接阅读。',
  mode: 'official',
  noRemoteDraft: true, // 平台无草稿概念：createDraft 仅本地暂存，半自动模式必须拦截

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const settings = await store.getSettings();
      const tg = settings.telegram;
      if (!tg?.botToken) {
        return { loggedIn: false };
      }

      const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/getMe`);
      if (res.ok) {
        const json = await res.json();
        if (json.ok && json.result) {
          return {
            loggedIn: true,
            account: `@${json.result.username}`
          };
        }
      }
      return { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem, onProgress?: (p: number) => void): Promise<MediaRef> {
    // Telegram 无草稿概念：媒体登记引用并保留 dataUrl，publish 阶段与正文一起真实发送
    // （sendMediaGroup/sendPhoto/sendVideo），避免"上传后发不出"的假成功。
    onProgress?.(100);
    return {
      id: 'tg_media_' + Date.now(),
      url: 'pending://telegram/' + encodeURIComponent(media.name),
      type: media.type,
      dataUrl: media.dataUrl
    };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    const settings = await store.getSettings();
    if (!settings.telegram?.botToken) {
      throw new Error('Telegram Bot Token 未配置，请先到设置面板填写');
    }
    // 草稿本地保存，发布阶段直接发送全文 + 媒体
    return {
      platformId: 'telegram',
      draftId: 'tg_' + Date.now(),
      title: article.title || 'Telegram 广播草稿',
      previewText: previewOf(article.body),
      body: article.body,
      mediaRefs: article.mediaRefs,
      createdAt: Date.now()
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    const settings = await store.getSettings();
    const tg = settings.telegram;
    if (!tg?.botToken || !tg?.chatId) {
      return {
        platformId: 'telegram',
        ok: false,
        error: 'Telegram Bot Token 或 Channel ID 未在设置中配置',
        timestamp: Date.now()
      };
    }

    const bodyText = draft.body || draft.previewText || '';
    const mediaRefs = (draft.mediaRefs || []).filter((m) => m.dataUrl);
    // Telegram 限制：纯文本 4096 / 图文 caption 1024，超限 API 直接报错，必须截断
    const caption = buildTelegramText(draft.title, bodyText, mediaRefs.length > 0);
    const apiBase = `https://api.telegram.org/bot${tg.botToken}`;

    try {
      // 无媒体 → 纯文本消息
      if (mediaRefs.length === 0) {
        const res = await fetch(`${apiBase}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: tg.chatId, text: caption, parse_mode: 'MarkdownV2' })
        });
        const json = await res.json();
        if (!json.ok) {
          return { platformId: 'telegram', ok: false, error: json.description || '发送失败', timestamp: Date.now() };
        }
        return {
          platformId: 'telegram',
          ok: true,
          url: `https://t.me/${String(tg.chatId).replace('@', '')}/${json.result?.message_id}`,
          timestamp: Date.now()
        };
      }

      // 有媒体 → 用 mediaGroup 一次发送（图文/视频混排，≤10 项，caption 放第一项）
      const items = mediaRefs.slice(0, 10);
      const mediaJson = items.map((m, i) => {
        const isVideo = (m.type || '').startsWith('video/');
        const base: Record<string, string> = { type: isVideo ? 'video' : 'photo', media: `attach://file${i}` };
        if (i === 0) base.caption = caption;
        if (i === 0) base.parse_mode = 'MarkdownV2';
        return base;
      });

      const form = new FormData();
      form.append('chat_id', tg.chatId);
      form.append('media', JSON.stringify(mediaJson));
      for (let i = 0; i < items.length; i++) {
        const blobRes = await fetch(items[i].dataUrl!);
        const blob = await blobRes.blob();
        form.append(`file${i}`, blob, items[i].url.split('/').pop() || `media_${i}`);
      }
      const mediaRes = await fetch(`${apiBase}/sendMediaGroup`, { method: 'POST', body: form });
      const mediaJsonRes = await mediaRes.json();
      if (!mediaJsonRes.ok) {
        return { platformId: 'telegram', ok: false, error: mediaJsonRes.description || '媒体发送失败', timestamp: Date.now() };
      }
      const firstMsg = mediaJsonRes.result?.[0];
      return {
        platformId: 'telegram',
        ok: true,
        url: `https://t.me/${String(tg.chatId).replace('@', '')}/${firstMsg?.message_id}`,
        timestamp: Date.now()
      };
    } catch (e: any) {
      return { platformId: 'telegram', ok: false, error: e?.message || 'Telegram 发送异常', timestamp: Date.now() };
    }
  }
};
