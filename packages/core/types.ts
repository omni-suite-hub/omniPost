export type PlatformId = 
  // —— 已有平台 ——
  | 'weibo' 
  | 'xiaohongshu' 
  | 'bilibili' 
  | 'zhihu' 
  | 'wordpress' 
  | 'twitter' 
  | 'youtube' 
  | 'telegram'
  // —— 对标"文章同步助手"新增（API 直连）——
  | 'juejin'          // 掘金
  | 'baijiahao'       // 百家号
  | 'csdn'            // CSDN
  | 'yuque'           // 语雀
  | 'douban'          // 豆瓣
  | 'sohu'            // 搜狐号
  | 'xueqiu'          // 雪球
  | 'weixin'          // 微信公众号
  | 'woshipm'         // 人人都是产品经理
  | 'cto51'           // 51CTO
  | 'imooc'           // 慕课手记
  | 'oschina'         // 开源中国
  | 'segmentfault'    // 思否
  | 'cnblogs'         // 博客园
  | 'eastmoney'       // 东方财富
  | 'zip-download'    // Markdown 压缩包（本地导出，非平台）
  // —— CMS 自建站 ——
  | 'typecho'         // Typecho（MetaWeblog）
  | 'metaweblog'      // 通用 MetaWeblog
  // —— 海外社交平台（对标主流社交）——
  | 'bluesky'         // Bluesky（AT Protocol）
  | 'mastodon'        // Mastodon（联邦宇宙）
  | 'reddit'          // Reddit（session cookie 直连）
  // —— 海外内容/技术社区（API 直连）——
  | 'devto'           // Dev.to（Forem REST API，免费）
  | 'hashnode'        // Hashnode（GraphQL，需 Pro）
  // —— 国内资讯平台 ——
  | 'toutiao'         // 今日头条（头条号 API 直连）
  // —— 半自动平台（无公开 API，逆向端点待真实账号抓包）——
  | 'jianshu'         // 简书
  | 'netease'         // 网易号
  | 'douyin'          // 抖音图文
  | 'dayu'            // 大鱼号
  | 'yidian'          // 一点号
  | 'smzdm'           // 什么值得买
  | 'sohufocus';      // 搜狐焦点

export interface MediaItem {
  id: string;
  name: string;
  type: string; // 'image/jpeg', 'video/mp4', etc.
  size: number;
  dataUrl?: string; // base64 or blob URL
  file?: File;
}

export interface Article {
  id?: string;
  title?: string;
  body: string;            // Markdown or HTML
  media?: MediaItem[];     // Images / Videos
  mediaRefs?: MediaRef[];  // 已上传成功的媒体引用（由 uploadMedia 产生，传给 createDraft）
  link?: string;
  tags?: string[];
  category?: string;
}

export interface MediaRef { 
  id: string; 
  url: string;
  type?: string;
  dataUrl?: string;  // 保留原始媒体数据，供 publish 阶段真实上传（official 平台）
}

export interface DraftRef { 
  platformId: PlatformId; 
  draftId: string; 
  title?: string;
  url?: string;
  previewText?: string;
  body?: string;           // 完整正文（发布阶段需要，避免被 previewText 截断）
  mediaRefs?: MediaRef[];  // 已登记/已上传的媒体引用（发布阶段传给 publish 真实发送）
  tabId?: number;          // session 平台：本次注入使用的编辑页 tab（publish 定位/发布后关闭用）
  createdAt?: number;
}

export interface PublishResult {
  platformId: PlatformId;
  ok: boolean;
  url?: string;
  error?: string;
  draftId?: string;
  timestamp: number;
  /** 半自动模式：仅建草稿（未调 publish API），需用户手动点发布 */
  draftOnly?: boolean;
  /** 半自动平台专用：内容未写入平台（平台无草稿/直发接口），需用户打开页面后手动粘贴发布。
   *  与 draftOnly 的区别：draftOnly=平台侧已有真实草稿；manualOnly=平台侧什么都没有。 */
  manualOnly?: boolean;
}

