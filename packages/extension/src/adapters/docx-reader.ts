/**
 * .docx 文档解析器（Word 2007+ OOXML）。
 *
 * .docx = ZIP 容器，内含 word/document.xml（正文 XML）。仅依赖 fflate（Apache-2.0/MIT）
 * 做 unzip，正文文本提取走原生 DOMParser 解析 w:p / w:t 节点。
 *
 * 用途：popup「上传文档」导入 .docx 作为发布正文，弥补「手动粘贴」的体验。
 * 输出 { title, text }：title 取正文第一段前 60 字符，text 为段落拼接（段间空行）。
 *
 * 设计：浏览器 DOM 环境运行（DOMParser 必需），不进 Service Worker。
 */
import { unzipSync, strFromU8 } from 'fflate';

const MAX_DOCX_BYTES = 30 * 1024 * 1024; // 30MB 硬上限（与 popup 媒体策略对齐）

export interface DocxImportResult {
  title: string;
  text: string;
}

/**
 * 从 .docx 的 ArrayBuffer 提取纯文本。
 * @throws 当解压失败 / 缺 word/document.xml / 超过 30MB 时抛错。
 */
export function readDocxText(arrayBuffer: ArrayBuffer): DocxImportResult {
  if (arrayBuffer.byteLength > MAX_DOCX_BYTES) {
    throw new Error(`文档过大（${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB > 30MB）`);
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(arrayBuffer));
  } catch (e: any) {
    throw new Error(`不是有效的 .docx 文件：${e?.message || '解压失败'}`);
  }
  const docXmlBytes = files['word/document.xml'];
  if (!docXmlBytes) throw new Error('文档缺少正文（word/document.xml）');

  const docXml = strFromU8(docXmlBytes);
  const parser = new DOMParser();
  const doc = parser.parseFromString(docXml, 'application/xml');
  const errNode = doc.querySelector('parsererror');
  if (errNode) throw new Error('文档 XML 解析失败');

  // 提取所有段落（w:p），段落内 w:t 拼接；保留段落分隔
  const paragraphs = Array.from(doc.getElementsByTagName('w:p'));
  const lines: string[] = [];
  for (const p of paragraphs) {
    const texts = Array.from(p.getElementsByTagName('w:t'));
    const line = texts.map((t) => t.textContent || '').join('');
    if (line) lines.push(line);
  }
  const text = lines.join('\n\n');
  if (!text) throw new Error('文档正文为空');

  // 标题取第一段前 60 字符（截断标点与首尾空白）
  const first = lines[0] || '';
  const title = first.replace(/[\s。！？!?\.,，；;]+$/, '').slice(0, 60);

  return { title, text };
}
