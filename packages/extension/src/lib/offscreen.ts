/**
 * Offscreen Document 客户端（MV3）。
 *
 * Service Worker 生命周期短且没有 DOM：大文件上传、blob URL 下载等必须放到
 * offscreen document 里执行，否则会被浏览器回收中断，或根本拿不到 DOM API。
 *
 * 注意：offscreen.html 是运行时创建的（manifest 无对应字段），因此必须在
 * vite.config.ts 里显式声明为额外构建入口，否则产物中不存在该页面。
 */

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

let creating: Promise<boolean> | null = null;

/** 确保 offscreen document 已存在（并发安全；不可用时返回 false 由调用方降级）。 */
export async function ensureOffscreen(): Promise<boolean> {
  if (typeof chrome.offscreen?.createDocument !== 'function') return false;
  if (creating) return creating;
  creating = (async () => {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      } as any);
      if (contexts && contexts.length > 0) return true;
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL(OFFSCREEN_URL),
        reasons: ['BLOBS'] as any,
        justification: '本地导出 ZIP：Service Worker 无 DOM，需要 blob URL 才能按文章标题命名下载文件',
      });
      return true;
    } catch (e) {
      console.warn('[OmniPost] offscreen document 创建失败，将降级为 data URL 下载:', e);
      return false;
    }
  })();
  const ok = await creating;
  creating = null;
  return ok;
}

/** 经 offscreen 下载（dataUrl → blob → chrome.downloads，文件名可自定义）。失败返回 null。 */
export async function offscreenDownload(dataUrl: string, filename: string): Promise<number | null> {
  if (!(await ensureOffscreen())) return null;
  try {
    // 加超时：offscreen 通信一旦挂起会让整个发布卡死
    const res = await Promise.race([
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_DOWNLOAD', payload: { dataUrl, filename } }),
      new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
    if (res && (res as any).ok && typeof (res as any).downloadId === 'number') return (res as any).downloadId;
  } catch (e) {
    console.warn('[OmniPost] offscreen 下载失败，将降级为 data URL 下载:', e);
  }
  return null;
}
