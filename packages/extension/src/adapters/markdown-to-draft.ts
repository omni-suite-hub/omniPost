/**
 * 极简 Markdown → Draft.js contentState JSON（豆瓣专用，Service Worker 零依赖、无 DOM）。
 *
 * 背景：豆瓣笔记编辑器基于 Draft.js，autosave 接口的 note_text 必须是 Draft.js raw JSON。
 * 原版"文章同步助手"依赖 markdown-draft-js + remarkable 两个 npm 包；本项目为 SW 零依赖
 * 原则手写等价实现，覆盖豆瓣笔记实际用到的块类型：
 *   - 标题 (#~######) → header-one~six
 *   - 段落 / 引用 / 无序与有序列表 / 围栏代码块
 *   - 独立成行的图片 ![]() → atomic 块 + IMAGE entity
 *   - 行内图片 → 段落内 IMAGE entity
 *   - 行内 **粗体** / *斜体* / `行内代码` → inlineStyleRanges
 *
 * 输出：JSON.stringify({ entityMap, blocks })，结构与 markdown-draft-js 一致。
 */

export interface DoubanImageData {
  id: string;
  url: string;
  thumb: string;
  width?: number;
  height?: number;
  file_name?: string;
  file_size?: number;
}

interface StyleRange {
  offset: number;
  length: number;
  style: string;
}

interface EntityRange {
  offset: number;
  length: number;
  key: number;
}

