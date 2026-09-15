/**
 * oddsAlert.js — 赔率异动监控与提醒（P6）
 * 竞彩智选 Pro · 数据分析系统
 *
 * 定位（用户最早诉求 + 硬约束）：
 *   国内/国外发生赔率异动时，第一时间触发提醒；且提醒必须能辅助下单，
 *   不能只喊"有异动"。因此本模块在检测到异动后，会与 P3 趋势 / P4 热度
 *   做交叉验证，给出「流入/流出 + 顺势关注 / 反手回避 / 警惕诱盘」的可执行建议。
 *
 * 三件套职责：
 *   1) detectMovements(series, opts)      —— 单场：扫描全部快照的异动 + 下建议（挂赔率监测页卡片）
 *   2) detectFromOdds(prev, cur, opts)    —— 轮询点：用前后两次赔率直接判定异动（零额外 IO，用于全局 toast）
 *   3) scanAll(seriesMap, opts)           —— 全市场：扫描所有比赛的最近异动（提醒中心）
 *   4) 渲染 + 提醒通道：renderAlertCard / renderAlerts / showToast / notifyEmail(预留) / localStorage 日志
 *
 * 阈值：默认取 CONFIG.thresholds.alertMove（0.05 = 5 个隐含概率点）。
 * 依赖：纯函数 + DOM（浏览器）；Node 下仅跑分析逻辑（无 DOM 分支）。
 */
