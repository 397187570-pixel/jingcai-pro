/**
 * dashboard.js — 数据看板组件
 * 竞彩智选 Pro · 模块化版
 * 依赖：utils.js (esc/deVigOdds)、predictor.js (eloPredict)、CONFIG
 */

(function() {
/* 依赖解析：浏览器用全局，Node 用 require */
  let esc, deVigOdds, eloPredict, calibrateProbability, getOddsForCell, MultiDim;
  if (typeof window !== 'undefined' && window.esc) {
    esc = window.esc; deVigOdds = window.deVigOdds; eloPredict = window.eloPredict;
    getOddsForCell = window.getOddsForCell;
    MultiDim = window.MultiDim;
    calibrateProbability = window.Calibration ? window.Calibration.calibrateProbability : null;
  } else {
    const utils = require('../core/utils.js');
    const predictor = require('../engine/predictor.js');
    esc = utils.esc; deVigOdds = utils.deVigOdds; eloPredict = predictor.eloPredict;
    getOddsForCell = utils.getOddsForCell;
    try { MultiDim = require('../engine/multiDim.js'); } catch (e) { MultiDim = null; }
    try { calibrateProbability = require('../engine/calibration.js').calibrateProbability; } catch (e) { calibrateProbability = null; }
  }

  /* 多维预测单元样式映射 */
  function badgeClassForCell(cell) {
    if (!cell) return 'badge-blue';
    if (cell.key === '1x2-home' || cell.key === 'ah-home' || cell.dim === '进球数') return 'badge-green';
    if (cell.key === '1x2-away' || cell.key === 'ah-away') return 'badge-red';
    return 'badge-amber';
  }

  /* 取单场比赛竞彩选项中概率最高的一项（跨维度） */
  function getBestOption(m) {
    if (!MultiDim) return null;
    const odds = m.odds || {};
    if (!odds.h || odds.h <= 1) return null;
    const p = deVigOdds(odds.h, odds.d || 3.3, odds.a || 3.4);
    const line = (m.handicap !== null && m.handicap !== undefined && m.handicap !== '') ? Number(m.handicap)
      : (m.hhad && m.hhad.line !== undefined && m.hhad.line !== null && m.hhad.line !== '' ? Number(m.hhad.line) : null);
    try {
      const md = MultiDim.buildMultiDim({ homeWin: p.pH, draw: p.pD, awayWin: p.pA }, { line: line });
      const top = md.top5 && md.top5[0];
      if (!top) return null;
      top.odds = getOddsForCell ? getOddsForCell(top, m) : null;
      return top;
    } catch (e) {
      return null;
    }
  }

  /* 当前联赛筛选状态（全局，供 renderDashboard 复用） */
  let _leagueFilter = 'all';

  /* 绑定联赛筛选栏 */
  function bindLeagueFilter() {
    const bar = document.getElementById('leagueFilter');
    if (!bar || bar.dataset.bound) return;
    bar.dataset.bound = '1';
    bar.querySelectorAll('.league-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        bar.querySelectorAll('.league-chip').forEach(c => c.classList.remove('on'));
        chip.classList.add('on');
        _leagueFilter = chip.dataset.league;
        /* 重渲列表（用 AppState 当前数据，避免重复请求） */
        const ms = (typeof AppState !== 'undefined' && AppState.matches) ? AppState.matches : [];
        renderDashboard(ms);
      });
    });
  }

  /* 情报侧栏（取前 4 场做速览） */
  function renderIntelSide(list) {
    const el = document.getElementById('dashIntelSide');
    if (!el) return;
    if (!list.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">暂无赛事情报</div>'; return; }
    el.innerHTML = list.slice(0, 5).map(m => {
      const h = m.homeTeam || m.homeName || '主队';
      const a = m.awayTeam || m.awayName || '客队';
      const odds = m.odds || {};
      const tag = m.isDerby ? '<span class="badge badge-red" style="font-size:10px;padding:2px 6px;">德比</span>'
        : m.isFeatured ? '<span class="badge badge-amber" style="font-size:10px;padding:2px 6px;">焦点</span>' : '';
      return `<div class="intel-side-item">
        <div class="isi-teams">${esc(h)} <span style="color:var(--text-muted);">vs</span> ${esc(a)}</div>
        <div class="isi-meta">${esc(m.league || '')} ${tag}</div>
      </div>`;
    }).join('');
  }

  /* ============================================
   渲染数据看板
   ============================================ */
  function renderDashboard(matches) {
    bindLeagueFilter();
    const all = matches || [];
    // 联赛筛选
    const list = _leagueFilter === 'all' ? all : all.filter(m => (m.league || '').indexOf(_leagueFilter) >= 0);

    // KPI 统计
    setText('kpiTotal', all.length);
    setText('totalCount', all.length);
    setText('matchCountBadge', all.length + ' 场');
    const highCount = all.filter(m => {
      const o = m.odds || {};
      if (!o.h || o.h <= 1) return false;
      const p = deVigOdds(o.h, o.d || 3.3, o.a || 3.4);
      const conf = Math.max(p.pH, p.pD, p.pA) * 100;
      let real = conf;
      if (calibrateProbability) { const c = calibrateProbability(conf / 100); real = c.calibrated * 100; }
      return real >= 65;
    }).length;
    setText('kpiHigh', highCount);
    // 价值注回报：用 P8 回测 ROI 作为诚实基准（-4.84%），标注样本内
    setText('kpiValueRoi', '-4.8%');
    setText('kpiModelAcc', '50.3%');

    const ml = document.getElementById('matchList');
    if (!ml) return;

    if (!list.length) {
    // 只展示中国竞彩选定的比赛；竞彩无在售场次时如实提示
      ml.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px;">' +
      (all.length ? '该联赛今日暂无竞彩场次' : '今日中国竞彩暂无在售场次<br><span style="font-size:11px;opacity:.7;">（竞彩官网每日 9:00-23:00 更新场次，赛季间隙可能为空）</span><br><br>') +
      '<button class="btn btn-primary" onclick="loadMatches()" style="font-size:12px;">🔄 刷新场次</button>' +
      '</div>';
      renderIntelSide(all);
      return;
    }

    ml.innerHTML = list.map((m) => {
      const origIdx = all.indexOf(m);
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

      // 真实置信度（校准后）
      let realConf = conf, calNote = '';
      if (calibrateProbability) {
        const cal = calibrateProbability(conf / 100);
        if (cal.calibrated !== conf / 100) {
          realConf = cal.calibrated * 100;
          calNote = `<div style="font-size:9px;color:var(--text-muted);margin-top:1px;">真实 ${realConf.toFixed(0)}%</div>`;
        }
      }

      const oddsHtml = odds.h ? `
      <span class="odds-t" style="color:var(--c-red);">${odds.h.toFixed(2)}</span>
      <span class="odds-t" style="color:var(--c-amber);">${(odds.d||0).toFixed(2)}</span>
      <span class="odds-t" style="color:var(--c-green);">${(odds.a||0).toFixed(2)}</span>` : '暂无赔率';

      const best = getBestOption(m);
      const bestClass = badgeClassForCell(best);
      const bestLabel = best ? best.label : '--';
      const bestOdds = best && best.odds ? best.odds.toFixed(2) : '--';
      const bestPct = best ? (best.p * 100).toFixed(1) + '%' : '';

      return `
    <div class="match-item" style="display:flex;align-items:center;gap:14px;padding:14px 16px;border-bottom:1px solid var(--border-color);cursor:pointer;transition:background var(--transition);" onclick="openAnalysisDetail(${origIdx})" data-match-idx="${origIdx}">
      <div class="match-league-info">
        <div class="league-tag"><span class="dot" style="background:var(--c-blue);"></span>${esc(m.league || '')}</div>
        <div class="match-code" style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${esc(m.code || '')}</div>
      </div>
      <div class="match-teams" style="flex:1;min-width:0;">
        <div class="team-names" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(h)} <span style="color:var(--text-muted);font-weight:400;margin:0 4px;">vs</span> ${esc(a)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${esc(m.time || m.date || '')}</div>
      </div>
      <div class="match-odds" style="display:flex;gap:8px;font-family:var(--font-mono);font-size:13px;">
        ${oddsHtml}
      </div>
      <div class="match-best" style="text-align:center;min-width:72px;">
        <span class="badge ${bestClass}" style="font-size:12px;padding:4px 8px;">✓ ${esc(bestLabel)}</span>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-family:var(--font-mono);">@ ${bestOdds}</div>
        <div style="font-size:10px;color:var(--text-muted);">${bestPct}</div>
      </div>
      <div class="match-conf" style="text-align:center;">
        <span class="badge ${realConf >= 65 ? 'badge-green' : realConf >= 50 ? 'badge-amber' : 'badge-blue'}" style="font-size:12px;">${realConf.toFixed(0)}%</span>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">真实置信度</div>
        ${calNote}
      </div>
    </div>`;
    }).join('');

    renderIntelSide(all);
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  /* ============================================
   导出
   ============================================ */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderDashboard, bindLeagueFilter };
  }
  if (typeof window !== 'undefined') {
    window.renderDashboard = renderDashboard;
    window.bindLeagueFilter = bindLeagueFilter;
  }

})();
