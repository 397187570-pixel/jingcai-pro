/**
 * compare.js — 「赛果复盘」对比页
 * 竞彩智选 Pro · 模块化版
 *
 * 功能：选定日期（默认昨日），用模型对当日已结算比赛"回溯重建"推荐方案
 *   （概率最高 Top5 + 稳妥/冷门串关），再与实际赛果(winFlag H/D/A)逐条对比，
 *   给出命中率汇总。这是模型自校准 / 验证闭环的"看得见"入口。
 *
 * 诚实声明：
 *   - 推荐由「当日最终赔率」经 OddsModel / 竞彩去抽水隐含概率重建，非预先存储的展示方案；
 *     赔率盘中微调不影响结论方向，属合理回溯近似。
 *   - 竞彩固定抽水约 12.9%，长期数学期望为负；本页仅验证"方向命中率"，不构成盈利保证。
 */
(function () {
  'use strict';

  var ZH = { h: '主胜', d: '平', a: '客胜' };
  // 模型方向 → winFlag：同时兼容 Top5 的 'home' 与串关腿的 'h' 两种写法
  var SIDE_MAP = { home: 'H', draw: 'D', away: 'A', h: 'H', d: 'D', a: 'A' };
  var FLAG_ZH = { H: '主胜', D: '平', A: '客胜' };

  // 串关「单场双选」开关状态（复盘页独立维护；与引擎 OPTS 同步）
  var useDoubleState = false;
  // 单腿命中判定：双选腿（l.sides 含两个结果）任一命中即算中；单选腿按 l.side 判定
  function legHit(l, m) {
    if (!m) return false;
    if (l.double && l.sides) return l.sides.some(function (s) { return SIDE_MAP[s] === m.winFlag; });
    return SIDE_MAP[l.side] === m.winFlag;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  // 顶部状态条：让"选日期 / 点按钮"始终有可见反馈（避免用户以为没反应）
  function setStatus(msg, isErr) {
    var el = document.getElementById('compareStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'cmp-status' + (isErr ? ' cmp-status-err' : '');
  }
  function nowStr() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function pct(x) { return (Math.round((x || 0) * 1000) / 10).toFixed(1) + '%'; }

  function colorFor(side) {
    return side === 'home' ? 'var(--c-blue)' : (side === 'draw' ? 'var(--c-amber)' : 'var(--c-red)');
  }

  /* ---------- 主渲染 ---------- */
  // 统计所有「有已结算样本」的日期（倒序），用于默认日期与选择器范围约束
  function computeAvailable(hist) {
    var map = {};
    (hist || []).forEach(function (m) {
      if (m.matchDate && m.winFlag && 'HDA'.indexOf(m.winFlag) >= 0
          && parseFloat(m.h) > 1 && parseFloat(m.a) > 1) {
        map[m.matchDate] = (map[m.matchDate] || 0) + 1;
      }
    });
    return Object.keys(map).sort().reverse().map(function (d) { return { date: d, n: map[d] }; });
  }

  function renderCompare(dateStr, isExplicit) {
    var page = document.getElementById('page-compare');
    if (!page) return;
    var dateInput = document.getElementById('compareDate');
    if (dateInput && !dateStr) dateStr = (dateInput.value || '').trim();
    if (dateStr) dateStr = String(dateStr).trim();

    var sumEl = document.getElementById('compareSummary');
    var top5El = document.getElementById('compareTop5');
    var parlayEl = document.getElementById('compareParlay');
    setStatus('🔄 加载历史样本…');
    if (sumEl) sumEl.innerHTML = '<div class="empty-hint">⏳ 加载历史样本…</div>';
    if (top5El) top5El.innerHTML = '<div class="empty-hint">⏳</div>';
    if (parlayEl) parlayEl.innerHTML = '<div class="empty-hint">⏳</div>';

    var OM = window.OddsParlay;
    if (!OM || !OM.scoreCurrentMatches) {
      if (sumEl) sumEl.innerHTML = '<div class="empty-hint">⚠️ 串关引擎未就绪</div>';
      return;
    }

    fetch('ml/data/history_matches.json?v=' + (window.APP_VERSION || ''))
      .then(function (r) { return r.json(); })
      .then(function (hist) {
        var avail = computeAvailable(hist);
        var latest = avail.length ? avail[0].date : null;
        var earliest = avail.length ? avail[avail.length - 1].date : null;

        // 约束日期选择器范围，避免选到无数据的空白日
        if (dateInput) {
          if (earliest) dateInput.min = earliest;
          if (latest) dateInput.max = latest;
        }

        // 初次进入（未显式选日期）：默认跳到「最近一个有赛果的日期」，保证一打开就有内容
        if (!dateStr) {
          dateStr = latest || '';
          if (dateInput && dateStr) dateInput.value = dateStr;
        }

        var recs = (hist || []).filter(function (m) {
          return m.matchDate === dateStr
            && m.winFlag && 'HDA'.indexOf(m.winFlag) >= 0
            && parseFloat(m.h) > 1 && parseFloat(m.a) > 1;
        });

        if (!recs.length) {
          // 用户显式选了某天但无数据：给出「跳到最近有赛果日期」的快捷入口
          var hint = '<div class="empty-hint">📭 ' + esc(dateStr) +
            ' 当日无已结算比赛样本。</div>';
          if (isExplicit && latest) {
            hint += '<div style="margin-top:10px;"><button class="btn" onclick="renderCompare(\'' +
              latest + '\',false)">↩ 跳到最近有赛果的日期（' + esc(latest) + '）</button></div>';
          } else if (latest) {
            hint += '<div class="empty-hint" style="margin-top:6px;">最近有赛果的日期：' + esc(latest) + '</div>';
          } else {
            hint += '<div class="empty-hint" style="margin-top:6px;">历史样本中暂无已结算比赛。</div>';
          }
          if (sumEl) sumEl.innerHTML = hint;
          if (top5El) top5El.innerHTML = '';
          if (parlayEl) parlayEl.innerHTML = '';
          setStatus('📭 ' + esc(dateStr) + ' 无已结算样本', true);
          return;
        }

        // 标准化为评分引擎可消费的比赛对象，并保留赛果
        var matches = recs.map(function (m) {
          return {
            homeTeam: m.homeTeam, awayTeam: m.awayTeam, league: m.leagueName || '',
            code: m.matchId || '',
            odds: { h: parseFloat(m.h), d: parseFloat(m.d), a: parseFloat(m.a) },
            winFlag: m.winFlag, score: m.sectionsNo999 || ''
          };
        });
        var byKey = {};
        matches.forEach(function (m) { byKey[m.homeTeam + '|' + m.awayTeam] = m; });

        var scored = OM.scoreCurrentMatches(matches);

        // ---------- Top5：按模型概率最高边排序，取前 5 ----------
        var top5 = scored.map(function (x) {
          var p = x.res.p;
          var i = p[0] >= p[1] ? (p[0] >= p[2] ? 0 : 2) : (p[1] >= p[2] ? 1 : 2);
          var side = ['home', 'draw', 'away'][i];
          var m = byKey[x.meta.zhHome + '|' + x.meta.zhAway];
          var hit = !!(m && SIDE_MAP[side] === m.winFlag);
          return { m: m, side: side, prob: p[i], hit: hit };
        }).sort(function (a, b) { return b.prob - a.prob; }).slice(0, 5);

        if (top5El) top5El.innerHTML = renderTop5Table(top5);
        if (parlayEl) parlayEl.innerHTML = renderParlayCompare(scored, byKey);

        // ---------- 汇总 ----------
        var top5Hit = top5.filter(function (r) { return r.hit; }).length;
        var rec = OM.recommendFromScored(scored, 3, { useDouble: useDoubleState });
        var stableHit = rec ? rec.stable.legs.every(function (l) {
          var m = byKey[l.meta.zhHome + '|' + l.meta.zhAway];
          return legHit(l, m);
        }) : false;
        var coldHit = rec ? rec.cold.legs.every(function (l) {
          var m = byKey[l.meta.zhHome + '|' + l.meta.zhAway];
          return legHit(l, m);
        }) : false;

        if (sumEl) sumEl.innerHTML = renderSummary(matches.length, top5Hit, top5.length, stableHit, coldHit);
        setStatus('✅ 已刷新对比 · ' + nowStr() + ' · ' + esc(dateStr) + '（' + matches.length + ' 场）');
      })
      .catch(function (e) {
        if (sumEl) sumEl.innerHTML = '<div class="empty-hint">⚠️ 加载失败：' + esc(e.message || e) + '</div>';
        setStatus('⚠️ 加载失败：' + esc(e.message || e), true);
      });
  }

  function renderSummary(n, top5Hit, top5Total, stableHit, coldHit) {
    var cards = [
      { label: '当日已结算场次', value: n + ' 场', color: 'var(--c-blue)', sub: '纳入复盘样本' },
      { label: 'Top5 方向命中', value: top5Hit + '/' + top5Total, color: top5Hit >= 3 ? 'var(--c-green)' : 'var(--c-amber)',
        sub: top5Total ? (pct(top5Hit / top5Total) + ' · 仅方向') : '—' },
      { label: '稳妥串关', value: stableHit ? '命中' : '未命中', color: stableHit ? 'var(--c-green)' : 'var(--c-red)', sub: '3 腿全中才算命中' },
      { label: '冷门串关', value: coldHit ? '命中' : '未命中', color: coldHit ? 'var(--c-green)' : 'var(--c-red)', sub: '3 腿全中才算命中' }
    ];
    return '<div class="grid grid-4">' + cards.map(function (k) {
      return '<div class="card kpi-card">' +
        '<div class="kpi-label">' + esc(k.label) + '</div>' +
        '<div class="kpi-value" style="color:' + k.color + '">' + esc(k.value) + '</div>' +
        '<div class="kpi-foot">' + esc(k.sub) + '</div></div>';
    }).join('') + '</div>';
  }

  function renderTop5Table(rows) {
    if (!rows.length) return '<div class="empty-hint">该日无足够数据生成 Top5。</div>';
    var body = rows.map(function (r, i) {
      var m = r.m;
      var actual = FLAG_ZH[m.winFlag] || m.winFlag;
      var hitCls = r.hit ? 'cmp-hit' : 'cmp-miss';
      var hitTxt = r.hit ? '✓ 命中' : '✗ 未中';
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td><span class="badge badge-blue">' + esc(m.league) + '</span></td>' +
        '<td>' + esc(m.homeTeam) + ' <span style="color:var(--text-muted)">vs</span> ' + esc(m.awayTeam) +
          (m.score ? ' <span style="color:var(--text-muted);font-size:11px;">(' + esc(m.score) + ')</span>' : '') + '</td>' +
        '<td style="color:' + colorFor(r.side) + ';font-weight:600;">' + esc(ZH[r.side]) + '</td>' +
        '<td style="font-family:var(--font-mono);">' + pct(r.prob) + '</td>' +
        '<td>' + esc(actual) + '</td>' +
        '<td class="' + hitCls + '">' + hitTxt + '</td>' +
      '</tr>';
    }).join('');
    return '<table class="table compare-table"><thead><tr>' +
      '<th>#</th><th>联赛</th><th>对阵（比分）</th><th>推荐</th><th>模型概率</th><th>实际赛果</th><th>结果</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function renderParlayCompare(scored, byKey) {
    var rec = window.OddsParlay.recommendFromScored(scored, 3, { useDouble: useDoubleState });
    if (!rec) return '<div class="empty-hint">该日比赛不足以生成串关（需 ≥3 场）。</div>';
    return '<div class="parlay-row">' +
      renderParlayCard(rec.stable, byKey, 'stable') +
      renderParlayCard(rec.cold, byKey, 'cold') +
    '</div>';
  }

  function renderParlayCard(card, byKey, type) {
    var isStable = type === 'stable';
    var isDouble = !!card.isDouble;
    var badge = isStable ? 'badge-green' : 'badge-amber';
    var title = isDouble ? (isStable ? '稳妥型·双选（更高命中）' : '冷门型·双选（更稳高回报）') : (isStable ? '稳妥型（高命中）' : '冷门型（高回报）');
    var s = card.stats;
    var evCls = s.ev >= 0 ? 'pos' : 'neg';

    var legs = card.legs.map(function (l) {
      var m = byKey[l.meta.zhHome + '|' + l.meta.zhAway];
      var hit = legHit(l, m);
      var hitCls = hit ? 'cmp-hit' : 'cmp-miss';
      var actual = m ? (FLAG_ZH[m.winFlag] || m.winFlag) : '—';
      var pick = (l.double ? '<span class="pl-double">双选</span> ' : '') + esc(l.sideZh) + ' @' + l.jc.toFixed(2);
      return '<li>' +
        '<span class="pl-teams">' + esc(l.meta.zhHome) + ' vs ' + esc(l.meta.zhAway) +
          (m && m.score ? ' <span style="color:var(--text-muted);font-size:11px;">(' + esc(m.score) + ')</span>' : '') + '</span>' +
        '<span class="pl-pick">' + pick + '</span>' +
        '<span class="pl-prob">' + (l.prob * 100).toFixed(1) + '%</span>' +
        '<span class="pl-ev ' + (l.ev >= 0 ? 'pos' : 'neg') + '">' + (l.ev >= 0 ? '+' : '') + (l.ev * 100).toFixed(1) + 'pp</span>' +
        '<span class="' + hitCls + '">' + (hit ? '✓' : '✗') + ' ' + esc(actual) + '</span>' +
      '</li>';
    }).join('');

    var allHit = card.legs.every(function (l) {
      var m = byKey[l.meta.zhHome + '|' + l.meta.zhAway];
      return legHit(l, m);
    });
    var comboCls = allHit ? 'cmp-hit' : 'cmp-miss';
    var comboTxt = allHit ? '✓ 串关命中（' + card.legs.length + ' 腿全中）' : '✗ 串关未命中（至少 1 腿错）';

    return '<div class="parlay-card ' + (isStable ? 'stable' : 'cold') + '">' +
      '<div class="parlay-card-head"><span class="badge ' + badge + '">' + title + '</span>' +
        '<span class="parlay-comb-ev ' + evCls + '">组合 EV ' + (s.ev >= 0 ? '+' : '') + (s.ev * 100).toFixed(1) + 'pp</span></div>' +
      '<ol class="parlay-legs">' + legs + '</ol>' +
      '<div class="parlay-stats">' +
        '<div><span class="ps-k">组合模型概率</span><span class="ps-v">' + (s.combP * 100).toFixed(2) + '%</span></div>' +
        '<div><span class="ps-k">组合竞彩赔率</span><span class="ps-v">' + s.combOdds.toFixed(2) + '×</span></div>' +
      '</div>' +
      '<div class="cmp-combo ' + comboCls + '">' + comboTxt + '</div>' +
      '<div class="parlay-note">组合 EV 为样本内历史拟合（乐观），真实价值 ROI≈−4.8%；本页仅验证方向命中，不构成盈利保证。</div>' +
    '</div>';
  }

  /* ---------- 初始化：按钮绑定 + 日期框 change 即自动渲染（app.js init 调用） ---------- */
  function initCompare() {
    var dateInput = document.getElementById('compareDate');
    var btn = document.getElementById('compareBtn');
    var dblToggle = document.getElementById('compareDoubleToggle');
    // 双选开关：同步引擎全局选项 + 本地状态，并立即重渲染当前日期
    if (dblToggle) {
      dblToggle.checked = !!window.OddsParlay && window.OddsParlay.getOption && window.OddsParlay.getOption('useDouble');
      useDoubleState = dblToggle.checked;
      dblToggle.addEventListener('change', function () {
        useDoubleState = dblToggle.checked;
        if (window.OddsParlay && window.OddsParlay.setOption) window.OddsParlay.setOption('useDouble', useDoubleState);
        renderCompare(dateInput ? dateInput.value : null, true);
      });
    }
    // 选日期即刷新（无需点按钮），直接修复"选了日期点按钮没反应"的观感问题
    if (dateInput) dateInput.addEventListener('change', function () {
      renderCompare(dateInput.value, true);
    });
    if (btn) btn.addEventListener('click', function () {
      renderCompare(dateInput ? dateInput.value : null, true);
    });
  }

  window.renderCompare = renderCompare;
  window.initCompare = initCompare;
})();
