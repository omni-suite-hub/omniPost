/**
 * OmniPost 内容注入工具库（Content Script 侧共享）
 *
 * 注入技术参考 MultiPost-Extension（https://github.com/leaperone/MultiPost-Extension，
 * Apache-2.0）与文章同步助手（https://github.com/wechatsync/Wechatsync）的成熟做法：
 *  - 编辑器就绪等待：MutationObserver 轮询代替固定 sleep
 *  - textarea/input：原生 value setter + input/change 事件（兼容 React 受控组件）
 *  - contenteditable（ProseMirror/Draft.js/Slate）：聚焦后派发 ClipboardEvent paste
 *  - 文件上传：DataTransfer 写入 <input type="file"> 后派发 change 事件
 */
import { humanClick, humanScrollTo } from './humanize';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等待第一个命中的选择器出现（支持多候选，按顺序尝试）。超时抛错。 */
export function waitForElement(selector: string | string[], timeout = 15000): Promise<Element> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const list = Array.isArray(selector) ? selector : [selector];
      for (const sel of list) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    };

    const found = check();
    if (found) {
      resolve(found);
      return;
    }

    const observer = new MutationObserver(() => {
      const el = check();
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`元素 ${JSON.stringify(selector)} 在 ${timeout}ms 内未出现`));
    }, timeout);
  });
}

/** 等待指定数量的元素出现。 */
export function waitForElements(selector: string, count: number, timeout = 30000): Promise<Element[]> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const checkElements = () => {
      const elements = document.querySelectorAll(selector);
      if (elements.length >= count) {
        resolve(Array.from(elements));
        return;
      }
      if (Date.now() - startTime > timeout) {
        reject(new Error(`未能在 ${timeout}ms 内找到 ${count} 个 "${selector}" 元素`));
        return;
      }
      setTimeout(checkElements, 200);
    };
    checkElements();
  });
}

/** 在候选元素中按可见文本查找目标（如"发送/发布"按钮）。 */
export async function findElementByText(
  selector: string,
  text: string,
  maxRetries = 8,
  retryInterval = 500,
): Promise<Element | null> {
  for (let i = 0; i < maxRetries; i++) {
    const elements = document.querySelectorAll(selector);
    const el = Array.from(elements).find((e) => e.textContent?.includes(text));
    if (el) return el;
    await sleep(retryInterval);
  }
  return null;
}

/** 通过原生 setter 给 input/textarea 赋值并派发 input/change（兼容 React 受控组件）。 */
export function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLInputElement
      ? window.HTMLInputElement.prototype
      : window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 聚焦并派发 input 事件，确保框架感知（针对不可控元素）。 */
export function pokeInput(el: Element): void {
  (el as HTMLElement).focus();
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 向 contenteditable 编辑器注入内容（ProseMirror/Draft.js/Slate 均响应 paste 事件）。
 * 优先 text/html，无则回退 text/plain。
 */
export function pasteIntoEditor(
  editor: Element,
  text: string,
  html?: string,
): void {
  (editor as HTMLElement).focus();
  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: new DataTransfer(),
  });
  if (html) {
    pasteEvent.clipboardData!.setData('text/html', html);
  }
  pasteEvent.clipboardData!.setData('text/plain', text);
  editor.dispatchEvent(pasteEvent);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 等待第一个可见的 <input type="file"> 出现（多候选按顺序尝试）。
 * 平台图片按钮点击后才会挂载 file input，因此用 MutationObserver 轮询等待。
 * "可见"判定用 getClientRects（display:none 的隐藏 input 不计入，但被 label 托管的
 * 隐藏 input 仍可注入，故提供 fallbackInputs 二次兜底）。
 */
