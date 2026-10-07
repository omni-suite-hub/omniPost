/**
 * 微信公众号 (weixin) adapter —— API 直连（对标"文章同步助手"）。
 *
 * 机制：不打开编辑页。background 带 cookie 调用 mp.weixin.qq.com 私有 API：
 *  1. checkLogin: GET https://mp.weixin.qq.com/ → 从 HTML data 对象挖 token/ticket/user_name 等
 *  2. 图片上传:   FormData(file) → POST /cgi-bin/filetransfer?action=upload_material → cdn_url
 *  3. 建草稿:     POST /cgi-bin/operate_appmsg?sub=create&type=77（全字段 urlencoded，token 头/URL）
 *
 * 内容处理（微信编辑器要求）：
 *  - 剥离非微信域名外链（仅保留文字）；
 *  - 图片走 mmbiz CDN（跳过 mmbiz.qpic.cn / mmbiz.qlogo.cn）；
 *  - 默认 CSS 行内化（微信编辑器会剥离 <style>），外包 <section>。
 *
 * 请求经 declarativeNetRequest 注入 Origin/Referer（mp.weixin.qq.com）。
 */
import { PlatformAdapter, Article, MediaItem, MediaRef, DraftRef, PublishResult, PlatformAccount } from '@omnipost/core';
import { apiFetch, withHeaderRules, parseJson } from './api-client';
import { processImages, dataUriToBlob, pubResult, ImageUploadResult } from './api-base';
import { md2html } from './md2html';
import { previewOf } from './utils';

const HEADER_RULES = [
  { urlFilter: '*://mp.weixin.qq.com/cgi-bin/*', headers: { Origin: 'https://mp.weixin.qq.com', Referer: 'https://mp.weixin.qq.com/' } },
];

interface WeixinMeta {
  token: string;
  userName: string;
  nickName: string;
  ticket: string;
  svrTime: number;
  avatar: string;
}

let cachedMeta: WeixinMeta | null = null;

/** 从公众号首页 HTML 挖会话凭证（token/ticket/user_name 等） */
async function ensureMeta(): Promise<WeixinMeta> {
  if (cachedMeta) return cachedMeta;
  const res = await apiFetch('https://mp.weixin.qq.com/');
  const html = await res.text();

  const tokenMatch = html.match(/data:\s*\{[\s\S]*?t:\s*["']([^"']+)["']/);
  const userNameMatch = html.match(/user_name:\s*["']([^"']+)["']/);
  const nickNameMatch = html.match(/nick_name:\s*["']([^"']+)["']/);
  // 未登录的登录页 JS 里也可能含 data.t 字段，但绝无 user_name/nick_name —— 以此为登录判据，防假成功
  if (!tokenMatch || (!userNameMatch && !nickNameMatch)) throw new Error('请先登录微信公众号');

  const ticketMatch = html.match(/ticket:\s*["']([^"']+)["']/);
  const timeMatch = html.match(/time:\s*["'](\d+)["']/);
  const headImgMatch = html.match(/head_img:\s*['"]([^'"]+)['"]/);
  const avatarMatch = html.match(/class="weui-desktop-account__thumb"[^>]*src="([^"]+)"/);
  let avatar = avatarMatch ? avatarMatch[1] : headImgMatch ? headImgMatch[1] : '';
  if (avatar.startsWith('http://')) avatar = avatar.replace('http://', 'https://');

  cachedMeta = {
    token: tokenMatch[1],
    userName: userNameMatch ? userNameMatch[1] : '',
    nickName: nickNameMatch ? nickNameMatch[1] : '',
    ticket: ticketMatch ? ticketMatch[1] : '',
    svrTime: timeMatch ? Number(timeMatch[1]) : Date.now() / 1000,
    avatar,
  };
  return cachedMeta;
}

/** LaTeX → codecogs 图片（微信公众号不支持原生公式） */
function isLatexFormula(text: string): boolean {
  if (/[\\^_{}]/.test(text)) return true;
  if (/[α-ωΑ-Ω]/.test(text)) return true;
  if (/[∑∏∫∂∇∞≠≤≥±×÷√]/.test(text)) return true;
  return false;
}

function processLatex(content: string): string {
  let out = content.replace(/\$\$([^$]+)\$\$/g, (match, latex) => {
    if (!isLatexFormula(latex)) return match;
    const encoded = encodeURIComponent(latex.trim());
    return `<p style="text-align: center;"><img src="https://latex.codecogs.com/png.latex?\\dpi{150}${encoded}" alt="formula" style="vertical-align: middle; max-width: 100%;"></p>`;
  });
  out = out.replace(/\$([^$]+)\$/g, (match, latex) => {
    if (!isLatexFormula(latex)) return match;
    const encoded = encodeURIComponent(latex.trim());
    return `<img src="https://latex.codecogs.com/png.latex?\\dpi{120}${encoded}" alt="formula" style="vertical-align: middle;">`;
  });
  return out;
}

/** 剥离外部链接：非微信域名的 <a> 只保留文字 */
export function stripExternalLinks(content: string): string {
  return content.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, href, text) => {
    if (
      href &&
      (href.includes('mp.weixin.qq.com') ||
        href.includes('weixin.qq.com') ||
        href.startsWith('#') ||
        href.startsWith('javascript:'))
    ) {
      return match;
    }
    return text;
  });
}

