/**
 * oddsTrend.js — 国内外赔率「偏差 / 背离 / 收敛」时序分析 + 下单建议
 * 竞彩智选 Pro · 数据分析系统 · P3
 *
 * 核心定位（用户硬约束）：
 *   所有分析必须落地成"可辅助下单的建议"，不能只给分析数字。
 *   因此 analyze() 的返回里第一公民是 advice —— 直接回答：
 *   "这场我该买哪边、为什么、置信度多高"。
 *
 * 输入：OddsHistory.getSeries(matchId) 返回的快照序列（按时间升序）。
 * 快照字段见 oddsHistory.js：{ ts, jc:{h,d,a}, intl:[...], implied:{ jc, intlAvg, sharp } }
 *
 * 三类规律：
 *   1) 偏差 Deviation   —— 当前竞彩隐含概率 与 国际参考(均值/Pinnacle) 的差。
 *                          负 = 竞彩比国际便宜 → 该方向有"价值边际"。
 *   2) 背离 Divergence  —— 竞彩与国际在一段时间内"反向移动"。
 *                          竞彩降赔(隐含↑) 而 国际升赔(隐含↓) = 竞彩在推、机构在撤 → 诱盘预警；
 *                          竞彩升赔(隐含↓) 而 国际降赔(隐含↑) = 机构在买、竞彩滞后 → 价值强化。
 *   3) 收敛 Convergence —— |偏差| 随时间缩小 = 市场逐步达成共识。
 *
 * 依赖：纯函数，浏览器/Node 同构（无外部依赖）。
 */
