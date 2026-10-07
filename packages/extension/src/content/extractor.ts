/**
 * 文章正文提取器（content script，DOM 环境）。
 *
 * 对标"文章同步助手"的网页转 Markdown：从当前页面智能提取标题、正文、封面图、摘要。
 * 提取策略：
 *   1. 站点特定提取（微信公众号 #js_content）
 *   2. 通用提取（Mozilla Readability，Apache-2.0，见 lib/Readability.js）
 *   3. 懒加载图片处理（data-src / data-original / data-actualsrc / _src → src）
 *
 * 输出 { title, markdown, cover, summary, url }，经 chrome.runtime.onMessage
 * 的 EXTRACT_ARTICLE 消息供 popup / background / MCP 复用。
 */
import type { ExtractedArticle } from '@omnipost/core';
import { html2md } from '../adapters/html2md';
import Readability, { ReadabilityParseResult } from './lib/Readability';

export type { ExtractedArticle };

/** Readability 构造器形状（便于单测注入 mock） */
export type ReadabilityCtor = new (doc: Document, options?: Record<string, unknown>) => {
  parse(): ReadabilityParseResult | null;
};

/** 懒加载图片属性优先级（微信/知乎/掘金等常见 data-src 约定） */
const LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-actualsrc', 'data-lazy-src', '_src', 'data-url'];

/** 把懒加载图片的真实地址解析到 src，供 Readability 与 html2md 正确取图 */
export function resolveLazyImages(root: ParentNode): void {
  const imgs = root.querySelectorAll('img');
  imgs.forEach((img) => {
    for (const attr of LAZY_SRC_ATTRS) {
      const v = img.getAttribute(attr);
      if (v && !v.startsWith('data:image')) {
        img.setAttribute('src', v);
        break;
      }
    }
  });
}

/** 提取封面图：优先 og:image，其次正文首图 */
function pickCover(doc: Document, contentHtml: string): string | undefined {
  const og = doc.querySelector('meta[property="og:image"]')?.getAttribute('content');
  if (og) return og;
  // 从正文 HTML 里找第一张图
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(contentHtml);
  return m ? m[1] : undefined;
}

/** 提取摘要：og:description 优先 */
function pickSummary(doc: Document, fallback?: string): string | undefined {
  const og = doc.querySelector('meta[property="og:description"]')?.getAttribute('content')
    || doc.querySelector('meta[name="description"]')?.getAttribute('content');
  return og || fallback || undefined;
}

/** 微信公众号正文提取 */
function extractWeixin(doc: Document): ExtractedArticle | null {
  const title = doc.querySelector('#activity-name')?.textContent?.trim()
    || doc.querySelector('meta[property="og:title"]')?.getAttribute('content')
    || doc.title;
  const contentEl = doc.querySelector('#js_content') as HTMLElement | null;
  if (!title || !contentEl) return null;

  // 微信正文图片走 data-src 懒加载，克隆后处理再取 innerHTML
  const clone = contentEl.cloneNode(true) as HTMLElement;
  resolveLazyImages(clone);
  const html = clone.innerHTML;
  const markdown = html2md(html);
  if (!markdown.trim()) return null;

  return {
    title,
    markdown,
    html,
    cover: pickCover(doc, html),
    summary: pickSummary(doc),
    url: doc.location?.href || '',
    platform: 'weixin',
  };
}

/** 通用正文提取（Readability） */
function extractGeneric(doc: Document, ReadabilityCtor: ReadabilityCtor): ExtractedArticle | null {
  const url = doc.location?.href || '';

  // 克隆文档避免污染页面；在克隆上处理懒加载图片
  const clone = doc.cloneNode(true) as Document;
  resolveLazyImages(clone);

  let parsed: ReadabilityParseResult | null = null;
  try {
    parsed = new ReadabilityCtor(clone).parse();
  } catch {
    parsed = null;
  }
  if (!parsed || !parsed.content || !parsed.content.trim()) return null;

  const markdown = html2md(parsed.content);
  if (!markdown.trim()) return null;

  const title = parsed.title || doc.title || '';
  return {
    title,
    markdown,
    html: parsed.content,
    cover: pickCover(doc, parsed.content),
    summary: pickSummary(doc, parsed.excerpt),
    url,
    platform: 'generic',
  };
}

/**
 * 提取入口：按 URL 分流站点特定 / 通用提取。
 * @param doc 目标文档（默认当前页面）；单测可传 mock。
 * @param ReadabilityCtor 可注入 Readability 实现（单测 mock）。
 */
export function extractArticle(
  doc: Document = document,
  ReadabilityCtor: ReadabilityCtor = Readability,
): ExtractedArticle | null {
  const url = doc.location?.href || '';

  // 微信公众号
  if (url.includes('mp.weixin.qq.com')) {
    return extractWeixin(doc);
  }

  return extractGeneric(doc, ReadabilityCtor);
}
