#!/usr/bin/env node
/**
 * OmniPost MCP Server（真实实现）
 *
 * - 完整 MCP stdio 协议：initialize / initialized / ping / tools/list / tools/call
 * - check_auth / sync_article 经 @omnipost/bridge 的 sendCommand 由 Chrome 扩展真实执行
 * - upload_image 真实读取本地图片为 base64 并登记，sync_article 携带媒体给扩展
 * - 绝不假报"ready / 成功"：命令失败或扩展不可达时返回 isError 工具错误
 *
 * 协议版本：2024-11-05（MCP 官方 JSON-RPC over stdio，每行一条 JSON）。
 */
import { BRIDGE_PORT, sendCommand } from '@omnipost/bridge';
import {
  handleCheckAuth,
  handleExtractArticle,
  handleListPlatforms,
  handleSyncArticle,
  handleUploadImage,
} from './tools.js';

const SERVER_INFO = { name: '@omnipost/mcp-server', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

const TOOL_DEFS = [
  {
    name: 'list_platforms',
    description: '获取所有支持的 P0 社交媒体发布平台清单',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_auth',
    description: '真实检查各平台登录认证状态（经 Chrome 扩展查询；未登录 / 未配置返回错误信息）',
    inputSchema: {
      type: 'object',
      properties: { platforms: { type: 'array', items: { type: 'string' }, description: '指定平台 id，缺省查全部' } },
    },
  },
  {
    name: 'sync_article',
    description: '真实向选定平台分发文章草稿（经 Chrome 扩展执行；需扩展运行且目标平台已登录/配置）',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文章标题（可选）' },
        body: { type: 'string', description: 'Markdown 正文（必填）' },
        platforms: { type: 'array', items: { type: 'string' }, description: '目标平台 id，缺省为扩展已配置平台' },
        mediaIds: { type: 'array', items: { type: 'string' }, description: '先用 upload_image 上传得到的 mediaId' },
      },
      required: ['body'],
    },
  },
  {
    name: 'extract_article',
    description: '从当前浏览器标签页智能提取文章标题与正文（Readability 阅读模式，返回 Markdown）；传入 content 时改为本地解析该文本',
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: '可选：原始文本，传入则本地解析标题/正文；不传则提取当前页面' } },
    },
  },
  {
    name: 'upload_image',
    description: '真实读取本地图片文件并登记为媒体，供 sync_article 使用',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '本地图片绝对路径（png/jpg/gif/webp 等）' } },
      required: ['path'],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'list_platforms':
      return { result: handleListPlatforms() };
    case 'extract_article':
      return { result: await handleExtractArticle(args, { sendCommand }) };
    case 'upload_image':
      return { result: handleUploadImage(args) };
    case 'check_auth':
      return { result: await handleCheckAuth(args, { sendCommand }) };
    case 'sync_article':
      return { result: await handleSyncArticle(args, { sendCommand }) };
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop(); // 保留不完整行

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 非 JSON 行（如 stderr 混入）忽略
    }

    const { id, method } = msg || {};

    // 通知类：无需响应
    if (method === 'notifications/initialized' || (method || '').startsWith('notifications/')) {
      continue;
    }

    try {
      switch (method) {
        case 'initialize':
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: SERVER_INFO,
            },
          });
          break;

        case 'ping':
          send({ jsonrpc: '2.0', id, result: {} });
          break;

        case 'tools/list':
          send({ jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } });
          break;

        case 'tools/call': {
          const name = msg.params?.name;
          const args = msg.params?.arguments || {};
          let out;
          try {
            const { result } = await handleToolCall(name, args);
            out = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
          } catch (e) {
            out = {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: e?.message || '工具调用失败' }],
                isError: true,
              },
            };
          }
          send(out);
          break;
        }

        default:
          // 未知名方法：按 MCP 规范回 -32601
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: e?.message || '内部错误' } });
    }
  }
});

console.error(`[OmniPost MCP Server] 已启动（stdio, bridge 端口 ${BRIDGE_PORT}）`);