(function (global) {
  'use strict';

  const SIDES = ['h', 'd', 'a'];
  const ZH = { h: '主胜', d: '平局', a: '客胜' };
  const EPS = 0.005; // 0.5 个概率点，作为"有无变化"的判定阈值

  /* ---------- 小工具 ---------- */
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function r1(x) { return Math.round(x * 1000) / 1000; }   // 概率点保留 3 位
  function pct(x) { return Math.round(x * 1000) / 10; }     // 概率 -> 百分比(保留 1 位)
  function sign(x) { return x > EPS ? 1 : x < -EPS ? -1 : 0; }

  /* 解析某快照的"参考隐含概率"（默认国际均值，缺则退 Pinnacle） */
  function refOf(snap, refKey) {
    if (!snap || !snap.implied) return null;
    return snap.implied[refKey] || snap.implied.intlAvg || null;
  }

  /**
   * 单快照偏差（概率点）：竞彩 − 参考。
   * @returns {{h:number,d:number,a:number}|null}
   */
  function deviationAt(snap, refKey) {
    const jc = snap.implied && snap.implied.jc;
    const ref = refOf(snap, refKey);
    if (!jc || !ref) return null;
    return { h: r1(jc.h - ref.h), d: r1(jc.d - ref.d), a: r1(jc.a - ref.a) };
  }

  /**
   * 趋势：首条→最新条的隐含概率变化 + 背离 + 收敛判定。
   * 仅基于有效快照（同时有 jc 与 参考隐含）。
   */
  function trendOf(series, refKey) {
    const valid = series.filter(s => s.implied && s.implied.jc && refOf(s, refKey));
    if (valid.length < 2) return null;
    const first = valid[0], last = valid[valid.length - 1];
    const jcF = first.implied.jc, jcL = last.implied.jc;
    const rf = refOf(first, refKey), rl = refOf(last, refKey);

    const out = { refKey: refKey, jcDelta: {}, refDelta: {}, divergence: {}, convergence: {} };
    SIDES.forEach(side => {
      const jd = r1(jcL[side] - jcF[side]);
      const rd = r1(rl[side] - rf[side]);
      out.jcDelta[side] = jd;
      out.refDelta[side] = rd;
      const sj = sign(jd), sr = sign(rd);
      out.divergence[side] = (sj !== 0 && sr !== 0 && sj !== sr);

      // 收敛：比较首/末偏差绝对值
      const d0 = r1(jcF[side] - rf[side]);
      const d1 = r1(jcL[side] - rl[side]);
      if (Math.abs(d0) < EPS && Math.abs(d1) < EPS) out.convergence[side] = 'flat';
      else if (sign(d0) === sign(d1)) {
        if (Math.abs(d1) < Math.abs(d0) - EPS) out.convergence[side] = 'converging';
        else if (Math.abs(d1) > Math.abs(d0) + EPS) out.convergence[side] = 'diverging';
        else out.convergence[side] = 'flat';
      } else {
        out.convergence[side] = 'crossed'; // 偏差翻向，最强信号
      }
    });
    return out;
  }

  /* ============================================================
     主分析入口
     ============================================================ */
  /**
   * @param {Array} series  OddsHistory 快照序列（按 ts 升序）
   * @param {Object} [opts]
   *   refKey: 'intlAvg'(默认) | 'sharp'
   *   valueThreshold: 触发"建议买"的偏差阈值(概率点, 默认 0.03 = 3pt)
   *   minPoints: 最少有效快照数(默认 2)
   * @returns {Object} 含 deviation / trend / signals / advice
   */
  function analyze(series, opts) {
    opts = opts || {};
    const refKey = opts.refKey || 'intlAvg';
    const valueThreshold = typeof opts.valueThreshold === 'number' ? opts.valueThreshold : 0.03;
    const minPoints = opts.minPoints || 2;

    const valid = (series || []).filter(s => s.implied && s.implied.jc && refOf(s, refKey));
    const meta = (series && series[0] && series[0].meta) || {};

    if (valid.length < minPoints) {
      return {
        insufficient: true,
        points: valid.length,
        matchId: (series && series[0] && series[0].matchId) || null,
        meta: meta,
        advice: {
          hasValue: false, action: 'watch', confidence: 0,
          headline: '样本不足（需要 ≥' + minPoints + ' 个有效快照）',
          reasons: ['打开本页后系统会持续记录竞彩赔率；接入国际赔率将解锁偏差/背离分析。'],
          perSide: []
        }
      };
    }

    const latest = valid[valid.length - 1];
    const dev = deviationAt(latest, refKey);
    const trend = trendOf(series, refKey);

    // 逐边计算价值分
    const perSide = SIDES.map(side => {
      const d = dev[side];                 // 偏差（负=竞彩便宜=价值）
      const raw = -d;                       // 价值原始分（正=好）
      let bonus = 0;
      const conv = trend ? trend.convergence[side] : 'flat';
      const div = trend ? trend.divergence[side] : false;
      const refD = trend ? trend.refDelta[side] : 0;
      const jcD = trend ? trend.jcDelta[side] : 0;

      if (conv === 'converging' && d < 0) bonus += Math.min(Math.abs(raw), 0.05) * 0.5; // 偏差在有利方向收敛
      if (div && refD > 0 && jcD < 0) bonus += 0.03;   // 机构买、竞彩撤 → 价值强化
      if (div && refD < 0 && jcD > 0) bonus -= 0.04;   // 竞彩推、机构撤 → 诱盘惩罚

      let valueScore = clamp(raw + bonus, -0.15, 0.15);

      let action = 'avoid';
      if (valueScore >= valueThreshold) action = 'buy';
      else if (valueScore > 0) action = 'watch';

      const base = clamp(valueScore / 0.09, 0, 1);
      const sampleFactor = clamp((valid.length - 2) / 6, 0.5, 1);
      const conf = Math.round(clamp(base * sampleFactor, 0, 1) * 100) / 100;

      return {
        side: side, zh: ZH[side],
        devPts: pct(d),                      // 偏差(百分点)：负=竞彩便宜
        refImplied: pct(refOf(latest, refKey)[side]),
        jcImplied: pct(latest.implied.jc[side]),
        action: action, conf: conf, valueScore: r1(valueScore),
        convergence: conv, divergence: div
      };
    });

    // 最佳边
    perSide.sort((x, y) => y.valueScore - x.valueScore);
    const best = perSide[0];

    // 信号汇总
    const signals = [];
    SIDES.forEach(side => {
      const ps = perSide.find(p => p.side === side);
      if (ps.divergence) {
        signals.push({
          type: 'divergence', side: side, zh: ZH[side],
          severity: ps.valueScore >= valueThreshold ? 'high' : 'mid',
          detail: (trend.refDelta[side] > 0 ? '国际买入' : '国际撤出') + ' / 竞彩'
            + (trend.jcDelta[side] > 0 ? '推升' : '压低') + ' → 背离'
        });
      }
      if (ps.convergence === 'converging') {
        signals.push({ type: 'convergence', side: side, zh: ZH[side], severity: 'mid', detail: '偏差在收敛，市场趋于共识' });
      }
      if (ps.convergence === 'crossed') {
        signals.push({ type: 'convergence', side: side, zh: ZH[side], severity: 'high', detail: '偏差翻向，方向出现反转' });
      }
      if (Math.abs(ps.devPts) / 100 >= valueThreshold) {
        signals.push({ type: 'deviation', side: side, zh: ZH[side], severity: ps.devPts < 0 ? 'high' : 'mid', detail: '当前偏差 ' + ps.devPts.toFixed(1) + 'pt' });
      }
    });

    // 建议文案
    const reasons = [];
    const hasValue = best.valueScore >= valueThreshold;
    if (hasValue) {
      reasons.push('竞彩' + best.zh + '隐含 ' + best.jcImplied.toFixed(1) + '%，国际参考 ' + best.refImplied.toFixed(1)
        + '%，竞彩便宜 ' + Math.abs(best.devPts).toFixed(1) + ' 个点 → 价值窗口');
      const bConv = best.convergence, bDiv = best.divergence;
      if (bDiv) reasons.push('背离确认：国际' + (trend.refDelta[best.side] > 0 ? '持续买入' : '持续撤出') + '该方向，与价值方向一致');
      if (bConv === 'converging') reasons.push('偏差正在收敛，市场逐步认可该方向');
      if (bConv === 'crossed') reasons.push('偏差已翻向，该方向由贵转便宜，信号增强');
    } else if (best.valueScore > 0) {
      reasons.push('竞彩' + best.zh + '略便宜 ' + Math.abs(best.devPts).toFixed(1) + ' 个点，但未达阈值(' + (valueThreshold * 100).toFixed(0) + 'pt)，建议观望');
    } else {
      reasons.push('三方向竞彩均未显价值，或竞彩整体偏贵（国内抽水 12.9%）→ 不建议本场 1X2 价值投注');
    }
    // 诱盘反向提示
    const trap = perSide.find(p => p.divergence && p.valueScore < 0);
    if (trap) reasons.push('注意：' + trap.zh + '出现"竞彩推升、国际撤出"背离，疑似诱盘，规避');

    const action = hasValue ? 'buy' : (best.valueScore > 0 ? 'watch' : 'avoid');
    const headline = hasValue
      ? '建议重点关注：' + best.zh + '（竞彩便宜 ' + Math.abs(best.devPts).toFixed(1) + 'pt，置信 ' + (best.conf * 100).toFixed(0) + '%）'
      : (best.valueScore > 0 ? '可小注观望：' + best.zh : '本场无明确价值，建议回避');

    return {
      insufficient: false,
      points: valid.length,
      spanMs: latest.ts - valid[0].ts,
      matchId: latest.matchId,
      refKey: refKey,
      meta: meta,
      deviation: dev,                 // 最新快照偏差（概率点）
      latestImplied: { jc: latest.implied.jc, ref: refOf(latest, refKey) },
      trend: trend,
      signals: signals,
      advice: {
        hasValue: hasValue,
        bestSide: best.side, bestSideZh: best.zh,
        action: action,
        confidence: best.conf,
        headline: headline,
        reasons: reasons,
        perSide: perSide
      }
    };
  }

  /* ============================================================
     渲染：把分析+建议画成一个可嵌入的卡片（挂到赔率监测页）
     ============================================================ */
  function arrow(delta) {
    const s = sign(delta);
    return s > 0 ? '↑' : s < 0 ? '↓' : '→';
  }
  function convLabel(c) {
    return c === 'converging' ? '收敛中' : c === 'diverging' ? '发散中' : c === 'crossed' ? '已翻向' : '平稳';
  }
  function actionBadge(a) {
    if (a === 'buy') return '<span class="status-tag st-value">建议买</span>';
    if (a === 'watch') return '<span class="status-tag st-normal">观望</span>';
    return '<span class="status-tag st-risk">回避</span>';
  }

  /**
   * @param {HTMLElement|null} container
   * @param {Object} result  analyze() 返回值
   */
  function renderAdvice(container, result) {
    if (!container) return;
    if (!result) { container.innerHTML = ''; return; }
    if (result.insufficient) {
      container.innerHTML = `
      <div class="card" style="margin-top:16px;border-left:3px solid var(--c-amber);">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px;">📈 国内外赔率趋势分析</div>
        <div style="font-size:12px;color:var(--text-muted);">${esc(result.advice.headline)}。<br>${esc(result.advice.reasons[0] || '')}</div>
      </div>`;
      return;
    }

    const adv = result.advice;
    const refName = result.refKey === 'sharp' ? 'Pinnacle' : '国际均值';
    const rows = adv.perSide.map(p => `
      <tr>
        <td style="font-weight:600;">${p.zh}</td>
        <td class="odds-t">${p.jcImplied.toFixed(1)}%</td>
        <td class="odds-t">${p.refImplied.toFixed(1)}%</td>
        <td class="odds-t ${p.devPts < 0 ? 'low' : ''}">${p.devPts > 0 ? '+' : ''}${p.devPts.toFixed(1)}pt</td>
        <td class="odds-t">${arrow(result.trend ? result.trend.jcDelta[p.side] : 0)}竞/${arrow(result.trend ? result.trend.refDelta[p.side] : 0)}际</td>
        <td style="font-size:11px;color:var(--text-muted);">${convLabel(p.convergence)}${p.divergence ? ' · 背离' : ''}</td>
        <td>${actionBadge(p.action)}</td>
      </tr>`).join('');

    const reasons = adv.reasons.map(r => `<li style="margin-bottom:4px;">${esc(r)}</li>`).join('');

    const boxCls = adv.action === 'buy' ? 'st-value' : adv.action === 'watch' ? 'st-normal' : 'st-risk';
    container.innerHTML = `
      <div class="card" style="margin-top:16px;border-left:4px solid var(--${boxCls === 'st-value' ? 'c-green' : boxCls === 'st-risk' ? 'c-red' : 'c-amber'});">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
          <div style="font-size:15px;font-weight:700;">📈 国内外赔率趋势分析 · 下单建议</div>
          <span class="badge badge-blue">参考：${esc(refName)} · ${result.points} 个快照</span>
        </div>
        <div style="background:var(--bg-elevated);border-radius:12px;padding:12px 14px;margin-bottom:12px;">
          <div style="font-size:14px;font-weight:700;color:var(--${boxCls === 'st-value' ? 'c-green' : boxCls === 'st-risk' ? 'c-red' : 'c-amber'});">${esc(adv.headline)}</div>
          <ul style="margin:8px 0 0 18px;font-size:12.5px;color:var(--text);line-height:1.6;">${reasons}</ul>
        </div>
        <table class="table">
          <thead><tr><th>方向</th><th>竞彩隐含</th><th>${esc(refName)}隐含</th><th>偏差</th><th>趋势</th><th>形态</th><th>动作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="font-size:10.5px;color:var(--text-muted);margin-top:8px;">
          偏差 = 竞彩隐含 − ${esc(refName)}隐含（负=竞彩更便宜=价值）。置信度基于偏差幅度与样本量，仅供参考，非稳赚；竞彩固定抽水约 12.9%。
        </div>
      </div>`;
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  const api = { analyze: analyze, deviationAt: deviationAt, trendOf: trendOf, renderAdvice: renderAdvice };
  if (typeof window !== 'undefined') window.OddsTrend = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})(typeof window !== 'undefined' ? window : this);
