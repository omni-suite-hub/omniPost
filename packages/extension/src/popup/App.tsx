import React, { useState, useEffect, useRef } from 'react';
import { Article, DraftRef, MediaItem, PlatformAccount, PlatformId, PublishHistoryRecord, PublishProgress, PublishResult } from '@omnipost/core';
import { store, PlatformSettings, AiSettings, AccountEntry } from '../store';
// Markdown 排版渲染统一由 PreviewModal 承载 (renderMarkdown)
import { readDocxText } from '../adapters/docx-reader';
import { AI_PROVIDERS, generateArticle, getProvider } from '../adapters/ai-client';
import { md2html } from '../adapters/md2html';
import { markdownToPlainText, getPlatformFormat } from '../adapters/markdown-utils';
import { OmniPostLogo } from '../components/OmniPostLogo';
import { PreviewModal } from '../components/PreviewModal';
import { t, Lang } from '../lib/i18n';

interface PlatformInfo {
  id: PlatformId;
  name: string;
  region: 'domestic' | 'international';
  tags: string[];
  loginUrl: string;
  route: 'session' | 'official';
  color: string;        // 品牌主色（深色主题下用于高亮点缀）
  group: 'main' | 'vertical' | 'intl' | 'cms' | 'local'; // 平台分组（对标"文章同步助手"平台列表分区）
  /** 半自动模式：checkLogin 即使未登录也允许勾选（橙色徽章区分"已登录"绿色） */
  semiAuto?: boolean;
}

