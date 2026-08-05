/**
 * multiDim.test.js — 多维预测分解引擎单元测试
 * 运行：node tests/multiDim.test.js
 * 使用 Node 原生 assert，无第三方依赖
 */

const assert = require('assert');
const {
  buildMultiDim, solveXg, poissonWDL, scoreMatrix, totalGoals, asianHandicap, roundTo025, lineLabel
} = require('../js/engine/multiDim.js');
const { poisson } = require('../js/engine/predictor.js');

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (e) {
    failed++;
    console.log('  ❌ ' + name);
    console.log('     ' + e.message);
  }
}

console.log('\n🔢 poissonWDL 测试');
test('泊松胜平负概率和为 1', () => {
  const wdl = poissonWDL(1.6, 1.1, 8);
  const sum = wdl.homeWin + wdl.draw + wdl.awayWin;
  assert(Math.abs(sum - 1) < 0.001, `和 ${sum} 应 ≈1`);
});

test('强队 xG 更高 => 主胜概率 > 客胜', () => {
  const wdl = poissonWDL(2.2, 0.8, 8);
  assert(wdl.homeWin > wdl.awayWin, `主胜 ${wdl.homeWin} 应 > 客胜 ${wdl.awayWin}`);
});

console.log('\n🎯 solveXg xG 反演测试');
test('反演 xG 后泊松 W/D/L 与目标接近（强队主胜型）', () => {
  const target = { homeWin: 0.55, draw: 0.25, awayWin: 0.20 };
  const xg = solveXg(target.homeWin, target.draw, target.awayWin, { maxGoals: 8 });
  const wdl = poissonWDL(xg.homeXg, xg.awayXg, 8);
  assert(Math.abs(wdl.homeWin - target.homeWin) < 0.02, `主胜反演 ${wdl.homeWin.toFixed(3)} ≈ ${target.homeWin}`);
  assert(Math.abs(wdl.draw - target.draw) < 0.02, `平局反演 ${wdl.draw.toFixed(3)} ≈ ${target.draw}`);
  assert(Math.abs(wdl.awayWin - target.awayWin) < 0.02, `客胜反演 ${wdl.awayWin.toFixed(3)} ≈ ${target.awayWin}`);
});

test('反演 xG 后泊松 W/D/L 与目标接近（势均力敌型）', () => {
  const target = { homeWin: 0.38, draw: 0.30, awayWin: 0.32 };
  const xg = solveXg(target.homeWin, target.draw, target.awayWin, { maxGoals: 8 });
  const wdl = poissonWDL(xg.homeXg, xg.awayXg, 8);
  assert(Math.abs(wdl.homeWin - target.homeWin) < 0.02, `主胜反演 ${wdl.homeWin.toFixed(3)} ≈ ${target.homeWin}`);
  assert(Math.abs(wdl.draw - target.draw) < 0.02, `平局反演 ${wdl.draw.toFixed(3)} ≈ ${target.draw}`);
});

test('反演 xG 主队期望进球应 >= 客队（主胜型）', () => {
  const xg = solveXg(0.6, 0.22, 0.18, { maxGoals: 8 });
  assert(xg.homeXg > xg.awayXg, `主 xG ${xg.homeXg} 应 > 客 xG ${xg.awayXg}`);
});

console.log('\n⚖️ 让胜平负测试');
test('让球盘口概率和为 1（整数盘）', () => {
  const ah = asianHandicap(1.8, 1.0, 1, 8);
  const sum = ah.home + ah.draw + ah.away;
  assert(Math.abs(sum - 1) < 0.001, `和 ${sum} 应 ≈1`);
});

test('主队大幅让球(主让 -1)时 让胜(净胜2球+)概率接近 1', () => {
  // line = -1 表示主让1球：让胜 = 主队净胜 2 球以上
  const ah = asianHandicap(4.0, 0.2, -1, 8);
  assert(ah.home > 0.85, `让胜 ${ah.home} 应 >0.85`);
});

test('主受让（+0.5）时 让胜 = 主队不败概率', () => {
  // line = +0.5 表示主受让0.5：让胜 = 主队不败（胜或平）
  const xg = solveXg(0.5, 0.25, 0.25, { maxGoals: 8 });
  const ah = asianHandicap(xg.homeXg, xg.awayXg, 0.5, 8);
  const wdl = poissonWDL(xg.homeXg, xg.awayXg, 8);
  const notLose = wdl.homeWin + wdl.draw;
  assert(Math.abs(ah.home - notLose) < 0.001, `让胜 ${ah.home} 应 = 不败 ${notLose}`);
  assert(ah.draw === 0, `半球盘无让平，实际 ${ah.draw}`);
});

