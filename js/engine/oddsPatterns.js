/*
 * oddsPatterns.js — P5 权重规律挖掘（历史三件套回测）
 *
 * 输入: 高置信三件套 (竞彩隐含 + 欧盘均价隐含 + 赛果), 来自 ml/data/eu_odds_history.json
 * 输出: 按「历史 ROI」排序的规律榜 + 第一公民 advice（建议下哪边 / 历史命中% / ROI% / 样本）
 *
 * 重要现实约束:
 *  - 历史集每场只有【一个国际赔率快照】(football-data 收盘均价), 没有赔率时序。
 *    所以这里挖的是【静态偏差】规律(竞彩隐含 vs 欧洲共识偏差对赛果的预测力),
 *    而非 P3/P4 那种"随时间背离/收敛"(那需实时记录的时序)。
 *  - 用竞彩真实赔率反算历史 ROI: ROI = mean(赢则(jc-1), 输则 -1)。这是最诚实的"购买建议"地基。
 *  - 市场有效(Brier≈0) → 多数规律 ROI≈0/负。价值在于量化"竞彩偏离欧洲共识"是否含信息,
 *    并暴露少数局部窗口。所有规律标注样本量 n 与显著性 z, 防过拟合吹水。
 */
(function (global) {
  'use strict';

  var SIDES = ['h', 'd', 'a'];
  var ZH = { h: '主胜', d: '平', a: '客胜' };
  var IDX = { h: 0, d: 1, a: 2 };

  // 偏差分桶阈值(隐含概率单位)
  var GAP_BUCKETS = [
    { max: -0.05, label: '竞彩远低于欧盘 (≤ -5pt)' },
    { min: -0.05, max: -0.02, label: '竞彩偏低 -5 ~ -2pt' },
    { min: -0.02, max: -0.005, label: '竞彩略低 -2 ~ -0.5pt' },
    { min: -0.005, max: 0.005, label: '基本持平 ±0.5pt' },
    { min: 0.005, max: 0.02, label: '竞彩略高 +0.5 ~ 2pt' },
    { min: 0.02, max: 0.05, label: '竞彩偏高 +2 ~ 5pt' },
    { min: 0.05, label: '竞彩远高于欧盘 (≥ +5pt)' }
  ];

  function outcomeOf(score) {
    if (!score || score.indexOf(':') < 0) return null;
    var p = score.split(':');
    var x = parseFloat(p[0]), y = parseFloat(p[1]);
    if (isNaN(x) || isNaN(y)) return null;
    if (x > y) return 'h';
    if (x < y) return 'a';
    return 'd';
  }

  function inBucket(g, b) {
    if (b.min !== undefined && g < b.min) return false;
    if (b.max !== undefined && g > b.max) return false;
    return true;
  }

  // 单条件聚合: 在 data 中筛 predicate, 统计 target 边的命中率/ROI
  function aggregate(data, predicate, side) {
    var sub = data.filter(predicate);
    var n = sub.length;
    if (n === 0) return null;
    var wins = 0, roi = 0;
    for (var i = 0; i < sub.length; i++) {
      var d = sub[i];
      var win = d.o === side;
      if (win) wins++;
      roi += win ? (d.jc[IDX[side]] - 1) : -1;
    }
    return { n: n, wins: wins, wr: wins / n, roi: roi / n };
  }

  function zScore(wr, baseWr, n) {
    if (n <= 1) return 0;
    var v = baseWr * (1 - baseWr) / n;
    if (v <= 0) return 0;
    return (wr - baseWr) / Math.sqrt(v);
  }

  /**
   * 主分析
   * @param {Array} history 三件套记录(原始 JSON 数组)
   * @param {Object} opts { minN=50, roiThreshold=0.0 }
   */
  function analyze(history, opts) {
    opts = opts || {};
    var minN = opts.minN || 50;
    var roiThreshold = opts.roiThreshold || 0.0;

    var data = [];
    for (var i = 0; i < history.length; i++) {
      var r = history[i];
      if (r.low_conf) continue;                 // 仅高置信
      if (!r.jc_score || !r.eu_avg_implied || !r.jc_implied) continue;
      var o = outcomeOf(r.jc_score);
      if (!o) continue;
      var jc = [Number(r.jc_h), Number(r.jc_d), Number(r.jc_a)];
      if (jc.some(function (v) { return isNaN(v) || v <= 1; })) continue;
      var ps = r.eu_ps ? [Number(r.eu_ps[0]), Number(r.eu_ps[1]), Number(r.eu_ps[2])] : null;
      if (ps && ps.some(function (v) { return isNaN(v); })) ps = null;
      data.push({
        o: o, jc: jc,
        jcImp: r.jc_implied, euImp: r.eu_avg_implied, psImp: ps,
        gaps: {
          h: r.jc_implied[0] - r.eu_avg_implied[0],
          d: r.jc_implied[1] - r.eu_avg_implied[1],
          a: r.jc_implied[2] - r.eu_avg_implied[2]
        },
        league: r.leagueName
      });
    }

    var nTot = data.length;
    if (nTot < minN) {
      return { insufficient: true, n: nTot, patterns: [], summary: { n: nTot } };
    }

    // 基准命中率
    var base = { h: 0, d: 0, a: 0 };
    data.forEach(function (d) { base[d.o]++; });
    SIDES.forEach(function (s) { base[s] = base[s] / nTot; });

    var patterns = [];

    // ---- 特征1: 每边偏差分桶 ----
    SIDES.forEach(function (s) {
      GAP_BUCKETS.forEach(function (b) {
        var agg = aggregate(data, function (d) { return inBucket(d.gaps[s], b); }, s);
        if (!agg) return;
        var z = zScore(agg.wr, base[s], agg.n);
        patterns.push(makePattern({
          feature: 'gap', side: s, label: b.label,
          n: agg.n, wr: agg.wr, roi: agg.roi, baseWr: base[s], z: z, minN: minN
        }));
      });
    });

    // ---- 特征2: 最大偏离边(竞彩最看好 / 最不看好) ----
    function maxSide(absOrSign) {
      return function (d) {
        var best = null, bestVal = -Infinity;
        SIDES.forEach(function (s) {
          var v = absOrSign === 'abs' ? Math.abs(d.gaps[s]) : d.gaps[s];
          if (v > bestVal) { bestVal = v; best = s; }
        });
        return best;
      };
    }
    [['maxPos', maxSide('sign'), '竞彩最看好(最大正偏差)边'],
     ['maxNeg', function (d) {
       var best = null, bestVal = Infinity;
       SIDES.forEach(function (s) { if (d.gaps[s] < bestVal) { bestVal = d.gaps[s]; best = s; } });
       return best;
     }, '竞彩最不看好(最大负偏差)边'],
     ['maxAbs', maxSide('abs'), '竞彩与欧盘分歧最大边']].forEach(function (cfg) {
      var kind = cfg[0], fn = cfg[1], desc = cfg[2];
      SIDES.forEach(function (s) {
        var agg = aggregate(data, function (d) { return fn(d) === s; }, s);
        if (!agg) return;
        var z = zScore(agg.wr, base[s], agg.n);
        patterns.push(makePattern({
          feature: 'dev_' + kind, side: s, label: desc,
          n: agg.n, wr: agg.wr, roi: agg.roi, baseWr: base[s], z: z, minN: minN
        }));
      });
    });

    // ---- 特征3: Pinnacle(sharp) 倾斜(有 ps 时才算) ----
    var hasPs = data.some(function (d) { return d.psImp; });
    if (hasPs) {
      SIDES.forEach(function (s) {
        var agg = aggregate(data, function (d) {
          return d.psImp && (d.psImp[s] - d.euImp[s]) > 0.005;
        }, s);
        if (!agg) return;
        var z = zScore(agg.wr, base[s], agg.n);
        patterns.push(makePattern({
          feature: 'sharp', side: s, label: 'Pinnacle 比均价更看好',
          n: agg.n, wr: agg.wr, roi: agg.roi, baseWr: base[s], z: z, minN: minN
        }));
      });
    }

    // ---- 排序 + 筛选 ----
    patterns = patterns.filter(function (p) { return p.n >= minN; });
    patterns.sort(function (a, b) { return b.roi - a.roi; });

    // 可行动 = 历史 ROI 显著为正(>2%) 且样本充足。z 仅作信息参考(赔率已定价时强信号也可 ROI 负)。
    var actionable = patterns.filter(function (p) {
      return p.roi > 0.02 && p.n >= minN;
    });
    var marketEfficient = actionable.length === 0;

    // ---- advice 层 ----
    var advice = {
      headline: marketEfficient
        ? '市场有效：未发现系统性 +EV 规律（多数为噪声）。以下为相对最强的局部窗口，仅供参考。'
        : '发现 ' + actionable.length + ' 条历史 +EV 局部窗口，可作重点关注名单。',
      items: actionable.slice(0, 12).map(function (p) {
        return {
          condition: '[' + p.label + '] 下' + ZH[p.side],
          side: p.side,
          wr: Math.round(p.wr * 1000) / 10,
          n: p.n,
          roi: Math.round(p.roi * 1000) / 10,
          lift: Math.round((p.wr / p.baseWr) * 1000) / 10,
          z: Math.round(p.z * 100) / 100,
          text: '当' + p.label + '，历史下' + ZH[p.side] + '命中 ' +
            (Math.round(p.wr * 1000) / 10) + '%（n=' + p.n + '），ROI ' +
            (p.roi >= 0 ? '+' : '') + (Math.round(p.roi * 1000) / 10) + '%，相对基准 ×' +
            (Math.round((p.wr / p.baseWr) * 1000) / 1000) + '，z=' + (Math.round(p.z * 100) / 100)
        };
      })
    };

    return {
      n: nTot, base: base, hasPs: hasPs, marketEfficient: marketEfficient,
      patterns: patterns, advice: advice,
      summary: {
        n: nTot, base: base, actionableCount: actionable.length,
        bestRoi: patterns.length ? patterns[0].roi : 0,
        bestPattern: patterns.length ? patterns[0] : null
      }
    };
  }

  function makePattern(o) {
    var significant = Math.abs(o.z) >= 1.96;
    var action = (o.roi > 0.02) ? 'bet' : 'watch';
    return {
      feature: o.feature, side: o.side, sideZh: ZH[o.side], label: o.label,
      n: o.n, wr: o.wr, roi: o.roi, baseWr: o.baseWr,
      lift: o.wr / o.baseWr, z: o.z, significant: significant, action: action
    };
  }

  // ---- 渲染(浏览器) ----
  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  function renderPatterns(container, result) {
    if (!container) return;
    if (result.insufficient) {
      container.innerHTML = '<div class="empty-hint">样本不足（需 ≥50 场高置信三件套），暂无法挖掘规律。</div>';
      return;
    }
    var rows = result.patterns.slice(0, 20).map(function (p) {
      var cls = p.action === 'bet' ? 'bet' : 'watch';
      var sig = p.significant ? '<span class="badge-sig">显著</span>' : '';
      return '<tr class="' + cls + '">' +
        '<td>' + esc(p.label) + '</td>' +
        '<td>' + esc(p.sideZh) + '</td>' +
        '<td>' + (Math.round(p.wr * 1000) / 10) + '%</td>' +
        '<td>' + p.n + '</td>' +
        '<td class="' + (p.roi >= 0 ? 'pos' : 'neg') + '">' + (p.roi >= 0 ? '+' : '') + (Math.round(p.roi * 1000) / 10) + '%</td>' +
        '<td>×' + (Math.round(p.lift * 100) / 100) + '</td>' +
        '<td>' + (Math.round(p.z * 100) / 100) + ' ' + sig + '</td>' +
        '<td>' + (p.action === 'bet' ? '<span class="badge-bet">可关注</span>' : '—') + '</td>' +
        '</tr>';
    }).join('');

    var adviceItems = result.advice.items.map(function (it) {
      return '<li><b>' + esc(it.condition) + '</b> — ' + esc(it.text) + '</li>';
    }).join('');

    container.innerHTML =
      '<div class="patterns-head">基于 <b>' + result.n + '</b> 场高置信三件套回测 · 按历史 ROI 排序' +
      (result.hasPs ? ' · 含 Pinnacle sharp' : '') + '</div>' +
      '<table class="table patterns-table"><thead><tr>' +
      '<th>条件（竞彩 vs 欧盘偏差）</th><th>边</th><th>命中率</th><th>样本n</th>' +
      '<th>历史ROI</th><th>相对基准</th><th>z</th><th>建议</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="patterns-advice"><div class="advice-h">' + esc(result.advice.headline) + '</div>' +
      (adviceItems ? '<ul>' + adviceItems + '</ul>' : '<div class="empty-hint">无显著 +EV 窗口，建议观望。</div>') +
      '</div>';

    if (result.summary && result.summary.bestPattern) {
      var bp = result.summary.bestPattern;
      container.innerHTML += '<div class="patterns-foot">最强规律: ' + esc(bp.label) + ' → ' +
        esc(bp.sideZh) + '，ROI ' + (bp.roi >= 0 ? '+' : '') + (Math.round(bp.roi * 1000) / 10) +
        '%（n=' + bp.n + '）。注：历史回测不代表未来，市场有效前提下仅作局部参考。</div>';
    }
  }

  var api = { analyze: analyze, renderPatterns: renderPatterns, outcomeOf: outcomeOf };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.OddsPatterns = api;
  }
})(typeof window !== 'undefined' ? window : this);
