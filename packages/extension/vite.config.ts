import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest: manifest as any }),
  ],
  build: {
    rollupOptions: {
      // offscreen document 不由 manifest 引用（运行时 chrome.offscreen.createDocument 创建），
      // crx 插件不会自动收录，必须显式声明为额外入口，否则产物里根本没有 offscreen.html。
      input: {
        offscreen: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src/offscreen/offscreen.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
