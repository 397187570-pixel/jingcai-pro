/**
 * app.js — 应用入口
 * 竞彩智选 Pro · 模块化版 v2.0
 * 职责：数据加载、页面路由、事件绑定、组件调度
 */

/* global renderVerdict, renderQuotaBar */

/* ============================================
   全局状态
   ============================================ */
const AppState = {
  matches: [],
  selectedIndex: 0,
  settings: {}
};

/* football-data.org 默认 Key（用户提供；可在设置里覆盖） */
const FOOTBALL_DATA_DEFAULT_KEY = '3fe18ae6596b42d68ce5fafc8c98f2fb';

/* 默认 SCF 代理（腾讯云广州区，CORS 已开放 *，返回中国竞彩网当日场次）。
   线上/本地未手动配置 proxyUrl 时自动启用，确保串关展示真实的当日竞彩而非历史演示。 */
const DEFAULT_PROXY_URL = 'https://1301319324-0rhvwc1if1.ap-guangzhou.tencentscf.com';

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
  if (page === 'ai') {
    renderAIRecommendations(AppState.matches);
  }
  if (page === 'verdict' && AppState.matches.length) {
    renderVerdict(AppState.matches);
    /* AI 串关推荐面板已移至研判结论页（Top5 之下），随该页一并刷新 */
    const vp = document.getElementById('oddsParlayPanelAi');
    if (vp && window.OddsParlay) window.OddsParlay.renderParlayPanel(vp, 3, AppState.matches);
  }
  if (page === 'compare' && typeof renderCompare === 'function') renderCompare();
  if (page === 'analysis' && AppState.matches.length) {
    renderAnalysisList(AppState.matches);
    /* 如果有选中比赛，同步渲染详情 */
    if (AppState.selectedIndex >= 0 && AppState.matches[AppState.selectedIndex]) {
      renderAnalysisDetail(AppState.matches[AppState.selectedIndex]);
    }
  }
  if (page === 'intelligence' && AppState.matches.length) renderIntelligence(AppState.matches);
  if (page === 'toolbox') renderToolbox();
  // 进场递进动画（每切页播放一次）
  playEntrance(el);
}

/* 页面进场递进动画：一次性播放，避免数据重渲染时重复触发 */
function playEntrance(pageEl) {
  if (!pageEl) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const sel = '.section-head, .kpi-card, .card, .intel-card, .breakdown-col, .rank-item, .parlay-card';
  const nodes = pageEl.querySelectorAll(sel);
  let i = 0;
  nodes.forEach(el => {
    // 跳过嵌套在另一卡片内的卡片，避免双重动画
    if (el.classList.contains('card') && el.parentElement && el.parentElement.closest('.card')) return;
    el.style.animation = 'none';
    void el.offsetWidth; // 强制重排以重置动画
    el.style.animation = 'cardIn .55s var(--ease-premium) backwards';
    el.style.animationDelay = (i * 45) + 'ms';
    i++;
  });
}

/* 磁吸微交互：按钮 / 导航随光标轻微位移（premium 手感） */
function setupMotion() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const sel = '.btn, .nav-tab';
  const MAX = 6;
  const easeIn = 'transform .12s cubic-bezier(.16,1,.3,1)';
  const easeOut = 'transform .45s cubic-bezier(.16,1,.3,1)';
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest && e.target.closest(sel);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - r.left - r.width / 2;
    const my = e.clientY - r.top - r.height / 2;
    const tx = Math.max(-MAX, Math.min(MAX, mx * 0.22));
    const ty = Math.max(-MAX, Math.min(MAX, my * 0.34));
    el.style.transition = easeIn;
    el.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
  }, { passive: true });
  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest && e.target.closest(sel);
    if (!el) return;
    if (el.contains(e.relatedTarget)) return; // 在子元素间移动不重置
    el.style.transition = easeOut;
    el.style.transform = '';
  });
}

/* ============================================
   数据加载（通过模块化 API 层）
   ============================================ */
