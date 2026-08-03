/**
 * calibration.test.js — 置信度校准测试
 * 运行：node tests/calibration.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// 加载校准表（从真实采集结果）
const calibrationPath = path.join(__dirname, '../js/engine/calibration.json');
const calibrationData = JSON.parse(fs.readFileSync(calibrationPath, 'utf8'));

// 模拟加载（直接注入）
const { loadCalibration, isCalibrated, calibrateProbability, calibrateProbs, formatConfidence } =
  require('../js/engine/calibration.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + e.message); }
}

console.log('\n🎯 置信度校准测试');
test('校准表已生成（真实数据）', () => {
  assert(calibrationData.n_matches > 1000, `应有 >1000 场，实际 ${calibrationData.n_matches}`);
  assert(calibrationData.table.length > 3, '应有多个区间');
});

test('校准表加载', async () => {
  // 直接设置缓存
  const cal = require('../js/engine/calibration.js');
  cal.__setCalibration(calibrationData);
  assert.strictEqual(isCalibrated(), true);
});

test('高概率区间的真实置信度', () => {
  const cal = require('../js/engine/calibration.js');
  cal.__setCalibration(calibrationData);
  const r = calibrateProbability(0.75);
  // 0.7-0.8 区间实际 76.4%
  assert(r.calibrated > 0.7 && r.calibrated < 0.85, `实际 ${r.calibrated} 应在 0.7-0.85`);
  assert.strictEqual(r.range, '0.7-0.8');
});

test('低概率区间校准', () => {
  const cal = require('../js/engine/calibration.js');
  cal.__setCalibration(calibrationData);
  const r = calibrateProbability(0.35);
  assert(r.calibrated > 0.3 && r.calibrated < 0.45, `实际 ${r.calibrated} 应在 0.3-0.45`);
});

test('概率边界处理（0 和 1）', () => {
  const cal = require('../js/engine/calibration.js');
  cal.__setCalibration(calibrationData);
  const low = calibrateProbability(0);
  const high = calibrateProbability(1);
  assert(Number.isFinite(low.calibrated));
  assert(Number.isFinite(high.calibrated));
});

test('calibrateProbs 归一化后和为 1', () => {
  const cal = require('../js/engine/calibration.js');
  cal.__setCalibration(calibrationData);
  const result = calibrateProbs({ homeWin: 0.55, draw: 0.25, awayWin: 0.20 });
  const sum = result.homeWin + result.draw + result.awayWin;
  assert(Math.abs(sum - 1) < 0.01, `和 ${sum} 应 ≈1`);
  assert(result.confidence, '应包含 confidence');
});

test('formatConfidence 返回展示信息', () => {
  const cal = require('../js/engine/calibration.js');
  cal.__setCalibration(calibrationData);
  const f = formatConfidence(0.65);
  assert(f.display.includes('%'));
  assert(f.range);
  assert(f.delta);
});

test('未加载校准表时返回原始值', () => {
  const cal = require('../js/engine/calibration.js');
  cal.__setCalibration(null);
  const r = calibrateProbability(0.6);
  assert.strictEqual(r.calibrated, 0.6);
  assert.strictEqual(r.range, '未校准');
});

console.log('\n════════════════════════════');
console.log(`📊 结果: ${passed} 通过, ${failed} 失败`);
console.log('════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);
