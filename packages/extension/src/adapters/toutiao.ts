/**
 * 今日头条（头条号）adapter —— API 直连（参考 Wechatsync 适配器）。
 *
 * 关键发现：头条号「只支持 HTML」（supportTypes: ['html']），不是 markdown。
 * 端点：POST https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article
 * 数据：
 *   - title: 标题
 *   - content: HTML 正文（不是 markdown）
 *   - save: '0' = 存草稿, '1' = 发布
 *   - pgc_id: 0=新建, 已有 pgc_id=更新
 *   - article_type: 0（普通文章）
 *
 * 流程：
 *   1. checkLogin: GET /mp/agw/media/get_media_info
 *   2. createDraft: POST publish save='0' → pgc_id（自动存草稿，用户手动点发布）
 *   3. publish: POST publish save='1' 用 pgc_id 发布（半自动模式跳过，仅返回 draftOnly）
 *
 * 没有公开 API 文档，端点参考 wechatsync + 头条号编辑器网络请求，需真实账号验证端点稳定性。
 */
import { PlatformAdapter, Article, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson } from './api-client';
import { md2html } from './md2html';
import { pubResult } from './api-base';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://mp.toutiao.com/*', headers: { Origin: 'https://mp.toutiao.com', Referer: 'https://mp.toutiao.com/' } },
];

const PUBLISH_URL = 'https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article';
const PROFILE_URL = 'https://mp.toutiao.com/mp/agw/media/get_media_info';

interface ToutiaoPublishRes {
  data?: { pgc_id?: number };
  message?: string;
  err_no?: number;
  code?: number; // 头条号实际响应字段（不是 err_no），success 时 code=0
  [k: string]: any;
}

/** 头条号响应判定：success 时 code===0（err_no 是旧版字段，少数版本仍可能用，都兼容） */
function isToutiaoSuccess(r: ToutiaoPublishRes): boolean {
  if (r.code === 0 || r.code === 200) return true;
  if (r.err_no === 0) return true;
  // 兜底：响应含 pgc_id 也算成功
  if (r.data?.pgc_id) return true;
  return false;
}

/** 发布（save=1）的严格判定：仅认显式成功码——草稿接口回显也带 pgc_id，不能用 pgc_id 兜底判发布成功 */
function isToutiaoPublished(r: ToutiaoPublishRes): boolean {
  return r.code === 0 || r.code === 200 || r.err_no === 0;
}

async function callPublish(article: Article, opts: { save: '0' | '1'; pgc_id?: string }): Promise<ToutiaoPublishRes> {
  const html = md2html(article.body || '');
  const body = new URLSearchParams({
    title: article.title || '',
    content: html,
    article_type: '0',
    article_ad_type: '2',
    from_diagnosis: '0',
    origin_debut_check_pgc_normal: '0',
    tree_plan_article: '0',
    save: opts.save,
    pgc_id: opts.pgc_id || '0',
    pgc_feed_covers: '[]',
  });
  const res = await withHeaderRules(HEADER_RULES, () =>
    apiFetch(PUBLISH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }),
  );
  return parseJson<ToutiaoPublishRes>(res, '头条号发布');
}

export const toutiaoAdapter: PlatformAdapter = {
  id: 'toutiao',
  name: '今日头条',
  region: 'domestic',
  contentTypes: ['article'],
  route: 'session',
  stylePrompt: '今日头条风格：中文资讯口吻，标题有新闻感、吸引点击，正文分段清晰、观点明确，适合资讯/图文内容。',
  mode: 'api',
  homepage: 'https://mp.toutiao.com/',

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const res = await withHeaderRules(HEADER_RULES, () => apiFetch(PROFILE_URL));
      const json = await parseJson<{ data?: { user?: { id?: string; screen_name?: string; https_avatar_url?: string } } }>(
        res,
        '头条号登录检测',
      );
      const u = json.data?.user;
      if (u?.id) {
        return { loggedIn: true, account: u.screen_name, username: u.screen_name, avatar: u.https_avatar_url };
      }
      return { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  },

  async createDraft(article: Article): Promise<DraftRef> {
    // save='0' = 存草稿（不发），返回 pgc_id
    const r = await callPublish(article, { save: '0' });
    if (!isToutiaoSuccess(r)) {
      // 把头条号真实 message 完整抛出（含 err_msg/code 调试信息）
      throw new Error(`头条号存草稿失败：${r.message || JSON.stringify(r)}`);
    }
    const pgcId = r.data?.pgc_id;
    if (!pgcId) throw new Error(`头条号存草稿失败：响应缺少 pgc_id — ${r.message || JSON.stringify(r)}`);
    return {
      platformId: 'toutiao',
      draftId: String(pgcId),
      title: article.title || '今日头条草稿',
      url: `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${pgcId}`,
      previewText: previewOf(article.body),
      body: article.body,
      createdAt: Date.now(),
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // save='1' = 发布（用已有 pgc_id 覆盖为发布态）
    try {
      const r = await callPublish(
        { title: draft.title, body: draft.body || '' } as Article,
        { save: '1', pgc_id: draft.draftId },
      );
      if (!isToutiaoPublished(r)) {
        return pubResult('toutiao', false, { error: `头条号发布失败：${r.message || JSON.stringify(r)}` });
      }
      const pgcId = r.data?.pgc_id || draft.draftId;
      return pubResult('toutiao', true, {
        url: `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${pgcId}`,
        draftId: String(pgcId),
      });
    } catch (e: any) {
      return pubResult('toutiao', false, { error: e?.message || '头条号发布失败' });
    }
  },
};
