import { Article, DraftRef, ExtractedArticle, PlatformAccount, PlatformId, PublishHistoryRecord, ScheduledItem } from '@omnipost/core';
import { detectBrowserLang, Lang } from '../lib/i18n';

/** 多账号条目（P2）：某平台的一个账号（含其独立凭证 config） */
export interface AccountEntry {
  id: string;
  name: string;
  config: any;
}

export interface PlatformSettings {
  wordpress?: {
    endpoint: string;
    username: string;
    appPassword?: string;
  };
  telegram?: {
    botToken: string;
    chatId: string;
  };
  twitter?: {
    apiKey?: string;
    apiSecret?: string;
    accessToken?: string;
    accessSecret?: string;
  };
  youtube?: {
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
  // Phase C C3：CMS（MetaWeblog XML-RPC 通道）
  typecho?: {
    siteUrl: string;
    endpoint?: string; // 默认 {siteUrl}/action/xmlrpc
    username: string;
    password: string;
  };
  metaweblog?: {
    siteUrl: string;
    endpoint?: string; // 默认 {siteUrl}/xmlrpc.php
    username: string;
    password: string;
  };
  // 海外社交平台
  bluesky?: {
    identifier: string; // handle 或 email
    appPassword: string; // Bluesky「设置→应用密码」生成
  };
  mastodon?: {
    instance: string; // 如 mastodon.social
    accessToken: string;
  };
  reddit?: {
    subreddit: string; // 目标板块，如 test 或 u_用户名
  };
  // 海外内容/技术社区（API 直连）
  devto?: {
    apiKey: string; // Dev.to「Settings → Extensions → DEV Community API Keys」生成
  };
  hashnode?: {
    apiKey: string; // Hashnode Personal Access Token（需 Pro 订阅）
    publicationId: string; // 目标 publication 的 GraphQL id
  };
  // 国内资讯平台（session 注入）
  toutiao?: {
    // 头条号无需凭证，复用 mp.toutiao.com 登录态（session 注入）
    homepage?: string;
  };
}

/** AI 文案生成配置（OpenAI 兼容，预置 DeepSeek/OpenAI/Qwen/Kimi/GLM） */
export interface AiSettings {
  provider: string; // 'deepseek' | 'openai' | 'qwen' | 'kimi' | 'glm' | 'custom'
  apiKey: string;
  model: string;
  baseUrl: string; // 空则用 provider 默认 baseUrl
}

export const store = {
  async getAuth(platformId: PlatformId): Promise<PlatformAccount> {
    try {
      const data = await chrome.storage.local.get('auth');
      return data.auth?.[platformId] || { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  },

  async getAllAuth(): Promise<Record<PlatformId, PlatformAccount>> {
    try {
      const data = await chrome.storage.local.get('auth');
      return data.auth || {};
    } catch {
      return {} as Record<PlatformId, PlatformAccount>;
    }
  },

  async setAuth(platformId: PlatformId, authData: PlatformAccount): Promise<void> {
    const data = await chrome.storage.local.get('auth');
    const newAuth = { ...data.auth, [platformId]: { ...authData, lastChecked: Date.now() } };
    await chrome.storage.local.set({ auth: newAuth });
  },

  async getDraft(id: string): Promise<Article | null> {
    const data = await chrome.storage.local.get('drafts');
    return data.drafts?.[id] || null;
  },

  async saveDraft(id: string, article: Article): Promise<void> {
    const data = await chrome.storage.local.get('drafts');
    const newDrafts = { ...data.drafts, [id]: article };
    await chrome.storage.local.set({ drafts: newDrafts });
  },

  async getHistory(): Promise<PublishHistoryRecord[]> {
    const data = await chrome.storage.local.get('history');
    return data.history || [];
  },

  async addHistory(record: PublishHistoryRecord): Promise<void> {
    const data = await chrome.storage.local.get('history');
    const history = data.history || [];
    history.unshift(record);
    // keep max 50
    if (history.length > 50) history.pop();
    await chrome.storage.local.set({ history });
  },

  async getSettings(): Promise<PlatformSettings> {
    const data = await chrome.storage.local.get(['settings', 'accounts', 'activeAccountId']);
    const merged: Record<string, any> = { ...(data.settings || {}) };
    // P2 多账号合并层：有活跃账号的平台用其 config 覆盖默认单账号配置
    const accounts = data.accounts || {};
    const active = data.activeAccountId || {};
    for (const [pid, accountId] of Object.entries(active)) {
      const acc = (accounts[pid] || []).find((a: any) => a.id === accountId);
      if (acc) merged[pid] = acc.config;
    }
    return merged as PlatformSettings;
  },

  async saveSettings(settings: Partial<PlatformSettings>): Promise<void> {
    const data = await chrome.storage.local.get('settings');
    const merged = { ...(data.settings || {}), ...settings };
    await chrome.storage.local.set({ settings: merged });
  },

  // ---- 草稿持久化（Chrome popup 失焦即关闭，必须落盘才能恢复） ----

  /**
   * 落盘待发布草稿。注意：媒体仅存元数据（name/type/size），不存 dataUrl——
   * chrome.storage.local 默认配额仅 10MB，一张大图 base64 即超限导致 set 抛错；
   * 媒体本体由 popup 会话持有，popup 重开后需重新添加。
   */
  async savePendingArticle(article: Article | null): Promise<void> {
    if (!article) {
      await chrome.storage.local.set({ pendingArticle: null });
      return;
    }
    const safeArticle: Article = {
      ...article,
      media: article.media?.map((m) => ({ id: m.id, name: m.name, type: m.type, size: m.size })) || []
    };
    await chrome.storage.local.set({ pendingArticle: safeArticle });
  },

  async getPendingArticle(): Promise<Article | null> {
    const data = await chrome.storage.local.get('pendingArticle');
    return data.pendingArticle || null;
  },

  async savePendingDrafts(drafts: DraftRef[]): Promise<void> {
    await chrome.storage.local.set({ pendingDrafts: drafts });
  },

  async getPendingDrafts(): Promise<DraftRef[]> {
    const data = await chrome.storage.local.get('pendingDrafts');
    return data.pendingDrafts || [];
  },

  async clearPending(): Promise<void> {
    await chrome.storage.local.remove(['pendingArticle', 'pendingDrafts']);
  },

  // ---- 从网页提取的文章（fab / popup "从当前页提取" → Side Panel 填充） ----

  async saveExtractedArticle(article: ExtractedArticle | null): Promise<void> {
    await chrome.storage.local.set({ extractedArticle: article });
  },

  async getExtractedArticle(): Promise<ExtractedArticle | null> {
    const data = await chrome.storage.local.get('extractedArticle');
    return data.extractedArticle || null;
  },

  // ---- Bridge Token（网页调用 window.syncPost 的一次性令牌） ----

  async ensureBridgeToken(): Promise<string> {
    const data = await chrome.storage.local.get('bridgeToken');
    if (data.bridgeToken) return data.bridgeToken;
    const token = 'om' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    await chrome.storage.local.set({ bridgeToken: token });
    return token;
  },

  async getBridgeToken(): Promise<string> {
    const data = await chrome.storage.local.get('bridgeToken');
    return data.bridgeToken || '';
  },

  // ---- UI 设置（与凭证无关的扩展行为开关，如隐藏悬浮同步按钮） ----

  async getUiSettings(): Promise<{ hideFab: boolean; publishMode: 'auto' | 'semi' }> {
    const data = await chrome.storage.local.get('ui');
    return {
      hideFab: !!(data.ui?.hideFab),
      publishMode: data.ui?.publishMode === 'semi' ? 'semi' : 'auto',
    };
  },

  async setUiSettings(patch: Partial<{ hideFab: boolean; publishMode: 'auto' | 'semi' }>): Promise<void> {
    const cur = await this.getUiSettings();
    await chrome.storage.local.set({ ui: { ...cur, ...patch } });
  },

  // ---- 界面语言（i18n：仅 zh/en） ----

  async getLang(): Promise<Lang> {
    const data = await chrome.storage.local.get('lang');
    if (data.lang === 'zh' || data.lang === 'en') return data.lang;
    return detectBrowserLang();
  },

  async setLang(lang: Lang): Promise<void> {
    await chrome.storage.local.set({ lang });
  },

  // ---- AI 配置（文案生成） ----

  async getAiSettings(): Promise<AiSettings> {
    const data = await chrome.storage.local.get('ai');
    return data.ai || { provider: 'deepseek', apiKey: '', model: 'deepseek-v4-flash', baseUrl: '' };
  },

  async setAiSettings(patch: Partial<AiSettings>): Promise<void> {
    const cur = await this.getAiSettings();
    await chrome.storage.local.set({ ai: { ...cur, ...patch } });
  },

  // ---- 定时发布队列（P1） ----

  async getScheduledQueue(): Promise<ScheduledItem[]> {
    const data = await chrome.storage.local.get('scheduledQueue');
    return data.scheduledQueue || [];
  },

  async saveScheduledQueue(items: ScheduledItem[]): Promise<void> {
    await chrome.storage.local.set({ scheduledQueue: items });
  },

  async addScheduled(item: ScheduledItem): Promise<void> {
    const cur = await this.getScheduledQueue();
    cur.push(item);
    await this.saveScheduledQueue(cur);
  },

  async removeScheduled(id: string): Promise<void> {
    const cur = await this.getScheduledQueue();
    await this.saveScheduledQueue(cur.filter((i) => i.id !== id));
  },

  // ---- 多账号矩阵（P2，仅 official 平台） ----

  async listAccounts(pid: PlatformId): Promise<AccountEntry[]> {
    const data = await chrome.storage.local.get('accounts');
    return (data.accounts || {})[pid] || [];
  },

  async addAccount(pid: PlatformId, name: string, config: any): Promise<string> {
    const data = await chrome.storage.local.get('accounts');
    const accounts = { ...(data.accounts || {}) };
    const list = accounts[pid] || [];
    const id = 'acc_' + pid + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    list.push({ id, name: name || '账号 ' + (list.length + 1), config });
    accounts[pid] = list;
    await chrome.storage.local.set({ accounts });
    return id;
  },

  async removeAccount(pid: PlatformId, accountId: string): Promise<void> {
    const data = await chrome.storage.local.get('accounts');
    const accounts = { ...(data.accounts || {}) };
    accounts[pid] = (accounts[pid] || []).filter((a: any) => a.id !== accountId);
    await chrome.storage.local.set({ accounts });
    // 若删除的是活跃账号，清掉活跃标记
    const active = await chrome.storage.local.get('activeAccountId');
    if (active.activeAccountId?.[pid] === accountId) {
      const next = { ...(active.activeAccountId || {}) };
      delete next[pid];
      await chrome.storage.local.set({ activeAccountId: next });
    }
  },

  async switchAccount(pid: PlatformId, accountId: string | null): Promise<void> {
    const data = await chrome.storage.local.get('activeAccountId');
    const active = { ...(data.activeAccountId || {}) };
    if (accountId) active[pid] = accountId;
    else delete active[pid];
    await chrome.storage.local.set({ activeAccountId: active });
  },

  async getActiveAccountId(pid: PlatformId): Promise<string | null> {
    const data = await chrome.storage.local.get('activeAccountId');
    return data.activeAccountId?.[pid] || null;
  }
};