(function (global) {
  'use strict';

  const SIDES = ['h', 'd', 'a'];
  const ZH = { h: '主胜', d: '平局', a: '客胜' };
  const EPS = 0.005; // 0.5 个概率点判定阈值

  /* ---------- 小工具 ---------- */
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function r1(x) { return Math.round(x * 1000) / 1000; }
  function pct(x) { return Math.round(x * 1000) / 10; }      // 概率 -> 百分比(保留 1 位)
  function sign(x) { return x > EPS ? 1 : x < -EPS ? -1 : 0; }

  function impliedOf(snap) { return snap && snap.implied && snap.implied.jc ? snap.implied.jc : null; }
  function oddsOf(snap) { return snap && snap.jc ? snap.jc : null; }

  function thresholdFrom(opts) {
    if (opts && typeof opts.threshold === 'number') return opts.threshold;
    if (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.thresholds) return CONFIG.thresholds.alertMove;
    return 0.05;
  }

  /* 赔率 -> 去水隐含概率 */
  function oddsToImplied(o) {
    if (!o || !o.h || !o.d || !o.a) return null;
    const s = 1 / o.h + 1 / o.d + 1 / o.a;
    if (!s) return null;
    return { h: (1 / o.h) / s, d: (1 / o.d) / s, a: (1 / o.a) / s };
  }

  /* 两个快照之间的单边变化 */
  function stepDelta(prev, cur) {
    const pj = impliedOf(prev), cj = impliedOf(cur);
    const po = oddsOf(prev), co = oddsOf(cur);
    if (!pj || !cj || !po || !co) return null;
    const out = {};
    SIDES.forEach(side => {
      const impDeltaPp = pct(cj[side] - pj[side]);                       // 隐含概率变化(百分点)
      const oddsDeltaPct = po[side] ? Math.round(((co[side] - po[side]) / po[side]) * 1000) / 10 : 0;
      out[side] = {
        impDeltaPp: impDeltaPp,
        oddsDeltaPct: oddsDeltaPct,
        fromOdds: po[side], toOdds: co[side],
        fromImp: pj[side], toImp: cj[side]
      };
    });
    return out;
  }

  /* 是否构成异动（用隐含概率变化幅度判定，赔率变动只是展示用） */
  function isMove(d, threshold) { return Math.abs(d.impDeltaPp) >= threshold * 100; }

  /* 从前后两次赔率直接判定异动（轮询点用，零额外 IO） */
  function detectFromOdds(prevOdds, curOdds, opts) {
    if (!prevOdds || !curOdds) return null;
    const pj = oddsToImplied(prevOdds), cj = oddsToImplied(curOdds);
    if (!pj || !cj) return null;
    const threshold = thresholdFrom(opts);
    let picked = null;
    SIDES.forEach(side => {
      const impDeltaPp = pct(cj[side] - pj[side]);
      const oddsDeltaPct = prevOdds[side] ? Math.round(((curOdds[side] - prevOdds[side]) / prevOdds[side]) * 1000) / 10 : 0;
      if (isMove({ impDeltaPp: impDeltaPp }, threshold)) {
        if (!picked || Math.abs(impDeltaPp) > Math.abs(picked.impDeltaPp)) {
          picked = {
            side: side, sideZh: ZH[side],
            fromOdds: prevOdds[side], toOdds: curOdds[side],
            oddsDeltaPct: oddsDeltaPct, impDeltaPp: impDeltaPp,
            direction: impDeltaPp > 0 ? 'in' : 'out',   // in = 赔率降 = 资金流入
            fromTs: (opts && opts.fromTs) || 0, toTs: (opts && opts.toTs) || 0
          };
        }
      }
    });
    return picked;
  }

  /* ============================================================
     单场：扫描全部快照的异动 + 下建议
     ============================================================ */
  function detectMovements(series, opts) {
    opts = opts || {};
    const threshold = thresholdFrom(opts);
    const minPoints = opts.minPoints || 2;
    if (!series || series.length < minPoints) {
      return {
        insufficient: true, movements: [], latestBySide: {},
        advice: { action: 'watch', confidence: 0, headline: '样本不足（需要 ≥' + minPoints + ' 个快照）', reasons: ['打开本页后系统持续记录竞彩赔率，异动检测随记录自动生效。'], moves: [] },
        threshold: threshold, matchId: null, meta: {}
      };
    }
    const movements = [];
    for (let i = 1; i < series.length; i++) {
      const d = stepDelta(series[i - 1], series[i]);
      if (!d) continue;
      SIDES.forEach(side => {
        if (isMove(d[side], threshold)) {
          movements.push({
            side: side, sideZh: ZH[side],
            fromOdds: d[side].fromOdds, toOdds: d[side].toOdds,
            oddsDeltaPct: d[side].oddsDeltaPct,
            impDeltaPp: d[side].impDeltaPp,
            direction: d[side].impDeltaPp > 0 ? 'in' : 'out',
            fromTs: series[i - 1].ts, toTs: series[i].ts
          });
        }
      });
    }
    // 每个 side 取最近一条作为「当前异动」
    const latestBySide = {};
    movements.forEach(m => { if (!latestBySide[m.side] || m.toTs > latestBySide[m.side].toTs) latestBySide[m.side] = m; });

    const trendResult = opts.trendResult || null;
    const heatResult = opts.heatResult || null;
    const advice = buildAdvice(latestBySide, trendResult, heatResult, threshold);

    return {
      insufficient: false, movements: movements, latestBySide: latestBySide, advice: advice,
      threshold: threshold,
      matchId: (series[0] && series[0].matchId) || null,
      meta: (series[0] && series[0].meta) || {}
    };
  }

  /* 交叉验证 + 建议推导（第一公民仍是 advice） */
  function buildAdvice(latestBySide, trendResult, heatResult, threshold) {
    const moves = [];
    SIDES.forEach(side => { if (latestBySide[side]) moves.push(latestBySide[side]); });
    if (!moves.length) {
      return {
        action: 'watch', confidence: 0,
        headline: '当前无赔率异动',
        reasons: ['本场最近快照未触发异动阈值（' + (threshold * 100).toFixed(0) + 'pp），继续监控。'],
        moves: []
      };
    }
    moves.sort((a, b) => Math.abs(b.impDeltaPp) - Math.abs(a.impDeltaPp));
    const top = moves[0];
    const dirZh = top.sideZh;
    const dirIn = top.direction === 'in';

    const trendMap = {}; if (trendResult && trendResult.advice && trendResult.advice.perSide) trendResult.advice.perSide.forEach(p => { trendMap[p.side] = p; });
    const heatMap = {}; if (heatResult && heatResult.advice && heatResult.advice.perSide) heatResult.advice.perSide.forEach(p => { heatMap[p.side] = p; });
    const topTrend = trendMap[top.side];
    const topHeat = heatMap[top.side];

    const reasons = [];
    let action = 'watch', conf = 0.3;

    if (dirIn) {
      // 资金流入：赔率被压低
      const smartConfirmed = topHeat && topHeat.smartConfirmed;
      const retailOnly = topHeat && topHeat.retailOnly;
      const trap = topTrend && topTrend.divergence && topTrend.valueScore < 0;
      if (trap) {
        action = 'fade'; conf = 0.45;
        reasons.push(dirZh + '赔率被压低（资金流入 ' + Math.abs(top.impDeltaPp).toFixed(1) + 'pp），但 P3 背离显示「竞彩推/国际撤」疑似诱盘 → 反手或回避。');
      } else if (retailOnly && !smartConfirmed) {
        action = 'caution'; conf = 0.35;
        reasons.push(dirZh + '竞彩端单独压低（散户/跟单流入 ' + Math.abs(top.impDeltaPp).toFixed(1) + 'pp），机构未确认 → 警惕追热。');
      } else if (smartConfirmed || (topTrend && topTrend.valueScore >= 0.03)) {
        action = 'follow'; conf = clamp(0.45 + Math.abs(top.impDeltaPp) / 100, 0.45, 0.85);
        reasons.push('机构/聪明钱与竞彩同步压低' + dirZh + '（' + Math.abs(top.impDeltaPp).toFixed(1) + 'pp），资金一致流入 → 顺势关注。');
      } else {
        action = 'watch'; conf = 0.3;
        reasons.push(dirZh + '赔率异动压低（' + Math.abs(top.impDeltaPp).toFixed(1) + 'pp），但机构未明确确认，先观望。');
      }
    } else {
      // 资金流出：赔率上升、隐含概率下降
      action = 'fade'; conf = 0.4;
      reasons.push(dirZh + '赔率上升（资金流出 ' + Math.abs(top.impDeltaPp).toFixed(1) + 'pp），市场正在撤离该方向 → 谨慎或反手。');
    }

    // 若 P3 在该方向有明确价值(买)，流入是强化信号
    if (topTrend && topTrend.action === 'buy' && dirIn) {
      action = 'follow'; conf = Math.max(conf, 0.6);
      reasons.push('P3 该方向本就有价值窗口，异动流入强化信号。');
    }

    if (moves.length > 1) {
      const others = moves.slice(1).map(m => m.sideZh + (m.direction === 'in' ? '流入' : '流出') + Math.abs(m.impDeltaPp).toFixed(1) + 'pp').join('，');
      reasons.push('其余异动：' + others + '。');
    }

    const actionText = { follow: '顺势关注', fade: '反手/回避', caution: '警惕诱盘', watch: '观望' }[action];
    const headline = action === 'follow' ? '⚡ ' + dirZh + '异动：资金一致流入，顺势关注'
      : action === 'fade' ? '⚡ ' + dirZh + '异动：' + (dirIn ? '疑似诱盘，反手/回避' : '资金撤离，谨慎')
        : action === 'caution' ? '⚡ ' + dirZh + '异动：散户单热，警惕追热'
          : '⚡ ' + dirZh + '异动（' + (dirIn ? '流入' : '流出') + '）但机构未确认，观望';

    return { action: action, confidence: Math.round(conf * 100) / 100, headline: headline, reasons: reasons, moves: moves };
  }

  /* ============================================================
     全市场：扫描所有比赛的最近异动（提醒中心）
     ============================================================ */
  function scanAll(matchSeriesMap, opts) {
    opts = opts || {};
    const threshold = thresholdFrom(opts);
    const windowMs = opts.windowMs || (10 * 60 * 1000); // 最近 10 分钟内的异动
    const now = Date.now();
    const items = [];
    Object.keys(matchSeriesMap || {}).forEach(matchId => {
      const series = matchSeriesMap[matchId];
      if (!series || series.length < 2) return;
      const recent = series.filter(s => s.ts >= now - windowMs);
      const det = detectMovements(recent.length >= 2 ? recent : series, { threshold: threshold });
      if (det.movements.length) {
        items.push({
          matchId: matchId, meta: det.meta,
          movements: det.movements, advice: det.advice,
          threshold: threshold, latestTs: det.movements[det.movements.length - 1].toTs
        });
      }
    });
    items.sort((a, b) => (b.latestTs || 0) - (a.latestTs || 0));
    return { items: items, threshold: threshold, windowMs: windowMs };
  }

  /* ============================================================
     渲染：当前场异动卡片（挂赔率监测页）
     ============================================================ */
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function actionBadge(a) {
    const map = {
      follow: ['st-value', '顺势关注'], 'follow_small': ['st-normal', '小注跟随'],
      caution: ['st-risk', '警惕诱盘'], fade: ['st-risk', '反手/回避'], watch: ['st-normal', '观望']
    };
    const m = map[a] || ['st-normal', '观望'];
    return '<span class="status-tag ' + m[0] + '">' + m[1] + '</span>';
  }
  function dirWord(d) { return d === 'in' ? '资金流入' : '资金流出'; }

  function renderAlertCard(container, detResult) {
    if (!container) return;
    if (!detResult) { container.innerHTML = ''; return; }
    if (detResult.insufficient) {
      container.innerHTML = `
      <div class="card" style="margin-top:16px;border-left:3px solid var(--c-amber);">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px;">🚨 赔率异动监控</div>
        <div style="font-size:12px;color:var(--text-muted);">${esc(detResult.advice.headline)}。</div>
      </div>`;
      return;
    }
    const adv = detResult.advice;
    const cls = adv.action === 'follow' ? 'st-value' : adv.action === 'fade' || adv.action === 'caution' ? 'st-risk' : 'st-normal';
    const lines = adv.moves.map(m => `
      <tr>
        <td style="font-weight:600;">${m.sideZh}</td>
        <td class="odds-t">${m.fromOdds.toFixed(2)} → ${m.toOdds.toFixed(2)}</td>
        <td class="odds-t ${m.direction === 'in' ? 'low' : ''}">${m.direction === 'in' ? '↓' : '↑'} ${Math.abs(m.oddsDeltaPct).toFixed(1)}%</td>
        <td class="odds-t ${m.direction === 'in' ? 'low' : ''}">${m.direction === 'in' ? '+' : ''}${m.impDeltaPp.toFixed(1)}pp</td>
        <td><span class="status-tag ${m.direction === 'in' ? 'st-value' : 'st-risk'}">${dirWord(m.direction)}</span></td>
      </tr>`).join('');
    const reasons = adv.reasons.map(r => '<li style="margin-bottom:4px;">' + esc(r) + '</li>').join('');
    container.innerHTML = `
      <div class="card" style="margin-top:16px;border-left:4px solid var(--${cls === 'st-value' ? 'c-green' : cls === 'st-risk' ? 'c-red' : 'c-amber'});">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
          <div style="font-size:15px;font-weight:700;">🚨 赔率异动监控 · 提醒</div>
          <span class="badge badge-blue">阈值 ${ (detResult.threshold * 100).toFixed(0) }pp</span>
        </div>
        <div style="background:var(--bg-elevated);border-radius:12px;padding:12px 14px;margin-bottom:12px;">
          <div style="font-size:14px;font-weight:700;color:var(--${cls === 'st-value' ? 'c-green' : cls === 'st-risk' ? 'c-red' : 'c-amber'});">${esc(adv.headline)}</div>
          <ul style="margin:8px 0 0 18px;font-size:12.5px;color:var(--text);line-height:1.6;">${reasons}</ul>
        </div>
        <table class="table">
          <thead><tr><th>方向</th><th>赔率变化</th><th>赔率%</th><th>隐含Δ</th><th>方向</th></tr></thead>
          <tbody>${lines}</tbody>
        </table>
        <div style="font-size:10.5px;color:var(--text-muted);margin-top:8px;">异动 = 相邻快照隐含概率变化 ≥ 阈值；已与 P3 趋势 / P4 热度交叉验证。提醒仅作辅助，竞彩固定抽水约 12.9%。</div>
      </div>`;
  }

  /* ============================================================
     渲染：全市场提醒中心（扫描所有比赛）
     ============================================================ */
  function renderAlerts(container, scanResult) {
    if (!container) return;
    if (!scanResult) { container.innerHTML = ''; return; }
    const items = scanResult.items || [];
    if (!items.length) {
      container.innerHTML = `
      <div class="card" style="margin-top:16px;border-left:3px solid var(--c-green);">
        <div style="font-size:15px;font-weight:700;margin-bottom:8px;">📡 异动提醒中心</div>
        <div class="alert-empty">最近 ${ Math.round(scanResult.windowMs / 60000) } 分钟内无赔率异动（阈值 ${ (scanResult.threshold * 100).toFixed(0) }pp）。系统正在持续监控所有已记录比赛。</div>
      </div>`;
      return;
    }
    const cards = items.map(it => {
      const meta = it.meta || {};
      const label = (meta.homeTeam || '') + ' vs ' + (meta.awayTeam || '') + (meta.league ? ' · ' + meta.league : '');
      const mv = it.movements.map(m => '<span class="alert-tag ' + (m.direction === 'in' ? 'in' : 'out') + '">' + m.sideZh + ' ' + dirWord(m.direction) + ' ' + Math.abs(m.impDeltaPp).toFixed(1) + 'pp</span>').join('');
      const when = it.latestTs ? new Date(it.latestTs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      return `<div class="alert-item">
        <div class="ai-head"><span class="ai-label">${esc(label)}</span><span class="ai-time">${esc(when)}</span></div>
        <div class="ai-tags">${mv}</div>
        <div class="ai-advice">${esc(it.advice.headline)} ${actionBadge(it.advice.action)}</div>
      </div>`;
    }).join('');
    container.innerHTML = `
      <div class="card" style="margin-top:16px;border-left:4px solid var(--c-red);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
          <div style="font-size:15px;font-weight:700;">📡 异动提醒中心（${items.length} 场）</div>
          <span class="badge badge-blue">最近 ${ Math.round(scanResult.windowMs / 60000) } 分钟 · 阈值 ${ (scanResult.threshold * 100).toFixed(0) }pp</span>
        </div>
        <div class="alert-list">${cards}</div>
      </div>`;
  }

  /* ============================================================
     提醒通道：站内 toast + 邮件接口(预留) + 本地日志
     ============================================================ */
  function ensureToastRoot() {
    if (typeof document === 'undefined') return null;
    let root = document.getElementById('toastContainer');
    return root; // 复用 app.js 的 toastContainer，保持统一视觉
  }

  /**
   * 站内 toast：第一时间提醒。
   * @param {Object} o { matchLabel, sideZh, direction, impDeltaPp, action, headline, body, ttl }
   */
  function showToast(o) {
    o = o || {};
    if (typeof document === 'undefined') return;
    const root = ensureToastRoot();
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast alert-toast';
    const actionCls = { follow: 'st-value', fade: 'st-risk', caution: 'st-risk', watch: 'st-normal' }[o.action] || 'st-normal';
    const actionText = { follow: '顺势关注', fade: '反手/回避', caution: '警惕诱盘', watch: '观望' }[o.action] || '观望';
    el.innerHTML =
      '<div class="at-head">⚡ 赔率异动提醒</div>' +
      (o.matchLabel ? '<div class="at-sub">' + esc(o.matchLabel) + '</div>' : '') +
      '<div class="at-body">' + esc(o.body || '') + '</div>' +
      '<div class="at-foot"><span class="status-tag ' + actionCls + '">' + actionText + '</span>' +
      '<button class="at-close" aria-label="关闭">×</button></div>';
    root.appendChild(el);
    setTimeout(function () {
      el.classList.add('toast-hide');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }, o.ttl || 9000);
    // 邮件接口（预留，默认不发送）
    notifyEmail({
      type: 'odds-movement', matchLabel: o.matchLabel, headline: o.headline || o.body,
      sideZh: o.sideZh, direction: o.direction, impDeltaPp: o.impDeltaPp, action: o.action, ts: Date.now()
    });
  }

  /* 邮件接口：默认仅记录不发送；真实接入时通过 setEmailHook 挂函数 */
  let _emailHook = null;
  function setEmailHook(fn) { _emailHook = (typeof fn === 'function') ? fn : null; }
  function notifyEmail(alert) {
    if (_emailHook) { try { return _emailHook(alert); } catch (e) { /* ignore */ } }
    if (typeof console !== 'undefined') console.info('[OddsAlert] 邮件提醒(预留未启用):', alert && (alert.headline || alert.body));
    return false;
  }

  /* 本地日志（提醒中心历史，可选） */
  const LS_KEY = 'jc_alert_log';
  function logAlert(a) {
    try {
      const log = getLog();
      log.unshift(a);
      if (log.length > 100) log.length = 100;
      localStorage.setItem(LS_KEY, JSON.stringify(log));
    } catch (e) { /* 存储不可用忽略 */ }
  }
  function getLog() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { return []; } }
  function clearLog() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }

  const api = {
    detectMovements: detectMovements,
    detectFromOdds: detectFromOdds,
    scanAll: scanAll,
    buildAdvice: buildAdvice,
    renderAlertCard: renderAlertCard,
    renderAlerts: renderAlerts,
    showToast: showToast,
    notifyEmail: notifyEmail,
    setEmailHook: setEmailHook,
    logAlert: logAlert,
    getLog: getLog,
    clearLog: clearLog
  };
  if (typeof window !== 'undefined') window.OddsAlert = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})(typeof window !== 'undefined' ? window : this);
