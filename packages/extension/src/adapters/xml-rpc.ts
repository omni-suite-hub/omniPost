/**
 * 零依赖 XML-RPC 客户端（Service Worker 可用）。
 *
 * 对齐"文章同步助手" metaweblog 通道，但不引入任何 npm 依赖：
 * - 构建请求：紧凑格式（某些 XML-RPC 实现对多余空白敏感）；
 * - 解析响应：递归解析器（处理 string/int/i4/boolean/double/base64/struct/array
 *   任意嵌套），比参考实现的单层正则更健壮；
 * - 上传媒体：metaWeblog.newMediaObject 的 bits/bytes 双发（Typecho 兼容）。
 */

// ---------- 构建请求 ----------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function valueToXml(value: unknown): string {
  if (typeof value === 'string') return `<string>${escapeXml(value)}</string>`;
  if (typeof value === 'number') return `<i4>${Math.trunc(value)}</i4>`;
  if (typeof value === 'boolean') return `<boolean>${value ? 1 : 0}</boolean>`;
  if (value instanceof Uint8Array) return `<base64>${bytesToBase64(value)}</base64>`;
  if (typeof value === 'object' && value !== null) {
    return `<struct>${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `<member><name>${escapeXml(k)}</name><value>${valueToXml(v)}</value></member>`)
      .join('')}</struct>`;
  }
  return `<string>${escapeXml(String(value))}</string>`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** 构建 XML-RPC 请求体（紧凑格式） */
