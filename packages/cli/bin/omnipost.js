#!/usr/bin/env node
/**
 * OmniPost CLI —— 真实实现（不再"假装成功"）
 *
 * 通信模型：CLI → @omnipost/bridge 的 sendCommand → 127.0.0.1:18432 →
 *          Chrome 扩展 background 轮询取命令 → 真实执行（登录检测 / 建草稿）→ 回写结果。
 *
 * 前置条件：Chrome 已加载 OmniPost 扩展并保持运行（background 每 30s 轮询 bridge 一次）。
 * 若本机已有 MCP server 常驻 18432 端口，CLI 自动直通；否则临时起 standalone server。
 */
import { program } from 'commander';
import fs from 'fs';
import path from 'path';
import { BRIDGE_PORT, PLATFORMS, resolvePlatformIds, sendCommand } from '@omnipost/bridge';

function platformName(id) {
  return PLATFORMS.find((p) => p.id === id)?.name || id;
}

program
  .name('omnipost')
  .description('OmniPost 跨平台一键发布命令行工具（经本地 bridge 通道由 Chrome 扩展真实执行）')
  .version('0.1.0');

program
  .command('platforms')
  .description('列出所有支持的 P0 社交媒体平台')
  .action(() => {
    console.log('\n🌟 OmniPost 支持的目标平台清单 (P0)：');
    console.log('--------------------------------------------------');
    const rows = PLATFORMS.map((p) => ({
      id: p.id,
      name: p.name,
      route: p.route === 'session' ? 'session（浏览器登录态）' : 'official（官方 API）',
      types: p.types.join('/'),
    }));
    console.table(rows);
    console.log(`提示：session 平台直接复用 Chrome 登录态；bridge 端口 ${BRIDGE_PORT}（本机回环）。\n`);
  });

