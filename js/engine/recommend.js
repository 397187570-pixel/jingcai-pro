/**
 * recommend.js — 今日比赛预测方向与置信度建议(基于真实校准)
 * 竞彩智选 Pro
 *
 * 设计原则(诚实优先):
 *  - 1X2 基准置信度 = 竞彩隐含概率经全局校准表修正(已验证 Brier=0.0005)。
 *  - 联赛级偏差仅作"假设", 需实时验证, 不单独作为下注依据。
 *  - 价值信号 = 竞彩隐含概率 - 欧盘隐含概率(今日实时); 正=竞彩该方向赔付更优。
 *  - 亚盘 = 真实让球分布(历史回测)。
 *  - 任何结论都附带风险提示: 竞彩固定抽水 12.9%, 长期为负 EV。
 */
(function (global) {
  'use strict';

  function implied(h, d, a) {
    var s = 1 / h + 1 / d + 1 / a;
    return [1 / h / s, 1 / d / s, 1 / a / s];
  }

  // 用校准表把"隐含概率"映射为"真实置信度"
  function calibrate(conf, p) {
    if (!conf || !conf.table) return p;
    var best = p;
    for (var i = 0; i < conf.table.length; i++) {
      var rg = conf.table[i].range;
      var lo, hi;
      if (Array.isArray(rg)) { lo = rg[0]; hi = rg[1]; }
      else {
        var parts = String(rg).split('-');
        lo = parseFloat(parts[0]); hi = parseFloat(parts[1]);
      }
      if (p >= lo && p < hi) {
        return conf.table[i].actual; // 用真实命中率作置信度
      }
      // 落入最高桶(>=上限)用最后一档
      if (p >= lo) best = conf.table[i].actual;
    }
    return best;
  }

  // 标准正态 CDF 近似(Abramowitz-Stegun)
  function normCdf(x) {
    var t = 1 / (1 + 0.2316419 * Math.abs(x));
    var d = 0.3989423 * Math.exp(-x * x / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }

  // 取某联赛某结果的"历史偏差分布"; 联赛样本不足(n<40)则回退全局 ALL
  // eu_jc_gap.json 侧别键为 jh/jd/ja, 这里做 home/draw/away -> jh/jd/ja 映射
  var SIDE_KEY = { home: 'jh', draw: 'jd', away: 'ja' };
  var MIN_GAP_N = 40;
  function gapStats(euGap, league, side) {
    var k = SIDE_KEY[side];
    if (!k) return null;
    var L = euGap && euGap[league] && euGap[league][k];
    var A = euGap && euGap['ALL'] && euGap['ALL'][k];
    if (L && L.n >= MIN_GAP_N) return L;  // 联赛样本充足 -> 用本联赛
    if (A) return A;                      // 否则用全局兜底
    return L || null;
  }

  /**
   * 价值信号(数据驱动版, 双路径)
   *
   *  路径1 (金标准, 需实时欧盘):
   *    live 偏差 = 竞彩隐含 - 欧盘隐含; 与历史分布比较 -> z值 + 历史分位 + 是否超 p90
   *
   *  路径2 (无欧盘 / key-free, 用欧盘历史先验作参考标尺):
   *    模型价值边际 = 校准后模型概率(conf) - 竞彩去水隐含概率(pj)
   *    = 我们的"公平概率估计" 与 "市场定价概率" 的偏离; 正 = 模型认为该方向被市场低估。
   *    以 eu_jc_gap.json 的"竞彩 vs 欧盘历史偏差分布"为参考标尺衡量该边际的极端程度;
   *    闸门: 模型价值 >= +5% 才标记; 若同时超过该联赛历史 p90 偏差 => 极强(💎💎)。
   *    说明: 此路径不依赖实时欧盘, 是"模型 vs 市场"的价值参考, 非实时欧盘价值窗口。
   */
  function valueSignal(jc, eu, league, euGap, conf) {
    var pj = implied(jc[0], jc[1], jc[2]);
    var labels = ['home', 'draw', 'away'];

    // 路径1: 有实时欧盘 -> 金标准(符号已修正为投注者视角)
    //   价值 V = 欧盘隐含 − 竞彩隐含 (>0 = 竞彩该方向赔率更长/更优)
    //   历史 eu_jc_gap 存的是 gap = jc−eu; V = −gap。
    //   "竞彩显著便宜于欧盘" = gap 落入历史负尾 (jc−eu) < p10, 即 V 突破正极端。
    if (eu) {
      var pe = implied(eu[0], eu[1], eu[2]);
      var sig = {}, z = {}, pct = {}, flagged = {};
      for (var i = 0; i < 3; i++) {
        var g = Math.round((pe[i] - pj[i]) * 10000) / 10000; // V = 欧盘 − 竞彩
        sig[labels[i]] = g;
        var st = gapStats(euGap, league, labels[i]);
        if (st && st.std > 0) {
          var thr = (typeof st.p10 === 'number') ? st.p10 : -st.p90;
          z[labels[i]] = Math.round(((g + st.mean) / st.std) * 100) / 100;     // V 的 z
          pct[labels[i]] = Math.round(normCdf((g + st.mean) / st.std) * 1000) / 10;
          flagged[labels[i]] = (pj[i] - pe[i]) < thr; // (jc−eu) < p10 => 竞彩显著便宜
        } else {
          z[labels[i]] = null; pct[labels[i]] = null;
          flagged[labels[i]] = g > 0.02;
        }
      }
      var best = labels[0];
      for (var j = 1; j < 3; j++) if (sig[labels[j]] > sig[best]) best = labels[j];
      return {
        signal: sig, zscore: z, percentile: pct, flagged: flagged, strong: null,
        bestValueSide: best, bestValue: sig[best],
        priorSource: (euGap ? 'history' : 'none'), euFree: false, mode: 'live-eu'
      };
    }

    // 路径2: 无实时欧盘 -> 模型价值边际(关键-free)
    if (!conf) return null;
    var edge = {}, z = {}, pct = {}, flagged = {}, strong = {};
    for (var k = 0; k < 3; k++) {
      var e = Math.round((conf[k] - pj[k]) * 10000) / 10000; // 模型概率 - 市场隐含
      edge[labels[k]] = e;
      var st2 = gapStats(euGap, league, labels[k]);
      if (st2 && st2.std > 0) {
        z[labels[k]] = Math.round(((e - st2.mean) / st2.std) * 100) / 100;
        pct[labels[k]] = Math.round(normCdf((e - st2.mean) / st2.std) * 1000) / 10;
        strong[labels[k]] = e > st2.p90; // 超过欧盘历史最大偏差 => 极强
      } else {
        z[labels[k]] = null; pct[labels[k]] = null; strong[labels[k]] = false;
      }
      flagged[labels[k]] = e >= 0.05; // 模型价值 >= +5% 闸门
    }
    var best2 = labels[0];
    for (var m2 = 1; m2 < 3; m2++) if (edge[labels[m2]] > edge[best2]) best2 = labels[m2];
    return {
      signal: edge, zscore: z, percentile: pct, flagged: flagged, strong: strong,
      bestValueSide: best2, bestValue: edge[best2],
      priorSource: 'model-market', euFree: true, mode: 'model-market'
    };
  }

  /**
   * @param {Object} m
   *   league, homeTeam, awayTeam,
   *   jc: [h,d,a] 竞彩, eu: [h,d,a]|null 欧盘, goalLine: number|null
   * @param {Object} calib      全局校准(calibration.json)
   * @param {Object} leagueCal  联赛校准(league_calibration.json)
   * @param {Object} asian      亚盘(asian_handicap.json)
   */
  function recommend(m, calib, leagueCal, asian, euGap, opts) {
    opts = opts || {};
    // blendWeight: 方向概率中"竞彩校准概率"的权重 (0..1); 1=纯竞彩, 0=纯欧盘, null=不混合(默认)
    var blendWeight = (typeof opts.blendWeight === 'number') ? opts.blendWeight : null;
    var jc = m.jc;
    var pi = implied(jc[0], jc[1], jc[2]);
    var labels = ['home', 'draw', 'away'];
    var zh = ['主胜', '平', '客胜'];

    // 校准后置信度(竞彩)
    var conf = pi.map(function (p) { return calibrate(calib, p); });

    // 方向概率: 默认竞彩校准; 提供欧盘混合权重时融合欧盘去水概率(公平概率)
    var pDir = conf;
    if (blendWeight != null && m.eu) {
      var pe = implied(m.eu[0], m.eu[1], m.eu[2]); // 欧盘去水隐含(公平概率)
      pDir = conf.map(function (c, i) { return blendWeight * c + (1 - blendWeight) * pe[i]; });
    }

    // 方向 = 方向概率最高者
    var dir = 0;
    for (var i = 1; i < 3; i++) if (pDir[i] > pDir[dir]) dir = i;

    // 联赛假设(仅供参考)
    var lgEdge = null;
    if (leagueCal && leagueCal.leagues && leagueCal.leagues[m.league]) {
      var L = leagueCal.leagues[m.league];
      lgEdge = { n: L.n, meanBias: L.mean_bias, flag: L.edge_flag,
                 note: L.n < 80 ? '样本偏小, 噪声大, 仅假设' : '样本充足, 可作参考' };
    }

    // 亚盘
    var asianInfo = null;
    if (asian && asian.handicaps && m.goalLine != null) {
      var key = (Math.round(m.goalLine * 10) / 10).toFixed(1);
      if (asian.handicaps[key]) asianInfo = { line: m.goalLine, dist: asian.handicaps[key] };
    }

    // 价值信号(无实时欧盘时走模型价值边际, 欧盘历史先验作标尺)
    var vs = valueSignal(jc, m.eu, m.league, euGap, conf);

    // 文字建议
    var rec = zh[dir] + ' (校准置信度 ' + (pDir[dir] * 100).toFixed(1) + '%)';
    var caution = '竞彩固定抽水约 12.9%, 长期为负 EV; 本建议为概率参考, 非稳赚。';
    if (vs && vs.flagged[vs.bestValueSide]) {
      var side = vs.bestValueSide;
      var sideZh = zh[labels.indexOf(side)];
      var pctTxt = vs.percentile && vs.percentile[side] != null ? ('历史分位 ' + vs.percentile[side] + '%') : '';
      var zTxt = vs.zscore && vs.zscore[side] != null ? ('z=' + vs.zscore[side]) : '';
      if (vs.euFree) {
        // 路径2: 模型价值(关键-free)
        var strongTag = (vs.strong && vs.strong[side]) ? '💎💎 超欧盘历史 p90' : '💎 模型价值';
        rec += ' | 价值信号: ' + sideZh + ' 模型概率高于竞彩定价 +' + (vs.bestValue * 100).toFixed(1) +
               '% (' + strongTag + ' ' + pctTxt + ' ' + zTxt + ', 欧盘历史先验作标尺)';
      } else {
        // 路径1: 实时欧盘金标准(符号已修正: bestValue = 欧盘−竞彩 >0)
        rec += ' | 价值信号: ' + sideZh + ' 竞彩优于欧盘 +' + (vs.bestValue * 100).toFixed(1) +
               '% (' + pctTxt + ' ' + zTxt + ', 竞彩显著便宜于欧盘)';
      }
    }

    return {
      league: m.league, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
      oddsImplied: pi.map(function (x) { return Math.round(x * 10000) / 10000; }),
      calibratedConfidence: conf.map(function (x) { return Math.round(x * 10000) / 10000; }),
      direction: labels[dir], directionZh: zh[dir],
      directionConfidence: Math.round(pDir[dir] * 10000) / 10000,
      leagueEdge: lgEdge, asian: asianInfo, valueSignal: vs,
      recommendation: rec, caution: caution,
    };
  }

  var api = { recommend: recommend, implied: implied, calibrate: calibrate, valueSignal: valueSignal, normCdf: normCdf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Recommend = api;
})(typeof window !== 'undefined' ? window : this);