export function waitForFileInput(
  selectors: string | string[],
  timeout = 20000,
  preferVisible = true,
): Promise<HTMLInputElement> {
  return new Promise((resolve, reject) => {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const isVisible = (el: Element) => {
      const rects = (el as HTMLElement).getClientRects();
      return rects.length > 0;
    };
    const check = (): HTMLInputElement | null => {
      for (const sel of list) {
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(sel));
        if (inputs.length === 0) continue;
        if (preferVisible) {
          const visible = inputs.find(isVisible);
          if (visible) return visible;
        }
        return inputs[0]; // 兜底：隐藏的 file input 也可直接写 files（React 受控组件响应 change）
      }
      return null;
    };

    const found = check();
    if (found) {
      resolve(found);
      return;
    }

    const observer = new MutationObserver(() => {
      const el = check();
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`文件上传控件（${JSON.stringify(list)}）在 ${timeout}ms 内未出现`));
    }, timeout);
  });
}

/**
 * 将媒体（dataUrl）写入 <input type="file"> 并触发 change。
 * mediaList 元素: { name, type, dataUrl }。返回写入数量。
 */
export async function uploadMediaToInput(
  input: HTMLInputElement,
  mediaList: { name: string; type: string; dataUrl?: string }[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const dataTransfer = new DataTransfer();
  let added = 0;
  for (const item of mediaList) {
    try {
      let blob: Blob;
      if (item.dataUrl) {
        const res = await fetch(item.dataUrl);
        blob = await res.blob();
      } else {
        blob = new Blob([''], { type: item.type || 'application/octet-stream' });
      }
      dataTransfer.items.add(new File([blob], item.name || 'file', { type: blob.type || item.type }));
      added++;
      onProgress?.(added, mediaList.length);
    } catch (e) {
      console.warn('[OmniPost] 媒体读取失败，已跳过:', item.name, e);
    }
  }
  if (added > 0) {
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return added;
}

/** 把纯文本/换行转换为知乎等富文本编辑器可粘贴的 HTML 段落（先转义 HTML 特殊字符，防正文被当作 HTML 渲染）。 */
export function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

/**
 * 点击发布按钮后自动完成"二次确认 + 等待发布结果"（对标真实用户操作，供静默发布链路使用）：
 * 1) 点击初始发布按钮
 * 2) 轮询等待：URL 跳转 / 自定义成功判定（编辑框清空、发帖按钮消失等）任一成立 = 发布成功
 * 3) 期间若弹出确认弹窗（dialog/modal 容器），自动点击其中"发布/确认/确定"按钮
 * 4) 超时返回 { ok:false }，页面保持现状，供人工接管
 */
export async function clickPublishAndConfirm(
  initialBtn: HTMLElement,
  opts?: {
    timeoutMs?: number;
    extraBufferMs?: number;
    successCheck?: () => boolean; // 自定义成功判定（默认仅 URL 跳转）
  },
): Promise<{ ok: boolean; url: string }> {
  const timeoutMs = opts?.timeoutMs ?? 15000;
  const extraBufferMs = opts?.extraBufferMs ?? 1200;
  const startUrl = location.href;
  const successCheck = opts?.successCheck;

  // G1 拟人化点击：mouseover→mousedown→mouseup→click，失败回退原生 click
  await humanScrollTo(initialBtn);
  const clicked = await humanClick(initialBtn);
  if (!clicked) initialBtn.click();
  await sleep(extraBufferMs);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const urlChanged = location.href !== startUrl;
    const customOk = successCheck ? successCheck() : false;
    if (urlChanged || customOk) {
      return { ok: true, url: location.href };
    }
    // 仅在弹窗/浮层容器内寻找二次确认按钮，避免误点页面其他元素
    const containers = document.querySelectorAll(
      '[role="dialog"], .modal, .ant-modal, [class*="Modal"], [class*="modal"], .woo-dialog, [class*="dialog" i]',
    );
    for (const c of containers) {
      const btns = c.querySelectorAll<HTMLElement>('button, [role="button"]');
      const confirm = Array.from(btns).find(
        (b) => b !== initialBtn && /发布|确认|确定|完成|Submit|Publish|Confirm|Done/i.test(b.textContent || ''),
      );
      if (confirm) {
        const c2 = await humanClick(confirm);
        if (!c2) confirm.click();
        break;
      }
    }
    await sleep(500);
  }
  return { ok: false, url: location.href };
}