export interface PlatformAccount {
  loggedIn: boolean;
  account?: string;
  username?: string;  // 展示名（登录态增强，API 直连模式返回）
  avatar?: string;
  lastChecked?: number;
  error?: string;
}

/** 平台实现模式：api=私有 API 直连（对标文章同步助手）；session=打开编辑页 DOM 模拟；official=官方开放 API */
export type AdapterMode = 'api' | 'session' | 'official';

export interface PlatformAdapter {
  id: PlatformId;
  name: string;
  region: 'domestic' | 'international';
  contentTypes: ('text' | 'image' | 'video' | 'article')[];
  route: 'session' | 'official';
  mode: AdapterMode;          // 发布机制：API 直连 / DOM 模拟 / 官方 API
  homepage?: string;          // 未登录时引导跳转的登录页
  icon?: string;
  capabilities?: string[];    // 平台能力：draft/image_upload/cover/tags 等
  /** 平台风格描述（供 AI 多平台风格自适应改写，见 P0） */
  stylePrompt?: string;
  /** 半自动平台标记（豁免后台登录态强校验，直接创建跳转草稿） */
  semiAuto?: boolean;
  /** 平台无远程草稿概念（如 Telegram/Bluesky/Mastodon/Reddit：createDraft 仅本地暂存）。
   *  半自动发布模式（只建草稿）下必须为这些平台报错拦截，否则会假成功丢稿。 */
  noRemoteDraft?: boolean;
  /** createDraft 即真实发布（如 Hashnode publishPost）：半自动模式下不按「已存草稿」标记 */
  draftIsPublished?: boolean;

  checkLogin(): Promise<PlatformAccount>;
  uploadMedia?(media: MediaItem, onProgress?: (p: number) => void): Promise<MediaRef>;
  createDraft(article: Article): Promise<DraftRef>;
  publish(draft: DraftRef, opts?: { immediate?: boolean }): Promise<PublishResult>;
}

/** 平台元信息（供 popup 平台列表展示，与 PlatformAdapter 解耦） */
export interface PlatformMeta {
  id: PlatformId;
  name: string;
  icon?: string;
  homepage?: string;
  mode: AdapterMode;
  isAuthenticated?: boolean;
  username?: string;
  error?: string;
}

export interface PublishProgress {
  platformId: PlatformId;
  platformName: string;
  stage: 'idle' | 'checking' | 'uploading' | 'drafting' | 'publishing' | 'done' | 'failed';
  progress?: number;
  message?: string;
  result?: PublishResult;
  draft?: DraftRef;
}

export interface PublishHistoryRecord {
  id: string;
  title: string;
  body: string;
  timestamp: number;
  results: PublishResult[];
}

/** 从网页提取的文章（正文提取器输出，供 popup / MCP / fab 复用） */
export interface ExtractedArticle {
  title: string;
  /** Markdown 正文 */
  markdown: string;
  /** 原始 HTML（可选，某些平台需要） */
  html?: string;
  /** 封面图 URL */
  cover?: string;
  /** 摘要 */
  summary?: string;
  url: string;
  /** 提取来源平台标识（weixin / generic） */
  platform: string;
}

/** 定时发布队列项（P1） */
export interface ScheduledItem {
  id: string;
  article: Article;
  platformIds: PlatformId[];
  scheduledAt: number;
  aiRewrite: boolean;
  createdAt: number;
  lastError?: string;
  /** 周期：once=发一次 | daily=每天 | weekly=每周 */
  repeat?: 'once' | 'daily' | 'weekly';
  /** 内容来源：fixed=固定内容 | ai=到点按 topic AI 生成（内容每次不同） */
  contentMode?: 'fixed' | 'ai';
  /** AI 生成主题/选题（contentMode=ai 时必填） */
  topic?: string;
  /** 排期时各平台的活跃账号 ID 映射（防切换账号后串号发送） */
  activeAccounts?: Partial<Record<PlatformId, string>>;
}
