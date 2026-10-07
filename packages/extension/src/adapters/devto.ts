/**
 * Dev.to adapter —— Forem REST API 直连（official 路线）。
 *
 * API 要点（2026-08 核实）：
 *   - Base: https://dev.to/api
 *   - 认证：`api-key` header（注意不是 Authorization: Bearer）
 *   - Accept: application/vnd.forem.api-v1+json
 *   - 发帖：POST /api/articles，body 包在 { article: {...} } 里
 *   - 校验：GET /api/users/me
 *   - 无 OAuth，单一 API key；tags 最多 4 个，全小写、仅字母数字
 *
 * 语义：createDraft 用 published:false 建草稿，publish 用 PUT /api/articles/:id 翻转 published=true。
 * 配置：设置面板填 Dev.to API key（dev.to/settings/extensions 生成）。
 */
import { PlatformAdapter, Article, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { store } from '../store';
import { pubResult } from './api-base';
import { previewOf } from './utils';

const DEVTO_BASE = 'https://dev.to/api';
const DEVTO_HEADERS = (apiKey: string) => ({
  'api-key': apiKey,
  'Content-Type': 'application/json',
  Accept: 'application/vnd.forem.api-v1+json',
});

/** Dev.to tags 规整：最多 4 个，全小写、仅字母数字 */
function normalizeTags(tags: string[]): string[] {
  return tags
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)
    .slice(0, 4);
}

/** 从正文提取 tags（找 #标签 或常见格式），无则空数组 */
function extractTags(body: string): string[] {
  const tags: string[] = [];
  const re = /#([\u4e00-\u9fa5a-zA-Z0-9_-]{2,20})/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (tags.length >= 4) break;
    tags.push(m[1]);
  }
  return normalizeTags(tags);
}

async function me(apiKey: string): Promise<{ username: string }> {
  const res = await fetch(`${DEVTO_BASE}/users/me`, { headers: DEVTO_HEADERS(apiKey) });
  if (!res.ok) {
    let msg = `Dev.to 登录失败（HTTP ${res.status}）`;
    try { const j = await res.json(); msg = j?.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const j = await res.json();
  if (!j?.username) throw new Error('Dev.to 会话响应缺少 username');
  return { username: j.username };
}

export const devtoAdapter: PlatformAdapter = {
  id: 'devto',
  name: 'Dev.to',
  region: 'international',
  contentTypes: ['article'],
  route: 'official',
  stylePrompt: 'Dev.to 风格：英文（English）技术博客口吻，标题简洁有力，正文用 Markdown，可含代码块，面向开发者社区。',
  mode: 'official',
  capabilities: ['draft', 'tags'],
  homepage: 'https://dev.to/',

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const s = await store.getSettings();
      if (!s.devto?.apiKey) return { loggedIn: false };
      const u = await me(s.devto.apiKey);
      return { loggedIn: true, account: u.username, username: u.username };
    } catch {
      return { loggedIn: false };
    }
  },

  async createDraft(article: Article): Promise<DraftRef> {
    const s = await store.getSettings();
    if (!s.devto?.apiKey) throw new Error('Dev.to 未配置：请先在设置面板填写 API key');

    const body = article.body || '';
    const finalTitle = article.title?.trim() || previewOf(body, 30) || 'Untitled Post';
    const res = await fetch(`${DEVTO_BASE}/articles`, {
      method: 'POST',
      headers: DEVTO_HEADERS(s.devto.apiKey),
      body: JSON.stringify({
        article: {
          title: finalTitle,
          body_markdown: body,
          published: false, // 草稿优先，publish 阶段再翻转
          tags: extractTags(body),
          description: previewOf(body).slice(0, 150),
        },
      }),
    });
    if (!res.ok) {
      let msg = `Dev.to 创建草稿失败（HTTP ${res.status}）`;
      try { const j = await res.json(); msg = j?.error || j?.message || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const j = await res.json();
    if (!j?.id) throw new Error('Dev.to 创建草稿响应缺少 id');
    return {
      platformId: 'devto',
      draftId: String(j.id),
      title: finalTitle,
      url: j.url || `https://dev.to/dashboard`,
      previewText: previewOf(body),
      body,
      createdAt: Date.now(),
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    try {
      const s = await store.getSettings();
      if (!s.devto?.apiKey) return pubResult('devto', false, { error: 'Dev.to 未配置：请先在设置面板填写 API key' });

      // PUT /api/articles/:id 翻转 published=true
      const res = await fetch(`${DEVTO_BASE}/articles/${draft.draftId}`, {
        method: 'PUT',
        headers: DEVTO_HEADERS(s.devto.apiKey),
        body: JSON.stringify({ article: { published: true } }),
      });
      if (!res.ok) {
        let msg = `Dev.to 发布失败（HTTP ${res.status}）`;
        try { const j = await res.json(); msg = j?.error || j?.message || msg; } catch { /* ignore */ }
        return pubResult('devto', false, { error: msg });
      }
      const j = await res.json();
      return pubResult('devto', true, { url: j?.url || `https://dev.to/dashboard` });
    } catch (e: any) {
      return pubResult('devto', false, { error: e?.message || 'Dev.to 发布失败' });
    }
  },
};
