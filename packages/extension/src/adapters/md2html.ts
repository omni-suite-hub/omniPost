/**
 * 极简 Markdown → 干净 HTML（Service Worker 环境，零依赖、无 DOM）。
 *
 * 用途：API 直连平台 adapter 需要把用户正文（markdown）转成平台可接受的 HTML。
 * 与 popup 预览用的 renderMarkdown（带 Tailwind 类、专为预览设计）不同，
 * 这里输出"干净"HTML：不夹带样式类、全量转义防注入、可直接发布。
 *
 * 支持：标题(#~######)、段落、粗体/斜体/删除线/行内代码、链接、图片
 * （保留 <img> 供图床上传管线提取）、围栏代码块、引用、无序/有序列表、
 * 表格（简化版）、分隔线。
 *
 * 约定：
 * - 图片输出 <img src="..." alt="..." />，让 processImages() 能统一提取上传；
 * - 代码块输出 <pre><code class="language-xx">，供知乎 transformContent 二次转换。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内样式：代码跨度先行占位，避免粗体/斜体规则误伤代码内容 */
function inline(s: string): string {
  const codeSpans: string[] = [];
  const esc = escapeHtml(s).replace(/`([^`\n]+)`/g, (_m, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  const rendered = esc
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, url) => {
      const cleanUrl = url.replace(/&amp;/g, '&');
      return `<img src="${cleanUrl}" alt="${alt}" />`;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, text, url) => {
      const cleanUrl = url.replace(/&amp;/g, '&');
      return `<a href="${cleanUrl}">${text}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 还原代码跨度
  return rendered.replace(/\u0000(\d+)\u0000/g, (_m, idx) => codeSpans[Number(idx)] || '');
}

function isTableSeparator(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length > 0 && cells.every((c) => /^\s*:?-{3,}:?\s*$/.test(c));
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function md2html(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  // 段落缓冲（连续非特殊行合并为一个 <p>，单换行用 <br/>）
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${para.map(inline).join('<br/>')}</p>`);
      para = [];
    }
  };

  // 列表缓冲（相邻同类列表项合并为一个列表）
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${list.items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
      list = null;
    }
  };

  const flushAll = () => {
    flushPara();
    flushList();
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (!line) {
      flushAll();
      i++;
      continue;
    }

    // 围栏代码块
    if (/^```/.test(line)) {
      flushAll();
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合 ```
      const attrs = lang ? ` class="language-${lang}"` : '';
      out.push(`<pre><code${attrs}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      out.push('<hr/>');
      i++;
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      flushAll();
      out.push(`<blockquote><p>${inline(line.replace(/^>\s?/, ''))}</p></blockquote>`);
      i++;
      continue;
    }

    // 表格（当前行以 | 开头且非分隔行）
    if (/^\|/.test(line) && !isTableSeparator(line)) {
      flushAll();
      const rows: string[][] = [parseTableRow(line)];
      let j = i + 1;
      let hasSeparator = false;
      if (j < lines.length && isTableSeparator(lines[j].trim())) {
        hasSeparator = true;
        j++;
      }
      while (j < lines.length && /^\|/.test(lines[j].trim()) && !isTableSeparator(lines[j].trim())) {
        rows.push(parseTableRow(lines[j].trim()));
        j++;
      }
      if (hasSeparator && rows.length >= 1) {
        const header = rows[0];
        const body = rows.slice(1);
        out.push(
          `<table><thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
            `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
        );
      } else {
        out.push(
          `<table><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
        );
      }
      i = j;
      continue;
    }

    // 列表项
    const li = line.match(/^([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const ordered = /\d+[.)]/.test(li[1]);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(li[2]);
      i++;
      continue;
    }

    // 普通段落行
    para.push(line);
    i++;
  }

  flushAll();
  return out.join('\n');
}
