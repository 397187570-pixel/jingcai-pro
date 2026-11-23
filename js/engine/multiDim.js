/**
 * multiDim.js — 多维预测分解引擎（纯函数，可单元测试）
 * 不惑智选 Pro · 核心算法扩展
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
   半全场胜平负(HAFU)：上下半场独立泊松联合分布
   ============================================ */
/**
 * 半全场 9 种组合概率。假设上/下半场各自独立、xG 各占一半：
 *   上半场比分 (h1,a1) ~ Poisson(lh/2), Poisson(la/2)
 *   下半场比分 (h2,a2) ~ Poisson(lh/2), Poisson(la/2)
 *   半场结果 = WDL(h1,a1)；全场结果 = WDL(h1+h2, a1+a2)
 * 联合概率 = Σ P(h1)P(a1)P(h2)P(a2)，对所有满足该(半场,全场)组合的比分求和。
 * 竞彩 HAFU 键 = 半场结果字母 + 全场结果字母（h=主胜/d=平/a=客胜），
 *   如 'hh'=半主全主、'dh'=半平全主、'aa'=半客全客。
 * @returns {Object<string,number>} 9 个键的概率（和为 1）
 */
function halfFullWdl(homeXg, awayXg, opts) {
  const mg = (opts && opts.maxGoals) || 6; // 半场进球上限，6 足够（泊松尾部极小）
  const lh = homeXg / 2, la = awayXg / 2;
  const res = {};
  ['h', 'd', 'a'].forEach(x => ['h', 'd', 'a'].forEach(y => { res[x + y] = 0; }));
  const wd = (h, a) => h > a ? 'h' : (h === a ? 'd' : 'a');
  const ph = [], pa = [];
  for (let k = 0; k <= mg; k++) { ph[k] = mdPoisson(lh, k); pa[k] = mdPoisson(la, k); }
  for (let h1 = 0; h1 <= mg; h1++) {
    if (ph[h1] === 0) continue;
    for (let a1 = 0; a1 <= mg; a1++) {
      const p1 = ph[h1] * pa[a1];
      if (p1 === 0) continue;
      const half = wd(h1, a1);
      for (let h2 = 0; h2 <= mg; h2++) {
        if (ph[h2] === 0) continue;
        for (let a2 = 0; a2 <= mg; a2++) {
          const p = p1 * ph[h2] * pa[a2];
          if (p === 0) continue;
          const full = wd(h1 + h2, a1 + a2);
          res[half + full] += p;
        }
      }
    }
  }
  return res;
}

/* ============================================
   缺胜平负(HAD)时：从让球胜平负(HHAD)反推方向概率
   ============================================ */
/**
 * 部分竞彩场次只开让球胜平负(HHAD)、不开胜平负(HAD)（如主队让2球的悬殊场次）。
 * 此时没有 HAD 赔率，方向模型无法启动。本函数用让球盘赔率反推等效 HAD 概率：
 *   1) 让球三项赔率去水 → 让胜/让平/让负目标概率；
 *   2) 网格搜索 (homeXg, awayXg) 使 asianHandicap(xg, line) 拟合该目标；
 *   3) 用同一组 xG 经泊松算 WDL → 反推的胜平负方向概率。
 * 注意：单让球盘反解 xG 数学上非唯一，但泊松模型下解通常稳定；结果仅用于
 *      让缺 HAD 场次的研判页/多维分析可用，并应标注"由让球盘反推，仅供参考"。
 * @param {{h:number,d:number,a:number}} hhadOdds 让球胜平负赔率（去水前原始赔率）
 * @param {number} line 竞彩让球盘口（如 -2 表示主让2球）
 * @param {{maxGoals?:number}} [opts]
 * @returns {{homeWin:number,draw:number,awayWin:number,homeXg:number,awayXg:number,fitErr:number}|null}
 */
