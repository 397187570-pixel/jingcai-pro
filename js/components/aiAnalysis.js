/**
 * aiAnalysis.js — AI 研判组件
 * 竞彩智选 Pro · 模块化版
 * 依赖：utils.js (esc/deVigOdds)、predictor.js (eloPredict/findValueBets)
 */

(function() {
/* 依赖解析：浏览器用全局，Node 用 require */
let esc, deVigOdds, eloPredict, findValueBets, CONFIG, calibrateProbability;
if (typeof window !== 'undefined' && window.esc) {
  esc = window.esc; deVigOdds = window.deVigOdds; eloPredict = window.eloPredict;
  findValueBets = window.findValueBets; CONFIG = window.CONFIG;
  calibrateProbability = window.Calibration ? window.Calibration.calibrateProbability : null;
} else {
  const utils = require('../core/utils.js');
  const predictor = require('../engine/predictor.js');
  esc = utils.esc; deVigOdds = utils.deVigOdds;
  eloPredict = predictor.eloPredict; findValueBets = predictor.findValueBets;
  CONFIG = require('../../config/config.js');
  try { calibrateProbability = require('../engine/calibration.js').calibrateProbability; } catch (e) { calibrateProbability = null; }
}

/* ============================================
   渲染 AI 推荐列表（今日推荐 · 真实校准 + 价值信号）
   依赖：window.Recommend (recommend.js) + window.JC_MODEL (4 个 JSON)
   ============================================ */
function renderAIRecommendations(matches) {
  const listEl = document.getElementById('aiRecList');
  if (!listEl) return;

  if (!matches.length) {
    listEl.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">暂无推荐数据</div>';
    return;
  }

  const M = window.JC_MODEL;
  const haveModel = typeof window.Recommend === 'function' || (window.Recommend && window.Recommend.recommend);

  // 方法论说明横幅
  let banner = '';
  if (haveModel) {
    banner = '<div style="padding:10px 12px;margin-bottom:12px;background:var(--c-amber-dim);border:1px solid var(--c-amber);border-radius:8px;font-size:11px;line-height:1.7;color:var(--text-secondary);">'
      + '<b style="color:var(--c-amber);">📌 预测依据</b>：方向 = 竞彩隐含概率经 4399 场真实校准（Brier≈0.0005）；'
      + '价值信号 = 未拉取实时欧盘时, 采用「模型概率 − 竞彩市场概率」的模型价值边际(欧盘历史先验 eu_jc_gap.json 作参考标尺, ≥+5% 才标记, 超过历史 p90 为极强); 拉取实时欧盘后升级为竞彩 vs 欧盘实时偏差(突破历史 p90 标记)。'
      + '<br><b style="color:var(--c-red);">⚠️ 风险提示</b>：竞彩固定抽水约 12.9%，长期数学期望为负（负 EV）。本面板为概率参考，'
      + '任何单场都不构成「稳赚」，请严格仓位管理、切勿追高。'
      + '</div>';
  }

  const cards = matches.map((m, idx) => {
    const h = m.homeTeam || m.homeName || '主队';
    const a = m.awayTeam || m.awayName || '客队';
    const odds = m.odds || {};
    const goalLine = m.handicap != null && m.handicap !== '' ? Number(m.handicap) : null;

    // 优先用真实推荐模型
    if (haveModel && odds.h && odds.h > 1) {
      const m2 = {
        league: m.league || '竞彩',
        homeTeam: h, awayTeam: a,
        jc: [odds.h, odds.d || 3.3, odds.a || 3.4],
        eu: (m.eu && m.eu.length === 3) ? m.eu : null,
        goalLine: goalLine
      };
      const r = window.Recommend.recommend(m2, M && M.calib, M && M.leagueCal, M && M.asian, M && M.euGap);
      const dirClass = r.direction === 'home' ? 'badge-green' : r.direction === 'draw' ? 'badge-amber' : 'badge-red';
      const dirIcon = r.direction === 'home' ? '✓' : r.direction === 'draw' ? '○' : '✗';
      const confPct = (r.directionConfidence * 100).toFixed(1);
      const barColor = r.directionConfidence >= 0.6 ? 'var(--c-green)' : r.directionConfidence >= 0.5 ? 'var(--c-amber)' : 'var(--c-red)';

      // 价值信号
      let valueHtml = '<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">📡 价值信号：未加载模型校准数据</div>';
      if (r.valueSignal) {
        const vs = r.valueSignal;
        const side = vs.bestValueSide;
        const sideZh = side === 'home' ? '主胜' : side === 'draw' ? '平' : '客胜';
        const pct = vs.percentile && vs.percentile[side] != null ? ('历史分位 ' + vs.percentile[side] + '%') : '';
        const z = vs.zscore && vs.zscore[side] != null ? ('z=' + vs.zscore[side]) : '';
        if (vs.flagged[side]) {
          if (vs.euFree) {
            const strong = (vs.strong && vs.strong[side]) ? '💎💎 超欧盘历史 p90' : '💎 模型价值';
            valueHtml = '<div style="font-size:11px;color:var(--c-green);margin-top:6px;font-weight:600;">'
              + strong + '：' + sideZh + ' 模型概率高于竞彩定价 +' + (vs.bestValue * 100).toFixed(1) + '%（'
              + pct + ' ' + z + ' · 欧盘历史先验作标尺）</div>';
          } else {
            valueHtml = '<div style="font-size:11px;color:var(--c-green);margin-top:6px;font-weight:600;">'
              + '💎 价值信号：' + sideZh + ' 竞彩优于欧盘 +' + (vs.bestValue * 100).toFixed(1) + '%（'
              + pct + ' ' + z + '，突破历史 p90）'
              + (vs.priorSource === 'history' ? ' · 历史先验' : ' · 软阈值') + '</div>';
          }
        } else {
          valueHtml = '<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">📡 价值信号：无显著模型价值（模型与市场定价接近）</div>';
        }
      }

      // 亚盘覆盖
      let asianHtml = '';
      if (r.asian && r.asian.dist) {
        const d = r.asian.dist;
        asianHtml = '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">⚖️ 亚盘（' + Number(r.asian.line).toFixed(2)
          + '）：让球主胜 ' + (d.home * 100).toFixed(0) + '% · 平 ' + (d.draw * 100).toFixed(0) + '% · 客胜 ' + (d.away * 100).toFixed(0) + '%（' + d.n + ' 场回测）</div>';
      }

      return `
      <div class="rec-card" style="padding:14px;border:1px solid var(--border-color);border-radius:10px;margin-bottom:12px;background:var(--bg-card);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              <span class="badge badge-blue" style="font-size:10px;margin-right:6px;">${esc(m.code || '')}</span>${esc(h)} <span style="color:var(--text-muted);font-weight:400;">vs</span> ${esc(a)}
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${esc(m.league || '竞彩')}</div>
          </div>
          <div style="text-align:right;">
            <span class="badge ${dirClass}" style="font-size:13px;padding:6px 10px;">${dirIcon} ${esc(r.directionZh)}</span>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">@ ${(r.oddsImplied[['home','draw','away'].indexOf(r.direction)]).toFixed(2)}</div>
          </div>
        </div>
        <div style="margin-top:10px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:4px;">
            <span>校准置信度</span><span style="font-family:var(--font-mono);color:${barColor};font-weight:600;">${confPct}%</span>
          </div>
          <div style="height:8px;background:var(--border-color);border-radius:4px;overflow:hidden;">
            <div style="width:${confPct}%;height:100%;background:${barColor};transition:width .3s;"></div>
          </div>
        </div>
        ${asianHtml}
        ${valueHtml}
      </div>`;
    }

    // 降级：无模型时走旧 deVig + 校准
    let probs;
    if (odds.h && odds.h > 1) {
      const p = deVigOdds(odds.h, odds.d || 3.3, odds.a || 3.4);
      probs = { homeWin: p.pH, draw: p.pD, awayWin: p.pA };
    } else {
      const e = eloPredict(1600, 1500);
      probs = { homeWin: e.homeWin / 100, draw: e.draw / 100, awayWin: e.awayWin / 100 };
    }
    const conf = Math.max(probs.homeWin, probs.draw, probs.awayWin);
    let realConf = conf;
    if (calibrateProbability) {
      const cal = calibrateProbability(conf);
      if (cal.calibrated !== conf) realConf = cal.calibrated;
    }
    let pred, predClass, betOdd;
    if (probs.homeWin >= probs.draw && probs.homeWin >= probs.awayWin) {
      pred = '主胜'; predClass = 'win'; betOdd = odds.h || 0;
    } else if (probs.draw >= probs.awayWin) {
      pred = '平局'; predClass = 'draw'; betOdd = odds.d || 0;
    } else {
      pred = '客胜'; predClass = 'lose'; betOdd = odds.a || 0;
    }
    return `
    <div class="rec-card" style="padding:10px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;gap:12px;">
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:600;"><span class="badge badge-blue" style="font-size:10px;margin-right:6px;">${esc(m.code || '')}</span>${esc(h)} vs ${esc(a)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${esc(m.league || '竞彩')}</div>
      </div>
      <span class="badge ${predClass === 'win' ? 'badge-green' : predClass === 'draw' ? 'badge-amber' : 'badge-red'}" style="font-size:12px;">${pred === '主胜' ? '✓' : pred === '平局' ? '○' : '✗'} ${esc(pred)}</span>
      <span style="font-family:var(--font-mono);font-size:13px;">@ ${betOdd ? betOdd.toFixed(2) : '--'}</span>
      <span style="font-size:11px;color:var(--text-muted);">${(realConf * 100).toFixed(0)}%</span>
    </div>`;
  });

  listEl.innerHTML = banner + cards.join('');
}

/* ============================================
   价值注检测渲染
   ============================================ */
async function scanValueBetsModular(jcMatches, getIntOdds) {
  const listEl = document.getElementById('valueBetListModular');
  if (!listEl) return;

  listEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12px;">⏳ 正在对比国际赔率...</div>';
  try {
    const result = await getIntOdds();

    /* 错误对象传播：getIntOdds 返回 { _error, diagnosis } */
    if (result && result._error) {
      var diag = result.diagnosis || {};
      var diagHtml = '';
      if (diag.detectedLeagues && diag.detectedLeagues.length) {
        diagHtml += '<div style="margin-top:6px;font-size:11px;color:var(--text-muted);">';
        diagHtml += '检测到的竞彩联赛：' + esc(diag.detectedLeagues.join('、')) + '<br>';
        if (diag.unmappedLeagues && diag.unmappedLeagues.length) {
          diagHtml += '⚠️ 未映射联赛（The Odds API 无对应）：' + esc(diag.unmappedLeagues.join('、')) + '<br>';
        }
        if (diag.queriedKeys && diag.queriedKeys.length) {
          diagHtml += '已查询 sport key：' + esc(diag.queriedKeys.join('、')) + '<br>';
        }
        if (diag.platform) {
          diagHtml += '平台：' + esc(diag.platform === 'new' ? '新版 theoddsapi.com' : '旧版 the-odds-api.com/v4');
        }
        diagHtml += '</div>';
      }
      listEl.innerHTML = '<div style="padding:10px;color:var(--c-red);font-size:12px;">' +
        '❌ ' + esc(result._error) + diagHtml + '</div>';
      renderQuotaBar(result.quota || null);
      return;
    }

    const intOdds = result._data || result;
    if (!intOdds || !intOdds.length) {
      /* API 调用成功但返回 0 场：给出精准诊断 */
      var diag = result.diagnosis || {};
      var detailHtml = '';
      if (diag.detectedLeagues && diag.detectedLeagues.length) {
        detailHtml += '<div style="margin-top:6px;font-size:11px;color:var(--text-muted);">';
        detailHtml += '检测到的竞彩联赛：' + esc(diag.detectedLeagues.join('、')) + '<br>';
        if (diag.unmappedLeagues && diag.unmappedLeagues.length) {
          detailHtml += '⚠️ 未映射联赛：' + esc(diag.unmappedLeagues.join('、')) + '<br>';
        }
        if (diag.queriedKeys && diag.queriedKeys.length) {
          detailHtml += '已查询 sport key：' + esc(diag.queriedKeys.join('、')) + '<br>';
        }
        if (diag.perKey && Object.keys(diag.perKey).length) {
          detailHtml += '各 key 返回场数：';
          var pkParts = [];
          Object.keys(diag.perKey).forEach(function(k) {
            var v = diag.perKey[k];
            var label = k.replace(/^broad:/, ' broad-');
            if (v && v.ok) {
              pkParts.push(label + '=' + (v.rawCount || v.data && v.data.length || 0) + '场');
            } else if (v && !v.ok) {
              pkParts.push(label + ' 失败（' + esc(v.error || '未知') + '）');
            }
          });
          detailHtml += pkParts.join('、') + '<br>';
        }
        if (diag.broadTried) {
          detailHtml += '已尝试 broad-search 兜底：' + (diag.broadFound ? '找到数据' : '未找到') + '<br>';
        }
        if (diag.platform) {
          detailHtml += '平台：' + esc(diag.platform === 'new' ? '新版 theoddsapi.com' : '旧版 the-odds-api.com/v4') + '<br>';
        }
        detailHtml += '</div>';
      }
      listEl.innerHTML = '<div style="padding:10px;color:var(--c-amber);font-size:12px;">' +
        '⚠️ The Odds API 当前未返回任何在售赔率数据。<br>' +
        '<span style="font-size:11px;color:var(--text-muted);">' +
        '可能原因：当前竞彩场次（巴西杯/欧冠等）处于休赛期、比赛尚未挂牌、或 The Odds API 不覆盖该杯赛。</span>' +
        detailHtml + '</div>';
      renderQuotaBar(result.quota || null);
      return;
    }

    /* 使用时间+联赛匹配（替代失效的中英文队名4字符匹配） */
    var matched = (window.OddsApi && window.OddsApi.matchByTime)
      ? window.OddsApi.matchByTime(jcMatches, intOdds)
      : [];
    
    /* fallback: 旧版队名模糊匹配 */
    if (!matched.length) {
      jcMatches.forEach(function(m) {
        var odds = m.odds;
        if (!odds || !odds.h) return;
        var match = intOdds.find(function(i) {
          var hn = (i.homeTeam || '').toLowerCase();
          var an = (i.awayTeam || '').toLowerCase();
          var h4 = (m.homeTeam || '').slice(0, 4).toLowerCase();
          var a4 = (m.awayTeam || '').slice(0, 4).toLowerCase();
          return h4 && a4 && (hn.indexOf(h4) >= 0 || h4.indexOf(hn.slice(0, 4)) >= 0) &&
            (an.indexOf(a4) >= 0 || a4.indexOf(an.slice(0, 4)) >= 0);
        });
        if (match) matched.push({ jcMatch: m, intOdd: match, score: 0 });
      });
    }

    if (!matched.length) {
      // 未匹配诊断：展示国际赔率返回的联赛分布、时间范围、样本队名
      var sportCounts = {};
      var earliest = null, latest = null;
      var samples = [];
      intOdds.forEach(function(io, idx) {
        var sk = io.sportKey || '未知';
        sportCounts[sk] = (sportCounts[sk] || 0) + 1;
        if (io.commence) {
          var t = new Date(io.commence).getTime();
          if (!earliest || t < earliest) earliest = t;
          if (!latest || t > latest) latest = t;
        }
        if (idx < 5) samples.push((io.homeTeam || '?') + ' vs ' + (io.awayTeam || '?'));
      });
      var jcTimes = [];
      jcMatches.forEach(function(m) {
        if (m.date && m.time) jcTimes.push(m.date + ' ' + m.time + ' (' + (m.league || '未知') + ' ' + (m.homeTeam || '?') + ' vs ' + (m.awayTeam || '?') + ')');
      });
      var diag = result.diagnosis || {};
      var detail = '<div style="margin-top:6px;font-size:11px;color:var(--text-muted);">';
      detail += '国际赔率联赛分布：<br>';
      Object.keys(sportCounts).forEach(function(sk) {
        detail += '&nbsp;&nbsp;· ' + esc(sk) + '：' + sportCounts[sk] + ' 场<br>';
      });
      if (earliest && latest) {
        detail += '国际比赛时间范围：' + new Date(earliest).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' ~ ' + new Date(latest).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '（北京时间）<br>';
      }
      if (samples.length) {
        detail += '样本队名（国际）：' + esc(samples.join('、')) + '<br>';
      }
      if (jcTimes.length) {
        detail += '竞彩在售时间/队名：<br>';
        jcTimes.forEach(function(t) { detail += '&nbsp;&nbsp;· ' + esc(t) + '<br>'; });
      }
      if (diag.unmappedLeagues && diag.unmappedLeagues.length) {
        detail += '⚠️ 未映射联赛：' + esc(diag.unmappedLeagues.join('、')) + '<br>';
      }
      if (diag.broadTried) {
        detail += '已尝试 broad-search 兜底：' + (diag.broadFound ? '找到数据' : '未找到') + '<br>';
      }
      detail += '</div>';
      listEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12px;">' +
        '📋 国际赔率已获取 ' + intOdds.length + ' 场，但未匹配到当前竞彩比赛。<br>' +
        '<span style="font-size:11px;">已放宽时间窗口到24小时并启用联赛匹配，若仍无匹配，通常是 The Odds API 不覆盖该杯赛/资格赛。</span>' +
        detail + '</div>';
      return;
    }

    const bets = [];
    matched.forEach(function(item) {
      var m = item.jcMatch;
      var intOdd = item.intOdd;
      var odds = m.odds;
      if (!odds || !odds.h) return;

      // 回填欧盘实时赔率，供今日推荐面板显示价值信号
      if (intOdd.odds && intOdd.odds.h) {
        m.eu = [intOdd.odds.h, intOdd.odds.d, intOdd.odds.a];
      }

      const valueBets = findValueBets(
        { h: odds.h, d: odds.d, a: odds.a },
        { h: intOdd.odds.h, d: intOdd.odds.d, a: intOdd.odds.a },
        CONFIG.thresholds.valueBet
      );
      valueBets.forEach(v => {
        bets.push({
          code: m.code || '',
          match: (m.homeTeam || '') + ' vs ' + (m.awayTeam || ''),
          league: m.league || '',
          intBookmakers: intOdd.bookmakers || 0,
          ...v
        });
      });
    });

    if (!bets.length) {
      listEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12px;">未找到价值注 — 竞彩与国际赔率接近</div>';
      // 即使无价值注，也回填欧盘并刷新今日推荐面板（显示"无显著偏离"）
      if (typeof renderAIRecommendations === 'function') renderAIRecommendations(jcMatches);
      return;
    }

    if (typeof renderAIRecommendations === 'function') renderAIRecommendations(jcMatches);
    listEl.innerHTML = bets.slice(0, 8).map(b => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid var(--border-color);font-size:12px;">
        <span style="font-family:var(--font-mono);color:var(--c-blue);min-width:60px;">${esc(b.code)}</span>
        <span style="flex:1;">${esc(b.match)}</span>
        <span style="color:var(--c-amber);font-weight:600;">${esc(b.pick)}</span>
        <span style="font-family:var(--font-mono);">@${b.jcOdds.toFixed(2)}</span>
        <span style="font-size:11px;color:var(--c-green);">价值 +${b.valuePct}pp</span>
      </div>`).join('') +
      `<div style="padding:8px;font-size:11px;color:var(--text-muted);">💡 共 ${bets.length} 个价值注 · 已匹配 ${matched.length}/${jcMatches.length} 场</div>`;
    renderQuotaBar(result.quota || null);
  } catch (e) {
    listEl.innerHTML = `<div style="padding:10px;color:var(--c-red);font-size:12px;">❌ 扫描失败：${esc(e.message)}</div>`;
    renderQuotaBar(null);
  }
}

/* ============================================
   API 配额展示条
   ============================================ */
function renderQuotaBar(quota) {
  var el = document.getElementById('oddsQuotaBar');
  if (!el) return;
  if (!quota && window.OddsApi) {
    quota = {
      used: window.OddsApi.getUsedCount(),
      total: window.OddsApi.FREE_QUOTA || 500,
      remaining: window.OddsApi.getRemainingQuota()
    };
  }
  if (!quota) { el.innerHTML = ''; return; }
  var pct = Math.round(quota.used / quota.total * 100);
  var color = pct < 60 ? 'var(--c-green)' : pct < 85 ? 'var(--c-amber)' : 'var(--c-red)';
  el.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg-card-hover);border-radius:6px;font-size:11px;">' +
    '<span style="color:var(--text-muted);">📊 The Odds API</span>' +
    '<div style="flex:1;height:6px;background:var(--border-color);border-radius:3px;overflow:hidden;">' +
      '<div style="width:' + pct + '%;height:100%;background:' + color + ';transition:width 0.3s;"></div>' +
    '</div>' +
    '<span style="font-family:var(--font-mono);color:' + color + ';">' + quota.used + '/' + quota.total + '</span>' +
    '<span style="color:var(--text-muted);">剩余 ' + (quota.remaining !== undefined ? quota.remaining : (quota.total - quota.used)) + ' 次</span>' +
  '</div>';
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
  window.renderQuotaBar = renderQuotaBar;
}

})();
