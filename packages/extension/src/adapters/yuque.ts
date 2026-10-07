/**
 * 语雀 adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用语雀私有 API（四步链）：
 *  1. checkLogin: 读 cookie yuque_ctoken → GET api/mine/common_used 取用户与默认知识库
 *  2. 建空文档:   POST api/docs → 拿到 postId（图片挂在 Doc 上，必须先建文档）
 *  3. 传图:       POST api/upload/attach?attachable_type=Doc&attachable_id={postId}&type=image
 *  4. 内容转换:   POST api/docs/convert（markdown → lake 格式）
 *  5. 保存内容:   PUT api/docs/{postId}/content
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（www.yuque.com/api/*）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson, getCookie } from './api-client';
import { processImages, dataUriToBlob, pubResult } from './api-base';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://www.yuque.com/api/*', headers: { Origin: 'https://www.yuque.com', Referer: 'https://www.yuque.com/dashboard' } },
];

let cachedBookId: string | null = null;
let cachedUser: { name?: string; avatar_url?: string } | null = null;

export const yuqueAdapter: PlatformAdapter = {
  id: 'yuque',
  name: '语雀',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '语雀风格：知识文档，结构清晰，善用标题层级与列表，正式但不刻板。',
  mode: 'api',
  homepage: 'https://www.yuque.com',
  capabilities: ['article', 'draft', 'image_upload', 'tags'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const ctoken = await getCookie('.yuque.com', 'yuque_ctoken');
      if (!ctoken) return { loggedIn: false };
      const res = await withHeaderRules(HEADER_RULES, () =>
        apiFetch('https://www.yuque.com/api/mine/common_used', { headers: { 'x-csrf-token': ctoken } }),
      );
      const json = await parseJson<{
        data?: { books?: Array<{ target_id?: string; user?: { id?: number; name?: string; avatar_url?: string } }> };
      }>(res, '语雀登录检测');
      const books = json.data?.books;
      if (books && books.length > 0) {
        cachedBookId = books[0].target_id || null;
        cachedUser = books[0].user || null;
        return {
          loggedIn: true,
          account: cachedUser?.name || '语雀用户',
          username: cachedUser?.name,
          avatar: cachedUser?.avatar_url,
        };
      }
      // 兜底：无常用知识库的新用户，通过 /api/users/current 检查登录态与个人知识库
      try {
        const userRes = await withHeaderRules(HEADER_RULES, () =>
          apiFetch('https://www.yuque.com/api/users/current', { headers: { 'x-csrf-token': ctoken } }),
        );
        const userJson = await parseJson<{ data?: { id?: number; name?: string; avatar_url?: string } }>(userRes, '语雀用户信息');
        if (userJson.data?.id) {
          cachedUser = userJson.data;
          try {
            const booksRes = await withHeaderRules(HEADER_RULES, () =>
              apiFetch('https://www.yuque.com/api/mine/personal_books', { headers: { 'x-csrf-token': ctoken } }),
            );
            const booksJson = await parseJson<{ data?: Array<{ id?: string | number }> }>(booksRes, '语雀个人知识库');
            if (booksJson.data?.[0]?.id) {
              cachedBookId = String(booksJson.data[0].id);
            }
          } catch {}
          return {
            loggedIn: true,
            account: cachedUser.name || '语雀用户',
            username: cachedUser.name,
            avatar: cachedUser.avatar_url,
          };
        }
      } catch {}
      return { loggedIn: false };
    } catch {
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    // 语雀图片必须挂在某个 Doc 上（attachable_id），uploadMedia 阶段无 Doc，记录媒体数据并推迟到 createDraft
    return {
      id: 'yuque_media_' + Date.now(),
      url: 'pending://yuque/' + encodeURIComponent(media.name),
      type: media.type,
      dataUrl: media.dataUrl,
    };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      const ctoken = await getCookie('.yuque.com', 'yuque_ctoken');
      if (!ctoken) throw new Error('请先登录语雀');
      const bookId = cachedBookId;
      if (!bookId) {
        const auth = await this.checkLogin();
        if (!auth.loggedIn) throw new Error('请先登录语雀');
      }

      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '语雀文档';
      // 1. 创建空文档（图片要挂在这个 Doc 上）
      const createRes = await apiFetch('https://www.yuque.com/api/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': ctoken },
        body: JSON.stringify({
          title: finalTitle,
          type: 'Doc',
          format: 'lake',
          book_id: cachedBookId,
          status: 0,
        }),
      });
      const createData = await parseJson<{ data?: { id?: string }; message?: string }>(createRes, '语雀创建文档');
      if (!createData.data?.id) throw new Error(createData.message || '语雀创建文档失败');
      const postId = createData.data.id;

      // 2. 图片上传（挂在 Doc 上）
      let markdown = article.body || '';
      for (const ref of article.mediaRefs || []) {
        if (ref.dataUrl) {
          markdown += `\n\n![${ref.id}](${ref.dataUrl})\n`;
        }
      }
      markdown = await processImages(markdown, async (src) => {
        const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
        const form = new FormData();
        form.append('file', blob, 'image.jpg');
        const upRes = await apiFetch(
          `https://www.yuque.com/api/upload/attach?attachable_type=Doc&attachable_id=${postId}&type=image`,
          { method: 'POST', headers: { 'x-csrf-token': ctoken }, body: form },
        );
        const upData = await parseJson<{ data?: { url?: string } }>(upRes, '语雀图片上传');
        if (!upData.data?.url) throw new Error('语雀图片上传失败');
        return { url: upData.data.url };
      }, { skipPatterns: ['yuque.com', 'cdn.nlark.com'] });

      // 3. markdown → lake 格式
      const convertRes = await apiFetch('https://www.yuque.com/api/docs/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': ctoken },
        body: JSON.stringify({ from: 'markdown', to: 'lake', content: markdown }),
      });
      const convertData = await parseJson<{ data?: { content?: string } }>(convertRes, '语雀内容转换');
      if (!convertData.data?.content) throw new Error('语雀内容转换失败');
      const lakeContent = convertData.data.content;

      // 4. 保存内容
      const saveRes = await apiFetch(`https://www.yuque.com/api/docs/${postId}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': ctoken },
        body: JSON.stringify({
          format: 'lake',
          body_asl: lakeContent,
          body: `<div class="lake-content" typography="traditional">${lakeContent}</div>`,
          body_html: `<div class="lake-content" typography="traditional">${lakeContent}</div>`,
          draft_version: 0,
          sync_dynamic_data: false,
          save_type: 'auto',
          edit_type: 'Lake',
        }),
      });
      if (!saveRes.ok) throw new Error(`语雀保存内容失败：HTTP ${saveRes.status}`);

      return {
        platformId: 'yuque',
        draftId: postId,
        title: finalTitle,
        url: `https://www.yuque.com/go/doc/${postId}/edit`,
        previewText: previewOf(article.body),
        body: lakeContent,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：内容已存入语雀文档（status:0 草稿），返回成功与编辑链接
    return pubResult('yuque', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
