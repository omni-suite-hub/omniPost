/**
 * 下载文件命名修正。
 *
 * 背景：Service Worker 没有 DOM，无法用 URL.createObjectURL，本地 ZIP 导出只能走
 * `data:` URL。而 Chrome 对 data: URL 下载会**忽略** chrome.downloads.download 的
 * filename 参数，固定命名为 download.zip —— 多次导出会互相覆盖，用户找不到文件。
 *
 * 方案：用 chrome.downloads.onDeterminingFilename 在文件名确定阶段把标题名建议回去。
 * 该事件未触发时不影响原有行为（退化为默认名），属于尽力而为的修正。
 */

const pending = new Map<string, string>();
/** 最近一次登记的文件名（兜底槽）：offscreen 走 blob: URL 时键对不上，靠它兜住 */
let next: { name: string; ts: number } | null = null;
const TTL_MS = 60_000;

/** 注册"下一次该 URL 的下载应使用这个文件名"（URL 通常是 data: URL，可唯一定位）。 */
export function suggestDownloadName(url: string, filename: string): void {
  pending.set(url, filename);
  next = { name: filename, ts: Date.now() };
}

/** 在 background 顶层调用一次，注册监听。 */
export function installDownloadNaming(): void {
  if (!chrome.downloads?.onDeterminingFilename) return;
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const name = pending.get(item.url);
    if (name) {
      pending.delete(item.url);
      next = null;
      suggest({ filename: name });
      return;
    }
    // 兜底：offscreen 用 blob: URL 下载时 item.url 与登记的 data: URL 对不上，
    // 拿不到名字就会被固定成 download.zip（多次导出互相覆盖）。
    // 这里只对 blob:/data: 下载生效（HTTP(S) 下载是用户的正常下载，绝不干预），
    // 且 60s 内一次性消费，避免误命名其它文件。
    if (next && Date.now() - next.ts < TTL_MS && /^(blob|data):/.test(item.url || '')) {
      const n = next.name;
      next = null;
      suggest({ filename: n });
      return;
    }
    suggest();
  });
}
