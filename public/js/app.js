/**
 * app.js — 应用入口（模块化架构示范）
 * 竞彩智选 Pro · 负责初始化、路由、事件绑定
 */

/* ============================================
   全局状态（示范：单文件版兼容）
   ============================================ */
const AppState = {
  matches: [],
  selectedIndex: 0,
  settings: {}
};

/* ============================================
   页面路由
   ============================================ */
function switchPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
}

/* ============================================
   数据加载（使用模块化的 API 层）
   ============================================ */
async function loadMatches() {
  const result = await SportteryApi.getMatches('HAD');
  if (!result.ok) {
    toast('error', '❌', '加载失败: ' + result.error);
    return;
  }
  AppState.matches = result.data;
  renderDashboard();
}

/* ============================================
   渲染
   ============================================ */
function renderDashboard() {
  const list = document.getElementById('matchList');
  const m = AppState.matches;

  document.getElementById('statMatches').textContent = m.length;
  document.getElementById('statSource').textContent = '竞彩官方';
  document.getElementById('statStatus').textContent = '实时';

  const confCount = m.filter(x => {
    if (!x.odds) return false;
    const probs = deVigOdds(x.odds.h, x.odds.d, x.odds.a);
    return Math.max(probs.pH, probs.pD, probs.pA) > CONFIG.thresholds.highConfidence;
  }).length;
  document.getElementById('statConf').textContent = confCount;

  if (!m.length) {
    list.innerHTML = '<div class="page-subtitle">暂无数据，点击刷新</div>';
    return;
  }

  list.innerHTML = m.map(x => `
    <div class="analysis-item" onclick="openAnalysis('${esc(x.homeTeam)}','${esc(x.awayTeam)}')">
      <div class="ai-num">${esc(x.code)}</div>
      <div class="ai-teams">
        ${esc(x.homeTeam)} <span style="color:var(--text-muted);font-weight:400;">vs</span> ${esc(x.awayTeam)}
        <div class="ai-league">${esc(x.league)} · ${esc(x.time)}</div>
      </div>
      <div class="ai-odds">
        ${x.odds ? `<span style="color:var(--c-red);">${x.odds.h.toFixed(2)}</span>
        <span style="color:var(--c-amber);">${x.odds.d.toFixed(2)}</span>
        <span style="color:var(--c-green);">${x.odds.a.toFixed(2)}</span>` : '暂无赔率'}
      </div>
    </div>
  `).join('');
}

function openAnalysis(home, away) {
  switchPage('analysis');
  const probs = eloPredict(1600, 1500);
  document.getElementById('analysisList').innerHTML = `
    <div class="page-title" style="font-size:18px;margin-bottom:12px;">${esc(home)} vs ${esc(away)}</div>
    <div class="grid grid-3" style="margin-bottom:16px;">
      <div class="card"><div class="page-subtitle">主胜</div><div class="page-title">${probs.homeWin.toFixed(0)}%</div></div>
      <div class="card"><div class="page-subtitle">平局</div><div class="page-title">${probs.draw.toFixed(0)}%</div></div>
      <div class="card"><div class="page-subtitle">客胜</div><div class="page-title">${probs.awayWin.toFixed(0)}%</div></div>
    </div>
    <div class="page-subtitle">Elo 预测引擎（predictor.js 模块）</div>`;
}

/* ============================================
   Toast（模块化版）
   ============================================ */
function toast(type, icon, msg) {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = `<span>${esc(icon)}</span><span class="toast-text">${esc(msg)}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3500);
}

/* ============================================
   初始化
   ============================================ */
function init() {
  // 路由绑定
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchPage(tab.dataset.page));
  });
  // 刷新按钮
  document.getElementById('refreshBtn').addEventListener('click', loadMatches);
  // 加载数据
  loadMatches();
}

document.addEventListener('DOMContentLoaded', init);
