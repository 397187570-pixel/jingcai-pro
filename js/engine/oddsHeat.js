/**
 * oddsHeat.js — 市场热度指数（语义化）· 下单建议
 * 竞彩智选 Pro · 数据分析系统 · P4
 *
 * 为什么是"语义化"？
 *   国内竞彩官方不公开任何成交量/投注量；唯一真金白银的成交量在 Betfair/必发
 *   交易所（totalMatched），但国内被墙 + 需密钥，只能做 opt-in 升级（同 recordIntl 路线）。
 *   因此 P4 默认不依赖成交量，改用"赔率变动"反推钱往哪边挤：
 *     - 竞彩端赔率被压低(隐含↑) = 散户/跟单热度升
 *     - 机构端(国际均值 / Pinnacle)赔率被压低 = 聪明钱买入（权重更高）
 *     - 近期变动速率(加速度) = 热度在升温还是降温
 *
 * 用户硬约束（贯穿 P3→P8）：所有分析必须落地成"可辅助下单的建议"，
 *   故 analyze() 第一公民仍是 advice —— 直接回答"钱往哪边挤、该顺势 / 反手 / 观望"。
 *
 * 输入：OddsHistory.getSeries(matchId) 快照序列（时间升序）。
 * 输出：每边 0~100 热度分 + 方向 + 冷/温/热/爆热标签 + advice。
 *
 * 依赖：纯函数，浏览器/Node 同构。可选接收 P3 的 trendResult 做价值交叉验证。
 */
