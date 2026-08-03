/**
 * sporttery.js — 中国竞彩网官方 API 封装
 * 竞彩智选 Pro · API 层（唯一允许 fetch 的地方）
 */

/* 配置获取：浏览器用全局 CONFIG，Node 用 require */
let CONFIG;
if (typeof window !== 'undefined' && window.CONFIG) {
  CONFIG = window.CONFIG;
} else {
  try {
    CONFIG = require('../../config/config.js');
  } catch (e) {
    /* 浏览器无 require，全局 CONFIG 不存在时降级为空对象 */
    CONFIG = { dataSources: { sporttery: {} } };
  }
}

/**
 * 通用请求（带超时 + 结果模式）
 */
async function request(path, options = {}) {
  const cfg = CONFIG.dataSources.sporttery;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || cfg.timeout);

  try {
    const res = await fetch('https://' + cfg.base + path, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.sporttery.cn/'
      },
      ...options
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.errorCode !== '0') return { ok: false, error: data.errorMessage || 'API 错误' };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 获取在售比赛（支持 5 种玩法）
 * @param {string} [playType='HAD'] HAD/HHAD/CRS/TTG/HAFU
 */
async function getMatches(playType = 'HAD') {
  const cfg = CONFIG.dataSources.sporttery;
  const path = `${cfg.paths.calculator}?poolCode=${playType}&channel=${cfg.channel}`;
  const result = await request(path);

  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, data: normalizeMatches(result.data) };
}

/**
 * 获取历史开奖数据
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @param {number} [pageNo=1]
 */
async function getHistory(startDate, endDate, pageNo = 1) {
  const cfg = CONFIG.dataSources.sporttery;
  const path = `${cfg.paths.uniformResult}?matchBeginDate=${startDate}&matchEndDate=${endDate}` +
    `&leagueId=&pageSize=100&pageNo=${pageNo}&isFix=0&matchPage=1&pcOrWap=1`;
  const result = await request(path);

  if (!result.ok) return { ok: false, error: result.error };
  const matches = result.data.value?.matchResult || [];
  const total = result.data.value?.total || 0;
  return { ok: true, data: { matches, total } };
}

/**
 * 标准化比赛数据
 */
function normalizeMatches(raw) {
  const matches = [];
  const infoList = raw.value?.matchInfoList || [];
  infoList.forEach(day => {
    (day.subMatchList || []).forEach(m => {
      matches.push({
        id: m.matchId,
        code: m.matchNumStr,
        num: m.matchNum,
        date: m.matchDate,
        time: m.matchTime,
        weekday: m.matchWeek,
        league: m.leagueAbbName,
        leagueFull: m.leagueAllName,
        homeTeam: m.homeTeamAbbName,
        homeTeamFull: m.homeTeamAllName,
        awayTeam: m.awayTeamAbbName,
        awayTeamFull: m.awayTeamAllName,
        status: m.matchStatus,
        odds: m.had ? { h: +m.had.h, d: +m.had.d, a: +m.had.a } : null,
        hhad: m.hhad && m.hhad.h ? { h: +m.hhad.h, d: +m.hhad.d, a: +m.hhad.a, line: m.hhad.goalLine } : null,
        crs: Object.keys(m.crs || {}).length ? m.crs : null,
        ttg: Object.keys(m.ttg || {}).length ? m.ttg : null,
        hafu: Object.keys(m.hafu || {}).length ? m.hafu : null
      });
    });
  });
  return matches;
}

/* Node 环境导出（浏览器中 module 不存在，自动跳过） */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getMatches, getHistory, normalizeMatches };
}

/* 浏览器全局挂载（供 script 直接引用） */
if (typeof window !== 'undefined') {
  window.SportteryApi = { getMatches, getHistory, normalizeMatches };
}
