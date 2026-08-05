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
var lastApiKey = null;
var availableSportKeys = null; /* 当前 key 可用的 sport key 列表 */

function resetPlatformState(apiKey) {
  workingPlatform = null;
  availableSportKeys = null;
  lastApiKey = apiKey;
  try {
    localStorage.removeItem('jc_odds_sports_cache');
  } catch (e) {}
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

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

  /* 旧版 the-odds-api.com/v4/：/v4/sports/{sport}/odds/?apiKey=xxx */
  var v4Path = '/v4/sports/' + sport + '/odds/?apiKey=' + apiKey + qs;
  if (direct) return 'https://api.the-odds-api.com' + v4Path;
  return (proxyBase || '') + '/api/odds/v4' + v4Path;
}

/* 构建 /sports 列表 URL */
function buildSportsUrl(platform, apiKey) {
  var direct = (typeof window !== 'undefined' && window.JC_DIRECT) || (typeof window === 'undefined');
  var proxyBase = (typeof window !== 'undefined' && window.JC_API_BASE) || '';

  if (platform === 'new') {
    var newPath = '/sports/?apiKey=' + apiKey;
    if (direct) return 'https://api.theoddsapi.com' + newPath;
    return (proxyBase || '') + '/api/odds/new' + newPath;
  }

  var v4Path = '/v4/sports/?apiKey=' + apiKey;
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
  '墨西哥甲': 'soccer_mexico_ligamx',
  '墨超': 'soccer_mexico_ligamx',
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

/* 候选 broad-search sport key（会按 /sports 返回的实际可用 key 过滤） */
var BROAD_CANDIDATES = [
  'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
  'soccer_germany_bundesliga', 'soccer_france_ligue_one',
  'soccer_brazil_campeonato', 'soccer_uefa_champs_league',
  'soccer_uefa_europa_league', 'soccer_uefa_europa_conference_league',
  'soccer_turkey_super_league', 'soccer_portugal_primeira_liga',
  'soccer_netherlands_eredivisie', 'soccer_argentina_primera_division',
  'soccer_mexico_ligamx', 'soccer_usa_mls', 'soccer_japan_j_league',
  'soccer_korea_k_league', 'soccer_saudi_pro_league'
];

/**
 * 从竞彩比赛列表提取所需的 The Odds API sport keys
 * @param {Array} jcMatches 竞彩比赛列表
 * @param {Array} [availableKeys] 当前平台可用 sport key 列表
 * @returns {Object} { keys, unmapped }
 */
function detectSportKeys(jcMatches, availableKeys) {
  var keys = {};
  var unmapped = {};
  var keySet = availableKeys && availableKeys.length ? {} : null;
  if (keySet) {
    availableKeys.forEach(function(k) { keySet[k] = true; });
  }

  jcMatches.forEach(function(m) {
    var league = m.league || m.leagueFull || '';
    var mapped = LEAGUE_MAP[league];
    if (mapped) {
      if (!keySet || keySet[mapped]) {
        keys[mapped] = true;
      } else {
        unmapped[league] = mapped + '（当前平台不可用）';
      }
    } else {
      unmapped[league] = '无映射';
    }
  });

  var result = Object.keys(keys);
  var unmappedList = Object.keys(unmapped).map(function(k) {
    return k + ' → ' + unmapped[k];
  });
  return {
    keys: result.length ? result : ['soccer_epl'],
    unmapped: unmappedList
  };
}

/* ============================================
   通用 fetch + 错误处理
   ============================================ */
async function fetchJSON(url, opts) {
  opts = opts || {};
  var init = {
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  };
  if (opts.headers) Object.assign(init.headers, opts.headers);
  var res = await fetch(url, init);
  if (!res.ok) {
    var bodyText = '';
    try { bodyText = await res.text(); } catch (e) {}
    return { ok: false, status: res.status, bodyText: bodyText };
  }
  var data = await res.json();
  return { ok: true, status: res.status, data: data };
}

async function fetchSports(apiKey, platform) {
  var url = buildSportsUrl(platform, apiKey);
  var headers = { 'Accept': 'application/json' };
  if (platform === 'new') headers['x-api-key'] = apiKey;
  var r = await fetchJSON(url, { headers: headers });
  if (!r.ok) return { ok: false, platform: platform, error: r.status };

  var list = Array.isArray(r.data) ? r.data : (r.data.data || r.data.sports || []);
  var keys = list.map(function(s) { return s.key; }).filter(Boolean);
  return { ok: true, platform: platform, keys: keys, raw: list };
}

/* 获取当前 key 下可用 sport key，带 1 小时缓存 */
async function getAvailableKeys(apiKey) {
  if (availableSportKeys && availableSportKeys.length) return availableSportKeys;

  try {
    var cached = JSON.parse(localStorage.getItem('jc_odds_sports_cache') || 'null');
    if (cached && cached.key === apiKey && cached.ts && (Date.now() - cached.ts) < 3600000) {
      workingPlatform = cached.platform || workingPlatform;
      availableSportKeys = cached.keys || [];
      return availableSportKeys;
    }
  } catch (e) {}

  /* 先探测新版 */
  var newR = await fetchSports(apiKey, 'new');
  if (newR.ok && newR.keys.length) {
    workingPlatform = 'new';
    availableSportKeys = newR.keys;
  } else {
    var v4R = await fetchSports(apiKey, 'v4');
    if (v4R.ok && v4R.keys.length) {
      workingPlatform = 'v4';
      availableSportKeys = v4R.keys;
    } else {
      /* 都失败则使用候选列表，后续按请求结果过滤 */
      availableSportKeys = BROAD_CANDIDATES.slice();
      workingPlatform = 'new';
    }
  }

  try {
    localStorage.setItem('jc_odds_sports_cache', JSON.stringify({
      key: apiKey,
      ts: Date.now(),
      platform: workingPlatform,
      keys: availableSportKeys
    }));
  } catch (e) {}

  return availableSportKeys;
}

/**
 * 拉取单个运动在一个平台上的赔率，带 429 重试
 * @returns {Promise<{ok, data, error, platform, status, rawCount}>}
 */
async function fetchOneSportOnPlatform(platform, sport, apiKey, attempt) {
  attempt = attempt || 0;
  var url = buildUrl(platform, sport, apiKey);
  try {
    var headers = { 'Accept': 'application/json' };
    if (platform === 'new') headers['x-api-key'] = apiKey;
    var res = await fetch(url, { headers: headers });
    if (!res.ok) {
      var hints = {
        401: 'API Key 无效或已过期',
        403: 'Key 被拒绝（可能平台不匹配或免费版无权访问该联赛）',
        422: 'Key 格式错误',
        429: '请求太频繁（429）'
      };
      var errText = hints[res.status] || ('HTTP ' + res.status);
      try {
        var body = await res.json();
        if (body && body.message) errText = body.message;
      } catch (e) {}
      /* 429 时指数退避重试 */
      if (res.status === 429 && attempt < 2) {
        await sleep(500 * Math.pow(2, attempt));
        return fetchOneSportOnPlatform(platform, sport, apiKey, attempt + 1);
      }
      return { ok: false, error: errText, platform: platform, status: res.status };
    }
    var data = await res.json();
    /* 新版平台返回 { events: [...] } 或 { data: [...] }，旧版直接是数组 */
    var events = Array.isArray(data) ? data : (data.events || data.data || []);
    return { ok: true, data: normalizeOdds(events, sport), platform: platform, rawCount: events.length };
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
    return fetchOneSportOnPlatform(workingPlatform, sport, apiKey);
  }
  /* 未探明：先试新版，失败（认证类）再试旧版 */
  var newR = await fetchOneSportOnPlatform('new', sport, apiKey);
  if (newR.ok || (newR.status && newR.status !== 401 && newR.status !== 403)) {
    if (newR.ok) workingPlatform = 'new';
    return newR;
  }
  var v4R = await fetchOneSportOnPlatform('v4', sport, apiKey);
  if (v4R.ok) workingPlatform = 'v4';
  return v4R.ok ? v4R : newR;
}

/**
 * 标准化：提取每家公司的平均赔率
 * The Odds API 足球 h2h 的 outcomes 使用真实队名 + "Draw"，需要按队名匹配
 */
function normalizeOdds(raw, sportKey) {
  return raw.map(function(m) {
    var homeTeam = (m.home_team || '').trim();
    var awayTeam = (m.away_team || '').trim();
    var homeOdds = [], drawOdds = [], awayOdds = [];

    (m.bookmakers || []).forEach(function(b) {
      var h2h = (b.markets || []).find(function(mk) { return mk.key === 'h2h'; });
      if (h2h && h2h.outcomes) {
        h2h.outcomes.forEach(function(x) {
          var name = (x.name || '').trim();
          var price = x.price;
          if (!price || price <= 1) return;
          if (name === homeTeam || name === 'Home') homeOdds.push(price);
          else if (name === awayTeam || name === 'Away') awayOdds.push(price);
          else if (/^draw$/i.test(name)) drawOdds.push(price);
        });
      }
    });

    var avg = function(a) { return a.length ? +(a.reduce(function(x, y) { return x + y; }, 0) / a.length).toFixed(3) : 0; };
    return {
      homeTeam: homeTeam,
      awayTeam: awayTeam,
      sportKey: sportKey || '',
      commence: m.commence_time || m.start_time || m.commenceTime,
      odds: { h: avg(homeOdds), d: avg(drawOdds), a: avg(awayOdds) },
      bookmakers: (m.bookmakers || []).length
    };
  }).filter(function(m) { return m.odds.h > 1 && m.odds.a > 1; });
}

/**
 * 按比赛时间 + 联赛匹配竞彩比赛与国际赔率
 * @param {Array} jcMatches 竞彩比赛
 * @param {Array} intOdds 国际赔率
 * @returns {Array} 匹配结果 [{ jcMatch, intOdd, score }]
 */
function matchByTime(jcMatches, intOdds) {
  var results = [];
  jcMatches.forEach(function(jc) {
    var jcTs = null;
    if (jc.date && jc.time) {
      var d = String(jc.date).replace(/\//g, '-');
      var t = jc.time;
      // 竞彩日期可能是 MM-DD 或 YYYY-MM-DD；补全年份
      if (/^\d{2}-\d{2}$/.test(d)) {
        d = new Date().getFullYear() + '-' + d;
      }
      jcTs = new Date(d + 'T' + t + ':00+08:00').getTime();
    }

    var bestMatch = null;
    var bestScore = 0;
    intOdds.forEach(function(io) {
      var ioTs = io.commence ? new Date(io.commence).getTime() : 0;
      if (!jcTs || !ioTs) return;

      var diffH = Math.abs(jcTs - ioTs) / 3600000;
      if (diffH > 24) return; // 放宽到24小时（杯赛/资格赛经常跨时区或挂牌时间差异大）

      // 时间分：<=1h 0.8, <=3h 0.5, <=6h 0.35, <=12h 0.2, <=24h 0.1
      var timeScore = diffH <= 1 ? 0.8 : diffH <= 3 ? 0.5 : diffH <= 6 ? 0.35 : diffH <= 12 ? 0.2 : 0.1;

      // 队名匹配：中英文/简称/全名互相子串包含，给 bonus
      function nameSimilar(a, b) {
        if (!a || !b) return 0;
        a = a.toLowerCase().replace(/\s+/g, '');
        b = b.toLowerCase().replace(/\s+/g, '');
        if (a === b) return 1;
        // 互相包含
        if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 0.8;
        // 一方包含另一方前 2~4 字符（处理首字母缩写/简称）
        for (var len = 4; len >= 2; len--) {
          var seg = a.slice(0, len);
          if (seg.length >= 2 && b.indexOf(seg) >= 0) return 0.5;
          seg = b.slice(0, len);
          if (seg.length >= 2 && a.indexOf(seg) >= 0) return 0.5;
        }
        return 0;
      }

      var nameScore = 0;
      nameScore += nameSimilar(io.homeTeam, jc.homeTeam) * 0.35;
      nameScore += nameSimilar(io.awayTeam, jc.awayTeam) * 0.35;

      // 联赛映射 bonus：如果该国际赔率来自我们映射的 sport key，额外加分
      var leagueBonus = 0;
      var jcLeague = (jc.league || jc.leagueFull || '').trim();
      if (jcLeague && LEAGUE_MAP[jcLeague] && io.sportKey === LEAGUE_MAP[jcLeague]) {
        leagueBonus = 0.15;
      }

      var total = timeScore + nameScore + leagueBonus;
      if (total > bestScore) {
        bestScore = total;
        bestMatch = io;
      }
    });

    // 阈值：>=0.5（时间<=3h 即可；或时间<=6h+队名一队匹配）
    if (bestMatch && bestScore >= 0.5) {
      results.push({ jcMatch: jc, intOdd: bestMatch, score: bestScore });
    }
  });
  return results;
}

/* 带并发限制的异步任务调度 */
async function runWithConcurrency(tasks, concurrency) {
  concurrency = concurrency || 3;
  var results = new Array(tasks.length);
  var running = 0;
  var index = 0;

  return new Promise(function(resolve, reject) {
    function next() {
      if (index >= tasks.length) {
        if (running === 0) resolve(results);
        return;
      }
      var i = index++;
      running++;
      tasks[i]().then(function(r) {
        results[i] = { status: 'fulfilled', value: r };
        running--;
        next();
      }).catch(function(e) {
        results[i] = { status: 'rejected', reason: e };
        running--;
        next();
      });
      if (running < concurrency) next();
    }
    next();
  });
}

/**
 * 获取国际赔率（主入口）
 * @param {string} sport 运动 key（单运动模式，可空）
 * @param {string} apiKey API Key
 * @param {Array} jcMatches 可选：竞彩比赛列表，传入后自动多运动拉取
 * @param {Object} opts { skipBroad: bool }
 */
async function getOdds(sport, apiKey, jcMatches, opts) {
  opts = opts || {};
  if (!apiKey) return { ok: false, error: '未配置 API Key' };

  /* key 切换时重置平台状态 */
  if (apiKey !== lastApiKey) resetPlatformState(apiKey);

  /* 获取可用 sport keys */
  var availableKeys = await getAvailableKeys(apiKey);

  /* 配额检查 */
  var remaining = getRemainingQuota();
  var detected = detectSportKeys(jcMatches && jcMatches.length ? jcMatches : [], availableKeys);
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

  /* 特定联赛无数据 → broad-search 兜底 */
  var broadTried = false;
  var broadFound = false;
  var broadSearchKeys = [];
  if (!allOdds.length && !opts.skipBroad && (jcMatches && jcMatches.length)) {
    broadTried = true;
    /* 过滤出当前平台真实可用的 key */
    var keySet = {};
    availableKeys.forEach(function(k) { keySet[k] = true; });
    broadSearchKeys = BROAD_CANDIDATES.filter(function(k) { return keySet[k]; });

    if (broadSearchKeys.length) {
      var broadTasks = broadSearchKeys.map(function(sk) {
        return function() {
          return fetchOneSport(sk, apiKey).then(function(r) {
            perKey['broad:' + sk] = r;
            return r;
          });
        };
      });

      var broadResults = await runWithConcurrency(broadTasks, 3);
      broadResults.forEach(function(r) {
        if (r.status === 'fulfilled' && r.value.ok && r.value.data && r.value.data.length) {
          allOdds = allOdds.concat(r.value.data);
          broadFound = true;
        }
      });
      incrementUsedCount(broadSearchKeys.length);
    }
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
        broadFound: broadFound,
        broadSearchKeys: broadSearchKeys
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
      broadUsed: broadTried && broadFound,
      broadSearchKeys: broadSearchKeys
    }
  };
}

/* Node 环境导出 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getOdds, normalizeOdds, detectSportKeys, matchByTime, LEAGUE_MAP,
    getUsedCount, getRemainingQuota, isQuotaExceeded, FREE_QUOTA,
    buildUrl, buildSportsUrl, BROAD_CANDIDATES
  };
}

/* 浏览器全局挂载 */
if (typeof window !== 'undefined') {
  window.OddsApi = {
    getOdds, normalizeOdds, detectSportKeys, matchByTime, LEAGUE_MAP,
    getUsedCount, getRemainingQuota, isQuotaExceeded, FREE_QUOTA,
    buildUrl, buildSportsUrl, BROAD_CANDIDATES
  };
}

})();
