/**
 * intelligence.js — 情报矩阵组件
 * 竞彩智选 Pro · 模块化版
 * 设计稿「情报矩阵」页：6 张情报卡（球队战意 / 身价 / 伤病停赛 / 天气球场 / 裁判信息 / 德比特殊）
 * 数据来源：真实 match 字段 + 模型估算（无历史数据时如实标注），每卡带 advice 层
 */

(function() {
  let esc, deVigOdds, calibrateProbability;
  if (typeof window !== 'undefined' && window.esc) {
    esc = window.esc;
    deVigOdds = window.deVigOdds;
    calibrateProbability = window.Calibration ? window.Calibration.calibrateProbability : null;
  } else {
    const utils = require('../core/utils.js');
    esc = utils.esc;
    deVigOdds = utils.deVigOdds;
    try { calibrateProbability = require('../engine/calibration.js').calibrateProbability; } catch (e) { calibrateProbability = null; }
  }

  /* 当前选中的比赛索引（默认 0） */
  let _intelIdx = 0;

  /* ============================================
   比赛选择器（情报矩阵页顶部）
   ============================================ */
  function bindIntelSelector(matches) {
    const sel = document.getElementById('intelMatchSelect');
    if (!sel || sel.dataset.bound) return;
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => {
      _intelIdx = parseInt(sel.value, 10) || 0;
      renderIntelligence(matches);
    });
  }

  function renderIntelSelector(matches) {
    const sel = document.getElementById('intelMatchSelect');
    if (!sel) return;
    sel.innerHTML = matches.map((m, i) => {
      const h = m.homeTeam || m.homeName || '主队';
      const a = m.awayTeam || m.awayName || '客队';
      return `<option value="${i}" ${i === _intelIdx ? 'selected' : ''}>${esc(h)} vs ${esc(a)}</option>`;
    }).join('');
  }

  /* 从赔率推导战意/身价等估算（标注"模型估算"） */
  function deriveIntel(odds) {
    if (!odds || !odds.h || odds.h <= 1) {
      return { homeStrength: 0.5, awayStrength: 0.5, drawRate: 0.25, totalImplied: 0 };
    }
    const p = deVigOdds(odds.h, odds.d || 3.3, odds.a || 3.4);
    const totalImplied = (1 / odds.h + 1 / (odds.d || 3.3) + 1 / (odds.a || 3.4));
    return { homeStrength: p.pH, awayStrength: p.pA, drawRate: p.pD, totalImplied: totalImplied };
  }

  /* ============================================
   单张情报卡渲染（统一结构）
   ============================================ */
  function card(title, icon, bodyHtml, advice) {
    const advClass = advice.level === 'good' ? 'intel-advice good'
      : advice.level === 'warn' ? 'intel-advice warn'
      : advice.level === 'bad' ? 'intel-advice bad' : 'intel-advice';
    return `
    <div class="intel-card">
      <div class="intel-card-head"><span class="intel-icon">${icon}</span><span class="intel-card-title">${esc(title)}</span></div>
      <div class="intel-card-body">${bodyHtml}</div>
      <div class="${advClass}">💡 ${esc(advice.text)}</div>
    </div>`;
  }

  /* ============================================
   渲染情报矩阵
   ============================================ */
  function renderIntelligence(matches) {
    const grid = document.getElementById('intelGrid');
    if (!grid) return;
    if (!matches || !matches.length) {
      grid.innerHTML = '<div class="empty-hint" style="padding:40px;text-align:center;">今日中国竞彩暂无在售场次 — 加载后自动填充情报矩阵</div>';
      return;
    }
    bindIntelSelector(matches);
    renderIntelSelector(matches);

    const m = matches[_intelIdx] || matches[0];
    const h = m.homeTeam || m.homeName || '主队';
    const a = m.awayTeam || m.awayName || '客队';
    const odds = m.odds || {};
    const d = deriveIntel(odds);

    /* 1. 球队战意 */
    const homeWinPct = (d.homeStrength * 100).toFixed(0);
    const awayWinPct = (d.awayStrength * 100).toFixed(0);
    const motiveBody = `
      <div class="intel-line"><span class="il-k">${esc(h)}</span><span class="il-v" style="color:var(--c-green);">争胜意愿 ${homeWinPct}%</span></div>
      <div class="intel-line"><span class="il-k">${esc(a)}</span><span class="il-v" style="color:var(--c-red);">争胜意愿 ${awayWinPct}%</span></div>
      <div class="intel-line muted">联赛排名 / 保级压力 / 杯赛优先级：模型估算，无实时积分数据</div>`;
    const motiveAdvice = d.homeStrength - d.awayStrength > 0.12
      ? { level: 'good', text: `主队战意明显占优，优先考虑主胜方向` }
      : d.awayStrength - d.homeStrength > 0.12
        ? { level: 'good', text: `客队战意占优，关注客胜方向` }
        : { level: 'warn', text: `双方战意接近，谨慎对待让球盘` };

    /* 2. 球队身价 */
    const marketVal = (d.totalImplied > 0) ? (1 / d.totalImplied * 100).toFixed(1) : '--';
    const valueBody = `
      <div class="intel-line"><span class="il-k">市场预期强度</span><span class="il-v">${marketVal}%</span></div>
      <div class="intel-line muted">身价/阵容价值暂无实时源，以赔率返还率作替代标尺</div>`;
    const valueAdvice = d.homeStrength > 0.5
      ? { level: 'good', text: `市场更看好主队，与赔率隐含一致` }
      : d.awayStrength > 0.45
        ? { level: 'warn', text: `客队被市场高看，注意价值是否在赔率中已被定价` }
        : { level: 'warn', text: `身价预期均衡，难有单边错价` };

    /* 3. 伤病停赛 */
    const injuryBody = `<div class="intel-line muted">暂无实时伤病/停赛数据源</div>
      <div class="intel-line muted">建议赛前 1 小时刷新竞彩官方大名单</div>`;
    const injuryAdvice = { level: 'warn', text: `伤病为关键变量，下注前务必核对双方首发` };

    /* 4. 天气球场 */
    const weatherBody = `<div class="intel-line"><span class="il-k">比赛时段</span><span class="il-v">${esc(m.time || m.date || '待定')}</span></div>
      <div class="intel-line muted">天气 / 草坪状况暂无实时源，雨天通常压低进球预期</div>`;
    const weatherAdvice = { level: 'warn', text: `不利天气可能压低大小球，关注进球数盘下修` };

    /* 5. 裁判信息 */
    const refBody = `<div class="intel-line muted">暂无当值裁判数据源</div>
      <div class="intel-line muted">裁判尺度影响黄牌/点球预期（角球、进球玩法相关）</div>`;
    const refAdvice = { level: 'warn', text: `严哨裁判利好「小球 + 角球多」组合，需赛前确认` };

    /* 6. 德比特殊 */
    const isDerby = !!m.isDerby;
    const derbyBody = isDerby
      ? `<div class="intel-line"><span class="il-k">德比战</span><span class="il-v" style="color:var(--c-red);">已识别</span></div>
         <div class="intel-line muted">德比战历史常有冷门，赔率分歧大</div>`
      : `<div class="intel-line muted">本场非德比 / 同城战</div>`;
    const derbyAdvice = isDerby
      ? { level: 'bad', text: `德比战波动大，规避重仓，优先小注跟随市场` }
      : { level: 'good', text: `非德比，按模型常规方向处理即可` };

    grid.innerHTML = [
      card('球队战意', '🔥', motiveBody, motiveAdvice),
      card('球队身价', '💰', valueBody, valueAdvice),
      card('伤病停赛', '🩹', injuryBody, injuryAdvice),
      card('天气球场', '🌦️', weatherBody, weatherAdvice),
      card('裁判信息', '🟨', refBody, refAdvice),
      card('德比特殊', '⚔️', derbyBody, derbyAdvice)
    ].join('');
  }

  /* ============================================
   导出
   ============================================ */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderIntelligence, renderIntelSelector, bindIntelSelector };
  }
  if (typeof window !== 'undefined') {
    window.renderIntelligence = renderIntelligence;
    window.renderIntelSelector = renderIntelSelector;
    window.bindIntelSelector = bindIntelSelector;
  }

})();
