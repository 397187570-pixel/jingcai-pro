/**
 * multiDim.js — 多维预测分解引擎（纯函数，可单元测试）
 * 竞彩智选 Pro · 核心算法扩展
 *
 * 设计原则（与「可信 1X2」保持一致）:
 *   多维预测不是凭空另算一套，而是从【已经过真实校准、用户信任的 1X2 概率】
 *   反演期望进球(xG)，再用同一个泊松模型把其它维度(比分 / 进球数 / 让胜平负)
 *   一致地分解出来。这样所有维度共享同一套概率基底，互相对齐、不自相矛盾。
 *
 *   维度覆盖：胜平负 / 让胜平负 / 进球数 / 比分
 *   输出：概率最高的 Top 5 结果选项，供用户挑选。
 */

/* ============================================
   基础工具
   ============================================ */
function mdFactorial(n) {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/**
 * 泊松概率 P(X=k)
 */
function mdPoisson(lambda, k) {
  if (lambda <= 0 || k < 0) return 0;
  return Math.pow(lambda, k) * Math.exp(-lambda) / mdFactorial(k);
}

function mdRound3(x) {
  return Math.round(x * 1000) / 1000;
}

function mdRound4(x) {
  return Math.round(x * 10000) / 10000;
}

/* ============================================
   泊松胜平负（给定 xG）
   ============================================ */
/**
 * 由主客队 xG 计算胜平负概率
 * @returns {{homeWin:number, draw:number, awayWin:number}} 0-1
 */
function poissonWDL(homeXg, awayXg, maxGoals) {
  const mg = maxGoals || 8;
  let hw = 0, dr = 0, aw = 0;
  for (let h = 0; h <= mg; h++) {
    const ph = mdPoisson(homeXg, h);
    if (ph === 0) continue;
    for (let a = 0; a <= mg; a++) {
      const p = ph * mdPoisson(awayXg, a);
      if (h > a) hw += p;
      else if (h === a) dr += p;
      else aw += p;
    }
  }
  return { homeWin: hw, draw: dr, awayWin: aw };
}

/* ============================================
   xG 反演（由目标 1X2 概率求 xG）
   ============================================ */
/**
 * 给定可信的 1X2 概率，反演主客队期望进球(xG)。
 * 方法：网格粗搜 + 局部精搜，最小化泊松 W/D/L 与目标 W/D/L 的均方误差。
 * @param {number} homeWinP 主胜概率 0-1
 * @param {number} drawP 平局概率 0-1
 * @param {number} awayWinP 客胜概率 0-1
 * @param {{maxGoals?:number, lo?:number, hi?:number}} [opts]
 * @returns {{homeXg:number, awayXg:number, err:number}}
 */
function solveXg(homeWinP, drawP, awayWinP, opts) {
  const o = opts || {};
  const mg = o.maxGoals || 8;
  const lo = (typeof o.lo === 'number') ? o.lo : 0.1;
  const hi = (typeof o.hi === 'number') ? o.hi : 4.0;

  // 归一化目标
  let tH = homeWinP, tD = drawP, tA = awayWinP;
  const ts = tH + tD + tA;
  if (ts > 0) {
    tH /= ts; tD /= ts; tA /= ts;
  }

  const evalErr = (lh, la) => {
    const wdl = poissonWDL(lh, la, mg);
    const dH = wdl.homeWin - tH;
    const dD = wdl.draw - tD;
    const dA = wdl.awayWin - tA;
    return dH * dH + dD * dD + dA * dA;
  };

  let best = { homeXg: 1.4, awayXg: 1.1, err: Infinity };
  const coarse = 0.1;
  for (let lh = lo; lh <= hi; lh += coarse) {
    for (let la = lo; la <= hi; la += coarse) {
      const err = evalErr(lh, la);
      if (err < best.err) best = { homeXg: lh, awayXg: la, err: err };
    }
  }

  // 局部精搜
  const cLo = Math.max(lo, best.homeXg - coarse);
  const cHi = Math.min(hi, best.homeXg + coarse);
  const aLo = Math.max(lo, best.awayXg - coarse);
  const aHi = Math.min(hi, best.awayXg + coarse);
  const refine = 0.02;
  for (let lh = cLo; lh <= cHi; lh += refine) {
    for (let la = aLo; la <= aHi; la += refine) {
      const err = evalErr(lh, la);
      if (err < best.err) best = { homeXg: lh, awayXg: la, err: err };
    }
  }

  return { homeXg: mdRound3(best.homeXg), awayXg: mdRound3(best.awayXg), err: best.err };
}

/* ============================================
   比分 / 进球数 / 让胜平负 派生
   ============================================ */
/**
 * 比分概率矩阵（按概率降序排列）
 * @returns {Array<{score:string, home:number, away:number, p:number}>}
 */
function scoreMatrix(homeXg, awayXg, maxGoals) {
  const mg = maxGoals || 8;
  const arr = [];
  for (let h = 0; h <= mg; h++) {
    const ph = mdPoisson(homeXg, h);
    for (let a = 0; a <= mg; a++) {
      const p = ph * mdPoisson(awayXg, a);
      if (p > 0.0005) arr.push({ score: h + ':' + a, home: h, away: a, p: mdRound4(p) });
    }
  }
  arr.sort((x, y) => y.p - x.p);
  return arr;
}

/**
 * 总进球数分布（0,1,2,... 直至 mg+'+' 桶）
 * @returns {Array<{goals:number|string, label:string, p:number}>}
 */
function totalGoals(homeXg, awayXg, maxGoals) {
  const mg = maxGoals || 8;
  const buckets = {};
  for (let h = 0; h <= mg; h++) {
    const ph = mdPoisson(homeXg, h);
    for (let a = 0; a <= mg; a++) {
      const t = h + a;
      const p = ph * mdPoisson(awayXg, a);
      const key = t >= mg ? (mg + '+') : t;
      buckets[key] = (buckets[key] || 0) + p;
    }
  }
  const keys = Object.keys(buckets).map((k) => (k === (mg + '+') ? Infinity : Number(k)))
    .sort((a, b) => a - b);
  const arr = [];
  keys.forEach((k) => {
    const isPlus = (k === Infinity);
    const rawKey = isPlus ? (mg + '+') : k;
    arr.push({
      goals: isPlus ? (mg + '+') : k,
      label: isPlus ? (mg + '+ 球') : (k + ' 球'),
      p: mdRound4(buckets[rawKey])
    });
  });
  return arr;
}

/**
 * 让胜平负概率。line 采用竞彩显示盘口惯例：负值=主队让球（主队让 L 球），正值=主队受让。
 *   line = -1（主让1）：让胜 = 主队净胜 2 球以上
 *   line = +0.5（主受让0.5）：让胜 = 主队不败（胜或平）
 *   line = 0：平手
 * 公式：调整后主队净胜球 = h + line - a（line<0 即从主队进球扣 |line|）
 * @returns {{home:number, draw:number, away:number}} 让胜/让平/让负 0-1
 */
function asianHandicap(homeXg, awayXg, line, maxGoals) {
  const mg = maxGoals || 8;
  let w = 0, d = 0, l = 0;
  for (let h = 0; h <= mg; h++) {
    const ph = mdPoisson(homeXg, h);
    for (let a = 0; a <= mg; a++) {
      const p = ph * mdPoisson(awayXg, a);
      const net = h + line - a; // 竞彩盘口惯例：line<0 即主队让球
      if (net > 0) w += p;
      else if (net === 0) d += p;
      else l += p;
    }
  }
  return { home: mdRound4(w), draw: mdRound4(d), away: mdRound4(l) };
}

/* ============================================
   盘口格式化
   ============================================ */
function roundTo025(x) {
  return Math.round(x * 4) / 4;
}

function fmtLine(line) {
  return String(Math.round(line * 100) / 100);
}

function lineLabel(line) {
  if (line === 0) return '平手';
  if (line < 0) return '主-' + fmtLine(-line);
  return '主+' + fmtLine(line);
}

/* ============================================
   主入口：多维预测 + Top5
   ============================================ */
/**
 * 从可信 1X2 概率生成多维预测结论。
 * @param {{homeWin:number, draw:number, awayWin:number}} target 1X2 概率（0-1，建议用校准后概率）
 * @param {{line?:number, maxGoals?:number}} [opts] line=真实让球盘口；缺省时按 xG 差推导「模型建议盘口」
 * @returns {{
 *   xg:{homeXg:number,awayXg:number},
 *   line:number, lineSuggested:boolean, lineLabel:string,
 *   scoreMatrix:Array, totalGoals:Array, asian:{home:number,draw:number,away:number},
 *   cells:Array<{dim:string,key:string,label:string,p:number}>,
 *   top5:Array<{dim:string,key:string,label:string,p:number}>
 * }}
 */
function buildMultiDim(target, opts) {
  const o = opts || {};
  const mg = o.maxGoals || 8;
  const homeWin = target.homeWin || 0;
  const draw = target.draw || 0;
  const awayWin = target.awayWin || 0;

  const xg = solveXg(homeWin, draw, awayWin, { maxGoals: mg });

  // 让球盘口：优先真实盘口，缺省时用 xG 差推导「模型建议盘口」
  let line = (typeof o.line === 'number') ? o.line : null;
  let lineSuggested = false;
  if (line === null || Number.isNaN(line)) {
    // 竞彩惯例：主队强(主队 xG 高) → 主让 → 显示为负值
    line = roundTo025(xg.awayXg - xg.homeXg);
    lineSuggested = true;
  }

  const sm = scoreMatrix(xg.homeXg, xg.awayXg, mg);
  const tg = totalGoals(xg.homeXg, xg.awayXg, mg);
  const ah = asianHandicap(xg.homeXg, xg.awayXg, line, mg);

  // 汇总所有维度的候选结果（每个维度各自归一，概率口径一致可直接比较）
  const cells = [];
  cells.push({ dim: '胜平负', key: '1x2-home', label: '主胜', p: homeWin });
  cells.push({ dim: '胜平负', key: '1x2-draw', label: '平', p: draw });
  cells.push({ dim: '胜平负', key: '1x2-away', label: '客胜', p: awayWin });

  sm.slice(0, 6).forEach((s) => {
    cells.push({ dim: '比分', key: 'score-' + s.score, label: s.score.replace(':', '-'), p: s.p });
  });
  tg.slice(0, 5).forEach((t) => {
    cells.push({ dim: '进球数', key: 'goals-' + t.goals, label: t.label, p: t.p });
  });
  cells.push({ dim: '让胜平负', key: 'ah-home', label: '让胜', p: ah.home });
  cells.push({ dim: '让胜平负', key: 'ah-draw', label: '让平', p: ah.draw });
  cells.push({ dim: '让胜平负', key: 'ah-away', label: '让负', p: ah.away });

  // 概率最高的前五个结果选项
  const top5 = cells.slice().sort((a, b) => b.p - a.p).slice(0, 5);

  return {
    xg: { homeXg: xg.homeXg, awayXg: xg.awayXg },
    line: line,
    lineSuggested: lineSuggested,
    lineLabel: lineLabel(line),
    scoreMatrix: sm,
    totalGoals: tg,
    asian: ah,
    cells: cells,
    top5: top5
  };
}

/* ============================================
   导出
   ============================================ */
const MultiDimApi = {
  buildMultiDim: buildMultiDim,
  solveXg: solveXg,
  poissonWDL: poissonWDL,
  scoreMatrix: scoreMatrix,
  totalGoals: totalGoals,
  asianHandicap: asianHandicap,
  roundTo025: roundTo025,
  lineLabel: lineLabel
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MultiDimApi;
} else if (typeof window !== 'undefined') {
  window.MultiDim = MultiDimApi;
}
