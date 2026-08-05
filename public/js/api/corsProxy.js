/**
 * corsProxy.js — CORS 代理层
 * 竞彩智选 Pro · 解决浏览器跨域限制
 */

(function() {
const PROXIES = [
  { name: '直连', wrap: u => u },
  { name: 'cors.sh', wrap: u => 'https://cors.sh/' + u },
  { name: 'proxy.cors.sh', wrap: u => 'https://proxy.cors.sh/' + u },
  { name: 'corsproxy.io', wrap: u => 'https://corsproxy.io/?url=' + encodeURIComponent(u) }
];

/**
 * 通过 CORS 代理请求（自动多代理切换）
 * @param {string} url 目标 URL
 * @param {Object} [options] fetch 选项
 */
async function fetchWithProxy(url, options = {}) {
  let lastError = '';
  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy.wrap(url), options);
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e.message;
    }
  }
  const err = new Error('所有 CORS 代理均失败: ' + lastError);
  err.code = 'CORS_FAILED';
  throw err;
}

/**
 * 测试所有代理连通性
 */
async function testAll() {
  const results = [];
  for (const proxy of PROXIES) {
    try {
      const t0 = Date.now();
      const res = await fetch(proxy.wrap('https://api.football-data.org/v4/competitions'), {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      results.push({ name: proxy.name, ok: true, latency: Date.now() - t0, status: res.status });
    } catch (e) {
      results.push({ name: proxy.name, ok: false, error: e.message });
    }
  }
  return results;
}

/* Node 环境导出 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fetchWithProxy, testAll, PROXIES };
}

/* 浏览器全局挂载 */
if (typeof window !== 'undefined') {
  window.CorsProxyApi = { fetchWithProxy, testAll, PROXIES };
}

})();
