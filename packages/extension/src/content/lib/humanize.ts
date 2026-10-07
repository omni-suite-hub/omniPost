/**
 * G1 拟人化输入层：真实事件级操作 + 随机节奏，去除"机器人瞬间填充"的风控特征。
 *
 * 设计原则（docs/G1G4.md）：
 * - 不引入 chrome.debugger（避免黄色调试警告条 + attach 限制），
 *   用 content script 的 InputEvent/MouseEvent 达到等价拟人化效果。
 * - 所有函数都是"增强"而非"替代"：失败时调用方回退到 setNativeValue/pasteIntoEditor。
 * - 速度与真实性的权衡：标题逐字输入，正文分段输入（避免长文本逐字导致耗时爆炸）。
 */

/** 随机延迟 [min, max]ms，避免固定节奏 */
export async function humanDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(min + Math.random() * (max - min));
  await new Promise((r) => setTimeout(r, ms));
}

/** 平滑滚动到元素可视区中心 */
export async function humanScrollTo(el: Element): Promise<void> {
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch {
    el.scrollIntoView();
  }
  await humanDelay(150, 300);
}

/** 拟人化点击：mouseover → mousedown → mouseup → click 完整序列（带随机间隔） */
export async function humanClick(el: HTMLElement): Promise<boolean> {
  try {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent('mouseover', base));
    await humanDelay(30, 80);
    el.dispatchEvent(new MouseEvent('mousedown', base));
    await humanDelay(50, 120);
    el.dispatchEvent(new MouseEvent('mouseup', base));
    await humanDelay(20, 60);
    el.dispatchEvent(new MouseEvent('click', base));
    return true;
  } catch {
    return false;
  }
}

/**
 * 拟人化输入：逐字/分段输入，触发真实 InputEvent。
 * - input/textarea：逐段设置 value（原生 setter）+ input 事件，React 受控组件可识别
 * - contenteditable：execCommand('insertText') 分段插入 + input 事件
 * opts.chunkSize 控制"逐字(=1)"还是"分段(=N)"，正文建议 8~24，标题建议 1。
 */
export async function humanType(
  el: HTMLElement,
  text: string,
  opts?: { chunkSize?: number; gapMs?: [number, number] },
): Promise<boolean> {
  if (!text) return true;
  const chunkSize = opts?.chunkSize ?? 1;
  const [gMin, gMax] = opts?.gapMs ?? [30, 80];
  try {
    el.focus?.();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return await typeIntoInput(el, text, chunkSize, gMin, gMax);
    }
    return await typeIntoContentEditable(el, text, chunkSize, gMin, gMax);
  } catch {
    return false;
  }
}

async function typeIntoInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  chunkSize: number,
  gMin: number,
  gMax: number,
): Promise<boolean> {
  const proto = el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const start = el.selectionStart ?? el.value.length;
  let pos = 0;
  while (pos < text.length) {
    const chunk = text.slice(pos, pos + chunkSize);
    // 在光标处累积插入（含已输入部分 + 原有后缀），不能只写当前 chunk，否则循环结束只剩最后一个字
    const insertAt = start + pos;
    const next = el.value.slice(0, insertAt) + chunk + el.value.slice(insertAt);
    if (setter) setter.call(el, next);
    else el.value = next;
    const end = start + pos + chunk.length;
    try { el.setSelectionRange?.(end, end); } catch { /* ignore */ }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: chunk }));
    pos += chunkSize;
    await humanDelay(gMin, gMax);
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

async function typeIntoContentEditable(
  el: HTMLElement,
  text: string,
  chunkSize: number,
  gMin: number,
  gMax: number,
): Promise<boolean> {
  let pos = 0;
  while (pos < text.length) {
    const chunk = text.slice(pos, pos + chunkSize);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, chunk);
    } catch { inserted = false; }
    if (!inserted) {
      // execCommand 失败（无焦点/被禁用）→ 返回 false，让 humanizeFill 回退 pasteIntoEditor。
      // 绝不能 fallback 到 textContent 追加：那样 hasText 会误判成功，但框架（ProseMirror/Slate）未同步。
      return false;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: chunk }));
    pos += chunkSize;
    await humanDelay(gMin, gMax);
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * 分段拟人化输入正文（长文本）：按段落或固定长度切块，块间随机停顿，
 * 兼顾"拟人化"与"不拖慢发布"。是 humanType 的长文本便捷封装。
 */
export async function humanTypeLong(
  el: HTMLElement,
  text: string,
  opts?: { segmentSize?: number; gapMs?: [number, number] },
): Promise<boolean> {
  const segmentSize = opts?.segmentSize ?? 16;
  return humanType(el, text, { chunkSize: segmentSize, gapMs: opts?.gapMs ?? [40, 120] });
}

/** 校验元素是否已包含预期文本（前 20 字），用于判断注入是否成功 */
export function hasText(el: HTMLElement, expected: string): boolean {
  const needle = expected.slice(0, 20).trim();
  if (!needle) return true;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return (el.value ?? '').includes(needle);
  }
  return (el.textContent ?? '').includes(needle) || (el.innerText ?? '').includes(needle);
}

/**
 * 拟人化填充 + 注入校验 + 降级回退：
 * 先 humanType 输入，校验内容是否真的进入；失败则调用 fallback 兜底。
 * 保证拟人化是"增强"而非"新增失败点"。
 */
export async function humanizeFill(
  el: HTMLElement,
  text: string,
  fallback: (el: HTMLElement, text: string) => void,
): Promise<boolean> {
  if (!text) return true;
  const chunkSize = text.length > 60 ? 16 : 1;
  const typed = await humanType(el, text, { chunkSize, gapMs: chunkSize === 1 ? [20, 55] : [40, 120] });
  if (typed && hasText(el, text)) return true;
  fallback(el, text);
  return hasText(el, text);
}
