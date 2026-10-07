const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CFT_BIN = path.join(
  __dirname, '..', '.tmp', 'cft', 'chrome-mac-arm64',
  'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'
);

/**
 * OmniPost 专属旗舰 Logo SVG (超高对比度、科技质感、多平台全网分发概念)
 * 设计解析：
 * 1. 容器（Squircle）：圆角 28，深邃高级的午夜星云渐变 (#312E81 -> #4F46E5 -> #7C3AED)，配高光内描边，在浅色/深色模式下均轮廓分明。
 * 2. 环形（Omni 环）：代表全网生态与平台聚合，纯白高亮半透明环线 + 天青色 (#38BDF8) 跃迁脉冲弧线。
 * 3. 核心象征（Post 超音速发射之羽 / 纸飞机）：
 *    - 几何折纸立体造型，以 45° 破空向右上飞翔（象征一键将文章/视频光速分发至全网）。
 *    - 主机翼采用纯白至高亮银蓝渐变（#FFFFFF -> #E0E7FF），副机翼配天青与极光紫，极致高对比度，哪怕在 16x16 极小尺寸下依然锐利清晰！
 */
function getOmniPostSvg(size = 128) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}">
  <defs>
    <!-- 背景渐变：深邃星空到电光紫罗兰 -->
    <linearGradient id="omniBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3730A3" />
      <stop offset="45%" stop-color="#4F46E5" />
      <stop offset="85%" stop-color="#7C3AED" />
      <stop offset="100%" stop-color="#9333EA" />
    </linearGradient>

    <!-- 顶部高光弧线 -->
    <linearGradient id="omniRim" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.4" />
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0.0" />
    </linearGradient>

    <!-- 主翼渐变：极高对比纯白到高光冷白 -->
    <linearGradient id="omniWingMain" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF" />
      <stop offset="70%" stop-color="#FFFFFF" />
      <stop offset="100%" stop-color="#E0E7FF" />
    </linearGradient>

    <!-- 副翼渐变：立体阴影面 -->
    <linearGradient id="omniWingSub" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#E0E7FF" />
      <stop offset="100%" stop-color="#C7D2FE" />
    </linearGradient>

    <!-- 气流尾翼底面 -->
    <linearGradient id="omniKeel" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#A5B4FC" />
      <stop offset="100%" stop-color="#818CF8" />
    </linearGradient>

    <!-- 柔和高阶阴影 -->
    <filter id="omniGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#000000" flood-opacity="0.35" />
    </filter>
  </defs>

  <!-- 外层高阶质感圆角基底 -->
  <rect x="3" y="3" width="122" height="122" rx="28" fill="url(#omniBg)" stroke="rgba(255,255,255,0.22)" stroke-width="2" />
  <rect x="4" y="4" width="120" height="120" rx="27" fill="none" stroke="url(#omniRim)" stroke-width="1.5" />

  <!-- 内部图形层 -->
  <g filter="url(#omniGlow)">
    <!-- Omni 全向环 (O) -->
    <circle cx="64" cy="64" r="33" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="7" />
    <!-- 激活的跃迁光弧 -->
    <path d="M 33 64 A 31 31 0 0 1 64 33" fill="none" stroke="#38BDF8" stroke-width="7" stroke-linecap="round" />
    <!-- 环周多发分发节点 (Omni Distribution Points) -->
    <circle cx="64" cy="33" r="3.5" fill="#38BDF8" />
    <circle cx="95" cy="64" r="3.5" fill="#C084FC" />
    <circle cx="64" cy="95" r="3.5" fill="#818CF8" />
    <circle cx="33" cy="64" r="3.5" fill="#38BDF8" />

    <!-- Post 发送之羽 / 超音速纸战机 (朝向东北 45° 破空分发) -->
    <!-- 尖端在 (94, 34)，左翼折点 (38, 58)，中折脊点 (58, 68)，尾翼 (70, 88) -->
    <path d="M 94 34 L 38 58 L 58 68 Z" fill="url(#omniWingMain)" />
    <path d="M 94 34 L 58 68 L 70 88 Z" fill="url(#omniWingSub)" />
    <!-- 纸飞机底部折骨，提供立体纵深感 -->
    <path d="M 58 68 L 63 76 L 70 88 Z" fill="url(#omniKeel)" />
  </g>
</svg>`;
}

async function main() {
  const publicIconsDir = path.join(__dirname, '..', '..', 'packages', 'extension', 'public', 'icons');
  const distIconsDir = path.join(__dirname, '..', '..', 'packages', 'extension', 'dist', 'icons');
  const rootDistIconsDir = path.join(__dirname, '..', '..', 'dist', 'icons');

  const targets = [publicIconsDir, distIconsDir, rootDistIconsDir];
  targets.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

  const svg128 = getOmniPostSvg(128);
  const tmpHtml = path.join(__dirname, '..', '.tmp', 'icon_render.html');
  const tmpPng128 = path.join(__dirname, '..', '.tmp', 'icon128_raw.png');

  fs.writeFileSync(tmpHtml, `<!DOCTYPE html><html><body style="margin:0;padding:0;overflow:hidden;background:transparent;">${svg128}</body></html>`);

  console.log('Rendering high-res icon via Chrome for Testing...');
  execSync(`"${CFT_BIN}" --headless --disable-gpu --default-background-color=00000000 --window-size=128,128 --screenshot="${tmpPng128}" "file://${tmpHtml}"`);

  console.log('Generating multi-size icons (128x128, 48x48, 16x16)...');
  const sizes = [128, 48, 16];
  for (const s of sizes) {
    const tmpS = path.join(__dirname, '..', '.tmp', `icon${s}.png`);
    execSync(`sips -z ${s} ${s} "${tmpPng128}" --out "${tmpS}"`);

    for (const d of targets) {
      const dest = path.join(d, `icon${s}.png`);
      fs.copyFileSync(tmpS, dest);
      console.log(`Saved: ${dest} (${s}x${s}, ${fs.statSync(dest).size} bytes)`);
    }
  }

  // Also save the SVG file for React component inclusion
  const svgPath = path.join(__dirname, '..', '..', 'packages', 'extension', 'src', 'components', 'OmniPostLogo.tsx');
  const reactComponent = `import React from 'react';

interface LogoProps {
  className?: string;
  size?: number;
}

/**
 * OmniPost 旗舰统一样式 Logo 组件
 * 无论是 Side Panel、扩展图标、还是顶部 Header，保持 100% 视觉一致与高质感
 */
export const OmniPostLogo: React.FC<LogoProps> = ({ className = 'w-7 h-7', size = 28 }) => {
  return (
    <div className={\`inline-flex items-center justify-center shrink-0 drop-shadow-[0_2px_8px_rgba(99,102,241,0.35)] \${className}\`} style={{ width: size, height: size }}>
      <img
        src="/icons/icon48.png"
        alt="OmniPost"
        className="w-full h-full object-contain select-none"
        draggable={false}
      />
    </div>
  );
};
`;
  const compDir = path.dirname(svgPath);
  if (!fs.existsSync(compDir)) fs.mkdirSync(compDir, { recursive: true });
  fs.writeFileSync(svgPath, reactComponent);
  console.log('Created React Logo Component:', svgPath);

  console.log('All icons generated successfully!');
}

main().catch(err => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
