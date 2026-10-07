/**
 * OmniPost 悬浮多功能工具栏（FAB）。
 *
 * 设计：
 *   - 主按钮：36×36 圆形 focus ring（白底 + indigo 描边 + 深灰 outline 图标），
 *     点击即"提取正文并拉起 Side Panel 一键发布"（核心功能）。
 *   - hover 主按钮 → 主按钮展开为胶囊显示「同步此页」，同时左侧滑出 3 个工具：
 *     · 复制 Markdown（📋）
 *     · 复制纯文本
 *     · 下载 Markdown 文件
 *
 * 与豆包/秘塔/Edge Copilot 等"蓝渐变胶囊"刻意区分：白底 + outline 图标 + 圆形 focus ring。
 */
import { extractArticle, ExtractedArticle } from './extractor';
import { t, Lang } from '../lib/i18n';
import { store } from '../store';

let fabLang: Lang = 'zh';

const FAB_ID = 'omnipost-fab';
const FAB_H = 36;
const FAB_W_COLLAPSED = 36;
const FAB_W_EXPANDED = 118;
const ACTION_SIZE = 34;

const PULSE_KEYFRAMES = `
  @keyframes omnipost-fab-pulse {
    0%, 100% { box-shadow: 0 2px 8px rgba(99, 102, 241, 0.22); }
    50%      { box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4), 0 0 0 6px rgba(99, 102, 241, 0.08); }
  }
`;

// —— 图标（深灰 #475569 stroke）——
const ICON_SYNC = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12a9 9 0 1 1-3.5-7.13"/>
    <polyline points="21 4 21 9 16 9"/>
  </svg>`;
const ICON_COPY_MD = `
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="9" width="12" height="12" rx="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    <path d="M12 15h2M15 15v2" opacity="0"/>
  </svg>`;
const ICON_COPY_TEXT = `
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 6h16M4 12h16M4 18h10"/>
  </svg>`;
const ICON_DOWNLOAD = `
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3v12M6 11l6 6 6-6M4 21h16"/>
  </svg>`;
const ICON_OK = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 6L9 17l-5-5"/>
  </svg>`;