function inferWdlFromHandicap(hhadOdds, line, opts) {
  if (!hhadOdds || !Number.isFinite(line)) return null;
  const h = Number(hhadOdds.h), d = Number(hhadOdds.d), a = Number(hhadOdds.a);
  if (!(h > 1 && d > 1 && a > 1)) return null;
  const mg = (opts && opts.maxGoals) || 8;
  // 让球三项去水
  const s = 1 / h + 1 / d + 1 / a;
  const tH = 1 / h / s, tD = 1 / d / s, tA = 1 / a / s;
  // 网格搜索 xG 拟合让球三项（粗搜 + 局部精搜）
  const evalErr = (lh, la) => {
    const ah = asianHandicap(lh, la, line, mg);
    const dH = ah.home - tH, dD = ah.draw - tD, dA = ah.away - tA;
    return dH * dH + dD * dD + dA * dA;
  };
  let best = { lh: 1.4, la: 1.1, err: Infinity };
  for (let lh = 0.1; lh <= 5; lh += 0.1) {
    for (let la = 0.1; la <= 5; la += 0.1) {
      const err = evalErr(lh, la);
      if (err < best.err) best = { lh, la, err };
    }
  }
  const cLh0 = Math.max(0.1, best.lh - 0.1), cLh1 = Math.min(5, best.lh + 0.1);
  const cLa0 = Math.max(0.1, best.la - 0.1), cLa1 = Math.min(5, best.la + 0.1);
  for (let lh = cLh0; lh <= cLh1; lh += 0.02) {
    for (let la = cLa0; la <= cLa1; la += 0.02) {
      const err = evalErr(lh, la);
      if (err < best.err) best = { lh, la, err };
    }
  }
  const wdl = poissonWDL(best.lh, best.la, mg);
  const sum = wdl.homeWin + wdl.draw + wdl.awayWin;
  if (!(sum > 0)) return null;
  return {
    homeWin: wdl.homeWin / sum, draw: wdl.draw / sum, awayWin: wdl.awayWin / sum,
    homeXg: mdRound3(best.lh), awayXg: mdRound3(best.la), fitErr: mdRound4(best.err)
  };
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

  // 竞彩可买盘口换算：模型建议盘口可能是 0.75 这类竞彩没有的四分盘。
  // 竞彩 HHAD 只开整数盘，把建议盘口按"主队让/受让方向"吸附到最近整数盘，
  // 并给出"建议盘一侧概率 = 可买整数盘哪几项之和"的对照，避免展示买不到的概率。
  let jcConvert = null;
  if (typeof o.line === 'number' && !Number.isNaN(o.line)) {
    // 已有竞彩真实盘口：可直接买，无需换算
    jcConvert = { needed: false, buyLine: line, buyAsian: ah, mapping: null };
  } else {
    // 模型建议盘口：吸附到最近整数盘（0 视为平手，也不可买让球盘则保留说明）
    const dir = line < 0 ? -1 : 1;                       // 主让 / 主受让
    const mag = Math.abs(line);
    let buyMag = Math.round(mag);                         // 最近整数
    if (buyMag === 0) buyMag = 1;                         // 平手盘无让球玩法，给最接近的 ±1
    const buyLine = dir * buyMag;
    const buyAsian = asianHandicap(xg.homeXg, xg.awayXg, buyLine, mg);
    // 例：建议主受让0.75(dir=+1, mag=0.75→buy1)。建议让负=客净胜≥1球
    //     = 可买+1盘的(让平=客恰净胜1 + 让负=客净胜≥2)。让胜同盘一致。
    // 例：建议主让0.75(dir=-1)→buy-1。建议让胜=主净胜≥1球 = -1盘(让胜+让平)。
    let mapping;
    if (mag - Math.floor(mag) > 0 && Math.floor(mag) < buyMag) {
      // 四分/半球盘，吸附到"更大让球"的整数盘，一侧概率被拆成两项
      mapping = dir > 0
        ? { side: 'away', parts: ['ah-draw', 'ah-away'] } // 主受让：建议让负 = 可买盘 让平+让负
        : { side: 'home', parts: ['ah-home', 'ah-draw'] }; // 主让：建议让胜 = 可买盘 让胜+让平
    } else {
      mapping = null;
    }
    jcConvert = { needed: true, suggestLine: line, buyLine: buyLine, buyAsian: buyAsian, mapping: mapping };
  }

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
    jcConvert: jcConvert,
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
  halfFullWdl: halfFullWdl,
  inferWdlFromHandicap: inferWdlFromHandicap,
  roundTo025: roundTo025,
  lineLabel: lineLabel
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MultiDimApi;
} else if (typeof window !== 'undefined') {
  window.MultiDim = MultiDimApi;
}
