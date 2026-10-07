/**
 * 极简 Markdown 渲染（Side Panel 预览用）。
 * 先 HTML 转义防 XSS，再逐行处理标题/列表/引用/代码块，行内处理加粗/斜体/行内代码/链接。
 * 纯函数、零依赖，可直接单元测试。
 */
export function renderMarkdown(src: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s: string) =>
    esc(s)
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/g, '<img src="$2" alt="$1" class="rounded-lg max-h-64 mx-auto my-2 border border-white/10" />')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*(.+?)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/`(.+?)`/g, '<code class="px-1 py-0.5 rounded bg-white/[0.08] text-[11px] font-mono">$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer" class="text-indigo-400 hover:underline">$1</a>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer" class="text-indigo-400 hover:underline">$2</a>');
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (inCode) {
        out.push(`<pre class="p-2.5 my-2 rounded-lg bg-[#090d15] border border-white/[0.08] overflow-x-auto text-[11px] font-mono leading-relaxed text-gray-200">${esc(codeBuf.join('\n'))}</pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    const line = raw.trim();
    if (!line) { out.push('<div class="h-2"></div>'); continue; }
    if (/^---{1,}$/.test(line) || /^\*\*\*{1,}$/.test(line)) {
      out.push('<hr class="my-3 border-white/10" />');
    } else if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const text = inline(line.replace(/^#+\s*/, ''));
      out.push(`<div class="${level <= 2 ? 'text-[14px] font-bold border-b border-white/[0.08] pb-1' : 'text-[12px] font-semibold'} text-white mt-2 mb-1">${text}</div>`);
    } else if (/^[-*]\s/.test(line)) {
      out.push(`<div class="flex gap-1.5 text-[12px] text-gray-300 leading-relaxed my-0.5"><span class="text-indigo-400">•</span><span class="flex-1">${inline(line.replace(/^[-*]\s*/, ''))}</span></div>`);
    } else if (/^\d+\.\s/.test(line)) {
      const num = line.match(/^(\d+)\./)![1];
      out.push(`<div class="flex gap-1.5 text-[12px] text-gray-300 leading-relaxed my-0.5"><span class="text-indigo-400 font-mono text-[11px]">${num}.</span><span class="flex-1">${inline(line.replace(/^\d+\.\s*/, ''))}</span></div>`);
    } else if (/^>\s?/.test(line)) {
      out.push(`<div class="pl-2.5 py-0.5 my-1 border-l-2 border-indigo-500/60 bg-indigo-500/5 rounded-r text-[12px] text-gray-400 italic">${inline(line.replace(/^>\s?/, ''))}</div>`);
    } else {
      out.push(`<div class="text-[12px] text-gray-300 leading-relaxed my-0.5">${inline(line)}</div>`);
    }
  }
  if (inCode && codeBuf.length) {
    out.push(`<pre class="p-2.5 my-2 rounded-lg bg-[#090d15] border border-white/[0.08] overflow-x-auto text-[11px] font-mono leading-relaxed text-gray-200">${esc(codeBuf.join('\n'))}</pre>`);
  }
  return out.join('');
}

/**
 * 将 Markdown 正文切分为段落块（尊重代码块围栏，不把代码块内部的空行切碎）。
 * 用于富文本混排中计算图片可放置的槽位（Slot）。
 */
export function splitMarkdownIntoBlocks(src: string): string[] {
  const normalized = src.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const lines = normalized.split('\n');
  const blocks: string[] = [];
  let currentBlock: string[] = [];
  let inCode = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      currentBlock.push(line);
      continue;
    }
    if (inCode) {
      currentBlock.push(line);
      continue;
    }
    if (!line.trim()) {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock.join('\n'));
        currentBlock = [];
      }
    } else {
      currentBlock.push(line);
    }
  }
  if (currentBlock.length > 0) {
    blocks.push(currentBlock.join('\n'));
  }
  return blocks.length > 0 ? blocks : [];
}
