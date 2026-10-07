import { waitForElement, waitForFileInput, uploadMediaToInput, setNativeValue, pasteIntoEditor, sleep } from './lib/inject';
import { humanizeFill } from './lib/humanize';
import { markdownToPlainText } from '../adapters/markdown-utils';

console.log('[OmniPost] Douyin Content Script Initialized');

interface DouyinFillPayload {
  title?: string;
  body?: string;
}

async function fillDouyinDraft(payload: DouyinFillPayload): Promise<void> {
  const { title, body } = payload;
  console.log('[OmniPost] Filling Douyin draft editor:', { title, bodyLength: body?.length });

  const errors: string[] = [];      // 致命错误（正文）
  const warnings: string[] = [];    // 非致命（标题缺失等，抖音允许无标题）

  // 1. 抖音标题：严格限制最多 20 字，剥离 Markdown 语法标记与外层括注
  const cleanTitle = title
    ? markdownToPlainText(title).replace(/^[【\[](.*?)[】\]]$/, '$1').trim().slice(0, 20)
    : '';

  if (cleanTitle) {
    try {
      const titleInput = (await waitForElement(
        [
          'input[placeholder*="作品标题"]',
          'input[placeholder*="添加作品标题"]',
          'input[placeholder*="标题"]',
          'input[maxlength="20"]',
          '.semi-input[placeholder*="标题"]',
          'input.semi-input',
          'div[data-placeholder*="标题"]',
        ],
        12000,
      )) as HTMLElement | null;

      if (titleInput) {
        let okTitle = false;
        if (titleInput instanceof HTMLInputElement || titleInput instanceof HTMLTextAreaElement) {
          okTitle = await humanizeFill(titleInput, cleanTitle, (el, t) => setNativeValue(el as HTMLInputElement, t));
        } else {
          okTitle = await humanizeFill(titleInput, cleanTitle, (el, t) => pasteIntoEditor(el, t, t));
        }
        if (!okTitle) errors.push('标题注入后内容校验未通过');
        else console.log('[OmniPost] Douyin title filled successfully:', cleanTitle);
      } else {
        errors.push('未找到抖音标题输入框');
      }
    } catch (e: any) {
      errors.push(`标题填写失败: ${e?.message || '未知错误'}`);
    }
  }

  // 2. 抖音作品描述：严格限制最多 1000 字，纯文本排版（Markdown 转纯文本，去除裸标记）
  const cleanBody = body ? markdownToPlainText(body).slice(0, 1000) : '';

  if (cleanBody) {
    try {
      const contentEditor = (await waitForElement(
        [
          'textarea[placeholder*="作品描述"]',
          'textarea[placeholder*="添加作品描述"]',
          'textarea[placeholder*="描述"]',
          'div[contenteditable="true"][placeholder*="描述"]',
          'div[contenteditable="true"]',
          '.zone-container',
          '.editor-kit-container',
          '[data-placeholder*="描述"]',
          '.semi-input-textarea',
        ],
        15000,
      )) as HTMLElement | null;

      if (contentEditor) {
        const okBody = await humanizeFill(contentEditor, cleanBody, (el, t) => {
          if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            setNativeValue(el, t);
          } else {
            pasteIntoEditor(el, t, t.replace(/\n/g, '<br/>'));
          }
        });
        if (!okBody) errors.push('正文注入后内容校验未通过');
        else console.log('[OmniPost] Douyin description filled successfully, length:', cleanBody.length);
      } else {
        errors.push('未找到抖音作品描述输入框');
      }
    } catch (e: any) {
      errors.push(`正文填写失败: ${e?.message || '未知错误'}`);
    }
  }

  await sleep(300);

  if (warnings.length > 0) console.warn('[OmniPost] Douyin fill warnings:', warnings.join('；'));
  // 诚实上报：正文是发布必需项，正文没填进去必须判失败，绝不静默假成功（标题缺失仅告警）
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }
}

// 响应后台或 Popup 主动下发的消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'DOUYIN_INJECT_MEDIA') {
    const { media } = message.payload;
    (async () => {
      const input = await waitForFileInput(
        ['input[type="file"]', 'input[accept*="image"]', '.upload-btn input', '.semi-upload-hidden-input'],
        20000,
      );
      const injected = await uploadMediaToInput(input, media);
      if (injected < 1) throw new Error('没有可注入的媒体文件');
      sendResponse({ ok: true, injected });
    })().catch((err) => {
      console.warn('[OmniPost] Douyin media inject failed:', err?.message);
      sendResponse({ ok: false, error: `抖音图片上传控件未就绪: ${err?.message || '未知错误'}` });
    });
    return true;
  }

  if (message.type === 'DOUYIN_INJECT_DRAFT') {
    fillDouyinDraft(message.payload)
      .then(() => sendResponse({ ok: true, draftId: 'douyin_' + Date.now() }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || '未知错误' }));
    return true;
  }
});

// 兜底机制：页面打开时检查 storage 是否有 5 分钟内的未填充草稿（支持直接打开或点击「打开草稿」）
(async () => {
  try {
    const result = await chrome.storage.local.get(['douyin_draft_pending', 'pending_article']);
    const pending = result.douyin_draft_pending || (result.pending_article ? {
      title: result.pending_article.title,
      body: result.pending_article.body,
      timestamp: Date.now(),
    } : null);

    if (pending && pending.timestamp && Date.now() - pending.timestamp < 300000) {
      // 抖音发布页加载稍有异步延时，等待 DOM 挂载就绪后自动注入
      setTimeout(() => {
        fillDouyinDraft({ title: pending.title, body: pending.body }).catch(() => {});
      }, 1500);
    }
  } catch {
    /* ignore storage error */
  }
})();
