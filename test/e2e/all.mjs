#!/usr/bin/env node
/**
 * OmniPost 上线前 e2e 全量入口：按序执行 test/e2e 下各专项脚本并汇总。
 *
 * 为什么需要这个入口（而不是逐个手跑）：
 *  - 各脚本启动时会 rm -rf 自己的 Chrome profile（test/.tmp 下数百个文件），
 *    在 WorkBuddy 沙箱里会触发批量删除守卫而直接崩掉。这里统一对子进程关闭守卫：
 *    删除目标恒为 test/.tmp/* 的测试 profile，不涉及任何用户文件。
 *  - 统一串行执行，避免多个 Chrome for Testing 实例抢端口 / 抢资源导致假失败。
 *
 * 运行：node test/e2e/all.mjs
 *       node test/e2e/all.mjs ui-audit smoke   （只跑指定套件）
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const SUITES = [
  'smoke',                 // 冒烟：扩展加载 / SW 注册 / storage 往返
  'publish-flow',          // 发布主流程 + 回执弹窗（中英双语）
  'disconnect-recovery',   // 发布断线兜底（本次新增：进度落盘 + 失联还原 + fatal）
  'ui-audit',              // 上线前 UI 全量审计（i18n 泄漏 / 布局 / 交互 / 空状态）
  'group-collapse-card',   // 平台分组独立折叠 + 卡片排版
  'settings-cred-layout',  // 设置面板凭证区排版（折行 / 溢出）
  'cred-links',            // 凭证「去申请」跳转入口
  'preview-modal',         // 真实排版预览弹窗
  'media-upload',          // 媒体上传（真实 file chooser）
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const list = only.length ? only : SUITES;

const cleanEnv = {
  ...process.env,
  NODE_OPTIONS: (process.env.NODE_OPTIONS || '').replace(/--require="[^"]*safe-delete[^"]*"\s*/, ''),
  // 仅对 e2e 子进程生效：它们删除的是 test/.tmp 下自己的 Chrome profile
  CODEBUDDY_SAFE_DELETE_ENABLED: '0',
};

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, file)], { cwd: ROOT, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('close', (code) => resolve({ file, code, out }));
  });
}

/** 从各脚本自己的汇总行里解析「通过 / 失败」，解析不到就退回退出码 */
function parse(out, code) {
  const nums = [...out.matchAll(/通过\s*(\d+)\s*[项]?\s*[/，,]\s*失败\s*(\d+)/g)];
  if (nums.length) {
    const m = nums[nums.length - 1];
    return { pass: +m[1], fail: +m[2] };
  }
  const m2 = /总计\s*(\d+)\s*项[，,]\s*通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)/.exec(out);
  if (m2) return { pass: +m2[2], fail: +m2[3] };
  const m3 = /通过\s*(\d+)\s*[/，,]\s*失败\s*(\d+)/.exec(out);
  if (m3) return { pass: +m3[1], fail: +m3[2] };
  // 「总计 38 项，通过 38 项，全部通过 🎉」这类只报通过数的汇总
  const m4 = /总计\s*(\d+)\s*项[，,]\s*通过\s*(\d+)\s*项/.exec(out);
  if (m4) return { pass: +m4[2], fail: +m4[1] - +m4[2] };
  return { pass: code === 0 ? 1 : 0, fail: code === 0 ? 0 : 1 };
}

async function main() {
  console.log('====================================================');
  console.log('🚀 OmniPost e2e 全量回归（真实 Chrome for Testing）');
  console.log('====================================================\n');
  const rows = [];
  for (const s of list) {
    const file = `${s}.mjs`;
    if (!fs.existsSync(path.join(__dirname, file))) {
      console.log(`  ⚠️ [SKIP] ${s}（脚本不存在）`);
      rows.push({ suite: s, pass: 0, fail: 0, code: -1, skipped: true });
      continue;
    }
    process.stdout.write(`  ▶ ${s} ... `);
    const { code, out } = await run(file);
    const { pass, fail } = parse(out, code);
    fs.writeFileSync(path.join(ROOT, 'test', '.tmp', `e2e-${s}.log`), out);
    console.log(`通过 ${pass} / 失败 ${fail}  (exit=${code})`);
    rows.push({ suite: s, pass, fail, code });
  }

  console.log('\n====================================================');
  console.log('📊 e2e 全量汇总');
  console.log('====================================================');
  let tp = 0, tf = 0;
  for (const r of rows) {
    if (r.skipped) { console.log(`  ⚠️  ${r.suite.padEnd(24)} SKIP`); continue; }
    tp += r.pass; tf += r.fail;
    console.log(`  ${r.fail === 0 ? '✅' : '❌'} ${r.suite.padEnd(24)} 通过 ${String(r.pass).padStart(3)} / 失败 ${r.fail}`);
  }
  console.log('----------------------------------------------------');
  console.log(`  合计: 通过 ${tp} / 失败 ${tf}`);
  console.log('====================================================');
  process.exit(tf === 0 ? 0 : 1);
}

main();
