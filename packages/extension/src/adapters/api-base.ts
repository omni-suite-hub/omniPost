/**
 * API 直连 adapter 共享工具：图片处理、内容转换、结果构造。
 * 与 api-client.ts 配合，供所有"API 直连"平台 adapter 复用。
 *
 * 关键设计（对齐 CodeAdapter 思想）：
 * - Service Worker 无 DOM：图片处理用正则提取 URL（兼容 HTML <img> 与 Markdown ![]()），
 *   上传后做字符串替换，不依赖 DOMParser；
 * - uploadFn 自行处理 data URI 与远程 URL 两条路径；
 * - 同 URL 去重（同一张图只传一次），300ms 节流防触发风控。
 */

import { PublishResult, PlatformId } from '@omnipost/core';
import { sleep } from './api-client';

export interface ImageUploadResult {
  /** 新的图片 URL */
  url: string;
  /** 额外 img 属性（如 data-pid） */
  attrs?: Record<string, string | number>;
}

export interface ImageProcessOptions {
  /** 跳过匹配这些子串的远程图片（平台自身 CDN 等） */
  skipPatterns?: string[];
  onProgress?: (current: number, total: number) => void;
  /** 相邻上传间隔 ms（默认 300） */
  delayMs?: number;
}

interface ImgMatch {
  full: string;
  src: string;
  alt?: string;
  type: 'html' | 'markdown';
}

/** 提取 HTML 与 Markdown 中的所有图片 */
export function extractImages(content: string): ImgMatch[] {
  const matches: ImgMatch[] = [];
  const htmlImgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = htmlImgRegex.exec(content)) !== null) {
    matches.push({ full: m[0], src: m[1], type: 'html' });
  }
  const mdImgRegex = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gi;
  while ((m = mdImgRegex.exec(content)) !== null) {
    matches.push({ full: m[0], src: m[2], alt: m[1], type: 'markdown' });
  }
  return matches;
}

/**
 * 处理文章图片：逐个上传并替换 URL。
 * uploadFn 需自行处理 data URI / 远程 URL 两种入参。
 */
export async function processImages(
  content: string,
  uploadFn: (src: string) => Promise<ImageUploadResult>,
  options: ImageProcessOptions = {},
): Promise<string> {
  const { skipPatterns = [], onProgress, delayMs = 300 } = options;
  const matches = extractImages(content);
  if (matches.length === 0) return content;

  let result = content;
  const uploadedMap = new Map<string, ImageUploadResult>();
  let processed = 0;

  for (const { full, src, alt, type } of matches) {
    if (!src) continue;
    // data URI 不参与 skip 判断（本地图必须上传）；远程图命中平台 CDN 则跳过
    if (!src.startsWith('data:')) {
      if (skipPatterns.some((p) => src.includes(p))) continue;
    }
    processed++;
    onProgress?.(processed, matches.length);
    try {
      let uploadResult = uploadedMap.get(src);
      if (!uploadResult) {
        uploadResult = await uploadFn(src);
        uploadedMap.set(src, uploadResult);
      }
      if (type === 'html') {
        let replacement = `<img src="${uploadResult.url}"`;
        if (uploadResult.attrs) {
          for (const [k, v] of Object.entries(uploadResult.attrs)) replacement += ` ${k}="${v}"`;
        }
        replacement += ' />';
        result = result.replace(full, replacement);
      } else {
        result = result.replace(full, `![${alt || ''}](${uploadResult.url})`);
      }
    } catch {
      // 单图失败不阻塞整篇，保留原图引用
    }
    await sleep(delayMs);
  }
  return result;
}

/** data URI → Blob */
export async function dataUriToBlob(dataUri: string): Promise<Blob> {
  const res = await fetch(dataUri);
  return res.blob();
}

/** Blob → data URI */
export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('blob 读取失败')));
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

/** 构造发布结果（统一 timestamp） */
export function pubResult(platformId: PlatformId, ok: boolean, extra?: Partial<PublishResult>): PublishResult {
  return { platformId, ok, timestamp: Date.now(), ...extra };
}

/** HTML 压缩标签间空白（部分平台编辑器要求紧凑 HTML） */
export function compactHtml(html: string): string {
  return html.replace(/>\s+</g, '><');
}
