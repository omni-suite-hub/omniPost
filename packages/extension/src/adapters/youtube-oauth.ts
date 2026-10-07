/**
 * YouTube OAuth2 (PKCE) + Data API 工具
 *
 * 流程：设置面板填 Google Cloud OAuth Client ID/Secret →
 *       chrome.identity.launchWebAuthFlow 打开授权页（PKCE code_verifier/code_challenge）→
 *       换 token → 存 store（accessToken/refreshToken/expiresAt）→ 过期自动刷新。
 *
 * 纯函数全部导出，便于单元测试直接执行真实逻辑。
 */

export interface YoutubeTokens {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
}

export interface YoutubeConfig extends YoutubeTokens {
  clientId?: string;
  clientSecret?: string;
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube';
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

/** 生成 PKCE code_verifier（43-128 位，A-Za-z0-9-_）。 */
export function generateCodeVerifier(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const arr = new Uint8Array(64);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < arr.length; i++) out += chars[arr[i] % chars.length];
  return out;
}

/** PKCE code_challenge = base64url(sha256(code_verifier))。 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  let digest: ArrayBuffer;
  if (typeof crypto !== 'undefined' && (crypto as any).subtle) {
    digest = await (crypto as any).subtle.digest('SHA-256', data);
  } else {
    // node 兜底（esbuild bundle 到 node 单测时 webcrypto 不可用的情况）
    // @ts-ignore node-only fallback：项目无 @types/node，跳过 'crypto' 类型解析
    const { createHash } = await import('crypto');
    digest = createHash('sha256').update(data).digest().buffer as ArrayBuffer;
  }
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** 构造授权页 URL。 */
export function buildAuthUrl(clientId: string, codeChallenge: string, redirectUri: string): string {
  const qs = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_ENDPOINT}?${qs.toString()}`;
}

/** 用授权码换取 token（POST oauth2.googleapis.com/token）。 */
export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<YoutubeTokens> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`OAuth 授权失败: ${json.error_description || json.error || res.statusText}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || undefined,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  };
}

/** 用 refresh_token 刷新 access token。 */
export async function refreshTokens(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<YoutubeTokens> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Token 刷新失败: ${json.error_description || json.error || res.statusText}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: refreshToken,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  };
}

/** 检查 token 是否有效（存在且未过期，预留 5 分钟余量）。 */
export function isTokenValid(tokens: YoutubeTokens): boolean {
  if (!tokens.accessToken) return false;
  if (!tokens.expiresAt) return true; // 无过期时间视为有效
  return tokens.expiresAt - Date.now() > 5 * 60 * 1000;
}

/** 获取可用 access token；过期则用 refreshToken 刷新（返回新 token，供调用方持久化）。 */
export async function ensureAccessToken(cfg: YoutubeConfig): Promise<{ token: string; updated?: YoutubeTokens }> {
  if (isTokenValid(cfg)) return { token: cfg.accessToken! };
  if (cfg.refreshToken && cfg.clientId && cfg.clientSecret) {
    const updated = await refreshTokens(cfg.clientId, cfg.clientSecret, cfg.refreshToken);
    return { token: updated.accessToken!, updated };
  }
  throw new Error('YouTube 未授权或 Token 已过期，请到设置面板重新授权');
}

/** 创建 resumable 上传会话，返回 upload URL（POST upload/youtube/v3/videos）。 */
export async function createResumableSession(
  accessToken: string,
  metadata: { title: string; description: string; privacyStatus?: string },
  fileSize: number,
  contentType: string,
): Promise<string> {
  const res = await fetch(`${YOUTUBE_API}/videos?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(fileSize),
      'X-Upload-Content-Type': contentType,
    },
    body: JSON.stringify({
      snippet: { title: metadata.title, description: metadata.description },
      status: { privacyStatus: metadata.privacyStatus || 'private' },
    }),
  });
  const uploadUrl = res.headers.get('Location');
  if (!res.ok || !uploadUrl) {
    throw new Error(`创建 YouTube 上传会话失败: HTTP ${res.status}`);
  }
  return uploadUrl;
}

/** 更新视频元数据 / 隐私状态（videos.update）。 */
export async function updateVideo(
  accessToken: string,
  videoId: string,
  update: { title?: string; description?: string; privacyStatus?: string },
): Promise<void> {
  const part: string[] = [];
  if (update.title || update.description) part.push('snippet');
  if (update.privacyStatus) part.push('status');
  if (part.length === 0) return;

  const res = await fetch(`${YOUTUBE_API}/videos?part=${part.join(',')}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      id: videoId,
      snippet: update.title || update.description
        ? { title: update.title, description: update.description }
        : undefined,
      status: update.privacyStatus ? { privacyStatus: update.privacyStatus } : undefined,
    }),
  });
  if (!res.ok) {
    throw new Error(`更新视频信息失败: HTTP ${res.status}`);
  }
}

/** 校验 token 并返回频道信息（channels.list）。 */
export async function fetchChannel(accessToken: string): Promise<{ name: string; avatar?: string }> {
  const res = await fetch(`${YOUTUBE_API}/channels?part=snippet&mine=true`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`YouTube 鉴权校验失败: HTTP ${res.status}`);
  }
  const json = await res.json();
  const channel = json.items?.[0]?.snippet;
  if (!channel) throw new Error('未找到 YouTube 频道');
  return { name: channel.title, avatar: channel.thumbnails?.default?.url };
}

/**
 * 完整 OAuth 授权：launchWebAuthFlow 打开 Google 授权页 → 回调取 code → 换 token。
 * （chrome.identity 依赖浏览器环境；单元测试中 mock chrome.identity）
 */
export async function authorizeYoutube(clientId: string, clientSecret: string): Promise<YoutubeTokens> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = buildAuthUrl(clientId, codeChallenge, redirectUri);

  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!responseUrl) throw new Error('OAuth 授权已取消');
  const code = new URL(responseUrl).searchParams.get('code');
  if (!code) throw new Error('OAuth 授权失败：回调缺少授权码');
  return exchangeCode(clientId, clientSecret, code, codeVerifier, redirectUri);
}
