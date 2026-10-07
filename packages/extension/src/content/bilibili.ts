import { waitForElement, waitForFileInput, uploadMediaToInput, findElementByText, setNativeValue, pasteIntoEditor, sleep, clickPublishAndConfirm } from './lib/inject';
import { humanizeFill } from './lib/humanize';
import { markdownToPlainText } from '../adapters/markdown-utils';

console.log('[OmniPost] Bilibili Content Script Initialized');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'BILI_INJECT_MEDIA') {
    const { media } = message.payload;
    (async () => {
      // B站动态发布框：图片上传的 file input
      const input = await waitForFileInput(
        ['input[type="file"]', '.dynamic-upload input', 'input[accept*="image"]'],
        20000,
      );
      const injected = await uploadMediaToInput(input, media);
      if (injected < 1) throw new Error('没有可注入的媒体文件');
      sendResponse({ ok: true, injected });
    })().catch((err) => {
      console.warn('[OmniPost] Bilibili media inject failed:', err?.message);
      sendResponse({ ok: false, error: `B站图片上传控件未就绪: ${err?.message || '未知错误'}` });
    });
    return true;
  }

  if (message.type === 'BILI_INJECT_DRAFT') {
    const { title, body } = message.payload;
    console.log('[OmniPost] Injecting into Bilibili composer:', title, body);

    (async () => {
      // 动态发布框：contenteditable + placeholder 是稳定锚点
      const editor = (await waitForElement(
        ['div[placeholder="有什么想和大家分享的？"][contenteditable="true"]', '.dynamic-edit-box', 'textarea'],
        15000,
      )) as HTMLElement | null;
      if (!editor) {
        throw new Error('未找到B站动态编辑器');
      }

      // B站动态不支持 Markdown，转换为排版自然的纯文本
      const cleanBody = markdownToPlainText(body || '');
      const cleanTitle = title ? markdownToPlainText(title).replace(/^[【\[](.*?)[】\]]$/, '$1').trim() : '';
      const fullContent = cleanTitle ? `【${cleanTitle}】\n${cleanBody}` : cleanBody;
      // G1 拟人化：分段输入，失败回退 paste/setNativeValue；注入失败必须报错（防空草稿假成功）
      const okBody = await humanizeFill(editor, fullContent, (el, t) => {
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          setNativeValue(el, t);
        } else {
          pasteIntoEditor(el, t);
        }
      });
      if (!okBody) throw new Error('B站动态正文注入失败（内容校验未通过）');
      await sleep(300);
      console.log('[OmniPost] Bilibili editor filled successfully');
      sendResponse({ ok: true, draftId: 'bili_' + Date.now() });
    })().catch((err) => {
      console.warn('[OmniPost] Bilibili inject failed:', err?.message);
      sendResponse({ ok: false, error: `B站编辑器未就绪: ${err?.message || '未知错误'}` });
    });
    return true;
  }

  if (message.type === 'BILI_CONFIRM_PUBLISH') {
    (async () => {
      const pubBtn = (await findElementByText('button', '发布', 10, 500)) as HTMLElement | null;
      if (!pubBtn) {
        sendResponse({ ok: false, error: '未找到B站发布按钮' });
        return;
      }
      // B站发布成功后页面跳转至动态详情，URL 变化即成功
      const r = await clickPublishAndConfirm(pubBtn, { timeoutMs: 15000 });
      if (r.ok) {
        sendResponse({ ok: true, url: r.url });
      } else {
        sendResponse({ ok: false, error: 'B站发布超时（页面已保留供你操作）' });
      }
    })().catch(() => sendResponse({ ok: false, error: 'B站发布按钮定位失败' }));
    return true;
  }
});
