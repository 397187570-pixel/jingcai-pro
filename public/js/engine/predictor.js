/**
 * predictor.js — AI 预测引擎（纯函数，可单元测试）
 * 竞彩智选 Pro · 核心算法
 */

/* ============================================
   Elo 评分预测
   ============================================ */
/**
 * 基于 Elo 评分差预测胜平负概率
 * @param {number} homeElo 主队 Elo
 * @param {number} awayElo 客队 Elo
 * @param {number} [homeAdvantage=100] 主场优势
 * @returns {{homeWin:number, draw:number, awayWin:number}} 概率（%）
 */
function eloPredict(homeElo, awayElo, homeAdvantage = 50) {
  const h = Number.isFinite(homeElo) ? homeElo : 1500;
  const a = Number.isFinite(awayElo) ? awayElo : 1500;
  const dr = h + homeAdvantage - a;
  const p = 1 / (1 + Math.pow(10, -dr / 400));
  const draw = Math.max(0, (1 - Math.abs(p - 0.5) * 2) * 0.25);
  return {
    homeWin: Math.round(p * 1000) / 10,
    draw: Math.round(draw * 1000) / 10,
    awayWin: Math.round((1 - p - draw) * 1000) / 10
  };
}

/* ============================================
   泊松分布
   ============================================ */
function factorial(n) {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/**
 * 泊松分布概率 P(X=k)
 */
function poisson(lambda, k) {
  if (lambda <= 0 || k < 0) return 0;
  return Math.pow(lambda, k) * Math.exp(-lambda) / factorial(k);
}

/**
 * 基于泊松分布计算比分概率矩阵
 * @param {number} homeXg 主队期望进球
 * @param {number} awayXg 客队期望进球
 * @param {number} [maxGoals=8] 最大进球数
 * @returns {Object} 比分概率 { '1:0': 0.12, ... }
 */
function poissonScoreMatrix(homeXg, awayXg, maxGoals = 8) {
  const matrix = {};
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poisson(homeXg, h) * poisson(awayXg, a);
      if (p > 0.001) matrix[`${h}:${a}`] = Math.round(p * 1000) / 1000;
    }
  }
  return matrix;
}

/**
 * 从比分矩阵计算胜平负概率
 * @returns {{homeWin:number, draw:number, awayWin:number}} 概率（0-1）
 */
function scoreMatrixToWDL(matrix) {
  let hw = 0, dr = 0, aw = 0;
  Object.entries(matrix).forEach(([score, p]) => {
    const [h, a] = score.split(':').map(Number);
    if (h > a) hw += p;
    else if (h === a) dr += p;
    else aw += p;
  });
  return { homeWin: hw, draw: dr, awayWin: aw };
}

/* ============================================
   融合预测（Elo + 赔率市场）
   ============================================ */
/**
 * 综合预测：结合 Elo 评分与市场赔率
 * @param {number} homeElo 主队 Elo
 * @param {number} awayElo 客队 Elo
 * @param {Object} odds 市场赔率 {h,d,a}
 * @param {number} [marketWeight=0.5] 市场权重（0-1）
 */
function fusedPredict(homeElo, awayElo, odds, marketWeight = 0.5) {
  const elo = eloPredict(homeElo, awayElo);
  const eloProbs = { homeWin: elo.homeWin / 100, draw: elo.draw / 100, awayWin: elo.awayWin / 100 };

  // 市场去水概率
  const H = odds.h, D = odds.d, A = odds.a;
  const sum = 1 / H + 1 / D + 1 / A;
  const marketProbs = { homeWin: (1 / H) / sum, draw: (1 / D) / sum, awayWin: (1 / A) / sum };

  const w = Math.max(0, Math.min(1, marketWeight));
  return {
    homeWin: eloProbs.homeWin * (1 - w) + marketProbs.homeWin * w,
    draw: eloProbs.draw * (1 - w) + marketProbs.draw * w,
    awayWin: eloProbs.awayWin * (1 - w) + marketProbs.awayWin * w
  };
}

/**
 * 置信度：最高概率值
 */
function confidence(probs) {
  return Math.max(probs.homeWin, probs.draw, probs.awayWin);
}

/* ============================================
   价值注检测
   ============================================ */
/**
 * 对比竞彩与国际赔率，检测价值注
 * @param {Object} jcOdds 竞彩赔率 {h,d,a}
 * @param {Object} intOdds 国际赔率 {h,d,a}
 * @param {number} [threshold=0.04] 价值阈值
 * @returns {Array} 价值注列表
 */
function findValueBets(jcOdds, intOdds, threshold = 0.04) {
  const jc = deVig(jcOdds);
  const int = deVig(intOdds);
  const picks = ['h', 'd', 'a'];
  const labels = { h: '主胜', d: '平局', a: '客胜' };
  const results = [];

  picks.forEach(k => {
    const value = jc[k] - int[k];
    if (value > threshold) {
      results.push({
        pick: labels[k],
        valuePct: Math.round(value * 1000) / 10,
        jcProb: Math.round(jc[k] * 1000) / 10,
        intProb: Math.round(int[k] * 1000) / 10,
        jcOdds: jcOdds[k],
        intOdds: intOdds[k]
      });
    }
  });

  return results.sort((a, b) => b.valuePct - a.valuePct);
}

function deVig(odds) {
  const sum = 1 / odds.h + 1 / odds.d + 1 / odds.a;
  return { h: (1 / odds.h) / sum, d: (1 / odds.d) / sum, a: (1 / odds.a) / sum };
}

/* ============================================
   导出
   ============================================ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { eloPredict, poisson, factorial, poissonScoreMatrix, scoreMatrixToWDL, fusedPredict, confidence, findValueBets, deVig };
}
/* 浏览器全局挂载 */
if (typeof window !== 'undefined') {
  window.eloPredict = eloPredict;
  window.poisson = poisson;
  window.factorial = factorial;
  window.poissonScoreMatrix = poissonScoreMatrix;
  window.scoreMatrixToWDL = scoreMatrixToWDL;
  window.fusedPredict = fusedPredict;
  window.confidence = confidence;
  window.findValueBets = findValueBets;
  window.deVig = deVig;
}
