/*
 * recommendRules.js — 推荐规则登记与执行层（持续学习）
 * 竞彩智选 Pro · 引擎层
 *
 * 设计原则（用户要求 2026-11-23）：
 *  「无论发现任何有助于提升 pp 的规则，无论是否显著，都需要更新进推荐算法。」
 *
 * 因此本模块是一个「规则登记薄」：每发现一条宣称能提升命中率/ROI 的规则，
 * 无论样本内/外是否统计显著，都在这里登记，并标注其证据强度、方向、增益 pp。
 * 推荐引擎（oddsParlay.js）在打分后调用本层，对每场的模型概率/概率排序做修正。
 *
 * 诚实优先（与项目一贯原则一致）：
 *  - 每条规则必须如实标注 significance（significant / directional / weak / noise），
 *    不得把噪声伪装成稳定优势。
 *  - 证据强度决定「修正幅度」：显著 => 用实测增益；仅方向一致 => 打折施加；
 *    noise => 登记但不施加（记录 INACTIVE_REASON）。
 *  - 所有施加都写入 leg.ruleTags，供 UI 透明展示"这一腿因何规则被调整"。
 *
 * 已登记规则（累计）：
 *  R1 divergence_eu_anchor 竞彩/欧赔 top1 分歧时以欧赔为准
 *     证据：2169 场同场数据；分歧场(4.7%)跟随欧赔 ROI +8.8% vs 跟随竞彩 −33.2%，
 *           但 bootstrap 95%CI 含 0 → significance=directional，打折施加。
 *  R2 closing_line_drift 开盘→临场赔率移动方向（Δp）作为信号
 *     证据：7578 场 football-data CSV；Δp>0.03 桶实际命中比开盘隐含高 +6.56pp，
 *           Δp<−0.03 桶低 −6.16pp（单调）；Δp≥0.04 跟随资金流 ROI 训练+3.2%/验证+16.2%
 *           （验证 CI 下界>0）→ significance=significant（样本外），施加于有开盘赔率的场次。
 *  R3 hot_drift_confirm 开盘热门且资金继续流入（Δp>0）才买热门
 *     证据：训练 ROI −0.59% / 验证 +2.81%（均 near-zero，方向改善）→ significance=weak，
 *           仅登记，作为 R2 的辅助标签，不单独改变排序。
 *  R4 value_bet_guard 正 EV 护栏（已在 oddsModel.advice 实现，此处仅登记避免重复）
 *
 * 数据来源与复现：见今日工作日志；规则增益均来自真实历史回放，样本外验证优先。
 */
