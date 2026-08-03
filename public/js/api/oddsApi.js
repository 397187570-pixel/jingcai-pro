/**
 * oddsApi.js — The Odds API 封装（国际赔率）
 * 竞彩智选 Pro · API 层
 */

/* 配置获取：浏览器用全局 CONFIG，Node 用 require */
let CONFIG;
if (typeof window !== 'undefined' && window.CONFIG) {
  CONFIG = window.CONFIG;
} else {
  CONFIG = require('../../config/config.js');
}

/**
 * 获取国际赔率（h2h 市场）
 * @param {string} sport 运动（默认 soccer_epl）
 * @param {string} apiKey API Key
 */
async function getOdds(sport = 'soccer_epl', apiKey) {
  if (!apiKey) return { ok: false, error: '未配置 API Key' };

  const cfg = CONFIG.dataSources.oddsApi;
  const url = 'https://' + cfg.base + '/v4/sports/' + sport + '/odds/?apiKey=' + apiKey +
    '&regions=' + cfg.regions + '&markets=' + cfg.markets + '&oddsFormat=decimal';

  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      const hints = {
        401: 'Key 无效',
        403: 'Key 被拒绝',
        422: 'Key 格式错误',
        429: '请求超限（免费版每月500次）'
      };
      return { ok: false, error: hints[res.status] || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data: normalizeOdds(data) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 标准化：提取每家公司的平均赔率
 */
function normalizeOdds(raw) {
  return raw.map(m => {
    const homeOdds = [], drawOdds = [], awayOdds = [];
    (m.bookmakers || []).forEach(b => {
      const h2h = (b.markets || []).find(mk => mk.key === 'h2h');
      if (h2h && h2h.outcomes) {
        const o = {};
        h2h.outcomes.forEach(x => o[x.name] = x.price);
        if (o.Home) homeOdds.push(o.Home);
        if (o.Draw) drawOdds.push(o.Draw);
        if (o.Away) awayOdds.push(o.Away);
      }
    });
    const avg = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : 0;
    return {
      homeTeam: m.home_team,
      awayTeam: m.away_team,
      commence: m.commence_time,
      odds: { h: avg(homeOdds), d: avg(drawOdds), a: avg(awayOdds) },
      bookmakers: (m.bookmakers || []).length
    };
  }).filter(m => m.odds.h > 1);
}

/* Node 环境导出 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getOdds, normalizeOdds };
}

/* 浏览器全局挂载 */
if (typeof window !== 'undefined') {
  window.OddsApi = { getOdds, normalizeOdds };
}
