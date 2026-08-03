/**
 * toolbox.js — 个人工具箱组件
 * 竞彩智选 Pro · 模块化版
 * 依赖：utils.js (esc)
 */

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
 */
function renderToolbox() {
  const records = getBetRecords();

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
