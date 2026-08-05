/**
 * footballData.js — football-data.org API 模块
 * 竞彩智选 Pro · 真实历史比赛数据源（ML 训练 + 置信度校准）
 *
 * 认证：HTTP header X-Auth-Token
 * 限流：免费版 10 req/min，必须解析响应头自动节流（邮件特别提醒）
 */

(function() {
/* ============================================
   配置
   ============================================ */
const FOOTBALL_DATA = {
  // 浏览器走代理（绕开 football-data 的 CORS 限制），Node 直连
  // 代理基地址：window.JC_API_BASE（app.js 初始化时设置）
  //   - 本地（JC_API_BASE 空）：同源 /api/football/* → local_server.py → api.football-data.org/v4/*
  //   - 云端（JC_API_BASE=SCF 域名）：https://xxx...scf.com/api/football/*
  base: (typeof window !== 'undefined')
    ? (window.JC_API_BASE || '') + '/api/football'
    : 'https://api.football-data.org/v4',
  // 免费版限流（响应头可覆盖）
  rateLimit: { available: 10, resetInSec: 60 }
};

/* 支持的联赛（免费版可用） */
const COMPETITIONS = {
  PL: 'Premier League',
  ELC: 'Championship',
  PD: 'Primera Division',
  SA: 'Serie A',
  BL1: 'Bundesliga',
  FL1: 'Ligue 1',
  DED: 'Eredivisie',
  PPL: 'Primeira Liga',
  BSA: 'Brazil Serie A',
  CL: 'Champions League'
};

/* ============================================
   限流追踪（自动节流）
   ============================================ */
let lastResetTime = Date.now();
let availableRequests = 10;

function updateRateLimit(headers) {
  const avail = headers.get('x-requests-available-minute');
  const reset = headers.get('x-requestcounter-reset');
  if (avail) availableRequests = parseInt(avail, 10);
  if (reset) lastResetTime = Date.now() + parseInt(reset, 10) * 1000;
}

/**
 * 等待直到有请求额度（自动节流，防止 429）
 */
async function waitForRateLimit() {
  if (availableRequests > 0) {
    availableRequests--;
    return;
  }
  // 无额度：等待重置
  const waitMs = Math.max(1000, lastResetTime - Date.now() + 100);
  console.log(`[football-data] 限流，等待 ${Math.round(waitMs/1000)}s`);
  await new Promise(r => setTimeout(r, waitMs));
  availableRequests = 9; // 重置后可用
}

/* ============================================
   核心请求
   ============================================ */
let API_KEY = '';

function setApiKey(key) {
  API_KEY = key || '';
}

function getApiKey() {
  return API_KEY;
}

/**
 * 通用请求（带 X-Auth-Token + 限流 + 重试）
 */
async function request(path) {
  if (!API_KEY) return { ok: false, error: '未配置 football-data API Key' };

  for (let attempt = 0; attempt < 3; attempt++) {
    await waitForRateLimit();
    try {
      const res = await fetch(FOOTBALL_DATA.base + path, {
        headers: { 'X-Auth-Token': API_KEY, 'Accept': 'application/json' }
      });

      // 更新限流信息
      updateRateLimit(res.headers);

      if (res.status === 429) {
        console.warn('[football-data] 429 限流，等待重置重试...');
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }
      if (res.status === 401) return { ok: false, error: 'API Key 无效（401）' };
      if (res.status === 403) return { ok: false, error: '无权限（403）' };

      const data = await res.json();
      if (!res.ok) {
        return { ok: false, error: data.message || `HTTP ${res.status}` };
      }
      return { ok: true, data };
    } catch (e) {
      if (attempt === 2) return { ok: false, error: e.message };
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return { ok: false, error: '请求失败' };
}

/* ============================================
   数据接口
   ============================================ */

/**
 * 获取已结束比赛（用于训练/校准）
 * @param {string} comp 联赛代码（如 BSA）
 * @param {Object} options {limit, from, to}
 */
async function getFinishedMatches(comp = 'BSA', options = {}) {
  const limit = options.limit || 100;
  let path = `/competitions/${comp}/matches?status=FINISHED&limit=${limit}`;
  if (options.from && options.to) {
    path += `&dateFrom=${options.from}&dateTo=${options.to}`;
  }
  const result = await request(path);
  if (!result.ok) return result;

  const matches = (result.data.matches || []).map(m => ({
    id: m.id,
    competition: m.competition?.name || comp,
    homeTeam: m.homeTeam?.name || '',
    awayTeam: m.awayTeam?.name || '',
    date: m.utcDate?.slice(0, 10) || '',
    homeGoals: m.score?.fullTime?.home ?? null,
    awayGoals: m.score?.fullTime?.away ?? null,
    winner: m.score?.winner || null,
    status: m.status
  })).filter(m => m.homeGoals !== null);

  return { ok: true, data: matches, meta: result.data.resultSet };
}

/**
 * 获取未开赛比赛（SCHEDULED）— 供数据看板展示
 * @param {string} comp 联赛代码（默认 BSA 巴西甲，8月有赛程）
 * @param {Object} options {limit}
 * @returns {{ok:boolean, data:Array, error?:string}} 标准化的未开赛比赛列表
 */
async function getUpcomingMatches(comp = 'BSA', options = {}) {
  const limit = options.limit || 50;
  const path = `/competitions/${comp}/matches?status=SCHEDULED&limit=${limit}`;
  const result = await request(path);
  if (!result.ok) return result;

  const matches = (result.data.matches || []).map(m => ({
    id: m.id,
    competition: m.competition?.name || comp,
    league: m.competition?.name || comp,
    homeTeam: m.homeTeam?.name || '',
    awayTeam: m.awayTeam?.name || '',
    date: m.utcDate?.slice(0, 10) || '',
    time: m.utcDate || '',
    status: m.status,
    matchday: m.matchday || null,
    // 无赔率信息，用 null 表示（ML 预测不依赖赔率）
    odds: null,
    code: 'FD-' + (m.id || '')
  })).filter(m => m.homeTeam && m.awayTeam);

  return { ok: true, data: matches, meta: result.data.resultSet };
}

/**
 * 标准化为训练特征（赛前 + 赛后）
 */
function toTrainingSample(match) {
  if (match.homeGoals === null) return null;
  const homeGoals = match.homeGoals;
  const awayGoals = match.awayGoals;
  let label = homeGoals > awayGoals ? 0 : homeGoals === awayGoals ? 1 : 2; // 0主胜 1平 2客胜
  return {
    ...match,
    label,
    featureBase: {
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      competition: match.competition
    }
  };
}

/**
 * 获取当前在售比赛的赔率（需付费版，免费版无赔率，保留接口占位）
 */
async function getOdds(comp = 'BSA') {
  const result = await request(`/competitions/${comp}/matches?status=SCHEDULED`);
  if (!result.ok) return result;
  return { ok: true, data: (result.data.matches || []).map(m => ({
    homeTeam: m.homeTeam?.name || '',
    awayTeam: m.awayTeam?.name || '',
    date: m.utcDate || ''
  })) };
}

/**
 * 批量采集多个联赛（供训练脚本用）
 * @param {string[]} comps 联赛列表
 */
async function collectAll(comps = ['BSA', 'SA', 'PD', 'BL1', 'FL1']) {
  const all = [];
  for (const comp of comps) {
    const r = await getFinishedMatches(comp, { limit: 100 });
    if (r.ok) {
      all.push(...r.data);
      console.log(`  ${comp}: +${r.data.length} 场（共 ${all.length}）`);
    } else {
      console.warn(`  ${comp}: ${r.error}`);
    }
    // 限流间隔
    await new Promise(r => setTimeout(r, 3000));
  }
  return all;
}

/* ============================================
   导出
   ============================================ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { setApiKey, getApiKey, getFinishedMatches, getUpcomingMatches, toTrainingSample, getOdds, collectAll, COMPETITIONS };
}
if (typeof window !== 'undefined') {
  window.FootballData = { setApiKey, getApiKey, getFinishedMatches, getUpcomingMatches, toTrainingSample, getOdds, collectAll, COMPETITIONS };
}

})();
