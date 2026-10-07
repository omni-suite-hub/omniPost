import React from 'react';

interface LogoProps {
  className?: string;
  size?: number;
}

/**
 * OmniPost 旗舰统一样式 Logo 组件
 * 与 Chrome 侧边栏/扩展栏图标 100% 保持一致的高级质感与高对比度设计
 */
export const OmniPostLogo: React.FC<LogoProps> = ({ className = 'w-7 h-7', size = 28 }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 128 128"
      width={size}
      height={size}
      className={`shrink-0 drop-shadow-[0_2px_10px_rgba(99,102,241,0.4)] ${className}`}
      aria-label="OmniPost Logo"
    >
      <defs>
        <linearGradient id="omniHeaderBg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3730A3" />
          <stop offset="45%" stopColor="#4F46E5" />
          <stop offset="85%" stopColor="#7C3AED" />
          <stop offset="100%" stopColor="#9333EA" />
        </linearGradient>
        <linearGradient id="omniHeaderRim" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="omniHeaderWingMain" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="70%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#E0E7FF" />
        </linearGradient>
        <linearGradient id="omniHeaderWingSub" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#E0E7FF" />
          <stop offset="100%" stopColor="#C7D2FE" />
        </linearGradient>
        <linearGradient id="omniHeaderKeel" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#A5B4FC" />
          <stop offset="100%" stopColor="#818CF8" />
        </linearGradient>
        <filter id="omniHeaderGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="3" stdDeviation="3.5" floodColor="#000000" floodOpacity="0.35" />
        </filter>
      </defs>

      <rect x="3" y="3" width="122" height="122" rx="28" fill="url(#omniHeaderBg)" stroke="rgba(255,255,255,0.22)" strokeWidth="2" />
      <rect x="4" y="4" width="120" height="120" rx="27" fill="none" stroke="url(#omniHeaderRim)" strokeWidth="1.5" />

      <g filter="url(#omniHeaderGlow)">
        <circle cx="64" cy="64" r="33" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="7" />
        <path d="M 33 64 A 31 31 0 0 1 64 33" fill="none" stroke="#38BDF8" strokeWidth="7" strokeLinecap="round" />
        <circle cx="64" cy="33" r="3.5" fill="#38BDF8" />
        <circle cx="95" cy="64" r="3.5" fill="#C084FC" />
        <circle cx="64" cy="95" r="3.5" fill="#818CF8" />
        <circle cx="33" cy="64" r="3.5" fill="#38BDF8" />
        <path d="M 94 34 L 38 58 L 58 68 Z" fill="url(#omniHeaderWingMain)" />
        <path d="M 94 34 L 58 68 L 70 88 Z" fill="url(#omniHeaderWingSub)" />
        <path d="M 58 68 L 63 76 L 70 88 Z" fill="url(#omniHeaderKeel)" />
      </g>
    </svg>
  );
};
