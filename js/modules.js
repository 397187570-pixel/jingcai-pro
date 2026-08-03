/**
 * modules.js — ES Module 统一出口
 * 供 Vite 构建使用（UMD 文件通过动态挂载全局，ESM 统一导出）
 */

// 导入顺序保持依赖
import './core/utils.js';
import '../config/config.js';
import './engine/predictor.js';
import './api/sporttery.js';
import './api/oddsApi.js';
import './api/corsProxy.js';
import './components/dashboard.js';
import './components/aiAnalysis.js';
import './app.js';

export {};