async function loadMatches() {
  try {
    // 页面上可见的诊断（不依赖 console）
    const diag = window.__jcDiag = { steps: [], dataSource: '?', error: null };
    const logStep = (msg, ok) => {
      diag.steps.push((ok ? '✅' : '❌') + ' ' + msg);
      try { console.log('[jc] ' + msg); } catch (e) {}
      updateDiagPanel();
    };
    logStep('开始加载，fdKey: ' + (AppState.settings.footballKey || FOOTBALL_DATA_DEFAULT_KEY).slice(0,6) + '...', true);

    const proxyUrl = AppState.settings.proxyUrl || DEFAULT_PROXY_URL;
    let result;
    let dataSource = 'sporttery';

    if (proxyUrl) {
      // 优先 SCF 代理
      logStep('SCF 代理: ' + proxyUrl, true);
      const res = await fetch(proxyUrl + '/api/matches');
      result = { ok: res.ok, data: await res.json(), isProxy: true };
      dataSource = 'scf-proxy';
    } else {
      // 唯一数据源：中国竞彩官网（经本地/云端代理）
      // 规则：只展示中国竞彩选定的比赛，其他联赛一律不展示
      logStep('竞彩官网（经代理）...', true);
      result = await SportteryApi.getMatches('HAD');
      logStep('竞彩 → ' + (result.ok ? (result.data ? result.data.length + ' 场' : '0 场') : ('ERR: ' + result.error)), result.ok && result.data && result.data.length > 0);
      if (result.ok && result.data && result.data.length) {
        dataSource = 'sporttery';
      } else {
        // 竞彩无在售场次（如休赛期/时段无场次）→ 如实提示，不拿其他联赛充数
        logStep('今日无竞彩在售场次', false);
        result = { ok: false, error: '今日中国竞彩暂无在售场次（竞彩未选定比赛）' };
      }
    }

    // 竞彩无在售场次 = 正常空态（不报错），渲染"今日无竞彩场次"界面
    if (!result.ok || !result.data) {
      AppState.matches = [];
      AppState.dataSource = dataSource;
      updateDiagPanel();
      renderAll();
      toast('info', '📭', result.error || '今日中国竞彩暂无在售场次');
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
    } else if (dataSource.startsWith('football-data')) {
      matches = result.data || [];
    } else {
      matches = result.data || [];
    }

    AppState.matches = matches;
    AppState.dataSource = dataSource;
    // 更新"数据源"KPI 卡片
    const srcEl = document.getElementById('statSource');
    if (srcEl) {srcEl.textContent = dataSource.startsWith('football-data')
      ? 'football-data · ' + dataSource.split(':')[1]
      : (dataSource === 'scf-proxy' ? 'SCF 代理' : '竞彩官方');}
    updateDiagPanel();
    renderAll();
    recordOddsTick(); // P1+P2：把当前国内外赔率写入时序存储，供偏差/背离/热度分析
    const srcLabel = dataSource.startsWith('football-data')
      ? `（${dataSource.split(':')[1]} 联赛）`
      : (dataSource === 'scf-proxy' ? '（SCF 代理）' : '（竞彩官方）');
    if (matches.length === 0) {
      toast('info', '📭', '今日中国竞彩暂无在售场次，稍后刷新试试');
    } else {
      toast('success', '✅', `已加载 ${matches.length} 场竞彩场次（${srcLabel}）`);
    }
  } catch (e) {
    toast('error', '❌', '加载失败: ' + e.message);
    try { if (window.__jcDiag) window.__jcDiag.error = e.message; updateDiagPanel(); } catch (_) {}
  }
}

/**
 * 页面内诊断面板：把数据加载过程渲染到"数据源"KPI 卡片下方
 * 不依赖 console，任何浏览器都能看到
 */
function updateDiagPanel() {
  const el = document.getElementById('diagPanel');
  if (!el) return;
  const d = window.__jcDiag || { steps: [], dataSource: '?', error: null };
  const err = d.error ? `<div style="color:var(--c-red);">❌ 异常: ${esc(d.error)}</div>` : '';
  const steps = d.steps.length
    ? d.steps.map(s => `<div style="font-size:10px;line-height:1.5;">${s}</div>`).join('')
    : '<div style="font-size:10px;color:var(--text-muted);">等待加载...</div>';
  el.innerHTML = `<div style="margin-top:10px;padding:10px;background:var(--bg-card-hover);border:1px solid var(--border-color);border-radius:8px;">
    <div style="font-size:11px;font-weight:600;margin-bottom:6px;">🔍 数据源诊断</div>
    ${err}
    ${steps}
  </div>`;
}