test('主让(-1)时 让胜 = 主队净胜2球以上', () => {
  const xg = solveXg(0.5, 0.25, 0.25, { maxGoals: 8 });
  const ah = asianHandicap(xg.homeXg, xg.awayXg, -1, 8);
  const wdl = poissonWDL(xg.homeXg, xg.awayXg, 8);
  let winBy2 = 0;
  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      if (h - a >= 2) winBy2 += poisson(xg.homeXg, h) * poisson(xg.awayXg, a);
    }
  }
  assert(Math.abs(ah.home - winBy2) < 0.001, `让胜 ${ah.home} 应 = 净胜2球+ ${winBy2}`);
});

console.log('\n🥅 进球数测试');
test('总进球数分布和为 1', () => {
  const tg = totalGoals(1.6, 1.1, 8);
  const sum = tg.reduce((a, b) => a + b.p, 0);
  assert(Math.abs(sum - 1) < 0.001, `和 ${sum} 应 ≈1`);
});

test('总进球数包含「8+ 球」兜底桶', () => {
  const tg = totalGoals(1.6, 1.1, 8);
  assert(tg.some((t) => String(t.goals).indexOf('+') >= 0), '应包含 8+ 桶');
});

console.log('\n📊 buildMultiDim 集成测试');
test('返回对象包含四维与 Top5', () => {
  const md = buildMultiDim({ homeWin: 0.5, draw: 0.25, awayWin: 0.25 }, { line: -1 });
  assert(Array.isArray(md.scoreMatrix) && md.scoreMatrix.length > 0, '应有比分矩阵');
  assert(Array.isArray(md.totalGoals) && md.totalGoals.length > 0, '应有进球数分布');
  assert(md.asian && typeof md.asian.home === 'number', '应有让球概率');
  assert(Array.isArray(md.top5) && md.top5.length === 5, `Top5 应恰好 5 项，实际 ${md.top5.length}`);
  assert(typeof md.lineLabel === 'string' && md.lineLabel.length > 0, '应有盘口标签');
});

test('Top5 按概率降序排列', () => {
  const md = buildMultiDim({ homeWin: 0.55, draw: 0.23, awayWin: 0.22 }, { line: null });
  for (let i = 1; i < md.top5.length; i++) {
    assert(md.top5[i - 1].p >= md.top5[i].p, `Top5 应降序：第${i}项 ${md.top5[i].p} > 前项 ${md.top5[i - 1].p}`);
  }
});

test('Top5 覆盖多维度（至少 2 个不同 dim）', () => {
  const md = buildMultiDim({ homeWin: 0.5, draw: 0.27, awayWin: 0.23 }, { line: -1 });
  const dims = new Set(md.top5.map((c) => c.dim));
  assert(dims.size >= 2, `Top5 应跨维度，实际 ${dims.size} 个维度：${[...dims].join('/')}`);
});

test('未提供盘口时自动推导「模型建议盘口」', () => {
  const md = buildMultiDim({ homeWin: 0.6, draw: 0.22, awayWin: 0.18 }, { line: null });
  assert(md.lineSuggested === true, '应标记 lineSuggested');
  assert(typeof md.line === 'number', '应推导出一个数值盘口');
});

test('提供真实盘口时不标记为建议盘口', () => {
  const md = buildMultiDim({ homeWin: 0.5, draw: 0.25, awayWin: 0.25 }, { line: -1 });
  assert(md.lineSuggested === false, '不应标记为建议盘口');
  assert(md.line === -1, `盘口应为 -1，实际 ${md.line}`);
});

test('cells 汇总覆盖全部四个维度', () => {
  const md = buildMultiDim({ homeWin: 0.5, draw: 0.25, awayWin: 0.25 }, { line: -1 });
  const dims = new Set(md.cells.map((c) => c.dim));
  ['胜平负', '让胜平负', '进球数', '比分'].forEach((d) => {
    assert(dims.has(d), `cells 应含维度 ${d}`);
  });
});

console.log('\n🔧 工具函数测试');
test('roundTo025 四舍五入到 0.25 网格', () => {
  assert.strictEqual(roundTo025(0.3), 0.25);
  assert.strictEqual(roundTo025(0.4), 0.5);
  assert.strictEqual(roundTo025(1.12), 1);
});

test('lineLabel 格式化（竞彩盘口惯例：负=主让，正=主受让）', () => {
  assert.strictEqual(lineLabel(0), '平手');
  assert.strictEqual(lineLabel(1), '主+1');
  assert.strictEqual(lineLabel(-0.5), '主-0.5');
});

console.log('\n════════════════════════════');
console.log(`📊 结果: ${passed} 通过, ${failed} 失败`);
console.log('════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