export function buildXmlRpcRequest(method: string, params: unknown[]): string {
  const paramXml = params
    .map((param) => `<param><value>${valueToXml(param)}</value></param>`)
    .join('');
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${paramXml}</params></methodCall>`;
}

// ---------- 解析响应 ----------

export type XmlRpcValue = string | number | boolean | Uint8Array | XmlRpcStruct | XmlRpcValue[] | null;
export interface XmlRpcStruct {
  [key: string]: XmlRpcValue;
}

export interface XmlRpcResponse {
  success: boolean;
  value?: XmlRpcValue;
  faultCode?: number;
  faultString?: string;
}

/** 从 <tag ...> 开始匹配到对应 </tag>，返回 [inner, endIndex]（处理嵌套）；找不到返回 null */
function matchTag(xml: string, start: number, tag: string): [string, number] | null {
  const open = xml.indexOf(`<${tag}`, start);
  if (open < 0) return null;
  const openEnd = xml.indexOf('>', open);
  if (openEnd < 0) return null;
  const closeTag = `</${tag}>`;
  // 从内容起点开始扫描，遇到嵌套 <tag 则跳过其闭合
  let depth = 1;
  let i = openEnd + 1;
  while (i < xml.length && depth > 0) {
    const nextOpen = xml.indexOf(`<${tag}`, i);
    const nextClose = xml.indexOf(closeTag, i);
    if (nextClose < 0) return null;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + tag.length + 1;
    } else {
      depth--;
      i = nextClose + closeTag.length;
    }
  }
  if (depth !== 0) return null;
  return [xml.slice(openEnd + 1, i - closeTag.length), i];
}

function unescapeXml(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 解析 <value>...</value> 内部内容为一个 XML-RPC 值 */
function parseValueInner(inner: string): XmlRpcValue {
  const t = inner.trim();

  // <string>：常见；也可能是空 <value></value> → 空字符串
  const stringMatch = t.match(/^<string>([\s\S]*)<\/string>$/);
  if (stringMatch) return unescapeXml(stringMatch[1]);

  const intMatch = t.match(/^<(i4|int)>(-?\d+)<\/\1>$/);
  if (intMatch) return parseInt(intMatch[2], 10);

  const boolMatch = t.match(/^<boolean>([01])<\/boolean>$/);
  if (boolMatch) return boolMatch[1] === '1';

  const doubleMatch = t.match(/^<double>([\d.eE+-]+)<\/double>$/);
  if (doubleMatch) return parseFloat(doubleMatch[1]);

  const b64Match = t.match(/^<base64>([\s\S]*)<\/base64>$/);
  if (b64Match) return base64ToBytes(b64Match[1]);

  // <struct>：解析 member 列表（递归）
  const structMatch = t.match(/^<struct>([\s\S]*)<\/struct>$/);
  if (structMatch) {
    const obj: XmlRpcStruct = {};
    const body = structMatch[1];
    let i = 0;
    while (i < body.length) {
      const member = matchTag(body, i, 'member');
      if (!member) break;
      const [memberInner] = member;
      const nameMatch = memberInner.match(/<name>([\s\S]*?)<\/name>/);
      const valueMatch = memberInner.match(/<value>([\s\S]*?)<\/value>/);
      if (nameMatch && valueMatch) {
        obj[unescapeXml(nameMatch[1])] = parseValueInner(valueMatch[1]);
      }
      i = member[1];
    }
    return obj;
  }

  // <array>：解析 data 下的 value 列表（递归）
  const arrayMatch = t.match(/^<array><data>([\s\S]*)<\/data><\/array>$/);
  if (arrayMatch) {
    const values: XmlRpcValue[] = [];
    const body = arrayMatch[1];
    let i = 0;
    while (i < body.length) {
      const value = matchTag(body, i, 'value');
      if (!value) break;
      values.push(parseValueInner(value[0]));
      i = value[1];
    }
    return values;
  }

  // 裸文本（无类型标签）
  if (!t.includes('<')) return unescapeXml(t);
  return null;
}

/** 解析 XML-RPC 响应，返回成功标志 + 值 / fault 信息 */
export function parseXmlRpcResponse(xml: string): XmlRpcResponse {
  // fault：<fault><value><struct>...</struct></value></fault>
  const faultMatch = matchTag(xml, 0, 'fault');
  if (faultMatch) {
    const value = matchTag(faultMatch[0], 0, 'value');
    let faultCode: number | undefined;
    let faultString: string | undefined;
    if (value) {
      const struct = parseValueInner(value[0]);
      if (struct && typeof struct === 'object' && !(struct instanceof Uint8Array)) {
        const s = struct as XmlRpcStruct;
        faultCode = typeof s.faultCode === 'number' ? s.faultCode : undefined;
        faultString = typeof s.faultString === 'string' ? s.faultString : undefined;
      }
    }
    return { success: false, faultCode, faultString: faultString || 'XML-RPC 错误' };
  }

  // 正常响应：<params><param><value>...</value></param></params>
  const params = matchTag(xml, 0, 'params');
  if (params) {
    const param = matchTag(params[0], 0, 'param');
    if (param) {
      const value = matchTag(param[0], 0, 'value');
      if (value) {
        return { success: true, value: parseValueInner(value[0]) };
      }
    }
  }
  return { success: true, value: undefined };
}

/** 从响应 XML 中提取最新文章的 postid（Typecho 返回 0 时兜底查证用） */
export function extractLatestPostId(xml: string): string | null {
  // 中央目录风格：<member><name>postid</name><value><string>123</string></value></member>
  const member = matchTag(xml, 0, 'member');
  if (member) {
    const nameMatch = member[0].match(/<name>postid<\/name>/);
    if (nameMatch) {
      const value = matchTag(member[0], 0, 'value');
      if (value) {
        const parsed = parseValueInner(value[0]);
        if (typeof parsed === 'string' || typeof parsed === 'number') return String(parsed);
      }
    }
  }
  return null;
}

// ---------- 常用端点推导 ----------

/** WordPress/通用 MetaWeblog 默认端点 */
export function defaultXmlRpcEndpoint(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, '') + '/xmlrpc.php';
}

/** Typecho 默认端点 */
export function defaultTypechoEndpoint(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, '') + '/action/xmlrpc';
}
