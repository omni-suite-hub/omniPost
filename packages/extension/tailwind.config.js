/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#0c0f17',
        card: '#141824',
        'card-hover': '#1b2030',
        popover: '#1a1f2e',
        muted: '#1e2433',
        'muted-foreground': '#8b92a8',
        foreground: '#f0f2f5',
        primary: '#6366f1',
        'primary-hover': '#818cf8',
        secondary: '#1e2330',
        accent: '#334155',
        border: '#2a3142',
        success: '#22c55e',
        error: '#ef4444',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      }
    },
  },
  plugins: [],
}
