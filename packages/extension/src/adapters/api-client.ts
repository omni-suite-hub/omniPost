/**
 * API 直连客户端（对标"文章同步助手"的静默发布机制）。
 *
 * 核心思路：在 background 中直接用 fetch 携带用户 cookie 调用平台私有 API，
 * 通过 declarativeNetRequest 动态注入 Origin/Referer/x-requested-with 等头部，
 * 从而"零页面"完成建草稿/传图/发布——不再打开平台编辑页 DOM 模拟。
 *
 * 安全边界：
 * - 所有 header 规则用 initiatorDomains: [chrome.runtime.id] 限定只影响扩展自身请求；
 * - 规则用完即删（finally 清理），不残留全局改头；
 * - 请求统一 30s 超时，AbortController 兜底。
 */

const DEFAULT_FETCH_TIMEOUT = 30 * 1000;

/**
 * G3 指纹一致性：统一请求头，避免同一账号在不同请求间指纹漂移。
 * 三原则（详见 docs/G1G4.md）：不主动改变指纹、请求头一致、固定环境复用。
 * Accept-Language 用浏览器 UI 语言（chrome.i18n.getUILanguage），稳定且与浏览器一致。
 */
function buildCommonHeaders(extra: HeadersInit | undefined): HeadersInit {
  const lang = (() => {
    try { return chrome.i18n.getUILanguage(); } catch { return 'zh-CN'; }
  })();
  const common: Record<string, string> = { 'Accept-Language': lang };
  if (!extra) return common;
  if (extra instanceof Headers) {
    const h = new Headers(extra);
    if (!h.has('Accept-Language')) h.set('Accept-Language', lang);
    return h;
  }
  if (Array.isArray(extra)) {
    const has = extra.some(([k]) => k.toLowerCase() === 'accept-language');
    return has ? extra : [...extra, ['Accept-Language', lang]];
  }
  return { ...(extra as Record<string, string>), ...common };
}

/** 带 cookie + 超时的 fetch（扩展 Service Worker 环境） */
export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT);
  try {
    return await fetch(url, {
      ...options,
      headers: buildCommonHeaders(options.headers),
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(`请求超时（${DEFAULT_FETCH_TIMEOUT / 1000}秒）: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 动态 header 规则（declarativeNetRequest，仅作用于扩展自身请求） */
// declarativeNetRequest 规则 ID 必须是严格 >= 1 的正整数
let ruleIdBase = (Date.now() % 100000) + 1;
let ruleIdCounter = 0;

export interface HeaderRule {
  urlFilter: string;
  headers: Record<string, string>;
  resourceTypes?: chrome.declarativeNetRequest.ResourceType[];
}

async function addHeaderRule(rule: HeaderRule): Promise<number> {
  const id = ruleIdBase + (ruleIdCounter++ % 50000);
  const resourceTypes: chrome.declarativeNetRequest.ResourceType[] =
    rule.resourceTypes ||
    (['xmlhttprequest'] as chrome.declarativeNetRequest.ResourceType[]);
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: Object.entries(rule.headers).map(([header, value]) => ({
            header,
            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
            value,
          })),
        },
        condition: {
          urlFilter: rule.urlFilter,
          // 只对扩展自身发起的请求生效，不影响用户浏览其他网页
          initiatorDomains: [chrome.runtime.id],
          resourceTypes,
        },
      },
    ],
  });
  return id;
}

/** 清理历史所有残留的动态规则（Service Worker 启动初始化时调用，防止配额泄漏） */
export async function clearAllDynamicRules(): Promise<void> {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules?.();
    if (rules && rules.length > 0) {
      const removeRuleIds = rules.map((r) => r.id);
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    }
  } catch {
    /* ignore */
  }
}

/** 在指定 header 规则生效期间执行 fn，执行完毕（无论成败）即清理规则 */
export async function withHeaderRules<T>(
  rules: HeaderRule[],
  fn: () => Promise<T>,
): Promise<T> {
  const added: number[] = [];
  try {
    for (const rule of rules) {
      added.push(await addHeaderRule(rule));
    }
    return await fn();
  } finally {
    if (added.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: added }).catch(() => {});
    }
  }
}

/** 读取指定域的 cookie 值（便捷方法） */
export async function getCookie(domain: string, name: string): Promise<string | null> {
  try {
    const cookies = await chrome.cookies.getAll({ domain, name });
    return cookies.length > 0 ? cookies[0].value : null;
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** G4 拟人化节奏：随机延迟 [min, max]，避免"机器人固定间隔"特征 */
export function humanDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(min + Math.random() * (max - min));
  return sleep(ms);
}

/** G2 cookie 健康：读指定域 cookie 的剩余有效期（天），无 cookie 返回 null */
export async function getCookieHealth(domain: string, name: string): Promise<{ remainingDays: number; expiresAt: number; value: string } | null> {
  try {
    const cookies = await chrome.cookies.getAll({ domain, name });
    const c = cookies[0];
    if (!c) return null;
    const expiresAt = c.expirationDate ?? Infinity;
    const remainingDays = expiresAt === Infinity ? Infinity : (expiresAt - Date.now() / 1000) / 86400;
    return { remainingDays, expiresAt, value: c.value };
  } catch {
    return null;
  }
}

/** 解析 JSON 响应，非 JSON 时给出可读错误 */
export async function parseJson<T>(res: Response, ctx: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${ctx}：响应不是有效 JSON（HTTP ${res.status}）— ${text.slice(0, 120)}`);
  }
}
