/**
 * aiAnalysis.js — AI 研判组件
 * 竞彩智选 Pro · 模块化版
 * 依赖：utils.js (esc/deVigOdds)、predictor.js (eloPredict/findValueBets)
 */

/* 依赖解析：浏览器用全局，Node 用 require */
let esc, deVigOdds, eloPredict, findValueBets, CONFIG;
if (typeof window !== 'undefined' && window.esc) {
  esc = window.esc; deVigOdds = window.deVigOdds; eloPredict = window.eloPredict;
  findValueBets = window.findValueBets; CONFIG = window.CONFIG;
} else {
  const utils = require('../core/utils.js');
  const predictor = require('../engine/predictor.js');
  esc = utils.esc; deVigOdds = utils.deVigOdds;
  eloPredict = predictor.eloPredict; findValueBets = predictor.findValueBets;
  CONFIG = require('../../config/config.js');
}

/* ============================================
   渲染 AI 推荐列表
   ============================================ */
function renderAIRecommendations(matches) {
  const listEl = document.getElementById('aiRecList');
  if (!listEl) return;

  if (!matches.length) {
    listEl.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">暂无推荐数据</div>';
    return;
  }

  // 计算每场推荐 + 置信度
  const recs = matches.slice(0, 6).map(m => {
    const h = m.homeTeam || m.homeName || '主队';
    const a = m.awayTeam || m.awayName || '客队';
    const odds = m.odds || {};

    let probs, conf;
    if (odds.h && odds.h > 1) {
      const p = deVigOdds(odds.h, odds.d || 3.3, odds.a || 3.4);
      probs = { homeWin: p.pH, draw: p.pD, awayWin: p.pA };
    } else {
      const e = eloPredict(1600, 1500);
      probs = { homeWin: e.homeWin / 100, draw: e.draw / 100, awayWin: e.awayWin / 100 };
    }
    conf = Math.max(probs.homeWin, probs.draw, probs.awayWin);

    let pred, predClass, betOdd;
    if (probs.homeWin >= probs.draw && probs.homeWin >= probs.awayWin) {
      pred = '主胜'; predClass = 'win'; betOdd = odds.h || 0;
    } else if (probs.draw >= probs.awayWin) {
      pred = '平局'; predClass = 'draw'; betOdd = odds.d || 0;
    } else {
      pred = '客胜'; predClass = 'lose'; betOdd = odds.a || 0;
    }

    return {
      match: `${h} vs ${a}`,
      code: m.code || '',
      league: m.league || '竞彩',
      pred, predClass,
      odds: betOdd ? betOdd.toFixed(2) : '--',
      conf: (conf * 100).toFixed(0) + '%'
    };
  });

  listEl.innerHTML = recs.map(r => `
    <div class="recommend-item" style="display:flex;align-items:center;gap:12px;padding:10px;border-bottom:1px solid var(--border-color);">
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:600;">
          <span class="badge badge-blue" style="font-size:10px;margin-right:6px;">${esc(r.code)}</span>${esc(r.match)}
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${esc(r.league)}</div>
      </div>
      <span class="badge ${r.predClass === 'win' ? 'badge-green' : r.predClass === 'draw' ? 'badge-amber' : 'badge-red'}" style="font-size:12px;">
        ${r.pred === '主胜' ? '✓' : r.pred === '平局' ? '○' : '✗'} ${esc(r.pred)}
      </span>
      <span style="font-family:var(--font-mono);font-size:13px;">@ ${r.odds}</span>
      <span style="font-size:11px;color:var(--text-muted);">${r.conf}</span>
    </div>`).join('');
}

/* ============================================
   价值注检测渲染
   ============================================ */
async function scanValueBetsModular(jcMatches, getIntOdds) {
  const listEl = document.getElementById('valueBetListModular');
  if (!listEl) return;

  listEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12px;">⏳ 正在对比国际赔率...</div>';
  try {
    const intOdds = await getIntOdds();
    if (!intOdds || !intOdds.length) {
      listEl.innerHTML = '<div style="padding:10px;color:var(--c-amber);font-size:12px;">未获取到国际赔率，请检查 API Key</div>';
      return;
    }

    const bets = [];
    jcMatches.forEach(m => {
      const odds = m.odds;
      if (!odds || !odds.h) return;
      // 球队名匹配（简化：取前 4 字符）
      const match = intOdds.find(i => {
        const hn = (i.homeTeam || '').toLowerCase();
        const an = (i.awayTeam || '').toLowerCase();
        const h4 = (m.homeTeam || '').slice(0, 4).toLowerCase();
        const a4 = (m.awayTeam || '').slice(0, 4).toLowerCase();
        return h4 && a4 && (hn.includes(h4) || h4.includes(hn.slice(0, 4))) &&
          (an.includes(a4) || a4.includes(an.slice(0, 4)));
      });
      if (!match) return;

      const valueBets = findValueBets(
        { h: odds.h, d: odds.d, a: odds.a },
        { h: match.odds.h, d: match.odds.d, a: match.odds.a },
        CONFIG.thresholds.valueBet
      );
      valueBets.forEach(v => {
        bets.push({
          code: m.code || '',
          match: `${m.homeTeam} vs ${m.awayTeam}`,
          league: m.league || '',
          ...v
        });
      });
    });

    if (!bets.length) {
      listEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12px;">未找到价值注 — 竞彩与国际赔率接近</div>';
      return;
    }

    listEl.innerHTML = bets.slice(0, 8).map(b => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid var(--border-color);font-size:12px;">
        <span style="font-family:var(--font-mono);color:var(--c-blue);min-width:60px;">${esc(b.code)}</span>
        <span style="flex:1;">${esc(b.match)}</span>
        <span style="color:var(--c-amber);font-weight:600;">${esc(b.pick)}</span>
        <span style="font-family:var(--font-mono);">@${b.jcOdds.toFixed(2)}</span>
        <span style="font-size:11px;color:var(--c-green);">价值 +${b.valuePct}pp</span>
      </div>`).join('') +
      `<div style="padding:8px;font-size:11px;color:var(--text-muted);">💡 共 ${bets.length} 个价值注</div>`;
  } catch (e) {
    listEl.innerHTML = `<div style="padding:10px;color:var(--c-red);font-size:12px;">❌ 扫描失败：${esc(e.message)}</div>`;
  }
}

/* ============================================
   导出
   ============================================ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderAIRecommendations, scanValueBetsModular };
}
if (typeof window !== 'undefined') {
  window.renderAIRecommendations = renderAIRecommendations;
  window.scanValueBetsModular = scanValueBetsModular;
}
