/**
 * predictor.test.js — 预测引擎单元测试
 * 运行：node tests/predictor.test.js
 * 使用 Node 原生 assert，无第三方依赖
 */

const assert = require('assert');
const {
  eloPredict, poisson, factorial, poissonScoreMatrix,
  scoreMatrixToWDL, fusedPredict, confidence, findValueBets, deVig
} = require('../js/engine/predictor.js');

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

console.log('\n📐 eloPredict 测试');
test('强队(1800) vs 弱队(1500)：主胜概率应 >60%', () => {
  const r = eloPredict(1800, 1500);
  assert(r.homeWin > 60, `主胜 ${r.homeWin} 应 >60`);
  assert(r.awayWin < 30, `客胜 ${r.awayWin} 应 <30`);
});

test('势均力敌(1500 vs 1500)：三路概率接近', () => {
  const r = eloPredict(1500, 1500);
  assert(r.homeWin > 40 && r.homeWin < 60, `主胜 ${r.homeWin} 应在 40-60`);
  assert(r.draw >= 10, `平局 ${r.draw} 应 >=10`);
});

test('三路概率之和 ≈ 100', () => {
  const r = eloPredict(1600, 1450);
  const sum = r.homeWin + r.draw + r.awayWin;
  assert(Math.abs(sum - 100) < 1, `和 ${sum} 应 ≈100`);
});

console.log('\n🧮 poisson / factorial 测试');
test('factorial(0)=1, factorial(5)=120', () => {
  assert.strictEqual(factorial(0), 1);
  assert.strictEqual(factorial(5), 120);
});

test('poisson 概率和为 1（lambda=1.5, k=0..10）', () => {
  let sum = 0;
  for (let k = 0; k <= 10; k++) sum += poisson(1.5, k);
  assert(Math.abs(sum - 1) < 0.001, `和 ${sum} 应 ≈1`);
});

test('poisson 比分矩阵生成', () => {
  const m = poissonScoreMatrix(1.5, 1.2);
  const entries = Object.keys(m);
  assert(entries.length > 10, `应有 >10 个比分，实际 ${entries.length}`);
  // 概率总和 ≈ 1
  const sum = Object.values(m).reduce((a, b) => a + b, 0);
  assert(Math.abs(sum - 1) < 0.1, `概率和 ${sum} 应 ≈1`);
});

test('scoreMatrixToWDL 胜平负概率和为 1', () => {
  const m = poissonScoreMatrix(1.8, 1.0);
  const wdl = scoreMatrixToWDL(m);
  const sum = wdl.homeWin + wdl.draw + wdl.awayWin;
  assert(Math.abs(sum - 1) < 0.01, `和 ${sum} 应 ≈1`);
});

console.log('\n🔮 fusedPredict 融合预测测试');
test('融合预测概率和为 1', () => {
  const r = fusedPredict(1600, 1500, { h: 2.1, d: 3.4, a: 3.2 });
  const sum = r.homeWin + r.draw + r.awayWin;
  assert(Math.abs(sum - 1) < 0.001, `和 ${sum} 应 ≈1`);
});

test('confidence 返回最高概率', () => {
  const c = confidence({ homeWin: 0.55, draw: 0.25, awayWin: 0.20 });
  assert.strictEqual(c, 0.55);
});

console.log('\n💎 价值注检测测试');
test('国际市场低估主胜时返回价值注', () => {
  // 竞彩主胜概率 55%，国际只有 45% → 价值 +10pp
  const bets = findValueBets(
    { h: 1.80, d: 3.50, a: 4.00 },  // 竞彩
    { h: 2.20, d: 3.20, a: 3.10 },  // 国际
    0.04
  );
  assert(bets.length > 0, '应找到至少一个价值注');
  assert(bets[0].pick === '主胜', `首选应为主胜，实际 ${bets[0].pick}`);
});

test('赔率接近时无价值注', () => {
  const bets = findValueBets(
    { h: 2.00, d: 3.30, a: 3.40 },
    { h: 2.05, d: 3.25, a: 3.30 },
    0.04
  );
  assert.strictEqual(bets.length, 0);
});

test('deVig 去水概率和为 1', () => {
  const p = deVig({ h: 2.0, d: 3.3, a: 3.4 });
  const sum = p.h + p.d + p.a;
  assert(Math.abs(sum - 1) < 0.001, `和 ${sum} 应 ≈1`);
});

console.log('\n════════════════════════════');
console.log(`📊 结果: ${passed} 通过, ${failed} 失败`);
console.log('════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
