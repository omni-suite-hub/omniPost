#!/usr/bin/env node
/**
 * 下载 Chrome for Testing（冒烟测试专用）
 * branded Chrome 137+ 已移除 --load-extension；Chrome for Testing（Chromium 系）仍支持。
 * 用法：node test/e2e/install-cft.cjs   （下载 stable 版 mac-arm64，~180MB，幂等：已存在则跳过）
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TMP = path.join(path.resolve(__dirname, '..', '..'), 'test', '.tmp', 'cft');
const CFT_DIR = path.join(TMP, 'chrome-mac-arm64');
const CFT_BIN = path.join(CFT_DIR, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');

const PLATFORM = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : process.platform;

async function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      res.pipe(file);
      file.on('finish', () => { file.close(resolve); });
    }).on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
  });
}

async function main() {
  if (fs.existsSync(CFT_BIN)) {
    console.log(`✅ Chrome for Testing 已存在: ${CFT_BIN}`);
    return;
  }
  console.log(`🌐 获取 Chrome for Testing stable（平台 ${PLATFORM}）...`);
  const j = await getJson('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json');
  const stable = j.channels.Stable;
  const entry = stable.downloads.chrome.find((d) => d.platform === PLATFORM);
  if (!entry) throw new Error(`平台 ${PLATFORM} 无下载项`);
  console.log(`  版本 ${stable.version}: ${entry.url}`);

  fs.mkdirSync(TMP, { recursive: true });
  const zip = path.join(TMP, `chrome-${PLATFORM}.zip`);
  // 国内网络下 Google 存储经常被限速（实测 ~37KB/s），优先走 npmmirror 镜像（阿里 CDN）
  const mirrorUrl = `https://cdn.npmmirror.com/binaries/chrome-for-testing/${stable.version}/${PLATFORM}/chrome-${PLATFORM}.zip`;
  console.log('  下载中（约 180MB）...');
  try {
    await download(mirrorUrl, zip);
  } catch (e) {
    console.log(`  镜像下载失败（${e.message}），回退官方源...`);
    await download(entry.url, zip);
  }
  console.log('  解压中...');
  execSync(`unzip -q -o "${zip}" -d "${TMP}"`);
  fs.unlinkSync(zip);
  if (!fs.existsSync(CFT_BIN)) throw new Error('解压后未找到 Chrome for Testing 可执行文件');
  console.log(`✅ 安装完成: ${CFT_BIN}`);
}

main().catch((e) => { console.error(`❌ 安装失败: ${e.message}`); process.exit(1); });