/** 微信默认 CSS 行内化（微信编辑器会剥离 <style>，参考实现用 juice.inlineContent；此处零依赖等价实现） */
export function applyWeixinCss(html: string): string {
  const RULES: Array<[string, string]> = [
    ['p', 'color: rgb(51, 51, 51); font-size: 15px; line-height: 1.75em; margin: 0 0 1em 0;'],
    ['h1', 'font-weight: bold; font-size: 1.25em; line-height: 1.4em; margin: 1em 0 0.5em 0;'],
    ['h2', 'font-weight: bold; font-size: 1.125em; margin: 1em 0 0.5em 0;'],
    ['h3', 'font-weight: bold; font-size: 1.05em; margin: 0.8em 0 0.4em 0;'],
    ['h4', 'font-weight: bold; font-size: 1em; margin: 0.8em 0 0.4em 0;'],
    ['h5', 'font-weight: bold; font-size: 1em; margin: 0.8em 0 0.4em 0;'],
    ['h6', 'font-weight: bold; font-size: 1em; margin: 0.8em 0 0.4em 0;'],
    ['ul', 'margin: 1em 0; padding-left: 2em;'],
    ['ol', 'margin: 1em 0; padding-left: 2em;'],
    ['li', 'margin-bottom: 0.4em;'],
    ['pre', 'font-family: monospace; white-space: pre; margin: 1em 0;'],
    ['code', 'font-family: monospace;'],
    ['blockquote', 'border-left: 4px solid #ddd; padding-left: 1em; margin: 1em 0; color: #666;'],
    ['strong', 'font-weight: bolder;'],
    ['b', 'font-weight: bolder;'],
    ['em', 'font-style: italic;'],
    ['i', 'font-style: italic;'],
  ];
  let out = html.replace(/<hr\/?>/g, '<hr style="border: none; border-top: 1px solid #ddd; margin: 1.5em 0;" />');
  for (const [tag, style] of RULES) {
    // 负向前瞻：已有 style 属性的标签（如 LaTeX 生成的居中 <p>）不再重复注入
    out = out.replace(new RegExp(`<${tag}(?![^>]*style=)(?=[ >])`, 'g'), `<${tag} style="${style}"`);
  }
  return `<section style="margin-left: 6px; margin-right: 6px; line-height: 1.75em;">${out}</section>`;
}

