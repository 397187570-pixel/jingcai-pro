/*
 * oddsParlay.js — P8b 串关（Accumulator）推荐引擎
 *
 * 依赖：OddsModel（scoreHistory 同步打分，无需异步；用内联 LR 模型）。
 *
 * 设计原则（与 P8 一致，诚实优先）：
 *  - 市场有效、系统性 +EV 不存在；串关的"组合 EV"因多次抽水叠加几乎必然为负。
 *  - 因此两套策略的定位是明确的"风险/回报"取舍，而非"必胜系统"：
 *      · 稳妥型：每腿取模型概率最高的边（最被看好的热门），最大化组合命中率，赔率偏低。
 *      · 冷门型：每腿取 EV 为正的高赔率边（优先），否则取最高 EV 边，最大化潜在回报，命中率低。
 *  - 面板如实展示 组合模型概率 / 组合竞彩赔率 / 组合 EV，并标注风险。
 *
 * 组合 EV 公式（竞彩串关为赔率相乘）：
 *   组合概率 P = ∏ p_i（各腿模型概率）
 *   组合赔率 O = ∏ jc_odds_i
 *   EV = P*(O-1) - (1-P)
 */
(function (global) {
  'use strict';

  var ZH = { h: '主胜', d: '平', a: '客胜' };
  var SIDES = ['h', 'd', 'a'];

  // 串关「单场双选」开关：一场比赛选两个结果（如 主胜/平）组成 OR 腿，
  // 腿命中率≈两项概率之和（显著抬高），代价是组合赔率下降。全局可设，供各页统一读取。
  var OPTS = { useDouble: true };
  function setOption(k, v) { if (OPTS.hasOwnProperty(k)) OPTS[k] = v; }
  // 双选等效赔率：胜或平 = 1 / (1/jc₁ + 1/jc₂)（对两单项隐含概率取并的公平赔率）
  function doubleOdds(a, b) { return 1 / (1 / a + 1 / b); }

  function jcArr(meta) { return [+meta.jc_h, +meta.jc_d, +meta.jc_a]; }

  // 容错读取一场比赛的胜平负赔率（兼容多种数据源形状：直形 odds.{h,d,a} / 嵌套 had / 扁平字段）
  function extractOdds(m) {
    if (!m) return null;
    var o = m.odds;
    if (o && o.h && o.d && o.a) return [+o.h, +o.d, +o.a];
    var had = (o && o.had) ? o.had : (m.had || null);
    if (had && had.h && had.d && had.a) return [+had.h, +had.d, +had.a];
    if (m.oddsHome && m.oddsDraw && m.oddsAway) return [+m.oddsHome, +m.oddsDraw, +m.oddsAway];
    return null;
  }

  // 把若干"腿"组合成串关，计算组合概率/赔率/EV
  function combine(picks) {
    var combP = picks.reduce(function (a, p) { return a * p.prob; }, 1);
    var combOdds = picks.reduce(function (a, p) { return a * p.jc; }, 1);
    var ev = combP * (combOdds - 1) - (1 - combP);
    return { combP: combP, combOdds: combOdds, ev: ev };
  }

  // 把 scored 行展开成"每条可选边"，用于挑腿
  function legPool(scored) {
    return scored.map(function (x) {
      var p = x.res.p, ev = x.res.ev, jc = jcArr(x.meta);
      var bestEVi = ev[0] >= ev[1] ? (ev[0] >= ev[2] ? 0 : 2) : (ev[1] >= ev[2] ? 1 : 2);
      var bestPi = p[0] >= p[1] ? (p[0] >= p[2] ? 0 : 2) : (p[1] >= p[2] ? 1 : 2);
      return {
        meta: x.meta, p: p, ev: ev, jc: jc,
        bestPi: bestPi, bestEVi: bestEVi
      };
    });
  }

  /**
   * 稳妥型：每腿取"模型概率最高"的边，挑 top-N 场（不同比赛）组合。
   * 目标：最大化组合命中率（赔率偏低，回报有限）。
   */
  function buildStable(scored, legs) {
    legs = legs || 3;
    var pool = legPool(scored).map(function (x) {
      var i = x.bestPi;
      return { meta: x.meta, side: SIDES[i], sideZh: ZH[SIDES[i]], prob: x.p[i], jc: x.jc[i], ev: x.ev[i] };
    }).sort(function (a, b) { return b.prob - a.prob; });
    var picks = pool.slice(0, legs);
    return { type: 'stable', legs: picks, stats: combine(picks) };
  }

  /**
   * 单场双选（稳妥型增强）：每腿取「该场模型概率最高的两个结果」组成 OR 腿
   *   （如 主胜 / 平），腿命中率 ≈ p_最高 + p_次高（显著抬高组合命中率），
   *   等效赔率 = 1/(1/jc_最高 + 1/jc_次高)（明显下调），组合赔率随之下降。
   * 目标：在「稳妥型」基础上进一步抬高组合命中率；代价是组合赔率更低、EV 仍为负（市场有效）。
   *   （冷门型保持单边，因双选会直接抹掉其"高赔率"优势，违背价值定位）
   */
  function buildDoubleStable(scored, legs) {
    legs = legs || 3;
    var rows = scored.map(function (x) {
      var p = x.res.p, jc = jcArr(x.meta);
      var order = [0, 1, 2].sort(function (i, j) { return p[j] - p[i]; });
      var i = order[0], j = order[1];
      var pComb = p[i] + p[j];
      var jcD = doubleOdds(jc[i], jc[j]);
      var evD = pComb * (jcD - 1) - (1 - pComb);
      return {
        meta: x.meta, double: true, sides: [SIDES[i], SIDES[j]],
        sideZh: ZH[SIDES[i]] + ' / ' + ZH[SIDES[j]],
        prob: pComb, jc: jcD, ev: evD, type: 'stable'
      };
    }).sort(function (a, b) { return b.prob - a.prob; });
    var picks = rows.slice(0, legs);
    return { type: 'stable', legs: picks, stats: combine(picks), isDouble: true };
  }

  /**
   * 冷门型：在"理性冷门区间(赔率 2.5–8×)"内优先取 EV 为正的边，按 EV 降序挑腿。
   * 目标：给"有真实价值倾向的中等赔率冷门"，避免挑 10×+ 极端长shots 组合成彩票式串关。
   * 合理性护栏：要求 模型概率/盈亏平衡 ≤ MAX_EDGE_RATIO，剔除模型在极端盘上过度自信的假价值
   *   （P8 回测显示价值 ROI 为负，大幅 +EV 多为模型噪声，不可作为下注依据）。
   * 若区间正 EV 不足 N 条，则放宽到区间内全部（仍受护栏约束）；再不足则退回全量按 EV 降序。
   */
  var MAX_EDGE_RATIO = 1.6; // 模型概率最多为赔率隐含的 1.6 倍，超出视为不可信假价值
  function buildCold(scored, legs) {
    legs = legs || 3;
    var pool = legPool(scored).map(function (x) {
      var i = x.bestEVi;
      var be = 1 / x.jc[i];                       // 该边盈亏平衡（含抽水）
      var sane = x.p[i] <= MAX_EDGE_RATIO * be;   // 模型不过度自信才纳入
      return { meta: x.meta, side: SIDES[i], sideZh: ZH[SIDES[i]], prob: x.p[i], jc: x.jc[i], ev: x.ev[i], sane: sane };
    });
    var band = pool.filter(function (x) { return x.jc >= 2.5 && x.jc <= 8 && x.sane; });
    var pos = band.filter(function (x) { return x.ev > 0; });
    var srcPool = pos.length >= legs ? pos : (band.length >= legs ? band : pool);
    srcPool.sort(function (a, b) { return b.ev - a.ev; }); // 价值导向：EV 高者优先
    var picks = srcPool.slice(0, legs);
    return {
      type: 'cold', legs: picks, stats: combine(picks),
      usedPositivePool: pos.length >= legs, usedBand: pos.length < legs && band.length >= legs
    };
  }

  /**
   * 单场双选（冷门型增强）：每腿取「该场落在理性冷门区间(2.5–8×)且模型未过度自信」的两条结果
   *   组成 OR 腿（如 平 / 客胜），腿命中率 ≈ p₁ + p₂，较单边冷门明显抬高命中率；
   *   等效赔率 = 1/(1/jc₁ + 1/jc₂)（下降），组合赔率随之下降。
   * 目标：在「冷门型」基础上以赔率换命中，比单边冷门更稳；代价是回报已低于纯单边冷门、组合 EV 仍为负。
   * 设计权衡：要求两条边都落在冷门区间内（避免拉入 1.5× 热门把等效赔率压到 <1 的退化区）；
   *   若某场冷门区间不足两条可双选边，则该场退回单边冷门腿补足，保持 3 串结构（混合卡）。
   */
  function buildDoubleCold(scored, legs) {
    legs = legs || 3;
    var doubleLegs = [], singleCands = [];
    scored.forEach(function (x) {
      var p = x.res.p, ev = x.res.ev, jc = jcArr(x.meta);
      var band = [];
      for (var k = 0; k < 3; k++) {
        var be = 1 / jc[k];                 // 该边盈亏平衡（含抽水）
        if (jc[k] >= 2.5 && jc[k] <= 8 && p[k] <= MAX_EDGE_RATIO * be) {
          band.push({ k: k, p: p[k], jc: jc[k], ev: ev[k] });
        }
      }
      if (band.length >= 2) {
        band.sort(function (a, b) { return b.ev - a.ev; }); // 价值导向：EV 最高的两条
        var i = band[0], j = band[1];
        var pComb = i.p + j.p;
        var jcD = doubleOdds(i.jc, j.jc);
        var evD = pComb * (jcD - 1) - (1 - pComb);
        doubleLegs.push({
          meta: x.meta, double: true, sides: [SIDES[i.k], SIDES[j.k]],
          sideZh: ZH[SIDES[i.k]] + ' / ' + ZH[SIDES[j.k]],
          prob: pComb, jc: jcD, ev: evD, type: 'cold'
        });
      } else if (band.length === 1) {
        var b = band[0];
        singleCands.push({ meta: x.meta, side: SIDES[b.k], sideZh: ZH[SIDES[b.k]], prob: b.p, jc: b.jc, ev: b.ev });
      }
    });
    doubleLegs.sort(function (a, b) { return b.prob - a.prob; });
    var picks = doubleLegs.slice(0, legs);
    // 双选腿不足 legs：用单边冷门腿补足，保持 3 串结构（混合卡）
    if (picks.length < legs) {
      var used = {};
      picks.forEach(function (l) { used[l.meta.zhHome + '|' + l.meta.zhAway] = true; });
      singleCands.sort(function (a, b) { return b.ev - a.ev; });
      singleCands.forEach(function (c) {
        if (picks.length >= legs) return;
        if (used[c.meta.zhHome + '|' + c.meta.zhAway]) return;
        used[c.meta.zhHome + '|' + c.meta.zhAway] = true;
        picks.push(c);
      });
    }
    if (!picks.length) return buildCold(scored, legs); // 完全无冷门边：退回单边冷门
    return {
      type: 'cold', legs: picks, stats: combine(picks),
      isDouble: picks.some(function (l) { return l.double; })
    };
  }

  // 把"当日比赛"转成与历史记录相同的 scored 行（供 buildStable/buildCold 复用）
  // 有国际均价时走 P8 多源融合模型；否则用竞彩去抽水隐含概率（诚实降级，仍需如实标注）
  function scoreCurrentMatches(matches) {
    var OM = (typeof window !== 'undefined' ? window : globalThis).OddsModel;
    var rows = [];
    for (var i = 0; i < (matches || []).length; i++) {
      var m = matches[i];
      var jc = extractOdds(m);
      if (!jc || jc.some(function (v) { return !(v > 1); })) continue;
      var meta = {
        zhHome: m.homeTeamFull || m.homeTeam || '主队',
        zhAway: m.awayTeamFull || m.awayTeam || '客队',
        jc_h: jc[0], jc_d: jc[1], jc_a: jc[2],
        code: m.code || '', league: m.league || '', time: m.time || ''
      };
      var res = null, usedModel = false;
      if (m.eu_avg) {
        var eu = Array.isArray(m.eu_avg) ? m.eu_avg.map(Number) : [+m.eu_avg.h, +m.eu_avg.d, +m.eu_avg.a];
        if (eu.length === 3 && eu[0] > 1 && eu[1] > 1 && eu[2] > 1 && OM && OM.predict) res = OM.predict(jc, eu);
      }
      if (!res) {
        var inv = [1 / jc[0], 1 / jc[1], 1 / jc[2]];
        var s = inv[0] + inv[1] + inv[2];
        var p = [inv[0] / s, inv[1] / s, inv[2] / s];
        var be = [1 / jc[0], 1 / jc[1], 1 / jc[2]];
        // 无国际均价：gap 缺失（无国内vs国际偏差可比），advice 层对此已做空值保护
        res = { p: p, breakeven: be, ev: [p[0] - be[0], p[1] - be[1], p[2] - be[2]], gap: null };
      } else { usedModel = true; }
      rows.push({ meta: meta, res: res, advice: (OM && OM.advice) ? OM.advice(res) : null, usedModel: usedModel, isCurrent: true });
    }
    return rows;
  }

  function recommendFromScored(scored, legs, opts) {
    if (!scored.length) return null;
    opts = opts || {};
    var useDouble = opts.useDouble !== undefined ? opts.useDouble : OPTS.useDouble;
    return {
      stable: useDouble ? buildDoubleStable(scored, legs) : buildStable(scored, legs),
      cold: useDouble ? buildDoubleCold(scored, legs) : buildCold(scored, legs),
      analyzedN: scored.length,
      usedModel: scored.some(function (x) { return x.usedModel; }),
      useDouble: useDouble
    };
  }

  function recommend(history, legs, opts) {
    // 兼容旧调用：传入历史三件套数组（含 jc_h/jc_d/jc_a/eu_avg）
    var OM = (typeof window !== 'undefined' ? window : globalThis).OddsModel;
    var scored = (OM && OM.scoreHistory) ? OM.scoreHistory(history) : [];
    if (!scored.length) return null;
    return recommendFromScored(scored, legs, opts);
  }

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
  }

  function renderLegs(legs) {
    return '<ol class="parlay-legs">' + legs.map(function (x) {
      var evCls = x.ev >= 0 ? 'pos' : 'neg';
      var pick = (x.double ? '<span class="pl-double">双选</span> ' : '') + x.sideZh + ' @' + x.jc.toFixed(2);
      return '<li><span class="pl-teams">' + esc((x.meta.zhHome || '') + ' vs ' + (x.meta.zhAway || '')) +
        '</span><span class="pl-pick">' + pick +
        '</span><span class="pl-prob">' + (x.prob * 100).toFixed(1) + '%</span>' +
        '<span class="pl-ev ' + evCls + '">' + (x.ev >= 0 ? '+' : '') + (x.ev * 100).toFixed(1) + 'pp</span></li>';
    }).join('') + '</ol>';
  }

  // 组合属性摘要：一眼看出"这组是怎么挑出来的"（哪条边/赔率区间/策略目标）
  function summarizeStrategy(rec) {
    var isStable = rec.type === 'stable';
    var sides = rec.legs.map(function (x) { return x.sideZh; });
    var jcs = rec.legs.map(function (x) { return x.jc; });
    var minJ = Math.min.apply(null, jcs), maxJ = Math.max.apply(null, jcs);
    var uniq = [];
    sides.forEach(function (s) { if (uniq.indexOf(s) < 0) uniq.push(s); });
    var sidePart = uniq.length === 1 ? ('组合 100% ' + uniq[0] + '腿') : ('含 ' + uniq.join('/') + ' 边');
    var oddsPart = '赔率区间 ' + minJ.toFixed(2) + '–' + maxJ.toFixed(2) + '×';
    var goal = rec.isDouble
      ? (isStable ? '单场双选·命中率最大化（赔率更低）' : '冷门双选·以赔率换命中（回报仍高于稳妥）')
      : (isStable ? '命中率最大化（必然伴随强抽水）' : '回报最大化（命中率低、波动大）');
    return sidePart + ' · ' + oddsPart + ' · ' + goal;
  }

  function renderCard(rec) {
    var isStable = rec.type === 'stable';
    var isCold = rec.type === 'cold';
    var isDouble = !!rec.isDouble;
    var s = rec.stats;
    var title = isDouble
      ? (isStable ? '稳妥型·双选（更高命中）' : '冷门型·双选（更稳的高回报）')
      : (isStable ? '稳妥型（高命中）' : '冷门型（高回报）');
    var badge = isStable ? 'badge-green' : 'badge-amber';
    var note;
    if (isDouble && isStable) {
      note = '每腿取该场模型概率最高的两个结果（如 主胜 / 平）组成 OR 腿，腿命中率≈两项概率之和，显著抬高组合命中率；代价是组合赔率明显下降（双选等效赔率 = 1/(1/jc₁ + 1/jc₂)）。' +
        '组合 EV 仍为负（市场有效），属"以赔率换命中"的稳妥玩法，适合更看重"中串"而非回报的场景。';
    } else if (isDouble && isCold) {
      var hasSingle = rec.legs.some(function (l) { return !l.double; });
      note = '每腿取该场落在理性冷门区间(2.5–8×)且模型未过度自信的两条结果组成 OR 腿（如 平 / 客胜），腿命中率≈两项概率之和，较单边冷门明显抬高命中率；' +
        '代价是组合赔率下降（双选等效赔率 = 1/(1/jc₁ + 1/jc₂)）。组合 EV 仍为负（市场有效），属"以赔率换命中"的冷门玩法——比单边冷门更稳，但回报已低于纯单边冷门。' +
        (hasSingle ? '当日部分比赛冷门区间不足两条可双选边，已以单边冷门腿补足。' : '');
    } else if (isStable) {
      note = '精选模型最看好的 ' + rec.legs.length + ' 项（单边概率最高），最大化组合命中率；赔率低、波动小，但单边 EV 为负（已含竞彩抽水），属"高命中但数学不划算"的稳妥玩法。';
    } else {
      note = '在理性冷门区间(赔率 2.5–8×)内挑选模型价值倾向边（优先 EV 为正），组成 ' + rec.legs.length + ' 串；潜在回报高于稳妥型，但命中率低、波动大。' +
        '注意：组合 EV 是模型在历史样本内的拟合结果（样本内乐观），P8 的 5-fold 外推回测显示真实价值 ROI≈−4.8%，故本组为"价值倾向候选"而非已验证优势，请谨慎。' +
        (rec.usedPositivePool ? '' : (rec.usedBand ? '当前区间正 EV 不足，已取区间内最高 EV 边。' : '候选池偏薄，已退回全量按 EV 排序。'));
    }
    var evCls = s.ev >= 0 ? 'pos' : 'neg';
    return '<div class="parlay-card ' + (isStable ? 'stable' : 'cold') + '">' +
      '<div class="parlay-card-head"><span class="badge ' + badge + '">' + title + '</span>' +
      '<span class="parlay-comb-ev ' + evCls + '">组合 EV ' + (s.ev >= 0 ? '+' : '') + (s.ev * 100).toFixed(1) + 'pp</span></div>' +
      renderLegs(rec.legs) +
      '<div class="parlay-stats">' +
      '<div><span class="ps-k">组合模型概率</span><span class="ps-v">' + (s.combP * 100).toFixed(2) + '%</span></div>' +
      '<div><span class="ps-k">组合竞彩赔率</span><span class="ps-v">' + s.combOdds.toFixed(2) + '×</span></div>' +
      '</div>' +
      '<div class="parlay-strategy">' + summarizeStrategy(rec) + '</div>' +
      '<div class="parlay-note">' + note + '</div>' +
      '</div>';
  }

  function paintRec(container, rec, info) {
    if (!rec) { container.innerHTML = '<div class="empty-hint">无可分析场次。</div>'; return; }
    var srcLabel = info.isCurrent
      ? '基于当日 ' + rec.analyzedN + ' 场在售比赛'
      : '基于 ' + rec.analyzedN + ' 场历史回测';
    var modelLabel = rec.usedModel ? 'P8 模型（2159 场历史校准）' : '竞彩去抽水隐含概率';
    var demoBanner = info.fallback
      ? '<div class="parlay-demo-banner">⚠️ 演示数据：当前无在售场次或赔率暂不可读，以下为 <b>' + rec.analyzedN + ' 场历史回测样本</b>，<b>非当日真实推荐</b>，仅供模型与界面演示。接入竞彩 / SCF 代理实时数据后自动切换为当日串关。</div>'
      : '';
    container.innerHTML =
      demoBanner +
      '<div class="patterns-head">AI 串关推荐 · ' + srcLabel + ' · ' + modelLabel + ' · 双策略（市场有效，组合 EV 多为负，仅作风险/回报取舍参考）</div>' +
      '<div class="parlay-row">' + renderCard(rec.stable) + renderCard(rec.cold) + '</div>' +
      '<div class="patterns-foot">组合 EV = 组合模型概率 ×(组合赔率−1) −(1−组合概率)，竞彩串关赔率为各腿相乘。' +
      '因多次抽水叠加，组合 EV 通常为负；「稳妥型」主打高命中、「冷门型」主打高回报，均为风险偏好选择，不构成必胜建议。' +
      (info.isCurrent && !rec.usedModel ? '（当前比赛未接入国际均价，概率取自竞彩去抽水隐含值；开启国际赔率采集后自动升级为 P8 模型。）' : '') +
      '</div>';
  }

  function renderParlayPanel(container, legs, matches, opts) {
    if (!container) return;
    legs = legs || 3;

    // 1) 当日比赛优先：有数据且可打分 → 直接展示当日串关（修复"显示历史比赛"问题）
    if (Array.isArray(matches) && matches.length) {
      var scored = scoreCurrentMatches(matches);
      if (scored.length) {
        paintRec(container, recommendFromScored(scored, legs, opts), {
          isCurrent: true,
          usedModel: scored.some(function (x) { return x.usedModel; }),
          fallback: false
        });
        return;
      }
    }

    // 2) 无当日数据 / 当日赔率不可读 → 历史回测演示（明确标注，非当日推荐）
    renderParlayFallback(container, legs, opts);
  }

  // 历史回测演示：仅在无当日可分析场次时作为兜底，明确标注为演示数据（不冒充当日推荐）
  function renderParlayFallback(container, legs, opts) {
    container.innerHTML = '<div class="empty-hint">无当日可分析场次，正在加载历史回测演示…</div>';
    var v = window.APP_VERSION || '';
    var cands = ['ml/data/eu_odds_history.json?v=' + v, './ml/data/eu_odds_history.json?v=' + v, 'jingcai-pro/ml/data/eu_odds_history.json?v=' + v];
    (function tryFetch(i) {
      if (i >= cands.length) { container.innerHTML = '<div class="empty-hint">无法加载历史回测数据。</div>'; return; }
      fetch(cands[i]).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (hist) {
        paintRec(container, recommend(hist, legs, opts), { isCurrent: false, usedModel: true, fallback: true });
      }).catch(function () { tryFetch(i + 1); });
    })(0);
  }

  var api = {
    combine: combine, buildStable: buildStable, buildCold: buildCold, buildDoubleStable: buildDoubleStable, buildDoubleCold: buildDoubleCold,
    scoreCurrentMatches: scoreCurrentMatches, recommendFromScored: recommendFromScored,
    recommend: recommend, renderParlayPanel: renderParlayPanel, renderCard: renderCard,
    setOption: setOption, getOption: function (k) { return OPTS[k]; }
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.OddsParlay = api;
  }
})(typeof window !== 'undefined' ? window : this);
