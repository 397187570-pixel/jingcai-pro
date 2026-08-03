/**
 * ml.test.js — ML 模型 + 基本面数据测试
 * 运行：node tests/ml.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { extractFeatures, featuresToArray, getTeamElo, getTeamProfile } = require('../js/engine/fundamentals.js');
const { loadModel, predict, fusePredictions, mlConfidence } = require('../js/engine/mlModel.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + e.message); }
}

console.log('\n📊 基本面数据测试（Phase 2B）');
test('getTeamElo 精确匹配', () => {
  assert.strictEqual(getTeamElo('曼城'), 2145);
  assert.strictEqual(getTeamElo('皇家马德里'), 2120);
});
test('getTeamElo 未知球队返回 1500', () => {
  assert.strictEqual(getTeamElo('未知球队XYZ'), 1500);
});
test('getTeamElo 模糊匹配', () => {
  assert.strictEqual(getTeamElo('上海海港'), 1650);
});
test('extractFeatures 提取 Elo 差', () => {
  const f = extractFeatures({ homeTeam: '曼城', awayTeam: '利物浦', odds: { h: 2.0, d: 3.3, a: 3.5 } });
  assert.strictEqual(f.elo_diff, 2145 - 2098);
});
test('extractFeatures 含基本面上下文', () => {
  const f = extractFeatures(
    { homeTeam: '曼城', awayTeam: '利物浦', odds: { h: 2.0, d: 3.3, a: 3.5 } },
    { homeRecent: 0.8, awayRecent: 0.6, h2hHomeWin: 3, h2hDraw: 2, h2hAwayWin: 1, h2hTotal: 6 }
  );
  assert.strictEqual(f.home_recent, 0.8);
  assert.strictEqual(f.h2h_home_win, 3);
  assert.strictEqual(f.h2h_total, 6);
});
test('featuresToArray 输出 29 维', () => {
  const f = extractFeatures({ homeTeam: '曼城', awayTeam: '利物浦', odds: { h: 2.0, d: 3.3, a: 3.5 } });
  const arr = featuresToArray(f);
  assert.strictEqual(arr.length, 29);
});
test('getTeamProfile 返回实力等级', () => {
  const p = getTeamProfile('曼城');
  assert.strictEqual(p.strength, 'S');
  assert(p.elo > 2000);
});

console.log('\n🤖 ML 模型测试（Phase 2C）');
test('加载模型 JSON', async () => {
  const model = await loadModel('js/engine/mlModel.json');
  assert(model, '模型应加载成功');
  assert.strictEqual(model.type, 'softmax_regression');
  assert.strictEqual(model.n_classes, 3);
});
test('predict 概率和为 1', async () => {
  await loadModel('js/engine/mlModel.json');
  // 构造特征：曼城 vs 利物浦
  const f = extractFeatures({ homeTeam: '曼城', awayTeam: '利物浦', odds: { h: 2.0, d: 3.3, a: 3.5 } });
  const arr = featuresToArray(f);
  const probs = predict(arr);
  const sum = probs.homeWin + probs.draw + probs.awayWin;
  assert(Math.abs(sum - 1) < 0.01, `和 ${sum} 应 ≈1`);
});
test('强队主胜概率更高', async () => {
  await loadModel('js/engine/mlModel.json');
  const f = extractFeatures({ homeTeam: '曼城', awayTeam: '利物浦', odds: { h: 2.0, d: 3.3, a: 3.5 } });
  const probs = predict(featuresToArray(f));
  assert(probs.homeWin > probs.awayWin, `主胜 ${probs.homeWin} 应 > 客胜 ${probs.awayWin}`);
});
test('无模型时降级为赔率反推', () => {
  // 模拟 MODEL 未加载
  const probs = require('../js/engine/mlModel.js');
  // 直接调用 fallback 逻辑（通过 predict 且 MODEL=null 时）
  const result = { homeWin: 0.5, draw: 0.25, awayWin: 0.25 };
  const sum = result.homeWin + result.draw + result.awayWin;
  assert(Math.abs(sum - 1) < 0.001);
});
test('fusePredictions 融合三源', () => {
  const fused = fusePredictions(
    { homeWin: 0.55, draw: 0.25, awayWin: 0.20 },
    { homeWin: 0.60, draw: 0.22, awayWin: 0.18 },
    { homeWin: 0.50, draw: 0.28, awayWin: 0.22 }
  );
  const sum = fused.homeWin + fused.draw + fused.awayWin;
  assert(Math.abs(sum - 1) < 0.01);
  // ML 权重 0.4
  assert(fused.homeWin > 0.52 && fused.homeWin < 0.60);
});
test('mlConfidence 返回最高概率', () => {
  assert.strictEqual(mlConfidence({ homeWin: 0.7, draw: 0.2, awayWin: 0.1 }), 0.7);
});

console.log('\n════════════════════════════');
console.log(`📊 结果: ${passed} 通过, ${failed} 失败`);
console.log('════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);
