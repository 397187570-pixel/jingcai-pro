/**
 * fundamentals.js — 基本面数据模块（Phase 2B）
 * 竞彩智选 Pro · 为 ML 模型提供特征数据
 *
 * 数据源：
 * 1. 竞彩官方 API（球队名/赔率）
 * 2. football-data.org（历史战绩）— 需 API key
 * 3. 内置 Elo 数据库（可离线）
 *
 * 职责：提取特征向量（供 ML 模型使用）+ 球队基本面查询
 */

/* ============================================
   内置球队 Elo 数据库（种子数据，可扩充）
   ============================================ */
const TEAM_ELO_DB = {
  /* 英超 */
  '曼城': 2145, '阿森纳': 2087, '利物浦': 2098, '曼联': 1960,
  '切尔西': 1985, '热刺': 1970, '纽卡斯尔': 1988, '维拉': 1950,
  /* 西甲 */
  '皇家马德里': 2120, '巴塞罗那': 2105, '马竞': 2030, '毕尔巴鄂竞技': 1930,
  /* 意甲 */
  '国际米兰': 2050, '尤文图斯': 2020, 'AC米兰': 2005, '那不勒斯': 2040,
  /* 德甲 */
  '拜仁慕尼黑': 2110, '多特蒙德': 1995, '勒沃库森': 2010, '莱比锡红牛': 1980,
  /* 法甲 */
  '巴黎圣日耳曼': 2095, '摩纳哥': 1940, '马赛': 1925,
  /* 中超 */
  '上海海港': 1650, '山东泰山': 1620, '上海申花': 1610, '成都蓉城': 1600,
  '北京国安': 1595, '浙江队': 1560, '天津津门虎': 1545, '武汉三镇': 1540,
  /* 其他 */
  '塞伊奈': 1380, '赫尔辛基': 1450,
  '哈尔姆斯': 1350, '天狼星': 1400,
  '佐加顿斯': 1480, '韦斯特罗': 1320,
  '巴竞技': 1560, '维多利亚': 1500,
  '米拉索尔': 1520, '格雷米奥': 1610,
  '巴西国际': 1600, '科林蒂安': 1580
};

/* ============================================
   Elo 查询
   ============================================ */
function getTeamElo(teamName) {
  if (!teamName) return 1500;
  // 精确匹配
  if (TEAM_ELO_DB[teamName]) return TEAM_ELO_DB[teamName];
  // 模糊匹配（去掉空格/大小写）
  const key = Object.keys(TEAM_ELO_DB).find(k =>
    k.toLowerCase() === teamName.toLowerCase() ||
    k.includes(teamName) || teamName.includes(k)
  );
  return key ? TEAM_ELO_DB[key] : 1500;
}

/* ============================================
   特征提取（供 ML 模型使用）
   ============================================ */
/**
 * 从比赛数据提取特征向量
 * @param {Object} match 比赛数据
 * @param {Object} context 额外上下文（历史交锋、近期状态等）
 * @returns {Object} 特征对象
 */
function extractFeatures(match, context = {}) {
  const home = match.homeTeam || match.homeName || '';
  const away = match.awayTeam || match.awayName || '';
  const homeElo = getTeamElo(home);
  const awayElo = getTeamElo(away);
  const odds = match.odds || {};

  return {
    /* Elo 特征 */
    elo_diff: homeElo - awayElo,                    // Elo 差
    elo_home: homeElo,                               // 主队 Elo
    elo_away: awayElo,                               // 客队 Elo

    /* 赔率特征 */
    odds_home: odds.h || 0,
    odds_draw: odds.d || 0,
    odds_away: odds.a || 0,
    implied_home: odds.h ? 1 / odds.h : 0,           // 隐含主胜概率
    implied_away: odds.a ? 1 / odds.a : 0,

    /* 基本面（有则填，无则 0） */
    home_recent: context.homeRecent || 0,            // 近5场主队胜率 0-1
    away_recent: context.awayRecent || 0,
    home_form: context.homeForm || 0,                // 近5场主队得分 (0-15)
    away_form: context.awayForm || 0,
    h2h_home_win: context.h2hHomeWin || 0,           // 历史交锋主队胜场
    h2h_draw: context.h2hDraw || 0,
    h2h_away_win: context.h2hAwayWin || 0,
    h2h_total: context.h2hTotal || 0,
    home_home_win_rate: context.homeHomeWinRate || 0, // 主队主场胜率
    away_away_win_rate: context.awayAwayWinRate || 0, // 客队客场胜率
    home_goals_avg: context.homeGoalsAvg || 0,        // 主队场均进球
    away_goals_avg: context.awayGoalsAvg || 0,
    home_concede_avg: context.homeConcedeAvg || 0,    // 主队场均失球
    away_concede_avg: context.awayConcedeAvg || 0,
    home_possession: context.homePossession || 0,     // 主队控球率
    away_possession: context.awayPossession || 0,
    home_rank: context.homeRank || 0,                 // 联赛排名
    away_rank: context.awayRank || 0,

    /* 派生特征 */
    home_adv: homeElo - awayElo + 50,                 // 含主场优势
    strength_ratio: homeElo / (awayElo || 1),         // 实力比
    total_goals_implied: (context.homeGoalsAvg || 0) + (context.awayGoalsAvg || 0)
  };
}

/**
 * 特征向量转数组（供模型 predict）
 */
function featuresToArray(f) {
  return [
    f.elo_diff, f.elo_home, f.elo_away,
    f.odds_home, f.odds_draw, f.odds_away,
    f.implied_home, f.implied_away,
    f.home_recent, f.away_recent,
    f.home_form, f.away_form,
    f.h2h_home_win, f.h2h_draw, f.h2h_away_win, f.h2h_total,
    f.home_home_win_rate, f.away_away_win_rate,
    f.home_goals_avg, f.away_goals_avg,
    f.home_concede_avg, f.away_concede_avg,
    f.home_possession, f.away_possession,
    f.home_rank, f.away_rank,
    f.home_adv, f.strength_ratio, f.total_goals_implied
  ];
}

/* ============================================
   球队基本面查询（Demo 数据，可接真实数据源）
   ============================================ */
function getTeamProfile(teamName) {
  const elo = getTeamElo(teamName);
  const rank = 10 - Math.floor(elo / 200); // 粗略排名估算
  return {
    name: teamName,
    elo,
    rank: Math.max(1, Math.min(20, rank)),
    homeWinRate: 0.45 + (elo - 1500) / 2000,
    goalsAvg: 1.1 + (elo - 1400) / 1500,
    concedeAvg: Math.max(0.6, 1.4 - (elo - 1400) / 2000),
    possession: 45 + (elo - 1400) / 15,
    form: [3, 1, 3, 0, 1], // 最近5场得分 W/D/L
    strength: elo > 2000 ? 'S' : elo > 1800 ? 'A' : elo > 1600 ? 'B' : elo > 1400 ? 'C' : 'D'
  };
}

/* ============================================
   导出
   ============================================ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getTeamElo, extractFeatures, featuresToArray, getTeamProfile, TEAM_ELO_DB };
}
if (typeof window !== 'undefined') {
  window.Fundamentals = {
    getTeamElo, extractFeatures, featuresToArray, getTeamProfile, TEAM_ELO_DB
  };
}
