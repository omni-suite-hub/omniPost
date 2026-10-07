/**
 * Hashnode adapter —— GraphQL API 直连（official 路线）。
 *
 * 注意（2026-08 核实）：Hashnode 自 2026-05-13 起，**所有 API 访问需 Pro 订阅**，
 * 免费账户的 Personal Access Token 调用会失败（FORBIDDEN）。代码结构正确，但免费用户会得到明确报错。
 *
 * API 要点：
 *   - Endpoint: https://gql.hashnode.com（GraphQL-only，无 REST）
 *   - 认证：`Authorization: <raw PAT>`（不带 Bearer 前缀，Hashnode 官方要求）
 *   - 发帖：mutation publishPost，input 含 title/contentMarkdown/publicationId/tags
 *   - 陷阱：GraphQL 错误常 HTTP 200 + json.errors[]，必须显式检查，否则静默假成功
 *
 * 配置：设置面板填 Hashnode PAT + publicationId（需 Pro）。
 */
import { PlatformAdapter, Article, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { store } from '../store';
import { pubResult } from './api-base';
import { previewOf } from './utils';

const HASHNODE_ENDPOINT = 'https://gql.hashnode.com';

async function gql(token: string, query: string, variables: Record<string, any>): Promise<any> {
  const res = await fetch(HASHNODE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token, // raw PAT，不带 Bearer
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => null);
  if (!json) {
    throw new Error(`Hashnode 响应异常（HTTP ${res.status}，非 JSON，可能 token 失效或 Cloudflare 拦截）`);
  }
  // GraphQL 错误：HTTP 200 也可能带 errors，必须显式检查防假成功
  if (json.errors?.length) {
    throw new Error(`Hashnode GQL: ${json.errors.map((e: any) => e.message).join('; ')}`);
  }
  return json.data;
}

/** 查 me：校验 token + 拿 publicationId（若未配置） */
async function me(token: string): Promise<{ id: string; username: string }> {
  const data = await gql(token, `query { me { id username } }`, {});
  if (!data?.me) throw new Error('Hashnode token 无效或未订阅 Pro（2026-05 起 API 需 Pro）');
  return { id: data.me.id, username: data.me.username };
}

function slugify(tag: string): string {
  return String(tag).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

function extractTags(body: string): { name: string; slug: string }[] {
  const tags: { name: string; slug: string }[] = [];
  const re = /#([\u4e00-\u9fa5a-zA-Z0-9_-]{2,20})/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (tags.length >= 5) break;
    tags.push({ name: m[1], slug: slugify(m[1]) });
  }
  return tags;
}

export const hashnodeAdapter: PlatformAdapter = {
  id: 'hashnode',
  name: 'Hashnode',
  region: 'international',
  contentTypes: ['article'],
  route: 'official',
  stylePrompt: 'Hashnode 风格：英文（English）技术博客口吻，标题简洁，正文用 Markdown 含代码块，面向开发者社区。',
  mode: 'official',
  capabilities: ['draft', 'tags'],
  homepage: 'https://hashnode.com/',
  draftIsPublished: true, // publishPost 在 createDraft 阶段即真实发布，半自动模式下不得标「已存草稿」

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const s = await store.getSettings();
      if (!s.hashnode?.apiKey) return { loggedIn: false };
      const u = await me(s.hashnode.apiKey);
      return { loggedIn: true, account: u.username, username: u.username };
    } catch {
      return { loggedIn: false };
    }
  },

  async createDraft(article: Article): Promise<DraftRef> {
    const s = await store.getSettings();
    if (!s.hashnode?.apiKey) throw new Error('Hashnode 未配置：请先在设置面板填写 PAT 与 publicationId');

    const body = article.body || '';
    const finalTitle = article.title?.trim() || previewOf(body, 30) || 'Untitled Post';
    const input: Record<string, any> = {
      title: finalTitle,
      contentMarkdown: body,
      publicationId: s.hashnode.publicationId,
      tags: extractTags(body),
    };
    // publishPost 即发布，无草稿两步；这里直接发布（语义同 Bluesky/Telegram）
    const data = await gql(s.hashnode.apiKey, `mutation PublishPost($input: PublishPostInput!) { publishPost(input: $input) { post { id url slug } } }`, { input });
    const post = data?.publishPost?.post;
    if (!post?.id) throw new Error('Hashnode 发布响应缺少 post.id');
    return {
      platformId: 'hashnode',
      draftId: String(post.id),
      title: finalTitle,
      url: post.url || 'https://hashnode.com/dashboard',
      previewText: previewOf(body),
      body,
      createdAt: Date.now(),
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // Hashnode publishPost 在 createDraft 阶段已真实发布，此处幂等返回成功（草稿即发语义）
    try {
      if (draft.url) return pubResult('hashnode', true, { url: draft.url });
      return pubResult('hashnode', false, { error: 'Hashnode 发布失败：缺少文章链接' });
    } catch (e: any) {
      return pubResult('hashnode', false, { error: e?.message || 'Hashnode 发布失败' });
    }
  },
};
