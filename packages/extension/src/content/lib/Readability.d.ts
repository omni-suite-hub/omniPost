/**
 * Mozilla Readability 类型声明（实现见同目录 Readability.js，Apache-2.0）。
 */
export interface ReadabilityParseResult {
  title: string;
  byline: string | null;
  dir: string | null;
  content: string;
  textContent: string;
  length: number;
  excerpt: string;
  siteName: string | null;
}

declare class Readability {
  constructor(doc: Document, options?: Record<string, unknown>);
  parse(): ReadabilityParseResult | null;
}

export default Readability;
