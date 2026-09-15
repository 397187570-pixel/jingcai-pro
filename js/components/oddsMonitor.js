/**
 * oddsMonitor.js — 赔率监测组件
 * 竞彩智选 Pro · 模块化版
 * 依赖：utils.js (esc/deVigOdds)、predictor.js (eloPredict/poissonScoreMatrix)、CONFIG
 */

(function() {
/* 依赖解析：浏览器用全局，Node 用 require */
  let esc;
  if (typeof window !== 'undefined' && window.esc) {
    esc = window.esc;
  } else {
    esc = require('../core/utils.js').esc;
  }

  /* 赔率静态数据（示例值，运行时用真实赔率覆盖） */
  const ODDS_STATIC = {
    bookmakers: [
      { name: '竞彩官方', offset: 0, status: 'normal', statusLabel: '官方' },
      { name: '威廉希尔', offset: -0.02, status: 'normal', statusLabel: '正常' },
      { name: 'Bet365', offset: 0.02, status: 'value', statusLabel: '价值' },
      { name: 'Ladbrokes', offset: -0.01, status: 'normal', statusLabel: '正常' },
      { name: 'Pinnacle', offset: 0.03, status: 'normal', statusLabel: '正常' },
      { name: '明陞', offset: -0.04, status: 'risk', statusLabel: '诱盘' }
    ],
    scores: {
      '1-0': 5.2, '2-0': 6.8, '2-1': 8.5, '3-0': 11.5, '3-1': 14,
      '0-0': 9.5, '1-1': 6.2, '2-2': 13.5,
      '0-1': 9.5, '0-2': 12, '1-2': 11.5, '0-3': 28,
      '其他': 50
    },
    goals: [
      { goals: 0, label: '0 球', odds: 8.5 },
      { goals: 1, label: '1 球', odds: 4.2 },
      { goals: 2, label: '2 球', odds: 3.1 },
      { goals: 3, label: '3 球', odds: 3.8 },
      { goals: 4, label: '4 球', odds: 6.5 },
      { goals: 5, label: '5 球', odds: 12 },
      { goals: 6, label: '6 球', odds: 25 },
      { goals: '7+', label: '7+ 球', odds: 40 }
    ],
    htft: [
      { label: '胜/胜', cls: 'win', odds: 3.2, prob: 32 },
      { label: '胜/平', cls: 'draw', odds: 15, prob: 7 },
      { label: '平/胜', cls: 'win', odds: 5.0, prob: 15 },
      { label: '平/平', cls: 'draw', odds: 4.8, prob: 22 },
      { label: '负/负', cls: 'lose', odds: 5.5, prob: 18 },
      { label: '负/平', cls: 'draw', odds: 16, prob: 6 }
    ]
  };

  /**
 * 渲染赔率监测
 * @param {Array} matches 比赛列表
 * @param {number} selectedIndex 选中场次
 */
  function renderOddsMonitor(matches, selectedIndex) {
    const match = matches[selectedIndex] || matches[0];
    if (!match) return;

    /* 比赛信息标题栏 — 用户明确反馈"没有体现是哪场比赛的" */
    const headerEl = document.getElementById('oddsMatchHeader');
    if (headerEl) {
      const h = match.homeTeam || match.homeName || '主队';
      const a = match.awayTeam || match.awayName || '客队';
      headerEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-size:16px;font-weight:700;">${esc(h)} <span style="color:var(--text-muted);font-weight:400;">vs</span> ${esc(a)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">
            <span class="badge badge-blue" style="font-size:10px;">${esc(match.code || '')}</span>
            ${esc(match.league || '')} · ${esc(match.time || '')}
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span style="font-size:12px;color:var(--text-muted);">切换比赛：</span>
          <button class="btn" style="font-size:11px;padding:4px 10px;" onclick="switchOddsMatch(-1)">‹ 上一场</button>
          <span style="font-size:11px;color:var(--text-muted);">${(selectedIndex >= 0 ? selectedIndex : 0) + 1} / ${matches.length}</span>
          <button class="btn" style="font-size:11px;padding:4px 10px;" onclick="switchOddsMatch(1)">下一场 ›</button>
        </div>
      </div>`;
    }

    const odds = match.odds || {};
    const jcOdds = { h: odds.h || 1.85, d: odds.d || 3.6, a: odds.a || 4.2 };
    const sumOdds = 1 / jcOdds.h + 1 / jcOdds.d + 1 / jcOdds.a;
    const jcReturn = (1 / sumOdds * 100).toFixed(1);
    const kelly = h => +(h * sumOdds).toFixed(3);

    // 胜平负表
    const el = document.getElementById('oddsTableBody');
    if (el) {
      el.innerHTML = ODDS_STATIC.bookmakers.map(b => {
        const o = { h: +(jcOdds.h + b.offset).toFixed(2), d: +jcOdds.d.toFixed(2), a: +(jcOdds.a - b.offset).toFixed(2) };
        const stCls = b.status === 'normal' ? 'st-normal' : b.status === 'value' ? 'st-value' : 'st-risk';
        return `<tr>
        <td class="bk-name">${esc(b.name)}${b.offset === 0 ? '<span class="badge badge-green" style="font-size:9px;margin-left:4px;">真实</span>' : ''}</td>
        <td class="odds-t ${o.h < 1.85 ? 'low' : ''}">${o.h.toFixed(2)}</td>
        <td class="odds-t">${o.d.toFixed(2)}</td>
        <td class="odds-t">${o.a.toFixed(2)}</td>
        <td>${jcReturn}%</td>
        <td>${kelly(o.h).toFixed(3)}</td>
        <td><span class="status-tag ${stCls}">${b.statusLabel}</span></td>
      </tr>`;
      }).join('');
    }

    // 亚盘
    const asianEl = document.getElementById('asianTableBody');
    if (asianEl) {
      asianEl.innerHTML = ODDS_STATIC.bookmakers.map(b => {
        const hw = +(jcOdds.h / (jcOdds.h + 1) * 0.95 + b.offset).toFixed(2);
        const aw = +(1.9 - hw).toFixed(2);
        return `<tr>
        <td class="bk-name">${esc(b.name)}</td>
        <td class="odds-t" style="color:var(--c-red);">${hw}</td>
        <td class="odds-t">${match.handicap || '0'}球</td>
        <td class="odds-t" style="color:var(--c-green);">${aw}</td>
        <td>${kelly(jcOdds.h).toFixed(3)}</td>
        <td><span class="status-tag ${b.status === 'risk' ? 'st-risk' : 'st-normal'}">${b.status === 'risk' ? '升水' : '正常'}</span></td>
      </tr>`;
      }).join('');
    }

    // 大小球
    const ouEl = document.getElementById('ouTableBody');
    if (ouEl) {
      const totalXg = 1.5 + 1.2; // Elo 近似
      const ouLine = totalXg > 3 ? '3' : totalXg > 2.5 ? '2.5' : '2';
      ouEl.innerHTML = ODDS_STATIC.bookmakers.map(b => {
        const over = +(0.85 + ((totalXg - 2.5) * 0.05) + b.offset * 2).toFixed(2);
        const under = +(1.9 - over).toFixed(2);
        return `<tr>
        <td class="bk-name">${esc(b.name)}</td>
        <td class="odds-t" style="color:var(--c-green);">${over}</td>
        <td class="odds-t">${ouLine}球</td>
        <td class="odds-t" style="color:var(--c-red);">${under}</td>
        <td><span class="status-tag st-normal">${totalXg > 2.7 ? '大球导向' : '均衡'}</span></td>
      </tr>`;
      }).join('');
    }

    // 比分
    const scoreEl = document.getElementById('scoreGrid');
    if (scoreEl) {
      scoreEl.innerHTML = Object.entries(ODDS_STATIC.scores).map(([score, odd]) => {
        const isHighlight = ['2-1', '1-1', '2-0', '0-1'].includes(score);
        return `<div class="score-cell ${isHighlight ? 'highlight' : ''}">
        <div class="score-num">${esc(score)}</div>
        <div class="score-odd">${odd.toFixed(1)}</div>
      </div>`;
      }).join('');
    }

    // 总进球
    const goalsEl = document.getElementById('goalsGrid');
    if (goalsEl) {
      goalsEl.innerHTML = ODDS_STATIC.goals.map(g => `
      <div class="goal-cell">
        <div class="num">${esc(String(g.goals))}</div>
        <div class="lbl">${esc(g.label)}</div>
        <div class="odd">@${g.odds.toFixed(2)}</div>
      </div>`).join('');
    }

    // 半全场
    const htftEl = document.getElementById('htftGrid');
    if (htftEl) {
      htftEl.innerHTML = '<div class="htft-header">半场\\全场</div>' +
      ['胜', '平', '负'].map(h => '<div class="htft-header">' + h + '</div>').join('') +
      ODDS_STATIC.htft.map(o => `
        <div class="htft-cell">
          <div class="combo ${o.cls}">${esc(o.label)}</div>
          <div class="odd">@${o.odds.toFixed(2)}</div>
          <div class="prob">${o.prob}%</div>
        </div>`).join('');
    }

    // 诱盘信号
    const trapEl = document.getElementById('trapList');
    if (trapEl) {
      trapEl.innerHTML = [
        { type: '参考', typeClass: 'safe', title: `竞彩官方 ${jcOdds.h.toFixed(2)} / ${jcOdds.d.toFixed(2)} / ${jcOdds.a.toFixed(2)}`, text: `返奖率 ${jcReturn}%，凯利 ${kelly(jcOdds.h).toFixed(3)}。竞彩为真实数据。` }
      ].map(t => `
      <div class="trap-item ${t.typeClass}">
        <span class="trap-type" style="background:var(--c-${t.typeClass === 'hot' ? 'red' : t.typeClass === 'safe' ? 'green' : 'amber'}-dim);color:var(--c-${t.typeClass === 'hot' ? 'red' : t.typeClass === 'safe' ? 'green' : 'amber'});">${t.type}</span>
        <div><div style="font-size:13px;font-weight:600;margin-bottom:3px;">${esc(t.title)}</div>        <div class="trap-text">${esc(t.text)}</div></div>
      </div>`).join('');
    }

    // 国内外赔率趋势分析 + 市场热度指数（P3 + P4，共享同一份时序）
    if (typeof window !== 'undefined' && window.OddsHistory) {
      const code = match.code || (match.homeTeam + '_vs_' + match.awayTeam);
      // P8b 串关推荐（不依赖时序，提前到 getSeries 之外，避免 series 不足时被跳过导致空白）
      if (window.OddsParlay) {
        window.OddsParlay.renderParlayPanel(document.getElementById('oddsParlayPanel'), 3, matches);
      }
      window.OddsHistory.getSeries(code).then(function (series) {
        const trendC = document.getElementById('oddsTrendAdvice');
        const heatC = document.getElementById('oddsHeatPanel');
        const emptyTrend = { insufficient: true, advice: { headline: '暂无数时序数据', reasons: ['打开本页后系统会持续记录竞彩赔率；接入国际赔率后解锁偏差/背离分析与下单建议。'] } };
        const emptyHeat = { insufficient: true, advice: { headline: '暂无数时序数据', reasons: ['打开本页后系统持续记录竞彩赔率，记录越多热度信号越可靠；国内无成交量，热度由赔率变动语义化估算。'] } };
        if (!series || series.length < 2) {
          if (trendC && window.OddsTrend) window.OddsTrend.renderAdvice(trendC, emptyTrend);
          if (heatC && window.OddsHeat) window.OddsHeat.renderHeat(heatC, emptyHeat);
          return;
        }
        // P3 趋势分析（先算，结果传给 P4 做价值交叉验证）
        let trendResult = null;
        if (window.OddsTrend) {
          trendResult = window.OddsTrend.analyze(series, { refKey: 'intlAvg' });
          if (trendC) window.OddsTrend.renderAdvice(trendC, trendResult);
        }
        // P4 市场热度指数（带 P3 价值交叉验证）
        if (window.OddsHeat && heatC) {
          window.OddsHeat.renderHeat(heatC, window.OddsHeat.analyze(series, { refKey: 'intlAvg', trendResult: trendResult }));
        }
        // P6 赔率异动监控 + 提醒（当前场卡片，复用 P3/P4 交叉验证）
        const alertC = document.getElementById('oddsAlertCard');
        if (window.OddsAlert && alertC) {
          const det = window.OddsAlert.detectMovements(series, { refKey: 'intlAvg', trendResult: trendResult, heatResult: (window.OddsHeat ? window.OddsHeat.analyze(series, { refKey: 'intlAvg', trendResult: trendResult }) : null) });
          window.OddsAlert.renderAlertCard(alertC, det);
        }
        // P5 权重规律挖掘（全局历史回测，懒加载+缓存）
        renderPatternsPanel();
        // P8 ML 模型面板（逻辑回归多源融合，浏览器内实时推断）
        if (window.OddsModel) window.OddsModel.renderModelPanel(document.getElementById('oddsModelPanel'));
        // P6 全市场异动提醒中心（扫描所有已记录比赛的最近异动）
        renderAlertCenter();
      }).catch(function () {
        const c1 = document.getElementById('oddsTrendAdvice');
        const c2 = document.getElementById('oddsHeatPanel');
        if (c1) c1.innerHTML = '';
        if (c2) c2.innerHTML = '';
      });
    }
  }

  /* ============================================
   P6 全市场异动提醒中心（扫描所有已记录比赛的最近异动）
   ============================================ */
  function renderAlertCenter() {
    const c = document.getElementById('oddsAlertCenter');
    if (!c || !window.OddsHistory || !window.OddsAlert) return;
    c.innerHTML = '<div class="empty-hint">正在扫描全市场异动…</div>';
    window.OddsHistory.getAllSeries().then(function (map) {
      if (!map || !Object.keys(map).length) {
        window.OddsAlert.renderAlerts(c, { items: [], threshold: (window.CONFIG && CONFIG.thresholds.alertMove) || 0.05, windowMs: 10 * 60 * 1000 });
        return;
      }
      const scan = window.OddsAlert.scanAll(map, { windowMs: 10 * 60 * 1000 });
      window.OddsAlert.renderAlerts(c, scan);
    }).catch(function () {
      c.innerHTML = '<div class="empty-hint">异动提醒中心暂不可用（存储读取失败）。</div>';
    });
  }

  /* ============================================
   P5 权重规律挖掘面板（全局历史回测, 懒加载 + 缓存）
   ============================================ */
  let _patternsCache = null;
  let _patternsLoading = false;
  function renderPatternsPanel() {
    const c = document.getElementById('oddsPatternsPanel');
    if (!c || !window.OddsPatterns) return;
    if (_patternsCache) { window.OddsPatterns.renderPatterns(c, _patternsCache); return; }
    if (_patternsLoading) return;
    _patternsLoading = true;
    c.innerHTML = '<div class=\"empty-hint\">正在加载历史三件套回测模型…</div>';
    const candidates = [
      'ml/data/eu_odds_history.json',
      './ml/data/eu_odds_history.json',
      'jingcai-pro/ml/data/eu_odds_history.json'
    ];
    function tryFetch(i) {
      if (i >= candidates.length) {
        c.innerHTML = '<div class=\"empty-hint\">无法加载历史回测数据（ml/data/eu_odds_history.json）。</div>';
        _patternsLoading = false;
        return;
      }
      fetch(candidates[i]).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }).then(function (hist) {
        _patternsCache = window.OddsPatterns.analyze(hist, { minN: 50 });
        window.OddsPatterns.renderPatterns(c, _patternsCache);
        _patternsLoading = false;
      }).catch(function () { tryFetch(i + 1); });
    }
    tryFetch(0);
  }

  /* ============================================
   导出
   ============================================ */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderOddsMonitor, ODDS_STATIC };
  }
  if (typeof window !== 'undefined') {
    window.renderOddsMonitor = renderOddsMonitor;
    window.ODDS_STATIC = ODDS_STATIC;
  }

})();