const PLATFORMS: PlatformInfo[] = [
  // —— 国内主流 ——
  { id: 'weibo', name: '微博', region: 'domestic', tags: ['文', '图', '视'], loginUrl: 'https://weibo.com', route: 'session', color: '#E6162D', group: 'main' },
  { id: 'xiaohongshu', name: '小红书', region: 'domestic', tags: ['图', '视', '文'], loginUrl: 'https://creator.xiaohongshu.com', route: 'session', color: '#FF2442', group: 'main' },
  { id: 'bilibili', name: '哔哩哔哩', region: 'domestic', tags: ['视', '图', '文'], loginUrl: 'https://t.bilibili.com', route: 'session', color: '#00AEEC', group: 'main' },
  { id: 'zhihu', name: '知乎', region: 'domestic', tags: ['文', '专栏', '图'], loginUrl: 'https://zhuanlan.zhihu.com/write', route: 'session', color: '#0084FF', group: 'main' },
  { id: 'juejin', name: '掘金', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://juejin.cn/', route: 'session', color: '#1E80FF', group: 'main' },
  { id: 'csdn', name: 'CSDN', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://blog.csdn.net/', route: 'session', color: '#FC5531', group: 'main' },
  { id: 'yuque', name: '语雀', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://www.yuque.com/dashboard', route: 'session', color: '#31CC79', group: 'main' },
  { id: 'segmentfault', name: '思否', region: 'domestic', tags: ['文'], loginUrl: 'https://segmentfault.com/', route: 'session', color: '#009A61', group: 'main' },
  { id: 'cnblogs', name: '博客园', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://i.cnblogs.com/', route: 'session', color: '#0E74DA', group: 'main' },
  { id: 'oschina', name: '开源中国', region: 'domestic', tags: ['文'], loginUrl: 'https://www.oschina.net/', route: 'session', color: '#239637', group: 'main' },
  { id: 'douban', name: '豆瓣', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://www.douban.com/note/create', route: 'session', color: '#2E963D', group: 'main' },
  { id: 'sohu', name: '搜狐号', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://mp.sohu.com/', route: 'session', color: '#E60012', group: 'main' },
  { id: 'toutiao', name: '今日头条', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://mp.toutiao.com/', route: 'session', color: '#FE2C55', group: 'main' },
  { id: 'jianshu', name: '简书', region: 'domestic', tags: ['文'], loginUrl: 'https://www.jianshu.com/', route: 'session', color: '#EA6F5A', group: 'main', semiAuto: true },
  { id: 'netease', name: '网易号', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://mp.163.com/', route: 'session', color: '#E62E2E', group: 'main', semiAuto: true },
  { id: 'douyin', name: '抖音图文', region: 'domestic', tags: ['图文', '视'], loginUrl: 'https://creator.douyin.com/', route: 'session', color: '#161823', group: 'main', semiAuto: true },
  { id: 'dayu', name: '大鱼号', region: 'domestic', tags: ['文'], loginUrl: 'https://mp.dayu.com/', route: 'session', color: '#FF5000', group: 'main', semiAuto: true },
  { id: 'yidian', name: '一点号', region: 'domestic', tags: ['文'], loginUrl: 'https://mp.yidianzixun.com/', route: 'session', color: '#0084FF', group: 'main', semiAuto: true },
  { id: 'smzdm', name: '什么值得买', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://www.smzdm.com/', route: 'session', color: '#F04848', group: 'main', semiAuto: true },
  { id: 'sohufocus', name: '搜狐焦点', region: 'domestic', tags: ['文'], loginUrl: 'https://mp.focus.cn/', route: 'session', color: '#C81414', group: 'main', semiAuto: true },
  // —— 垂直平台 ——
  { id: 'baijiahao', name: '百家号', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://baijiahao.baidu.com/', route: 'session', color: '#306EFF', group: 'vertical' },
  { id: 'eastmoney', name: '东方财富', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://mp.eastmoney.com/', route: 'session', color: '#B92B27', group: 'vertical' },
  { id: 'xueqiu', name: '雪球', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://mp.xueqiu.com/', route: 'session', color: '#1B77D2', group: 'vertical' },
  { id: 'weixin', name: '微信公众号', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://mp.weixin.qq.com/', route: 'session', color: '#07C160', group: 'vertical' },
  { id: 'woshipm', name: '人人都是产品经理', region: 'domestic', tags: ['文'], loginUrl: 'https://www.woshipm.com/writing', route: 'session', color: '#F28C28', group: 'vertical' },
  { id: 'cto51', name: '51CTO', region: 'domestic', tags: ['文', '图'], loginUrl: 'https://blog.51cto.com/', route: 'session', color: '#CC0000', group: 'vertical' },
  { id: 'imooc', name: '慕课手记', region: 'domestic', tags: ['文'], loginUrl: 'https://www.imooc.com/', route: 'session', color: '#F01414', group: 'vertical' },
  // —— 国际平台 ——
  { id: 'twitter', name: 'X / Twitter', region: 'international', tags: ['推文', '图', '视'], loginUrl: 'https://x.com', route: 'session', color: '#1DA1F2', group: 'intl' },
  { id: 'youtube', name: 'YouTube', region: 'international', tags: ['视频', 'Shorts'], loginUrl: '', route: 'official', color: '#FF0000', group: 'intl' },
  { id: 'telegram', name: 'Telegram', region: 'international', tags: ['频道', '消息', '图'], loginUrl: '', route: 'official', color: '#229ED9', group: 'intl' },
  { id: 'bluesky', name: 'Bluesky', region: 'international', tags: ['帖子', '图'], loginUrl: '', route: 'official', color: '#0085FF', group: 'intl' },
  { id: 'mastodon', name: 'Mastodon', region: 'international', tags: ['帖子', '图'], loginUrl: '', route: 'official', color: '#6364FF', group: 'intl' },
  { id: 'reddit', name: 'Reddit', region: 'international', tags: ['帖子', '文本'], loginUrl: '', route: 'official', color: '#FF4500', group: 'intl' },
  { id: 'devto', name: 'Dev.to', region: 'international', tags: ['长文', '技术'], loginUrl: '', route: 'official', color: '#000000', group: 'intl' },
  { id: 'hashnode', name: 'Hashnode', region: 'international', tags: ['长文', '技术'], loginUrl: '', route: 'official', color: '#2962FF', group: 'intl' },
  // —— CMS 自建站 ——
  { id: 'wordpress', name: 'WordPress', region: 'domestic', tags: ['长文', '图', 'CMS'], loginUrl: '', route: 'official', color: '#21759B', group: 'cms' },
  { id: 'typecho', name: 'Typecho', region: 'domestic', tags: ['博客', 'CMS'], loginUrl: '', route: 'official', color: '#467B96', group: 'cms' },
  { id: 'metaweblog', name: 'MetaWeblog', region: 'domestic', tags: ['博客', 'CMS'], loginUrl: '', route: 'official', color: '#6B7280', group: 'cms' },
  // —— 本地导出 ——
  { id: 'zip-download', name: 'Markdown 压缩包', region: 'domestic', tags: ['导出', 'ZIP'], loginUrl: '', route: 'session', color: '#7C8DB0', group: 'local' },
];

const PLATFORM_GROUPS: { key: PlatformInfo['group']; label: string }[] = [
  { key: 'main', label: '国内主流' },
  { key: 'vertical', label: '垂直平台' },
  { key: 'intl', label: '国际平台' },
  { key: 'cms', label: 'CMS 自建站' },
  { key: 'local', label: '本地导出' },
];

const MAX_MEDIA_MB = 15;           // 单文件硬上限（dataUrl 经 runtime message 传递，base64 膨胀 ~1.37x，15MB 是安全值）
const MAX_VIDEO_MB = 15;           // 视频建议上限（超过则警告）

/** AI 各厂商的 API Key 申请入口（2026-09 核实） */
const AI_KEY_URLS: Record<string, string> = {
  deepseek: 'https://platform.deepseek.com/api_keys',
  openai: 'https://platform.openai.com/api-keys',
  qwen: 'https://bailian.console.aliyun.com/#/home',
  kimi: 'https://platform.moonshot.cn/console/api-keys',
  glm: 'https://open.bigmodel.cn/usercenter/apikeys',
  custom: '',
};

/**
 * 凭证「去哪申请」跳转链接：纵向两行——灰色说明 + 可点击链接（可换行不溢出），
 * 点击在新标签打开对应平台的申请/配置页（chrome.tabs.create 无需额外权限）。
 * text 需传入已翻译文案（调用处用 _()）。
 */
function CredLink({ text, url, note }: { text: string; url?: string; note?: string }) {
  return (
    <div className="min-w-0 space-y-0.5 text-[10px] leading-relaxed">
      {note && <div className="text-gray-500">{note}</div>}
      {url ? (
        <button
          type="button"
          onClick={() => chrome.tabs.create({ url })}
          className="text-sky-400 hover:text-sky-300 inline-flex items-start gap-1 text-left min-w-0"
        >
          <span aria-hidden className="flex-shrink-0">🔗</span>
          <span className="underline underline-offset-2 break-all">{text}</span>
        </button>
      ) : (
        text && <div className="text-gray-500 break-all">{text}</div>
      )}
    </div>
  );
}

/**
 * 「测试连接」按钮 + 即时状态一行排：默认不显示状态（不再常驻「未验证」灰字），
 * 点击后才出现 检测中/✅/❌。testConnection 内部会先自动保存设置，按钮无需再注明。
 */
function TestConn({ label, cls, disabled, onClick, status }: { label: string; cls: string; disabled: boolean; onClick: () => void; status?: string }) {
  const color = status?.startsWith('✅') ? 'text-green-400' : status?.startsWith('❌') ? 'text-red-400' : 'text-gray-400';
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`px-2.5 py-1 rounded text-[11px] border disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap transition ${cls}`}
      >{label}</button>
      {status && <span className={`text-[10px] ${color}`}>{status}</span>}
    </div>
  );
}

export default function App() {
  // 语言：必须在 mount 时异步从 chrome.storage 读取，否则相同 popup 进程里再次打开会拿到陈旧的 detectBrowserLang 结果
  const [lang, setLang] = useState<Lang | null>(null);
  /**
   * _() 必须读 ref 而不是闭包里的 lang：
   * mount 时 refreshAuth() 等异步回调是在 lang 尚未加载（null）时创建的闭包，
   * 这些闭包后续再调用 _() 时若读闭包变量会永远拿到 null → 英文界面却渲染中文。
   * 用 ref 可保证"调用时"取到的是最新语言。
   */
  const langRef = useRef<Lang | null>(null);
  const applyLang = (l: Lang) => { langRef.current = l; setLang(l); };
  const _ = (zh: string) => (langRef.current === null ? zh : t(zh, langRef.current));
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mediaList, setMediaList] = useState<MediaItem[]>([]);
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<PlatformId>>(new Set());
  const [authMap, setAuthMap] = useState<Record<string, PlatformAccount>>({});
  const [progressMap, setProgressMap] = useState<Record<string, PublishProgress>>({});
  const [isProcessing, setIsProcessing] = useState(false);

  // Modals
  const [activeDrafts, setActiveDrafts] = useState<DraftRef[]>([]);
  const [showResultsModal, setShowResultsModal] = useState(false);
  const [skippedPlatforms, setSkippedPlatforms] = useState<{ id: PlatformId; name: string; reason: 'notLoggedIn' }[]>([]);
  const [publishResults, setPublishResults] = useState<PublishResult[]>([]);
  // 非致命告警（AI 适配失败回退原文等）：回执弹窗顶部 banner 展示
  const [publishWarnings, setPublishWarnings] = useState<Record<string, string>>({});
  /** 长任务中与后台失联时的横幅提示：非空说明回执不完整，是按后台落盘的最后进度还原的 */
  const [runInterrupted, setRunInterrupted] = useState('');
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settings, setSettings] = useState<PlatformSettings>({});
  const [bridgeToken, setBridgeToken] = useState('');
  const [toast, setToast] = useState('');

  /**
   * lang=null 时收到的 toast 入队（不预求值），等 lang 就绪再 flush 时用最新 _() 翻译。
   *
   * 支持传「翻译函数」：拼接型文案（如 `已导入 xxx.png (1.2 KB)`）整体不是 EN_MAP 的 key，
   * 若直接传拼接后的字符串，_() 查不到就会回退中文（英文界面漏中文）。
   * 传 () => `${_('已导入 ')}...` 可保证各片段分别翻译、拼接后再显示。
   */
  const toastQueueRef = useRef<Array<string | (() => string)>>([]);
  const safeToast = (msg: string | (() => string)) => {
    if (lang !== null) setToast(typeof msg === 'function' ? msg() : _(msg));
    else toastQueueRef.current.push(msg);
  };
  useEffect(() => {
    if (lang !== null && toastQueueRef.current.length > 0) {
      const pending = toastQueueRef.current;
      toastQueueRef.current = [];
      const last = pending[pending.length - 1];
      setToast(typeof last === 'function' ? last() : _(last));
    }
  }, [lang]);

  /**
   * 将草稿内容同时以 text/html（富文本）与 text/plain（纯文本）写入剪贴板。
   * 当用户在新打开的草稿页面 Ctrl+V 粘贴时：
   *  - 富文本编辑器（微信公众号、头条号、简书、网易号、大鱼号、知乎等）会自动拾取 text/html，呈现原生大标题、加粗、列表与引用；
   *  - 纯文本或 Markdown 编辑器则拾取对应的干净纯文本。
   * 注意：API 平台（知乎/微博/公众号等）的 draft.body 已是转换后的 HTML，直接复用，
   *  绝不能再当 Markdown 走一遍 md2html（会把 HTML 标签转义成可见文本，剪贴板内容错乱）。
   */
  const copyDraftForPlatform = async (rawTitle: string, rawBody: string, platformId: PlatformId) => {
    const t = (rawTitle || '').trim();
    const b = (rawBody || '').trim();
    if (!t && !b) return;

    const format = getPlatformFormat(platformId);
    let plainText = '';
    let htmlText = '';

    // 判断 body 是否已是 HTML（API 平台 draft.body 存的是转换后的 HTML）
    const looksLikeHtml = /<\/?(p|div|h[1-6]|figure|section|blockquote|ul|ol|li|img|table|pre|span)[^>]*>/i.test(b);

    if (platformId === 'douyin') {
      // 抖音图文字数限制：标题 <= 20，作品描述 <= 1000
      const cleanTitle = t ? markdownToPlainText(t).replace(/^[【\[](.*?)[】\]]$/, '$1').trim().slice(0, 20) : '';
      const cleanBody = markdownToPlainText(b).slice(0, 1000);
      plainText = cleanTitle ? `${cleanTitle}\n\n${cleanBody}` : cleanBody;
      htmlText = cleanTitle ? `<p><strong>${cleanTitle}</strong></p><p>${cleanBody.replace(/\n/g, '<br/>')}</p>` : `<p>${cleanBody.replace(/\n/g, '<br/>')}</p>`;
    } else if (looksLikeHtml) {
      // 已是 HTML（来自 API 平台草稿）：html 通道原样用，纯文本通道剥离标签
      const stripped = b
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      plainText = t ? `${t}\n\n${stripped}` : stripped;
      htmlText = (t ? `<p><strong>${t}</strong></p>` : '') + b;
    } else {
      const fullMarkdown = t ? `# ${t}\n\n${b}` : b;
      plainText = format === 'markdown' ? fullMarkdown : markdownToPlainText(fullMarkdown);
      htmlText = md2html(fullMarkdown);
    }

    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const item = new ClipboardItem({
          'text/html': new Blob([htmlText], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        });
        await navigator.clipboard.write([item]);
        safeToast(_('标题与正文已复制，去新页面 Ctrl+V 粘贴'));
        return;
      }
    } catch (e) {
      console.warn('[OmniPost] ClipboardItem write failed, fallback to writeText:', e);
    }

    try {
      await navigator.clipboard.writeText(plainText);
      safeToast(_('标题与正文已复制，去新页面 Ctrl+V 粘贴'));
    } catch { /* ignore */ }
  };

  // UI 优化：真实排版预览弹窗 / 历史 / 拖拽 / YouTube 授权
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [history, setHistory] = useState<PublishHistoryRecord[]>([]);
  // P3：内容库检索关键字
  const [historyKeyword, setHistoryKeyword] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [ytStatus, setYtStatus] = useState<string>('');
  // CMS 测试连接状态（Typecho / MetaWeblog / WordPress 凭证有效性即时反馈）
  const [connStatus, setConnStatus] = useState<Record<string, string>>({});
  // 从当前页提取正文的进行中标记
  const [extracting, setExtracting] = useState(false);
  // 是否隐藏网页悬浮同步按钮（设置面板开关）
  const [hideFab, setHideFab] = useState(false);
  const [publishMode, setPublishMode] = useState<'auto' | 'semi'>('auto');
  // 内容来源 Tab：'ai'=AI 生成 | 'manual'=手动/提取/上传
  const [sourceTab, setSourceTab] = useState<'ai' | 'manual'>('manual');
  // AI 生成状态
  const [aiSettings, setAiSettings] = useState<AiSettings>({ provider: 'deepseek', apiKey: '', model: 'deepseek-v4-flash', baseUrl: '' });
  const [aiPrompt, setAiPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  // P0：AI 适配各平台风格开关
  const [aiRewrite, setAiRewrite] = useState(false);
  // P2：多账号矩阵
  const [accountPlatform, setAccountPlatform] = useState<PlatformId>('wordpress');
  const [accountsOfPlatform, setAccountsOfPlatform] = useState<AccountEntry[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [newAccountName, setNewAccountName] = useState('');
  // 平台列表：按分组独立展开未登录平台（每个分组的展开/收起互不影响）
  const [expandedLoggedOutGroups, setExpandedLoggedOutGroups] = useState<Set<string>>(new Set());
  const toggleLoggedOutGroup = (key: string) => {
    setExpandedLoggedOutGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 顶部提示条：3s 后自动消失
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => safeToast(''), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Refresh login status：点击后转圈 + 完成后 toast 反馈（N / 29 已登录）
  const [refreshing, setRefreshing] = useState(false);
  const refreshAuth = () => {
    if (refreshing) return;
    setRefreshing(true);
    // 平台数会随版本增加，不能写死（曾写死 29，实际 39，文案与事实不符）
    safeToast(() => `${_('正在刷新')} ${PLATFORMS.length} ${_('个平台登录态...')}`);
    let done = false;
    const finish = (fn: () => void) => { if (!done) { done = true; fn(); } };
    // 兜底：即使 background 异常未回调，45s 后也强制结束转圈，避免 icon 永久旋转
    const watchdog = setTimeout(() => finish(() => { setRefreshing(false); safeToast(_('刷新超时')); }), 45000);
    chrome.runtime.sendMessage({ type: 'CHECK_ALL_LOGIN' }, (res) => {
      clearTimeout(watchdog);
      finish(() => {
        setRefreshing(false);
        if (res && typeof res === 'object') {
          setAuthMap(res);
          // 清理 selectedPlatforms：移除未登录的平台，避免"UI 置灰但 set 里还在"导致底部计数与视觉不一致
          setSelectedPlatforms(prev => {
            const next = new Set<PlatformId>();
            for (const id of prev) {
              if (res[id]?.loggedIn) next.add(id);
            }
            // 若刷新前 set 为空（首次打开），自动勾选所有已登录的，给合理默认
            if (prev.size === 0) {
              for (const [id, a] of Object.entries(res)) {
                if ((a as any)?.loggedIn) next.add(id as PlatformId);
              }
            }
            return next;
          });
          const total = Object.keys(res).length;
          const loggedIn = Object.values(res).filter((a: any) => a?.loggedIn).length;
          safeToast(() => `${loggedIn}/${total} ${_('已登录')}`);
        } else {
          safeToast(_('刷新失败'));
        }
      });
    });
  };

  const refreshHistory = () => {
    store.getHistory().then(setHistory);
  };

  // 从当前活动标签页提取正文（对标"文章同步助手"的网页转 Markdown）
  const handleExtract = () => {
    if (extracting) return;
    setExtracting(true);
    chrome.runtime.sendMessage({ type: 'EXTRACT_ARTICLE', payload: {} }, (res) => {
      setExtracting(false);
      if (res?.ok && res.article) {
        setTitle(res.article.title || '');
        setBody(res.article.markdown || '');
        safeToast(res.article.cover ? _('已提取正文与封面（封面图可在发布时自动上传）') : _('已从当前页提取正文'));
      } else {
        safeToast(res?.error || _('提取失败：请先打开文章页面'));
      }
    });
  };

  // AI 一键生成文案：调 OpenAI 兼容客户端生成标题 + Markdown 正文，填入后切回编辑视图
  const handleGenerate = async () => {
    if (generating) return;
    const provider = getProvider(aiSettings.provider);
    const baseUrl = aiSettings.baseUrl || provider?.baseUrl || '';
    const model = aiSettings.model || provider?.defaultModel || '';
    if (!aiSettings.apiKey && provider?.requiresKey !== false) {
      safeToast(_('请先在设置面板配置 AI 的 API Key'));
      setShowSettingsModal(true);
      return;
    }
    if (!aiPrompt.trim()) {
      safeToast(_('请输入要生成的内容需求（主题 / 要点）'));
      return;
    }
    setGenerating(true);
    try {
      const r = await generateArticle({ baseUrl, apiKey: aiSettings.apiKey, model, prompt: aiPrompt });
      setTitle(r.title || '');
      setBody(r.body || '');
      setSourceTab('manual');
      safeToast(_('AI 已生成文案，可预览/编辑后一键发布'));
    } catch (e: any) {
      safeToast(e?.message || _('AI 生成失败'));
    } finally {
      setGenerating(false);
    }
  };


  // P2：多账号矩阵 helper
  const refreshAccounts = (pid: PlatformId) => {
    store.listAccounts(pid).then(setAccountsOfPlatform);
    store.getActiveAccountId(pid).then(setActiveAccountId);
  };
  const switchPlatformAccount = (pid: PlatformId, id: string | null) => {
    store.switchAccount(pid, id).then(() => {
      refreshAccounts(pid);
      refreshAuth();
      store.getSettings().then(setSettings);
      safeToast(id ? _('已切换账号') : _('已切回默认配置'));
    });
  };
  const addCurrentAsAccount = () => {
    const config = (settings as any)[accountPlatform];
    if (!config || !Object.values(config).some((v: any) => !!v)) { safeToast(_('请先填写该平台的凭证')); return; }
    const name = newAccountName.trim() || `${_('账号')} ${accountsOfPlatform.length + 1}`;
    store.addAccount(accountPlatform, name, config).then((id) => {
      store.switchAccount(accountPlatform, id).then(() => {
        setNewAccountName('');
        refreshAccounts(accountPlatform);
        refreshAuth();
        store.getSettings().then(setSettings);
        safeToast(_('已新增账号并切换'));
      });
    });
  };

  // 恢复上次会话：草稿、确认清单、进行中进度
  useEffect(() => {
    // popup 打开即清掉 fab 提取的 badge（fab 点击后 background 加的"已"提示）
    try { chrome.action?.setBadgeText?.({ text: '' }); } catch {}
    refreshAuth();
    store.getSettings().then(setSettings);
    store.getUiSettings().then((ui) => { setHideFab(!!ui.hideFab); setPublishMode(ui.publishMode); });
    store.getLang().then(applyLang);
    store.getAiSettings().then(setAiSettings);
    // ensureBridgeToken 幂等：已存在则复用，不存在则生成（否则 Bridge 永远无 token，window.syncPost 校验必失败）
    store.ensureBridgeToken().then(setBridgeToken);
    // 优先级控制：优先检查 fab 悬浮按钮提取的新文章；若无提取文章再回退恢复本地草稿，杜绝异步竞态覆写
    store.getExtractedArticle().then((extracted) => {
      if (extracted) {
        setTitle(extracted.title || '');
        setBody(extracted.markdown || '');
        store.saveExtractedArticle(null);
        safeToast(_('已从网页提取正文，确认后一键发布'));
      } else {
        store.getPendingArticle().then((article) => {
          if (article) {
            setTitle(article.title || '');
            setBody(article.body || '');
            // 持久化仅存媒体元数据（防 storage 配额超限），dataUrl 无法跨会话恢复，重开需重新添加
            const restorable = (article.media || []).filter((m) => m.dataUrl);
            setMediaList(restorable);
            if (article.media?.length && restorable.length === 0) {
              safeToast(_('已恢复草稿正文；媒体文件需重新添加'));
            }
          }
        });
      }
    });
    store.getPendingDrafts().then((drafts) => {
      if (drafts.length > 0) {
        // 一键静默发布模式下草稿即发，残留 pending 仅供失败重试
        setActiveDrafts(drafts);
        safeToast(() => `${_('检测到')} ${drafts.length} ${_('个未完成发布的草稿，可对失败平台重试')}`);
      }
    });
    refreshHistory();
    chrome.runtime.sendMessage({ type: 'GET_CURRENT_PROGRESS' }, (res) => {
      if (res?.progress) setProgressMap(res.progress);
    });

    const messageListener = (msg: any) => {
      if (msg.type === 'PROGRESS_UPDATE' && msg.payload) {
        const p = msg.payload as PublishProgress;
        setProgressMap(prev => ({ ...prev, [p.platformId]: p }));
        // done/failed 状态 6s 后自动从进度区淡出，避免 spinner 永转
        if (p.stage === 'done' || p.stage === 'failed') {
          setTimeout(() => {
            setProgressMap(prev => {
              const next = { ...prev };
              delete next[p.platformId];
              return next;
            });
          }, 6000);
        }
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);
    return () => chrome.runtime.onMessage.removeListener(messageListener);
  }, []);

  const togglePlatform = (id: PlatformId) => {
    const auth = authMap[id];
    if (auth && !auth.loggedIn) return; // 未登录平台置灰不可勾选
    setSelectedPlatforms(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = (select: boolean) => {
    if (select) {
      const enabled = PLATFORMS.filter(p => !authMap[p.id] || authMap[p.id].loggedIn).map(p => p.id);
      setSelectedPlatforms(new Set(enabled));
    } else {
      setSelectedPlatforms(new Set());
    }
  };

  /** 单个文件加入媒体列表（大小校验 + 读取为 dataUrl）。 */
  const addMediaFile = (file: File, index: number) => {
    if (file.size > MAX_MEDIA_MB * 1024 * 1024) {
      alert(`"${file.name}" ${_('超过')} ${MAX_MEDIA_MB}MB ${_('上限，已跳过（大文件上传将在后续版本通过后台分片支持）')}`);
      return;
    }
    if (file.type.startsWith('video/') && file.size > MAX_VIDEO_MB * 1024 * 1024) {
      if (!window.confirm(`"${file.name}" ${_('约')} ${(file.size / 1024 / 1024).toFixed(1)}MB${_('，视频较大可能上传较慢，仍要添加吗？')}`)) return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setMediaList(prev => [
        ...prev,
        {
          id: 'media_' + Date.now() + '_' + index,
          name: file.name,
          type: file.type,
          size: file.size,
          dataUrl: reader.result as string
        }
      ]);
    };
    reader.readAsDataURL(file);
  };

  const handleMediaUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    // 关键：e.target.files 是「活的 FileList」，一旦执行 e.target.value = ''
    // 该 FileList 会被立即清空（length → 0）。必须先快照为普通数组再重置 value，
    // 否则 addMediaFile 一次都不会被调用 —— 表现为「选了图片却毫无反应」。
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // 允许重复选择同一文件
    files.forEach((f, i) => addMediaFile(f, i));
  };

  // 拖拽上传：整块编辑器区域可投放
  const handleMediaDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;
    files.forEach((f, i) => addMediaFile(f, i));
  };

  // 一键清空：清空标题/正文/媒体，但保留平台勾选与设置（避免误清配置）
  const handleClear = () => {
    if (!title.trim() && !body.trim() && mediaList.length === 0) return;
    setTitle('');
    setBody('');
    setMediaList([]);
    store.savePendingArticle(null).then(() => safeToast(_('已清空')));
  };

  const handlePreviewModalSave = (newTitle: string, newBody: string, newMedia: MediaItem[]) => {
    setTitle(newTitle);
    setBody(newBody);
    setMediaList(newMedia);
    store.savePendingArticle({ title: newTitle, body: newBody, media: newMedia } as any).catch(() => {});
    safeToast(_('已保存并同步正文修改'));
  };

  // 上传文档（markdown / txt / docx）：自动解析为标题 + 正文填入
  const handleImportDocument = async (file: File) => {
    const name = (file.name || '').toLowerCase();
    const ext = name.match(/\.([a-z0-9]+)$/)?.[1] || '';
    try {
      let finalTitle = '';
      let finalBody = '';
      if (ext === 'md' || ext === 'markdown' || ext === 'txt') {
        const text = await file.text();
        const lines = text.split(/\r?\n/);
        const first = lines[0] || '';
        const parsedTitle = first.startsWith('# ') ? first.slice(2).trim() : '';
        const parsedBody = parsedTitle ? lines.slice(1).join('\n').trimStart() : text;
        finalTitle = parsedTitle || name.replace(/\.[a-z]+$/i, '');
        finalBody = parsedBody;
        setTitle(finalTitle);
        setBody(finalBody);
        safeToast(() => `${_('已导入 ')}${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
      } else if (ext === 'docx') {
        const buf = await file.arrayBuffer();
        const { title: t, text } = readDocxText(buf);
        finalTitle = t || name.replace(/\.docx$/i, '');
        finalBody = text;
        setTitle(finalTitle);
        setBody(finalBody);
        safeToast(() => `${_('已从 Word 导入 ')}${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
      } else {
        safeToast(() => `${_('暂不支持 .')}${ext}${_('（仅支持 .md / .markdown / .txt / .docx）')}`);
        return;
      }
      // 同步落盘草稿，恢复用（使用刚解析的实时值，杜绝 React 状态闭包将空内容覆盖写入）
      store.savePendingArticle({ title: finalTitle, body: finalBody, media: mediaList } as any).catch(() => {});
    } catch (e: any) {
      safeToast(e?.message || _('文档导入失败'));
    }
  };

  // 触发隐藏的文件选择器（用于「上传文档」按钮）
  const fileDocInputRef = React.useRef<HTMLInputElement | null>(null);
  const onPickDocument = () => fileDocInputRef.current?.click();
  const onDocumentSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleImportDocument(f);
    e.target.value = ''; // 允许选同名文件再次触发
  };

  const removeMedia = (id: string) => {
    setMediaList(prev => prev.filter(m => m.id !== id));
  };

  /**
   * 长任务失联兜底：后台每个平台的状态变化都会落盘到 storage 的 publishProgress，
   * 连接中断时用它还原各平台真实状态，杜绝「明明发出去了却全员显示未执行或被跳过」的假回执。
   */
  const recoverInterruptedRun = (platformIds: PlatformId[]) => {
    try {
      chrome.storage.local.get('publishProgress', (st) => {
        const prog: Record<string, PublishProgress> = (st as any)?.publishProgress || {};
        const recovered: PublishResult[] = platformIds.map((pid) => {
          const p = prog[pid];
          if (p?.result) return p.result; // 发布阶段已有明确结果，直接采信
          if (p?.stage === 'done') {
            // 草稿已建但尚未确认发布结果：如实标为草稿，用户可去平台手动发布
            return { platformId: pid, ok: true, url: p.draft?.url, draftId: p.draft?.draftId, draftOnly: true, timestamp: Date.now() } as PublishResult;
          }
          return {
            platformId: pid,
            ok: false,
            url: PLATFORMS.find((x) => x.id === pid)?.loginUrl,
            error: p?.message || _('未执行或被跳过'),
            timestamp: Date.now(),
          } as PublishResult;
        });
        if (recovered.length === 0) {
          alert(_('与后台的连接在长任务中中断（Service Worker 可能被 Chrome 回收），本次发布未执行。请重试；若反复出现，请减少一次勾选的平台数。'));
          return;
        }
        setPublishResults(recovered);
        setShowResultsModal(true);
      });
    } catch {
      alert(_('与后台的连接在长任务中中断（Service Worker 可能被 Chrome 回收），本次发布未执行。请重试；若反复出现，请减少一次勾选的平台数。'));
    }
  };

  // 一键静默发布：建草稿 → 自动发布 → 关闭编辑页（对标商店插件"一键发文"体验）
  const startAutoPublish = () => {
    if (!body.trim() && !title.trim()) {
      alert(_('请填写正文内容或标题'));
      return;
    }
    if (selectedPlatforms.size === 0) {
      alert(_('请至少勾选一个目标发布平台'));
      return;
    }
    if (selectedPlatforms.has('youtube') && !mediaList.some((m) => m.type.startsWith('video/'))) {
      alert(_('YouTube 仅支持视频发布，请先添加至少一个视频文件再发布'));
      return;
    }
    if (selectedPlatforms.has('xiaohongshu') && !mediaList.some((m) => m.type.startsWith('image/') || m.type.startsWith('video/'))) {
      alert(_('小红书仅支持图文或视频发布，请先添加至少一张图片或视频再发布'));
      return;
    }

    setIsProcessing(true);
    setProgressMap({});
    setRunInterrupted('');

    // B1 登录态预检：发布前先拉最新登录态，剔除未登录平台（避免发出去一堆"未登录失败"）
    chrome.runtime.sendMessage({ type: 'CHECK_ALL_LOGIN', payload: { platformIds: Array.from(selectedPlatforms) } }, (authRes) => {
      const notLoggedIn: PlatformId[] = [];
      const validPlatforms: PlatformId[] = [];
      for (const pid of Array.from(selectedPlatforms)) {
        const a = authRes?.[pid];
        if (a && a.loggedIn === false) {
          notLoggedIn.push(pid);
        } else validPlatforms.push(pid);
      }

      // 全部未登录 → 中止
      if (validPlatforms.length === 0) {
        setIsProcessing(false);
        alert(_('勾选的平台都未登录，请先在浏览器里登录对应平台，再回来发布。'));
        return;
      }

      // 部分未登录 → 告知并跳过
      if (notLoggedIn.length > 0) {
        const skipped = notLoggedIn.map((pid) => ({ id: pid, name: PLATFORMS.find((p) => p.id === pid)?.name || pid, reason: 'notLoggedIn' as const }));
        setSkippedPlatforms(skipped);
        const names = skipped.map((s) => s.name).join('、');
        const go = confirm(_('以下平台未登录，本次将跳过：\n') + names + _('\n\n是否继续发布已登录的平台？'));
        if (!go) {
          setIsProcessing(false);
          return;
        }
      } else {
        setSkippedPlatforms([]);
      }

      const article: Article = { title, body, media: mediaList };
      // 落盘草稿：popup 失焦即关闭，写盘后随时可恢复
      store.savePendingArticle(article);

      chrome.runtime.sendMessage({
        type: 'START_AUTO_PUBLISH',
        payload: {
          article,
          platformIds: validPlatforms,
          aiRewrite,
          semiAuto: publishMode === 'semi'
        }
      }, (response) => {
        setIsProcessing(false);
        // 后台管线崩溃时返回 fatal 结构化响应；连响应都没有说明 message port 已断（SW 被回收）
        if (response?.fatal) {
          setRunInterrupted(_('发布管线异常中断') + '：' + response.fatal);
          recoverInterruptedRun(validPlatforms);
          return;
        }
        if (!response) {
          setRunInterrupted(_('与后台的连接在长任务中中断（Service Worker 可能被 Chrome 回收），以下为中断前记录到的最后状态，可能不完整。'));
          recoverInterruptedRun(validPlatforms);
          return;
        }
        setRunInterrupted('');
        const drafts: DraftRef[] = response?.drafts || [];
        const results: PublishResult[] = response?.results || [];
        const errors: Record<string, string> = response?.errors || {};
        const warnings: Record<string, string> = response?.warnings || {};
        setPublishWarnings(warnings);
        setActiveDrafts(drafts);
        store.savePendingDrafts(drafts);

        // 前端双重保险：合并 results、errors 与 validPlatforms
        const allResults: PublishResult[] = [...results];
        for (const [pid, errMsg] of Object.entries(errors)) {
          if (!allResults.some(r => r.platformId === pid)) {
            const pMeta = PLATFORMS.find(p => p.id === pid);
            allResults.push({
              platformId: pid as PlatformId,
              ok: false,
              url: pMeta?.loginUrl,
              error: errMsg || _('草稿创建失败'),
              timestamp: Date.now()
            });
          }
        }
        for (const pid of validPlatforms) {
          if (!allResults.some(r => r.platformId === pid)) {
            const pMeta = PLATFORMS.find(p => p.id === pid);
            allResults.push({
              platformId: pid,
              ok: false,
              url: pMeta?.loginUrl,
              error: _('未执行或被跳过'),
              timestamp: Date.now()
            });
          }
        }

        if (allResults.length > 0) {
          setPublishResults(allResults);
          setShowResultsModal(true);
          store.clearPending(); // 发布流程结束，清空待发布状态
        } else {
          alert(_('未能完成任何平台发布。\n') + Object.values(errors).join('\n') || _('未知错误'));
        }
      });
    });
  };

  // 失败重试：对失败的平台重新发布（支持草稿阶段失败与发布阶段失败）
  const retryFailed = () => {
    const failedResults = publishResults.filter(r => !r.ok);
    const failedIds = failedResults.map(r => r.platformId);
    if (failedIds.length === 0) {
      alert(_('没有失败的平台需要重试'));
      return;
    }

    // 区分：已有草稿的直接走发布管线；没有草稿的重新走一键自动发布管线
    const retryDrafts = activeDrafts.filter(d => failedIds.includes(d.platformId));
    const draftPlatformIds = new Set(retryDrafts.map(d => d.platformId));
    const needFullRetryIds = failedIds.filter(pid => !draftPlatformIds.has(pid));

    setIsProcessing(true);

    const promises: Promise<PublishResult[]>[] = [];

    // 1. 有草稿的执行 START_PUBLISH_PIPELINE
    if (retryDrafts.length > 0) {
      promises.push(
        new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'START_PUBLISH_PIPELINE',
            payload: { drafts: retryDrafts }
          }, (res: PublishResult[]) => resolve(res || []));
        })
      );
    }

    // 2. 无草稿的（草稿阶段失败）重新走 START_AUTO_PUBLISH
    if (needFullRetryIds.length > 0) {
      // 重建载荷：article 仅存在于 startAutoPublish 的闭包，此处直接引用会 ReferenceError（P0 Bug 修复）
      const retryArticle: Article = { title, body, media: mediaList };
      promises.push(
        new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'START_AUTO_PUBLISH',
            payload: {
              article: retryArticle,
              platformIds: needFullRetryIds,
              aiRewrite,
              semiAuto: publishMode === 'semi'
            }
          }, (res) => {
            const newDrafts: DraftRef[] = res?.drafts || [];
            if (newDrafts.length > 0) {
              setActiveDrafts(prev => [...prev.filter(d => !needFullRetryIds.includes(d.platformId)), ...newDrafts]);
            }
            const resResults: PublishResult[] = res?.results || [];
            resolve(resResults);
          });
        })
      );
    }

    Promise.all(promises).then((resultsArray) => {
      setIsProcessing(false);
      const combined = resultsArray.flat();
      if (combined.length > 0) {
        setPublishResults(prev => {
          const map = new Map(prev.map(r => [r.platformId, r]));
          combined.forEach(r => map.set(r.platformId, r));
          return Array.from(map.values());
        });
      }
    });
  };

  const saveSettingsHandler = async () => {
    await store.saveSettings(settings);
    setShowSettingsModal(false);
    refreshAuth();
  };

  // YouTube OAuth：携带已填写的 Client ID/Secret 发起 PKCE 授权
  const authorizeYouTube = () => {
    setYtStatus(_('正在打开 Google 授权页，请完成登录...'));
    chrome.runtime.sendMessage({ type: 'YOUTUBE_AUTHORIZE' }, (res) => {
      if (res?.ok) {
        setYtStatus(_('✅ 授权成功，Access Token 已保存'));
        setTimeout(() => setYtStatus(''), 4000);
      } else {
        setYtStatus('❌ ' + (res?.error || _('授权失败')));
        setTimeout(() => setYtStatus(''), 6000);
      }
    });
  };

  // CMS 测试连接：先落盘当前设置（测试用最新凭证），再让 background 对该平台跑 checkLogin
  const testConnection = (platformId: PlatformId) => {
    store.saveSettings(settings).then(() => {
      setConnStatus(prev => ({ ...prev, [platformId]: _('检测中...') }));
      chrome.runtime.sendMessage({ type: 'CHECK_PLATFORM_LOGIN', payload: { platformId } }, (auth: PlatformAccount | undefined) => {
        setConnStatus(prev => ({
          ...prev,
          [platformId]: auth?.loggedIn
            ? `✅ ${_('连接成功')}${auth.account ? `（${auth.account}）` : ''}`
            : `❌ ${_('连接失败')}${auth?.error ? `：${auth.error}` : _('（请检查站点地址与凭证）')}`,
        }));
      });
    });
  };

  const platformLoginOrSettings = (p: PlatformInfo) => {
    if (p.route === 'official') {
      setShowSettingsModal(true); // WordPress/YouTube/Telegram/Typecho/MetaWeblog 走设置面板填凭证
    } else if (p.loginUrl) {
      window.open(p.loginUrl, '_blank');
    }
    // zip-download 等无登录页平台：点击无动作（恒可勾选）
  };

  // 语言未就绪时不渲染主体，避免 _() 在 lang=null 时显示原文导致"伪英文界面"
  if (lang === null) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#0c0f17] text-gray-500 text-[11px]">
        <div className="flex items-center gap-2">
          <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col h-full bg-[#0c0f17] text-[#f0f2f5] text-[13px] select-none font-sans">
      {/* Toast */}
      {toast && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[60] px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px] font-medium shadow-lg whitespace-nowrap">
          {toast}
        </div>
      )}

      {/* Top Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08] bg-[#0c0f17]/90 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <OmniPostLogo className="w-7 h-7" size={28} />
          <div>
            <span className="font-bold text-sm tracking-tight text-white">OmniPost</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={refreshAuth}
            disabled={refreshing}
            title={refreshing ? _('刷新中…') : _('刷新平台登录态')}
            className="p-1.5 rounded-md hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            onClick={() => { refreshHistory(); setShowHistoryModal(true); }}
            title={_('发布历史')}
            className="p-1.5 rounded-md hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          <button
            onClick={() => setShowSettingsModal(true)}
            title={_('平台 API 与账号设置')}
            className="p-1.5 rounded-md hover:bg-white/[0.06] text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </header>

      {/* Main Content Body */}
      <main className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 内容来源 Tab：AI 生成 / 手动编辑 */}
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[#141824] border border-white/[0.08]">
          {([
            { key: 'ai', label: '✨ AI 生成', hint: '一句话生成文案' },
            { key: 'manual', label: '📝 手动编辑', hint: '提取 / 上传 / 手动' },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setSourceTab(t.key)}
              className={`flex-1 px-2 py-1.5 rounded-md text-[12px] font-medium transition ${
                sourceTab === t.key ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/30' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {_(t.label)}
            </button>
          ))}
        </div>

        {/* AI 生成区 */}
        {sourceTab === 'ai' && (
          <div className="bg-[#141824] border border-white/[0.08] rounded-xl p-3.5 space-y-3">
            <textarea
              className="w-full h-28 p-3 bg-[#090d15] border border-white/[0.08] rounded-lg text-[13px] text-white placeholder-gray-500 resize-none focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 transition leading-relaxed"
              placeholder={_('描述你要生成的内容，例如：写一篇 800 字关于「2026 年 AI 编程助手横向对比」的文章，面向技术博主')}
              value={aiPrompt}
              onChange={e => setAiPrompt(e.target.value)}
            />
            <div className="flex items-center justify-between text-[10px] text-gray-500 px-1">
              <span className="truncate">{_('使用默认')}{getProvider(aiSettings.provider)?.name || aiSettings.provider} · {aiSettings.model || '—'}</span>
              <button onClick={() => setShowSettingsModal(true)} className="shrink-0 text-indigo-400 hover:underline ml-2">{_('在设置中修改')}</button>
            </div>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className={`w-full py-2.5 rounded-lg text-[13px] font-semibold transition flex items-center justify-center gap-2 ${
                generating ? 'bg-indigo-500/40 text-indigo-200 cursor-wait' : 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:from-indigo-400 hover:to-purple-500'
              }`}
            >
              {generating ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>{_('生成中…')}</>
              ) : _('✨ 一键生成文案')}
            </button>
            <p className="text-[10px] text-gray-500 leading-relaxed">{_('生成后自动填入标题与正文，可预览/编辑后一键发布到已选平台。API Key 在设置面板（⚙）配置。')}</p>
          </div>
        )}

        {/* Editor Area（支持拖拽投放媒体） */}
        {sourceTab === 'manual' && (
        <div
          className={`bg-[#141824] border rounded-xl p-3.5 shadow-sm space-y-3 transition-colors ${
            dragOver ? 'border-indigo-400 ring-2 ring-indigo-500/30' : 'border-white/[0.08]'
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleMediaDrop}
        >
          <div className="flex items-center gap-2">
            {/* min-w-0：320px 侧边栏下允许输入框收缩，否则「从当前页提取」按钮会被挤出容器（横向溢出） */}
            <input
              className="flex-1 min-w-0 px-3 py-2 bg-[#090d15] border border-white/[0.08] rounded-lg text-[13px] text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 transition"
              placeholder={_('文章 / 动态标题（可选）')}
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
            <button
              onClick={handleExtract}
              disabled={extracting}
              className={`shrink-0 px-3 py-2 rounded-lg text-[12px] font-medium transition border flex items-center gap-1.5 ${
                extracting
                  ? 'text-gray-500 border-white/[0.06] cursor-wait'
                  : 'text-indigo-300 border-indigo-500/30 hover:bg-indigo-500/10 hover:border-indigo-500/50'
              }`}
              title={_('从当前标签页提取文章正文与标题')}
            >
              {extracting ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span>{_('提取中…')}</span>
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  <span>{_('从当前页提取')}</span>
                </>
              )}
            </button>
          </div>

          {/* 编辑区操作工具栏：上传文档、清空、字数统计、真实排版预览 */}
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onPickDocument}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium text-violet-300 border border-violet-500/20 hover:bg-violet-500/10 hover:border-violet-500/40 transition flex items-center gap-1.5 shadow-sm"
                title={_('导入本地文档作为正文（支持 .md / .markdown / .txt / .docx）')}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>{_('上传文档')}</span>
              </button>
              <input
                ref={fileDocInputRef}
                type="file"
                accept=".md,.markdown,.txt,.docx,text/markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={onDocumentSelected}
                className="hidden"
              />

              <button
                type="button"
                onClick={handleClear}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium text-red-300/80 hover:text-red-300 border border-red-500/20 hover:bg-red-500/10 hover:border-red-500/40 transition flex items-center gap-1 shadow-sm"
                title={_('清空标题、正文与媒体（保留平台选择与设置）')}
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                </svg>
                <span>{_('清空')}</span>
              </button>

              <span className="text-[10px] text-gray-600 font-mono hidden sm:inline">{_('支持 .md / .txt / .docx')}</span>
            </div>

            <div className="flex items-center gap-2.5">
              <span className="text-[10px] font-mono text-gray-500">
                {body.length} {_('字')}
              </span>
              {(title.trim() || body.trim() || mediaList.length > 0) && (
                <button
                  type="button"
                  onClick={() => setShowPreviewModal(true)}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium text-indigo-300 hover:text-white bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 hover:border-indigo-500/50 transition flex items-center gap-1.5 shadow-sm"
                  title={_('打开真实排版预览弹窗（支持图片拖拽与文案修改）')}
                >
                  <span className="text-xs">↗</span>
                  <span>{_('真实排版预览')}</span>
                </button>
              )}
            </div>
          </div>

          {/* 正文输入区 */}
          <div className="relative">
            <textarea
              className="w-full h-44 p-3 bg-[#090d15] border border-white/[0.08] rounded-lg text-[13px] text-white placeholder-gray-500 resize-none focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 transition leading-relaxed font-sans"
              placeholder={_('在此撰写正文或 Markdown 内容，将自动适配各平台排版...（可直接拖拽图片/视频到此处）')}
              value={body}
              onChange={e => setBody(e.target.value)}
            />
          </div>

          {/* Media Section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-semibold text-gray-400 flex items-center gap-1.5">
                <span>{_('配图与视频')}</span>
                <span className="text-gray-500 font-normal">({mediaList.length})</span>
              </label>
              <label className="cursor-pointer text-[11px] text-indigo-400 hover:text-indigo-300 font-medium flex items-center gap-1 transition">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <span>{_('添加文件')}</span>
                <input type="file" multiple accept="image/*,video/*" className="hidden" onChange={handleMediaUpload} />
              </label>
            </div>

            {mediaList.length > 0 ? (
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {mediaList.map(m => (
                  <div key={m.id} className="relative group w-14 h-14 rounded-lg bg-[#090d15] border border-white/[0.1] overflow-hidden flex-shrink-0 flex items-center justify-center">
                    {m.type.startsWith('image/') ? (
                      <img src={m.dataUrl} className="w-full h-full object-cover" alt={m.name} />
                    ) : (
                      <div className="text-[10px] text-gray-400 text-center px-1">{_('🎬 视频')}</div>
                    )}
                    <button
                      onClick={() => removeMedia(m.id)}
                      className="absolute top-1 right-1 w-4 h-4 rounded-full bg-red-600/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="border border-dashed border-white/[0.1] rounded-lg px-3 py-3 text-center text-[10px] text-gray-500">
                {_('支持拖拽图片 / 视频到上方编辑区，或点击「添加文件」选择（单文件 ≤')} {MAX_MEDIA_MB}{_('MB）')}
              </div>
            )}
          </div>
        </div>
        )}

        {/* Platform Selection */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider font-mono">{_('目标发布平台')} ({PLATFORMS.length})</span>
            <div className="flex items-center gap-2 text-[11px]">
              <button onClick={() => selectAll(true)} className="text-indigo-400 hover:underline">{_('全选')}</button>
              <span className="text-gray-600">·</span>
              <button onClick={() => selectAll(false)} className="text-gray-400 hover:underline">{_('取消')}</button>
            </div>
          </div>

          {PLATFORM_GROUPS.map((g) => {
            const groupPlatforms = PLATFORMS.filter((p) => p.group === g.key);
            if (groupPlatforms.length === 0) return null;
            // 登录态优先：已登录 → 未检查（初始）→ 折叠的未登录
            const loggedIn = groupPlatforms.filter(p => authMap[p.id]?.loggedIn === true);
            const unknown = groupPlatforms.filter(p => !authMap[p.id]);
            const loggedOut = groupPlatforms.filter(p => authMap[p.id] && !authMap[p.id].loggedIn);
            const groupExpanded = expandedLoggedOutGroups.has(g.key);
            const visible = [...loggedIn, ...unknown, ...(groupExpanded ? loggedOut : [])];
            return (
              <div key={g.key} className="space-y-1.5">
                <div className="text-[10px] text-gray-500 font-mono tracking-wider">
                  {_(g.label)} ({groupPlatforms.length})
                  {loggedIn.length > 0 && <span className="text-emerald-500"> · {loggedIn.length} {_('已登录')}</span>}
                </div>
                <div className="grid grid-cols-2 gap-2">
            {visible.map(p => {
              const auth = authMap[p.id];
              const isSelected = selectedPlatforms.has(p.id);
              const progress = progressMap[p.id];
              const authKnown = !!auth;
              const locked = authKnown && !auth.loggedIn; // 未登录置灰加锁
              const progressDone = progress?.stage === 'done';
              const progressFailed = progress?.stage === 'failed';
              const progressActive = progress && !progressDone && !progressFailed;

              return (
                <div
                  key={p.id}
                  onClick={() => togglePlatform(p.id)}
                  className={`relative p-2.5 rounded-xl border transition-all flex flex-col justify-between overflow-hidden ${
                    locked ? 'cursor-not-allowed opacity-50'
                      : isSelected
                        ? 'cursor-pointer bg-[#1b2030] shadow-[0_0_12px_rgba(99,102,241,0.15)]'
                        : 'cursor-pointer bg-[#141824] border-white/[0.06] opacity-75 hover:opacity-100'
                  }`}
                  style={isSelected && !locked ? { borderColor: p.color + '99', boxShadow: `0 0 12px ${p.color}33` } : undefined}
                >
                  {/* 品牌色左条 */}
                  {isSelected && !locked && (
                    <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ backgroundColor: p.color }} />
                  )}
                  <div className="flex items-center gap-2 min-w-0">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={locked}
                      onChange={() => {}}
                      className="rounded border-gray-700 focus:ring-0 flex-shrink-0"
                      style={{ accentColor: p.color }}
                    />
                    <span className="font-semibold text-white text-[12px] flex items-center gap-1.5 min-w-0">
                      <span className="w-2 h-2 rounded-full inline-block flex-shrink-0" style={{ backgroundColor: p.color }} />
                      <span className="truncate">{_(p.name)}</span>
                    </span>
                    {locked && <span className="text-[9px] text-gray-500 flex-shrink-0">🔒</span>}
                  </div>

                  <div className="mt-2 flex items-center justify-between gap-1.5 text-[10px]">
                    <div className="min-w-0 flex">
                      {auth?.loggedIn ? (
                        p.semiAuto ? (
                          // 半自动平台：已登录标明已登录·半自动
                          <span className="text-emerald-400 flex items-center gap-1 truncate max-w-[140px]">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0"></span>
                            {auth.account ? _(auth.account) : _('已登录')} · {_('半自动')}
                          </span>
                        ) : (
                          <span className="text-emerald-400 flex items-center gap-1 truncate max-w-[120px]">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0"></span>
                            {auth.account ? _(auth.account) : _('已连接')}
                          </span>
                        )
                      ) : (
                        <button
                          onClick={e => { e.stopPropagation(); platformLoginOrSettings(p); }}
                          className="text-amber-400/80 hover:text-amber-400 flex items-center gap-1 underline min-w-0"
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400/80 flex-shrink-0"></span>
                          <span className="truncate">{p.route === 'official' ? _('未配置 (去设置)') : p.loginUrl ? _('未登录 (去登录)') : _('本地导出 (无需登录)')}</span>
                        </button>
                      )}
                    </div>
                    {p.tags.length > 0 && (
                      <div className="flex gap-1 flex-shrink-0">
                        {p.tags.map(t => (
                          <span key={t} className="text-[9px] px-1 bg-white/[0.05] rounded text-gray-400 font-mono whitespace-nowrap">{_(t)}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Dynamic Progress indicator */}
                  {progressActive && (
                    <div className="mt-1.5 pt-1.5 border-t border-white/[0.06] text-[10px] text-indigo-300 font-mono flex items-center gap-1.5 truncate">
                      <span className="animate-spin text-xs">⟳</span>
                      <span className="truncate">{progress.message}</span>
                    </div>
                  )}
                  {progressDone && (
                    <div className="mt-1.5 pt-1.5 border-t border-white/[0.06] text-[10px] text-emerald-400 font-mono flex items-center gap-1.5 truncate">
                      <span>✓</span>
                      <span className="truncate">{progress.message || _('已完成')}</span>
                    </div>
                  )}
                  {progressFailed && (
                    <div className="mt-1.5 pt-1.5 border-t border-white/[0.06] text-[10px] text-red-400 font-mono flex items-center gap-1.5 truncate">
                      <span>✕</span>
                      <span className="truncate">{progress.message || _('失败')}</span>
                    </div>
                  )}
                </div>
              );
            })}
                </div>
              {loggedOut.length > 0 && (
                <button
                  onClick={() => toggleLoggedOutGroup(g.key)}
                  className="w-full py-1.5 rounded-lg text-[11px] text-gray-400 hover:text-gray-200 border border-dashed border-white/[0.1] hover:border-white/[0.2] transition flex items-center justify-center gap-1"
                >
                  <svg className="w-3 h-3 transition-transform" style={{ transform: groupExpanded ? 'rotate(180deg)' : 'none' }} viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                  {groupExpanded ? _('收起未登录平台') : `${_('展开')} ${loggedOut.length} ${_('个未登录平台')}`}
                </button>
              )}
              </div>
            );
          })}
        </div>
      </main>

      {/* Bottom Action Strip */}
      <footer className="p-3 border-t border-white/[0.08] bg-[#0c0f17]/95 flex flex-col gap-2">
        <label className={`flex items-center gap-2 text-[11px] ${aiSettings.apiKey ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
          <input
            type="checkbox"
            checked={aiRewrite}
            disabled={!aiSettings.apiKey}
            onChange={(e) => setAiRewrite(e.target.checked)}
            className="w-3.5 h-3.5 accent-indigo-500"
          />
          <span className="text-gray-300">{_('✨ AI 适配各平台风格')}</span>
          <span className="text-gray-500">{aiSettings.apiKey ? _('（按知乎/小红书/X 等调性改写后发布）') : _('（需先在设置配置 AI Key）')}</span>
        </label>
        <div className="flex items-center gap-2">
          <div className="text-[11px] text-gray-400 whitespace-nowrap">
            {lang === 'zh' ? (
              <>
                {_('已勾选')}<span className="text-indigo-400 font-semibold">{selectedPlatforms.size}</span>{_('平台')}
              </>
            ) : (
              <>
                {_('Selected')} <span className="text-indigo-400 font-semibold">{selectedPlatforms.size}</span> {selectedPlatforms.size === 1 ? _('platform') : _('platforms')}
              </>
            )}
          </div>
          <button
            disabled={isProcessing}
            onClick={startAutoPublish}
            className="flex-1 min-w-0 py-2.5 px-3 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 text-white font-semibold rounded-lg shadow-[0_2px_12px_rgba(99,102,241,0.35)] transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {isProcessing ? (
              <>
                <svg className="animate-spin w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span className="truncate">{_('正在静默发布...')}</span>
              </>
            ) : (
              <>
                <span className="truncate">{lang === 'zh' ? _('一键生成并全网发布') : _('Publish everywhere')}</span>
                <span className="text-[10px] bg-white/20 px-1.5 py-0.5 rounded font-mono shrink-0">{_('静默自动')}</span>
              </>
            )}
          </button>
        </div>
      </footer>


      {/* Modal 2: Results & Links */}
      {showResultsModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#141824] border border-white/[0.1] rounded-2xl w-full max-w-sm overflow-hidden flex flex-col max-h-[92vh] shadow-2xl">
            <div className="px-4 py-3 border-b border-white/[0.08] flex items-center justify-between">
              <div>
                <h3 className="font-bold text-white text-[14px]">{_('发布结果回执')}</h3>
                {publishResults.length > 0 && (
                  <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1.5 font-mono">
                    <span>{_('共')} {publishResults.length} {_('个平台')}: </span>
                    {publishResults.filter(r => r.ok && !r.draftOnly && !r.manualOnly).length > 0 && (
                      <span className="text-emerald-400">{publishResults.filter(r => r.ok && !r.draftOnly && !r.manualOnly).length} {_('成功')}</span>
                    )}
                    {publishResults.filter(r => r.ok && r.draftOnly && !r.manualOnly).length > 0 && (
                      <span className="text-sky-300">{publishResults.filter(r => r.ok && r.draftOnly && !r.manualOnly).length} {_('草稿')}</span>
                    )}
                    {publishResults.filter(r => r.ok && r.manualOnly).length > 0 && (
                      <span className="text-amber-300">{publishResults.filter(r => r.ok && r.manualOnly).length} {_('待粘贴')}</span>
                    )}
                    {publishResults.filter(r => !r.ok).length > 0 && (
                      <span className="text-red-400">{publishResults.filter(r => !r.ok).length} {_('失败')}</span>
                    )}
                  </div>
                )}
              </div>
              <button onClick={() => setShowResultsModal(false)} className="text-gray-400 hover:text-white text-lg">×</button>
            </div>

            <div className="p-4 overflow-y-auto space-y-2 flex-1">
              {/* 长任务失联横幅：回执是按后台落盘的最后进度还原的，必须显式告知「可能不完整」 */}
              {runInterrupted && (
                <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-[11px] text-red-300 break-words">
                  {'⚠️ ' + runInterrupted}
                </div>
              )}
              {/* 非致命告警 banner（AI 适配失败回退原文等）：不阻塞但用户必须知情 */}
              {Object.keys(publishWarnings).length > 0 && (
                <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 space-y-1">
                  {Object.entries(publishWarnings).map(([pid, msg]) => (
                    <div key={pid} className="text-[11px] text-amber-300">
                      {'⚠️ ' + _(PLATFORMS.find(p => p.id === pid)?.name || pid) + ' — ' + msg}
                    </div>
                  ))}
                </div>
              )}
              {publishResults.map(r => {
                // 失败时：草稿页 URL（用于「打开草稿」按钮），优先用 draft.url（草稿详情可手动点发布）
                const draftUrl = activeDrafts.find(d => d.platformId === r.platformId)?.url;
                return (
                <div key={r.platformId} className="p-3 rounded-lg bg-[#090d15] border border-white/[0.06] flex items-center justify-between">
                  <div className="flex-1 min-w-0 pr-2">
                    <div className="font-semibold text-white text-[12px]">
                      {_(PLATFORMS.find(p => p.id === r.platformId)?.name || r.platformId)}
                    </div>
                    <div className="text-[11px] break-all">
                      {r.ok ? (
                        r.manualOnly ? (
                          <span className="text-amber-300">{_('待粘贴发布（打开后 Ctrl+V）')}</span>
                        ) : r.draftOnly ? (
                          <span className="text-sky-300">{_('已存草稿，未发布')}</span>
                        ) : (
                          <span className="text-emerald-400">{_('发布成功')}</span>
                        )
                      ) : (
                        <span className="text-red-400">{r.error || _('失败')}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* 失败时 + 草稿 URL 存在（来自 draft.url 或平台直发失败透出的 r.url）：提供「打开草稿」按钮 */}
                    {!r.ok && (draftUrl || r.url) && (
                      <button
                        onClick={async () => {
                          const targetUrl = draftUrl || r.url!;
                          const d = activeDrafts.find((x) => x.platformId === r.platformId);
                          await copyDraftForPlatform(d?.title || title || '', d?.body || body || '', r.platformId);
                          if (r.platformId === 'douyin') {
                            await chrome.storage.local.set({
                              douyin_draft_pending: {
                                title: d?.title || title || '',
                                body: d?.body || body || '',
                                timestamp: Date.now(),
                              }
                            }).catch(() => {});
                          }
                          chrome.tabs.create({ url: targetUrl });
                        }}
                        title={_('打开草稿详情页（可手动点发布）')}
                        className="px-2 py-1 bg-emerald-500/20 hover:bg-emerald-500/30 rounded text-[11px] text-emerald-300"
                      >{_('打开草稿')}</button>
                    )}
                    {/* 半自动模式：草稿已就绪，提供「打开草稿」按钮。点击时把标题+正文（富文本HTML与纯文本）复制到剪贴板，用户在打开的新页面 Ctrl+V 即可 */}
                    {r.draftOnly && r.url && (
                      <button
                        onClick={async () => {
                          const d = activeDrafts.find((x) => x.platformId === r.platformId);
                          await copyDraftForPlatform(d?.title || title || '', d?.body || body || '', r.platformId);
                          if (r.platformId === 'douyin') {
                            await chrome.storage.local.set({
                              douyin_draft_pending: {
                                title: d?.title || title || '',
                                body: d?.body || body || '',
                                timestamp: Date.now(),
                              }
                            }).catch(() => {});
                          }
                          chrome.tabs.create({ url: r.url! });
                        }}
                        title={_('打开草稿详情页（标题+正文已复制到剪贴板，可直接粘贴）')}
                        className="px-2 py-1 bg-emerald-500/20 hover:bg-emerald-500/30 rounded text-[11px] text-emerald-300"
                      >{_('打开草稿')}</button>
                    )}
                    {!r.draftOnly && r.url ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="px-2 py-1 bg-white/[0.06] hover:bg-white/[0.12] rounded text-[11px] text-indigo-400"
                      >{_('查看 ↗')}</a>
                    ) : (
                      !r.ok && (
                        <button
                          onClick={retryFailed}
                          className="px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 rounded text-[11px] text-amber-300"
                        >{_('重试')}</button>
                      )
                    )}
                  </div>
                </div>
                );
              })}

              {/* 被跳过的平台（B1 预检剔除的未登录平台，让用户清楚知道哪些没发） */}
              {skippedPlatforms.length > 0 && (
                <>
                  <div className="mt-3 pt-2 border-t border-white/[0.06] text-[10px] text-gray-500">{_('本次跳过')}{skippedPlatforms.length > 0 && <span className="ml-1 text-amber-400">({skippedPlatforms.length} {_('个未登录')})</span>}</div>
                  {skippedPlatforms.map((s) => (
                    <div key={s.id} className="p-3 rounded-lg bg-[#090d15] border border-amber-500/20 flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-white text-[12px]">{_(s.name)}</div>
                        <div className="text-[11px] text-amber-400">{_('未登录，已跳过')}</div>
                      </div>
                      <span className="text-[10px] text-gray-500 px-2 py-1">{_('去登录后重试')}</span>
                    </div>
                  ))}
                </>
              )}
            </div>

            <div className="p-3 border-t border-white/[0.08] bg-[#0c0f17]">
              <button
                onClick={() => { setShowResultsModal(false); setSkippedPlatforms([]); }}
                className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-semibold text-[12px]"
              >{_('完成')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 3: 发布历史 */}
      {showHistoryModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#141824] border border-white/[0.1] rounded-2xl w-full max-w-sm overflow-hidden flex flex-col max-h-[85vh] shadow-2xl">
            <div className="px-4 py-3 border-b border-white/[0.08] flex items-center justify-between">
              <h3 className="font-bold text-white text-[14px]">{_('📚 内容库')}</h3>
              <div className="flex items-center gap-2">
                <button onClick={refreshHistory} className="text-[11px] text-indigo-400 hover:underline">{_('刷新')}</button>
                <button onClick={() => setShowHistoryModal(false)} className="text-gray-400 hover:text-white text-lg">×</button>
              </div>
            </div>

            <div className="px-4 pt-3">
              <input
                className="w-full px-3 py-2 bg-[#090d15] border border-white/[0.08] rounded-lg text-[12px] text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                placeholder={_('🔍 搜索标题 / 正文关键词')}
                value={historyKeyword}
                onChange={e => setHistoryKeyword(e.target.value)}
              />
            </div>

            <div className="p-4 overflow-y-auto space-y-2.5 flex-1">
              {(() => {
                const kw = historyKeyword.trim().toLowerCase();
                const filtered = kw ? history.filter((h) => (h.title || '').toLowerCase().includes(kw) || (h.body || '').toLowerCase().includes(kw)) : history;
                if (filtered.length === 0) return (
                  <div className="text-center py-10 text-gray-500 text-[12px]">
                    <div className="text-2xl mb-2">🗂️</div>
                    {history.length === 0 ? _('暂无发布记录') : _('无匹配内容')}
                  </div>
                );
                return filtered.map((h) => (
                  <div key={h.id} className="p-2.5 rounded-lg bg-[#090d15] border border-white/[0.06]">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold text-white text-[12px] truncate max-w-[70%]">{h.title || _('未命名发布')}</span>
                      <span className="text-[9px] text-gray-500 font-mono">
                        {new Date(h.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    {h.body && <p className="text-[10px] text-gray-400 line-clamp-1 mb-1.5">{h.body}</p>}
                    <div className="flex flex-wrap gap-1">
                      {h.results.map((r) => {
                        const info = PLATFORMS.find((p) => p.id === r.platformId);
                        return (
                          <span
                            key={r.platformId}
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono ${
                              r.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                            }`}
                          >
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: info?.color || '#888' }} />
                            {_(info?.name || r.platformId)}
                            {r.ok ? '✓' : '✕'}
                          </span>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 pt-1.5 border-t border-white/[0.05]">
                      <button
                        onClick={() => { try { navigator.clipboard?.writeText(`# ${h.title || ''}\n\n${h.body || ''}`); } catch {} safeToast(_('已复制到剪贴板')); }}
                        className="text-[10px] text-gray-400 hover:text-white transition"
                      >{_('📋 复制')}</button>
                      <button
                        onClick={() => { setTitle(h.title || ''); setBody(h.body || ''); setSourceTab('manual'); setShowHistoryModal(false); safeToast(_('已载入内容，可编辑后发布')); }}
                        className="text-[10px] text-indigo-400 hover:text-indigo-300 transition"
                      >{_('↺ 再次使用')}</button>
                    </div>
                  </div>
                ));
              })()}
            </div>

            <div className="p-3 border-t border-white/[0.08] bg-[#0c0f17]">
              <button
                onClick={() => setShowHistoryModal(false)}
                className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-semibold text-[12px]"
              >{_('关闭')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 4: Settings Modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#141824] border border-white/[0.1] rounded-2xl w-full max-w-sm overflow-hidden flex flex-col max-h-[85vh] shadow-2xl">
            <div className="px-4 py-3 border-b border-white/[0.08] flex items-center justify-between">
              <h3 className="font-bold text-white text-[14px]">{_('平台凭证配置')}</h3>
              <button onClick={() => setShowSettingsModal(false)} className="text-gray-400 hover:text-white text-lg">×</button>
            </div>

            <div className="p-4 overflow-y-auto space-y-4 flex-1 text-[12px]">
              {/* 扩展行为：悬浮同步按钮等 */}
              <div className="space-y-2 pb-3 border-b border-white/[0.06]">
                <h4 className="font-semibold text-violet-400">{_('扩展行为')}</h4>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-gray-200">{_('语言')} / Language</span>
                  <select
                    value={lang}
                    onChange={(e) => { const l = e.target.value as Lang; applyLang(l); store.setLang(l); }}
                    className="px-2 py-1 bg-[#090d15] border border-white/[0.08] rounded text-white text-[11px] focus:outline-none focus:border-violet-500"
                  >
                    <option value="zh">中文 / Chinese</option>
                    <option value="en">English / 英文</option>
                  </select>
                </div>
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <span className="text-gray-200 flex-1">{_('在文章页显示悬浮「同步」按钮')}</span>
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-violet-500 cursor-pointer"
                    checked={!hideFab}
                    onChange={(e) => {
                      // 正向开关：勾选 = 显示悬浮球（hideFab 存的是反向语义，取反落盘）
                      const show = e.target.checked;
                      setHideFab(!show);
                      store.setUiSettings({ hideFab: !show });
                      safeToast(show ? _('已恢复悬浮同步按钮') : _('已隐藏悬浮同步按钮'));
                    }}
                  />
                </label>
                <p className="text-[10px] text-gray-500 leading-relaxed">{_('关闭后，文章页右下角的蓝色「同步」胶囊不再显示；不影响从扩展图标 / popup 「从当前页提取」。')}</p>

                {/* 发布模式：自动 / 半自动 */}
                <div className="pt-2">
                  <span className="text-gray-200 block mb-1.5">{_('发布模式')}</span>
                  <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[#090d15] border border-white/[0.06]">
                    <button
                      onClick={() => { setPublishMode('auto'); store.setUiSettings({ publishMode: 'auto' }); }}
                      className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition ${publishMode === 'auto' ? 'bg-indigo-500/30 text-indigo-200' : 'text-gray-400 hover:text-gray-200'}`}
                    >{_('自动发布')}</button>
                    <button
                      onClick={() => { setPublishMode('semi'); store.setUiSettings({ publishMode: 'semi' }); }}
                      className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition ${publishMode === 'semi' ? 'bg-emerald-500/30 text-emerald-200' : 'text-gray-400 hover:text-gray-200'}`}
                    >{_('半自动（仅建草稿）')}</button>
                  </div>
                  <p className="text-[10px] text-gray-500 leading-relaxed mt-1">
                    {publishMode === 'semi'
                      ? _('半自动：只自动建草稿，不调发布接口（绕开知乎/掘金等平台风控），发布结果回执点「打开草稿」手动点发布，成功率最高。')
                      : _('自动：建草稿后自动点发布。API 直连平台（知乎/掘金等）可能因风控被 403，失败时可点「打开草稿」手动补发。')}
                  </p>
                </div>
              </div>

              {/* AI 文案生成 */}
              <div className="space-y-2 pb-3 border-b border-white/[0.06]">
                <h4 className="font-semibold text-indigo-400">{_('AI 文案生成')}</h4>
                <select
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  value={aiSettings.provider}
                  onChange={e => {
                    const p = getProvider(e.target.value);
                    const next = { ...aiSettings, provider: e.target.value, model: p?.defaultModel || '', baseUrl: '' };
                    setAiSettings(next); store.setAiSettings(next);
                  }}
                >
                  {AI_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder="API Key"
                  type="password"
                  value={aiSettings.apiKey || ''}
                  onChange={e => { const n = { ...aiSettings, apiKey: e.target.value }; setAiSettings(n); store.setAiSettings(n); }}
                />
                {AI_KEY_URLS[aiSettings.provider] && (
                  <CredLink
                    note={_('申请指引：')}
                    text={`${_(AI_PROVIDERS.find(p => p.id === aiSettings.provider)?.name || '')} ${_('→ 控制台创建 API Key')}`}
                    url={AI_KEY_URLS[aiSettings.provider]}
                  />
                )}
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('模型名（留空用默认）')}
                  value={aiSettings.model || ''}
                  onChange={e => { const n = { ...aiSettings, model: e.target.value }; setAiSettings(n); store.setAiSettings(n); }}
                />
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('Base URL（留空用所选服务默认）')}
                  value={aiSettings.baseUrl || ''}
                  onChange={e => { const n = { ...aiSettings, baseUrl: e.target.value }; setAiSettings(n); store.setAiSettings(n); }}
                />
                <p className="text-[10px] text-gray-500 leading-relaxed">{_('支持 DeepSeek / OpenAI / 通义千问 / Kimi / 智谱 及任意 OpenAI 兼容服务。Key 仅存本机浏览器。')}</p>
              </div>

              {/* 多账号矩阵（P2） */}
              <div className="space-y-2 pb-3 border-b border-white/[0.06]">
                <h4 className="font-semibold text-emerald-400">{_('多账号矩阵')}</h4>
                <div className="flex items-center gap-2">
                  <select
                    className="flex-1 px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                    value={accountPlatform}
                    onChange={e => { const pid = e.target.value as PlatformId; setAccountPlatform(pid); refreshAccounts(pid); }}
                  >
                    {(['wordpress', 'telegram', 'youtube', 'twitter', 'typecho', 'metaweblog', 'bluesky', 'mastodon', 'reddit', 'devto', 'hashnode'] as PlatformId[]).map((pid) => (
                      <option key={pid} value={pid}>{_(PLATFORMS.find((p) => p.id === pid)?.name || pid)}</option>
                    ))}
                  </select>
                </div>
                {accountsOfPlatform.length === 0 ? (
                  <p className="text-[10px] text-gray-500">{_('该平台暂无多账号。填好下方凭证后，点「保存当前配置为新账号」即可创建第一个账号。')}</p>
                ) : (
                  <div className="space-y-1.5">
                    {accountsOfPlatform.map((acc) => (
                      <div key={acc.id} className="flex items-center justify-between text-[11px] bg-[#090d15] rounded px-2 py-1.5">
                        <span className="text-gray-300 flex-1 truncate">{acc.name}{acc.id === activeAccountId && <span className="text-emerald-400">{_('（当前）')}</span>}</span>
                        {acc.id !== activeAccountId && (
                          <button onClick={() => switchPlatformAccount(accountPlatform, acc.id)} className="text-emerald-400 hover:text-emerald-300 text-[10px]">{_('切换')}</button>
                        )}
                        <button onClick={() => store.removeAccount(accountPlatform, acc.id).then(() => { refreshAccounts(accountPlatform); refreshAuth(); })} className="ml-2 text-red-400 hover:text-red-300 text-[10px]">{_('删除')}</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                    placeholder={_('新账号名称（如 公司号 / 个人号）')}
                    value={newAccountName}
                    onChange={e => setNewAccountName(e.target.value)}
                  />
                  <button onClick={addCurrentAsAccount} className="shrink-0 px-2.5 py-1.5 rounded text-[11px] border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10">{_('保存当前配置为新账号')}</button>
                </div>
                {activeAccountId && (
                  <button onClick={() => switchPlatformAccount(accountPlatform, null)} className="text-[10px] text-gray-500 hover:text-gray-300 underline">{_('切回默认配置')}</button>
                )}
                <p className="text-[10px] text-gray-500 leading-relaxed">{_('仅支持填凭证的平台（WordPress/Telegram/Bluesky 等）；微博、小红书等 cookie 登录平台一浏览器一账号，不支持多账号。')}</p>
              </div>

              {/* WordPress */}
              <div className="space-y-2">
                <h4 className="font-semibold text-indigo-400">WordPress (REST API)</h4>
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('站点地址 (例如 https://example.com)')}
                  value={settings.wordpress?.endpoint || ''}
                  onChange={e => setSettings({ ...settings, wordpress: { ...(settings.wordpress || { username: '' }), endpoint: e.target.value } })}
                />
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('用户名')}
                  value={settings.wordpress?.username || ''}
                  onChange={e => setSettings({ ...settings, wordpress: { ...(settings.wordpress || { endpoint: '' }), username: e.target.value } })}
                />
                <input
                  type="password"
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('应用程序密码 (Application Password)')}
                  value={settings.wordpress?.appPassword || ''}
                  onChange={e => setSettings({ ...settings, wordpress: { ...(settings.wordpress || { endpoint: '', username: '' }), appPassword: e.target.value } })}
                />
                <CredLink
                  note={_('申请指引：')}
                  text={_('后台「用户→个人资料→应用程序密码」生成')}
                  url={settings.wordpress?.endpoint ? `${settings.wordpress.endpoint.replace(/\/$/, '')}/wp-admin/profile.php#application-passwords` : undefined}
                />
              </div>

              {/* Typecho */}
              <div className="space-y-2 border-t border-white/[0.08] pt-3">
                <h4 className="font-semibold text-[#467B96] flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#467B96]"></span>Typecho (MetaWeblog XML-RPC)
                </h4>
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('站点地址 (例如 https://blog.example.com)')}
                  value={settings.typecho?.siteUrl || ''}
                  onChange={e => setSettings({ ...settings, typecho: { ...(settings.typecho || { username: '', password: '' }), siteUrl: e.target.value } })}
                />
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('XML-RPC 端点（可选，默认 站点/action/xmlrpc）')}
                  value={settings.typecho?.endpoint || ''}
                  onChange={e => setSettings({ ...settings, typecho: { ...(settings.typecho || { siteUrl: '', username: '', password: '' }), endpoint: e.target.value } })}
                />
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('用户名')}
                  value={settings.typecho?.username || ''}
                  onChange={e => setSettings({ ...settings, typecho: { ...(settings.typecho || { siteUrl: '', password: '' }), username: e.target.value } })}
                />
                <input
                  type="password"
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('密码')}
                  value={settings.typecho?.password || ''}
                  onChange={e => setSettings({ ...settings, typecho: { ...(settings.typecho || { siteUrl: '', username: '' }), password: e.target.value } })}
                />
                <CredLink
                  note={_('配置指引：')}
                  text={_('账号同后台登录，需启用 XML-RPC')}
                  url={settings.typecho?.siteUrl ? `${settings.typecho.siteUrl.replace(/\/$/, '')}/admin` : undefined}
                />
                <TestConn
                  label={_('测试连接')}
                  cls="border-[#467B96]/40 text-[#7FB8D4] hover:bg-[#467B96]/10"
                  disabled={!settings.typecho?.siteUrl || !settings.typecho?.username}
                  onClick={() => testConnection('typecho')}
                  status={connStatus.typecho}
                />
              </div>

              {/* MetaWeblog */}
              <div className="space-y-2 border-t border-white/[0.08] pt-3">
                <h4 className="font-semibold text-[#6B7280] flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#6B7280]"></span>{_('MetaWeblog (通用 XML-RPC)')}</h4>
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('站点地址 (例如 https://blog.example.com)')}
                  value={settings.metaweblog?.siteUrl || ''}
                  onChange={e => setSettings({ ...settings, metaweblog: { ...(settings.metaweblog || { username: '', password: '' }), siteUrl: e.target.value } })}
                />
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('XML-RPC 端点（可选，默认 站点/xmlrpc.php）')}
                  value={settings.metaweblog?.endpoint || ''}
                  onChange={e => setSettings({ ...settings, metaweblog: { ...(settings.metaweblog || { siteUrl: '', username: '', password: '' }), endpoint: e.target.value } })}
                />
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('用户名')}
                  value={settings.metaweblog?.username || ''}
                  onChange={e => setSettings({ ...settings, metaweblog: { ...(settings.metaweblog || { siteUrl: '', password: '' }), username: e.target.value } })}
                />
                <input
                  type="password"
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('密码')}
                  value={settings.metaweblog?.password || ''}
                  onChange={e => setSettings({ ...settings, metaweblog: { ...(settings.metaweblog || { siteUrl: '', username: '' }), password: e.target.value } })}
                />
                <CredLink
                  note={_('配置指引：')}
                  text={_('填博客后台账号密码，兼容 WordPress 等')}
                  url={settings.metaweblog?.siteUrl ? `${settings.metaweblog.siteUrl.replace(/\/$/, '')}/admin` : undefined}
                />
                <TestConn
                  label={_('测试连接')}
                  cls="border-gray-500/40 text-gray-300 hover:bg-gray-500/10"
                  disabled={!settings.metaweblog?.siteUrl || !settings.metaweblog?.username}
                  onClick={() => testConnection('metaweblog')}
                  status={connStatus.metaweblog}
                />
              </div>

              {/* Telegram */}
              <div className="space-y-2 border-t border-white/[0.08] pt-3">
                <h4 className="font-semibold text-indigo-400">Telegram (Bot API)</h4>
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('Bot Token (例如 123456:ABC-DEF)')}
                  value={settings.telegram?.botToken || ''}
                  onChange={e => setSettings({ ...settings, telegram: { ...(settings.telegram || { chatId: '' }), botToken: e.target.value } })}
                />
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('Chat ID / Channel (例如 @mychannel)')}
                  value={settings.telegram?.chatId || ''}
                  onChange={e => setSettings({ ...settings, telegram: { ...(settings.telegram || { botToken: '' }), chatId: e.target.value } })}
                />
                <CredLink
                  note={_('申请指引：')}
                  text={_('私聊 @BotFather 发送 /newbot 创建')}
                  url="https://t.me/BotFather"
                />
              </div>

              {/* Bluesky */}
              <div className="space-y-2 border-t border-white/[0.08] pt-3">
                <h4 className="font-semibold text-sky-400">Bluesky (AT Protocol)</h4>
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('Handle / Email (例如 alice.bsky.social)')}
                  value={settings.bluesky?.identifier || ''}
                  onChange={e => setSettings({ ...settings, bluesky: { ...(settings.bluesky || { appPassword: '' }), identifier: e.target.value } })}
                />
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('App Password (Bluesky 设置→应用密码 生成)')}
                  type="password"
                  value={settings.bluesky?.appPassword || ''}
                  onChange={e => setSettings({ ...settings, bluesky: { ...(settings.bluesky || { identifier: '' }), appPassword: e.target.value } })}
                />
                <CredLink
                  note={_('申请指引：')}
                  text={_('设置→App Passwords 生成应用密码')}
                  url="https://bsky.app/settings/app-passwords"
                />
                <TestConn
                  label={_('测试连接')}
                  cls="border-sky-500/30 text-sky-300 hover:bg-sky-500/10"
                  disabled={!settings.bluesky?.identifier || !settings.bluesky?.appPassword}
                  onClick={() => testConnection('bluesky')}
                  status={connStatus.bluesky}
                />
              </div>

              {/* Dev.to */}
              <div className="space-y-2 border-t border-white/[0.08] pt-3">
                <h4 className="font-semibold text-gray-300 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-black border border-white/30"></span>Dev.to (Forem API)
                </h4>
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('API Key (dev.to/settings/extensions 生成)')}
                  type="password"
                  value={settings.devto?.apiKey || ''}
                  onChange={e => setSettings({ ...settings, devto: { apiKey: e.target.value } })}
                />
                <CredLink
                  note={_('申请指引：')}
                  text={_('Settings→API Keys 生成')}
                  url="https://dev.to/settings/extensions"
                />
                <TestConn
                  label={_('测试连接')}
                  cls="border-gray-500/30 text-gray-300 hover:bg-gray-500/10"
                  disabled={!settings.devto?.apiKey}
                  onClick={() => testConnection('devto')}
                  status={connStatus.devto}
                />
              </div>

              {/* Hashnode */}
              <div className="space-y-2 border-t border-white/[0.08] pt-3">
                <h4 className="font-semibold text-blue-400 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#2962FF]"></span>Hashnode (GraphQL, Pro required)
                </h4>
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('Personal Access Token (需 Pro 订阅)')}
                  type="password"
                  value={settings.hashnode?.apiKey || ''}
                  onChange={e => setSettings({ ...settings, hashnode: { ...(settings.hashnode || { publicationId: '' }), apiKey: e.target.value } })}
                />
                <CredLink
                  note={_('申请指引：')}
                  text={_('设置→Developer 生成 Token')}
                  url="https://hashnode.com/settings/developer"
                />
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('publicationId (博客的 GraphQL id)')}
                  value={settings.hashnode?.publicationId || ''}
                  onChange={e => setSettings({ ...settings, hashnode: { ...(settings.hashnode || { apiKey: '' }), publicationId: e.target.value } })}
                />
                <CredLink
                  note={_('publicationId 可留空：')}
                  text={_('发文时自动匹配，点此打开博客管理页')}
                  url="https://hashnode.com/dashboard"
                />
                <TestConn
                  label={_('测试连接')}
                  cls="border-blue-500/30 text-blue-300 hover:bg-blue-500/10"
                  disabled={!settings.hashnode?.apiKey}
                  onClick={() => testConnection('hashnode')}
                  status={connStatus.hashnode}
                />
              </div>

              {/* Mastodon */}
              <div className="space-y-2 border-t border-white/[0.08] pt-3">
                <h4 className="font-semibold text-violet-400">{_('Mastodon (联邦宇宙)')}</h4>
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('实例地址 (例如 mastodon.social)')}
                  value={settings.mastodon?.instance || ''}
                  onChange={e => setSettings({ ...settings, mastodon: { ...(settings.mastodon || { accessToken: '' }), instance: e.target.value } })}
                />
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('Access Token (设置→开发→新应用 创建)')}
                  type="password"
                  value={settings.mastodon?.accessToken || ''}
                  onChange={e => setSettings({ ...settings, mastodon: { ...(settings.mastodon || { instance: '' }), accessToken: e.target.value } })}
                />
                <CredLink
                  note={_('接入指引：')}
                  text={_('实例「设置→开发→新应用」创建 Token')}
                  url={settings.mastodon?.instance ? `https://${settings.mastodon.instance}/settings/applications` : undefined}
                />
                <TestConn
                  label={_('测试连接')}
                  cls="border-violet-500/30 text-violet-300 hover:bg-violet-500/10"
                  disabled={!settings.mastodon?.instance || !settings.mastodon?.accessToken}
                  onClick={() => testConnection('mastodon')}
                  status={connStatus.mastodon}
                />
              </div>

              {/* Reddit */}
              <div className="space-y-2 border-t border-white/[0.08] pt-3">
                <h4 className="font-semibold text-orange-400">{_('Reddit (已登录浏览器会话)')}</h4>
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder={_('目标板块 subreddit (例如 test 或 u_用户名)')}
                  value={settings.reddit?.subreddit || ''}
                  onChange={e => setSettings({ ...settings, reddit: { subreddit: e.target.value } })}
                />
                <TestConn
                  label={_('测试连接')}
                  cls="border-orange-500/30 text-orange-300 hover:bg-orange-500/10"
                  disabled={!settings.reddit?.subreddit}
                  onClick={() => testConnection('reddit')}
                  status={connStatus.reddit}
                />
                <CredLink
                  note={_('使用说明：')}
                  text={_('登录 reddit.com 后即可发文（复用浏览器会话）')}
                  url="https://www.reddit.com/login"
                />
              </div>

              {/* YouTube */}
              <div className="space-y-2 border-t border-white/[0.08] pt-3">
                <h4 className="font-semibold text-[#FF0000] flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#FF0000]"></span>YouTube (Data API v3)
                </h4>
                <input
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder="OAuth Client ID (Google Cloud Console)"
                  value={settings.youtube?.clientId || ''}
                  onChange={e => setSettings({ ...settings, youtube: { ...(settings.youtube || {}), clientId: e.target.value } })}
                />
                <input
                  type="password"
                  className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white"
                  placeholder="Client Secret"
                  value={settings.youtube?.clientSecret || ''}
                  onChange={e => setSettings({ ...settings, youtube: { ...(settings.youtube || {}), clientSecret: e.target.value } })}
                />
                <CredLink
                  note={_('申请指引：')}
                  text={_('Google Cloud Console 创建 OAuth 客户端（选「网页应用」）')}
                  url="https://console.cloud.google.com/apis/credentials"
                />
                {(() => { const u = (() => { try { return chrome.identity?.getRedirectURL?.(); } catch { return ''; } })() || ''; return u ? (
                  <div className="space-y-0.5 text-[10px]">
                    <button
                      type="button"
                      onClick={() => { try { navigator.clipboard.writeText(u); safeToast(_('回调地址已复制，请粘贴到 Google Cloud Console 授权回调 URL')); } catch { /* ignore */ } }}
                      className="text-sky-400 hover:text-sky-300 inline-flex items-center gap-1"
                    >
                      <span aria-hidden className="flex-shrink-0">🔗</span>
                      <span className="underline underline-offset-2">{_('复制 OAuth 回调地址')}</span>
                    </button>
                    <div className="font-mono text-gray-500 break-all leading-relaxed">{u}</div>
                  </div>
                ) : null; })()}
                <button
                  onClick={authorizeYouTube}
                  disabled={!settings.youtube?.clientId || !settings.youtube?.clientSecret}
                  className="w-full py-2 bg-[#FF0000]/90 hover:bg-[#FF0000] disabled:opacity-40 rounded-lg text-white font-semibold text-[12px] transition"
                >{_('🔗 授权 Google 账号（上传视频）')}</button>
                {ytStatus && (
                  <div className="text-[10px] text-gray-400 font-mono leading-relaxed">{ytStatus}</div>
                )}
                {settings.youtube?.accessToken && (
                  <div className="text-[10px] text-emerald-400">{_('✅ 已授权（token 有效期至')} {settings.youtube.expiresAt ? new Date(settings.youtube.expiresAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US') : _('未知')}{_('，过期自动刷新）')}</div>
                )}
              </div>

              {/* Bridge Token */}
              <div className="space-y-2 border-t border-white/[0.08] pt-3">
                <h4 className="font-semibold text-indigo-400">{_('网页同步 Bridge Token')}</h4>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    className="w-full px-2.5 py-1.5 bg-[#090d15] border border-white/[0.08] rounded text-white font-mono text-[11px]"
                    value={bridgeToken || _('（首次打开自动生成）')}
                  />
                  <button
                    onClick={() => navigator.clipboard.writeText(bridgeToken)}
                    className="px-2 py-1.5 bg-white/[0.06] hover:bg-white/[0.12] rounded text-[11px] text-indigo-400 whitespace-nowrap"
                  >{_('复制')}</button>
                </div>
                <p className="text-[10px] text-gray-500">{_('网页调用 window.syncPost({ title, body }) 时需携带该 token，防止任意网站触发同步。')}</p>
              </div>
            </div>

            <div className="p-3 border-t border-white/[0.08] bg-[#0c0f17]">
              <button
                onClick={saveSettingsHandler}
                className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-semibold text-[12px]"
              >{_('保存设置')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 5: Rich Markdown Real Preview Modal */}
      <PreviewModal
        isOpen={showPreviewModal}
        onClose={() => {
          setShowPreviewModal(false);
        }}
        title={title}
        body={body}
        mediaList={mediaList}
        onSave={handlePreviewModalSave}
        lang={lang}
      />
    </div>
  );
}