/** 行内样式/行内图片解析：返回纯净文本 + 样式区间 + 图片实体区间 */
function inlineStyles(
  raw: string,
  imageDataMap: Map<string, DoubanImageData>,
  registerEntity: (data: any) => number,
): { text: string; ranges: StyleRange[]; entityRanges: EntityRange[] } {
  // 1) 行内代码占位（防止 * / [ 规则误伤代码内容）
  const codeTokens: string[] = [];
  let s = raw.replace(/`([^`\n]+)`/g, (_m, code) => {
    codeTokens.push(code);
    return `\u0000${codeTokens.length - 1}\u0000`;
  });
  // 2) 行内图片占位（含 ![]() 与 ![alt](url "title")）
  const imgTokens: Array<{ src: string; data: any }> = [];
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, _alt, src) => {
    const sourcePair = src.split('?#');
    const imgData = imageDataMap.get(src) || imageDataMap.get(sourcePair[0]);
    imgTokens.push({
      src,
      data: imgData
        ? { id: imgData.id, src: imgData.url, thumb: imgData.thumb, url: imgData.url, width: imgData.width, height: imgData.height, file_name: imgData.file_name, file_size: imgData.file_size }
        : { id: sourcePair[1] || '', src: sourcePair[0], thumb: sourcePair[0], url: sourcePair[0] },
    });
    return `\u0003${imgTokens.length - 1}\u0003`;
  });
  // 3) 粗体 / 斜体占位
  const boldTokens: string[] = [];
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, b) => {
    boldTokens.push(b);
    return `\u0001${boldTokens.length - 1}\u0001`;
  });
  const italicTokens: string[] = [];
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_m, pre, i) => {
    italicTokens.push(i);
    return `${pre}\u0002${italicTokens.length - 1}\u0002`;
  });

  // 4) 按顺序还原占位符，记录区间
  const re = /\u0000(\d+)\u0000|\u0001(\d+)\u0001|\u0002(\d+)\u0002|\u0003(\d+)\u0003/g;
  let last = 0;
  let text = '';
  const ranges: StyleRange[] = [];
  const entityRanges: EntityRange[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    text += s.slice(last, m.index);
    const offset = text.length;
    if (m[1] !== undefined) {
      const t = codeTokens[Number(m[1])];
      text += t;
      ranges.push({ offset, length: t.length, style: 'CODE' });
    } else if (m[2] !== undefined) {
      const t = boldTokens[Number(m[2])];
      text += t;
      ranges.push({ offset, length: t.length, style: 'BOLD' });
    } else if (m[3] !== undefined) {
      const t = italicTokens[Number(m[3])];
      text += t;
      ranges.push({ offset, length: t.length, style: 'ITALIC' });
    } else if (m[4] !== undefined) {
      const t = imgTokens[Number(m[4])];
      const key = registerEntity({ type: 'IMAGE', mutability: 'IMMUTABLE', data: t.data });
      // 图片实体区间长度按原 markdown 源串长度计算（Draft.js 仅要求 offset/length 落在文本内，
      // 这里以实体 key 对应的占位长度为 1，Draft.js 图片装饰器按 data 渲染，长度不影响展示）
      const len = 1;
      entityRanges.push({ offset, length: len, key });
      text += ' ';
    }
    last = m.index + m[0].length;
  }
  text += s.slice(last);
  return { text, ranges, entityRanges };
}

/**
 * Markdown → Draft.js raw JSON（豆瓣 note_text）。
 * @param markdown Markdown 内容
 * @param imageDataMap 图片 URL → 完整图片数据（上传时收集）
 */
export function markdownToDraft(
  markdown: string,
  imageDataMap: Map<string, DoubanImageData> = new Map(),
): string {
  // 保证每个图片独立成行（对齐 markdown-draft-js 的换行预处理）
  const processed = markdown
    .split('\n')
    .map((line) => {
      const parts = line.split('![');
      return parts.length > 1 ? parts.join('\n![') : line;
    })
    .join('\n');

  const entityMap: Record<string, any> = {};
  let entityCounter = 0;
  const registerEntity = (entity: any): number => {
    const key = entityCounter++;
    entityMap[key] = entity;
    return key;
  };

  const blocks: any[] = [];
  let keyCounter = 0;
  const genKey = () => {
    // 5 字符唯一 key（Draft.js 惯例）
    const k = keyCounter++;
    return k.toString(36).padStart(5, '0');
  };
  const pushBlock = (type: string, text: string, ranges: StyleRange[] = [], entityRanges: EntityRange[] = []) => {
    blocks.push({ key: genKey(), type, text, depth: 0, inlineStyleRanges: ranges, entityRanges, data: {} });
  };

  const HEADER_TYPES = ['header-one', 'header-two', 'header-three', 'header-four', 'header-five', 'header-six'];

  const lines = processed.split('\n');
  let i = 0;
  let inCode = false;
  let codeBuf: string[] = [];
  let paraBuf: string[] = [];

  const flushParagraph = () => {
    if (paraBuf.length === 0) return;
    const joined = paraBuf.join(' ');
    const { text, ranges, entityRanges } = inlineStyles(joined, imageDataMap, registerEntity);
    pushBlock('paragraph', text, ranges, entityRanges);
    paraBuf = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (inCode) {
      if (/^\s*```/.test(line)) {
        pushBlock('code-block', codeBuf.join('\n'));
        codeBuf = [];
        inCode = false;
      } else {
        codeBuf.push(line);
      }
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushParagraph();
      inCode = true;
      i++;
      continue;
    }

    const trimmed = line.trim();

    // 独立成行的图片 → atomic 块
    const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
    if (imgMatch) {
      flushParagraph();
      const src = imgMatch[2];
      const sourcePair = src.split('?#');
      const imgData = imageDataMap.get(src) || imageDataMap.get(sourcePair[0]);
      const key = registerEntity({
        type: 'IMAGE',
        mutability: 'IMMUTABLE',
        data: imgData
          ? { id: imgData.id, src: imgData.url, thumb: imgData.thumb, url: imgData.url, width: imgData.width, height: imgData.height, file_name: imgData.file_name, file_size: imgData.file_size }
          : { id: sourcePair[1] || '', src: sourcePair[0], thumb: sourcePair[0], url: sourcePair[0] },
      });
      pushBlock('atomic', ' ', [], [{ offset: 0, length: 1, key }]);
      i++;
      continue;
    }

    // 标题
    const hMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      flushParagraph();
      const { text, ranges, entityRanges } = inlineStyles(hMatch[2], imageDataMap, registerEntity);
      pushBlock(HEADER_TYPES[hMatch[1].length - 1], text, ranges, entityRanges);
      i++;
      continue;
    }

    // 引用
    const qMatch = line.match(/^>\s?(.*)$/);
    if (qMatch) {
      flushParagraph();
      const { text, ranges, entityRanges } = inlineStyles(qMatch[1], imageDataMap, registerEntity);
      pushBlock('blockquote', text, ranges, entityRanges);
      i++;
      continue;
    }

    // 无序列表
    const ulMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (ulMatch) {
      flushParagraph();
      const { text, ranges, entityRanges } = inlineStyles(ulMatch[1], imageDataMap, registerEntity);
      pushBlock('unordered-list-item', text, ranges, entityRanges);
      i++;
      continue;
    }

    // 有序列表
    const olMatch = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (olMatch) {
      flushParagraph();
      const { text, ranges, entityRanges } = inlineStyles(olMatch[1], imageDataMap, registerEntity);
      pushBlock('ordered-list-item', text, ranges, entityRanges);
      i++;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      i++;
      continue;
    }

    // 空行 → 段落断点
    if (trimmed === '') {
      flushParagraph();
      i++;
      continue;
    }

    paraBuf.push(trimmed);
    i++;
  }
  flushParagraph();
  // 未闭合的代码块
  if (inCode && codeBuf.length > 0) {
    pushBlock('code-block', codeBuf.join('\n'));
  }

  return JSON.stringify({ entityMap, blocks });
}
