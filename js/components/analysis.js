/**
 * analysis.js — 深度分析组件
 * 竞彩智选 Pro · 模块化版
 * 依赖：utils.js (esc/deVigOdds)、predictor.js (eloPredict)、calibration.js
 */

(function() {
/* 依赖解析：浏览器用全局，Node 用 require */
let esc, deVigOdds, eloPredict, calibrateProbability;
if (typeof window !== 'undefined' && window.esc) {
  esc = window.esc; deVigOdds = window.deVigOdds; eloPredict = window.eloPredict;
  calibrateProbability = window.Calibration ? window.Calibration.calibrateProbability : null;
} else {
  const utils = require('../core/utils.js');
  const predictor = require('../engine/predictor.js');
  esc = utils.esc; deVigOdds = utils.deVigOdds; eloPredict = predictor.eloPredict;
  try { calibrateProbability = require('../engine/calibration.js').calibrateProbability; } catch (e) { calibrateProbability = null; }
}

/* 全局选中索引（用于高亮） */
let selectedAnalysisIdx = -1;

/**
 * 渲染深度分析列表
 * @param {Array} matches 比赛列表
 */
function renderAnalysisList(matches) {
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

    /* 真实置信度（校准后） */
    let realConf = conf;
    if (calibrateProbability) {
      const cal = calibrateProbability(conf / 100);
      if (cal.calibrated !== conf / 100) realConf = cal.calibrated * 100;
    }

    const isSel = idx === selectedAnalysisIdx;

    return `
    <div class="analysis-item ${isSel ? 'selected' : ''}" onclick="openAnalysisDetail(${idx})" style="cursor:pointer;${isSel ? 'background:var(--bg-card-hover);border-left:3px solid var(--c-blue);' : ''}">
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
        <span class="badge ${realConf >= 65 ? 'badge-green' : realConf >= 50 ? 'badge-amber' : 'badge-blue'}">${realConf.toFixed(0)}%</span>
      </div>
      <div class="ai-arrow">›</div>
    </div>`;
  }).join('');
}

/**
 * 从赔率推导分析因子（不用硬编码静态数据）
 */
function deriveFactors(odds) {
  if (!odds || !odds.h || odds.h <= 1) {
    return [
      { name: '近期状态', val: 0.50, color: 'var(--c-blue)', note: '赔率反推' },
      { name: '主场优势', val: 0.50, color: 'var(--c-cyan)', note: '赔率反推' },
      { name: '攻防能力', val: 0.50, color: 'var(--c-green)', note: '赔率反推' },
      { name: '历史交锋', val: 0.50, color: 'var(--c-amber)', note: '无数据' },
      { name: '战意评估', val: 0.50, color: 'var(--c-purple)', note: '赔率反推' }
    ];
  }
  var p = deVigOdds(odds.h, odds.d || 3.3, odds.a || 3.4);
  /* 主胜概率高 → 近期状态/主场优势高 */
  var homeStrength = p.pH;
  var awayStrength = p.pA;
  /* 总进球期望：用赔率反推大致进球区间 */
  var totalImplied = (1/odds.h + 1/odds.d + 1/odds.a);
  var returnRate = 1 / totalImplied;
  /* 平局概率高 → 攻防均衡，进球少 */
  var drawRate = p.pD;
  var attackFactor = 0.5 + (0.4 - drawRate) * 1.5; /* 平局越少，攻防越活跃 */

  return [
    { name: '近期状态', val: Math.max(0.2, Math.min(0.95, homeStrength + 0.1)), color: 'var(--c-blue)', note: '赔率反推' },
    { name: '主场优势', val: Math.max(0.25, Math.min(0.9, homeStrength - awayStrength + 0.5)), color: 'var(--c-cyan)', note: '赔率反推' },
    { name: '攻防能力', val: Math.max(0.2, Math.min(0.85, attackFactor)), color: 'var(--c-green)', note: '赔率反推' },
    { name: '历史交锋', val: 0.50, color: 'var(--c-amber)', note: '暂无数据' },
    { name: '战意评估', val: Math.max(0.3, Math.min(0.8, 0.5 + (homeStrength - 0.45) * 0.6)), color: 'var(--c-purple)', note: '赔率反推' }
  ];
}

/**
 * 从赔率推导估算攻防数据（标注"模型估算"）
 */
function deriveMetrics(odds) {
  if (!odds || !odds.h || odds.h <= 1) {
    return [
      { label: '预估进球', home: '--', away: '--', note: '模型估算' },
      { label: '预估失球', home: '--', away: '--', note: '模型估算' },
      { label: '预估射门', home: '--', away: '--', note: '模型估算' },
      { label: '控球率', home: '--', away: '--', note: '模型估算' },
      { label: '预估角球', home: '--', away: '--', note: '模型估算' }
    ];
  }
  var p = deVigOdds(odds.h, odds.d || 3.3, odds.a || 3.4);
  /* 主胜概率 → 估算主队进球偏多 */
  var homeGoals = (p.pH * 2.2 + p.pD * 1.1).toFixed(1);
  var awayGoals = (p.pA * 2.2 + p.pD * 1.1).toFixed(1);
  /* 射门估算：进球期望 × 7（足球平均 ~7 射门/进球） */
  var homeShots = Math.round(parseFloat(homeGoals) * 7);
  var awayShots = Math.round(parseFloat(awayGoals) * 7);
  /* 控球率：按实力分配 */
  var homePoss = Math.round(p.pH * 100 / (p.pH + p.pA));
  var awayPoss = 100 - homePoss;
  /* 角球估算 */
  var homeCorners = (parseFloat(homeGoals) * 2.5 + 3).toFixed(1);
  var awayCorners = (parseFloat(awayGoals) * 2.5 + 3).toFixed(1);

  return [
    { label: '预估进球', home: homeGoals, away: awayGoals, note: '模型估算' },
    { label: '预估失球', home: awayGoals, away: homeGoals, note: '模型估算' },
    { label: '预估射门', home: homeShots, away: awayShots, note: '模型估算' },
    { label: '控球率', home: homePoss + '%', away: awayPoss + '%', note: '模型估算' },
    { label: '预估角球', home: homeCorners, away: awayCorners, note: '模型估算' }
  ];
}

