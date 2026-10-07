import { PlatformAdapter, PlatformId } from '@omnipost/core';
import { weiboAdapter } from './weibo';
import { xiaohongshuAdapter } from './xiaohongshu';
import { bilibiliAdapter } from './bilibili';
import { zhihuAdapter } from './zhihu';
import { wordpressAdapter } from './wordpress';
import { twitterAdapter } from './twitter';
import { youtubeAdapter } from './youtube';
import { telegramAdapter } from './telegram';
import { juejinAdapter } from './juejin';
import { csdnAdapter } from './csdn';
import { yuqueAdapter } from './yuque';
import { segmentfaultAdapter } from './segmentfault';
import { cnblogsAdapter } from './cnblogs';
import { oschinaAdapter } from './oschina';
import { doubanAdapter } from './douban';
import { sohuAdapter } from './sohu';
import { baijiahaoAdapter } from './baijiahao';
import { eastmoneyAdapter } from './eastmoney';
import { xueqiuAdapter } from './xueqiu';
import { weixinAdapter } from './weixin';
import { woshipmAdapter } from './woshipm';
import { cto51Adapter } from './cto51';
import { imoocAdapter } from './imooc';
import { zipDownloadAdapter } from './zip-download';
import { metaweblogAdapter } from './metaweblog';
import { typechoAdapter } from './typecho';
import { blueskyAdapter } from './bluesky';
import { mastodonAdapter } from './mastodon';
import { redditAdapter } from './reddit';
import { devtoAdapter } from './devto';
import { hashnodeAdapter } from './hashnode';
import { toutiaoAdapter } from './toutiao';
import { makeSemiAutoAdapter } from './semi-auto';

/**
 * 平台注册表。
 * 注意：PlatformId 已扩展 16 个新平台 + 2 个 CMS（对标"文章同步助手"），
 * 未实现前用 Partial 保证类型安全——缺失平台返回 undefined，调用方必须判空。
 */
export const adapters: Partial<Record<PlatformId, PlatformAdapter>> = {
  weibo: weiboAdapter,
  xiaohongshu: xiaohongshuAdapter,
  bilibili: bilibiliAdapter,
  zhihu: zhihuAdapter,
  wordpress: wordpressAdapter,
  twitter: twitterAdapter,
  youtube: youtubeAdapter,
  telegram: telegramAdapter,
  // Phase C C1：8 个主流内容平台（API 直连，对标"文章同步助手"）
  juejin: juejinAdapter,
  csdn: csdnAdapter,
  yuque: yuqueAdapter,
  segmentfault: segmentfaultAdapter,
  cnblogs: cnblogsAdapter,
  oschina: oschinaAdapter,
  douban: doubanAdapter,
  sohu: sohuAdapter,
  // Phase C C2：7 个垂直平台（API 直连，对标"文章同步助手"）
  baijiahao: baijiahaoAdapter,
  eastmoney: eastmoneyAdapter,
  xueqiu: xueqiuAdapter,
  weixin: weixinAdapter,
  woshipm: woshipmAdapter,
  cto51: cto51Adapter,
  imooc: imoocAdapter,
  // Phase C C3：本地导出 + CMS（zip 下载 / 通用 MetaWeblog / Typecho）
  'zip-download': zipDownloadAdapter,
  typecho: typechoAdapter,
  metaweblog: metaweblogAdapter,
  // 海外社交平台（API 直连，对标主流社交）
  bluesky: blueskyAdapter,
  mastodon: mastodonAdapter,
  reddit: redditAdapter,
  // 海外内容/技术社区（API 直连）
  devto: devtoAdapter,
  hashnode: hashnodeAdapter,
  // 国内资讯平台（API 直连）
  toutiao: toutiaoAdapter,
  // 半自动平台（无公开 API，逆向端点待真实账号抓包）
  jianshu: makeSemiAutoAdapter({ id: 'jianshu', name: '简书', region: 'domestic', contentTypes: ['article'], stylePrompt: '简书风格：文学/生活/技术随笔，中文，排版清爽，标题简洁有韵味。', homepage: 'https://www.jianshu.com/', publishUrl: 'https://www.jianshu.com/writer' }),
  netease: makeSemiAutoAdapter({ id: 'netease', name: '网易号', region: 'domestic', contentTypes: ['article'], stylePrompt: '网易号风格：中文资讯，标题有看点，正文客观中立、分段清晰。', homepage: 'https://mp.163.com/', publishUrl: 'https://mp.163.com/' }),
  douyin: makeSemiAutoAdapter({ id: 'douyin', name: '抖音图文', region: 'domestic', contentTypes: ['article', 'image'], stylePrompt: '抖音图文风格：口语化、短句、多 emoji，配图为主，文案精炼。纯文本排版，严禁 Markdown 语法。字数严格限制：作品标题最多 20 字；作品描述（正文+话题标签合计）最多 1000 字，正文需为文末 2-3 个 #话题 预留约 30 字空间。', homepage: 'https://creator.douyin.com/', publishUrl: 'https://creator.douyin.com/creator-micro/content/upload' }),
  dayu: makeSemiAutoAdapter({ id: 'dayu', name: '大鱼号', region: 'domestic', contentTypes: ['article'], stylePrompt: '大鱼号风格：中文资讯，标题吸引点击，正文分段清晰。', homepage: 'https://mp.dayu.com/', publishUrl: 'https://mp.dayu.com/' }),
  yidian: makeSemiAutoAdapter({ id: 'yidian', name: '一点号', region: 'domestic', contentTypes: ['article'], stylePrompt: '一点号风格：中文资讯，标题精炼，正文客观。', homepage: 'https://mp.yidianzixun.com/', publishUrl: 'https://mp.yidianzixun.com/' }),
  smzdm: makeSemiAutoAdapter({ id: 'smzdm', name: '什么值得买', region: 'domestic', contentTypes: ['article'], stylePrompt: '什么值得买风格：种草/评测口吻，突出性价比与体验，口语化。', homepage: 'https://www.smzdm.com/', publishUrl: 'https://post.smzdm.com/' }),
  sohufocus: makeSemiAutoAdapter({ id: 'sohufocus', name: '搜狐焦点', region: 'domestic', contentTypes: ['article'], stylePrompt: '搜狐焦点风格：房产/资讯，客观专业，标题有信息量。', homepage: 'https://mp.focus.cn/', publishUrl: 'https://mp.focus.cn/' }),
};

export function getAdapter(platformId: PlatformId): PlatformAdapter | undefined {
  return adapters[platformId];
}

export function getAllAdapters(): PlatformAdapter[] {
  return Object.values(adapters).filter((a): a is PlatformAdapter => !!a);
}