/* ============================================
   渲染调度
   ============================================ */
let _entrancePlayed = false;
function renderAll() {
  renderDashboard(AppState.matches);
  renderAnalysisList(AppState.matches);
  renderIntelligence(AppState.matches);
  renderOddsMonitor(AppState.matches, AppState.selectedIndex);
  renderAIRecommendations(AppState.matches);
  // 串关面板必须跟随当日数据刷新：switchPage('ai') 只在切页瞬间渲染一次，
  // 若 AI 页在 loadMatches 完成前打开会残留历史 fallback，故这里补刷 AI 串关面板。
  // （赔率页 #oddsParlayPanel 已由 renderOddsMonitor 一并刷新）
  if (window.OddsParlay) {
    const pai = document.getElementById('oddsParlayPanelAi');
    if (pai) window.OddsParlay.renderParlayPanel(pai, 3, AppState.matches);
  }
  renderVerdict(AppState.matches);
  renderToolbox();

  // 首屏进场动画（仅首次渲染触发一次）
  if (!_entrancePlayed) {
    const ap = document.querySelector('.page.active');
    if (ap) playEntrance(ap);
    _entrancePlayed = true;
  }

  // KPI 补充（用 AppState.dataSource 显示真实来源）
  if (AppState.dataSource) {
    const src = AppState.dataSource;
    setText('statSource', src.startsWith('football-data') ? 'football-data' : (src === 'scf-proxy' ? 'SCF 代理' : '竞彩官方'));
  } else {
    setText('statSource', '竞彩官方');
  }
}

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  /* ============================================
     赔率时序记录（P1 存储层 + P2 采集轮询）
     把每一时刻的国内外赔率写入 OddsHistory，形成可按比赛查询的时间序列，
     供后续「偏差/背离/收敛」分析、市场热度监测、异动预警使用。
       - 国内(竞彩): 每次刷新都记录，无外部请求、零成本。
       - 国际: 需 The Odds API Key，免费配额仅 500/月，默认关闭(opt-in)，
               开启后节流(默认 15 分钟一次)以保命配额。
     ============================================ */
  let _lastIntlFetch = 0;

  /**
   * 采集一次快照：国内必记，国际按需节流
   */
  async function recordOddsTick() {
    if (typeof OddsHistory === 'undefined') return;
    if (!AppState.matches || !AppState.matches.length) return;

    // 国内快照：每场竞彩 odds（始终记录）
    const recs = AppState.matches.map(function (m) {
      const mid = m.code || (m.homeTeam + '_vs_' + m.awayTeam);
      return {
        matchId: mid,
        jc: m.odds ? { h: m.odds.h, d: m.odds.d, a: m.odds.a } : null,
        meta: {
          league: m.league, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
          handicap: m.handicap, kickoff: m.time
        }
      };
    });

    // 国际快照：可选 + 节流（保护配额）
    const intlByMatch = {};
    const key = AppState.settings.oddsKey || '';
    const wantIntl = AppState.settings.recordIntl === true;
    const intlIntervalMs = (AppState.settings.intlInterval || 15) * 60 * 1000;
    const now = Date.now();
    if (wantIntl && key && typeof OddsApi !== 'undefined' && (now - _lastIntlFetch) >= intlIntervalMs) {
      _lastIntlFetch = now;
      try {
        const r = await OddsApi.getOdds(null, key, AppState.matches);
        if (r.ok && r.data && r.data.length) {
          const matched = OddsApi.matchByTime(AppState.matches, r.data);
          matched.forEach(function (item) {
            const mid = item.jcMatch.code || (item.jcMatch.homeTeam + '_vs_' + item.jcMatch.awayTeam);
            intlByMatch[mid] = [{
              book: '国际均值',
              h: item.intOdd.odds.h, d: item.intOdd.odds.d, a: item.intOdd.odds.a
            }];
          });
        }
      } catch (e) { /* 国际拉取失败：降级为仅国内记录 */ }
    }

    await Promise.all(recs.map(function (rec) {
      rec.intl = intlByMatch[rec.matchId] || [];
      return OddsHistory.record(rec.matchId, rec).catch(function () {});
    }));

    // P6 异动提醒：比对本次与上次赔率，跨越阈值则第一时间站内 toast（带去重）
    if (typeof OddsAlert !== 'undefined') {
      const prevOdds = AppState._prevOdds || {};
      const wasMove = AppState._prevMove || {};
      const now = Date.now();
      const newlyMoving = [];
      AppState.matches.forEach(function (m) {
        const mid = m.code || (m.homeTeam + '_vs_' + m.awayTeam);
        const p = prevOdds[mid];
        if (p && m.odds) {
          const mv = OddsAlert.detectFromOdds(p, m.odds, { fromTs: 0, toTs: now });
          const key = mid + '|' + (mv ? mv.side : '');
          if (mv && !wasMove[key]) newlyMoving.push({ m: m, mv: mv });
          wasMove[key] = !!mv;
        }
        prevOdds[mid] = m.odds;
      });
      AppState._prevOdds = prevOdds;
      AppState._prevMove = wasMove;
      newlyMoving.forEach(function (item) {
        const m = item.m, mv = item.mv;
        const label = (m.homeTeam || '') + ' vs ' + (m.awayTeam || '');
        const dirText = mv.direction === 'in' ? '资金流入（赔率压低）' : '资金流出（赔率上升）';
        const action = mv.direction === 'in' ? 'follow' : 'fade';
        OddsAlert.showToast({
          matchLabel: label, sideZh: mv.sideZh, direction: mv.direction,
          impDeltaPp: mv.impDeltaPp, action: action,
          body: mv.sideZh + ' ' + dirText + ' ' + Math.abs(mv.impDeltaPp).toFixed(1) + 'pp（' + mv.fromOdds.toFixed(2) + '→' + mv.toOdds.toFixed(2) + '）',
          headline: label + ' ' + mv.sideZh + '异动', ttl: 9000
        });
      });
    }
  }

  /**
   * 启动时序记录：初始化存储 + 周期轮询（国内连续、国际由 recordOddsTick 内部节流）
   */
  function initOddsRecording() {
    if (typeof OddsHistory === 'undefined') return;
    OddsHistory.init().catch(function () {});
    // 首屏稍后记录一次（等比赛列表就绪）
    setTimeout(function () { recordOddsTick(); }, 2000);
    // 周期性记录
    const recInterval = (AppState.settings.recordingInterval || 60) * 1000;
    setInterval(function () { recordOddsTick(); }, recInterval);
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
   注：此函数由 dashboard 渲染的 onclick 调用（全局），非 JS 内部引用
   ============================================ */
/* eslint-disable-next-line no-unused-vars */
function openAnalysisDetail(idx) {
  AppState.selectedIndex = idx;
  /* 同步刷新：赔率监测 + AI 研判 + 深度分析详情 */
  renderOddsMonitor(AppState.matches, idx);
  renderAnalysisList(AppState.matches);
  renderAnalysisDetail(AppState.matches[idx]);
  /* 如果当前不在深度分析页，切换过去 */
  const analysisPage = document.getElementById('page-analysis');
  if (analysisPage && !analysisPage.classList.contains('active')) {
    switchPage('analysis');
  }
}

/* 赔率监测页：切换比赛 */
/* eslint-disable-next-line no-unused-vars */
function switchOddsMatch(dir) {
  const n = AppState.matches.length;
  if (!n) return;
  AppState.selectedIndex = (AppState.selectedIndex + dir + n) % n;
  renderOddsMonitor(AppState.matches, AppState.selectedIndex);
  /* 同步刷新深度分析 */
  renderAnalysisList(AppState.matches);
  renderAnalysisDetail(AppState.matches[AppState.selectedIndex]);
}

/* ============================================
   价值注扫描
   ============================================ */
async function scanValueBets() {
  // 从输入/设置读 key
  const key = AppState.settings.oddsKey || '';
  if (!key) {
    toast('warn', '⚠️', '请先配置 The Odds API Key');
    showKeySetup();
    return;
  }
  await scanValueBetsModular(AppState.matches, async () => {
    // 传入竞彩比赛列表 → 自动检测联赛 → 多运动并行拉取
    // 返回完整结果对象（含 ok/error/diagnosis/quota），由 scanValueBetsModular 处理
    const r = await OddsApi.getOdds(null, key, AppState.matches);
    if (r.ok) {
      r._data = r.data;
      return r;
    }
    // 传播真实错误 + 诊断信息
    r._error = r.error || '未知错误';
    return r;
  });
}

/* ============================================
   API Key 可视化设置
   ============================================ */
function showKeySetup() {
  const el = document.getElementById('valueBetListModular');
  if (!el) return;
  const current = AppState.settings.oddsKey || '';
  el.innerHTML = `
    <div style="padding:14px;background:var(--c-amber-dim);border-radius:8px;border:1px solid var(--c-amber);">
      <div style="font-size:13px;font-weight:600;color:var(--c-amber);margin-bottom:8px;">⚠️ 未配置 The Odds API Key</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.6;">
        免费版 500 次/月，<a href="https://the-odds-api.com/" target="_blank" style="color:var(--c-blue);">the-odds-api.com</a> 注册即可
      </div>
      <div style="display:flex;gap:8px;">
        <input type="text" id="oddsKeyInput" placeholder="粘贴 API Key（形如 ghp_xxx 或纯随机串）"
          value="${esc(current)}"
          style="flex:1;padding:8px 10px;border:1px solid var(--border-strong);border-radius:6px;font-size:12px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-primary);" />
        <button class="btn btn-primary" id="saveKeyBtn" style="font-size:12px;">💾 保存</button>
        <button class="btn" id="clearKeyBtn" style="font-size:12px;">清除</button>
      </div>
      <div id="keyTestStatus" style="margin-top:8px;font-size:11px;"></div>
    </div>`;
  // 绑定
  const saveBtn = document.getElementById('saveKeyBtn');
  const clearBtn = document.getElementById('clearKeyBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveOddsKey);
  if (clearBtn) clearBtn.addEventListener('click', clearOddsKey);
}

/**
 * 保存 API Key 到 localStorage
 */
async function saveOddsKey() {
  const input = document.getElementById('oddsKeyInput');
  const status = document.getElementById('keyTestStatus');
  if (!input || !status) return;
  const key = input.value.trim();
  if (!key) {
    status.innerHTML = '<span style="color:var(--c-red);">❌ Key 不能为空</span>';
    return;
  }
  status.innerHTML = '<span style="color:var(--text-muted);">⏳ 验证 Key...</span>';
  // 真实验证：传入竞彩比赛自动检测联赛
  const r = await OddsApi.getOdds(null, key, AppState.matches);
  if (r.ok) {
    AppState.settings.oddsKey = key;
    localStorage.setItem('jc_settings', JSON.stringify(AppState.settings));
    const sportInfo = r.sportKeys ? '（' + r.sportKeys.join(', ') + '）' : '';
    const quotaInfo = r.quota ? ' · 本月已用 ' + r.quota.used + '/' + r.quota.total + ' 次' : '';
    status.innerHTML = `<span style="color:var(--c-green);">✅ Key 有效，找到 ${r.data.length} 场国际赔率${sportInfo}${quotaInfo}</span>`;
    if (typeof renderQuotaBar === 'function') renderQuotaBar(r.quota);
    toast('success', '✅', 'API Key 已保存，可扫描价值注');
    setTimeout(() => scanValueBets(), 1000);
  } else {
    status.innerHTML = `<span style="color:var(--c-red);">❌ ${esc(r.error)}</span>`;
    if (r.quota && typeof renderQuotaBar === 'function') renderQuotaBar(r.quota);
  }
}

function clearOddsKey() {
  AppState.settings.oddsKey = '';
  localStorage.removeItem('jc_settings');
  showKeySetup();
  toast('info', '🗑', 'API Key 已清除');
}

/* ============================================
   今日推荐模型加载（真实校准 + 欧盘历史偏差先验）
   ============================================ */
async function loadRecommendModel() {
  const files = {
    calib: 'js/engine/calibration.json',
    leagueCal: 'js/engine/league_calibration.json',
    asian: 'js/engine/asian_handicap.json',
    euGap: 'js/engine/eu_jc_gap.json'
  };
  try {
    const entries = await Promise.all(
      Object.entries(files).map(async ([k, url]) => {
        const res = await fetch(url);
        return [k, res.ok ? await res.json() : null];
      })
    );
    const model = {};
    entries.forEach(([k, v]) => { model[k] = v; });
    window.JC_MODEL = model;
    console.log('[jc] 今日推荐模型已加载', Object.keys(model).filter(k => model[k]).join('/'));
  } catch (e) {
    console.warn('[jc] 今日推荐模型加载失败', e.message);
    window.JC_MODEL = null;
  }
}

/* ============================================
   初始化
   ============================================ */
/* ============================================
   主题切换（亮 / 暗 / 系统）—— 联动 Ardot「JCZ Pro」暗色令牌
   ============================================ */
function setupTheme() {
  const root = document.documentElement;
  const sw = document.getElementById('themeSwitch');
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function stored() {
    try { return localStorage.getItem('jc-theme') || 'dark'; } catch (e) { return 'dark'; }
  }
  function apply(theme) {
    let t = theme;
    if (t === 'system') t = (mq && mq.matches) ? 'dark' : 'light';
    root.setAttribute('data-theme', t);
    if (sw) sw.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.themeSet === theme));
  }
  apply(stored());
  if (sw) sw.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      const t = b.dataset.themeSet;
      try { localStorage.setItem('jc-theme', t); } catch (e) {}
      apply(t);
    });
  });
  if (mq) {
    const onSys = () => { if (stored() === 'system') apply('system'); };
    if (mq.addEventListener) mq.addEventListener('change', onSys);
    else if (mq.addListener) mq.addListener(onSys);
  }
}

