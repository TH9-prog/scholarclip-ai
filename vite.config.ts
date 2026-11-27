import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 标准 Manifest V3 多入口构建：popup / options 为 HTML 页面，background 为 module service worker。
// 网页内容提取通过 chrome.scripting.executeScript 注入内联函数完成，因此无需单独打包 content script。
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: '',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: mode === 'development' ? 'inline' : false,
    rollupOptions: {
      input: {
        popup: 'popup.html',
        options: 'options.html',
        background: 'src/background/index.ts',
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
