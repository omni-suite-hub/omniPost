/**
 * Markdown 与平台格式自适应转换工具库
 *
 * 针对不支持 Markdown 语法的平台（如小红书、微博、B站动态、X/Twitter 等社交平台，
 * 以及需要富文本 HTML 注入的知乎、公众号、头条号等），提供双向排版转换支持：
 *  1. markdownToPlainText：将 Markdown 转化为符合社交排版习惯的干净纯文本（消除裸 # 和 **）
 *  2. getPlatformFormat：判断平台接受的格式类型（markdown / html / plain）
 */
import { PlatformId } from '@omnipost/core';

/**
 * 将 Markdown 文档转换为适合社交/纯文本平台阅读的自然纯文本：
 *  - 标题（# ~ ###）转为 【标题】 或 📌 标题
 *  - 粗体（**、__）与斜体（*、_）剥离标记，还原为自然文本
 *  - 链接 [文本](url) 转换为 文本 (url)
 *  - 图片 ![alt](url) 转换为 [图片: alt] 或直接清理
 *  - 无序列表（- / * / +）转换为 • 项目符号
 *  - 引用（>）转换为 | 引用
 *  - 围栏代码块剥离反引号，保留代码缩进与内容
 *  - 清理多余空行
 */
export function markdownToPlainText(src: string): string {
  if (!src) return '';

  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const resultLines: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // 1. 围栏代码块检测
    if (/^```/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      resultLines.push(rawLine);
      continue;
    }

    // 2. 空行
    if (!trimmed) {
      // 避免连续多于一个空行
      if (resultLines.length > 0 && resultLines[resultLines.length - 1] !== '') {
        resultLines.push('');
      }
      continue;
    }

    // 3. 分割线
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
      resultLines.push('──────────');
      continue;
    }

    let line = rawLine;

    // 4. 标题解析
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      let text = headerMatch[2].trim();
      // 清理行内标记
      text = stripInlineStyles(text);
      if (level <= 3) {
        // 大小标题：规范为【标题】（如果已有书名号或方括号，不再重复加）
        if (text.startsWith('【') && text.endsWith('】')) {
          line = text;
        } else if (text.startsWith('[') && text.endsWith(']')) {
          line = text;
        } else {
          line = `【${text}】`;
        }
      } else {
        line = `• ${text}`;
      }
      resultLines.push(line);
      continue;
    }

    // 5. 引用块
    const quoteMatch = line.match(/^>\s*(.+)$/);
    if (quoteMatch) {
      const quoteText = stripInlineStyles(quoteMatch[1].trim());
      resultLines.push(`| ${quoteText}`);
      continue;
    }

    // 6. 无序列表
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      const indent = ulMatch[1];
      const text = stripInlineStyles(ulMatch[2]);
      resultLines.push(`${indent}• ${text}`);
      continue;
    }

    // 7. 有序列表
    const olMatch = line.match(/^(\s*\d+\.)\s+(.+)$/);
    if (olMatch) {
      const prefix = olMatch[1];
      const text = stripInlineStyles(olMatch[2]);
      resultLines.push(`${prefix} ${text}`);
      continue;
    }

    // 8. 普通段落：剥离行内样式
    line = stripInlineStyles(line);
    resultLines.push(line);
  }

  return resultLines.join('\n').trim();
}

/**
 * 剥离行内粗体、斜体、删除线、行内代码、图片、链接等 Markdown 语法标记
 */
function stripInlineStyles(text: string): string {
  let s = text;

  // 1. 剥离图片：![alt](url) -> [图片: alt] 或空
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_m, alt) => {
    const a = (alt || '').trim();
    return a ? `[图片: ${a}]` : '';
  });

  // 2. 处理链接：[text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText, url) => {
    const lt = (linkText || '').trim();
    const u = (url || '').trim();
    if (!lt || lt === u) return u;
    return `${lt} (${u})`;
  });

  // 3. 行内代码：`code` -> code
  s = s.replace(/`([^`]+)`/g, '$1');

  // 4. 粗斜体：***text*** 或 ___text___
  s = s.replace(/(\*\*\*|___)(.*?)\1/g, '$2');

  // 5. 粗体：**text** 或 __text__
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');

  // 6. 斜体：*text* 或 _text_（防下划线变量名误伤，前后需非单词或标点边界）
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
  s = s.replace(/(^|[^a-zA-Z0-9_])_([^_\n]+)_(?![a-zA-Z0-9_])/g, '$1$2');

  // 7. 删除线：~~text~~
  s = s.replace(/~~(.*?)~~/g, '$1');

  return s;
}

/**
 * 平台格式分类
 *  - 'markdown': 原生支持 Markdown（Dev.to, CSDN, 掘金, 思否, 博客园, 开源中国, Reddit 等）
 *  - 'html': 富文本平台（知乎, 微信公众号, 今日头条, 简书, 网易号, 大鱼号, 搜狐等）
 *  - 'plain': 纯文本 / 社交平台（小红书, 微博, B站动态, Twitter, Bluesky, Mastodon, Telegram, 抖音等）
 */
export type PlatformContentFormat = 'markdown' | 'html' | 'plain';

export function getPlatformFormat(platformId: PlatformId): PlatformContentFormat {
  switch (platformId) {
    // 纯文本 / 社交平台（不支持 Markdown 标记）
    // 注意：微博（头条文章）与 B站（专栏）的适配器实际走 HTML 富文本编辑器，不在此列
    // YouTube 描述框支持 Markdown 风格（超链接、加粗），归 markdown，不走 plain 清洗
    case 'xiaohongshu':
    case 'twitter':
    case 'bluesky':
    case 'mastodon':
    case 'telegram':
    case 'douyin':
      return 'plain';

    // 富文本平台（使用富文本 HTML 编辑器）
    case 'zhihu':
    case 'weixin':
    case 'toutiao':
    case 'jianshu':
    case 'netease':
    case 'dayu':
    case 'yidian':
    case 'smzdm':
    case 'sohufocus':
    case 'sohu':
    case 'baijiahao':
    case 'eastmoney':
    case 'xueqiu':
    case 'woshipm':
    case 'douban':
    // 微博头条文章 / B站专栏均为 HTML 富文本编辑器（适配器内 md2html），
    // 误归为 plain 会先被洗成纯文本再转 HTML，标题层级与加粗全丢
    case 'weibo':
    case 'bilibili':
      return 'html';

    // Markdown 原生平台
    case 'juejin':
    case 'csdn':
    case 'segmentfault':
    case 'oschina':
    case 'cnblogs':
    case 'devto':
    case 'hashnode':
    case 'wordpress':
    case 'typecho':
    case 'metaweblog':
    case 'yuque':
    case 'reddit':
    case 'cto51':
    case 'imooc':
    case 'zip-download':
    default:
      return 'markdown';
  }
}
