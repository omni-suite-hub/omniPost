/**
 * zip-download adapter —— 本地导出为 Markdown + 图片的 ZIP 压缩包（对标"文章同步助手"）。
 *
 * 机制：不调任何平台 API，也不打开页面。createDraft 阶段完成全部工作：
 *  1. 正文作为 Markdown（无 `# 标题` 则补 `# {title}`）
 *  2. 提取正文图片（HTML <img> 与 Markdown ![]()），远程图 4 并发下载到内存，
 *     data URI 图解码写入；图片进 zip 的 images/ 目录，正文引用替换为相对路径
 *  3. buildZip → Blob → chrome.downloads.download 静默保存到下载目录
 * publish 返回"草稿即成功"（本地导出无发布概念）。
 *
 * 与 background 管线配合：无 uploadMedia（本地导出不走平台图床），
 * createDraft 失败抛错（内容为空 / 构建失败），不假成功。
 */
import { PlatformAdapter, Article, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { buildZip, buildZipDirectoryEntry, ZipEntry } from './zip-writer';
import { extractImages, pubResult } from './api-base';
import { suggestDownloadName } from '../lib/download-naming';
import { offscreenDownload } from '../lib/offscreen';
import { t, Lang } from '../lib/i18n';
import { store } from '../store';

const MAX_CONCURRENCY = 4;

/** 4 并发池下载全部远程图片 → Map<src, bytes>（单图失败跳过，不阻塞整篇） */
async function downloadAll(urls: string[]): Promise<Map<string, Uint8Array>> {
  const results = new Map<string, Uint8Array>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, urls.length) }, async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      try {
        const res = await fetch(url, { credentials: 'omit' });
        if (!res.ok) continue;
        results.set(url, new Uint8Array(await res.arrayBuffer()));
      } catch {
        // 单图下载失败：保留原引用
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** 解码 data URI（base64 与 percent-encoded 双支持） */
export function dataUriToBytes(dataUri: string): Uint8Array {
  const comma = dataUri.indexOf(',');
  if (comma < 0) throw new Error('无效的 data URI');
  const meta = dataUri.slice(5, comma);
  const payload = dataUri.slice(comma + 1);
  const binary = meta.includes(';base64') ? atob(payload) : decodeURIComponent(payload);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 从 URL / 魔数推断扩展名（对齐参考实现，补魔数兜底） */
export function imageExtFrom(url: string, bytes: Uint8Array): string {
  const m = url.match(/\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:\?|$)/i);
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'webp';
  return 'png';
}

/**
 * Uint8Array → base64（分块编码，避免大文件 String.fromCharCode(...arr) 爆栈）。
 * Service Worker 无 Blob/URL.createObjectURL，导出 zip 只能走 data URL。
 */
export function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32KB：兼顾性能与调用栈安全
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/** 清理文件名，移除非法字符（对齐参考实现） */
export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*]/g, '_') // Windows 非法字符
      .replace(/[\x00-\x1f]/g, '') // 控制字符
      .replace(/\.+$/, '') // 末尾的点
      .trim()
      .slice(0, 200) // 限制长度
    || 'article'
  );
}

