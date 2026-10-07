/**
 * AI 文案生成客户端 —— OpenAI 兼容 chat completions（零依赖，fetch 直连）。
 *
 * 用途：popup「AI 生成」一键生成标题 + Markdown 正文，填入后一键发布。
 * 所有主流 AI（DeepSeek / OpenAI / 通义千问 / Kimi / 智谱）均提供 OpenAI 兼容端点，
 * 统一走同一个 fetch 客户端，仅 baseUrl / model / apiKey 不同。
 *
 * 模型名为 2026-08 核实的最新可用值（DeepSeek 旧 deepseek-chat/reasoner 已于 2026-07-24 弃用）。
 */

export interface AiProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  /** 是否需要 API key（部分本地/开放端点可空） */
  requiresKey: boolean;
}

/** 预置主流 provider（OpenAI 兼容格式，模型名 2026-08 最新） */
export const AI_PROVIDERS: AiProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    defaultModel: 'deepseek-v4-flash',
    requiresKey: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-4.1', 'gpt-4o'],
    defaultModel: 'gpt-5.5',
    requiresKey: true,
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    defaultModel: 'qwen-plus',
    requiresKey: true,
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3', 'moonshot-v1-8k', 'moonshot-v1-32k'],
    defaultModel: 'kimi-k3',
    requiresKey: true,
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air'],
    defaultModel: 'glm-4-plus',
    requiresKey: true,
  },
  {
    id: 'custom',
    name: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    models: [],
    defaultModel: '',
    requiresKey: true,
  },
];

/** 生成文章的系统提示词：要求 JSON 输出 { title, body } */
const GEN_SYSTEM_PROMPT =
  '你是一名资深的自媒体内容创作者，擅长把一句需求扩展成结构完整、可直接发布到多平台的文章。' +
  '请根据用户需求生成一篇适合在知乎、微信公众号、掘金、小红书等平台发布的文章。' +
  '要求：标题精炼有吸引力；正文用 Markdown 格式，含必要的分段、小标题（##）、列表，篇幅适中（600~1500 字）；' +
  '只输出 JSON，不要任何解释或代码块标记，格式严格为 {"title":"...","body":"..."}，body 内换行用 \\n 表示。';

export interface AiGenerateInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 用户需求/主题 */
  prompt: string;
}

export interface AiGenerateResult {
  title: string;
  body: string;
}

/**
 * 调用 OpenAI 兼容 chat completions 生成标题 + Markdown 正文。
 * @throws 网络错误 / 非 2xx / 解析失败时抛错（供 UI 展示，绝不假成功）。
 */
