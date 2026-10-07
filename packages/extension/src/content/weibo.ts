import { waitForElement, waitForFileInput, uploadMediaToInput, findElementByText, setNativeValue, sleep, clickPublishAndConfirm } from './lib/inject';
import { markdownToPlainText } from '../adapters/markdown-utils';

console.log('[OmniPost] Weibo Content Script Initialized');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'WEIBO_INJECT_MEDIA') {
    const { media } = message.payload;
    (async () => {
      // 微博发博工具条：点开图片按钮后挂载 file input
      const input = await waitForFileInput('input[type="file"]', 20000);
      const injected = await uploadMediaToInput(input, media);
      if (injected < 1) throw new Error('没有可注入的媒体文件');
      sendResponse({ ok: true, injected });
    })().catch((err) => {
      console.warn('[OmniPost] Weibo media inject failed:', err?.message);
      sendResponse({ ok: false, error: `微博图片上传控件未就绪: ${err?.message || '未知错误'}` });
    });
    return true;
  }

  if (message.type === 'WEIBO_INJECT_DRAFT') {
    const { title, body } = message.payload;
    console.log('[OmniPost] Injecting into Weibo composer:', title, body);

    (async () => {
      // 微博发布框（桌面版首页顶部，占位文案为验证过的稳定锚点）
      const textarea = (await waitForElement(
        'textarea[placeholder="有什么新鲜事想分享给大家？"]',
      )) as HTMLTextAreaElement;

      // 微博不支持 Markdown，转换为排版自然的纯文本
      const cleanBody = markdownToPlainText(body || '');
      const cleanTitle = title ? markdownToPlainText(title).replace(/^[【\[](.*?)[】\]]$/, '$1').trim() : '';
      const fullContent = cleanTitle ? `【${cleanTitle}】\n${cleanBody}` : cleanBody;
      setNativeValue(textarea, fullContent);
      await sleep(300);
      console.log('[OmniPost] Weibo textarea filled successfully');
      sendResponse({ ok: true, draftId: 'wb_' + Date.now() });
    })().catch((err) => {
      console.warn('[OmniPost] Weibo inject failed:', err?.message);
      sendResponse({ ok: false, error: `微博编辑器未就绪: ${err?.message || '未知错误'}` });
    });
    return true; // async response
  }

  if (message.type === 'WEIBO_CONFIRM_PUBLISH') {
    console.log('[OmniPost] Triggering Weibo publish button');
    (async () => {
      // 优先按按钮文案"发送"定位（微博 woo 按钮体系），再回退旧选择器
      const sendBtn = (await findElementByText('span.woo-button-content', '发送', 10, 500)) ||
        (await waitForElement(
          ['button[title*="发布"]', '.Tool_btn_2q6kF', '[node-type="submit"]'],
          8000,
        ));
      if (sendBtn) {
        // 微博发布成功后编辑框内容被清空（URL 不变），以此判定发布结果
        const r = await clickPublishAndConfirm(sendBtn as HTMLElement, {
          timeoutMs: 15000,
          successCheck: () => {
            const ta = document.querySelector(
              'textarea[placeholder="有什么新鲜事想分享给大家？"]',
            ) as HTMLTextAreaElement | null;
            return !!ta && ta.value.trim().length === 0;
          },
        });
        if (r.ok) {
          sendResponse({ ok: true, url: r.url || 'https://weibo.com' });
        } else {
          sendResponse({ ok: false, error: '微博发布超时（页面已保留供你操作）' });
        }
      } else {
        sendResponse({ ok: false, error: '未找到微博发送按钮' });
      }
    })().catch(() => sendResponse({ ok: false, error: '微博发送按钮定位失败' }));
    return true;
  }
});
