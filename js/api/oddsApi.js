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
  let CONFIG;
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
  const FREE_QUOTA = 500; /* 免费版每月 500 次 */

  function getQuotaKey() {
    const d = new Date();
    return 'jc_odds_quota_' + d.getFullYear() + '_' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function getUsedCount() {
    try {
      const data = JSON.parse(localStorage.getItem(getQuotaKey()) || '{"count":0}');
      return data.count || 0;
    } catch (e) { return 0; }
  }

  function incrementUsedCount(n) {
    n = n || 1;
    try {
      const key = getQuotaKey();
      const data = JSON.parse(localStorage.getItem(key) || '{"count":0}');
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
  let workingPlatform = null;
  let lastApiKey = null;
  let availableSportKeys = null; /* 当前 key 可用的 sport key 列表 */
  /* session 内 sport key 黑名单（探测到的真实 404/422 列表）— 避免重复请求浪费配额 */
  let deadSportKeys = {};
  /* session 内 sport key 白名单（实测过 200 的列表） */
  let liveSportKeys = {};

  function resetPlatformState(apiKey) {
    workingPlatform = null;
    availableSportKeys = null;
    lastApiKey = apiKey;
    deadSportKeys = {};
    liveSportKeys = {};
    try {
      localStorage.removeItem('jc_odds_sports_cache');
    } catch (e) {}
  }

  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  /* 构建请求 URL（支持代理/直连 + 双平台） */
  function buildUrl(platform, sport, apiKey) {
    const cfg = CONFIG.dataSources.oddsApi;
    const direct = (typeof window !== 'undefined' && window.JC_DIRECT) || (typeof window === 'undefined');
    const proxyBase = (typeof window !== 'undefined' && window.JC_API_BASE) || '';

    const qs = '&regions=' + cfg.regions + '&markets=' + cfg.markets + '&oddsFormat=decimal';

    if (platform === 'new') {
    /* 新版 theoddsapi.com：/odds/?sport_key=xxx&apiKey=xxx */
      const newPath = '/odds/?sport_key=' + sport + qs + '&apiKey=' + apiKey;
      if (direct) return 'https://api.theoddsapi.com' + newPath;
      return (proxyBase || '') + '/api/odds/new' + newPath;
    }

    /* 旧版 the-odds-api.com/v4/：/v4/sports/{sport}/odds/?apiKey=xxx */
    const v4Path = '/v4/sports/' + sport + '/odds/?apiKey=' + apiKey + qs;
    if (direct) return 'https://api.the-odds-api.com' + v4Path;
    return (proxyBase || '') + '/api/odds/v4' + v4Path;
  }

  /* 构建 /sports 列表 URL */
  function buildSportsUrl(platform, apiKey) {
    const direct = (typeof window !== 'undefined' && window.JC_DIRECT) || (typeof window === 'undefined');
    const proxyBase = (typeof window !== 'undefined' && window.JC_API_BASE) || '';

    if (platform === 'new') {
      const newPath = '/sports/?apiKey=' + apiKey;
      if (direct) return 'https://api.theoddsapi.com' + newPath;
      return (proxyBase || '') + '/api/odds/new' + newPath;
    }

    const v4Path = '/v4/sports/?apiKey=' + apiKey;
    if (direct) return 'https://api.the-odds-api.com' + v4Path;
    return (proxyBase || '') + '/api/odds/v4' + v4Path;
  }

  /* ============================================
   竞彩联赛 → The Odds API sport key 映射
   覆盖竞彩常见联赛 + 杯赛（杯赛映射到对应国家顶级联赛作代理）
   ============================================ */
  const LEAGUE_MAP = {
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
    '日联赛杯': 'soccer_japan_j_league',
    '意杯': 'soccer_italy_serie_a',
    '意大利杯': 'soccer_italy_serie_a',
    '沙职': 'soccer_saudi_pro_league',
    '沙地联': 'soccer_saudi_pro_league',
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
  const BROAD_CANDIDATES = [
    'soccer_epl', 'soccer_spain_la_liga',
    'soccer_germany_bundesliga', 'soccer_france_ligue_one',
    'soccer_uefa_champs_league',
    'soccer_uefa_europa_league', 'soccer_uefa_europa_conference_league',
    'soccer_turkey_super_league', 'soccer_portugal_primeira_liga',
    'soccer_netherlands_eredivisie', 'soccer_argentina_primera_division',
    'soccer_mexico_ligamx', 'soccer_usa_mls',
    'soccer_korea_k_league', 'soccer_saudi_pro_league'
    /* 注：'soccer_italy_serie_a' / 'soccer_japan_j_league' / 'soccer_brazil_campeonato' /
       'soccer_sweden_allsvenskan' 已被实测 404/422，从兜底列表剔除（LEAGUE_MAP 命中后由
       deadSportKeys 在会话内拦截，不会再请求；本列表只放首次未确认的兜底） */
  ];

  /* ============================================
   竞彩中文队名 → 国际英文队名 别名表
   - 第一部分：BUILTIN_TEAM_ALIAS 覆盖今日及常见场次的 J 联赛/英冠/瑞超/沙职/巴甲/巴西杯/意大利杯
   - 第二部分：运行时懒加载 ml/data/team_alias.json（仅欧洲常驻段，跳过错配段）
   ============================================ */
  const BUILTIN_TEAM_ALIAS = {
  /* 日本 J1 / J2 联赛（J League / J2 League / 日联赛杯） */
    '日职': {
      '横滨水手': 'Yokohama F. Marinos', '神户胜利船': 'Vissel Kobe', '浦和红钻': 'Urawa Red Diamonds',
      '大阪钢巴': 'Gamba Osaka', '川崎前锋': 'Kawasaki Frontale', '名古屋鲸八': 'Nagoya Grampus',
      '鹿岛鹿角': 'Kashima Antlers', '广岛三箭': 'Sanfrecce Hiroshima', 'FC东京': 'FC Tokyo',
      '大阪樱花': 'Cerezo Osaka', '柏太阳神': 'Kashiwa Reysol', '东京绿茵': 'Tokyo Verdy',
      '新潟天鹅': 'Albirex Niigata', '京都不死鸟': 'Kyoto Sanga', '福冈黄蜂': 'Avispa Fukuoka',
      '鸟栖砂岩': 'Sagan Tosu', '清水心跳': 'Shimizu S-Pulse', '町田泽维亚': 'Machida Zelvia',
      '磐田喜悦': 'Jubilo Iwata', '冈山雉鸡': 'Fagiano Okayama',
      '浦和': 'Urawa Red Diamonds', '横滨': 'Yokohama F. Marinos'
    },
    '日联赛杯': {
      '八户南源': 'Vanraure Hachinohe', '枥木城': 'Tochigi SC', '山口雷诺法': 'Renofa Yamaguchi',
      '熊本深红': 'Roasso Kumamoto', '爱媛FC': 'Ehime FC', '千叶市原': 'JEF United Chiba',
      '札幌冈萨多': 'Consadole Sapporo', '仙台七夕': 'Vegalta Sendai',
      '大宫松鼠': 'Omiya Ardija', '德岛漩涡': 'Tokushima Vortis', '水户蜀葵': 'Mito HollyHock',
      '群马草津': 'Thespakusatsu Gunma', '长崎成功丸': 'V-Varen Nagasaki', '山形山神': 'Montedio Yamagata',
      '湘南丽海': 'Shonan Bellmare', 'FC琉球': 'FC Ryukyu', '甲府风林': 'Ventforet Kofu',
      '横滨FC': 'Yokohama FC', '町田泽维亚': 'Machida Zelvia', 'FC东京': 'FC Tokyo',
      '新潟天鹅': 'Albirex Niigata', '鹿岛鹿角': 'Kashima Antlers', '横滨水手': 'Yokohama F. Marinos',
      '川崎前锋': 'Kawasaki Frontale', '柏太阳神': 'Kashiwa Reysol', '大阪樱花': 'Cerezo Osaka'
    },
    '英冠': {
      '雷克斯汉姆': 'Wrexham', '米德尔斯堡': 'Middlesbrough', '南安普敦': 'Southampton',
      '伊普斯维奇': 'Ipswich', '考文垂': 'Coventry', '西布罗姆维奇': 'West Brom',
      '查尔顿': 'Charlton', '牛津联': 'Oxford United', '布莱克本': 'Blackburn',
      '朴次茅斯': 'Portsmouth', '伯明翰': 'Birmingham', '诺维奇': 'Norwich',
      '米尔沃尔': 'Millwall', '德比郡': 'Derby', '女王公园巡游者': 'QPR',
      '沃特福德': 'Watford', '赫尔城': 'Hull', '谢菲尔德星期三': 'Sheffield Wednesday',
      '斯旺西': 'Swansea', '谢菲尔德联': 'Sheffield United', '布里斯托城': 'Bristol City',
      '莱切斯特': 'Leicester', '普雷斯顿': 'Preston', '斯托克城': 'Stoke',
      '加的夫城': 'Cardiff', '雷丁': 'Reading', '巴恩斯利': 'Barnsley',
      '女王巡游者': 'QPR', '维冈': 'Wigan',
      '伯恩利': 'Burnley', '布莱克本流浪者': 'Blackburn', '牛津': 'Oxford United'
    },
    '瑞超': {
      '马尔默': 'Malmo', '佐加顿斯': 'Djurgarden', '北雪平': 'Norrkoping', '哈马比': 'Hammarby',
      'AIK索尔纳': 'AIK', '赫根': 'Hacken', '埃尔夫斯堡': 'Elfsborg', '耶夫勒': 'Gefle',
      '哥德堡': 'Goteborg', '瓦斯特拉斯': 'Vasteras', '卡尔马': 'Kalmar',
      '布鲁马波卡纳': 'Brommapojkarna', '哈尔姆斯塔德': 'Halmstad', '天狼星': 'Sirius',
      '米亚尔比': 'Mjallby', '韦纳穆': 'Varnamo', '赫恩赞': 'Helsingborg'
    },
    '沙职': {
      '利雅得胜利': 'Al Nassr', '利雅得新月': 'Al Hilal', '利雅得青年': 'Al Riyadh',
      '吉达联合': 'Al Ittihad', '吉达国民': 'Al Ahli', '吉达阿赫利': 'Al Ahli',
      '达曼协作': 'Damac', '阿尔泰': 'Al Tai', '阿尔卡利': 'Al Qadisiyah',
      '阿尔哈森': 'Al Hazem', '阿尔科赫德斯': 'Al Khaleej', '阿尔沙巴布': 'Al Shabab',
      '哈萨正义': 'Al Fateh', '塔亚文': 'Taawon', '阿赫利': 'Al Ahli', '布赖代合作': 'Al Taawon',
      '迈季迈阿宽广': 'Al Fayha', '拉斯永恒': 'Al Raed', '新未来SC': 'NEOM SC',
      '赛哈特海湾': 'Al Kholood', '迪里耶': 'Al Riyadh', '胡巴尔卡德西亚': 'Al Qadisiyah'
    },
    '法甲': {
      '巴黎圣曼': 'Paris Saint-Germain', '马赛': 'Marseille', '雷恩': 'Rennes', '里昂': 'Lyon',
      '朗斯': 'Lens', '布雷斯特': 'Brest', '斯特拉斯堡': 'Strasbourg', '南特': 'Nantes',
      '图卢兹': 'Toulouse', '里尔': 'Lille', '勒阿弗尔': 'Le Havre', '尼斯': 'Nice',
      '洛里昂': 'Lorient', '巴黎FC': 'Paris FC', '梅斯': 'Metz', '昂热': 'Angers',
      '摩纳哥': 'Monaco', '欧塞尔': 'Auxerre', '蒙彼利埃': 'Montpellier'
    },
    '意甲': {
      'AC米兰': 'AC Milan', '卡利亚里': 'Cagliari', '克雷莫纳': 'Cremonese', '科莫': 'Como',
      '都灵': 'Torino', '尤文图斯': 'Juventus', '维罗纳': 'Verona', '罗马': 'Roma',
      '拉齐奥': 'Lazio', '比萨': 'Pisa', '博洛尼亚': 'Bologna', '国际米兰': 'Inter Milan',
      '佛罗伦萨': 'Fiorentina', '亚特兰大': 'Atalanta', '萨索洛': 'Sassuolo', '莱切': 'Lecce',
      '帕尔马': 'Parma', '热那亚': 'Genoa', '那不勒斯': 'Napoli', '乌迪内斯': 'Udinese',
      '威尼斯': 'Venezia', '弗洛西诺内': 'Frosinone', '恩波利': 'Empoli', '蒙扎': 'Monza'
    },
    '意大利杯': {
      '萨索洛': 'Sassuolo', '弗洛西诺内': 'Frosinone', '乌迪内斯': 'Udinese', '威尼斯': 'Venezia',
      'AC米兰': 'AC Milan', '尤文图斯': 'Juventus', '国际米兰': 'Inter Milan',
      '那不勒斯': 'Napoli', '罗马': 'Roma', '拉齐奥': 'Lazio', '亚特兰大': 'Atalanta',
      '佛罗伦萨': 'Fiorentina', '都灵': 'Torino', '博洛尼亚': 'Bologna', '热那亚': 'Genoa'
    },
    '巴甲': {
      '帕尔梅拉斯': 'Palmeiras', '弗拉门戈': 'Flamengo', '科林蒂安': 'Corinthians',
      '圣保罗': 'Sao Paulo', '弗鲁米嫩塞': 'Fluminense', '米内罗竞技': 'Atletico Mineiro',
      '格雷米奥': 'Gremio', '国际体育': 'Internacional', '博塔弗戈': 'Botafogo',
      '福塔莱萨': 'Fortaleza', '阿瓦伊': 'Avai', '塞阿拉': 'Ceara', '库亚巴': 'Cuiaba',
      '巴伊亚': 'Bahia', '瓦斯科达伽马': 'Vasco', '戈亚斯': 'Goias', '米内罗美洲': 'America Mineiro',
      '尤文图德': 'Juventude', '布拉干蒂诺': 'Bragantino', '克鲁塞罗': 'Cruzeiro',
      '桑托斯': 'Santos',
      '米拉索尔': 'Mirassol', '巴西国际': 'Internacional', '巴拉纳竞技': 'Athletico Paranaense',
      '福塔雷萨': 'Fortaleza', '萨拉戈萨': 'Atletico Paranaense'
    },
    '巴西杯': {
      '弗拉门戈': 'Flamengo', '帕尔梅拉斯': 'Palmeiras', '圣保罗': 'Sao Paulo',
      '科林蒂安': 'Corinthians', '弗鲁米嫩塞': 'Fluminense', '博塔弗戈': 'Botafogo',
      '米内罗竞技': 'Atletico Mineiro', '格雷米奥': 'Gremio', '巴伊亚': 'Bahia',
      '桑托斯': 'Santos', '巴西国际': 'Internacional'
    },
    '西甲': {
      '比利亚雷亚尔': 'Villarreal', '马德里竞技': 'Atletico Madrid', '皇家贝蒂斯': 'Real Betis',
      '莱万特': 'Levante', '巴伦西亚': 'Valencia', '巴塞罗那': 'Barcelona', '阿拉维斯': 'Alaves',
      '巴列卡诺': 'Rayo Vallecano', '皇家马德里': 'Real Madrid', '毕尔巴鄂竞技': 'Athletic Bilbao',
      '马洛卡': 'Mallorca', '奥维耶多': 'Oviedo', '皇家社会': 'Real Sociedad', '塞尔塔': 'Celta Vigo',
      '奥萨苏纳': 'Osasuna', '西班牙人': 'Espanyol', '赫塔费': 'Getafe', '塞维利亚': 'Sevilla',
      '埃尔切': 'Elche', '赫罗纳': 'Girona',
      '维戈塞尔塔': 'Celta Vigo', '塞尔塔维戈': 'Celta Vigo'
    }
  };

  let _teamAliasesLoaded = false;
  let _teamAliasesLoading = null;

  /* 异步懒加载 ml/data/team_alias.json（仅欧洲常驻段，1 小时缓存） */
  async function getTeamAliases() {
    if (_teamAliasesLoaded) return BUILTIN_TEAM_ALIAS;
    if (_teamAliasesLoading) return _teamAliasesLoading;
    _teamAliasesLoading = new Promise(function(resolve) {
      try {
        const url = (typeof window !== 'undefined' && (window.JC_DATA_BASE || (window.JC_API_BASE || ''))) || '';
        const filePath = (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:')
          ? 'ml/data/team_alias.json'
          : (url ? (url + '/ml/data/team_alias.json') : 'ml/data/team_alias.json');
        fetch(filePath).then(function(r) { return r.ok ? r.json() : {}; }).then(function(aliases) {
          try {
          /* 仅合并非错配段：欧冠/欧协联历史别名表有噪声，跳过 */
            const safeLeagues = ['英格兰超级联赛', '英格兰冠军联赛', '英格兰甲级联赛',
              '法国甲级联赛', '法国乙级联赛', '西班牙甲级联赛', '意大利甲级联赛',
              '德国甲级联赛', '德国乙级联赛', '葡萄牙超级联赛', '荷兰甲级联赛'];
            const leagueToKey = {
              '英格兰超级联赛': '英超', '英格兰冠军联赛': '英冠', '英格兰甲级联赛': '英甲',
              '法国甲级联赛': '法甲', '法国乙级联赛': '法乙', '西班牙甲级联赛': '西甲',
              '意大利甲级联赛': '意甲', '德国甲级联赛': '德甲', '德国乙级联赛': '德乙',
              '葡萄牙超级联赛': '葡超', '荷兰甲级联赛': '荷甲'
            };
            safeLeagues.forEach(function(leagueZh) {
              const sub = aliases[leagueZh];
              if (!sub) return;
              const key = leagueToKey[leagueZh];
              if (!key) return;
              BUILTIN_TEAM_ALIAS[key] = BUILTIN_TEAM_ALIAS[key] || {};
              Object.keys(sub).forEach(function(cn) {
                if (!BUILTIN_TEAM_ALIAS[key][cn]) BUILTIN_TEAM_ALIAS[key][cn] = sub[cn];
              });
            });
          } catch (e) { /* 合并失败忽略，下次重试 */ }
          _teamAliasesLoaded = true;
          resolve(BUILTIN_TEAM_ALIAS);
        }).catch(function() { _teamAliasesLoaded = true; resolve(BUILTIN_TEAM_ALIAS); });
      } catch (e) {
        _teamAliasesLoaded = true;
        resolve(BUILTIN_TEAM_ALIAS);
      }
    });
    return _teamAliasesLoading;
  }

  /* 把竞彩中文队名按 (jc_league, jc_name) 解析为国际英文名（带 fallback） */
  function resolveTeamAlias(jcName, jcLeague) {
    if (!jcName) return null;
    const table = BUILTIN_TEAM_ALIAS;
  /* 优先按 jcLeague 命中（最准） */
    if (jcLeague && table[jcLeague] && table[jcLeague][jcName]) return table[jcLeague][jcName];
  /* 然后按队名字面命中（跨联赛共用别名） */
    const leagues = Object.keys(table);
    for (let i = 0; i < leagues.length; i++) {
      if (table[leagues[i]] && table[leagues[i]][jcName]) return table[leagues[i]][jcName];
    }
    return null;
  }

  /**
 * 从竞彩比赛列表提取所需的 The Odds API sport keys
 * @param {Array} jcMatches 竞彩比赛列表
 * @param {Array} [availableKeys] 当前平台可用 sport key 列表
 * @returns {Object} { keys, unmapped }
 */
  function detectSportKeys(jcMatches, availableKeys) {
    const keys = {};
    const unmapped = {};
    const keySet = availableKeys && availableKeys.length ? {} : null;
    if (keySet) {
      availableKeys.forEach(function(k) { keySet[k] = true; });
    }

    jcMatches.forEach(function(m) {
      const league = m.league || m.leagueFull || '';
      const mapped = LEAGUE_MAP[league];
      if (mapped) {
        /* session 内已知 dead → 不入请求队列 */
        if (deadSportKeys[mapped]) {
          unmapped[league] = mapped + '（本会话已确认不可用 HTTP ' + (deadSportKeys[mapped].status || '?') + '）';
          return;
        }
        if (!keySet || keySet[mapped]) {
          keys[mapped] = true;
        } else {
          unmapped[league] = mapped + '（当前平台不可用）';
        }
      } else {
        unmapped[league] = '无映射';
      }
    });

    const result = Object.keys(keys);
    const unmappedList = Object.keys(unmapped).map(function(k) {
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
    const init = {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    };
    if (opts.headers) Object.assign(init.headers, opts.headers);
    const res = await fetch(url, init);
    if (!res.ok) {
      let bodyText = '';
      try { bodyText = await res.text(); } catch (e) {}
      return { ok: false, status: res.status, bodyText: bodyText };
    }
    const data = await res.json();
    return { ok: true, status: res.status, data: data };
  }

  async function fetchSports(apiKey, platform) {
    const url = buildSportsUrl(platform, apiKey);
    const headers = { 'Accept': 'application/json' };
    if (platform === 'new') headers['x-api-key'] = apiKey;
    const r = await fetchJSON(url, { headers: headers });
    if (!r.ok) return { ok: false, platform: platform, error: r.status };

    const list = Array.isArray(r.data) ? r.data : (r.data.data || r.data.sports || []);
    const keys = list.map(function(s) { return s.key; }).filter(Boolean);
    return { ok: true, platform: platform, keys: keys, raw: list };
  }

  /* 获取当前 key 下可用 sport key，带 1 小时缓存 */
  async function getAvailableKeys(apiKey) {
    if (availableSportKeys && availableSportKeys.length) return availableSportKeys;

    try {
      const cached = JSON.parse(localStorage.getItem('jc_odds_sports_cache') || 'null');
      if (cached && cached.key === apiKey && cached.ts && (Date.now() - cached.ts) < 3600000) {
        workingPlatform = cached.platform || workingPlatform;
        availableSportKeys = cached.keys || [];
        return availableSportKeys;
      }
    } catch (e) {}

    /* 先探测新版 */
    const newR = await fetchSports(apiKey, 'new');
    if (newR.ok && newR.keys.length) {
      workingPlatform = 'new';
      availableSportKeys = newR.keys;
    } else {
      const v4R = await fetchSports(apiKey, 'v4');
      if (v4R.ok && v4R.keys.length) {
        workingPlatform = 'v4';
        availableSportKeys = v4R.keys;
      } else {
      /* 双平台探测均失败：默认仅信任历史白名单里的稳定联赛（保命，不浪费配额） */
        availableSportKeys = KNOWN_STABLE_KEYS.slice();
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

  /* 仅测过稳定返回的基线 sport key（探测失败兜底，绝不包含 404 高危项） */
  const KNOWN_STABLE_KEYS = [
    'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
    'soccer_germany_bundesliga', 'soccer_france_ligue_one',
    'soccer_brazil_campeonato', 'soccer_uefa_champs_league',
    'soccer_uefa_europa_league', 'soccer_uefa_europa_conference_league',
    'soccer_turkey_super_league', 'soccer_portugal_primeira_liga',
    'soccer_netherlands_eredivisie', 'soccer_korea_k_league',
    'soccer_saudi_pro_league', 'soccer_sweden_allsvenskan'
  ];

  /**
   * 拉取单个运动在一个平台上的赔率，带 429 重试
   * @returns {Promise<{ok, data, error, platform, status, rawCount, sport, skipQuota}>}
   * skipQuota=true 表示本请求不应计入额度（404/422/网络异常，避免空耗）
   */
  async function fetchOneSportOnPlatform(platform, sport, apiKey, attempt) {
    attempt = attempt || 0;
    const url = buildUrl(platform, sport, apiKey);
    try {
      const headers = { 'Accept': 'application/json' };
      if (platform === 'new') headers['x-api-key'] = apiKey;
      const res = await fetch(url, { headers: headers });
      if (!res.ok) {
        const hints = {
          401: 'API Key 无效或已过期',
          403: 'Key 被拒绝（可能平台不匹配或免费版无权访问该联赛）',
          404: '该 sport key 在 Odds API 中不存在（可能为地区/赛季覆盖外）',
          422: 'Key 格式错误',
          429: '请求太频繁（429）'
        };
        let errText = hints[res.status] || ('HTTP ' + res.status);
        try {
          const body = await res.json();
          if (body && body.message) errText = body.message;
        } catch (e) {}
        /* 404/422/403 标记 session 级 dead，per request 内避免重复请求 */
        if (res.status === 404 || res.status === 422 || res.status === 403) {
          deadSportKeys[sport] = { ts: Date.now(), status: res.status };
        }
        /* 429 时指数退避重试 */
        if (res.status === 429 && attempt < 2) {
          await sleep(500 * Math.pow(2, attempt));
          return fetchOneSportOnPlatform(platform, sport, apiKey, attempt + 1);
        }
        return { ok: false, error: errText, platform: platform, status: res.status, sport: sport, skipQuota: true };
      }
      const data = await res.json();
      /* 新版平台返回 { events: [...] } 或 { data: [...] }，旧版直接是数组 */
      const events = Array.isArray(data) ? data : (data.events || data.data || []);
      liveSportKeys[sport] = true;
      return { ok: true, data: normalizeOdds(events, sport), platform: platform, rawCount: events.length };
    } catch (e) {
      let msg = e.message || 'network error';
      if (msg === 'Failed to fetch' || msg === 'Load failed') {
        msg = '网络请求失败（可能是 CORS 被拦截或代理未配置）';
      }
      return { ok: false, error: msg, platform: platform, sport: sport, skipQuota: true };
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
    const newR = await fetchOneSportOnPlatform('new', sport, apiKey);
    if (newR.ok || (newR.status && newR.status !== 401 && newR.status !== 403)) {
      if (newR.ok) workingPlatform = 'new';
      return newR;
    }
    const v4R = await fetchOneSportOnPlatform('v4', sport, apiKey);
    if (v4R.ok) workingPlatform = 'v4';
    return v4R.ok ? v4R : newR;
  }

  /**
 * 标准化：提取每家公司的平均赔率
 * The Odds API 足球 h2h 的 outcomes 使用真实队名 + "Draw"，需要按队名匹配
 */
  function normalizeOdds(raw, sportKey) {
    return raw.map(function(m) {
      const homeTeam = (m.home_team || '').trim();
      const awayTeam = (m.away_team || '').trim();
      const homeOdds = [], drawOdds = [], awayOdds = [];

      /* 双格式兼容：
         旧版: m.bookmakers[].markets[].outcomes[]
         新版 (theoddsapi.com): m.books[].outcomes[]（market 在 book 上直挂） */
      const bookList = m.bookmakers || m.books || [];
      bookList.forEach(function(b) {
        /* 新版：b.outcomes 直接挂；旧版：b.markets[].outcomes */
        const markets = b.markets && b.markets.length ? b.markets
                      : (b.market ? [{ key: b.market, outcomes: b.outcomes || [] }]
                                  : [{ key: '', outcomes: b.outcomes || [] }]);
        markets.forEach(function(mk) {
          if (mk.key && mk.key !== 'h2h') return;
          (mk.outcomes || []).forEach(function(x) {
            const name = (x.name || '').trim();
            const price = x.price;
            if (!price || price <= 1) return;
            if (name === homeTeam || name === 'Home') homeOdds.push(price);
            else if (name === awayTeam || name === 'Away') awayOdds.push(price);
            else if (/^draw$/i.test(name)) drawOdds.push(price);
          });
        });
      });

      const avg = function(a) { return a.length ? +(a.reduce(function(x, y) { return x + y; }, 0) / a.length).toFixed(3) : 0; };
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
    const results = [];
    jcMatches.forEach(function(jc) {
      let jcTs = null;
      if (jc.date && jc.time) {
        let d = String(jc.date).replace(/\//g, '-');
      /* jc.time 形如 "17:30:00" 或 "17:30"，统一截为 HH:MM，避免拼出非法 ISO */
        const t = String(jc.time).slice(0, 5);
        // 竞彩日期可能是 MM-DD 或 YYYY-MM-DD；补全年份
        if (/^\d{2}-\d{2}$/.test(d)) {
          d = new Date().getFullYear() + '-' + d;
        }
        jcTs = new Date(d + 'T' + t + ':00+08:00').getTime();
      }

      const jcLeague = (jc.league || jc.leagueFull || '').trim();
    /* 用别名表把竞彩中文队名预先扩成候选英文（最多 2 个） */
      const jcHomeAlias = resolveTeamAlias(jc.homeTeam, jcLeague);
      const jcAwayAlias = resolveTeamAlias(jc.awayTeam, jcLeague);
      const jcHomeCandidates = [jc.homeTeam, jcHomeAlias].filter(Boolean);
      const jcAwayCandidates = [jc.awayTeam, jcAwayAlias].filter(Boolean);

      let bestMatch = null;
      let bestScore = 0;
      let bestLeagueMatched = false;
      intOdds.forEach(function(io) {
        const ioTs = io.commence ? new Date(io.commence).getTime() : 0;
        if (!jcTs || isNaN(jcTs) || !ioTs) return;

        const diffH = Math.abs(jcTs - ioTs) / 3600000;
        if (diffH > 24) return; // 放宽到24小时（杯赛/资格赛经常跨时区或挂牌时间差异大）

        // 时间分：<=1h 0.8, <=3h 0.5, <=6h 0.35, <=12h 0.2, <=24h 0.1
        const timeScore = diffH <= 1 ? 0.8 : diffH <= 3 ? 0.5 : diffH <= 6 ? 0.35 : diffH <= 12 ? 0.2 : 0.1;

        // 队名匹配：中英文/简称/全名互相子串包含，给 bonus
        function nameSimilar(a, b) {
          if (!a || !b) return 0;
          a = a.toLowerCase().replace(/\s+/g, '');
          b = b.toLowerCase().replace(/\s+/g, '');
          if (a === b) return 1;
          // 互相包含
          if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 0.8;
          // 一方包含另一方前 3~4 字符（避免 'al/co/in' 等高频 2 字符误命中不相关队名）
          for (let len = 4; len >= 3; len--) {
            let seg = a.slice(0, len);
            if (seg.length >= 3 && b.indexOf(seg) >= 0) return 0.5;
            seg = b.slice(0, len);
            if (seg.length >= 3 && a.indexOf(seg) >= 0) return 0.5;
          }
          return 0;
        }

      /* 取 jc 主/客候选中与 io 主/客最佳匹配（解决一队命中即可的痛点） */
        function bestPairScore(ioName, jcCandidates) {
          let s = 0;
          for (let i = 0; i < jcCandidates.length; i++) {
            const v = nameSimilar(ioName, jcCandidates[i]);
            if (v > s) s = v;
          }
          return s;
        }
        const homeNameScore = bestPairScore(io.homeTeam, jcHomeCandidates);
        const awayNameScore = bestPairScore(io.awayTeam, jcAwayCandidates);
      /* 同时校验交叉：io 主队 vs jc 客候选（防止互换）——值很大时反向可比 */
        const crossHomeAway = bestPairScore(io.homeTeam, jcAwayCandidates);
        const crossAwayHome = bestPairScore(io.awayTeam, jcHomeCandidates);
      /* 若正向都低（<0.3）但 cross 任一 ≥0.5，疑似 io 队名与 jc 另一队名更接近，跳过 */
        let nameScore = homeNameScore * 0.35 + awayNameScore * 0.35;
        if (homeNameScore < 0.3 && awayNameScore < 0.3 && (crossHomeAway >= 0.5 || crossAwayHome >= 0.5)) {
          return;
        }

        // 联赛映射 bonus：如果该国际赔率来自我们映射的 sport key，额外加分
        let leagueBonus = 0;
        let leagueMatched = false;
        if (jcLeague && LEAGUE_MAP[jcLeague] && io.sportKey === LEAGUE_MAP[jcLeague]) {
          leagueBonus = 0.15;
          leagueMatched = true;
        }

        const total = timeScore + nameScore + leagueBonus;
        if (total > bestScore) {
          bestScore = total;
          bestMatch = io;
          bestLeagueMatched = leagueMatched;
        }
      });

      // 阈值：常规 >=0.5；联赛映射命中时降到 >=0.35（应对短名队被时分低拉分）
      const threshold = bestLeagueMatched ? 0.35 : 0.5;
      if (bestMatch && bestScore >= threshold) {
        results.push({ jcMatch: jc, intOdd: bestMatch, score: bestScore, leagueMatched: bestLeagueMatched });
      }
    });
    return results;
  }

  /* 同步版（已加载别名表前提下可用），便于 Node 冒烟测试 */
  function matchByTimeSync(jcMatches, intOdds) {
    return matchByTime(jcMatches, intOdds);
  }

  /* 带并发限制的异步任务调度 */
  async function runWithConcurrency(tasks, concurrency) {
    concurrency = concurrency || 3;
    const results = new Array(tasks.length);
    let running = 0;
    let index = 0;

    return new Promise(function(resolve, reject) {
      function next() {
        if (index >= tasks.length) {
          if (running === 0) resolve(results);
          return;
        }
        const i = index++;
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
    const availableKeys = await getAvailableKeys(apiKey);

    /* 配额检查 */
    const remaining = getRemainingQuota();
    const detected = detectSportKeys(jcMatches && jcMatches.length ? jcMatches : [], availableKeys);
    const sportKeys = (jcMatches && jcMatches.length) ? detected.keys : [sport || 'soccer_epl'];
    const needed = sportKeys.length;

    if (remaining < needed) {
      return {
        ok: false,
        error: 'API 配额不足：本月已用 ' + getUsedCount() + '/' + FREE_QUOTA +
        ' 次，本次需要 ' + needed + ' 次，剩余 ' + remaining + ' 次。' +
        '（每月 1 日自动重置，或升级付费套餐）',
        quota: { used: getUsedCount(), total: FREE_QUOTA, remaining: remaining, needed: needed }
      };
    }

    let allOdds = [];
    const errors = [];
    const perKey = {}; /* sport key → 结果描述 */

    const results = await Promise.allSettled(sportKeys.map(function(sk) {
      return fetchOneSport(sk, apiKey).then(function(r) {
        perKey[sk] = r;
        return r;
      });
    }));

    /* 配额扣减：仅对成功（200）请求计费；404/422/网络异常等 skipQuota 不计 */
    let successCount = 0;
    results.forEach(function(r) {
      if (r.status === 'fulfilled' && r.value && r.value.ok && !r.value.skipQuota) {
        successCount++;
      }
    });
    if (successCount > 0) incrementUsedCount(successCount);

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
    let broadTried = false;
    let broadFound = false;
    let broadSearchKeys = [];
    if (!allOdds.length && !opts.skipBroad && (jcMatches && jcMatches.length)) {
      broadTried = true;
      /* 过滤出当前平台真实可用的 key；同时跳过 session 内已知 dead 的 */
      const keySet = {};
      availableKeys.forEach(function(k) { keySet[k] = true; });
      broadSearchKeys = BROAD_CANDIDATES.filter(function(k) {
        return keySet[k] && !deadSportKeys[k];
      });

      if (broadSearchKeys.length) {
        const broadTasks = broadSearchKeys.map(function(sk) {
          return function() {
            return fetchOneSport(sk, apiKey).then(function(r) {
              perKey['broad:' + sk] = r;
              return r;
            });
          };
        });

        const broadResults = await runWithConcurrency(broadTasks, 3);
        let broadSuccess = 0;
        broadResults.forEach(function(r) {
          if (r.status === 'fulfilled') {
            const v = r.value;
            if (v.ok && v.data && v.data.length) {
              allOdds = allOdds.concat(v.data);
              broadFound = true;
              if (!v.skipQuota) broadSuccess++;
            }
          }
        });
        if (broadSuccess > 0) incrementUsedCount(broadSuccess);
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
          deadKeys: Object.keys(deadSportKeys).map(function(k) {
            return k + ' (HTTP ' + (deadSportKeys[k].status || '?') + ')';
          }),
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
      getOdds, normalizeOdds, detectSportKeys, matchByTime, matchByTimeSync, LEAGUE_MAP,
      getUsedCount, getRemainingQuota, isQuotaExceeded, FREE_QUOTA,
      buildUrl, buildSportsUrl, BROAD_CANDIDATES, KNOWN_STABLE_KEYS,
      getTeamAliases, resolveTeamAlias
    };
  }

  /* 浏览器全局挂载 */
  if (typeof window !== 'undefined') {
    window.OddsApi = {
      getOdds, normalizeOdds, detectSportKeys, matchByTime, matchByTimeSync, LEAGUE_MAP,
      getUsedCount, getRemainingQuota, isQuotaExceeded, FREE_QUOTA,
      buildUrl, buildSportsUrl, BROAD_CANDIDATES, KNOWN_STABLE_KEYS,
      getTeamAliases, resolveTeamAlias
    };
  }

})();