const ICON_ERR = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
  </svg>`;

/** markdown → 纯文本（去掉标题/链接/图片/代码围栏等标记，保留可读结构） */
function markdownToPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/^```[a-zA-Z0-9_+-]*\n?/gm, '').replace(/```$/gm, ''))
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 安全文件名（移除非法字符 + 长度截断） */
function safeFileName(title: string): string {
  const base = (title || 'article').replace(/[\\/:*?"<>|#\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return base || 'article';
}

/** 复制到剪贴板（含 execCommand 兜底） */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fallthrough */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 下载 markdown 为 .md 文件 */
function downloadMarkdown(article: ExtractedArticle): boolean {
  try {
    const blob = new Blob([article.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFileName(article.title)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

/** 创建基础圆形按钮 */
function makeButton(size: number, innerHTML: string, title: string, onClick: () => void, opts: { pulse?: boolean; primary?: boolean } = {}): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('role', 'button');
  el.setAttribute('title', title);
  el.style.cssText = `
    width: ${size}px !important;
    height: ${size}px !important;
    border-radius: ${size / 2}px !important;
    background: #ffffff !important;
    border: 1px solid rgba(99, 102, 241, 0.18) !important;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08), 0 1px 3px rgba(15, 23, 42, 0.04) !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    user-select: none !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif !important;
    transition: transform 0.2s, background 0.2s, border-color 0.2s, box-shadow 0.2s !important;
    box-sizing: border-box !important;
  `;
  el.innerHTML = innerHTML;
  if (opts.pulse) el.style.animation = 'omnipost-fab-pulse 1.2s ease-in-out 3';
  el.addEventListener('mouseenter', () => { el.style.transform = 'translateY(-2px)'; });
  el.addEventListener('mouseleave', () => { el.style.transform = 'translateY(0)'; });
  el.addEventListener('click', onClick);
  return el;
}

/** 创建悬浮多功能工具栏 */
export function createSyncFab(onClick: () => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.id = FAB_ID;
  wrap.style.cssText = `
    position: fixed !important;
    right: 24px !important;
    bottom: 88px !important;
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 8px !important;
    z-index: 2147483646 !important;
  `;

  // —— 主按钮（同步发布）：圆形 focus ring，hover 展开成胶囊 + 显示「同步此页」——
  const primary = document.createElement('div');
  primary.setAttribute('role', 'button');
  primary.setAttribute('aria-label', t('同步文章到多平台', fabLang));
  primary.setAttribute('title', t('同步此页：提取正文并一键发布到多平台', fabLang));
  primary.style.cssText = `
    width: ${FAB_W_COLLAPSED}px !important;
    height: ${FAB_H}px !important;
    padding: 0 !important;
    border-radius: ${FAB_H / 2}px !important;
    background: #ffffff !important;
    border: 1px solid rgba(99, 102, 241, 0.18) !important;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08), 0 1px 3px rgba(15, 23, 42, 0.04) !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 0 !important;
    transition: width 0.28s cubic-bezier(0.4, 0, 0.2, 1), padding 0.28s cubic-bezier(0.4, 0, 0.2, 1), gap 0.28s, box-shadow 0.2s, transform 0.2s !important;
    user-select: none !important;
    color: #1f2937 !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif !important;
    overflow: hidden !important;
    white-space: nowrap !important;
    box-sizing: border-box !important;
  `;
  primary.innerHTML = `
    ${ICON_SYNC}
    <span class="omnipost-fab-label" style="
      max-width: 0;
      opacity: 0;
      overflow: hidden;
      white-space: nowrap;
      transition: max-width 0.28s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s;
      font-size: 13px;
    ">${t('同步此页', fabLang)}</span>`;
  primary.addEventListener('mouseenter', () => {
    primary.style.width = `${FAB_W_EXPANDED}px`;
    primary.style.padding = '0 14px';
    primary.style.gap = '6px';
    const label = primary.querySelector('.omnipost-fab-label') as HTMLElement | null;
    if (label) { label.style.maxWidth = '90px'; label.style.opacity = '1'; }
  });
  primary.addEventListener('mouseleave', () => {
    primary.style.width = `${FAB_W_COLLAPSED}px`;
    primary.style.padding = '0';
    primary.style.gap = '0';
    const label = primary.querySelector('.omnipost-fab-label') as HTMLElement | null;
    if (label) { label.style.maxWidth = '0'; label.style.opacity = '0'; }
  });
  primary.addEventListener('click', onClick);

  // —— 3 个工具按钮（默认收起，hover 主按钮时展开）——
  const actions: HTMLElement[] = [];
  const makeAction = (icon: string, title: string, handler: () => void) => {
    const a = makeButton(ACTION_SIZE, icon, title, handler);
    a.style.cssText += `
      opacity: 0 !important;
      transform: translateX(14px) scale(0.6) !important;
      pointer-events: none !important;
      transition: opacity 0.24s cubic-bezier(0.4,0,0.2,1), transform 0.24s cubic-bezier(0.4,0,0.2,1), background 0.2s, border-color 0.2s, box-shadow 0.2s !important;
    `;
    actions.push(a);
    return a;
  };

  const copyMdBtn = makeAction(ICON_COPY_MD, t('复制 Markdown', fabLang), () => {
    try {
      const article = extractArticle();
      if (!article) { flashAction(copyMdBtn, false); return; }
      copyText(article.markdown).then((ok) => flashAction(copyMdBtn, ok));
    } catch { flashAction(copyMdBtn, false); }
  });
  const copyTextBtn = makeAction(ICON_COPY_TEXT, t('复制纯文本', fabLang), () => {
    try {
      const article = extractArticle();
      if (!article) { flashAction(copyTextBtn, false); return; }
      copyText(markdownToPlainText(article.markdown)).then((ok) => flashAction(copyTextBtn, ok));
    } catch { flashAction(copyTextBtn, false); }
  });
  const downloadBtn = makeAction(ICON_DOWNLOAD, t('下载 Markdown', fabLang), () => {
    try {
      const article = extractArticle();
      if (!article) { flashAction(downloadBtn, false); return; }
      flashAction(downloadBtn, downloadMarkdown(article));
    } catch { flashAction(downloadBtn, false); }
  });

  // hover 主按钮时展开工具（监听 wrap 整体，避免移动鼠标到工具时立即收起）
  wrap.addEventListener('mouseenter', () => {
    actions.forEach((a, i) => {
      a.style.opacity = '1';
      a.style.transform = 'translateX(0) scale(1)';
      a.style.pointerEvents = 'auto';
      a.style.transitionDelay = `${i * 40}ms`;
    });
  });
  wrap.addEventListener('mouseleave', () => {
    actions.forEach((a) => {
      a.style.opacity = '0';
      a.style.transform = 'translateX(14px) scale(0.6)';
      a.style.pointerEvents = 'none';
      a.style.transitionDelay = '0ms';
    });
  });

  const style = document.createElement('style');
  style.textContent = PULSE_KEYFRAMES;
  document.head.appendChild(style);
  primary.style.animation = 'omnipost-fab-pulse 1.2s ease-in-out 3';

  // 顺序：工具在左，主按钮在右
  wrap.appendChild(copyMdBtn);
  wrap.appendChild(copyTextBtn);
  wrap.appendChild(downloadBtn);
  wrap.appendChild(primary);

  return wrap;
}

