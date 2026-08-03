/**
 * oddsMonitor.js — 赔率监测组件
 * 竞彩智选 Pro · 模块化版
 * 依赖：utils.js (esc/deVigOdds)、predictor.js (eloPredict/poissonScoreMatrix)、CONFIG
 */

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
        <div><div style="font-size:13px;font-weight:600;margin-bottom:3px;">${esc(t.title)}</div><div class="trap-text">${esc(t.text)}</div></div>
      </div>`).join('');
  }
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
