/*
 * oddsModel.js — P8 ML 建模升级（逻辑回归多源融合模型 · 前端可移植推理）
 *
 * 设计目标（替换 P5 的手写规则统计）：
 *  - 用「竞彩隐含 + 欧盘均价隐含 + 偏差(竞彩−欧盘)」9 个特征，多分类逻辑回归给出 h/d/a 概率。
 *  - 模型系数由 ml/p8_train.py 在 2167 场高置信三件套上训练并导出（p8_model_lr.json，scheme B）。
 *  - 关键：不仅给概率，还计算每边 EV = 模型概率 − 赔率盈亏平衡(1/赔率)，
 *    诚实回答「哪边有+EV价值 / 没有则仅方向参考」，满足"分析必须给可下单建议"硬约束。
 *
 * 透明结论（见 ODDS_ANALYSIS_P8.md）：市场有效，系统性+EV不存在；
 *   本模型价值下注回测 ROI≈+4.0%（2026-09-15 重训，n=2167），但正EV样本命中率仅~25%
 *   （靠少数长赔率正确翻盘），属噪声/局部窗口而非稳定edge；远优于无脑下热门的−13%，
 *   但不足以构成制胜系统。故面板如实标注「非价值/方向」，模型定位为"纪律性 EV 计算器"，而非必胜系统。
 *
 * 移植性：系数内联（EMBEDDED_MODEL），无需网络也能推断；fetch 成功则以文件覆盖。
 */
