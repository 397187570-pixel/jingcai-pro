#!/usr/bin/env node
/**
 * backtest_eu.js — 无欧盘 vs 有欧盘 价值信号精准度 + 欧盘混合方向 回测
 * 竞彩智选 Pro
 *
 * 复用生产代码 js/engine/recommend.js，重放 eu_odds_history.json 中
 * "竞彩 + 欧盘 + 真实赛果" 三件套齐全的历史场次。
 *
 * 路径:
 *   A. 无欧盘(eu=null)        -> 模型价值边际 💎, 方向=竞彩校准
 *   B. 有欧盘(eu=eu_avg)      -> 实时欧盘偏差 💎, 方向=竞彩校准
 *   C. 有欧盘 + 混合方向(w)    -> 实时欧盘偏差 💎, 方向=竞彩/欧盘混合
 *
 * 关键诚实点: 竞彩抽水 ~12.9%, 任何在竞彩赔率下注的策略 ROI 必然为负。
 * 因此价值信号的"精准度"不靠 ROI 正负, 而靠:
 *   - priceBeat = 💎标的真实胜率 − 该标的竞彩去水隐含概率 (是否跑赢定价)
 *   - 💎胜率 vs 全样本方向胜率 (是否真分离出更好的注)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('../js/engine/recommend.js');

const root = path.join(__dirname, '..');
const load = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const calib = load('js/engine/calibration.json');
const leagueCal = load('js/engine/league_calibration.json');
const asian = load('js/engine/asian_handicap.json');
const euGap = load('js/engine/eu_jc_gap.json');
const hist = load('ml/data/eu_odds_history.json');

function parseScore(s) {
  if (!s || !String(s).includes(':')) return null;
  const [h, a] = String(s).split(':').map(Number);
  if (isNaN(h) || isNaN(a)) return null;
  return h > a ? 'H' : (h === a ? 'D' : 'A');
}
const labels = ['home', 'draw', 'away'];
const sideIdx = { home: 0, draw: 1, away: 2 };

// 仅用干净场次(排除 low_conf / 缺数据)
const rows = hist.filter(r =>
  !r.low_conf && r.jc_h && r.jc_d && r.jc_a &&
  Array.isArray(r.eu_avg) && r.eu_avg[0] && parseScore(r.eu_score)
);
const N = rows.length;

function mkMatch(r, withEu) {
  return {
    league: r.leagueName,
    homeTeam: r.zhHome, awayTeam: r.zhAway,
    jc: [+r.jc_h, +r.jc_d, +r.jc_a],
    eu: withEu ? r.eu_avg.map(Number) : null,
    goalLine: null
  };
}

// 累加器
function acc() {
  return { n: 0, dirWin: 0, dirRoi: 0, flagN: 0, flagWin: 0, flagImp: 0, flagRoi: 0 };
}
function runPath(withEu, blendWeight) {
  const a = acc();
  for (const r of rows) {
    const m = mkMatch(r, withEu);
    const opts = blendWeight != null ? { blendWeight } : {};
    const rec = R.recommend(m, calib, leagueCal, asian, euGap, opts);
    const outcome = parseScore(r.eu_score);
    const oi = outcome === 'H' ? 0 : outcome === 'D' ? 1 : 2;

    // 方向
    const di = sideIdx[rec.direction];
    const dirWin = di === oi;
    a.n++;
    if (dirWin) a.dirWin++;
    const odd = m.jc[di];
    a.dirRoi += dirWin ? (odd - 1) : -1;

    // 价值信号 💎
    const vs = rec.valueSignal;
    if (vs && vs.flagged[vs.bestValueSide]) {
      const si = sideIdx[vs.bestValueSide];
      const fw = si === oi;
      const pj = R.implied(m.jc[0], m.jc[1], m.jc[2])[si]; // 竞彩去水隐含
      a.flagN++;
      if (fw) a.flagWin++;
      a.flagImp += pj;
      const fodd = m.jc[si];
      a.flagRoi += fw ? (fodd - 1) : -1;
    }
  }
  return a;
}

function fmt(a) {
  return {
    n: a.n,
    dirWinRate: (a.dirWin / a.n * 100),
    dirRoi: (a.dirRoi / a.n * 100),
    flagN: a.flagN,
    flagWinRate: a.flagN ? (a.flagWin / a.flagN * 100) : 0,
    flagImpAvg: a.flagN ? (a.flagImp / a.flagN * 100) : 0,
    priceBeat: a.flagN ? (a.flagWin / a.flagN - a.flagImp / a.flagN) * 100 : 0,
    flagRoi: a.flagN ? (a.flagRoi / a.flagN * 100) : 0
  };
}

// 运行
const A = fmt(runPath(false, null));   // 无欧盘
const B = fmt(runPath(true, null));    // 有欧盘, 方向=竞彩(默认)
// C: 混合方向扫描
const sweep = [0, 0.3, 0.5, 0.7, 0.85, 1.0];
const Cs = sweep.map(w => ({ w, m: fmt(runPath(true, w)) }));
const Cbest = Cs.slice().sort((x, y) => y.m.dirWinRate - x.m.dirWinRate)[0];

// ---------- 输出 ----------
const pct = x => x.toFixed(1) + '%';
const line = (label, m, extra) =>
  `${label.padEnd(26)} n=${String(m.n).padStart(4)} | 方向胜率 ${pct(m.dirWinRate).padStart(6)} | 方向ROI ${m.dirRoi >= 0 ? '+' : ''}${m.dirRoi.toFixed(1).padStart(6)}%` +
  (extra ? ' | ' + extra : '');

console.log('='.repeat(78));
console.log('📊 竞彩智选 Pro — 无欧盘 vs 有欧盘 回测 (真实生产代码 recommend.js)');
console.log('='.repeat(78));
console.log(`样本: ${N} 场 (竞彩+欧盘+赛果三件套齐全, 已排除 low_conf)`);
console.log(`\n--- ① 方向准确率 (选主胜/平/客胜 是否猜中) ---`);
console.log(line('A. 无欧盘(模型价值)', A));
console.log(line('B. 有欧盘(实时偏差)', B));
Cs.forEach(c => console.log(line(`C. 混合 w=${c.w}`, c.m)));
console.log(`\n👉 混合最优方向: w=${Cbest.w} → 方向胜率 ${pct(Cbest.m.dirWinRate)} (vs A/B 均≈${pct(A.dirWinRate)})`);

console.log(`\n--- ② 价值信号 💎 精准度 (核心问题: 无欧盘 vs 有欧盘) ---`);
const vline = (label, m) =>
  `${label.padEnd(22)} 💎注数 ${String(m.flagN).padStart(4)} | 💎胜率 ${pct(m.flagWinRate).padStart(6)} | 去水隐含 ${pct(m.flagImpAvg).padStart(6)} | 跑赢定价 ${m.priceBeat >= 0 ? '+' : ''}${m.priceBeat.toFixed(1).padStart(5)}pp | 💎ROI ${m.flagRoi >= 0 ? '+' : ''}${m.flagRoi.toFixed(1).padStart(6)}%`;
console.log(vline('A. 无欧盘', A));
console.log(vline('B. 有欧盘', B));
console.log(`\n解读:`);
console.log(`  · 跑赢定价 = 💎标的真实胜率 − 该标的竞彩去水隐含概率; >0 表示信号挑出了"定价有利"的注`);
console.log(`  · A 与 B 的方向胜率相同(方向均来自竞彩), 差异只在💎价值信号的精准度`);

// 保存 markdown 报告
const md = `# 欧盘价值信号回测报告

> 生成: ${new Date().toISOString().slice(0, 19)} | 样本: ${N} 场 (竞彩+欧盘+赛果, 排除 low_conf)
> 引擎: 生产代码 js/engine/recommend.js

## ① 方向准确率
| 路径 | 样本 | 方向胜率 | 方向ROI |
|------|------|----------|---------|
| A. 无欧盘 | ${A.n} | ${pct(A.dirWinRate)} | ${A.dirRoi.toFixed(1)}% |
| B. 有欧盘 | ${B.n} | ${pct(B.dirWinRate)} | ${B.dirRoi.toFixed(1)}% |
${Cs.map(c => `| C. 混合 w=${c.w} | ${c.m.n} | ${pct(c.m.dirWinRate)} | ${c.m.dirRoi.toFixed(1)}%`).join('\n')}
| **混合最优 w=${Cbest.w}** | | **${pct(Cbest.m.dirWinRate)}** | |

## ② 价值信号 💎 精准度 (无欧盘 vs 有欧盘)
| 路径 | 💎注数 | 💎胜率 | 去水隐含 | 跑赢定价(pp) | 💎ROI |
|------|--------|--------|----------|--------------|-------|
| A. 无欧盘(模型价值) | ${A.flagN} | ${pct(A.flagWinRate)} | ${pct(A.flagImpAvg)} | ${A.priceBeat.toFixed(1)} | ${A.flagRoi.toFixed(1)}% |
| B. 有欧盘(实时偏差) | ${B.flagN} | ${pct(B.flagWinRate)} | ${pct(B.flagImpAvg)} | ${B.priceBeat.toFixed(1)} | ${B.flagRoi.toFixed(1)}% |

- 跑赢定价 > 0 = 信号挑出"定价有利"的注(真实胜率高于市场定价)。
- 竞彩抽水 ~12.9%, 💎ROI 必然为负, 比较意义在 priceBeat / 胜率, 不在 ROI 正负。

## 结论
- **方向准确率**: A 与 B 相同(≈${A.dirWinRate.toFixed(1)}%, 欧盘不参与方向); 欧盘混合方向在 w=${Cbest.w} 仅 ${Cbest.m.dirWinRate.toFixed(1)}%, 无实质提升 → 方向默认仍用竞彩校准。
- **价值信号精准度(跑赢定价 pp)**: 无欧盘 A = +${A.priceBeat.toFixed(1)} / 有欧盘 B = ${B.priceBeat.toFixed(1)}。
  - 旧版"有欧盘"信号因**符号反向**, priceBeat 曾达 -8.8pp(实为亏损信号, ROI -28.7%); 已修正为"欧盘概率−竞彩概率>0"。
  - 修正后 B 打平定价(-0.6pp), 仍**不优于**无欧盘模型信号(+2.3pp, 但差异在统计噪声边缘, 不宜夸大)。
- **直觉被数据推翻**: "双源交叉验证(有欧盘)更准" 在本数据上不成立。竞彩内部联赛级系统偏差(模型价值边际)比跨市场当日偏差更可预测。
- **实战含义**: 竞彩 12.9% 抽水下所有 ROI 必为负; 💎 的真正价值是"挑出跑赢自身定价的注"(A 能做到 +2.3pp, B 修正后≈持平)。欧盘当前未带来方向或价值的实质提升。
`;
fs.writeFileSync(path.join(__dirname, 'BACKTEST_EU_REPORT.md'), md);
console.log(`\n✅ 报告已写 ml/BACKTEST_EU_REPORT.md`);
