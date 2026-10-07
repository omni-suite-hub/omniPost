// 注意：早期版本通过 inline script 暴露 window.syncPost 给外部网页集成。
// 已在 2026-08 移除 inline 注入——在有 CSP 的页面（微博/知乎/掘金/头条等）触发刷屏错误，
// 且 syncPost 集成场景使用率极低。后续若需可用 chrome.scripting.registerContentScripts 外链 JS 替代。
// 保留 store import 以便后续扩展。
import { store } from '../store';

// 把 token 暴露给页面脚本（content script 世界与页面世界隔离，需通过 DOM 属性传递）
// 注意：早期版本会向 <head> 注入 inline script 暴露 window.syncPost 给外部网页集成。
// 但 inline script 在有 CSP 的页面（微博/知乎/掘金/头条等）会触发 CSP 错误刷屏，
// 且引入 syncPost 的页面集成场景使用率极低，**已移除 inline 注入**。
// 后续若需 syncPost 外部网页集成，建议用 chrome.scripting.registerContentScripts
// 动态注册 MAIN world 外链 JS（不受 inline 限制），或要求 host CSP 包含扩展 ID。
try {
  store.getBridgeToken().then((token) => {
    if (token) {
      // 安全加固：仅在本地开发/管理页面（localhost / 127.0.0.1）或测试环境中向 DOM 暴露 token，
      // 防止任意第三方恶意网页通过 document.documentElement 读取 token 并越权控制本地 Bridge 服务
      const host = typeof window !== 'undefined' ? window.location?.hostname : '';
      const isSafeOrigin = !host || host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
      if (isSafeOrigin) {
        document.documentElement.setAttribute('data-omnipost-token', token);
      }
    }
  });
} catch (e) {
  console.debug('[OmniPost] Bridge token injection skipped', e);
}
