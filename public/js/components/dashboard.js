/**
 * dashboard.js — 数据看板组件
 * 竞彩智选 Pro · 模块化版
 * 依赖：utils.js (esc/deVigOdds)、predictor.js (eloPredict)、CONFIG
 */

/* 依赖解析：浏览器用全局，Node 用 require */
let esc, deVigOdds, eloPredict;
if (typeof window !== 'undefined' && window.esc) {
  esc = window.esc; deVigOdds = window.deVigOdds; eloPredict = window.eloPredict;
} else {
  const utils = require('../core/utils.js');
  const predictor = require('../engine/predictor.js');
  esc = utils.esc; deVigOdds = utils.deVigOdds; eloPredict = predictor.eloPredict;
}

/* ============================================
   渲染数据看板
   ============================================ */
function renderDashboard(matches) {
  const list = matches || [];

  // KPI 统计
  setText('kpiTotal', list.length);
  setText('totalCount', list.length);
  setText('matchCountBadge', list.length + ' 场');
  const highCount = list.filter(m => m.isFeatured || m.featured).length;
  setText('kpiHigh', highCount);
  const chgCount = list.filter(m => m.oddsChanged).length;
  setText('kpiChanges', chgCount);
  setText('kpiFeatured', list.filter(m => m.isDerby).length);

  const ml = document.getElementById('matchList');
  if (!ml) return;

  if (!list.length) {
    ml.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px;">暂无比赛数据，点击刷新</div>';
    return;
  }

  ml.innerHTML = list.map((m, idx) => {
    const h = m.homeTeam || m.homeName || '主队';
    const a = m.awayTeam || m.awayName || '客队';
    const odds = m.odds || {};

    // AI 概率：优先用赔率反推，无赔率用 Elo
    let probs;
    if (odds.h && odds.h > 1) {
      const p = deVigOdds(odds.h, odds.d || 3.3, odds.a || 3.4);
      probs = { homeWin: p.pH * 100, draw: p.pD * 100, awayWin: p.pA * 100 };
    } else {
      probs = eloPredict(1600, 1500);
    }
    const conf = Math.max(probs.homeWin, probs.draw, probs.awayWin);

    const oddsHtml = odds.h ? `
      <span class="odds-t" style="color:var(--c-red);">${odds.h.toFixed(2)}</span>
      <span class="odds-t" style="color:var(--c-amber);">${(odds.d||0).toFixed(2)}</span>
      <span class="odds-t" style="color:var(--c-green);">${(odds.a||0).toFixed(2)}</span>` : '暂无赔率';

    return `
    <div class="match-item" onclick="openAnalysisDetail(${idx})" data-match-idx="${idx}">
      <div class="match-league-info">
        <div class="league-tag"><span class="dot" style="background:var(--c-blue);"></span>${esc(m.league || '')}</div>
        <div class="match-code" style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${esc(m.code || '')}</div>
      </div>
      <div class="match-teams">
        <div class="team-names" style="font-weight:600;">${esc(h)} <span style="color:var(--text-muted);font-weight:400;margin:0 4px;">vs</span> ${esc(a)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${esc(m.time || m.date || '')}</div>
      </div>
      <div class="match-odds" style="display:flex;gap:8px;font-family:var(--font-mono);font-size:13px;">
        ${oddsHtml}
      </div>
      <div class="match-conf" style="text-align:center;">
        <span class="badge ${conf >= 65 ? 'badge-green' : conf >= 50 ? 'badge-amber' : 'badge-blue'}" style="font-size:12px;">${conf.toFixed(0)}%</span>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">置信度</div>
      </div>
    </div>`;
  }).join('');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ============================================
   导出
   ============================================ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderDashboard };
}
if (typeof window !== 'undefined') {
  window.renderDashboard = renderDashboard;
}
