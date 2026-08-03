/**
 * app.js — 应用入口
 * 竞彩智选 Pro · 模块化版 v2.0
 * 职责：数据加载、页面路由、事件绑定、组件调度
 */

/* ============================================
   全局状态
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
  // 进入页面时刷新对应内容
  if (page === 'odds' && AppState.matches.length) renderOddsMonitor(AppState.matches, AppState.selectedIndex);
  if (page === 'ai' && AppState.matches.length) renderAIRecommendations(AppState.matches);
  if (page === 'analysis' && AppState.matches.length) renderAnalysisList(AppState.matches, null);
  if (page === 'toolbox') renderToolbox();
}

/* ============================================
   数据加载（通过模块化 API 层）
   ============================================ */
async function loadMatches() {
  try {
    // 优先 SCF 代理，其次直连
    const proxyUrl = AppState.settings.proxyUrl || '';
    let result;
    if (proxyUrl) {
      const res = await fetch(proxyUrl + '/api/matches');
      result = { ok: res.ok, data: await res.json(), isProxy: true };
    } else {
      result = await SportteryApi.getMatches('HAD');
    }

    if (!result.ok || !result.data) {
      toast('error', '❌', '加载失败: ' + (result.error || '数据源不可用'));
      return;
    }

    // 标准化数据
    let matches;
    if (result.isProxy && result.data.success) {
      matches = (result.data.matches || []).map(m => ({
        code: m.matchNumStr || m.code,
        league: m.league || m.leagueName,
        homeTeam: m.homeTeamFull || m.homeTeam,
        awayTeam: m.awayTeamFull || m.awayTeam,
        time: m.matchTime || m.time,
        date: m.matchDate || m.date,
        odds: m.had ? { h: parseFloat(m.had.h), d: parseFloat(m.had.d), a: parseFloat(m.had.a) } : null,
        handicap: m.hhad ? m.hhad.goalLine : ''
      }));
    } else {
      matches = result.data || [];
    }

    AppState.matches = matches;
    renderAll();
    toast('success', '✅', `已加载 ${matches.length} 场比赛`);
  } catch (e) {
    toast('error', '❌', '加载失败: ' + e.message);
  }
}

/* ============================================
   渲染调度
   ============================================ */
function renderAll() {
  renderDashboard(AppState.matches);
  renderAnalysisList(AppState.matches, null);
  renderOddsMonitor(AppState.matches, AppState.selectedIndex);
  renderAIRecommendations(AppState.matches);
  renderToolbox();

  // KPI 补充
  setText('statSource', '竞彩官方');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ============================================
   Toast
   ============================================ */
function toast(type, icon, msg) {
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = `<span>${esc(icon)}</span><span class="toast-text">${esc(msg)}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3500);
}

/* ============================================
   深度分析：列表点击下钻
   ============================================ */
function openAnalysisDetail(idx) {
  AppState.selectedIndex = idx;
  switchPage('analysis');
  renderAnalysisDetail(AppState.matches[idx]);
}

/* ============================================
   价值注扫描
   ============================================ */
async function scanValueBets() {
  // 从输入/设置读 key
  const key = AppState.settings.oddsKey || '';
  if (!key) {
    toast('warn', '⚠️', '请先配置 The Odds API Key');
    document.getElementById('valueBetListModular').innerHTML =
      '<div style="padding:10px;background:var(--c-amber-dim);color:var(--c-amber);font-size:12px;">⚠️ 未配置 The Odds API Key — 请在控制台 AppState.settings.oddsKey 设置</div>';
    return;
  }
  await scanValueBetsModular(AppState.matches, async () => {
    const r = await OddsApi.getOdds('soccer_epl', key);
    return r.ok ? r.data : [];
  });
}

/* ============================================
   初始化
   ============================================ */
function init() {
  // 读取设置
  try {
    const saved = JSON.parse(localStorage.getItem('jc_settings') || '{}');
    AppState.settings = saved;
  } catch (e) { /* 无设置 */ }

  // 从 URL 参数读取 proxy
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('proxy')) AppState.settings.proxyUrl = params.get('proxy');
  } catch (e) { /* 忽略 */ }

  // 路由绑定
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchPage(tab.dataset.page));
  });

  // 刷新按钮
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadMatches);

  // 价值注扫描
  const scanBtn = document.getElementById('scanValueBtn');
  if (scanBtn) scanBtn.addEventListener('click', scanValueBets);

  // 自动刷新
  let interval = (parseInt(AppState.settings.refreshInterval) || 30) * 1000;
  const sel = document.getElementById('refreshIntervalSelect');
  if (sel) {
    sel.addEventListener('change', () => {
      interval = parseInt(sel.value) * 1000;
    });
  }
  setInterval(() => loadMatches(), interval);

  // 首屏加载
  loadMatches();
}

document.addEventListener('DOMContentLoaded', init);