/** 微信公众号 API 错误码 → 可读文案 */
function formatWeixinError(ret: number): string {
  const errorMap: Record<number, string> = {
    [-6]: '请输入验证码',
    [-8]: '请输入验证码',
    [-1]: '系统错误，请注意备份内容后重试',
    [-2]: '参数错误，请注意备份内容后重试',
    [-5]: '服务错误，请注意备份内容后重试',
    [-99]: '内容超出字数，请调整',
    [-206]: '服务负荷过大，请稍后重试',
    [200002]: '参数错误，请注意备份内容后重试',
    [200003]: '登录态超时，请重新登录',
    [412]: '图文中含非法外链',
    [62752]: '可能含有具备安全风险的链接，请检查',
    [64502]: '你输入的微信号不存在',
    [64505]: '发送预览失败，请稍后再试',
    [64506]: '保存失败，链接不合法',
    [64507]: '内容不能包含外部链接',
    [64562]: '请勿插入非微信域名的链接',
    [64509]: '正文中不能包含超过3个视频',
    [64515]: '当前素材非最新内容，请重新打开并编辑',
    [64702]: '标题超出64字长度限制',
    [64703]: '摘要超出120字长度限制',
    [64705]: '内容超出字数，请调整',
    [10806]: '正文不能有违规内容，请重新编辑',
    [10807]: '内容不能违反公众平台协议',
    [220001]: '素材管理中的存储数量已达上限',
    [220002]: '图片库已达到存储上限',
  };
  return errorMap[ret] || `同步失败 (错误码: ${ret})`;
}

async function uploadWeixinImage(blob: Blob): Promise<string> {
  const meta = await ensureMeta();
  const form = new FormData();
  const timestamp = Date.now();
  const filename = `${timestamp}.jpg`;
  form.append('type', blob.type || 'image/jpeg');
  form.append('id', String(timestamp));
  form.append('name', filename);
  form.append('lastModifiedDate', new Date().toString());
  form.append('size', String(blob.size));
  form.append('file', blob, filename);

  const res = await apiFetch(
    `https://mp.weixin.qq.com/cgi-bin/filetransfer?action=upload_material&f=json&scene=8&writetype=doublewrite&groupid=1&ticket_id=${meta.userName}&ticket=${meta.ticket}&svr_time=${meta.svrTime}&token=${meta.token}&lang=zh_CN&seq=${Date.now()}&t=${Math.random()}`,
    { method: 'POST', body: form },
  );
  const data = await parseJson<{ cdn_url?: string; base_resp?: { err_msg?: string; ret?: number } }>(res, '微信公众号图片上传');
  if (data.base_resp?.err_msg !== 'ok' || !data.cdn_url) {
    throw new Error(`图片上传失败: ${data.base_resp?.err_msg || '未知错误'}`);
  }
  return data.cdn_url;
}

async function uploadBySrc(src: string): Promise<ImageUploadResult> {
  const blob = src.startsWith('data:') ? await dataUriToBlob(src) : await apiFetch(src).then((r) => r.blob());
  const url = await uploadWeixinImage(blob);
  return { url };
}