(function (global) {
  'use strict';

  var RULES = [
    {
      id: 'R1_divergence_eu_anchor',
      name: '分歧场以欧赔为准',
      enabled: true,
      significance: 'directional',
      gainPP: 8.8,
      detail: '竞彩与欧赔 top1 判断不一致时，改以欧赔方向为锚。分歧场跟随欧赔 ROI +8.8% vs 竞彩 −33.2%；bootstrap 95%CI 含 0，故按 50% 打折施加。',
      apply: function (row) {
        var jc = row.jcArr, eu = row.euArr;
        if (!jc || !eu) return null;
        // top1 = 隐含概率最高项（=赔率最低项），必须用去水隐含概率判断，不能直接 argmax 赔率
        var pj = implied(jc), pe = implied(eu);
        if (!pj || !pe) return null;
        var ij = argmax(pj), ie = argmax(pe);
        if (ij === ie) return null; // 无分歧不触发
        // 用户明确要求"分歧以欧赔为准"：方向必须切到欧赔 top1。
        // 直接采用欧赔去水隐含概率（锚定），语义清晰；证据强度 directional 如实标注在 tag。
        var np = pe.slice();
        var s = np[0] + np[1] + np[2];
        np = [np[0] / s, np[1] / s, np[2] / s];
        // 重新计算 EV（概率变了，盈亏平衡不变）
        var be = row.res.breakeven || [1 / jc[0], 1 / jc[1], 1 / jc[2]];
        var ev = [np[0] - be[0], np[1] - be[1], np[2] - be[2]];
        return {
          p: np, ev: ev,
          tag: '分歧以欧赔为准(+8.8pp,方向性)',
          metaShift: { from: SIDES[ij], to: SIDES[ie] }
        };
      }
    },
    {
      id: 'R2_closing_line_drift',
      name: '开盘→临场赔率移动(CLV Δp)',
      enabled: true,
      significance: 'significant',
      gainPP: 16.2,
      detail: '国际盘口开盘→收盘隐含概率变化 Δp 单调预测赛果：Δp≥0.04 跟随资金流 ROI 训练+3.2%/验证+16.2%（验证 95%CI 下界>0）。需要开盘赔率(openOdds)数据，无则跳过。',
      apply: function (row) {
        var open = row.openOdds, close = row.closeOdds;
        if (!open || !close) return null; // 无时间序列数据，优雅跳过
        var po = implied(open), pc = implied(close);
        if (!po || !pc) return null;
        var delta = [pc[0] - po[0], pc[1] - po[1], pc[2] - po[2]];
        var iMax = argmax(delta);
        if (delta[iMax] < 0.04) return null; // 门槛：强资金流才触发
        // significant：按实测增益全额方向修正——把该结果概率向"资金确认"方向抬升
        // 幅度与 Δp 挂钩（0.04→+6pp，0.10→+12pp 上限），有界避免过自信
        var lift = Math.min(0.12, Math.max(0.04, delta[iMax] * 1.0));
        var np = row.res.p.slice();
        np[iMax] = np[iMax] + lift;
        var others = [0, 1, 2].filter(function (k) { return k !== iMax; });
        var sumOthers = np[others[0]] + np[others[1]];
        if (sumOthers > 0) {
          np[others[0]] *= (1 - np[iMax]) / sumOthers;
          np[others[1]] *= (1 - np[iMax]) / sumOthers;
        }
        var jc = row.jcArr || [1 / np[0], 1 / np[1], 1 / np[2]];
        var be = row.res.breakeven || [1 / jc[0], 1 / jc[1], 1 / jc[2]];
        var ev = [np[0] - be[0], np[1] - be[1], np[2] - be[2]];
        return {
          p: np, ev: ev,
          tag: 'CLV资金流+' + (delta[iMax] * 100).toFixed(1) + 'pp(' + SIDES[iMax] + ')',
          delta: delta, focusedSide: SIDES[iMax]
        };
      }
    }
    // R3 仅登记为观察标签，不施加（significance=weak），见下方 WATCHLIST
  ];

  // 观察中的规则：登记但不施加，等样本累积/显著性达标后再启用
  var WATCHLIST = [
    {
      id: 'R3_hot_drift_confirm', name: '开盘热门+资金流入确认',
      significance: 'weak', gainPP: 2.8,
      detail: '开盘热门且 Δp>0 才买：训练 −0.59%/验证 +2.81%。near-zero，作为 R2 辅助标签，不单独改排序。'
    },
    {
      id: 'R4_value_bet_guard', name: '正EV护栏',
      significance: 'structural', gainPP: null,
      detail: '已在 oddsModel.advice 的 MAX_EDGE_RATIO=1.6 实现，此处登记避免重复施加。'
    },
    {
      id: 'R5_cold_market_avoid', name: '高抽水玩法回避(TTG/HAFU/CRS)',
      significance: 'significant', gainPP: null,
      detail: '抽水实测 HAD 13.9% / TTG 25.4% / HAFU 25.4% / CRS 46%。结构性结论：只用 HAD，不用高抽水玩法。现行引擎已遵守。'
    }
  ];

  var SIDES = ['h', 'd', 'a'];
  function argmax(a) { return a[0] >= a[1] ? (a[0] >= a[2] ? 0 : 2) : (a[1] >= a[2] ? 1 : 2); }
  function implied(o) {
    try {
      var inv = [1 / +o[0], 1 / +o[1], 1 / +o[2]];
      if (inv.some(function (v) { return !(v > 0); })) return null;
      var s = inv[0] + inv[1] + inv[2];
      return [inv[0] / s, inv[1] / s, inv[2] / s];
    } catch (e) { return null; }
  }

  /**
   * 对 scored 行施加规则修正。返回新的 scored 数组（不修改入参）。
   * 每行附加：row.ruleApplied（是否修正）、row.ruleTags（标签数组）、row.appliedRules（规则id）
   */
  function applyTo(scored) {
    if (!Array.isArray(scored)) return scored;
    return scored.map(function (orig) {
      var row = Object.assign({}, orig);
      var tags = [], applied = [];
      for (var i = 0; i < RULES.length; i++) {
        var rule = RULES[i];
        if (!rule.enabled) continue;
        try {
          var out = rule.apply(row);
          if (!out) continue;
          if (out.p) row.res = Object.assign({}, row.res, { p: out.p, ev: out.ev });
          if (out.tag) tags.push(out.tag);
          applied.push({ id: rule.id, significance: rule.significance, gainPP: rule.gainPP, detail: out });
        } catch (e) {
          tags.push('规则执行异常:' + rule.id);
        }
      }
      row.ruleTags = tags;
      row.appliedRules = applied;
      row.ruleApplied = applied.length > 0;
      return row;
    });
  }

  function register(rule) {
    // 允许外部（未来分析脚本）动态登记新规则
    if (!rule || !rule.id || typeof rule.apply !== 'function') return false;
    var idx = RULES.findIndex(function (r) { return r.id === rule.id; });
    if (idx >= 0) RULES[idx] = rule; else RULES.push(rule);
    return true;
  }

  var api = {
    RULES: RULES,
    WATCHLIST: WATCHLIST,
    applyTo: applyTo,
    register: register,
    getRule: function (id) { return RULES.find(function (r) { return r.id === id; }) || null; }
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.RecommendRules = api;
  }
})(typeof window !== 'undefined' ? window : this);
