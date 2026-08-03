/**
 * analysis.js — 深度分析组件
 * 竞彩智选 Pro · 模块化版
 * 依赖：utils.js (esc/deVigOdds)、predictor.js (eloPredict)
 */

/* 依赖解析：浏览器用全局，Node 用 require */
let esc, deVigOdds;
if (typeof window !== 'undefined' && window.esc) {
  esc = window.esc; deVigOdds = window.deVigOdds;
} else {
  const utils = require('../core/utils.js');
  esc = utils.esc; deVigOdds = utils.deVigOdds;
}

/* 静态分析数据（示例） */
const ANALYSIS_STATIC = {
  factors: [
    { name: '近期状态', val: 0.92, color: 'var(--c-blue)' },
    { name: '主场优势', val: 0.85, color: 'var(--c-cyan)' },
    { name: '攻防能力', val: 0.78, color: 'var(--c-green)' },
    { name: '历史交锋', val: 0.65, color: 'var(--c-amber)' },
    { name: '战意评估', val: 0.60, color: 'var(--c-purple)' }
  ],
  metrics: [
    { label: '进球数', home: 1.9, away: 1.3 },
    { label: '失球数', home: 0.8, away: 1.1 },
    { label: '射门', home: 14, away: 11 },
    { label: '控球率', home: 58, away: 42 },
    { label: '角球', home: 6.2, away: 4.8 }
  ],
  h2h: [
    { date: '2026-05-15', event: '巴西杯', home: '米拉索尔', score: '2:1', away: '格雷米奥', result: 'W' },
    { date: '2025-11-03', event: '巴西杯', home: '格雷米奥', score: '1:1', away: '米拉索尔', result: 'D' },
    { date: '2025-08-20', event: '巴西杯', home: '米拉索尔', score: '0:2', away: '格雷米奥', result: 'L' }
  ]
};

/**
 * 渲染深度分析列表
 * @param {Array} matches 比赛列表
 */
function renderAnalysisList(matches, onSelect) {
  const listEl = document.getElementById('analysisList');
  if (!listEl) return;

  if (!matches.length) {
    listEl.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:30px;">暂无比赛数据</div>';
    return;
  }

  listEl.innerHTML = matches.map((m, idx) => {
    const h = m.homeTeam || m.homeName || '主队';
    const a = m.awayTeam || m.awayName || '客队';
    const odds = m.odds || {};

    let conf = 50;
    if (odds.h && odds.h > 1) {
      const p = deVigOdds(odds.h, odds.d || 3.3, odds.a || 3.4);
      conf = Math.max(p.pH, p.pD, p.pA) * 100;
    }

    return `
    <div class="analysis-item" onclick="${onSelect ? 'window.__selectAnalysis(' + idx + ')' : ''}">
      <div class="ai-num">${esc(m.code || '')}</div>
      <div class="ai-teams">
        ${esc(h)} <span style="color:var(--text-muted);font-weight:400;">vs</span> ${esc(a)}
        <div class="ai-league">${esc(m.league || '')} · ${esc(m.time || '')}</div>
      </div>
      <div class="ai-odds">
        ${odds.h ? `<span style="color:var(--c-red);">${odds.h.toFixed(2)}</span>
        <span style="color:var(--c-amber);">${(odds.d||0).toFixed(2)}</span>
        <span style="color:var(--c-green);">${(odds.a||0).toFixed(2)}</span>` : '暂无赔率'}
      </div>
      <div class="ai-conf">
        <span class="badge ${conf >= 65 ? 'badge-green' : conf >= 50 ? 'badge-amber' : 'badge-blue'}">${conf.toFixed(0)}%</span>
      </div>
      <div class="ai-arrow">›</div>
    </div>`;
  }).join('');
}

/**
 * 渲染单场分析详情
 */