(function (global) {
  'use strict';

  const SIDES = ['h', 'd', 'a'];
  const ZH = { h: '主胜', d: '平局', a: '客胜' };
  const EPS = 0.005; // 0.5 个概率点判定阈值

  /* ---------- 小工具 ---------- */
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function r1(x) { return Math.round(x * 1000) / 1000; }
  function pct(x) { return Math.round(x * 1000) / 10; }
  function sign(x) { return x > EPS ? 1 : x < -EPS ? -1 : 0; }

  /* 解析参考隐含（默认国际均值，缺则退 Pinnacle/sharp） */
  function refOf(snap, refKey) {
    if (!snap || !snap.implied) return null;
    return snap.implied[refKey] || snap.implied.intlAvg || snap.implied.sharp || null;
  }

  /* 热度标签 */
  function heatLabel(score) {
    if (score >= 75) return '爆热';
    if (score >= 55) return '热';
    if (score >= 35) return '温';
    if (score >= 15) return '偏冷';
    return '冷';
  }
  function heatColor(score) {
    if (score >= 75) return 'var(--c-red)';
    if (score >= 55) return 'var(--c-amber)';
    if (score >= 35) return 'var(--c-blue)';
    return 'var(--text-muted)';
  }

  /* ============================================================
     主分析入口
     ============================================================ */
  /**
   * @param {Array} series  OddsHistory 快照序列（ts 升序）
   * @param {Object} [opts]
   *   refKey: 'intlAvg'(默认) | 'sharp'
   *   minPoints, trendResult(可选 P3 结果)
   *   driftScale: 把"漂移概率点"归一化到 0~1 的分母(默认 0.08 = 8pt 封顶)
   *   momentumScale: 加速度分母(默认 0.05)
   * @returns {Object} heat + direction + advice
   */
  function analyze(series, opts) {
    opts = opts || {};
    const refKey = opts.refKey || 'intlAvg';
    const minPoints = opts.minPoints || 2;
    const driftScale = opts.driftScale || 0.08;
    const momentumScale = opts.momentumScale || 0.05;
    const trendResult = opts.trendResult || null;

    const valid = (series || []).filter(s => s.implied && s.implied.jc && refOf(s, refKey));
    const meta = (series && series[0] && series[0].meta) || {};

    if (valid.length < minPoints) {
      return {
        insufficient: true,
        points: valid.length,
        matchId: (series && series[0] && series[0].matchId) || null,
        meta: meta,
        advice: {
          action: 'watch', confidence: 0,
          headline: '样本不足（需要 ≥' + minPoints + ' 个有效快照）',
          reasons: ['打开本页后系统持续记录竞彩赔率；记录越多，热度信号越可靠。'],
          perSide: []
        }
      };
    }

    const first = valid[0], last = valid[valid.length - 1];
    const jcF = first.implied.jc, jcL = last.implied.jc;
    const rf = refOf(first, refKey), rl = refOf(last, refKey);

    // 动量：近期段(最后 1/3)均值 − 早期段均值（加速度）
    const k = Math.max(1, Math.floor(valid.length / 3));
    const early = valid.slice(0, valid.length - k);
    const recent = valid.slice(valid.length - k);
    function avgImplied(list, key) {
      const f = key === 'jc' ? s => s.implied.jc : s => refOf(s, refKey);
      let h = 0, d = 0, a = 0, n = 0;
      list.forEach(s => { const v = f(s); if (v) { h += v.h; d += v.d; a += v.a; n++; } });
      if (!n) return null;
      return { h: h / n, d: d / n, a: a / n };
    }
    const earlyJc = avgImplied(early, 'jc'), recentJc = avgImplied(recent, 'jc');
    const earlyR = avgImplied(early, 'ref'), recentR = avgImplied(recent, 'ref');

    // 异动检测（供 P6 复用）：最后一步 jc 隐含跳变
    let lastStep = { h: 0, d: 0, a: 0 };
    if (valid.length >= 2) {
      const prev = valid[valid.length - 2];
      SIDES.forEach(side => {
        if (prev.implied && prev.implied.jc) lastStep[side] = r1(jcL[side] - prev.implied.jc[side]);
      });
    }
    const spike = Math.max(Math.abs(lastStep.h), Math.abs(lastStep.d), Math.abs(lastStep.a)) > 0.02;

    // 逐边热度
    const perSide = SIDES.map(side => {
      const jcDrift = r1(jcL[side] - jcF[side]);      // 竞彩端隐含变化(+ = 热度升)
      const refDrift = r1(rl[side] - rf[side]);        // 机构端隐含变化(+ = 聪明钱买)
      const momJc = (recentJc && earlyJc) ? r1(recentJc[side] - earlyJc[side]) : 0;
      const momR = (recentR && earlyR) ? r1(recentR[side] - earlyR[side]) : 0;

      const driftN = clamp(jcDrift / driftScale, -1, 1);   // 散户热度
      const sharpN = clamp(refDrift / driftScale, -1, 1);  // 聪明钱
      const momN = clamp((momJc + momR) / 2 / momentumScale, -1, 1); // 加速度

      // 聪明钱权重更高；只呈现"热"的那半(负向=冷→压低位)
      const raw = 0.45 * driftN + 0.40 * sharpN + 0.15 * momN;
      const score = Math.round(clamp(raw, 0, 1) * 100);

      const smartConfirmed = sharpN > 0.2 && sign(sharpN) === sign(driftN);
      const retailOnly = driftN > 0.15 && sharpN <= 0.05;   // 竞彩动、机构没动

      return {
        side: side, zh: ZH[side], score: score, label: heatLabel(score),
        driftPts: pct(jcDrift), sharpDriftPts: pct(refDrift),
        momentumPts: pct(momJc),
        smartConfirmed: smartConfirmed, retailOnly: retailOnly
      };
    });

    // 方向：最热边
    perSide.sort((x, y) => y.score - x.score);
    const dir = perSide[0];
    // 失衡度：最高 − 最低（0=均衡，1=一边倒）
    const balance = clamp((perSide[0].score - perSide[perSide.length - 1].score) / 100, 0, 1);

    // 与 P3 价值交叉验证
    const trendMap = {};
    if (trendResult && trendResult.advice && trendResult.advice.perSide) {
      trendResult.advice.perSide.forEach(p => { trendMap[p.side] = p; });
    }
    const dirTrend = trendMap[dir.side];

    // 建议推导
    const reasons = [];
    let action = 'watch', conf = 0.3;

    if (dir.score < 15) {
      conf = 0.2; // "均衡"理由在最终动作确定后按需补（避免与 fade 覆写矛盾）
    } else if (dir.retailOnly && !dir.smartConfirmed) {
      // 竞彩端单涨、机构不确认 → 警惕诱盘/散户过热
      reasons.push(dir.zh + '热度由竞彩端单独推升(+' + Math.abs(dir.driftPts).toFixed(1)
        + 'pt)，但机构/聪明钱未确认(' + dir.sharpDriftPts.toFixed(1) + 'pt)，警惕诱盘或散户过热。');
      if (dirTrend && dirTrend.divergence) {
        reasons.push('P3 背离确认：竞彩推升、国际撤出 → 该方向疑似诱盘，规避。');
        action = 'fade'; conf = 0.4;
      } else {
        action = 'caution'; conf = 0.35;
      }
    } else if (dir.smartConfirmed) {
      // 机构确认买入
      if (dirTrend && dirTrend.valueScore >= 0.03) {
        action = 'follow';
        reasons.push('聪明钱(机构)持续买入' + dir.zh + '(+' + Math.abs(dir.sharpDriftPts).toFixed(1)
          + 'pt) 且竞彩同步升温，与 P3 价值方向一致 → 顺势跟随。');
        conf = clamp(0.5 + dir.score / 200, 0, 0.85);
      } else {
        action = 'follow_small';
        reasons.push('机构买入' + dir.zh + '热度确认，但 P3 未检出明显价值 → 可小注跟随，不宜重仓。');
        conf = clamp(0.35 + dir.score / 300, 0, 0.7);
      }
    } else {
      // 热度中等、未见明确聪明钱确认
      reasons.push(dir.zh + '热度偏高(' + dir.label + ')，但机构未明确确认，先观望。');
      conf = 0.3;
    }

    // 补充：若最热边恰是 P3 诱盘边，强制反手提示
    if (dirTrend && dirTrend.divergence && dirTrend.valueScore < 0 && action !== 'fade') {
      reasons.push('注意：最热方向出现"竞彩推/国际撤"背离，建议反手或回避，勿追热。');
      action = 'fade'; conf = Math.max(conf, 0.45);
    }

    if (spike) reasons.push('⚡ 检测到赔率异动（最后一步跳变 >2pt），热度正在快速变化。');

    // 仅在最终仍是 watch 且热度偏低时补"均衡"理由
    if (action === 'watch' && dir.score < 15) {
      reasons.push('三边热度均偏低，市场无明显资金倾向，建议观望。');
    }

    const actionText = {
      follow: '顺势跟随', 'follow_small': '小注跟随', caution: '警惕诱盘',
      fade: '反手/回避', watch: '观望'
    }[action];

    // headline 必须在最终 action 确定后生成（陷阱覆写可能把动作改成 fade）
    let headline;
    if (action === 'fade') {
      headline = '最热方向疑似诱盘（竞彩推/国际撤）→ 建议反手或回避';
    } else if (dir.score < 15) {
      headline = '市场热度均衡，无明显资金倾向';
    } else {
      headline = '热度指向 ' + dir.zh + '（' + dir.label + '）— 建议' + actionText;
    }

    // perSide 按原始顺序
    const ordered = SIDES.map(s => perSide.find(p => p.side === s));

    return {
      insufficient: false,
      points: valid.length,
      spanMs: last.ts - first.ts,
      matchId: last.matchId,
      refKey: refKey,
      meta: meta,
      heat: { h: ordered[0], d: ordered[1], a: ordered[2] },
      direction: { side: dir.side, zh: dir.zh, score: dir.score },
      balance: r1(balance),
      spike: spike,
      lastStep: lastStep,
      advice: {
        action: action,
        confidence: Math.round(conf * 100) / 100,
        headline: headline,
        reasons: reasons,
        perSide: ordered
      }
    };
  }

  /* ============================================================
     渲染：热度仪表（挂到赔率监测页）
     ============================================================ */
  function actionBadge(a) {
    const map = {
      follow: ['st-value', '顺势跟随'], 'follow_small': ['st-normal', '小注跟随'],
      caution: ['st-risk', '警惕诱盘'], fade: ['st-risk', '反手/回避'], watch: ['st-normal', '观望']
    };
    const m = map[a] || ['st-normal', '观望'];
    return '<span class="status-tag ' + m[0] + '">' + m[1] + '</span>';
  }

  /**
   * @param {HTMLElement|null} container
   * @param {Object} result  analyze() 返回
   */
  function renderHeat(container, result) {
    if (!container) return;
    if (!result) { container.innerHTML = ''; return; }
    if (result.insufficient) {
      container.innerHTML = `
      <div class="card" style="margin-top:16px;border-left:3px solid var(--c-amber);">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px;">🔥 市场热度指数</div>
        <div style="font-size:12px;color:var(--text-muted);">${esc(result.advice.headline)}。<br>${esc(result.advice.reasons[0] || '')}</div>
      </div>`;
      return;
    }

    const adv = result.advice;
    const refName = result.refKey === 'sharp' ? 'Pinnacle' : '国际均值';
    const ordered = adv.perSide;

    const bars = ordered.map(p => `
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;">
          <span style="font-weight:600;">${p.zh} ${p.smartConfirmed ? '<span title="机构确认买入" style="color:var(--c-green);">●</span>' : p.retailOnly ? '<span title="仅竞彩端推升" style="color:var(--c-red);">●</span>' : ''}</span>
          <span style="color:${heatColor(p.score)};font-weight:700;">${p.score} · ${p.label}</span>
        </div>
        <div style="height:8px;background:var(--bg-elevated);border-radius:6px;overflow:hidden;">
          <div style="width:${p.score}%;height:100%;background:${heatColor(p.score)};border-radius:6px;"></div>
        </div>
        <div style="font-size:10.5px;color:var(--text-muted);margin-top:3px;">
          竞彩漂移 ${p.driftPts > 0 ? '+' : ''}${p.driftPts.toFixed(1)}pt · 机构漂移 ${p.sharpDriftPts > 0 ? '+' : ''}${p.sharpDriftPts.toFixed(1)}pt
        </div>
      </div>`).join('');

    const reasons = adv.reasons.map(r => `<li style="margin-bottom:4px;">${esc(r)}</li>`).join('');

    container.innerHTML = `
      <div class="card" style="margin-top:16px;border-left:4px solid var(--c-red);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
          <div style="font-size:15px;font-weight:700;">🔥 市场热度指数 · 资金流向建议</div>
          <span class="badge badge-blue">${esc(refName)} · ${result.points} 快照 · 失衡 ${(result.balance * 100).toFixed(0)}%</span>
        </div>
        ${bars}
        <div style="background:var(--bg-elevated);border-radius:12px;padding:12px 14px;margin-top:6px;">
          <div style="font-size:14px;font-weight:700;color:${heatColor(result.direction.score)};">${esc(adv.headline)}</div>
          <ul style="margin:8px 0 0 18px;font-size:12.5px;color:var(--text);line-height:1.6;">${reasons}</ul>
        </div>
        <div style="font-size:10.5px;color:var(--text-muted);margin-top:8px;">
          热度 = 竞彩端漂移(45%) + 机构/聪明钱漂移(40%) + 近期加速度(15%) 合成；机构买入权重更高。无真实成交量，属语义化估算（国内竞彩不公开投注量）。${result.spike ? ' ⚡已检测到异动。' : ''}
        </div>
      </div>`;
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  const api = { analyze: analyze, renderHeat: renderHeat, heatLabel: heatLabel };
  if (typeof window !== 'undefined') window.OddsHeat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})(typeof window !== 'undefined' ? window : this);
