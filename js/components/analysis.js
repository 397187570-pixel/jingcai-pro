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
  const selectedAnalysisIdx = -1;

  /**
 * 渲染深度分析列表
 * @param {Array} matches 比赛列表
 */
  function renderAnalysisList(matches) {
    const listEl = document.getElementById('analysisList');
    if (!listEl) return;

    /* 同步更新顶部比赛选择器 */
    bindAnalysisSelector(matches);
    renderAnalysisSelector(matches);

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
    const p = deVigOdds(odds.h, odds.d || 3.3, odds.a || 3.4);
    /* 主胜概率高 → 近期状态/主场优势高 */
    const homeStrength = p.pH;
    const awayStrength = p.pA;
    /* 总进球期望：用赔率反推大致进球区间 */
    const totalImplied = (1/odds.h + 1/odds.d + 1/odds.a);
    const returnRate = 1 / totalImplied;
    /* 平局概率高 → 攻防均衡，进球少 */
    const drawRate = p.pD;
    const attackFactor = 0.5 + (0.4 - drawRate) * 1.5; /* 平局越少，攻防越活跃 */

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
    const p = deVigOdds(odds.h, odds.d || 3.3, odds.a || 3.4);
    /* 主胜概率 → 估算主队进球偏多 */
    const homeGoals = (p.pH * 2.2 + p.pD * 1.1).toFixed(1);
    const awayGoals = (p.pA * 2.2 + p.pD * 1.1).toFixed(1);
    /* 射门估算：进球期望 × 7（足球平均 ~7 射门/进球） */
    const homeShots = Math.round(parseFloat(homeGoals) * 7);
    const awayShots = Math.round(parseFloat(awayGoals) * 7);
    /* 控球率：按实力分配 */
    const homePoss = Math.round(p.pH * 100 / (p.pH + p.pA));
    const awayPoss = 100 - homePoss;
    /* 角球估算 */
    const homeCorners = (parseFloat(homeGoals) * 2.5 + 3).toFixed(1);
    const awayCorners = (parseFloat(awayGoals) * 2.5 + 3).toFixed(1);

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
      const hv = parseFloat(mt.home) || 0;
      const av = parseFloat(mt.away) || 0;
      const max = Math.max(hv, av, 1) * 1.2;
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

    /* 渲染三栏拆解区块 */
    renderAnalysisBreakdown(match, { probs: probs, conf: conf, realConf: realConf, pred: pred, factors: factors, metrics: metrics });
  }

  /* ============================================
   比赛选择器（深度分析页顶部）
   ============================================ */
  function bindAnalysisSelector(matches) {
    const sel = document.getElementById('analysisMatchSelect');
    if (!sel || sel.dataset.bound) return;
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.value, 10) || 0;
      if (typeof AppState !== 'undefined') AppState.selectedIndex = idx;
      renderAnalysisDetail(matches[idx]);
      renderAnalysisList(matches);
    });
  }

  function renderAnalysisSelector(matches) {
    const sel = document.getElementById('analysisMatchSelect');
    if (!sel) return;
    const cur = (typeof AppState !== 'undefined' && AppState.selectedIndex) || 0;
    sel.innerHTML = matches.map((m, i) => {
      const h = m.homeTeam || m.awayName || '主队';
      const a = m.awayTeam || m.homeName || '客队';
      return `<option value="${i}" ${i === cur ? 'selected' : ''}>${esc(h)} vs ${esc(a)}</option>`;
    }).join('');
  }

  /**
 * 渲染单场三栏拆解：AI预测总览 / 维度贡献排名 / 攻防对比
 */
  function renderAnalysisBreakdown(match, ctx) {
    const host = document.getElementById('analysisBreakdown');
    if (!host) return;
    const probs = (ctx && ctx.probs) || { pH: 0.5, pD: 0.25, pA: 0.25 };
    const factors = (ctx && ctx.factors) || deriveFactors(match.odds);
    const metrics = (ctx && ctx.metrics) || deriveMetrics(match.odds);

    /* 维度贡献排名（用 MultDim top5，若无则退化为因子） */
    let rankHtml;
    if (window.MultiDim && match.odds && match.odds.h > 1) {
      const line = (match.handicap !== null && match.handicap !== undefined && match.handicap !== '')
        ? Number(match.handicap)
        : (match.hhad && match.hhad.line !== undefined ? Number(match.hhad.line) : null);
      try {
        const md = window.MultiDim.buildMultiDim(
          { homeWin: probs.pH, draw: probs.pD, awayWin: probs.pA },
          { line: line }
        );
        const top = (md.top5 || []).slice(0, 5);
        rankHtml = top.length ? top.map((c, i) => `
          <div class="rank-item">
            <span class="rank-no">${i + 1}</span>
            <div class="rank-body">
              <div class="rank-label">${esc(c.label || c.key)}</div>
              <div class="rank-bar-wrap"><div class="rank-bar" style="width:${(c.p * 100).toFixed(0)}%;background:var(--c-blue);"></div></div>
            </div>
            <span class="rank-pct">${(c.p * 100).toFixed(1)}%</span>
          </div>`).join('') : '<div class="empty-hint">暂无维度数据</div>';
      } catch (e) { rankHtml = '<div class="empty-hint">维度计算失败</div>'; }
    } else {
      rankHtml = factors.map((f, i) => `
        <div class="rank-item">
          <span class="rank-no">${i + 1}</span>
          <div class="rank-body">
            <div class="rank-label">${esc(f.name)}</div>
            <div class="rank-bar-wrap"><div class="rank-bar" style="width:${(f.val * 100).toFixed(0)}%;background:${f.color};"></div></div>
          </div>
          <span class="rank-pct">${(f.val * 100).toFixed(0)}%</span>
        </div>`).join('');
    }

    const metricsHtml = metrics.map(mt => {
      const hv = parseFloat(mt.home) || 0;
      const av = parseFloat(mt.away) || 0;
      const max = Math.max(hv, av, 1) * 1.2;
      return `<div class="metric-row">
        <div class="metric-label">${esc(mt.label)}</div>
        <div class="metric-bar-wrap">
          <div class="metric-bar-l" style="width:${(hv / max * 100).toFixed(0)}%;background:var(--c-blue);">${mt.home}</div>
          <div style="flex:1;height:1px;background:var(--border-color);"></div>
          <div class="metric-bar-r" style="width:${(av / max * 100).toFixed(0)}%;background:var(--c-red);">${mt.away}</div>
        </div>
      </div>`;
    }).join('');

    host.innerHTML = `
    <div class="breakdown-grid">
      <div class="card breakdown-col">
        <div class="bd-col-title">🤖 AI 预测总览</div>
        <div class="bd-pred-main">
          <div class="bd-pred-val" style="color:var(--c-green);">${(probs.pH * 100).toFixed(0)}%</div>
          <div class="bd-pred-sub">主胜概率（最高）</div>
        </div>
        <div class="bd-mini-row">
          <div class="bd-mini"><span class="bd-mini-k">平局</span><span class="bd-mini-v" style="color:var(--c-amber);">${(probs.pD * 100).toFixed(0)}%</span></div>
          <div class="bd-mini"><span class="bd-mini-k">客胜</span><span class="bd-mini-v" style="color:var(--c-red);">${(probs.pA * 100).toFixed(0)}%</span></div>
        </div>
        <div class="bd-pred-foot">推荐方向：<strong>${(ctx && ctx.pred) || '--'}</strong> · 真实置信 ${(ctx && ctx.realConf ? Math.round(ctx.realConf * 100) : '--')}%</div>
      </div>
      <div class="card breakdown-col">
        <div class="bd-col-title">📐 维度贡献排名</div>
        ${rankHtml}
      </div>
      <div class="card breakdown-col">
        <div class="bd-col-title">⚔️ 攻防对比 <span style="font-size:10px;color:var(--text-muted);font-weight:400;">（模型估算）</span></div>
        ${metricsHtml}
      </div>
    </div>`;
  }

  /* ============================================
   导出
   ============================================ */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderAnalysisList, renderAnalysisDetail, renderAnalysisBreakdown, renderAnalysisSelector, bindAnalysisSelector };
  }
  if (typeof window !== 'undefined') {
    window.renderAnalysisList = renderAnalysisList;
    window.renderAnalysisDetail = renderAnalysisDetail;
    window.renderAnalysisBreakdown = renderAnalysisBreakdown;
    window.renderAnalysisSelector = renderAnalysisSelector;
    window.bindAnalysisSelector = bindAnalysisSelector;
  }

})();
