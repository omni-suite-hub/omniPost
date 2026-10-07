/**
 * 零依赖 HTML → Markdown（content script 环境，可在 node 单测运行，无 DOM）。
 *
 * 与 md2html.ts（Markdown→HTML）对称。输入是 Readability 输出的"干净"HTML
 * （浏览器 innerHTML 序列化结果，标签良构、无 script/style），输出 Markdown。
 *
 * 覆盖：h1~h6、p、br、strong/b、em/i、del/s、行内 code、pre>code 围栏、
 * a 链接、img 图片、ul/ol/li 列表（含嵌套）、blockquote 引用、hr 分隔线、
 * table 表格、figure/figcaption。
 *
 * 设计：递归下降解析（token 化 + 良构 HTML 的闭合匹配），不依赖 DOMParser，
 * 因此单测可直接在 node 执行。inline 元素拼接为无换行字符串，block 元素间空行分隔。
 */

// 无闭合标签的元素（自闭合或 void）
const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'wbr']);

// 块级元素：渲染时块间空行分隔
const BLOCK_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'article', 'ul', 'ol', 'li',
  'blockquote', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption',
  'hr', 'header', 'footer', 'main', 'aside', 'nav',
]);

type HtmlElement = { type: 'element'; tag: string; attrs: Record<string, string>; children: HtmlNode[] };
type HtmlNode = { type: 'text'; text: string } | HtmlElement;

const isElement = (n: HtmlNode): n is HtmlElement => n.type === 'element';

/** 解码常见 HTML 实体（提取正文里经常混入 &amp; &lt; &gt; &quot; &#39; &nbsp; 等） */
export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCodePoint(parseInt(code, 16)));
}

/** 解析开标签属性串（如 ` src="a.jpg" alt="x"`）为 map */
function parseAttrs(attrsStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrsStr))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

/** 递归下降：解析 HTML 字符串为节点树（良构 HTML，标签正确嵌套） */
function parseNodes(html: string, pos: { i: number }, stopTag?: string): HtmlNode[] {
  const nodes: HtmlNode[] = [];
  while (pos.i < html.length) {
    const lt = html.indexOf('<', pos.i);
    if (lt === -1) {
      const text = html.slice(pos.i);
      if (text) nodes.push({ type: 'text', text: decodeEntities(text) });
      pos.i = html.length;
      break;
    }
    if (lt > pos.i) {
      nodes.push({ type: 'text', text: decodeEntities(html.slice(pos.i, lt)) });
    }
    // 注释
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      pos.i = end === -1 ? html.length : end + 3;
      continue;
    }
    // 闭合标签：交还上层处理（或遇到期望的停止标签）
    if (html.startsWith('</', lt)) {
      const closeMatch = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/.exec(html.slice(lt));
      if (!closeMatch) {
        pos.i = lt + 2;
        continue;
      }
      const closeTag = closeMatch[1].toLowerCase();
      if (stopTag && closeTag === stopTag) {
        pos.i = lt + closeMatch[0].length;
        return nodes;
      }
      // 未匹配的孤立闭标签：跳过（浏览器 innerHTML 不会出现，防御性处理）
      pos.i = lt + closeMatch[0].length;
      continue;
    }
    // 开标签 / 自闭合
    const gt = html.indexOf('>', lt);
    if (gt === -1) {
      pos.i = html.length;
      break;
    }
    const rawTag = html.slice(lt + 1, gt);
    const selfClose = rawTag.endsWith('/');
    const tagMatch = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(rawTag);
    if (!tagMatch) {
      pos.i = gt + 1;
      continue;
    }
    const tag = tagMatch[1].toLowerCase();
    // 隐式闭合：如果当前处于 <p> 中，遇到了新的同级段落/块标签（如 <p> 或 <h1> 等），直接交还上层关闭
    if (stopTag === 'p' && (tag === 'p' || BLOCK_TAGS.has(tag))) {
      pos.i = lt; // 回退指针，留给外层闭合后重新处理新块
      return nodes;
    }
    if (stopTag === 'li' && tag === 'li') {
      pos.i = lt;
      return nodes;
    }
    const attrs = parseAttrs(rawTag.slice(tagMatch[0].length));
    pos.i = gt + 1;

    if (selfClose || VOID_TAGS.has(tag)) {
      nodes.push({ type: 'element', tag, attrs, children: [] });
      continue;
    }
    const children = parseNodes(html, pos, tag);
    nodes.push({ type: 'element', tag, attrs, children });
  }
  return nodes;
}