(function (global) {
  'use strict';

  var ZH = { h: '主胜', d: '平', a: '客胜' };
  var IDX = { h: 0, d: 1, a: 2 };
  // 合理性护栏：模型概率最多为赔率隐含(盈亏平衡)的 1.6 倍，超出视为模型在极端盘上过度自信的假价值
  var MAX_EDGE_RATIO = 1.6;

  // 内联模型（与 ml/p8_model_lr.json 一致，scheme B，9 特征；2026-09-15 重训于 2167 场）
  var EMBEDDED_MODEL = {
    model: 'logistic_regression_multinomial',
    scheme: 'B',
    classes: ['h', 'd', 'a'],
    features: ['jc_h', 'jc_d', 'jc_a', 'eu_h', 'eu_d', 'eu_a', 'gap_h', 'gap_d', 'gap_a'],
    coef: [
      [0.9397562826246092, -0.22001530026273047, -0.719637637030656, 0.8429822533738485, -0.12001353501296247, -0.7228653730296736, 0.09677402925075397, -0.10000176524976793, 0.0032277359990150164],
      [-0.44968889606269313, 0.5364857700645185, -0.08521698319081417, -0.09094827892474042, 0.42070748778671874, -0.32817931805096756, -0.3587406171379541, 0.11577828227780015, 0.24296233486015392],
      [-0.4900673865619089, -0.31647046980178795, 0.804854620221472, -0.7520339744491061, -0.30069395277375627, 1.051044691080644, 0.2619665878872, -0.015776517028032067, -0.2461900708591686]
    ],
    intercept: [0.0058127427928166145, -0.015697478620312382, 0.009884735827506888],
    base_dist: [0.415782, 0.269036, 0.315182],
    trained_on_n: 2167
  };

  var model = EMBEDDED_MODEL;
  var loadPromise = null;

  function implied(odds) {
    var inv = odds.map(function (o) { return 1 / o; });
    var s = inv.reduce(function (a, b) { return a + b; }, 0);
    if (s <= 0) return null;
    return inv.map(function (x) { return x / s; });
  }

  function softmax(logits) {
    var m = Math.max(logits[0], logits[1], logits[2]);
    var e0 = Math.exp(logits[0] - m), e1 = Math.exp(logits[1] - m), e2 = Math.exp(logits[2] - m);
    var s = e0 + e1 + e2;
    return [e0 / s, e1 / s, e2 / s];
  }

  function loadModel() {
    if (loadPromise) return loadPromise;
    loadPromise = (function () {
      var cands = ['ml/p8_model_lr.json', './ml/p8_model_lr.json', 'jingcai-pro/ml/p8_model_lr.json', '/jingcai-pro/ml/p8_model_lr.json'];
      function tryFetch(i) {
        if (i >= cands.length) return Promise.resolve(EMBEDDED_MODEL); // 兜底用内联
        return fetch(cands[i]).then(function (r) {
          if (!r.ok) throw 0;
          return r.json();
        }).then(function (j) { model = j; return j; }).catch(function () { return tryFetch(i + 1); });
      }
      return tryFetch(0);
    })();
    return loadPromise;
  }

  /**
   * 核心推断：给定竞彩赔率 + 国际均价，输出模型概率 + 每边 EV + 偏差
   * @returns {p, breakeven, ev, jcImp, euImp, gap} 或 null
   */
  function predict(jcOdds, euAvgOdds) {
    if (typeof jcOdds === 'string') jcOdds = jcOdds.split(',').map(Number);
    if (typeof euAvgOdds === 'string') euAvgOdds = euAvgOdds.split(',').map(Number);
    var jcImp = implied(jcOdds), euImp = implied(euAvgOdds);
    if (!jcImp || !euImp) return null;
    var gap = [jcImp[0] - euImp[0], jcImp[1] - euImp[1], jcImp[2] - euImp[2]];
    var feat = [jcImp[0], jcImp[1], jcImp[2], euImp[0], euImp[1], euImp[2], gap[0], gap[1], gap[2]];
    var logits = [model.intercept[0], model.intercept[1], model.intercept[2]];
    for (var c = 0; c < 3; c++) {
      for (var i = 0; i < feat.length; i++) logits[c] += model.coef[c][i] * feat[i];
    }
    var p = softmax(logits);
    var breakeven = jcOdds.map(function (o) { return 1 / o; });   // 含竞彩抽水
    var ev = [p[0] - breakeven[0], p[1] - breakeven[1], p[2] - breakeven[2]];
    return { p: p, breakeven: breakeven, ev: ev, jcImp: jcImp, euImp: euImp, gap: gap };
  }

  /**
   * 第一公民 advice 层（满足"必须给买哪边建议"硬约束，同时诚实标注 EV）
   */
  function advice(result) {
    if (!result) return { insufficient: true };
    var ev = result.ev, p = result.p;
    var bestEV = Math.max(ev[0], ev[1], ev[2]);
    var bestIdx = ev[0] >= ev[1] ? (ev[0] >= ev[2] ? 0 : 2) : (ev[1] >= ev[2] ? 1 : 2);
    var likelyIdx = p[0] >= p[1] ? (p[0] >= p[2] ? 0 : 2) : (p[1] >= p[2] ? 1 : 2);
    // 价值需满足：EV>0 且模型概率未过度偏离赔率隐含（护栏，剔除假价值）
    var saneBest = p[bestIdx] <= MAX_EDGE_RATIO * result.breakeven[bestIdx];
    var hasValue = bestEV > 0 && saneBest;
    var idx = hasValue ? bestIdx : likelyIdx;
    var side = ['h', 'd', 'a'][idx];                 // 字符串键，供下游与 ZH 对齐
    var confidence = hasValue ? Math.min(0.95, 0.5 + bestEV * 3) : p[idx];
    var action = hasValue ? 'bet' : (bestEV > -0.01 ? 'watch' : 'fade');
    var reasons = [];
    if (hasValue) {
      reasons.push('模型概率 ' + (p[idx] * 100).toFixed(1) + '% 高于赔率盈亏平衡 ' +
        (result.breakeven[idx] * 100).toFixed(1) + '%，理论 EV +' + (bestEV * 100).toFixed(1) + 'pp');
    } else {
      reasons.push('无 +EV 窗口：所有边 EV 均为负（最大 ' + (bestEV * 100).toFixed(1) +
        'pp），市场有效，系统性价值不存在（回测价值下注 ROI≈+4%，但正EV样本命中率仅~25%，属噪声/局部窗口）');
      reasons.push('模型方向倾向「' + ZH[side] + '」（概率 ' + (p[idx] * 100).toFixed(1) +
        '%），仅作方向参考，非价值下注');
    }
    // gap 仅在有国际均价(predict 路径)时存在；无国际赔率时缺失，跳过该理由（无偏差可比较）
    if (result.gap && Math.abs(result.gap[idx]) > 0.02) {
      reasons.push('竞彩相对国际' + (result.gap[idx] > 0 ? '高估' : '低估') +
        ' ' + (Math.abs(result.gap[idx]) * 100).toFixed(1) + 'pp');
    }
    return {
      action: action, side: side, sideZh: ZH[side], confidence: confidence,
      ev: bestEV, p: p, breakeven: result.breakeven,
      headline: hasValue ? ('价值窗口：倾向下' + ZH[side]) : ('无 +EV · 模型倾向' + ZH[side] + '（仅方向参考）'),
      reasons: reasons
    };
  }

  // 批量：对历史三件套在浏览器内实时推断（演示模型可用性 + 复现回测结论）
  function scoreHistory(history) {
    var rows = [];
    for (var i = 0; i < history.length; i++) {
      var r = history[i];
      if (r.low_conf) continue;
      if (!r.jc_score || !r.eu_avg) continue;
      var jc = [+r.jc_h, +r.jc_d, +r.jc_a];
      var eu = r.eu_avg.map(Number);
      if (jc.some(function (v) { return v <= 1; }) || eu.some(function (v) { return v <= 1; })) continue;
      var res = predict(jc, eu);
      if (!res) continue;
      rows.push({ meta: r, res: res, advice: advice(res) });
    }
    return rows;
  }

  // 把每行展开成"推荐边 / 单边最高概率 / 最高EV / 竞彩赔率"，供排名使用
  function enrich(rows) {
    return rows.map(function (x) {
      var p = x.res.p, ev = x.res.ev;
      var bi = p[0] >= p[1] ? (p[0] >= p[2] ? 0 : 2) : (p[1] >= p[2] ? 1 : 2);
      var ei = ev[0] >= ev[1] ? (ev[0] >= ev[2] ? 0 : 2) : (ev[1] >= ev[2] ? 1 : 2);
      return {
        meta: x.meta, p: p, ev: ev, res: x.res,
        bestIdx: bi, bestSide: ['h', 'd', 'a'][bi], bestProb: p[bi],
        bestEV: ev[ei], jc: [+x.meta.jc_h, +x.meta.jc_d, +x.meta.jc_a]
      };
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
  }

  /**
   * 全量逐场分析 + 排名（满足"把每场都分析出来，挑概率最高的场次的某项下注"）
   * sortKey: 'prob' 单边最高概率优先 | 'ev' EV（价值）优先
   * expand: 是否展开全部（否则默认前 150 场，避免一次性渲染 2159 行卡顿）
   */
  function showModelTable(container, hist, sortKey, expand) {
    container.__hist = hist;
    container.__sortKey = sortKey || 'prob';
    container.__expand = !!expand;
    var rows = enrich(scoreHistory(hist));
    var key = container.__sortKey;
    rows.sort(function (a, b) {
      return key === 'ev' ? (b.bestEV - a.bestEV) : (b.bestProb - a.bestProb);
    });
    var total = rows.length;
    var limit = container.__expand ? total : Math.min(150, total);
    var shown = rows.slice(0, limit);
    var head = '<div class="patterns-head">ML 模型全量逐场分析 · 共分析 <b>' + total +
      '</b> 场 · 按「' + (key === 'ev' ? 'EV（价值）' : '单边最高模型概率') + '」排序 · 可直接挑概率最高的场次下注</div>' +
      '<div class="pm-controls">' +
      '<span class="pm-label">排序</span>' +
      '<button class="pm-btn ' + (key === 'prob' ? 'on' : '') + '" onclick="OddsModel._resort(event,\'prob\')">概率优先</button>' +
      '<button class="pm-btn ' + (key === 'ev' ? 'on' : '') + '" onclick="OddsModel._resort(event,\'ev\')">EV优先</button>' +
      (limit < total
        ? '<button class="pm-btn ghost" onclick="OddsModel._resort(event,\'' + key + '\',true)">展开全部 ' + total + ' 场</button>'
        : (container.__expand ? '<button class="pm-btn ghost" onclick="OddsModel._resort(event,\'' + key + '\',false)">收起</button>' : '')) +
      '</div>';
    var trs = shown.map(function (x, i) {
      var idx = x.bestIdx, sideZh = ZH[x.bestSide];
      var odd = x.jc[idx], be = x.res.breakeven[idx], ev = x.ev[idx];
      var hasVal = ev > 0 && x.bestProb <= MAX_EDGE_RATIO * be;
      var cls = hasVal ? 'bet' : (ev > -0.01 ? 'watch' : 'fade');
      var tag = hasVal ? '<span class="badge-bet">价值</span>'
        : (cls === 'fade' ? '<span class="badge-sig">非价值</span>' : '<span class="badge-watch">方向</span>');
      var probStr = x.p.map(function (v, k) {
        return (k === idx ? '<b>' : '') + (v * 100).toFixed(1) + '%' + (k === idx ? '</b>' : '');
      }).join(' / ');
      return '<tr class="' + cls + '"><td class="rk">' + (i + 1) + '</td>' +
        '<td>' + esc((x.meta.zhHome || '') + ' vs ' + (x.meta.zhAway || '')) + '</td>' +
        '<td>' + probStr + '</td>' +
        '<td>' + sideZh + '</td>' +
        '<td>' + odd.toFixed(2) + '</td>' +
        '<td>' + (be * 100).toFixed(1) + '%</td>' +
        '<td class="' + (ev >= 0 ? 'pos' : 'neg') + '">' + (ev >= 0 ? '+' : '') + (ev * 100).toFixed(1) + '</td>' +
        '<td>' + tag + '</td></tr>';
    }).join('');
    container.innerHTML = head +
      '<table class="table patterns-table"><thead><tr><th>#</th><th>场次</th><th>模型概率 h/d/a（粗体=推荐边）</th>' +
      '<th>推荐边</th><th>竞彩赔率</th><th>盈亏平衡</th><th>EV(pp)</th><th>类型</th></tr></thead><tbody>' + trs + '</tbody></table>' +
      '<div class="patterns-foot">排名按单边最高模型概率 / 最高 EV 给出「推荐边」；EV = 模型概率 − 赔率盈亏平衡(1/赔率)。' +
      '回测价值下注 ROI≈+4%（正EV样本命中率仅~25%，属噪声/局部窗口，非稳定edge），故多数场次标「非价值」仅方向参考。市场有效前提下，模型定位为纪律性 EV 计算器，请结合自身策略使用。</div>';
  }

  // 排序/展开按钮回调（从按钮向上找到带 data-model-panel 的容器）
  function _resort(e, key, expand) {
    var c = e.target.closest('[data-model-panel]');
    if (!c || !c.__hist) return;
    showModelTable(c, c.__hist, key, expand !== undefined ? expand : c.__expand);
  }

  function renderModelPanel(container) {
    if (!container) return;
    container.setAttribute('data-model-panel', '1');
    container.innerHTML = '<div class="empty-hint">加载 ML 模型与回测数据…</div>';
    loadModel().then(function () {
      var cands = ['ml/data/eu_odds_history.json', './ml/data/eu_odds_history.json', 'jingcai-pro/ml/data/eu_odds_history.json'];
      (function tryFetch(i) {
        if (i >= cands.length) { container.innerHTML = '<div class="empty-hint">无法加载历史回测数据。</div>'; return; }
        fetch(cands[i]).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (hist) {
          showModelTable(container, hist, 'prob', false);
        }).catch(function () { tryFetch(i + 1); });
      })(0);
    }).catch(function () {
      container.innerHTML = '<div class="empty-hint">ML 模型加载失败。</div>';
    });
  }

  var api = {
    loadModel: loadModel, predict: predict, advice: advice,
    scoreHistory: scoreHistory, renderModelPanel: renderModelPanel, implied: implied,
    showModelTable: showModelTable, _resort: _resort, EMBEDDED_MODEL: EMBEDDED_MODEL
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.OddsModel = api;
  }
})(typeof window !== 'undefined' ? window : this);
