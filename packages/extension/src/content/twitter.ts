import { waitForElement, waitForFileInput, uploadMediaToInput, sleep, clickPublishAndConfirm } from './lib/inject';
import { markdownToPlainText } from '../adapters/markdown-utils';

/**
 * X/Twitter 280 字限制（官方加权计数：CJK 全角字符按 2 计，其余按 1）。
 * 超长时在标点/空白边界截断并补省略号，避免硬切句子。
 */
const X_MAX_WEIGHTED = 280;

function xWeightedLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    n += /[⺀-鿿豈-﫿︰-﹏＀-￠　-〿]/.test(ch) ? 2 : 1;
  }
  return n;
}

export function truncateForX(s: string, max = X_MAX_WEIGHTED): string {
  if (xWeightedLength(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = /[⺀-鿿豈-﫿︰-﹏＀-￠　-〿]/.test(ch) ? 2 : 1;
    if (w + cw > max - 1) break; // 预留 1 给省略号
    out += ch;
    w += cw;
  }
  // 回退到最近的句子/语义边界（句号、换行、空格等），最多回退 40 字符
  const boundary = Math.max(
    out.lastIndexOf('。'), out.lastIndexOf('！'), out.lastIndexOf('？'),
    out.lastIndexOf('\n'), out.lastIndexOf('. '), out.lastIndexOf('，'), out.lastIndexOf(' '),
  );
  if (boundary > 0 && out.length - boundary <= 40) out = out.slice(0, boundary + 1);
  return out.trimEnd() + '…';
}

console.log('[OmniPost] X/Twitter Content Script Initialized');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TWITTER_INJECT_MEDIA') {
    const { media } = message.payload;
    (async () => {
      // X 发帖框：媒体按钮对应的 file input（data-testid 是稳定锚点）
      const input = await waitForFileInput(
        ['input[data-testid="fileInput"]', 'input[type="file"]'],
        20000,
      );
      const injected = await uploadMediaToInput(input, media);
      if (injected < 1) throw new Error('没有可注入的媒体文件');
      sendResponse({ ok: true, injected });
    })().catch((err) => {
      console.warn('[OmniPost] X media inject failed:', err?.message);
      sendResponse({ ok: false, error: `X 图片上传控件未就绪: ${err?.message || '未知错误'}` });
    });
    return true;
  }

  if (message.type === 'TWITTER_INJECT_DRAFT') {
    const { title, body } = message.payload;
    console.log('[OmniPost] Injecting into X composer:', title, body);

    (async () => {
      // X 发帖框：内容块 data-contents=true（React 编辑器），用 paste 注入
      const editor = (await waitForElement(
        'div[data-contents="true"]',
        20000,
      )) as HTMLElement | null;
      if (!editor) {
        throw new Error('未找到 X 发帖编辑器');
      }

      // X/Twitter 不支持 Markdown，转换为排版自然的纯文本
      const cleanBody = markdownToPlainText(body || '');
      const cleanTitle = title ? markdownToPlainText(title).replace(/^[【\[](.*?)[】\]]$/, '$1').trim() : '';
      const fullText = cleanTitle ? `【${cleanTitle}】\n${cleanBody}` : cleanBody;
      editor.focus();
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      });
      pasteEvent.clipboardData!.setData('text/plain', fullText);
      editor.dispatchEvent(pasteEvent);
      await sleep(500);
      console.log('[OmniPost] X composer filled successfully');
      sendResponse({ ok: true, draftId: 'tw_' + Date.now() });
    })().catch((err) => {
      console.warn('[OmniPost] X inject failed:', err?.message);
      sendResponse({ ok: false, error: `X 编辑器未就绪: ${err?.message || '未知错误'}` });
    });
    return true;
  }

  if (message.type === 'TWITTER_CONFIRM_PUBLISH') {
    (async () => {
      // X 发布按钮：aria-label 同时兼容中英文界面（发帖/Post）
      const postBtn = (await waitForElement(
        ['button[data-testid="tweetButton"]', 'button[aria-label*="发帖"]', 'button[aria-label*="Post"]'],
        10000,
      )) as HTMLElement | null;
      if (!postBtn) {
        sendResponse({ ok: false, error: '未找到 X 发布按钮' });
        return;
      }
      // X 发布成功后发帖框关闭（发帖按钮消失），URL 可能不变，以此判定结果
      const r = await clickPublishAndConfirm(postBtn, {
        timeoutMs: 15000,
        successCheck: () => !document.querySelector('[data-testid="tweetButton"]'),
      });
      if (r.ok) {
        sendResponse({ ok: true, url: r.url });
      } else {
        sendResponse({ ok: false, error: 'X 发布超时（页面已保留供你操作）' });
      }
    })().catch(() => sendResponse({ ok: false, error: 'X 发布按钮定位失败' }));
    return true;
  }
});