function renderAnalysisDetail(match) {
  const container = document.getElementById('analysisDetail');
  if (!container) return;

  const h = match.homeTeam || '主队';
  const a = match.awayTeam || '客队';
  const odds = match.odds || {};
  const probs = odds.h && odds.h > 1
    ? deVigOdds(odds.h, odds.d || 3.3, odds.a || 3.4)
    : { pH: 0.5, pD: 0.25, pA: 0.25 };
  const conf = Math.max(probs.pH, probs.pD, probs.pA);
  const pred = probs.pH >= probs.pD && probs.pH >= probs.pA ? '主胜' : probs.pD >= probs.pA ? '平局' : '客胜';

  // 因子
  const factorsHtml = ANALYSIS_STATIC.factors.map(f => `
    <div class="factor-row">
      <div class="factor-name">${esc(f.name)}</div>
      <div class="factor-bar-wrap"><div class="factor-bar" style="width:${f.val * 100}%;background:${f.color};"></div></div>
      <div class="factor-pct" style="color:${f.color};">${(f.val * 100).toFixed(0)}%</div>
    </div>`).join('');

  // 攻防对比
  const metricsHtml = ANALYSIS_STATIC.metrics.map(mt => {
    const max = Math.max(mt.home, mt.away) * 1.2;
    return `<div class="metric-row">
      <div class="metric-label">${esc(mt.label)}</div>
      <div class="metric-bar-wrap">
        <div class="metric-bar-l" style="width:${(mt.home / max * 100).toFixed(0)}%;background:var(--c-blue);">${mt.home}</div>
        <div style="flex:1;height:1px;background:var(--border-color);"></div>
        <div class="metric-bar-r" style="width:${(mt.away / max * 100).toFixed(0)}%;background:var(--c-red);">${mt.away}</div>
      </div>
    </div>`;
  }).join('');

  // 交锋记录
  const h2hHtml = ANALYSIS_STATIC.h2h.map(x => `
    <tr>
      <td style="color:var(--text-muted);font-family:var(--font-mono);font-size:11px;">${esc(x.date)}</td>
      <td>${esc(x.event)}</td>
      <td>${esc(x.home)}</td>
      <td style="font-family:var(--font-mono);font-weight:600;">${esc(x.score)}</td>
      <td>${esc(x.away)}</td>
      <td><span class="result-tag ${x.result}">${x.result === 'W' ? '主胜' : x.result === 'D' ? '平局' : '客胜'}</span></td>
    </tr>`).join('');

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <div>
        <div style="font-size:18px;font-weight:700;">${esc(h)} <span style="color:var(--text-muted);font-weight:400;">vs</span> ${esc(a)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${esc(match.league || '')} · ${esc(match.time || '')}</div>
      </div>
      <span class="badge ${conf >= 65 ? 'badge-green' : 'badge-amber'}">置信度 ${(conf * 100).toFixed(0)}%</span>
    </div>

    <div class="grid grid-3" style="margin-bottom:16px;">
      <div class="card"><div class="page-subtitle">主胜</div><div class="page-title" style="color:var(--c-green);">${(probs.pH * 100).toFixed(0)}%</div></div>
      <div class="card"><div class="page-subtitle">平局</div><div class="page-title" style="color:var(--c-amber);">${(probs.pD * 100).toFixed(0)}%</div></div>
      <div class="card"><div class="page-subtitle">客胜</div><div class="page-title" style="color:var(--c-red);">${(probs.pA * 100).toFixed(0)}%</div></div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div style="font-size:14px;font-weight:600;margin-bottom:12px;">📊 因子贡献度</div>
      ${factorsHtml}
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div style="font-size:14px;font-weight:600;margin-bottom:12px;">⚔️ 攻防数据对比</div>
      ${metricsHtml}
    </div>

    <div class="card">
      <div style="font-size:14px;font-weight:600;margin-bottom:12px;">📜 近 3 次交锋</div>
      <table class="table"><tbody>${h2hHtml}</tbody></table>
    </div>

    <div style="margin-top:16px;padding:10px;background:var(--c-blue-dim);border-radius:8px;font-size:13px;">
      🎯 AI 研判：推荐 <strong>${esc(pred)}</strong>（置信度 ${(conf * 100).toFixed(0)}%）
    </div>`;
}

/* ============================================
   导出
   ============================================ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderAnalysisList, renderAnalysisDetail, ANALYSIS_STATIC };
}
if (typeof window !== 'undefined') {
  window.renderAnalysisList = renderAnalysisList;
  window.renderAnalysisDetail = renderAnalysisDetail;
  window.ANALYSIS_STATIC = ANALYSIS_STATIC;
}
