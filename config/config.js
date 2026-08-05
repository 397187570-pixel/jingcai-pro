/**
 * config.js — 全局配置（配置与代码分离）
 * 竞彩智选 Pro · 所有魔法数字/阈值集中于此
 */

/* 用 var 而非 const：多个 <script> 之间顶层 var 可重复声明且不会触发
   "Identifier 'CONFIG' has already been declared" 的 SyntaxError */
var CONFIG = {
  /* 版本 */
  version: '2.0.0',

  /* 数据源 */
  dataSources: {
    sporttery: {
      base: 'webapi.sporttery.cn',
      paths: {
        // 官网同款接口（uniform 版）：竞彩在售场次（含胜平负/让球/比分/总进球/半全场）
        calculator: '/gateway/uniform/football/getMatchCalculatorV1.qry',
        uniformResult: '/gateway/uniform/football/getUniformMatchResultV1.qry'
      },
      channel: 'c_web',
      timeout: 10000
    },
    oddsApi: {
      base: 'api.the-odds-api.com',
      regions: 'eu',
      markets: 'h2h',
      timeout: 8000
    }
  },

  /* 预测阈值 */
  thresholds: {
    highConfidence: 0.65,   // 高置信推荐阈值
    valueBet: 0.04,         // 价值注检测阈值（4pp）
    alertMove: 0.05,        // 赔率异动预警（5%）
    overTotalXg: 2.7,       // 大球判定阈值
    minOdds: 1.01           // 有效赔率下限
  },

  /* 竞彩玩法 */
  playTypes: {
    HAD: '胜平负',
    HHAD: '让球胜平负',
    CRS: '比分',
    TTG: '总进球',
    HAFU: '半全场'
  },

  /* 投注管理 */
  betting: {
    maxStakePct: 0.05,     // 单注不超过资金 5%
    stopLossStreak: 3,     // 连续亏损 3 场停手
    monthlyRoiLimit: -0.10 // 月度 ROI < -10% 暂停
  },

  /* 缓存 */
  cache: {
    oddsTtl: 10 * 60 * 1000,   // 赔率缓存 10 分钟
    matchesTtl: 5 * 60 * 1000, // 比赛缓存 5 分钟
    maxEntries: 500
  },

  /* 刷新 */
  refresh: {
    defaultInterval: 30,   // 秒
    minInterval: 5,
    maxInterval: 300
  },

  /* UI */
  ui: {
    listLimit: 20,        // 列表默认条数
    detailLimit: 6,       // 详情默认条数
    maxParlayLegs: 8      // 串关最大关数
  },

  /* 回测 */
  backtest: {
    defaultMonths: 3,
    stakePerBet: 100,
    strategies: ['all', 'conf60', 'conf65', 'conf70']
  }
};

/* 浏览器挂载全局 */
if (typeof window !== 'undefined') {
  window.CONFIG = CONFIG;
}

/* Node 环境导出 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CONFIG;
}