function setupParlayDouble() {
  var toggle = document.getElementById('parlayDoubleToggle');
  if (!toggle) return;
  var init0 = !!window.OddsParlay && window.OddsParlay.getOption && window.OddsParlay.getOption('useDouble');
  toggle.checked = !!init0;
  toggle.addEventListener('change', function () {
    if (window.OddsParlay && window.OddsParlay.setOption) window.OddsParlay.setOption('useDouble', toggle.checked);
    var p = document.getElementById('oddsParlayPanelAi');
    if (p && window.OddsParlay) window.OddsParlay.renderParlayPanel(p, 3, AppState.matches);
  });
}

function init() {
  // 主题（亮/暗/系统）
  setupTheme();
  // 磁吸微交互
  setupMotion();

  // 读取设置
  try {
    const saved = JSON.parse(localStorage.getItem('jc_settings') || '{}');
    AppState.settings = saved;
  } catch (e) { /* 无设置 */ }

  // 从 URL 参数读取 proxy / direct
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('proxy')) AppState.settings.proxyUrl = params.get('proxy');
    if (params.get('direct') === '1') AppState.settings.direct = true;
  } catch (e) { /* 忽略 */ }

  // 代理基地址（本地/云端统一）：
  //   - 本地预览：proxyUrl 为空 → JC_API_BASE='' → 同源 /api/sporttery、/api/football 走 local_server.py
  //   - 云端 SCF：proxyUrl=云函数域名 → JC_API_BASE=该域名 → /api/sporttery、/api/football 走云函数
  //   - 云端纯静态直连：?direct=1 → JC_API_BASE='' + JC_DIRECT=true → 直连竞彩官网（CORS 开放）
  window.JC_API_BASE = (AppState.settings.proxyUrl || '').replace(/\/+$/, '');
  window.JC_DIRECT = AppState.settings.direct === true;

  // 自动检测：非 localhost 且未设代理时，自动启用直连模式（竞彩官网 CORS 全开放）
  if (!window.JC_API_BASE && !window.JC_DIRECT) {
    const host = location.hostname || '';
    const isLocal = (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '');
    if (!isLocal) {
      window.JC_DIRECT = true;
      console.log('[jc] 非本地环境，自动启用直连模式');
    }
  }

  // 路由绑定
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchPage(tab.dataset.page));
  });

  // 刷新按钮
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadMatches);

  // 设置按钮
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);

  // 价值注扫描
  const scanBtn = document.getElementById('scanValueBtn');
  if (scanBtn) scanBtn.addEventListener('click', scanValueBets);

  // 赛果复盘（默认日期 + 按钮绑定）
  if (typeof window.initCompare === 'function') window.initCompare();

  // 串关「单场双选」开关（研判结论页）
  setupParlayDouble();

  // 自动刷新
  let interval = (parseInt(AppState.settings.refreshInterval) || 30) * 1000;
  const sel = document.getElementById('refreshIntervalSelect');
  if (sel) {
    sel.addEventListener('change', () => {
      interval = parseInt(sel.value) * 1000;
    });
  }
  setInterval(() => loadMatches(), interval);

  // 加载 ML 模型 + 校准表（异步，不影响首屏）
  if (typeof MLModel !== 'undefined' && typeof Calibration !== 'undefined') {
    Promise.all([MLModel.loadModel('js/engine/mlModel.json'), Calibration.loadCalibration('js/engine/calibration.json')])
      .then(() => {
        toast('success', '🧠', 'AI 模型 + 真实置信度已加载（' + (Calibration.isCalibrated() ? Calibration.__nMatches() + ' 场历史校准' : '') + '）');
      })
      .catch(() => { /* 降级：继续用 Elo */ });
  }

  // 加载「今日推荐」真实模型：校准表 + 联赛校准 + 亚盘分布 + 欧盘历史偏差先验
  // 这些 JSON 由 ml/build_real_model.py 与 ml/build_eu_history.py 生成（基于 4399 场真实竞彩 + 1157 场欧盘历史）
  loadRecommendModel();

  // P1+P2：启动赔率时序记录（国内连续、国际节流），为偏差/背离/热度分析积累数据
  initOddsRecording();

  // 首屏加载
  loadMatches();
}