program
  .command('auth')
  .description('检查各平台登录认证状态（真实查询 Chrome 扩展）')
  .option('-p, --platforms <list>', '指定平台，用英文逗号隔开（例如 weibo,zhihu,x）')
  .action(async (options) => {
    try {
      console.log('🔌 正在通过本地 bridge 向 Chrome 扩展查询登录态...');
      const result = await sendCommand({
        type: 'check_login',
        payload: { platforms: resolvePlatformIds(options.platforms) || [] },
      });
      if (result.status === 'error') {
        console.error(`❌ ${result.error}`);
        process.exit(1);
      }
      const auth = result.auth || {};
      const entries = Object.entries(auth);
      if (entries.length === 0) {
        console.error('❌ 未查询到任何平台状态');
        process.exit(1);
      }
      const rows = entries.map(([id, a]) => ({
        platform: id,
        status: a.loggedIn ? '✅ 已登录' : '❌ 未登录',
        account: a.loggedIn ? (a.account || '(未知)') : '—',
      }));
      console.table(rows);
      process.exit(rows.some((r) => r.status.includes('已登录')) ? 0 : 1);
    } catch (e) {
      console.error(`❌ 查询失败: ${e?.error || e?.message || e}`);
      console.error('   请确认：1) Chrome 已加载 OmniPost 扩展  2) 扩展 background 已轮询 bridge（默认每 30s 一次）');
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('读取本地 Markdown 文件并真实同步到各平台草稿（经 Chrome 扩展执行）')
  .argument('<filePath>', '需要同步的 Markdown 文件路径')
  .option('-p, --platforms <list>', '指定目标平台，用英文逗号隔开（例如 weibo,zhihu,x）')
  .action(async (filePath, options) => {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`❌ 文件不存在: ${resolvedPath}`);
      process.exit(1);
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const lines = content.split('\n');
    let title = '';
    let body = content;
    if (lines[0] && lines[0].startsWith('# ')) {
      title = lines[0].replace('# ', '').trim();
      body = lines.slice(1).join('\n').trim();
    }
    if (!body.trim()) {
      console.error('❌ Markdown 正文为空，无法同步');
      process.exit(1);
    }

    const dir = path.dirname(resolvedPath);
    const media = [];
    // 扫描 Markdown 中引用的本地相对路径图片（如 ![alt](./pic.png) 或 <img src="./pic.png">）
    const mdImgRegex = /!\[([^\]]*)\]\((?!https?:\/\/)([^)]+)\)/g;
    let match;
    let index = 0;
    while ((match = mdImgRegex.exec(content)) !== null) {
      const imgRelPath = match[2].trim();
      const imgFullPath = path.resolve(dir, imgRelPath);
      if (fs.existsSync(imgFullPath)) {
        try {
          const ext = path.extname(imgFullPath).toLowerCase().replace('.', '') || 'png';
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
          const buf = fs.readFileSync(imgFullPath);
          const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
          media.push({
            id: 'cli_img_' + Date.now() + '_' + index++,
            name: path.basename(imgFullPath),
            type: mime,
            size: buf.length,
            dataUrl,
          });
        } catch { /* ignore read error */ }
      }
    }

    const wanted = resolvePlatformIds(options.platforms) || [];

    console.log('==================================================');
    console.log('🚀 [OmniPost CLI] 开始文章同步任务（真实执行）');
    console.log(`📄 标题: ${title || '无标题'}`);
    console.log(`📝 字数: ${body.length} 字符`);
    if (media.length > 0) {
      console.log(`🖼️  检测到本地图片: ${media.length} 张（已打包 base64）`);
    }
    console.log(`🎯 目标平台: ${wanted.length > 0 ? wanted.join(', ') : '已配置平台（自动过滤未配置的 official 平台）'}`);
    console.log('==================================================');
    console.log('🔌 正在通过本地 bridge 向 Chrome 扩展发送同步命令...');
    console.log('⏳ 等待扩展检查登录态并创建草稿（session 平台会打开编辑器标签页，请勿关闭）...\n');

    try {
      const result = await sendCommand({
        type: 'sync_article',
        payload: { title, body, platforms: wanted, media },
      });
      if (result.status === 'error') {
        console.error(`❌ 同步失败: ${result.error}`);
        process.exit(1);
      }
      const drafts = result.drafts || [];
      const errors = result.errors || {};
      const results = result.results || [];
      const errCount = Object.keys(errors).length;

      if (drafts.length === 0) {
        console.error('❌ 未能生成任何草稿。');
        if (errCount > 0) {
          console.error('错误明细:');
          for (const [pid, msg] of Object.entries(errors)) {
            console.error(`  - ${platformName(pid)}: ${msg}`);
          }
        }
        process.exit(1);
      }

      console.log(`✅ 已生成 ${drafts.length} 个平台草稿:`);
      for (const d of drafts) {
        const link = d.url ? ` (${d.url})` : '';
        console.log(`   • ${platformName(d.platformId)}: ${d.previewText || d.title || '无预览'}${link}`);
      }
      // sync_article 走的是完整自动发布管线（建草稿→自动发布），把逐平台真实结果打印出来
      if (results.length > 0) {
        console.log('\n📮 发布结果:');
        for (const r of results) {
          const state = r.ok ? (r.draftOnly ? '📝 已存草稿' : '✅ 已发布') : '❌ 失败';
          const link = r.url ? ` (${r.url})` : '';
          console.log(`   • ${platformName(r.platformId)}: ${state}${link}${r.error ? ` — ${r.error}` : ''}`);
        }
      }
      if (errCount > 0) {
        console.warn(`\n⚠️  ${errCount} 个平台失败:`);
        for (const [pid, msg] of Object.entries(errors)) {
          console.warn(`   - ${platformName(pid)}: ${msg}`);
        }
      }
      process.exit(0);
    } catch (e) {
      console.error(`❌ 同步失败: ${e?.error || e?.message || e}`);
      console.error('   请确认：1) Chrome 已加载 OmniPost 扩展  2) 扩展 background 已轮询 bridge（默认每 30s 一次）');
      process.exit(1);
    }
  });

program.parse();
