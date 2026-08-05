/**
 * oddsApi.js — The Odds API 封装（国际赔率）
 * 竞彩智选 Pro · API 层
 *
 * 兼容两个平台（自动探测）：
 *   旧版 the-odds-api.com/v4/  → ?apiKey= 参数认证
 *   新版 theoddsapi.com        → x-api-key 头认证（?apiKey= 浏览器测试可用）
 *
 * 三层代理策略（本地/云端统一）：
 *   1) 本地预览：JC_API_BASE='' → 同源 /api/odds/* 走 local_server.py
 *   2) 云端 SCF：JC_API_BASE=SCF域名 → /api/odds/* 走云函数
 *   3) 云端直连：JC_DIRECT=true → 直连 api.the-odds-api.com / api.theoddsapi.com
 *
 * 配额管理：免费版 500 次/月，localStorage 月度持久化
 */

(function() {
/* 配置获取：浏览器用全局 CONFIG，Node 用 require */
var CONFIG;
if (typeof window !== 'undefined' && window.CONFIG) {
  CONFIG = window.CONFIG;
} else {
  try {
    CONFIG = require('../../config/config.js');
  } catch (e) {
    CONFIG = { dataSources: { oddsApi: {} } };
  }
}

/* ============================================
   API 调用配额管理
   ============================================ */
var FREE_QUOTA = 500; /* 免费版每月 500 次 */

function getQuotaKey() {
  var d = new Date();
  return 'jc_odds_quota_' + d.getFullYear() + '_' + String(d.getMonth() + 1).padStart(2, '0');
}

function getUsedCount() {
  try {
    var data = JSON.parse(localStorage.getItem(getQuotaKey()) || '{"count":0}');
    return data.count || 0;
  } catch (e) { return 0; }
}

function incrementUsedCount(n) {
  n = n || 1;
  try {
    var key = getQuotaKey();
    var data = JSON.parse(localStorage.getItem(key) || '{"count":0}');
    data.count = (data.count || 0) + n;
    data.lastCall = new Date().toISOString();
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) { /* 存储失败忽略 */ }
}

function getRemainingQuota() {
  return Math.max(0, FREE_QUOTA - getUsedCount());
}

function isQuotaExceeded() {
  return getUsedCount() >= FREE_QUOTA;
}

/* ============================================
   平台自动探测（旧版 v4 / 新版 theoddsapi.com）
   ============================================ */
/* null = 未探测；'v4' = 旧版；'new' = 新版 */
var workingPlatform = null;

/* 构建请求 URL（支持代理/直连 + 双平台） */
function buildUrl(platform, sport, apiKey) {
  var cfg = CONFIG.dataSources.oddsApi;
  var direct = (typeof window !== 'undefined' && window.JC_DIRECT) || (typeof window === 'undefined');
  var proxyBase = (typeof window !== 'undefined' && window.JC_API_BASE) || '';

  var qs = '&regions=' + cfg.regions + '&markets=' + cfg.markets + '&oddsFormat=decimal';

  if (platform === 'new') {
    /* 新版 theoddsapi.com：/odds/?sport_key=xxx&apiKey=xxx */
    var newPath = '/odds/?sport_key=' + sport + qs + '&apiKey=' + apiKey;
    if (direct) return 'https://api.theoddsapi.com' + newPath;
    return (proxyBase || '') + '/api/odds/new' + newPath;
  }

  /* 旧版 the-odds-api.com/v4/：/v4/sports/xxx/odds/?apiKey=xxx */
  var v4Path = '/v4/sports/' + sport + '/odds/?apiKey=' + apiKey + qs;
  if (direct) return 'https://api.the-odds-api.com' + v4Path;
  return (proxyBase || '') + '/api/odds/v4' + v4Path;
}

/* ============================================
   竞彩联赛 → The Odds API sport key 映射
   覆盖竞彩常见联赛 + 杯赛（杯赛映射到对应国家顶级联赛作代理）
   ============================================ */
var LEAGUE_MAP = {
  /* 顶级联赛 */
  '英超': 'soccer_epl',
  '英冠': 'soccer_efl_champ',
  '西甲': 'soccer_spain_la_liga',
  '意甲': 'soccer_italy_serie_a',
  '德甲': 'soccer_germany_bundesliga',
  '法甲': 'soccer_france_ligue_one',
  '巴甲': 'soccer_brazil_campeonato',
  '日职': 'soccer_japan_j_league',
  '日乙': 'soccer_japan_j2_league',
  '韩K': 'soccer_korea_k_league',
  '美职': 'soccer_usa_mls',
  '欧冠': 'soccer_uefa_champs_league',
  '欧联': 'soccer_uefa_europa_league',
  '欧会杯': 'soccer_uefa_europa_conference_league',
  '土超': 'soccer_turkey_super_league',
  '葡超': 'soccer_portugal_primeira_liga',
  '荷甲': 'soccer_netherlands_eredivisie',
  '比甲': 'soccer_belgium_first_div',
  '苏超': 'soccer_scotland_premiership',
  '瑞超': 'soccer_sweden_allsvenskan',
  '挪超': 'soccer_norway_eliteserien',
  '丹超': 'soccer_denmark_superliga',
  '奥超': 'soccer_austria_bundesliga',
  '瑞士超': 'soccer_swiss_superleague',
  '希腊超': 'soccer_greece_super_league',
  '捷甲': 'soccer_czech_first_league',
  '波兰超': 'soccer_poland_ekstraklasa',
  '俄超': 'soccer_russia_premier_league',
  '以超': 'soccer_israel_premier_league',
  '中超': 'soccer_china_superleague',
  '澳超': 'soccer_australia_aleague',
  '哥伦甲': 'soccer_colombia_primera_a',
  '阿甲': 'soccer_argentina_primera_division',
  '墨西哥甲': 'soccer_mexico_liga_mx',
  '沙特超': 'soccer_saudi_pro_league',
  '欧国联': 'soccer_uefa_nations_league',
  '世预赛': 'soccer_fifa_world_cup_qualifying',
  '亚洲杯': 'soccer_afc_asian_cup',
  '非洲杯': 'soccer_africa_cup_of_nations',
  '欧洲杯': 'soccer_uefa_euro',
  '美洲杯': 'soccer_copa_america',
  '解放者杯': 'soccer_copa_libertadores',
  /* 杯赛 → 映射到对应国家/地区顶级联赛（The Odds API 不单独覆盖杯赛） */
  '巴西杯': 'soccer_brazil_campeonato',
  '英格兰足总杯': 'soccer_efl_champ',
  '意大利杯': 'soccer_italy_serie_a',
  '德国杯': 'soccer_germany_bundesliga',
  '法国杯': 'soccer_france_ligue_one',
  '西班牙国王杯': 'soccer_spain_la_liga',
  '日本联赛杯': 'soccer_japan_j_league',
  '韩国杯': 'soccer_korea_k_league',
  '中国足协杯': 'soccer_china_superleague',
  '荷兰杯': 'soccer_netherlands_eredivisie',
  '葡萄牙杯': 'soccer_portugal_primeira_liga',
  '土耳其杯': 'soccer_turkey_super_league',
  '苏格兰杯': 'soccer_scotland_premiership',
  '比利时杯': 'soccer_belgium_first_div',
  '丹麦杯': 'soccer_denmark_superliga',
  '奥地利杯': 'soccer_austria_bundesliga',
  '瑞士杯': 'soccer_swiss_superleague',
  '波兰杯': 'soccer_poland_ekstraklasa',
  '俄罗斯杯': 'soccer_russia_premier_league',
  '以色列杯': 'soccer_israel_premier_league',
  '美国公开杯': 'soccer_usa_mls',
  '南美杯': 'soccer_copa_libertadores',
  '欧协联': 'soccer_uefa_europa_conference_league'
};

/* 用于 broad-search 的常用足球 sport key 列表 */
var BROAD_SEARCH_KEYS = [
  'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
  'soccer_germany_bundesliga', 'soccer_france_ligue_one',
  'soccer_brazil_campeonato', 'soccer_uefa_champs_league',
  'soccer_uefa_europa_league', 'soccer_uefa_europa_conference_league',
  'soccer_turkey_super_league', 'soccer_portugal_primeira_liga',
  'soccer_netherlands_eredivisie', 'soccer_argentina_primera_division',
  'soccer_mexico_liga_mx', 'soccer_usa_mls', 'soccer_japan_j_league',
  'soccer_korea_k_league', 'soccer_saudi_pro_league'
];

/**
 * 从竞彩比赛列表提取所需的 The Odds API sport keys
 * @param {Array} jcMatches 竞彩比赛列表
 * @returns {Array} 去重后的 sport key 数组
 */
function detectSportKeys(jcMatches) {
  var keys = {};
  var unmapped = {};
  jcMatches.forEach(function(m) {
    var league = m.league || m.leagueFull || '';
    if (LEAGUE_MAP[league]) {
      keys[LEAGUE_MAP[league]] = true;
    } else {
      unmapped[league] = true;
    }
  });
  var result = Object.keys(keys);
  return {
    keys: result.length ? result : ['soccer_epl'],
    unmapped: Object.keys(unmapped)
  };
}

/**
 * 拉取单个运动在一个平台上的赔率
 * @returns {Promise<{ok, data, error, platform, status}>}
 */
async function fetchOneSportOnPlatform(platform, sport, apiKey) {
  var url = buildUrl(platform, sport, apiKey);
  try {
    var res = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
      var hints = {
        401: 'API Key 无效或已过期',
        403: 'Key 被拒绝（可能平台不匹配）',
        422: 'Key 格式错误',
        429: '请求超限（免费版每月500次）'
      };
      var errText = hints[res.status] || ('HTTP ' + res.status);
      try {
        var body = await res.json();
        if (body && body.message) errText = body.message;
      } catch (e) {}
      return { ok: false, error: errText, platform: platform, status: res.status };
    }
    var data = await res.json();
    /* 新版平台返回 { events: [...] } 或 { data: [...] }，旧版直接是数组 */
    var events = Array.isArray(data) ? data : (data.events || data.data || []);
    return { ok: true, data: normalizeOdds(events), platform: platform, rawCount: events.length };
  } catch (e) {
    var msg = e.message || 'network error';
    if (msg === 'Failed to fetch' || msg === 'Load failed') {
      msg = '网络请求失败（可能是 CORS 被拦截或代理未配置）';
    }
    return { ok: false, error: msg, platform: platform };
  }
}

/**
 * 拉取单个运动：先试已探明的平台，未探明则新旧都试
 */
async function fetchOneSport(sport, apiKey) {
  if (workingPlatform) {
    var r = await fetchOneSportOnPlatform(workingPlatform, sport, apiKey);
    return r;
  }
  /* 未探明：先试新版，失败（认证类）再试旧版 */
  var newR = await fetchOneSportOnPlatform('new', sport, apiKey);
  if (newR.ok || (newR.status && newR.status !== 401 && newR.status !== 403)) {
    if (newR.ok) workingPlatform = 'new';
    return newR;
  }
  /* 新版认证失败，试旧版 */
  var v4R = await fetchOneSportOnPlatform('v4', sport, apiKey);
  if (v4R.ok) workingPlatform = 'v4';
  return v4R.ok ? v4R : newR; /* 返回有数据的那个；都失败则返回新版错误 */
}

/**
 * 标准化：提取每家公司的平均赔率
 */
function normalizeOdds(raw) {
  return raw.map(function(m) {
    var homeOdds = [], drawOdds = [], awayOdds = [];
    (m.bookmakers || []).forEach(function(b) {
      var h2h = (b.markets || []).find(function(mk) { return mk.key === 'h2h'; });
      if (h2h && h2h.outcomes) {
        var o = {};
        h2h.outcomes.forEach(function(x) { o[x.name] = x.price; });
        if (o.Home) homeOdds.push(o.Home);
        if (o.Draw) drawOdds.push(o.Draw);
        if (o.Away) awayOdds.push(o.Away);
      }
    });
    var avg = function(a) { return a.length ? +(a.reduce(function(x, y) { return x + y; }, 0) / a.length).toFixed(3) : 0; };
    return {
      homeTeam: m.home_team,
      awayTeam: m.away_team,
      commence: m.commence_time,
      odds: { h: avg(homeOdds), d: avg(drawOdds), a: avg(awayOdds) },
      bookmakers: (m.bookmakers || []).length
    };
  }).filter(function(m) { return m.odds.h > 1; });
}

/**
 * 按比赛时间 + 联赛匹配竞彩比赛与国际赔率
 * @param {Array} jcMatches 竞彩比赛
 * @param {Array} intOdds 国际赔率
 * @returns {Array} 匹配结果 [{ jcMatch, intOdd }]
 */
function matchByTime(jcMatches, intOdds) {
  var results = [];
  jcMatches.forEach(function(jc) {
    var jcTs = null;
    if (jc.date && jc.time) {
      var d = jc.date.replace(/-/g, '/');
      var t = jc.time;
      jcTs = new Date(d + 'T' + t + ':00+08:00').getTime();
    }

    var bestMatch = null;
    var bestScore = 0;
    intOdds.forEach(function(io) {
      var ioTs = io.commence ? new Date(io.commence).getTime() : 0;
      if (!jcTs || !ioTs) return;

      var diffH = Math.abs(jcTs - ioTs) / 3600000;
      if (diffH > 3) return;

      var timeScore = 1 - (diffH / 3);

      var nameScore = 0;
      var hn = (io.homeTeam || '').toLowerCase();
      var an = (io.awayTeam || '').toLowerCase();
      var h4 = (jc.homeTeam || '').slice(0, 3).toLowerCase();
      var a4 = (jc.awayTeam || '').slice(0, 3).toLowerCase();
      if (h4 && (hn.indexOf(h4) >= 0 || h4.indexOf(hn.slice(0, 3)) >= 0)) nameScore += 0.5;
      if (a4 && (an.indexOf(a4) >= 0 || a4.indexOf(an.slice(0, 3)) >= 0)) nameScore += 0.5;

      var total = timeScore + nameScore;
      if (total > bestScore) {
        bestScore = total;
        bestMatch = io;
      }
    });

    if (bestMatch && bestScore >= 0.3) {
      results.push({ jcMatch: jc, intOdd: bestMatch, score: bestScore });
    }
  });
  return results;
}

/**
 * 获取国际赔率（主入口）
 * @param {string} sport 运动 key（单运动模式，可空）
 * @param {string} apiKey API Key
 * @param {Array} jcMatches 可选：竞彩比赛列表，传入后自动多运动拉取
 * @param {Object} opts { broadSearch: bool }
 */
async function getOdds(sport, apiKey, jcMatches, opts) {
  opts = opts || {};
  if (!apiKey) return { ok: false, error: '未配置 API Key' };

  /* 配额检查 */
  var remaining = getRemainingQuota();
  var detected = detectSportKeys(jcMatches && jcMatches.length ? jcMatches : []);
  var sportKeys = (jcMatches && jcMatches.length) ? detected.keys : [sport || 'soccer_epl'];
  var needed = sportKeys.length;

  if (remaining < needed) {
    return {
      ok: false,
      error: 'API 配额不足：本月已用 ' + getUsedCount() + '/' + FREE_QUOTA +
        ' 次，本次需要 ' + needed + ' 次，剩余 ' + remaining + ' 次。' +
        '（每月 1 日自动重置，或升级付费套餐）',
      quota: { used: getUsedCount(), total: FREE_QUOTA, remaining: remaining, needed: needed }
    };
  }

  var allOdds = [];
  var errors = [];
  var perKey = {}; /* sport key → 结果描述 */

  var results = await Promise.allSettled(sportKeys.map(function(sk) {
    return fetchOneSport(sk, apiKey).then(function(r) {
      perKey[sk] = r;
      return r;
    });
  }));

  incrementUsedCount(needed);

  results.forEach(function(r, i) {
    if (r.status === 'fulfilled') {
      if (r.value.ok) {
        allOdds = allOdds.concat(r.value.data);
      } else {
        errors.push(sportKeys[i] + ': ' + r.value.error);
      }
    } else {
      errors.push(sportKeys[i] + ': ' + (r.reason && r.reason.message || 'unknown'));
    }
  });

  /* 特定联赛无数据 → broad-search 兜底（仅当未显式关闭） */
  var broadTried = false;
  var broadFound = false;
  if (!allOdds.length && !opts.skipBroad && (jcMatches && jcMatches.length)) {
    broadTried = true;
    var broadResults = await Promise.allSettled(BROAD_SEARCH_KEYS.map(function(sk) {
      return fetchOneSport(sk, apiKey).then(function(r) { perKey['broad:' + sk] = r; return r; });
    }));
    broadResults.forEach(function(r) {
      if (r.status === 'fulfilled' && r.value.ok && r.value.data && r.value.data.length) {
        allOdds = allOdds.concat(r.value.data);
        broadFound = true;
      }
    });
    incrementUsedCount(BROAD_SEARCH_KEYS.length);
  }

  if (!allOdds.length && errors.length) {
    return {
      ok: false,
      error: errors[0],
      partial: false,
      quota: { used: getUsedCount(), total: FREE_QUOTA },
      diagnosis: {
        detectedLeagues: (jcMatches || []).map(function(m) { return m.league || m.leagueFull; }),
        queriedKeys: sportKeys,
        unmappedLeagues: detected.unmapped,
        perKey: perKey,
        platform: workingPlatform,
        broadTried: broadTried,
        broadFound: broadFound
      }
    };
  }

  return {
    ok: true,
    data: allOdds,
    sportKeys: sportKeys,
    partial: errors.length > 0,
    quota: { used: getUsedCount(), total: FREE_QUOTA, remaining: getRemainingQuota() },
    diagnosis: {
      detectedLeagues: (jcMatches || []).map(function(m) { return m.league || m.leagueFull; }),
      queriedKeys: sportKeys,
      unmappedLeagues: detected.unmapped,
      perKey: perKey,
      platform: workingPlatform,
      broadTried: broadTried,
      broadFound: broadFound,
      broadUsed: broadTried && broadFound
    }
  };
}

/* Node 环境导出 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getOdds, normalizeOdds, detectSportKeys, matchByTime, LEAGUE_MAP,
    getUsedCount, getRemainingQuota, isQuotaExceeded, FREE_QUOTA,
    buildUrl, BROAD_SEARCH_KEYS
  };
}

/* 浏览器全局挂载 */
if (typeof window !== 'undefined') {
  window.OddsApi = {
    getOdds, normalizeOdds, detectSportKeys, matchByTime, LEAGUE_MAP,
    getUsedCount, getRemainingQuota, isQuotaExceeded, FREE_QUOTA,
    buildUrl, BROAD_SEARCH_KEYS
  };
}

})();