/** 压缩空白：去掉文本首尾空白、多段空白折叠为单个空格 */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 渲染行内内容（无换行），用于 p / li / heading / a / strong 内部 */
function renderInline(nodes: HtmlNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      out += n.text;
      continue;
    }
    const tag = n.tag;
    if (tag === 'br') {
      out += '\n';
    } else if (tag === 'strong' || tag === 'b') {
      out += `**${renderInline(n.children)}**`;
    } else if (tag === 'em' || tag === 'i') {
      out += `*${renderInline(n.children)}*`;
    } else if (tag === 'del' || tag === 's') {
      out += `~~${renderInline(n.children)}~~`;
    } else if (tag === 'code') {
      const code = renderInline(n.children).replace(/`/g, '\\`');
      out += `\`${code}\``;
    } else if (tag === 'a') {
      const href = n.attrs.href || '';
      const text = renderInline(n.children) || href;
      out += href ? `[${text}](${href})` : text;
    } else if (tag === 'img') {
      const src = n.attrs.src || '';
      const alt = n.attrs.alt || '';
      if (src) out += `![${alt}](${src})`;
    } else {
      // span/sub/sup/mark/u 等：透传内容
      out += renderInline(n.children);
    }
  }
  return out;
}

/** 递归渲染块级节点为 markdown（可含换行结构，如列表、表格、代码块） */
function renderBlock(node: HtmlNode): string {
  if (node.type === 'text') {
    return normalizeText(node.text);
  }
  const tag = node.tag;
  const children = node.children;

  if (tag === 'br') return '\n';
  if (tag === 'hr') return '---';

  if (/^h[1-6]$/.test(tag)) {
    const lvl = Number(tag[1]);
    const text = normalizeText(renderInline(children));
    return text ? `${'#'.repeat(lvl)} ${text}` : '';
  }
  if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' || tag === 'header' || tag === 'footer' || tag === 'main' || tag === 'aside' || tag === 'nav') {
    return normalizeText(renderInline(children));
  }
  if (tag === 'blockquote') {
    const inner = renderBlocks(children);
    return inner
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
  }
  if (tag === 'pre') {
    // pre 内可能有 <code>，取 code 文本；语言从 class 提取
    const codeNode = children.find((c): c is HtmlElement => isElement(c) && c.tag === 'code');
    const raw = codeNode ? inlineToText(codeNode.children) : inlineToText(children);
    const langClass = (codeNode && codeNode.attrs.class) || node.attrs.class || '';
    const langMatch = /(?:language-|lang-)([a-zA-Z0-9_+-]+)/.exec(langClass);
    const lang = langMatch ? langMatch[1] : '';
    const body = raw.replace(/\n$/, '');
    return `\`\`\`${lang}\n${body}\n\`\`\``;
  }
  if (tag === 'ul' || tag === 'ol') {
    const ordered = tag === 'ol';
    const items: string[] = [];
    let idx = 1;
    for (const c of children) {
      if (isElement(c) && c.tag === 'li') {
        items.push(renderListItem(c, ordered, idx));
        idx++;
      }
    }
    return items.join('\n');
  }
  if (tag === 'li') {
    return renderListItem(node, false, 1);
  }
  if (tag === 'table') {
    return renderTable(children);
  }
  if (tag === 'figure') {
    const img = children.find((c): c is HtmlElement => isElement(c) && c.tag === 'img');
    const caption = children.find((c): c is HtmlElement => isElement(c) && c.tag === 'figcaption');
    const parts: string[] = [];
    if (img) parts.push(renderInline([img]));
    if (caption) {
      const cap = normalizeText(renderInline(caption.children));
      if (cap) parts.push(cap);
    }
    return parts.join('\n');
  }
  if (tag === 'figcaption') {
    return normalizeText(renderInline(children));
  }
  if (tag === 'th' || tag === 'td') {
    return normalizeText(renderInline(children));
  }
  if (tag === 'tr' || tag === 'thead' || tag === 'tbody') {
    return renderBlocks(children);
  }

  // 未知块级/其他：递归渲染子块
  if (BLOCK_TAGS.has(tag)) {
    return renderBlocks(children);
  }
  return renderInline(children);
}

