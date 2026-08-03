import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * 竞彩智选 Pro - Vite 配置
 * 渐进式工程化：UMD 模块 + 开发服务器 + 静态构建
 */
export default defineConfig({
  root: '.',

  /* 开发服务器 */
  server: {
    port: 5173,
    host: true,
    open: false,
    proxy: {
      '/api': {
        target: process.env.SCF_URL || 'http://localhost:9000',
        changeOrigin: true
      }
    }
  },

  /* public 目录：js/css/config 原样复制到 dist */
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.html')
    }
  },

  /* 版本注入 */
  define: {
    __APP_VERSION__: JSON.stringify('2.0.0'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString())
  }
});
