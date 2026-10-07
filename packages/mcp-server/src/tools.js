/**
 * OmniPost MCP 工具层（纯函数，可单测）
 *
 * 真实原则：
 *  - check_auth / sync_article 必须经 bridge sendCommand 由 Chrome 扩展真实执行，绝不假报 ready/成功；
 *  - upload_image 真实读取本地文件为 base64 dataUrl 并登记到 mediaStore，sync_article 携带这些媒体给扩展；
 *  - extract_article / list_platforms 为本地纯逻辑。
 */
import fs from 'fs';
import path from 'path';
import { PLATFORMS } from '@omnipost/bridge';

/** 本地媒体登记表：mediaId -> { id, name, type, size, dataUrl }（进程内存，随 MCP 生命周期存在） */
export const mediaStore = new Map();

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avif': 'image/avif',
};

function mimeOf(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function handleListPlatforms() {
  return { platforms: PLATFORMS.map((p) => ({ ...p })) };
}

export async function handleExtractArticle(args = {}, deps = {}) {
  const content = String(args.content || '').trim();
  // 有文本输入：本地解析标题/正文（向后兼容）；否则经 bridge 从当前浏览器页面智能提取
  if (content) {
    const lines = content.split('\n');
    const title = lines[0]?.startsWith('# ') ? lines[0].replace('# ', '').trim() : '';
    const body = title ? lines.slice(1).join('\n').trim() : content;
    return { title, body, mediaCount: 0, source: 'text' };
  }
  const send = deps.sendCommand;
  if (typeof send !== 'function') throw new Error('bridge sendCommand 不可用（需先启动 Chrome 扩展并启用 MCP 连接）');
  const result = await send({ type: 'extract', payload: {} });
  if (result.status === 'error') throw new Error(result.error || '正文提取失败');
  const article = result.article || {};
  return {
    title: article.title || '',
    body: article.markdown || '',
    cover: article.cover || undefined,
    summary: article.summary || undefined,
    url: article.url || '',
    mediaCount: 0,
    source: 'page',
  };
}

export function handleUploadImage(args = {}) {
  const filePath = String(args.path || '').trim();
  if (!filePath) throw new Error('缺少参数 path（本地图片绝对路径）');
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`不是文件: ${resolved}`);
  const mime = mimeOf(resolved);
  if (!mime.startsWith('image/')) throw new Error(`仅支持图片文件（当前 mime: ${mime}）`);

  const dataUrl = 'data:' + mime + ';base64,' + fs.readFileSync(resolved).toString('base64');
  const id = 'mcp_media_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const name = path.basename(resolved);
  const item = { id, name, type: mime, size: stat.size, dataUrl };
  mediaStore.set(id, item);
  return { mediaId: id, name, type: mime, sizeBytes: stat.size };
}

/** 按 mediaIds 从 mediaStore 还原媒体列表（未知 id 抛错，避免静默丢图）。 */
function resolveMedia(mediaIds) {
  const out = [];
  for (const mid of mediaIds || []) {
    const item = mediaStore.get(mid);
    if (!item) throw new Error(`未知 mediaId: ${mid}（请先用 upload_image 上传）`);
    out.push({ id: item.id, name: item.name, type: item.type, size: item.size, dataUrl: item.dataUrl });
  }
  return out;
}

export async function handleCheckAuth(args = {}, deps = {}) {
  const send = deps.sendCommand;
  if (typeof send !== 'function') throw new Error('bridge sendCommand 不可用');
  const result = await send({
    type: 'check_login',
    payload: { platforms: Array.isArray(args.platforms) ? args.platforms : [] },
  });
  if (result.status === 'error') throw new Error(result.error || '查询登录态失败');
  return { auth: result.auth || {} };
}

export async function handleSyncArticle(args = {}, deps = {}) {
  const send = deps.sendCommand;
  if (typeof send !== 'function') throw new Error('bridge sendCommand 不可用');
  const body = String(args.body || '').trim();
  if (!body) throw new Error('缺少参数 body（文章正文）');
  const media = resolveMedia(args.mediaIds);
  const result = await send({
    type: 'sync_article',
    payload: {
      title: String(args.title || ''),
      body,
      platforms: Array.isArray(args.platforms) ? args.platforms : [],
      media,
    },
  });
  if (result.status === 'error') throw new Error(result.error || '同步草稿失败');
  return {
    draftsCreated: (result.drafts || []).map((d) => d.platformId),
    drafts: result.drafts || [],
    results: result.results || [],
    errors: result.errors || {},
    // sync_article 走完整自动发布管线（建草稿→自动发布），results 里有逐平台真实状态
    message: '已由 Chrome 扩展执行完整发布流程；逐平台结果见 results（ok/draftOnly/error）。',
  };
}
