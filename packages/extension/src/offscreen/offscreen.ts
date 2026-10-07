/**
 * OmniPost Offscreen Document —— 媒体上传代理（真实实现）
 *
 * 职责（PRD §12.5 媒体管线）：Service Worker 短命，大文件上传 / 长耗时请求必须放在
 * offscreen document 中执行，避免 SW 被浏览器回收导致上传中断。
 *
 * 支持两种模式：
 *  - OFFSCREEN_UPLOAD           multipart/form-data（XHR，带真实上传进度），
 *                               供 Telegram sendPhoto/sendVideo、WordPress media 等使用。
 *  - OFFSCREEN_RESUMABLE_UPLOAD 分片 PUT（Content-Range），
 *                               供 YouTube Data API resumable upload 使用。
 *
 * 消息协议：
 *   请求  { target:'offscreen', type, requestId, payload }
 *   响应  sendResponse({ ok, status?, responseText?, error? })
 *   进度  chrome.runtime.sendMessage({ type:'OFFSCREEN_PROGRESS', requestId, progress, phase })
 */

/** dataUrl → Blob（浏览器内 fetch dataUrl 即可，node 单测走 TextDecoder 兜底）。 */
export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  try {
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch (e) {
    throw new Error(`媒体数据解析失败: ${(e as Error)?.message || e}`);
  }
}

export interface UploadPart {
  name: string;
  filename: string;
  type: string;
  dataUrl: string;
}

export interface UploadResult {
  ok: boolean;
  status?: number;
  responseText?: string;
  error?: string;
}

function httpError(status: number, text: string): Error {
  const brief = text.slice(0, 500);
  return new Error(`HTTP ${status}: ${brief || 'empty response'}`);
}

/**
 * multipart/form-data 上传（XHR 以获得 upload.onprogress）。
 * 返回 Promise<UploadResult>，进度经 onProgress 回调（0-100）。
 * （导出供单元测试直接调用纯逻辑）
 */
export async function multipartUpload(
  url: string,
  parts: UploadPart[],
  opts: {
    method?: string;
    headers?: Record<string, string>;
    onProgress?: (p: number) => void;
    timeoutMs?: number;
  } = {},
): Promise<UploadResult> {
  const { method = 'POST', headers = {}, onProgress, timeoutMs = 0 } = opts;
  return new Promise(async (resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);

    if (timeoutMs > 0) xhr.timeout = timeoutMs;
    xhr.onload = () => {
      onProgress?.(100);
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, responseText: xhr.responseText });
    };
    xhr.onerror = () => resolve({ ok: false, error: `网络错误（${url}）` });
    xhr.ontimeout = () => resolve({ ok: false, error: `上传超时（${timeoutMs}ms）` });
    if (xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress?.(Math.round((e.loaded / e.total) * 100));
      };
    }

    const form = new FormData();
    try {
      for (const part of parts) {
        // 必须先把 dataUrl 解码为二进制 Blob，否则 base64 字符串会被当作文件内容
        const blob = await dataUrlToBlob(part.dataUrl);
        form.append(part.name, blob, part.filename);
      }
    } catch (e: any) {
      resolve({ ok: false, error: e?.message || '媒体数据解析失败' });
      return;
    }
    xhr.send(form);
  });
}

/**
 * 分片 PUT 上传（Content-Range），供 YouTube resumable upload 使用。
 * - 单片上传：仅传一次（Content-Length 完整）。
 * - 分片上传：首片 Content-Range: bytes 0-{end-1}/{total}，末片后服务端返回 201。
 * 任何非 2xx/308 响应都视为失败并立即中止。
 */
export async function sliceUpload(
  url: string,
  blob: Blob,
  opts: {
    chunkSize?: number;
    headers?: Record<string, string>;
    onProgress?: (p: number) => void;
  } = {},
): Promise<UploadResult> {
  const { chunkSize = 256 * 1024, headers = {}, onProgress } = opts;
  const total = blob.size;

  if (total === 0) return { ok: false, error: '文件为空，无法上传' };

  const doPut = (start: number, end: number, isLast: boolean): Promise<UploadResult> => {
    return new Promise((resolve) => {
      const chunk = blob.slice(start, end);
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      if (isLast) {
        xhr.setRequestHeader('Content-Length', String(end - start));
      } else {
        xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${total}`);
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ ok: true, status: xhr.status, responseText: xhr.responseText });
        } else if (xhr.status === 308 && !isLast) {
          resolve({ ok: true, status: 308, responseText: xhr.responseText });
        } else {
          resolve({ ok: false, status: xhr.status, responseText: xhr.responseText, error: httpError(xhr.status, xhr.responseText).message });
        }
      };
      xhr.onerror = () => resolve({ ok: false, error: `分片上传网络错误 (bytes ${start}-${end - 1})` });
      xhr.send(chunk);
    });
  };

  if (total <= chunkSize) {
    const res = await doPut(0, total, true);
    onProgress?.(100);
    return res;
  }

  let start = 0;
  while (start < total) {
    const end = Math.min(start + chunkSize, total);
    const isLast = end === total;
    const res = await doPut(start, end, isLast);
    if (!res.ok) {
      onProgress?.(Math.round((start / total) * 100));
      return res;
    }
    onProgress?.(Math.round((end / total) * 100));
    if (res.status === 308 || !isLast) {
      start = end;
    } else {
      return res; // 201 完成
    }
  }
  return { ok: false, error: '分片上传循环异常' };
}

// ---------- offscreen 消息路由 ----------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  const { type, requestId, payload } = message;
  const reportProgress = (progress: number, phase = 'uploading') => {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_PROGRESS', requestId, progress, phase }).catch(() => {});
  };

  if (type === 'OFFSCREEN_UPLOAD') {
    // payload: { url, method?, headers?, parts: UploadPart[] }
    multipartUpload(payload.url, payload.parts, {
      method: payload.method,
      headers: payload.headers,
      onProgress: reportProgress,
      timeoutMs: payload.timeoutMs,
    }).then((res) => sendResponse(res));
    return true; // async response
  }

  if (type === 'OFFSCREEN_DOWNLOAD') {
    // payload: { dataUrl, filename }
    // Service Worker 无 DOM → 不能 URL.createObjectURL，而 data: URL 下载会被 Chrome
    // 固定命名为 download.zip（忽略 filename 参数）。这里在 offscreen（有 DOM）里
    // 转成 blob URL 再下载，文件名才能按文章标题生效。
    (async () => {
      try {
        const res = await fetch(payload.dataUrl);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const id = await chrome.downloads.download({ url: objectUrl, filename: payload.filename, saveAs: false });
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
        sendResponse({ ok: true, downloadId: id });
      } catch (e: any) {
        sendResponse({ ok: false, error: e?.message || '下载失败' });
      }
    })();
    return true;
  }

  if (type === 'OFFSCREEN_RESUMABLE_UPLOAD') {
    // payload: { url, dataUrl, chunkSize?, headers? }
    dataUrlToBlob(payload.dataUrl)
      .then((blob) =>
        sliceUpload(payload.url, blob, {
          chunkSize: payload.chunkSize,
          headers: payload.headers,
          onProgress: reportProgress,
        }),
      )
      .then((res) => sendResponse(res))
      .catch((e: any) => sendResponse({ ok: false, error: e?.message || '分片上传异常' }));
    return true;
  }

  return false;
});