export const zipDownloadAdapter: PlatformAdapter = {
  id: 'zip-download',
  name: 'Markdown 压缩包',
  region: 'domestic',
  contentTypes: ['article', 'text', 'image'],
  route: 'session', // 本地导出：无需登录/配置，总是可同步（无平台语义，仅归入"始终参与"分支）
  mode: 'session',
  capabilities: ['article', 'image_export'],

  async checkLogin(): Promise<PlatformAccount> {
    // 本地导出不需要认证
    return { loggedIn: true, account: '本地下载', username: '本地下载' };
  },

  // 无 uploadMedia：本地导出不走平台图床，图片由 createDraft 直接打包进 zip

  async createDraft(article: Article): Promise<DraftRef> {
    let markdown = article.body || '';
    if (!markdown.trim()) throw new Error('文章内容为空，无法导出');

    const title = article.title || '未命名文章';
    if (!markdown.trimStart().startsWith('# ')) {
      markdown = `# ${title}\n\n${markdown}`;
    }

    const matches = extractImages(markdown);
    const remoteUrls = matches.map((m) => m.src).filter((src) => !src.startsWith('data:'));
    const downloaded = await downloadAll(remoteUrls);
    const timestamp = Math.floor(Date.now() / 1000);
    const urlToName = new Map<string, string>();
    const imageEntries: ZipEntry[] = [];
    let index = 0;

    let processed = markdown;
    for (const { full, src } of matches) {
      let bytes: Uint8Array | undefined;
      if (src.startsWith('data:')) {
        try {
          bytes = dataUriToBytes(src);
        } catch {
          continue;
        }
      } else {
        bytes = downloaded.get(src);
      }
      if (!bytes) continue; // 下载失败 → 保留原引用

      let filename = urlToName.get(src);
      if (!filename) {
        index++;
        filename = `image_${timestamp}_${String(index).padStart(3, '0')}.${imageExtFrom(src, bytes)}`;
        urlToName.set(src, filename);
        imageEntries.push({ name: `images/${filename}`, data: bytes });
      }
      // 只替换 src 引用本身（保留 alt / 其他属性）
      processed = processed.replace(full, full.replace(src, `images/${filename}`));
    }

    // 本地导出无 uploadMedia（不走平台图床）：mediaList 的本地媒体直接打包进 zip 并追加引用
    for (const m of article.media || []) {
      if (!m.dataUrl) continue;
      try {
        const mediaBytes = dataUriToBytes(m.dataUrl);
        index++;
        const mediaFilename = `image_${timestamp}_${String(index).padStart(3, '0')}.${imageExtFrom(m.dataUrl, mediaBytes)}`;
        imageEntries.push({ name: `images/${mediaFilename}`, data: mediaBytes });
        processed += `\n![${m.name || 'media'}](images/${mediaFilename})\n`;
      } catch {
        // 单个媒体解码失败：跳过，不阻塞整篇
      }
    }

    const entries: ZipEntry[] = [{ name: 'article.md', data: new TextEncoder().encode(processed) }];
    if (imageEntries.length > 0) {
      entries.push(buildZipDirectoryEntry('images/'));
      entries.push(...imageEntries);
    }

    const bytes = buildZip(entries);
    const filename = sanitizeFilename(title) + '.zip';

    // 关键：MV3 Service Worker 没有 DOM，URL.createObjectURL 根本不存在
    // （旧实现会抛 "URL.createObjectURL is not a function"，导致本地导出 100% 失败）。
    // 改为直接把 zip 编成 base64 data URL 交给 chrome.downloads（下载 API 支持 data: URL）。
    const dataUrl = `data:application/zip;base64,${uint8ToBase64(bytes)}`;
    // Chrome 会忽略 data: URL 下载的 filename 参数（固定叫 download.zip，多次导出互相覆盖），
    // 先登记期望文件名，由 onDeterminingFilename 在命名阶段改回去。
    suggestDownloadName(dataUrl, filename);
    // 优先经 offscreen 用 blob URL 下载（文件名才生效）；offscreen 不可用时降级为 data URL。
    const offscreenId = await offscreenDownload(dataUrl, filename);
    const downloadId = offscreenId ?? (await chrome.downloads.download({ url: dataUrl, filename, saveAs: false }));

    // previewText 会进历史记录并在界面上展示，必须本地化：
    // 之前是硬编码中文模板串，英文界面历史面板会漏中文（ui-audit 实测）
    let lang: Lang = 'zh';
    try { lang = await store.getLang(); } catch { /* 读取失败按中文兜底 */ }
    return {
      platformId: 'zip-download',
      draftId: String(downloadId),
      title,
      url: '',
      previewText: t('已下载 {file}（{n} 张图片）', lang)
        .replace('{file}', filename)
        .replace('{n}', String(imageEntries.length)),
      createdAt: Date.now(),
    };
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 本地导出语义：createDraft 已触发下载，无"发布"动作
    return pubResult('zip-download', true, { draftId: draft.draftId, url: '' });
  },
};
