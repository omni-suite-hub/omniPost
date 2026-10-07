import { waitForElement, waitForFileInput, uploadMediaToInput, findElementByText, setNativeValue, pasteIntoEditor, sleep, clickPublishAndConfirm } from './lib/inject';
import { humanizeFill } from './lib/humanize';
import { markdownToPlainText } from '../adapters/markdown-utils';

console.log('[OmniPost] Xiaohongshu Content Script Initialized');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'XHS_INJECT_MEDIA') {
    const { media } = message.payload;
    (async () => {
      // 小红书创作者后台：图片/视频上传的 file input
      const input = await waitForFileInput(
        ['input[type="file"]', '.upload-input input', 'input[accept*="image"]'],
        25000,
      );
      const injected = await uploadMediaToInput(input, media);
      if (injected < 1) throw new Error('没有可注入的媒体文件');
      sendResponse({ ok: true, injected });
    })().catch((err) => {
      console.warn('[OmniPost] Xiaohongshu media inject failed:', err?.message);
      sendResponse({ ok: false, error: `小红书图片上传控件未就绪: ${err?.message || '未知错误'}` });
    });
    return true;
  }

  if (message.type === 'XHS_INJECT_DRAFT') {
    const { title, body } = message.payload;
    console.log('[OmniPost] Injecting into Xiaohongshu note editor:', title, body);

    (async () => {
      // 小红书硬性规则：标题 <= 20 字，正文 <= 1000 字（setNativeValue 可绕过 maxlength，必须主动截断）
      const cleanTitle = title
        ? markdownToPlainText(title).replace(/^[【\[](.*?)[】\]]$/, '$1').trim().slice(0, 20)
        : '';
      const titleInput = (await waitForElement(
        ['input[placeholder*="标题"]', 'input[placeholder*="填写标题"]'],
        15000,
      )) as HTMLInputElement | null;
      if (titleInput && cleanTitle) {
        // G1 拟人化：逐字输入标题，失败回退原生 setter；注入失败必须报错（防无标题草稿）
        const okTitle = await humanizeFill(titleInput, cleanTitle, (el, t) => setNativeValue(el as HTMLInputElement, t));
        if (!okTitle) throw new Error('小红书标题注入失败（内容校验未通过）');
      }

      // 正文：contenteditable（小红书不支持 Markdown，清洗为排版自然的纯文本）
      const contentEditor = (await waitForElement(
        ['div[contenteditable="true"]', '.post-content', 'textarea'],
        15000,
      )) as HTMLElement | null;
      if (!contentEditor) {
        throw new Error('未找到小红书正文编辑器');
      }

      const cleanBody = markdownToPlainText(body || '').slice(0, 1000);
      // G1 拟人化：正文分段输入（长文本），失败回退 paste/setNativeValue；注入失败必须报错
      const okBody = await humanizeFill(contentEditor, cleanBody, (el, t) => {
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          setNativeValue(el, t);
        } else {
          pasteIntoEditor(el, t, t.replace(/\n/g, '<br/>'));
        }
      });
      if (!okBody) throw new Error('小红书正文注入失败（内容校验未通过）');
      await sleep(300);
      console.log('[OmniPost] Xiaohongshu note filled successfully');
      sendResponse({ ok: true, draftId: 'xhs_' + Date.now() });
    })().catch((err) => {
      console.warn('[OmniPost] Xiaohongshu inject failed:', err?.message);
      sendResponse({ ok: false, error: `小红书编辑器未就绪: ${err?.message || '未知错误'}` });
    });
    return true;
  }

  if (message.type === 'XHS_CONFIRM_PUBLISH') {
    (async () => {
      // 发布按钮：等待可点击（小红书按钮 aria-disabled 为 true 时不可点）
      const publishBtn = (await findElementByText('button', '发布', 12, 500)) as HTMLButtonElement | null;
      if (!publishBtn) {
        sendResponse({ ok: false, error: '未找到小红书发布按钮' });
        return;
      }
      let waited = 0;
      while (publishBtn.getAttribute('aria-disabled') === 'true' && waited < 30000) {
        await sleep(1000);
        waited += 1000;
      }
      if (publishBtn.getAttribute('aria-disabled') === 'true') {
        sendResponse({ ok: false, error: '小红书发布按钮 30s 内未就绪（可能缺少必要内容）' });
        return;
      }
      // 点击后自动处理二次确认（原创声明等弹窗），等待跳转/成功
      const r = await clickPublishAndConfirm(publishBtn, { timeoutMs: 20000 });
      if (r.ok) {
        sendResponse({ ok: true, url: r.url });
      } else {
        sendResponse({ ok: false, error: '小红书发布超时（页面已保留供你操作）' });
      }
    })().catch(() => sendResponse({ ok: false, error: '小红书发布按钮定位失败' }));
    return true;
  }
});