/**
 * 渲染单场分析详情（用选中比赛的真实数据）
 */
function renderAnalysisDetail(match) {
  const container = document.getElementById('analysisDetail');
  if (!container) return;
  if (!match) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:30px;">点击上方比赛查看深度分析</div>';
    return;
  }

  const h = match.homeTeam || '主队';
  const a = match.awayTeam || '客队';
  const odds = match.odds || {};
  const probs = odds.h && odds.h > 1
    ? deVigOdds(odds.h, odds.d || 3.3, odds.a || 3.4)
    : { pH: 0.5, pD: 0.25, pA: 0.25 };
  const conf = Math.max(probs.pH, probs.pD, probs.pA);
  const pred = probs.pH >= probs.pD && probs.pH >= probs.pA ? '主胜' : probs.pD >= probs.pA ? '平局' : '客胜';

  /* 真实置信度 */
  let realConf = conf, calNote = '';
  if (calibrateProbability) {
    const cal = calibrateProbability(conf);
    if (cal.calibrated !== conf) {
      realConf = cal.calibrated;
      calNote = `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">真实置信度 ${Math.round(realConf * 100)}%（校准样本 ${cal.count || 0} 场）</div>`;
    }
  }

  /* 从赔率推导因子 + 指标 */
  const factors = deriveFactors(odds);
  const metrics = deriveMetrics(odds);

  // 因子
  const factorsHtml = factors.map(f => `
    <div class="factor-row">
      <div class="factor-name">${esc(f.name)}<span style="font-size:9px;color:var(--text-muted);margin-left:4px;">${esc(f.note)}</span></div>
      <div class="factor-bar-wrap"><div class="factor-bar" style="width:${f.val * 100}%;background:${f.color};"></div></div>
      <div class="factor-pct" style="color:${f.color};">${(f.val * 100).toFixed(0)}%</div>
    </div>`).join('');

  // 攻防对比
  const metricsHtml = metrics.map(mt => {
    var hv = parseFloat(mt.home) || 0;
    var av = parseFloat(mt.away) || 0;
    var max = Math.max(hv, av, 1) * 1.2;
    return `<div class="metric-row">
      <div class="metric-label">${esc(mt.label)}</div>
      <div class="metric-bar-wrap">
        <div class="metric-bar-l" style="width:${(hv / max * 100).toFixed(0)}%;background:var(--c-blue);">${mt.home}</div>
        <div style="flex:1;height:1px;background:var(--border-color);"></div>
        <div class="metric-bar-r" style="width:${(av / max * 100).toFixed(0)}%;background:var(--c-red);">${mt.away}</div>
      </div>
    </div>`;
  }).join('');

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;padding:12px;background:var(--bg-card-hover);border-radius:8px;">
      <div>
        <div style="font-size:18px;font-weight:700;">${esc(h)} <span style="color:var(--text-muted);font-weight:400;">vs</span> ${esc(a)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${esc(match.league || '')} · ${esc(match.code || '')} · ${esc(match.time || '')}</div>
      </div>
      <span class="badge ${realConf >= 0.65 ? 'badge-green' : realConf >= 0.5 ? 'badge-amber' : 'badge-blue'}">置信度 ${Math.round(realConf * 100)}%</span>
    </div>
    ${calNote}

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
      <div style="font-size:14px;font-weight:600;margin-bottom:12px;">⚔️ 攻防数据对比 <span style="font-size:10px;color:var(--text-muted);font-weight:400;">（模型估算）</span></div>
      ${metricsHtml}
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div style="font-size:14px;font-weight:600;margin-bottom:12px;">📜 历史交锋</div>
      <div style="text-align:center;color:var(--text-muted);padding:20px;font-size:12px;">暂无历史交锋数据 — 当前数据源（竞彩官网）不提供历史记录</div>
    </div>

    <div style="margin-top:16px;padding:12px;background:var(--c-blue-dim);border-radius:8px;font-size:13px;">
      🎯 AI 研判：推荐 <strong>${esc(pred)}</strong>（置信度 ${Math.round(realConf * 100)}%）
    </div>`;
}

/* ============================================
   导出
   ============================================ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderAnalysisList, renderAnalysisDetail };
}
if (typeof window !== 'undefined') {
  window.renderAnalysisList = renderAnalysisList;
  window.renderAnalysisDetail = renderAnalysisDetail;
}

})();
