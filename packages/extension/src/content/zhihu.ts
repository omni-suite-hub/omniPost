import { waitForElement, waitForFileInput, uploadMediaToInput, findElementByText, setNativeValue, pasteIntoEditor, plainTextToHtml, sleep, clickPublishAndConfirm } from './lib/inject';
import { md2html } from '../adapters/md2html';

console.log('[OmniPost] Zhihu Content Script Initialized');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ZHIHU_INJECT_MEDIA') {
    const { media } = message.payload;
    (async () => {
      // 知乎文章编辑器：图片上传的 file input
      const input = await waitForFileInput(
        ['input[type="file"]', '.ImageUpload input', 'input[accept*="image"]'],
        20000,
      );
      const injected = await uploadMediaToInput(input, media);
      if (injected < 1) throw new Error('没有可注入的媒体文件');
      sendResponse({ ok: true, injected });
    })().catch((err) => {
      console.warn('[OmniPost] Zhihu media inject failed:', err?.message);
      sendResponse({ ok: false, error: `知乎图片上传控件未就绪: ${err?.message || '未知错误'}` });
    });
    return true;
  }

  if (message.type === 'ZHIHU_INJECT_DRAFT') {
    const { title, body } = message.payload;
    console.log('[OmniPost] Injecting into Zhihu editor:', title, body);

    (async () => {
      // 标题：知乎写作标题 textarea（去除可能误留的 Markdown 井号）
      const cleanTitle = (title || '').replace(/^#+\s*/, '').trim();
      const titleInput = (await waitForElement(
        ['textarea[placeholder*="标题"]', 'input[placeholder*="标题"]', 'textarea.WriteIndex-titleInput'],
        15000,
      )) as HTMLInputElement | HTMLTextAreaElement | null;
      if (titleInput && cleanTitle) {
        setNativeValue(titleInput, cleanTitle);
      }

      // 正文：知乎文章编辑器为内容块（Draft.js/data-contents=true），用 md2html 渲染真实富文本 HTML（plainTextToHtml 兜底）
      const editor = (await waitForElement(
        ['div[data-contents="true"]', '.public-DraftEditor-content', '.DraftEditor-editorContainer', '[contenteditable="true"]'],
        15000,
      )) as HTMLElement | null;
      if (!editor) {
        throw new Error('未找到知乎正文编辑器');
      }

      const htmlContent = md2html(body || '') || plainTextToHtml(body || '');
      pasteIntoEditor(editor, body, htmlContent);
      await sleep(300);
      console.log('[OmniPost] Zhihu article filled successfully');
      sendResponse({ ok: true, draftId: 'zh_' + Date.now() });
    })().catch((err) => {
      console.warn('[OmniPost] Zhihu inject failed:', err?.message);
      sendResponse({ ok: false, error: `知乎编辑器未就绪: ${err?.message || '未知错误'}` });
    });
    return true;
  }

  if (message.type === 'ZHIHU_CONFIRM_PUBLISH') {
    (async () => {
      // 知乎发布面板触发按钮
      const pubBtn = (await findElementByText('button', '发布', 12, 500)) as HTMLElement | null;
      if (!pubBtn) {
        sendResponse({ ok: false, error: '未找到知乎发布按钮' });
        return;
      }
      // 点击后自动处理二次确认弹窗（发布设置面板），并等待跳转至文章页
      const r = await clickPublishAndConfirm(pubBtn, { timeoutMs: 20000 });
      if (r.ok) {
        sendResponse({ ok: true, url: r.url });
      } else {
        sendResponse({ ok: false, error: '知乎发布超时（可能弹出了需人工处理的确认项），页面已保留供你操作' });
      }
    })().catch(() => sendResponse({ ok: false, error: '知乎发布按钮定位失败' }));
    return true;
  }
});
