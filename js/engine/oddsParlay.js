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
  var ZH_HHAD = { h: '让胜', d: '让平', a: '让负' };
  var SIDES = ['h', 'd', 'a'];

  // 腿的中文标签：让球玩法(HHAD)用让胜/让平/让负，其余用主胜/平/客胜。
  // 双选时 suffixIdx 有效（如"让胜 / 让平"）。
  function legSideZh(meta, i, j) {
    var z = (meta && meta.market === 'HHAD') ? ZH_HHAD : ZH;
    var s = z[SIDES[i]];
    if (j !== undefined && j !== null) s += ' / ' + z[SIDES[j]];
    return s;
  }

  // 串关「单场双选」开关：一场比赛选两个结果（如 主胜/平）组成 OR 腿，
  // 腿命中率≈两项概率之和（显著抬高），代价是组合赔率下降。全局可设，供各页统一读取。
  var OPTS = { useDouble: true };
  function setOption(k, v) { if (OPTS.hasOwnProperty(k)) OPTS[k] = v; }
  // 双选等效赔率：胜或平 = 1 / (1/jc₁ + 1/jc₂)（对两单项隐含概率取并的公平赔率）
  function doubleOdds(a, b) { return 1 / (1 / a + 1 / b); }

  function jcArr(meta) { return [+meta.jc_h, +meta.jc_d, +meta.jc_a]; }

  // ===== 泛化「玩法候选行」工具（竞彩所有可售玩法均可作为推荐项）=====
  // 每个玩法行的 res.p / res.ev / res.breakeven 与 meta.options 一一对应；
  // meta.options = [{key, zh, odds, p, ev, be}, ...]，选项数可变（TTG 8 / CRS 31 / HAFU 9 ...）。
  // 兼容旧 HAD 三项行：无 options 时 legPool 仍走 SIDES 三项逻辑。
  function isMarketRow(x) { return !!(x && x.meta && Array.isArray(x.meta.options) && x.meta.options.length >= 2); }

  // 把带 options 的玩法行按"单腿最优选项"展开成可挑的腿（供 stable/cold 复用三项挑腿器）
  // sideZh 直接取该玩法选项中文名；marketLabel 供 UI 标注玩法来源。
  function marketRowToScored(x) {
    var opt = x.meta.options;
    var bestP = 0, bestEV = -Infinity, iP = 0, iEV = 0;
    for (var i = 0; i < opt.length; i++) {
      if (opt[i].p > bestP) { bestP = opt[i].p; iP = i; }
      if (opt[i].ev > bestEV) { bestEV = opt[i].ev; iEV = i; }
    }
    // 伪造与历史行一致的形状，使 pickMarketPerMatch/buildStable/buildCold 无需大改。
    // p/ev 用选项数组（任意长度），bestPi/bestEVi 此时由 legPool 内 argmax 重算，故这里仅占位。
    return {
      meta: x.meta, res: x.res, advice: x.advice, usedModel: x.usedModel, isCurrent: true,
      jcArr: x.jcArr, euArr: x.euArr, matchKey: x.matchKey,
      openOdds: x.openOdds, closeOdds: x.closeOdds,
      ruleTags: x.ruleTags || [], appliedRules: x.appliedRules || [], ruleApplied: !!x.ruleApplied
    };
  }

  // argmax：兼容任意长度数组
  function argmaxN(a) {
    var bi = 0, bv = -Infinity;
    for (var i = 0; i < a.length; i++) if (a[i] > bv) { bv = a[i]; bi = i; }
    return bi;
  }

  // 泛化 legPool：对玩法行用 meta.options 的选项中文名，对历史行沿用 SIDES
  function legPoolGeneric(scored) {
    return scored.map(function (x) {
      var p = x.res.p, ev = x.res.ev, jc = jcArr(x.meta);
      var opts = (x.meta && x.meta.options) || null;
      var bestEVi = argmaxN(ev), bestPi = argmaxN(p);
      return {
        meta: x.meta, p: p, ev: ev, jc: jc,
        bestPi: bestPi, bestEVi: bestEVi,
        options: opts,
        ruleTags: x.ruleTags || [], appliedRules: x.appliedRules || []
      };
    });
  }

  // 选项中文名（玩法行取 options[i].zh，历史行取 ZH[ SIDES[i] ]）
  function sideLabel(poolRow, i, j) {
    var o = poolRow.options;
    var s = o ? String(o[i].zh) : (poolRow.meta.market === 'HHAD' ? ZH_HHAD[SIDES[i]] : ZH[SIDES[i]]);
    if (j !== undefined && j !== null) {
      s += ' / ' + (o ? String(o[j].zh) : (poolRow.meta.market === 'HHAD' ? ZH_HHAD[SIDES[j]] : ZH[SIDES[j]]));
    }
    return s;
  }

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
        bestPi: bestPi, bestEVi: bestEVi,
        ruleTags: x.ruleTags || [], appliedRules: x.appliedRules || []
      };
    });
  }

  /**
   * 稳妥型：每腿取"模型概率最高"的边，挑 top-N 场（不同比赛）组合。
   * 目标：最大化组合命中率（赔率偏低，回报有限）。
   */
  function buildStable(scored, legs) {
    legs = legs || 3;
    var pool = legPoolGeneric(scored).map(function (x) {
      var i = x.bestPi;
      return {
        meta: x.meta, side: x.options ? x.options[i].key : SIDES[i],
        sideZh: sideLabel(x, i), prob: x.p[i], jc: x.jc[i], ev: x.ev[i],
        marketLabel: x.meta.marketLabel || null,
        ruleTags: x.ruleTags || [], appliedRules: x.appliedRules || []
      };
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
      var idxs = []; for (var k = 0; k < p.length; k++) idxs.push(k);
      var order = idxs.sort(function (i, j) { return p[j] - p[i]; });
      var i = order[0], j = order[1];
      var pComb = p[i] + p[j];
      var jcD = doubleOdds(jc[i], jc[j]);
      var evD = pComb * (jcD - 1) - (1 - pComb);
      var opts = x.meta && x.meta.options;
      return {
        meta: x.meta, double: true,
        sides: [opts ? opts[i].key : SIDES[i], opts ? opts[j].key : SIDES[j]],
        sideZh: sideLabel({ meta: x.meta, options: opts }, i, j),
        prob: pComb, jc: jcD, ev: evD, type: 'stable',
        marketLabel: x.meta.marketLabel || null,
        ruleTags: x.ruleTags || [], appliedRules: x.appliedRules || []
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
    var pool = legPoolGeneric(scored).map(function (x) {
      var i = x.bestEVi;
      var be = 1 / x.jc[i];                       // 该边盈亏平衡（含抽水）
      var sane = x.p[i] <= MAX_EDGE_RATIO * be;   // 模型不过度自信才纳入
      return {
        meta: x.meta, side: x.options ? x.options[i].key : SIDES[i],
        sideZh: sideLabel(x, i), prob: x.p[i], jc: x.jc[i], ev: x.ev[i], sane: sane,
        marketLabel: x.meta.marketLabel || null
      };
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
      var opts = x.meta && x.meta.options;
      var sKey = function (k) { return opts ? opts[k].key : SIDES[k]; };
      var band = [];
      for (var k = 0; k < p.length; k++) {
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
          meta: x.meta, double: true, sides: [sKey(i.k), sKey(j.k)],
          sideZh: sideLabel({ meta: x.meta, options: opts }, i.k, j.k),
          prob: pComb, jc: jcD, ev: evD, type: 'cold',
          marketLabel: x.meta.marketLabel || null,
          ruleTags: x.ruleTags || [], appliedRules: x.appliedRules || []
        });
      } else if (band.length === 1) {
        var b = band[0];
        singleCands.push({
          meta: x.meta, side: sKey(b.k), sideZh: sideLabel({ meta: x.meta, options: opts }, b.k),
          prob: b.p, jc: b.jc, ev: b.ev, marketLabel: x.meta.marketLabel || null
        });
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

  // 当日可购买判定：竞彩官方 matchStatus='Selling' 才算在售；
  // 代理/历史结构可能没有 status，只要赔率有效就按可购买处理（不误杀）。
  // 已完场/停售/取消的场次绝不进入串关，避免推荐无法下单的历史比赛。
  function isPurchasable(m) {
    if (!m) return false;
    var s = String(m.status || m.matchStatus || '').toLowerCase();
    if (s && s !== 'selling' && s !== 'sale' && s !== 'onsale' && s !== 'open') return false;
    return true;
  }

  // 竞彩销售日：当日 10:00 ≤ 开赛时间 < 次日 10:00。
  // 以 10:00 为界；若当前时刻在 10:00 之前，则归属"昨日 10:00 ~ 今日 10:00"这个销售日。
  function salesWindow(now) {
    var d = (now instanceof Date) ? new Date(now.getTime()) : (now ? new Date(now) : new Date());
    var start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0, 0);
    if (d.getTime() < start.getTime()) start.setDate(start.getDate() - 1);
    var end = new Date(start.getTime());
    end.setDate(end.getDate() + 1);
    return { start: start, end: end };
  }

  // 开赛时间是否落在当前销售日窗口内。
  // 无开赛日期/时间时无法判断 → 降级保留（仍受 isPurchasable 在售约束），避免误杀。
  function inSalesWindow(m, now) {
    if (!m) return false;
    var date = m.date || m.matchDate || '';
    var time = m.time || m.matchTime || '';
    var dm = String(date).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (!dm) return true;
    var tm = String(time).match(/^(\d{1,2}):(\d{1,2})/);
    var hh = tm ? +tm[1] : 0;
    var mm = tm ? +tm[2] : 0;
    var kick = new Date(+dm[1], +dm[2] - 1, +dm[3], hh, mm, 0, 0);
    if (isNaN(kick.getTime())) return true;
    var w = salesWindow(now);
    return kick.getTime() >= w.start.getTime() && kick.getTime() < w.end.getTime();
  }

  // 由 HAD 三项概率 + 竞彩真实整数盘口，反演 xG 后重算让胜平负概率。
  // 复用 MultiDim（与研判页同一套泊松基底，口径一致）；不可用时降级为 hhad 赔率去水。
  function handicapProbs(hadP, line, hhadOdds) {
    var MD = (typeof window !== 'undefined' ? window : globalThis).MultiDim;
    if (MD && MD.buildMultiDim && hadP && hadP.length === 3 && typeof line === 'number') {
      try {
        var md = MD.buildMultiDim(
          { homeWin: hadP[0], draw: hadP[1], awayWin: hadP[2] },
          { line: line }
        );
        if (md && md.asian) return [md.asian.home, md.asian.draw, md.asian.away];
      } catch (e) { /* 降级到赔率去水 */ }
    }
    // 降级：用竞彩 hhad 赔率去水（诚实标注为市场隐含，非模型）
    if (hhadOdds && hhadOdds.length === 3) {
      var inv = hhadOdds.map(function (o) { return 1 / o; });
      var s = inv[0] + inv[1] + inv[2];
      return [inv[0] / s, inv[1] / s, inv[2] / s];
    }
    return null;
  }

  // 由方向概率求 xG（供 TTG/CRS/HAFU 概率派生，与研判页同源）
  function xgFromProbs(p) {
    var MD = (typeof window !== 'undefined' ? window : globalThis).MultiDim;
    if (!MD || !MD.solveXg || !p || p.length < 3) return null;
    try {
      var x = MD.solveXg(p[0], p[1], p[2], { maxGoals: 8 });
      return (x && x.homeXg > 0) ? x : null;
    } catch (e) { return null; }
  }

  // 把概率数组 + 赔率数组 + 中文标签数组，转成候选行的 options（每项含 ev/be）
  function mkOptions(keys, zhs, odds, probs) {
    var out = [];
    for (var i = 0; i < odds.length; i++) {
      var o = +odds[i], p = +probs[i];
      if (!(o > 1) || !(p > 0) || !isFinite(p)) continue;
      out.push({
        key: keys[i], zh: zhs[i], odds: o, p: p,
        be: 1 / o, ev: p * o - 1
      });
    }
    return out;
  }

  // 由一场比赛生成「所有竞彩真实在售玩法」的候选行（每玩法一行，供每场择一）。
  // 概率来自 xG 泊松派生（与研判页 MultiDim 同源）；赔率来自竞彩真实在售值。
  // 返回行数组；无有效概率/赔率的玩法自动跳过。
  function buildMarketRows(m, baseP, matchKey, usedModel) {
    var MD = (typeof window !== 'undefined' ? window : globalThis).MultiDim;
    if (!MD) return [];
    var rows = [];
    var base = {
      zhHome: m.homeTeamFull || m.homeTeam || '主队',
      zhAway: m.awayTeamFull || m.awayTeam || '客队',
      code: m.code || '', league: m.league || '',
      date: m.date || '', time: m.time || '', matchKey: matchKey,
      isCurrent: true, usedModel: usedModel, oddsInferred: !!m.oddsInferred
    };
    var xg = xgFromProbs(baseP);

    // 1) 胜平负 HAD（仅竞彩真实开出且非反推时；反推赔率不可当可买项）
    if (!m.oddsInferred) {
      var jc = extractOdds(m);
      if (jc && jc.length === 3 && jc.every(function (v) { return v > 1; })) {
        var opt = mkOptions(SIDES, ['主胜', '平', '客胜'], jc, baseP);
        if (opt.length === 3) {
          rows.push(makeMarketRow('HAD', '胜平负', base, opt, jc, baseP));
        }
      }
    }

    // 2) 让球胜平负 HHAD（竞彩真实整数盘）
    var hh = m.hhad, hhOdds = hh && [+hh.h, +hh.d, +hh.a];
    var hhLine = (typeof m.handicap === 'number' && !isNaN(m.handicap))
      ? m.handicap
      : (hh && hh.line ? Number(String(hh.line).replace('+', '')) : null);
    if (hhOdds && hhOdds.length === 3 && hhOdds.every(function (v) { return v > 1; }) &&
        typeof hhLine === 'number' && hhLine !== 0) {
      var hp = handicapProbs(baseP, hhLine, hhOdds);
      if (hp && hp.every(function (v) { return v > 0; })) {
        var hopt = mkOptions(SIDES, ['让胜', '让平', '让负'], hhOdds, hp);
        if (hopt.length === 3) {
          var hrow = makeMarketRow('HHAD', '让球胜平负 ' + lineText(hhLine), base, hopt, hhOdds, hp);
          hrow.meta.line = hhLine;
          rows.push(hrow);
        }
      }
    }

    if (!xg) return rows; // 无 xG：仅 HAD/HHAD（其概率不依赖 xG）

    // 3) 总进球 TTG（s0~s7，s7=7+球）
    if (m.ttg && Object.keys(m.ttg).length) {
      var tg = MD.totalGoals(xg.homeXg, xg.awayXg, 7); // 7+=桶
      var tgKeys = [], tgZh = [], tgOdds = [], tgP = [];
      for (var g = 0; g <= 7; g++) {
        var key = 's' + g;
        var od = +(m.ttg[key] || m.ttg[String(g)]);
        if (!(od > 1)) continue;
        var bucket = tg.find(function (t) {
          return String(t.goals).replace('+', '') === String(g);
        });
        var pv = bucket ? bucket.p : 0;
        tgKeys.push(key); tgZh.push(g === 7 ? '7+球' : (g + '球'));
        tgOdds.push(od); tgP.push(pv);
      }
      var topt = mkOptions(tgKeys, tgZh, tgOdds, tgP);
      if (topt.length) rows.push(makeMarketRow('TTG', '总进球', base, topt, tgOdds, tgP, tgKeys));
    }

    // 4) 比分 CRS（sXXsYY，主2位+客2位；概率取泊松比分矩阵）
    if (m.crs && Object.keys(m.crs).length && MD.scoreMatrix) {
      var sm = MD.scoreMatrix(xg.homeXg, xg.awayXg, 8);
      var pmap = {};
      sm.forEach(function (s) { pmap[s.home + ':' + s.away] = s.p; });
      var ck = [], cz = [], co = [], cp = [];
      Object.keys(m.crs).forEach(function (k) {
        var mm = String(k).match(/^s(\d{2})s(\d{2})$/);
        if (!mm) return;
        var h = +mm[1], a = +mm[2], od = +m.crs[k];
        if (!(od > 1)) return;
        var pv = pmap[h + ':' + a];
        if (!(pv > 0)) return;
        ck.push(k); cz.push(h + ':' + a); co.push(od); cp.push(pv);
      });
      var copt = mkOptions(ck, cz, co, cp);
      if (copt.length) rows.push(makeMarketRow('CRS', '比分', base, copt, co, cp, ck));
    }

    // 5) 半全场 HAFU（9 组合，概率取上下半场联合分布）
    if (m.hafu && Object.keys(m.hafu).length && MD.halfFullWdl) {
      var hf = MD.halfFullWdl(xg.homeXg, xg.awayXg);
      var hfZh = {
        hh: '胜/胜', hd: '胜/平', ha: '胜/负',
        dh: '平/胜', dd: '平/平', da: '平/负',
        ah: '负/胜', ad: '负/平', aa: '负/负'
      };
      var fk = [], fz = [], fo = [], fp = [];
      Object.keys(hfZh).forEach(function (k) {
        var od = +m.hafu[k];
        if (!(od > 1)) return;
        fk.push(k); fz.push(hfZh[k]); fo.push(od); fp.push(hf[k] || 0);
      });
      var fopt = mkOptions(fk, fz, fo, fp);
      if (fopt.length) rows.push(makeMarketRow('HAFU', '半全场', base, fopt, fo, fp, fk));
    }

    return rows;
  }

  function lineText(line) {
    return (line > 0 ? '+' : '') + line;
  }

  // 构造一条玩法候选行（形状对齐历史 scored 行，补 meta.options / meta.marketLabel）
  function makeMarketRow(market, marketLabel, base, options, jc, probs, keysOverride) {
    var ev = options.map(function (o) { return o.ev; });
    var be = options.map(function (o) { return o.be; });
    var p = options.map(function (o) { return o.p; });
    var meta = {
      zhHome: base.zhHome, zhAway: base.zhAway, code: base.code, league: base.league,
      date: base.date, time: base.time, matchKey: base.matchKey,
      market: market, marketLabel: marketLabel, options: options,
      jc_h: +jc[0], jc_d: +jc[1], jc_a: +jc[2]
    };
    return {
      meta: meta,
      res: { p: p, breakeven: be, ev: ev, gap: null },
      advice: null, usedModel: base.usedModel, isCurrent: true,
      jcArr: jc, euArr: null, matchKey: base.matchKey,
      openOdds: null, closeOdds: null,
      oddsInferred: base.oddsInferred
    };
  }

  // 把"当日比赛"转成与历史记录相同的 scored 行（供 buildStable/buildCold 复用）
  // 有国际均价时走 P8 多源融合模型；否则用竞彩去抽水隐含概率（诚实降级，仍需如实标注）
  function scoreCurrentMatches(matches, now) {
    var OM = (typeof window !== 'undefined' ? window : globalThis).OddsModel;
    var rows = [];
    for (var i = 0; i < (matches || []).length; i++) {
      var m = matches[i];
      if (!isPurchasable(m)) continue; // 只保留当日竞彩在售场次
      if (!inSalesWindow(m, now)) continue; // 只保留当前竞彩销售日窗口内开赛的场次
      var jc = extractOdds(m);
      if (!jc || jc.some(function (v) { return !(v > 1); })) continue;
      var matchKey = m.code || ((m.homeTeam || '') + '_' + (m.awayTeam || ''));
      var meta = {
        zhHome: m.homeTeamFull || m.homeTeam || '主队',
        zhAway: m.awayTeamFull || m.awayTeam || '客队',
        jc_h: jc[0], jc_d: jc[1], jc_a: jc[2],
        code: m.code || '', league: m.league || '',
        date: m.date || '', time: m.time || '',
        market: 'HAD', matchKey: matchKey
      };
      var res = null, usedModel = false, euArr = null;
      if (m.eu_avg) {
        var eu = Array.isArray(m.eu_avg) ? m.eu_avg.map(Number) : [+m.eu_avg.h, +m.eu_avg.d, +m.eu_avg.a];
        if (eu.length === 3 && eu[0] > 1 && eu[1] > 1 && eu[2] > 1) {
          euArr = eu;
          if (OM && OM.predict) res = OM.predict(jc, eu);
        }
      }
      if (!res) {
        var inv = [1 / jc[0], 1 / jc[1], 1 / jc[2]];
        var s = inv[0] + inv[1] + inv[2];
        var p = [inv[0] / s, inv[1] / s, inv[2] / s];
        var be = [1 / jc[0], 1 / jc[1], 1 / jc[2]];
        // 无国际均价：gap 缺失（无国内vs国际偏差可比），advice 层对此已做空值保护
        res = { p: p, breakeven: be, ev: [p[0] - be[0], p[1] - be[1], p[2] - be[2]], gap: null };
      } else { usedModel = true; }

      // 有完整竞彩玩法数据的当日场次 → 生成全玩法候选行（HAD/HHAD/TTG/CRS/HAFU）。
      // 只有 odds 的历史场次（compare.js 复盘）无 hhad/ttg/crs/hafu → 保持原 HAD 三项行，向后兼容。
      var hasPlays = !!(m.ttg || m.crs || m.hafu || m.hhad);
      if (hasPlays) {
        var mrows = buildMarketRows(m, res.p, matchKey, usedModel);
        if (mrows.length) {
          mrows.forEach(function (r) {
            r.openOdds = m.openOdds || null;
            r.closeOdds = m.closeOdds || null;
            r.euArr = euArr;
            r.advice = (OM && OM.advice) ? OM.advice(res) : null;
          });
          rows = rows.concat(mrows);
          continue;
        }
      }

      // 降级：无玩法数据的历史行（HAD 三项），保持原逻辑。
      // （有 hhad 的场次已在上方 hasPlays 分支由 buildMarketRows 统一生成 HHAD，此处不会重复。）
      rows.push({
        meta: meta, res: res, advice: (OM && OM.advice) ? OM.advice(res) : null,
        usedModel: usedModel, isCurrent: true,
        jcArr: jc, euArr: euArr, matchKey: matchKey,
        openOdds: m.openOdds || null, closeOdds: m.closeOdds || null
      });
    }
    return rows;
  }

  // 每场只保留一个玩法市场：按该市场最高单腿命中概率择优选（稳妥优先），
  // 避免同一场比赛的 HAD 与 HHAD 腿同时进串（不可重复下注同一场）。
  function pickMarketPerMatch(rows) {
    var best = {};
    rows.forEach(function (r) {
      var k = r.matchKey || r.meta.matchKey || Math.random();
      var topP = Math.max.apply(null, r.res.p);
      if (!best[k] || topP > best[k]._topP) { r._topP = topP; best[k] = r; }
    });
    return Object.keys(best).map(function (k) { var r = best[k]; delete r._topP; return r; });
  }

  function recommendFromScored(scored, legs, opts) {
    if (!scored.length) return null;
    opts = opts || {};
    var useDouble = opts.useDouble !== undefined ? opts.useDouble : OPTS.useDouble;
    // 规则层：把登记的所有"提升 pp"规则（分歧以欧赔为准 / CLV 资金流等）施加到打分结果上。
    // 无规则模块时优雅降级为原样打分（保持向后兼容）。
    var RR = (typeof window !== 'undefined' ? window : globalThis).RecommendRules;
    // 规则层 R1/R2 是 HAD 三项方向规则：只作用于历史三项行。
    // 玩法行(N 项 options)的概率已由同一方向基底派生，若让 R2 按三项索引改 res.p 会破坏数组结构，
    // 故玩法行跳过规则层（其基底已在 scoreCurrentMatches 用同一 P8/去水概率生成）。
    var legacy = scored.filter(function (x) { return !isMarketRow(x); });
    var marketRows = scored.filter(function (x) { return isMarketRow(x); });
    var appliedLegacy = (RR && RR.applyTo && legacy.length) ? RR.applyTo(legacy) : legacy;
    var applied = appliedLegacy.concat(marketRows);
    // 同一场可能同时有多个玩法候选行，只保留命中概率最高的一个市场，避免同场重复下注。
    applied = pickMarketPerMatch(applied);
    // analyzedN 按"场"统计而非玩法行：多玩法场次的候选行去重，避免把 16 场显示成 39 场。
    var matchKeys = {};
    scored.forEach(function (x) { matchKeys[x.matchKey || (x.meta && x.meta.matchKey) || Math.random()] = 1; });
    return {
      stable: useDouble ? buildDoubleStable(applied, legs) : buildStable(applied, legs),
      cold: useDouble ? buildDoubleCold(applied, legs) : buildCold(applied, legs),
      analyzedN: Object.keys(matchKeys).length,
      usedModel: scored.some(function (x) { return x.usedModel; }),
      useDouble: useDouble,
      rulesApplied: applied.some(function (x) { return x.ruleApplied; }),
      appliedRuleIds: applied.reduce(function (acc, x) {
        (x.appliedRules || []).forEach(function (r) { if (acc.indexOf(r.id) < 0) acc.push(r.id); });
        return acc;
      }, [])
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

  // 竞彩销售日跨零点：今天在售的场次常在次日凌晨/白天开赛，必须把开赛时间摆在明面上
  function kickoffText(meta) {
    var d = (meta.date || '').slice(5);   // 2026-11-24 -> 11-24
    var t = (meta.time || '').slice(0, 5); // 02:00:00 -> 02:00
    if (d && t) return d + ' ' + t;
    return d || t || '';
  }

  function renderLegs(legs) {
    return '<ol class="parlay-legs">' + legs.map(function (x) {
      var evCls = x.ev >= 0 ? 'pos' : 'neg';
      var pick = (x.double ? '<span class="pl-double">双选</span> ' : '') + x.sideZh + ' @' + x.jc.toFixed(2);
      var kick = kickoffText(x.meta || {});
      var kickHtml = kick
        ? '<span class="pl-kick">' + esc(kick) + ' 开赛</span>'
        : '';
      // 玩法标签：竞彩所有可售玩法均标出来源，避免与胜平负混淆。
      // - 让球盘口（竞彩真实整数盘）单独显示盘口值；
      // - 其余玩法（总进球/比分/半全场）显示玩法名。
      var marketHtml = '';
      if (x.meta && x.meta.market && x.meta.market !== 'HAD') {
        if (x.meta.market === 'HHAD') {
          marketHtml = '<span class="pl-market" title="竞彩让球胜平负，盘口 ' + esc(String(x.meta.line)) + '">让球' + esc(String(x.meta.line)) + '</span>';
        } else {
          marketHtml = '<span class="pl-market" title="竞彩' + esc(x.meta.marketLabel || x.meta.market) + '">' + esc(x.meta.marketLabel || x.meta.market) + '</span>';
        }
      }
      var tags = (x.ruleTags && x.ruleTags.length)
        ? '<div class="pl-rule-tags" style="font-size:11px;color:var(--color-text-secondary);margin-top:3px;">' +
          x.ruleTags.map(function (t) { return '<span title="历史回放规则修正">· ' + esc(t) + '</span>'; }).join(' ') + '</div>'
        : '';
      return '<li><span class="pl-teams">' + marketHtml + esc((x.meta.zhHome || '') + ' vs ' + (x.meta.zhAway || '')) + kickHtml +
        '</span><span class="pl-pick">' + pick +
        '</span><span class="pl-prob">' + (x.prob * 100).toFixed(1) + '%</span>' +
        '<span class="pl-ev ' + evCls + '">' + (x.ev >= 0 ? '+' : '') + (x.ev * 100).toFixed(1) + 'pp</span>' + tags + '</li>';
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
      ? '今日在售 ' + rec.analyzedN + ' 场（销售日 10:00~次日10:00 开赛，已标时间）'
      : '基于 ' + rec.analyzedN + ' 场历史回测（不可购买）';
    var modelLabel = rec.usedModel ? 'P8 模型（2159 场历史校准）' : '竞彩去抽水隐含概率';
    var demoBanner = info.fallback
      ? '<div class="parlay-demo-banner">⚠️ 演示数据：当前无当日可购买场次或赔率暂不可读，以下为 <b>' + rec.analyzedN + ' 场历史回测样本</b>，<b>非当日真实推荐、不可下单</b>，仅供模型与界面演示。接入竞彩实时数据后自动切换为当日串关。</div>'
      : '';
    container.innerHTML =
      demoBanner +
      '<div class="patterns-head">AI 串关推荐 · ' + srcLabel + ' · ' + modelLabel + ' · 双策略（市场有效，组合 EV 多为负，仅作风险/回报取舍参考）</div>' +
      '<div class="parlay-row">' + renderCard(rec.stable) + renderCard(rec.cold) + '</div>' +
      '推荐口径：只纳入开赛时间落在竞彩销售日「今日 10:00 ~ 次日 10:00」内的在售场次，跨到下一销售日的场次不纳入；' +
      '竞彩所有可售玩法（胜平负/让球胜平负/总进球/比分/半全场）均可作为推荐项，每场按模型命中概率择优取一个玩法，避免同场重复下注；' +
      '各玩法概率由同一方向基底以泊松模型一致派生，让球按竞彩真实整数盘口计算；未开胜平负的场次改用其在售玩法（如让球/总进球/比分/半全场）推荐，反推赔率不作为可买项。' +
      '高抽水玩法（总进球约25%/半全场约25%/比分约46%）EV 天然偏低，冷门型策略会自动少选，请留意；推荐腿已标注玩法与开赛时间，均可在今天下单。' +
      '组合 EV = 组合模型概率 ×(组合赔率−1) −(1−组合概率)，竞彩串关赔率为各腿相乘。' +
      '因多次抽水叠加，组合 EV 通常为负；「稳妥型」主打高命中、「冷门型」主打高回报，均为风险偏好选择，不构成必胜建议。' +
      (info.isCurrent && !rec.usedModel ? '（当前比赛未接入国际均价，概率取自竞彩去抽水隐含值；开启国际赔率采集后自动升级为 P8 模型。）' : '') +
      '</div>';
  }

  function renderParlayPanel(container, legs, matches, opts) {
    if (!container) return;
    legs = legs || 3;

    // 1) 当日可购买场次优先（status=Selling 且赔率可读）→ 只展示能下单的串关
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

    // 2) 无当日可购买场次 → 如实空态，不自动拿历史比赛凑数。
    //    历史回测演示改为用户显式点击才加载，且明确标注不可下单。
    renderNoLiveState(container, legs, opts);
  }

  function renderNoLiveState(container, legs, opts) {
    container.innerHTML = '<div class="empty-hint">' +
      '<b>暂无当日可购买的竞彩串关</b><br>' +
      '本面板只使用今日竞彩在售（Selling）、开赛时间落在销售日 10:00~次日10:00 内且赔率可读的场次，不用历史比赛凑数。<br>' +
      '<button type="button" class="parlay-hist-demo" style="margin-top:8px;padding:6px 12px;cursor:pointer;' +
      'background:var(--color-bg-elevated,rgba(255,255,255,.06));color:var(--color-text-primary);' +
      'border:1px solid var(--color-border);border-radius:8px;">查看历史回测演示（非当日推荐，不可下单）</button>' +
      '</div>';
    var btn = container.querySelector('.parlay-hist-demo');
    if (btn) btn.addEventListener('click', function () { renderParlayFallback(container, legs, opts); });
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
    isPurchasable: isPurchasable, salesWindow: salesWindow, inSalesWindow: inSalesWindow,
    handicapProbs: handicapProbs, pickMarketPerMatch: pickMarketPerMatch,
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