document.addEventListener('DOMContentLoaded', init);

/* ============================================
   设置弹窗（⚙️ 右上角）
   ============================================ */
function openSettings() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  // 填充当前值
  const proxyInput = document.getElementById('settingsProxyUrl');
  if (proxyInput) proxyInput.value = AppState.settings.proxyUrl || DEFAULT_PROXY_URL;
  const keyInput = document.getElementById('settingsOddsKey');
  if (keyInput) keyInput.value = AppState.settings.oddsKey || '';
  const fdInput = document.getElementById('settingsFootballKey');
  if (fdInput) fdInput.value = AppState.settings.footballKey || '';
  modal.style.display = 'flex';
}

function closeSettings() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.style.display = 'none';
}

/* eslint-disable-next-line no-unused-vars -- 由 HTML onclick 调用 */
function saveSettings() {
  const proxyInput = document.getElementById('settingsProxyUrl');
  const keyInput = document.getElementById('settingsOddsKey');
  if (proxyInput) AppState.settings.proxyUrl = proxyInput.value.trim();
  if (keyInput) AppState.settings.oddsKey = keyInput.value.trim();
  const fdInput = document.getElementById('settingsFootballKey');
  if (fdInput) AppState.settings.footballKey = fdInput.value.trim();
  try {
    localStorage.setItem('jc_settings', JSON.stringify(AppState.settings));
  } catch (e) { /* 存储失败忽略 */ }
  closeSettings();
  toast('success', '✅', '设置已保存');
  // 若保存了 Key 且当前页是 AI 研判，自动扫描
  if (AppState.settings.oddsKey) {
    setTimeout(() => scanValueBets(), 500);
  }
}

/* 点击弹窗遮罩关闭 */
document.addEventListener('click', (e) => {
  const modal = document.getElementById('settingsModal');
  if (modal && e.target === modal) closeSettings();
});
