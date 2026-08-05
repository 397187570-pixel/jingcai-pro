/**
 * verdict.js — 「研判结论」功能页
 * 竞彩智选 Pro · 云端落地
 *
 * 渲染与 Ardot 设计稿对齐的研判结论页：
 * KPI 带 + 赛事研判卡 + 多维预测分解（选择器/4 维度卡/Top5） + 方法论 + 回测 + 关键发现
 */
(function () {
  const VerdictState = {
    selectedIdx: 0,
    recs: []
  };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function pct(x) {
    return (Math.round((x || 0) * 1000) / 10).toFixed(1) + '%';
  }

  function nowTime() {
    const d = new Date();
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function todayDate() {
    const d = new Date();
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + days[d.getDay()];
  }

  /* 统一把 odds 对象转成 recommend 需要的 jc 数组 */
  function normMatch(m) {
    const jc = m.jc || (m.odds ? [m.odds.h, m.odds.d, m.odds.a] : [1, 1, 1]);
    const handicap = m.handicap !== null && m.handicap !== undefined && m.handicap !== '' ? Number(m.handicap) : null;
    return Object.assign({}, m, { jc: jc, handicap: handicap });
  }

  function buildRecs(matches) {
    if (!matches || !matches.length) return [];
    const model = window.JC_MODEL || {};
    return matches.map(function (m) {
      try {
        return window.Recommend.recommend(normMatch(m), model.calib, model.leagueCal, model.asian, model.euGap, {});
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
  }

  function buildMulti(rec, m) {
    const probs = rec.directionProbs || (m.jc ? [(m.jc[0]||1)/((m.jc[0]||1)+(m.jc[1]||1)+(m.jc[2]||1)),
      (m.jc[1]||1)/((m.jc[0]||1)+(m.jc[1]||1)+(m.jc[2]||1)),
      (m.jc[2]||1)/((m.jc[0]||1)+(m.jc[1]||1)+(m.jc[2]||1))] : [0.33,0.33,0.33]);
    const line = (m.handicap !== null && m.handicap !== undefined && m.handicap !== '') ? Number(m.handicap) : null;
    return window.MultiDim.buildMultiDim({ homeWin: probs[0], draw: probs[1], awayWin: probs[2] }, { line: line });
  }

  /* ---------- 渲染 ---------- */
  function renderKpi(recs, matches) {
    const total = matches.length;
    const valueCount = recs.filter(function (r) { return r && r.valueSignal && r.valueSignal.hasValue; }).length;
    const avgConf = recs.length ? recs.reduce(function (s, r) { return s + (r.directionConfidence || 0); }, 0) / recs.length : 0;
    const juice = 12.9;

    const kpi = [
      { label: '在售场次', value: total + ' 场', sub: total ? '场 · 杯赛 / 资格赛' : '暂无在售场次', color: 'blue' },
      { label: '价值信号触发', value: valueCount + ' 场', sub: '模型价值边际触发', color: 'amber' },
      { label: '平均校准置信', value: pct(avgConf), sub: '方向≈跟随市场胜率', color: 'navy' },
      { label: '竞彩固定抽水', value: juice + '%', sub: '长期负 EV · 严控仓位', color: 'red' }
    ];

    return kpi.map(function (k) {
      const valueColor = k.color === 'blue' ? 'var(--c-blue)' : (k.color === 'amber' ? 'var(--c-amber)' : (k.color === 'red' ? 'var(--c-red)' : 'var(--text-primary)'));
      return `
        <div class="card verdict-kpi-card">
          <div class="verdict-kpi-label">${esc(k.label)}</div>
          <div class="verdict-kpi-value" style="color:${valueColor}">${esc(k.value)}</div>
          <div class="verdict-kpi-sub">${esc(k.sub)}</div>
        </div>`;
    }).join('');
  }

  function renderMatchCards(recs, matches) {
    if (!recs.length) return '<div class="card">暂无在售场次，请稍后刷新。</div>';
    return recs.map(function (r, i) {
      const m = matches[i];
      const conf = r.directionConfidence || 0;
      const confPct = Math.min(Math.max(conf * 100, 0), 100);
      const dirColor = r.direction === 'home' ? 'var(--c-blue)' : (r.direction === 'draw' ? 'var(--c-amber)' : 'var(--c-red)');
      const dirZh = r.directionZh || r.direction;
      const hasValue = r.valueSignal && r.valueSignal.hasValue;
      const badgeClass = hasValue ? 'verdict-value-badge amber' : 'verdict-value-badge gray';
      const badgeText = hasValue ? ('价值信号：' + (r.valueSignal.signal || '模型价值')) : '无显著价值（市场定价高效）';
      return `
        <div class="card verdict-match-card" data-idx="${i}">
          <div class="verdict-match-toprow">
            <span class="badge badge-blue">${esc(m.league || '联赛')}</span>
            <span class="verdict-direction" style="color:${dirColor}">模型方向：${esc(dirZh)}</span>
          </div>
          <div class="verdict-match-teams">${esc(m.homeTeam)} vs ${esc(m.awayTeam)}</div>
          <div class="verdict-match-conf-label">校准置信度</div>
          <div class="verdict-match-conf-value" style="color:${dirColor}">${pct(conf)}</div>
          <div class="vd-bar-track"><div class="vd-bar-fill" style="width:${confPct}%;background:${dirColor}"></div></div>
          <div class="${badgeClass}">${esc(badgeText)}</div>
        </div>`;
    }).join('');
  }

  function renderMatchPills(recs, matches, selectedIdx) {
    if (!recs.length) return '';
    return '<div class="verdict-match-pills">' +
      recs.map(function (r, i) {
        const m = matches[i];
        const active = i === selectedIdx ? ' active' : '';
        return `<button class="verdict-pill${active}" data-idx="${i}">${esc(m.homeTeam)} vs ${esc(m.awayTeam)}</button>`;
      }).join('') +
      '</div>';
  }

  function renderDimBar(p, color) {
    const w = Math.min(Math.max(p * 100, 0), 100);
    return `<div class="vd-bar-track"><div class="vd-bar-fill" style="width:${w.toFixed(1)}%;background:${color}"></div></div>`;
  }

  function renderDimCard(title, subtitle, rows) {
    const sub = subtitle ? `<div class="verdict-dim-sub">${esc(subtitle)}</div>` : '';
    const body = rows.map(function (row) {
      return `<div class="verdict-dim-row">
        <span class="verdict-dim-label">${esc(row.label)}</span>
        ${renderDimBar(row.p, row.color)}
      </div>`;
    }).join('');
    return `<div class="card verdict-dim-card">
      <div class="verdict-dim-title">${esc(title)}</div>
      ${sub}
      ${body}
    </div>`;
  }

  function renderMultiDim(recs, matches) {
    if (!recs.length) return '';
    const idx = VerdictState.selectedIdx;
    const r = recs[idx];
    const m = matches[idx];
    const md = buildMulti(r, m);

    const baseProbs = r.directionProbs || [0.33, 0.33, 0.33];
    const wdlRows = [
      { label: '主胜 ' + pct(baseProbs[0]), p: baseProbs[0], color: 'var(--c-blue)' },
      { label: '平 ' + pct(baseProbs[1]), p: baseProbs[1], color: 'var(--c-amber)' },
      { label: '客胜 ' + pct(baseProbs[2]), p: baseProbs[2], color: 'var(--c-red)' }
    ];
    const ahRows = [
      { label: '让胜 ' + pct(md.asian.home), p: md.asian.home, color: 'var(--c-blue)' },
      { label: '让平 ' + pct(md.asian.draw), p: md.asian.draw, color: 'var(--c-amber)' },
      { label: '让负 ' + pct(md.asian.away), p: md.asian.away, color: 'var(--c-red)' }
    ];
    const goalRows = md.totalGoals.slice(0, 3).map(function (t) {
      return { label: t.label + ' ' + pct(t.p), p: t.p, color: 'var(--c-blue)' };
    });
    const scoreRows = md.scoreMatrix.slice(0, 3).map(function (s) {
      return { label: s.score.replace(':', '-') + ' ' + pct(s.p), p: s.p, color: 'var(--c-blue)' };
    });

    return renderDimCard('胜平负', null, wdlRows) +
      renderDimCard('让胜平负', md.lineLabel + (md.lineSuggested ? ' · 模型建议' : ' · 竞彩盘口'), ahRows) +
      renderDimCard('进球数', null, goalRows) +
      renderDimCard('比分', null, scoreRows);
  }

  function rankColorClass(rank) {
    if (rank === 1) return 'verdict-top5-pct green';
    if (rank === 2) return 'verdict-top5-pct blue';
    if (rank === 3) return 'verdict-top5-pct red';
    if (rank === 4) return 'verdict-top5-pct amber';
    return 'verdict-top5-pct muted';
  }

  function renderTop5(recs, matches) {
    if (!recs.length) return '';
    const idx = VerdictState.selectedIdx;
    const r = recs[idx];
    const m = matches[idx];
    const md = buildMulti(r, m);
    const top5 = md.top5 || [];

    const rows = top5.map(function (c, i) {
      const rank = i + 1;
      return `<div class="verdict-top5-row">
        <span class="verdict-top5-rank">${rank}</span>
        <span class="verdict-top5-name">${esc(c.label)} · ${esc(c.dim)}</span>
        <span class="${rankColorClass(rank)}">${pct(c.p)}</span>
      </div>`;
    }).join('');

    return `
      <div class="verdict-top5-header">🎯 概率最高 Top5 结果（点击选择）</div>
      <div class="verdict-top5-sub">跨维度归一 · 概率口径一致 · 供你优先参考</div>
      <div class="verdict-top5-body">${rows || '<div class="verdict-top5-row">暂无数据</div>'}</div>
    `;
  }

  /* ---------- 主入口 ---------- */
  function renderVerdict(matches) {
    matches = matches || [];
    const container = document.getElementById('page-verdict');
    if (!container) return;

    const recs = buildRecs(matches);
    VerdictState.recs = recs;
    if (VerdictState.selectedIdx >= recs.length) VerdictState.selectedIdx = 0;

    const kpiStrip = document.getElementById('verdictKpiStrip');
    const matchGrid = document.getElementById('verdictMatchGrid');
    const selector = document.getElementById('verdictMatchSelector');
    const dimGrid = document.getElementById('verdictMultiDimGrid');
    const top5 = document.getElementById('verdictTop5');
    const dateEl = document.getElementById('verdictDate');
    const updateEl = document.getElementById('verdictUpdateTime');
    const matchTag = document.getElementById('verdictMatchTag');

    if (kpiStrip) kpiStrip.innerHTML = renderKpi(recs, matches);
    if (matchGrid) matchGrid.innerHTML = renderMatchCards(recs, matches);
    if (selector) selector.innerHTML = renderMatchPills(recs, matches, VerdictState.selectedIdx);
    if (dimGrid) dimGrid.innerHTML = renderMultiDim(recs, matches);
    if (top5) top5.innerHTML = renderTop5(recs, matches);
    if (dateEl) dateEl.textContent = todayDate();
    if (updateEl) updateEl.textContent = nowTime();
    if (matchTag) matchTag.textContent = matches.length + ' 场在售 · 实时校准';

    bindPills(recs, matches);
  }

  function bindPills(recs, matches) {
    const selector = document.getElementById('verdictMatchSelector');
    if (!selector) return;
    selector.querySelectorAll('.verdict-pill').forEach(function (btn) {
      btn.addEventListener('click', function () {
        VerdictState.selectedIdx = parseInt(btn.dataset.idx, 10) || 0;
        const dimGrid = document.getElementById('verdictMultiDimGrid');
        const top5 = document.getElementById('verdictTop5');
        if (dimGrid) dimGrid.innerHTML = renderMultiDim(recs, matches);
        if (top5) top5.innerHTML = renderTop5(recs, matches);
        selector.querySelectorAll('.verdict-pill').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
      });
    });
  }

  window.renderVerdict = renderVerdict;
})();