export const weixinAdapter: PlatformAdapter = {
  id: 'weixin',
  name: '微信公众号',
  region: 'domestic',
  contentTypes: ['article', 'image'],
  route: 'session',
  stylePrompt: '微信公众号风格：标题抓人，开头引入入胜，正文排版分段，结尾引导关注。',
  mode: 'api',
  homepage: 'https://mp.weixin.qq.com',
  capabilities: ['article', 'draft', 'image_upload'],

  async checkLogin(): Promise<PlatformAccount> {
    try {
      const meta = await ensureMeta();
      return { loggedIn: true, account: meta.nickName, username: meta.nickName, avatar: meta.avatar || undefined };
    } catch {
      cachedMeta = null;
      return { loggedIn: false };
    }
  },

  async uploadMedia(media: MediaItem): Promise<MediaRef> {
    if (!media.dataUrl) throw new Error('微信公众号图片缺少 dataUrl');
    const blob = await dataUriToBlob(media.dataUrl);
    const url = await withHeaderRules(HEADER_RULES, () => uploadWeixinImage(blob));
    return { id: 'weixin_media_' + Date.now(), url, type: media.type };
  },

  async createDraft(article: Article): Promise<DraftRef> {
    return withHeaderRules(HEADER_RULES, async () => {
      const meta = await ensureMeta();

      // 内容管线：markdown → HTML → LaTeX → 外链剥离 → 图片上传 → 行内 CSS
      let content = md2html(article.body || '');
      content = processLatex(content);
      content = stripExternalLinks(content);
      content = await processImages(content, uploadBySrc, {
        skipPatterns: ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn'],
      });
      for (const ref of article.mediaRefs || []) {
        if (ref.url) content += `<p><img src="${ref.url}" /></p>`;
      }
      content = applyWeixinCss(content);

      const finalTitle = article.title?.trim() || previewOf(article.body, 30) || '公众号图文';
      const form = new URLSearchParams({
        token: meta.token,
        lang: 'zh_CN',
        f: 'json',
        ajax: '1',
        random: String(Math.random()),
        AppMsgId: '',
        count: '1',
        data_seq: '0',
        operate_from: 'Chrome',
        isnew: '0',
        ad_video_transition0: '',
        can_reward0: '0',
        related_video0: '',
        is_video_recommend0: '-1',
        title0: finalTitle,
        author0: '',
        writerid0: '0',
        fileid0: '',
        digest0: '',
        auto_gen_digest0: '1',
        content0: content,
        sourceurl0: '',
        need_open_comment0: '1',
        only_fans_can_comment0: '0',
        cdn_url0: '',
        cdn_235_1_url0: '',
        cdn_1_1_url0: '',
        cdn_url_back0: '',
        crop_list0: '',
        music_id0: '',
        video_id0: '',
        voteid0: '',
        voteismlt0: '',
        supervoteid0: '',
        cardid0: '',
        cardquantity0: '',
        cardlimit0: '',
        vid_type0: '',
        show_cover_pic0: '0',
        shortvideofileid0: '',
        copyright_type0: '0',
        releasefirst0: '',
        platform0: '',
        reprint_permit_type0: '',
        allow_reprint0: '',
        allow_reprint_modify0: '',
        original_article_type0: '',
        ori_white_list0: '',
        free_content0: '',
        fee0: '0',
        ad_id0: '',
        guide_words0: '',
        is_share_copyright0: '0',
        share_copyright_url0: '',
        source_article_type0: '',
        reprint_recommend_title0: '',
        reprint_recommend_content0: '',
        share_page_type0: '0',
        share_imageinfo0: '{"list":[]}',
        share_video_id0: '',
        dot0: '{}',
        share_voice_id0: '',
        insert_ad_mode0: '',
        categories_list0: '[]',
      });
      const res = await apiFetch(
        `https://mp.weixin.qq.com/cgi-bin/operate_appmsg?t=ajax-response&sub=create&type=77&token=${meta.token}&lang=zh_CN`,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form },
      );
      const data = await parseJson<{ appMsgId?: string; ret?: number; base_resp?: { ret?: number; err_msg?: string } }>(
        res,
        '微信公众号保存草稿',
      );
      if (!data.appMsgId) {
        cachedMeta = null; // Token 或凭证失效时清空内存缓存，允许后续重试
        const ret = data.ret ?? data.base_resp?.ret;
        throw new Error(ret !== undefined ? formatWeixinError(ret) : (data.base_resp?.err_msg || '保存草稿失败'));
      }
      const appMsgId = data.appMsgId;

      return {
        platformId: 'weixin',
        draftId: appMsgId,
        title: finalTitle,
        url: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${appMsgId}&token=${meta.token}&lang=zh_CN`,
        previewText: previewOf(article.body),
        body: content,
        createdAt: Date.now(),
      };
    });
  },

  async publish(draft: DraftRef): Promise<PublishResult> {
    // 草稿语义：operate_appmsg 已建图文素材草稿，直接返回成功与草稿链接
    return pubResult('weixin', true, { draftId: draft.draftId, url: draft.url, draftOnly: true });
  },
};