/** 工具按钮瞬时反馈：成功变绿 ✓，失败变红 ✗，1.2 秒后恢复 */
function flashAction(btn: HTMLElement, ok: boolean): void {
  const originalBg = '#ffffff';
  const originalBorder = 'rgba(99, 102, 241, 0.18)';
  const okBg = 'linear-gradient(135deg, #10b981, #059669)';
  const errBg = 'linear-gradient(135deg, #ef4444, #dc2626)';
  btn.style.background = ok ? okBg : errBg;
  btn.style.borderColor = 'transparent';
  btn.innerHTML = ok
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
  setTimeout(() => {
    if (!btn.isConnected) return;
    btn.style.background = originalBg;
    btn.style.borderColor = originalBorder;
    // 恢复原图标（根据 title 判断）
    const title = btn.getAttribute('title') || '';
    const icon = title === t('复制纯文本', fabLang) ? ICON_COPY_TEXT : title === t('下载 Markdown', fabLang) ? ICON_DOWNLOAD : ICON_COPY_MD;
    btn.innerHTML = icon;
  }, 1200);
}

/** 判断当前页面是否是"文章页"（有足够正文），避免在导航/列表页误显示 */
export function isArticlePage(): boolean {
  const url = location.href;
  // 微信公众号文章/编辑器页
  if (url.includes('mp.weixin.qq.com')) return true;

  // 有 <article> 标签且含正文
  const article = document.querySelector('article');
  if (article && (article.textContent?.trim().length ?? 0) > 200) return true;

  // 正文候选：取 <p> 段落文本总长度
  const paragraphs = document.querySelectorAll('p');
  let textLen = 0;
  paragraphs.forEach((p) => {
    textLen += p.textContent?.trim().length ?? 0;
  });
  return textLen > 400;
}

/** 注入悬浮工具栏 */
export async function injectFab(): Promise<void> {
  try { fabLang = await store.getLang(); } catch { fabLang = 'zh'; }
  if (document.getElementById(FAB_ID)) return;
  if (!isArticlePage()) return;

  const onClick = () => {
    let article: ExtractedArticle | null = null;
    let error: string | null = null;
    try {
      article = extractArticle();
    } catch (e: any) {
      error = e?.message || t('正文提取失败', fabLang);
    }
    markFabExtracted(article, error);
    chrome.runtime.sendMessage(
      { type: 'OPEN_PANEL_WITH_ARTICLE', payload: { article } },
      () => void chrome.runtime.lastError,
    );
  };

  const fab = createSyncFab(onClick);
  (document.body || document.documentElement).appendChild(fab);
}

/** 主按钮反馈：点击同步后变绿 ✓ / 红 ✗，3 秒后恢复 */
function markFabExtracted(article: ExtractedArticle | null, error: string | null): void {
  const wrap = document.getElementById(FAB_ID);
  if (!wrap) return;
  const primary = wrap.lastElementChild as HTMLElement | null;
  if (!primary) return;
  const ok = !!article;
  primary.innerHTML = ok
    ? `${ICON_OK}<span class="omnipost-fab-label" style="max-width:0;opacity:0;overflow:hidden;white-space:nowrap;font-size:13px;">${t('已提取', fabLang)}</span>`
    : `${ICON_ERR}<span class="omnipost-fab-label" style="max-width:0;opacity:0;overflow:hidden;white-space:nowrap;font-size:13px;">${t('未识别', fabLang)}</span>`;
  primary.setAttribute('title', ok
    ? t('已提取正文：请点扩展图标打开 Side Panel 自动填充', fabLang)
    : (error || t('当前页面未识别到文章正文', fabLang)));
  primary.style.background = ok
    ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
    : 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
  primary.style.borderColor = 'transparent';
  primary.style.width = '36px';
  primary.style.padding = '0';
  primary.style.animation = 'none';
  primary.style.pointerEvents = 'none';
  setTimeout(() => {
    const cur = document.getElementById(FAB_ID);
    if (!cur) return;
    const p = cur.lastElementChild as HTMLElement | null;
    if (!p) return;
    p.innerHTML = `${ICON_SYNC}<span class="omnipost-fab-label" style="max-width:0;opacity:0;overflow:hidden;white-space:nowrap;font-size:13px;">${t('同步此页', fabLang)}</span>`;
    p.setAttribute('title', t('同步此页：提取正文并一键发布到多平台', fabLang));
    p.style.background = '#ffffff';
    p.style.borderColor = 'rgba(99, 102, 241, 0.18)';
    p.style.animation = 'omnipost-fab-pulse 1.2s ease-in-out 3';
    p.style.pointerEvents = 'auto';
  }, 3000);
}
