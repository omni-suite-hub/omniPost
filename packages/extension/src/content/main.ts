/**
 * 正文提取 content script 统一入口。
 *
 * 职责：注册 EXTRACT_ARTICLE 消息监听（供 background / popup / MCP 提取正文）
 * 并注入悬浮"同步"按钮（fab，点击提取 + 拉起 Side Panel）。
 * 单一入口避免 extractor / fab 各自打包时消息监听重复注册。
 *
 * fab 注入前读取 store.getUiSettings() 决定是否隐藏（用户可在设置面板关闭悬浮按钮）。
 */
import { extractArticle } from './extractor';
import { injectFab } from './fab';
import { store } from '../store';
import { t, Lang } from '../lib/i18n';

let mainLang: Lang = 'zh';

// 响应 background 的 EXTRACT_ARTICLE 消息
chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message?.type !== 'EXTRACT_ARTICLE') return false;
  try {
    const article = extractArticle();
    if (article) {
      sendResponse({ ok: true, article });
    } else {
      sendResponse({ ok: false, error: t('当前页面未识别到文章正文', mainLang) });
    }
  } catch (e: any) {
    sendResponse({ ok: false, error: e?.message || t('正文提取失败', mainLang) });
  }
  return false;
});

// 注入悬浮同步按钮：先读 UI 设置，若用户隐藏则不注入
function tryInjectFab() {
  // 页面正文可能异步渲染，延迟 500ms 再判一次（fab 内部还会判 isArticlePage）
  setTimeout(async () => {
    try {
      const [ui, lang] = await Promise.all([store.getUiSettings(), store.getLang()]);
      mainLang = lang;
      if (ui.hideFab) return;
    } catch {
      // store 读取失败：默认注入（避免 UI 设置异常导致功能不可用）
    }
    injectFab();
  }, 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', tryInjectFab);
} else {
  tryInjectFab();
}
