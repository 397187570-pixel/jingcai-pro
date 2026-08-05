/**
 * toolbox.js — 个人工具箱组件
 * 竞彩智选 Pro · 模块化版
 * 依赖：utils.js (esc)
 */

(function() {
/* 依赖解析：浏览器用全局，Node 用 require */
let esc;
if (typeof window !== 'undefined' && window.esc) {
  esc = window.esc;
} else {
  esc = require('../core/utils.js').esc;
}

/* localStorage 键 */
const TOOLBOX_KEYS = {
  bets: 'jc_bets',
  follows: 'jc_follows'
};

/**
 * 读取投注记录
 */
function getBetRecords() {
  try {
    return JSON.parse(localStorage.getItem(TOOLBOX_KEYS.bets) || '[]');
  } catch (e) {
    return [];
  }
}

/**
 * 保存投注记录
 */
function saveBetRecords(records) {
  try {
    localStorage.setItem(TOOLBOX_KEYS.bets, JSON.stringify(records));
  } catch (e) { /* 存储失败忽略 */ }
}

/**
 * 添加投注记录
 */
function addBetRecord(record) {
  const records = getBetRecords();
  record.id = Date.now();
  record.date = record.date || new Date().toISOString().slice(0, 10);
  record.result = record.result || 'pending';
  record.profit = record.profit || 0;
  records.unshift(record);
  saveBetRecords(records);
  renderToolbox();
  return record;
}

/**
 * 渲染工具箱
 * 注：投注记录功能暂时保留，后续将改为"近 1 个月预测准确率统计"
 */
function renderToolbox() {
  const records = getBetRecords();

  /* 准确率统计占位（用户明确说缓后执行，先做 UI 骨架） */
  const accEl = document.getElementById('toolboxAccuracy');
  if (accEl) {
    /* 统计近 30 天有结果的记录 */
    var now = new Date();
    var recent = records.filter(function(r) {
      if (r.result === 'pending') return false;
      var d = new Date(r.date);
      return (now - d) <= 30 * 86400000;
    });
    var wins = recent.filter(function(r) { return r.result === 'win'; }).length;
    var total = recent.length;
    var rate = total ? Math.round(wins / total * 100) : 0;

    accEl.innerHTML =
      '<div class="grid grid-3" style="margin-bottom:12px;">' +
        '<div class="card"><div class="page-subtitle">近 30 天预测</div><div class="page-title">' + total + ' 场</div></div>' +
        '<div class="card"><div class="page-subtitle">命中</div><div class="page-title" style="color:var(--c-green);">' + wins + ' 场</div></div>' +
        '<div class="card"><div class="page-subtitle">准确率</div><div class="page-title" style="color:' + (rate >= 60 ? 'var(--c-green)' : rate >= 40 ? 'var(--c-amber)' : 'var(--c-red)') + ';">' + rate + '%</div></div>' +
      '</div>' +
      (total === 0
        ? '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:12px;">暂无已开奖记录 — 此功能需积累真实预测数据后自动统计</div>'
        : '<div style="font-size:11px;color:var(--text-muted);text-align:center;">数据来源：已记录的预测结果（localStorage，不涉及真实下注）</div>');
  }

  // 投注记录表
  const betBody = document.getElementById('betTableBody');
  if (betBody) {
    betBody.innerHTML = records.length === 0 ?
      '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px;">暂无投注记录 — 点击赔率格子添加</td></tr>' :
      records.slice().reverse().map(b => {
        const resTag = b.result === 'win'
          ? '<span class="result-tag W">命中</span>'
          : b.result === 'pending'
            ? '<span class="result-tag" style="background:var(--c-amber-dim);color:var(--c-amber);">待开奖</span>'
            : '<span class="result-tag L">未中</span>';
        const profitColor = b.profit > 0 ? 'var(--c-green)' : 'var(--c-red)';
        const profitDisplay = b.result === 'pending' ? '--' : (b.profit > 0 ? '+' : '') + '¥' + (b.profit || 0).toFixed(0);
        return `<tr>
          <td style="color:var(--text-muted);font-family:var(--font-mono);font-size:11px;">${esc(b.date)}</td>
          <td><div style="font-size:13px;">${esc(b.match)}</div></td>
          <td><span style="font-size:11px;">${esc(b.type || '')} · ${esc(b.sel || '')}</span></td>
          <td style="font-family:var(--font-mono);">@${esc(b.odds)}</td>
          <td style="font-family:var(--font-mono);">¥${esc(b.amt)}</td>
          <td>${resTag}</td>
          <td style="font-family:var(--font-mono);font-weight:600;color:${profitColor};">${profitDisplay}</td>
        </tr>`;
      }).join('');
  }

  // 关注球队
  const followEl = document.getElementById('followList');
  if (followEl) {
    const follows = getFollowTeams();
    followEl.innerHTML = follows.length === 0 ?
      '<div style="text-align:center;color:var(--text-muted);padding:20px;">暂无关注球队</div>' :
      follows.map(f => `
        <div class="follow-item">
          <div class="follow-logo">${esc((f.short || f.name || '?').slice(0, 2))}</div>
          <div class="follow-info">
            <div class="follow-name">${esc(f.name || '')}</div>
            <div class="follow-meta">${esc(f.league || '')} · 近况：${esc(f.recent || '')}</div>
          </div>
          <div class="follow-act">${esc(f.next || '暂无赛程')} ›</div>
        </div>`).join('');
  }

  // 统计卡片
  const winCount = records.filter(r => r.result === 'win').length;
  const lossCount = records.filter(r => r.result === 'loss').length;
  const totalProfit = records.filter(r => r.result !== 'pending')
    .reduce((s, r) => s + (r.profit || 0), 0);

  setText('toolboxTotal', records.length);
  setText('toolboxWin', winCount);
  setText('toolboxLoss', lossCount);
  setText('toolboxProfit', (totalProfit > 0 ? '+' : '') + '¥' + totalProfit.toFixed(0));
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function getFollowTeams() {
  try {
    return JSON.parse(localStorage.getItem(TOOLBOX_KEYS.follows) || '[]');
  } catch (e) {
    return [];
  }
}

/* ============================================
   导出
   ============================================ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderToolbox, addBetRecord, getBetRecords, getFollowTeams };
}
if (typeof window !== 'undefined') {
  window.renderToolbox = renderToolbox;
  window.addBetRecord = addBetRecord;
  window.getBetRecords = getBetRecords;
  window.getFollowTeams = getFollowTeams;
}

})();
