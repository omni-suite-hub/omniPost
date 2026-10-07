/**
 * Offscreen 客户端 —— 供 background / adapter 调用。
 * 负责：ensureOffscreen 生命周期管理 + 上传请求封装 + 进度回传。
 */
import { UploadPart, UploadResult } from './offscreen';

let offscreenReady: Promise<void> | null = null;

/** 确保 offscreen document 已创建（幂等）。 */
export async function ensureOffscreen(): Promise<void> {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      try {
        const exists = await chrome.offscreen.hasDocument();
        if (!exists) {
          await chrome.offscreen.createDocument({
            // 注意路径：crxjs 把额外入口构建到 dist/src/offscreen/offscreen.html，
            // 写 'offscreen.html' 会解析到扩展根目录（不存在该文件）导致创建失败
            url: 'src/offscreen/offscreen.html',
            reasons: ['BLOBS' as unknown as chrome.offscreen.Reason],
            justification: '大文件媒体上传（multipart/分片）与进度回调需要长生命周期页面',
          });
        }
      } catch (e) {
        offscreenReady = null;
        throw e;
      }
    })();
  }
  return offscreenReady;
}

export interface OffscreenRequest {
  type: string;
  payload: any;
  timeoutMs?: number;
  onProgress?: (progress: number, phase?: string) => void;
}

/** 发送 offscreen 请求；若带 onProgress，自动监听该 requestId 的进度消息。 */
export function sendOffscreen(req: OffscreenRequest): Promise<UploadResult> {
  const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const timeoutMs = req.timeoutMs || 120000;

  return new Promise<UploadResult>((resolve, reject) => {
    ensureOffscreen()
      .then(() => {
        let progressListener: ((msg: any) => void) | null = null;
        let settled = false;
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`offscreen 上传超时（${timeoutMs}ms）`));
        }, timeoutMs);

        const cleanup = () => {
          clearTimeout(timer);
          if (progressListener) chrome.runtime.onMessage.removeListener(progressListener);
        };

        if (req.onProgress) {
          progressListener = (msg: any) => {
            if (msg?.type === 'OFFSCREEN_PROGRESS' && msg.requestId === requestId) {
              req.onProgress!(msg.progress, msg.phase);
            }
          };
          chrome.runtime.onMessage.addListener(progressListener);
        }

        try {
          chrome.runtime.sendMessage(
            { target: 'offscreen', type: req.type, requestId, payload: req.payload },
            (res) => {
              if (settled) return;
              settled = true;
              cleanup();
              const err = chrome.runtime.lastError;
              if (err) {
                reject(new Error(`offscreen 不可用: ${err.message}`));
                return;
              }
              resolve((res as UploadResult) || { ok: false, error: 'offscreen 无响应' });
            },
          );
        } catch (e: any) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`offscreen 调用异常: ${e?.message || e}`));
        }
      })
      .catch(reject);
  });
}

/** multipart 上传（Telegram / WordPress 等）。 */
export function uploadMultipart(
  url: string,
  parts: UploadPart[],
  opts: { method?: string; headers?: Record<string, string>; onProgress?: (p: number) => void; timeoutMs?: number } = {},
): Promise<UploadResult> {
  return sendOffscreen({
    type: 'OFFSCREEN_UPLOAD',
    payload: { url, method: opts.method, headers: opts.headers, parts },
    timeoutMs: opts.timeoutMs,
    onProgress: opts.onProgress ? (p) => opts.onProgress!(p) : undefined,
  });
}

/** 分片 PUT（YouTube resumable upload）。 */
export function uploadResumable(
  url: string,
  dataUrl: string,
  opts: { chunkSize?: number; headers?: Record<string, string>; onProgress?: (p: number) => void } = {},
): Promise<UploadResult> {
  return sendOffscreen({
    type: 'OFFSCREEN_RESUMABLE_UPLOAD',
    payload: { url, dataUrl, chunkSize: opts.chunkSize, headers: opts.headers },
    onProgress: opts.onProgress ? (p) => opts.onProgress!(p) : undefined,
  });
}