/** 渲染 li：`- ` 或 `1. ` + inline 内容；若内部嵌套列表则缩进追加 */
function renderListItem(li: HtmlElement, ordered: boolean, idx: number): string {
  const marker = ordered ? `${idx}. ` : '- ';
  const inlineParts: HtmlNode[] = [];
  const nested: HtmlElement[] = [];
  for (const c of li.children) {
    if (isElement(c) && (c.tag === 'ul' || c.tag === 'ol')) {
      nested.push(c);
    } else {
      inlineParts.push(c);
    }
  }
  const head = `${marker}${normalizeText(renderInline(inlineParts))}`;
  if (nested.length === 0) return head;
  const nestedMd = nested.map((n) => renderBlock(n)).join('\n');
  const indented = nestedMd
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  return `${head}\n${indented}`;
}

/** 渲染 table 为 markdown 表格 */
function renderTable(children: HtmlNode[]): string {
  const rows: HtmlElement[][] = [];
  const collect = (nodes: HtmlNode[]) => {
    for (const n of nodes) {
      if (!isElement(n)) continue;
      if (n.tag === 'tr') {
        const cells = n.children.filter((c): c is HtmlElement => isElement(c) && (c.tag === 'td' || c.tag === 'th'));
        rows.push(cells);
      } else if (n.tag === 'thead' || n.tag === 'tbody') {
        collect(n.children);
      }
    }
  };
  collect(children);
  if (rows.length === 0) return '';

  const renderRow = (cells: HtmlElement[]) => cells.map((c) => normalizeText(renderInline(c.children)).replace(/\|/g, '\\|'));
  const header = rows[0].map((c) => (c.tag === 'th' ? 'th' : 'td'));
  const hasHeader = header.some((h) => h === 'th');

  const lines: string[] = [];
  let bodyStart = 0;
  if (hasHeader) {
    lines.push(`| ${renderRow(rows[0]).join(' | ')} |`);
    lines.push(`| ${rows[0].map(() => '---').join(' | ')} |`);
    bodyStart = 1;
  }
  for (let r = bodyStart; r < rows.length; r++) {
    lines.push(`| ${renderRow(rows[r]).join(' | ')} |`);
  }
  return lines.join('\n');
}

/** 取节点树的纯文本（用于 pre>code 内容，不做 inline 标记转换） */
function inlineToText(nodes: HtmlNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      out += n.text;
    } else if (n.tag === 'br') {
      out += '\n';
    } else {
      out += inlineToText(n.children);
    }
  }
  return out;
}

/** 渲染一组节点为块序列（块间空行分隔） */
function renderBlocks(nodes: HtmlNode[]): string {
  const parts: string[] = [];
  for (const n of nodes) {
    const s = renderBlock(n);
    if (s) parts.push(s);
  }
  return parts.join('\n\n');
}

/** HTML → Markdown 入口 */
export function html2md(html: string): string {
  const pos = { i: 0 };
  const nodes = parseNodes(html, pos);
  const md = renderBlocks(nodes);
  // 折叠多余空行
  return md.replace(/\n{3,}/g, '\n\n').trim();
}
