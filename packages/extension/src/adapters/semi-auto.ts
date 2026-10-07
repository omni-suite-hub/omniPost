/**
 * 通用「半自动」adapter 工厂。
 *
 * 背景：简书/网易号/抖音图文/大鱼号/一点号/什么值得买/搜狐焦点等平台，
 * 均无公开 API（发布端点是逆向的内部接口，参考插件 Wechatsync 的实现也在私有 submodule 不开源）。
 * 在拿到真实账号 F12 抓包的准确端点之前，先用「半自动」骨架兜底：
 *   - checkLogin 恒返回 loggedIn:true（浏览器跳转时自己判断登录态，不被 B1 预检剔除）
 *   - createDraft 返回占位草稿，url=平台发布页入口
 *   - publish 返回 draftOnly=true，popup「打开草稿」按钮跳到发布页 + 剪贴板已复制标题正文
 * 这样平台可出现在列表、半自动可用（用户手动粘贴发布），后续可逐个逆向补 API。
 */
import { PlatformAdapter, Article, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { pubResult } from './api-base';
import { previewOf, ensureEditorTab, sendToTab } from './utils';
import { markdownToPlainText } from './markdown-utils';

export interface SemiAutoOpts {
  id: string;
  name: string;
  region: 'domestic' | 'international';
  contentTypes: ('article' | 'text' | 'image')[];
  stylePrompt: string;
  /** 登录/主页入口 */
  homepage: string;
  /** 发布页入口（「打开草稿」按钮跳转目标） */
  publishUrl: string;
  /** 用于探测登录态的 Cookie 域名列表（例如 ['jianshu.com', '.jianshu.com']） */
  cookieDomains?: string[];
  /** 用于识别登录态的关键 Cookie 名称 */
  sessionCookieNames?: string[];
  /** 标签页匹配 pattern（例如 '*://*.jianshu.com/*'） */
  tabPattern?: string;
  /** 存储用户昵称/账号名的关键 Cookie 名（可选） */
  accountCookieName?: string;
}

interface SemiAutoDetectionConfig {
  domains: string[];
  sessionCookieNames: string[];
  tabPattern?: string;
  accountCookieName?: string;
}

const DEFAULT_DETECTION_CONFIGS: Record<string, SemiAutoDetectionConfig> = {
  jianshu: {
    domains: ['jianshu.com', '.jianshu.com'],
    sessionCookieNames: ['remember_user_token', 'user_token'],
    tabPattern: '*://*.jianshu.com/*',
  },
  netease: {
    domains: ['163.com', '.163.com', 'mp.163.com', '.mp.163.com'],
    sessionCookieNames: ['P_INFO', 'S_INFO', 'NTES_SESS'],
    tabPattern: '*://mp.163.com/*',
    accountCookieName: 'P_INFO',
  },
  douyin: {
    domains: ['douyin.com', '.douyin.com', 'creator.douyin.com', '.creator.douyin.com'],
    sessionCookieNames: ['sessionid', 'sessionid_ss'],
    tabPattern: '*://creator.douyin.com/*',
  },
  dayu: {
    domains: ['dayu.com', '.dayu.com', 'mp.dayu.com', '.mp.dayu.com'],
    sessionCookieNames: ['mp_token', 'ali_apache_track', 'session'],
    tabPattern: '*://mp.dayu.com/*',
  },
  yidian: {
    domains: ['yidianzixun.com', '.yidianzixun.com', 'mp.yidianzixun.com', '.mp.yidianzixun.com'],
    sessionCookieNames: ['JSESSIONID', 'userId', 'userName'],
    tabPattern: '*://mp.yidianzixun.com/*',
    accountCookieName: 'userName',
  },
  smzdm: {
    domains: ['smzdm.com', '.smzdm.com', 'post.smzdm.com', '.post.smzdm.com'],
    sessionCookieNames: ['sess', 'smzdm_id', 'user'],
    tabPattern: '*://*.smzdm.com/*',
    accountCookieName: 'smzdm_id',
  },
  sohufocus: {
    domains: ['focus.cn', '.focus.cn', 'sohu.com', '.sohu.com'],
    sessionCookieNames: ['focus_user', 'passport', 'ppinf', 'IPLOC'],
    tabPattern: '*://mp.focus.cn/*',
  },
};

export function makeSemiAutoAdapter(opts: SemiAutoOpts): PlatformAdapter {
  const defConfig = DEFAULT_DETECTION_CONFIGS[opts.id];
  const cookieDomains = opts.cookieDomains || defConfig?.domains || [];
  const sessionCookieNames = opts.sessionCookieNames || defConfig?.sessionCookieNames || [];
  const tabPattern = opts.tabPattern || defConfig?.tabPattern;
  const accountCookieName = opts.accountCookieName || defConfig?.accountCookieName;

  return {
    id: opts.id as PlatformAdapter['id'],
    name: opts.name,
    region: opts.region,
    contentTypes: opts.contentTypes,
    route: 'session',
    stylePrompt: opts.stylePrompt,
    mode: 'session',
    homepage: opts.homepage,
    capabilities: ['draft'],
    semiAuto: true,

    async checkLogin(): Promise<PlatformAccount> {
      try {
        // 1. 优先从已打开的创作者/后台标签页获取真实登录态与昵称
        if (typeof chrome !== 'undefined' && chrome.tabs?.query && tabPattern) {
          try {
            const tabs = await chrome.tabs.query({ url: tabPattern });
            if (tabs.length > 0 && tabs[0].id) {
              const results = await chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                func: () => {
                  const hasLoginForm = !!document.querySelector('input[type="password"], input[placeholder*="密码"], input[placeholder*="验证码"]');
                  const userEl = document.querySelector('.user-name, .user-nick, .user-info, .account-name, .header-user, [class*="userName"], [class*="avatar"], .user, .avatar, a[href^="/u/"]');
                  const text = userEl?.textContent?.trim() || '';
                  return {
                    loggedIn: !hasLoginForm && (!!text || !!userEl),
                    account: text || undefined,
                  };
                },
              });
              if (results?.[0]?.result?.loggedIn) {
                const acct = results[0].result.account || `${opts.name}用户`;
                return {
                  loggedIn: true,
                  account: acct,
                  username: acct,
                };
              }
            }
          } catch {
            /* ignore tab query/scripting error */
          }
        }

        // 2. Cookie 探查：检查浏览器中该平台的关键 Session Cookie
        if (typeof chrome !== 'undefined' && chrome.cookies?.getAll && cookieDomains.length > 0) {
          try {
            const cookiePromises = cookieDomains.map((domain) =>
              chrome.cookies.getAll({ domain }).catch(() => [] as chrome.cookies.Cookie[])
            );
            const timeoutPromise = new Promise<chrome.cookies.Cookie[][]>((resolve) =>
              setTimeout(() => resolve([]), 1500)
            );
            const lists = await Promise.race([Promise.all(cookiePromises), timeoutPromise]);
            const cookies = lists.flat();

            const sessionCookie = cookies.find((c) =>
              sessionCookieNames.some((name) => c.name.toLowerCase() === name.toLowerCase()) && !!c.value
            );

            if (sessionCookie) {
              let accountName = `${opts.name}用户`;
              if (accountCookieName) {
                const accCookie = cookies.find((c) => c.name.toLowerCase() === accountCookieName.toLowerCase() && !!c.value);
                if (accCookie?.value) {
                  try {
                    const raw = decodeURIComponent(accCookie.value);
                    const userPart = raw.split('|')[0] || raw;
                    if (userPart && userPart.length <= 40) {
                      accountName = userPart;
                    }
                  } catch {}
                }
              }
              return {
                loggedIn: true,
                account: accountName,
                username: accountName,
              };
            }
          } catch {
            /* ignore cookie error */
          }
        }

        return { loggedIn: false };
      } catch {
        return { loggedIn: false };
      }
    },

    async createDraft(article: Article): Promise<DraftRef> {
      let draftTabId: number | undefined;

      // 针对具备专用 Content Script 的半自动平台（如抖音图文），自动打开创作者页面并填入草稿
      if (opts.id === 'douyin' && tabPattern) {
        // 1. 存入 storage 待填充记录（供页面主动挂载时兜底读取）
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          await chrome.storage.local.set({
            douyin_draft_pending: {
              title: article.title,
              body: article.body,
              timestamp: Date.now(),
            },
          }).catch(() => {});
        }

        // 2. 确保创作者后台打开并激活
        if (typeof chrome !== 'undefined' && chrome.tabs) {
          const tab = await ensureEditorTab(tabPattern, opts.publishUrl, { active: true });
          draftTabId = tab.id;

          if (tab.id) {
            // 抖音字数硬性规则：标题 <= 20，描述 <= 1000，纯文本无 Markdown 符号
            const cleanTitle = article.title
              ? markdownToPlainText(article.title).replace(/^[【\[](.*?)[】\]]$/, '$1').trim().slice(0, 20)
              : '';
            const cleanBody = markdownToPlainText(article.body || '').slice(0, 1000);

            // 若有配图，先尝试上传配图（媒体失败不阻塞：图文也可后补，正文注入失败才判失败）
            if (article.media && article.media.length > 0) {
              await sendToTab(tab.id, {
                type: 'DOUYIN_INJECT_MEDIA',
                payload: { media: article.media.map((m) => ({ name: m.id || 'image.png', type: m.type, dataUrl: m.dataUrl })) },
              }, 10000).catch((e) => {
                console.warn('[OmniPost] 抖音媒体注入失败（不阻塞正文）:', e?.message);
              });
            }

            // 注入标题与描述到抖音草稿输入框——失败必须上抛，绝不能静默假成功
            const draftRes = await sendToTab<{ ok: boolean; error?: string }>(tab.id, {
              type: 'DOUYIN_INJECT_DRAFT',
              payload: { title: cleanTitle, body: cleanBody },
            }, 15000);
            if (!draftRes?.ok) {
              throw new Error(draftRes?.error || '抖音内容注入失败（页面未确认填入）');
            }
          }
        }
      }

      return {
        platformId: opts.id as DraftRef['platformId'],
        draftId: opts.id + '_manual_' + Date.now(),
        title: article.title ? (opts.id === 'douyin' ? article.title.slice(0, 20) : article.title) : opts.name + '草稿',
        url: opts.publishUrl,
        previewText: previewOf(article.body),
        body: article.body,
        tabId: draftTabId,
        createdAt: Date.now(),
      };
    },

    async publish(_draft: DraftRef): Promise<PublishResult> {
      // manualOnly：平台侧没有任何真实草稿（仅douyin注入了页面，其余平台需用户打开后手动粘贴），
      // UI 必须显示「待粘贴发布」而不是「已存草稿」，杜绝假成功
      return pubResult(opts.id as PublishResult['platformId'], true, { url: opts.publishUrl, draftOnly: true, manualOnly: true });
    },
  };
}