export async function generateArticle(input: AiGenerateInput): Promise<AiGenerateResult> {
  const base = (input.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('AI 服务地址（baseUrl）未配置');
  if (!input.model) throw new Error('AI 模型未选择');
  if (!input.prompt.trim()) throw new Error('请先输入要生成的内容需求');

  const content = await callChat(base, input.apiKey, input.model, GEN_SYSTEM_PROMPT, input.prompt, 0.8);
  return parseArticleJson(content);
}

/** 改写配置（复用 AI 设置） */
export interface RewriteConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 平台风格改写的系统提示词：保留事实，调整语气/篇幅/格式，并按平台要求调整语言 */
const REWRITE_SYSTEM_PROMPT =
  '你是资深的内容风格适配专家。请把用户提供的母稿改写成符合目标平台风格的文章。' +
  '严格保留母稿的核心信息、事实、数据和观点，不编造、不新增内容；调整语气、篇幅、结构、排版，' +
  '并可根据目标平台要求调整语言（例如国内平台保持中文、海外平台翻译成英文）。' +
  '只输出 JSON，格式严格为 {"title":"...","body":"..."}，body 内换行用 \\n 表示。';

import { markdownToPlainText, PlatformContentFormat } from './markdown-utils';

export async function rewriteForPlatform(
  mother: { title: string; body: string },
  stylePrompt: string,
  config: RewriteConfig,
  targetFormat: PlatformContentFormat = 'markdown',
  charLimit?: number,
  titleLimit?: number,
): Promise<AiGenerateResult> {
  const base = (config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('AI 服务地址未配置');
  if (!config.model) throw new Error('AI 模型未选择');

  let formatInstruction = '';
  if (targetFormat === 'plain') {
    formatInstruction =
      '\n\n【重要排版约束 - 必须严格遵守】\n' +
      '目标平台为纯文本/社交短文平台，不支持任何 Markdown 格式！\n' +
      '1. 严禁出现任何 Markdown 语法标记：绝对不要包含「# 标题」、「**加粗**」、「*斜体*」、「[链接文字](url)」、「- 列表项」或反引号代码块。\n' +
      '2. 必须采用该平台原生优雅排版：使用【小标题】或 Emoji 表情（如 📌、✨、💡、👉）作为视觉锚点，多用空行分段，列表使用数字标号（如 1. 2. 3. 或 ① ② ③），文末根据平台调性添加相应话题标签（如 #话题#）。';
  } else if (targetFormat === 'html') {
    formatInstruction =
      '\n\n【排版格式要求】\n' +
      '目标平台使用富文本排版（非原生 Markdown 编辑器）。文章应分段清晰、大纲层级明确、善用小标题，便于富文本展示。';
  } else {
    formatInstruction =
      '\n\n【排版格式要求】\n' +
      '目标平台支持标准 Markdown 格式。可合理使用 Markdown 标题、加粗、列表、代码块等语法。';
  }

  // 标题字数上限：约束 AI 改写标题长度（小红书 20 / 抖音 20 / YouTube 100 / Reddit 300 等）
  let titleInstruction = '';
  if (titleLimit && titleLimit > 0) {
    titleInstruction =
      `\n\n【标题字数上限 - 必须严格遵守】\n` +
      `目标平台标题有 ${titleLimit} 字的硬上限（含标点）。必须确保改写后标题字符数 <= ${titleLimit}，` +
      `超长时提炼核心信息、压缩冗余词，保留最具识别度的关键词。`;
  }

  // 正文字数上限：开启 AI 适配时由调用方传入，要求 AI 主动压缩/精炼到该字数以内
  let lengthInstruction = '';
  if (charLimit && charLimit > 0) {
    lengthInstruction =
      `\n\n【正文字数上限 - 必须严格遵守】\n` +
      `目标平台正文有 ${charLimit} 字的硬上限（含标点、不含标题）。母稿如超长，必须提炼核心、压缩冗余、合并相似观点，` +
      `确保改写后正文字符数 <= ${charLimit}。若母稿已在此范围内，保持信息完整即可，无需为凑字数而扩充。`;
  }

  const userPrompt = `【母稿标题】\n${mother.title}\n\n【母稿正文】\n${mother.body}\n\n【目标平台风格要求】\n${stylePrompt}${formatInstruction}${titleInstruction}${lengthInstruction}`;
  const content = await callChat(base, config.apiKey, config.model, REWRITE_SYSTEM_PROMPT, userPrompt, 0.7);
  const result = parseArticleJson(content);

  // 若目标平台为纯文本社交平台，对 AI 结果进行兜底清洗，防大模型偶发遗留 # 或 ** 等标记
  if (targetFormat === 'plain') {
    return {
      title: result.title ? markdownToPlainText(result.title) : result.title,
      body: markdownToPlainText(result.body),
    };
  }

  return result;
}

/** 通用 OpenAI 兼容 chat completions 调用，返回 assistant 文本 */
const AI_FETCH_TIMEOUT = 60 * 1000; // AI 生成可能慢，给 60s 兜底避免无限 hang
async function callChat(
  base: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_FETCH_TIMEOUT);
  let res: Response;
  const requestPayload: any = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature,
  };

  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestPayload),
      signal: controller.signal,
    });
    // 容错兼容：部分第三方/开源模型（如旧版 OneAPI/Ollama）不支持 response_format 参数并报 400
    if (!res.ok && res.status === 400) {
      const clone = res.clone();
      const errText = await clone.text().catch(() => '');
      if (errText.includes('response_format') || errText.includes('json_object')) {
        delete requestPayload.response_format;
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
        });
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(`AI 请求超时（${AI_FETCH_TIMEOUT / 1000}秒），请检查网络或更换 API 服务`);
    }
    throw new Error(`AI 网络错误: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let msg = `AI 请求失败（HTTP ${res.status}）`;
    try {
      const j = await res.json();
      msg = j?.error?.message || j?.message || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 未返回内容');
  return content;
}

/** 容错解析 AI 返回：优先 JSON，其次 "# 标题 + 正文" 文本 */
/** 反转义 JSON 字符串值中的常见转义序列（兼容 AI 把 \\n 当成字面字符的场景） */
function unescapeJsonStringValue(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** 用宽松正则从类 JSON 文本中提取 title/body 字段值（兜底：当 JSON.parse 失败但文本像 JSON 时用） */
function extractByRegex(candidate: string): { title: string; body: string } {
  // title 通常短且无换行，正则安全；body 可能跨多行，用更宽松的非贪婪匹配
  const titleMatch = candidate.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const bodyMatch = candidate.match(/"body"\s*:\s*"([\s\S]*?)"\s*\}\s*$/);
  // 若 body 匹配跨度过大（贪婪吃掉了整段），降级为更精确的非贪婪
  let body = '';
  if (bodyMatch) {
    body = unescapeJsonStringValue(bodyMatch[1]);
  } else {
    // 退路：body 可能未闭合，从 "body":" 开始截到末尾的 }
    const start = candidate.indexOf('"body"');
    if (start !== -1) {
      const colon = candidate.indexOf(':', start);
      const quote = candidate.indexOf('"', colon);
      if (quote !== -1) {
        // 找最后一个未转义的 " 作为结束符（粗略匹配）
        const end = candidate.lastIndexOf('"');
        if (end > quote) body = unescapeJsonStringValue(candidate.slice(quote + 1, end));
      }
    }
  }
  return {
    title: titleMatch ? unescapeJsonStringValue(titleMatch[1]).trim() : '',
    body: body.trim(),
  };
}

export function parseArticleJson(content: string): AiGenerateResult {
  const text = String(content).trim();
  // 剥离可能的 ```json ... ``` 围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : text;

  // 1) 优先尝试原汁原味的严格 JSON.parse（合法 JSON 内部的 \n 为合法转义，不能提前替换为真实换行符）
  try {
    const obj = JSON.parse(candidate);
    const title = String(obj.title || '').trim();
    const body = String(obj.body || '').trim();
    if (title || body) return { title, body };
  } catch { /* 非标准 JSON 或含破损字符，进入归一化与兜底 */ }

  // 1.5) 单引号伪 JSON（小模型常见输出 {'title': '...'}）：谨慎转双引号再解析
  // 只在整体形如 { '...' } 时尝试；内容含英文撇号时 JSON.parse 会自然失败并继续走后续兜底
  const sq = candidate.trim();
  if (/^\{\s*'/.test(sq)) {
    try {
      const obj = JSON.parse(sq.replace(/'/g, '"'));
      const title = String(obj.title || '').trim();
      const body = String(obj.body || '').trim();
      if (title || body) return { title, body };
    } catch { /* 继续后续兜底 */ }
  }

  // 2) 归一化字面 \n（AI 偶发把 JSON 转义序列写成字面字符，先归一化再解析）
  const normalized = candidate.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  try {
    const obj = JSON.parse(normalized);
    const title = String(obj.title || '').trim();
    const body = String(obj.body || '').trim();
    if (title || body) return { title, body };
  } catch { /* 继续正则兜底 */ }

  // 3) 兜底 #1：宽松正则提取 title/body（AI 偶发 body 内含未转义换行/引号导致整体 JSON.parse 失败，但 title 字段值通常完整）
  const regexResult = extractByRegex(candidate);
  if (regexResult.title || regexResult.body) return regexResult;

  // 4) 兜底 #2：文本解析（第一行 # 标题，其余正文）
  // 防乱码标题：首行若像 JSON 残片（{"title": ... 或 {'title': ...），绝不能当标题注入平台，
  // 返回空标题由下游走 previewOf 正文摘要兜底
  const lines = candidate.split(/\r?\n/);
  const first = lines[0] || '';
  const looksLikeJsonResidue = /^\s*[{[]/.test(first) || /["']?title["']?\s*:/.test(first);
  const title = looksLikeJsonResidue ? '' : first.replace(/^#+\s*/, '').trim();
  const body = title ? lines.slice(1).join('\n').trim() : (looksLikeJsonResidue ? '' : candidate);
  if (!title && !body) throw new Error('AI 返回内容无法解析');
  return { title, body };
}

/** 取 provider 预设（供 popup 下拉与默认值） */
export function getProvider(id: string): AiProviderPreset | undefined {
  return AI_PROVIDERS.find((p) => p.id === id);
}
