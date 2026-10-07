/**
 * AWS4-HMAC-SHA256 签名 + CRC32（零依赖，Service Worker 可用）。
 * 用途：掘金 ImageX 图床上传（字节跳动火山引擎对象存储）。
 * 移植自 Wechatsync（GPL-3.0）的 lib/aws4.ts，改为纯 Web Crypto 实现。
 */

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const keyBytes = key instanceof Uint8Array ? key : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function sha256Hex(message: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export interface AWS4SignParams {
  method: string;
  url: string;
  accessKeyId: string;
  secretAccessKey: string;
  securityToken?: string;
  region?: string;
  service?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface AWS4SignResult {
  authorization: string;
  amzDate: string;
  headers: Record<string, string>;
}

/** 生成 AWS4-HMAC-SHA256 签名头 */
export async function signAWS4(params: AWS4SignParams): Promise<AWS4SignResult> {
  const {
    method,
    url,
    accessKeyId,
    secretAccessKey,
    securityToken,
    region = 'cn-north-1',
    service = 'imagex',
    headers = {},
    body = '',
  } = params;

  const parsedUrl = new URL(url);
  const path = parsedUrl.pathname || '/';
  const queryString = parsedUrl.search.slice(1);

  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');

  // 规范化查询字符串（按参数名排序）
  const queryParams = new URLSearchParams(queryString);
  const sortedParams = Array.from(queryParams.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const canonicalQueryString = sortedParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const signedHeadersObj: Record<string, string> = { 'x-amz-date': amzDate };
  if (securityToken) signedHeadersObj['x-amz-security-token'] = securityToken;
  Object.assign(signedHeadersObj, headers);

  const signedHeaderNames = Object.keys(signedHeadersObj)
    .map((k) => k.toLowerCase())
    .sort()
    .join(';');

  const canonicalHeaders =
    Object.entries(signedHeadersObj)
      .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}`)
      .sort()
      .join('\n') + '\n';

  const payloadHash = await sha256Hex(body);

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaderNames,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalRequestHash = await sha256Hex(canonicalRequest);

  const stringToSign = [algorithm, amzDate, credentialScope, canonicalRequestHash].join('\n');

  const kDate = await hmacSha256(new TextEncoder().encode('AWS4' + secretAccessKey), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signatureBuffer = await hmacSha256(kSigning, stringToSign);
  const signature = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;

  const resultHeaders: Record<string, string> = { authorization, 'x-amz-date': amzDate };
  if (securityToken) resultHeaders['x-amz-security-token'] = securityToken;

  return { authorization, amzDate, headers: resultHeaders };
}

/** CRC32 校验值（十六进制字符串） */
export function crc32(data: Uint8Array): string {
  let crc = 0xffffffff;
  const table = getCRC32Table();
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

let crc32Table: Uint32Array | null = null;
function getCRC32Table(): Uint32Array {
  if (crc32Table) return crc32Table;
  crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc32Table[i] = c;
  }
  return crc32Table;
}
