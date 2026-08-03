import { defineConfig } from 'vite';
import { resolve } from 'path';
import { existsSync, mkdirSync, cpSync } from 'fs';

/**
 * 竞彩智选 Pro - Vite 配置
 * 渐进式工程化：UMD 模块 + 开发服务器 + 静态构建
 */

// 构建前同步 js/ 源码到 public/（确保 Vite 复制到 dist）
function syncSourceToPublic() {
  const publicJs = resolve(__dirname, 'public/js');
  if (!existsSync(publicJs)) mkdirSync(publicJs, { recursive: true });
  for (const sub of ['core', 'api', 'engine', 'components']) {
    const src = resolve(__dirname, `js/${sub}`);
    const dst = resolve(__dirname, `public/js/${sub}`);
    if (existsSync(src)) {
      cpSync(src, dst, { recursive: true });
    }
  }
  // config/ 复制
  const cfgSrc = resolve(__dirname, 'config');
  const cfgDst = resolve(__dirname, 'public/config');
  if (existsSync(cfgSrc)) {
    cpSync(cfgSrc, cfgDst, { recursive: true });
  }
}

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
    },
    /* 构建前：把源码同步到 public（确保 dist 有完整组件） */
    // vite-plugin-static-copy 内置支持，先尝试
  },
  plugins: [
    {
      name: 'sync-source-to-public',
      buildStart() {
        syncSourceToPublic();
      }
    }
  ],

  /* 版本注入 */
  define: {
    __APP_VERSION__: JSON.stringify('2.0.0'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString())
  }
});
