/**
 * utils.test.js — 工具函数单元测试
 * 运行：node tests/utils.test.js
 */

const assert = require('assert');
const {
  esc, safeNum, deVigOdds, kellyIndex, expectedValue, fmtDate, uniq, toPct
} = require('../js/core/utils.js');

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

console.log('\n🛡️  XSS 转义测试');
test('esc 转义 HTML 特殊字符', () => {
  assert.strictEqual(esc('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('esc 处理 null/undefined', () => {
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
});

test('esc 保留正常文本', () => {
  assert.strictEqual(esc('英超 曼城 vs 阿森纳'), '英超 曼城 vs 阿森纳');
});

console.log('\n🔢 数值工具测试');
test('safeNum 无效值返回 fallback', () => {
  assert.strictEqual(safeNum('abc', 5), 5);
  assert.strictEqual(safeNum(NaN, 0), 0);
  assert.strictEqual(safeNum('3.5', 0), 3.5);
});

test('deVigOdds 去水概率和为 1', () => {
  const p = deVigOdds(2.0, 3.3, 3.4);
  const sum = p.pH + p.pD + p.pA;
  assert(Math.abs(sum - 1) < 0.001, `和 ${sum} 应 ≈1`);
});

test('kellyIndex 正期望为正', () => {
  const k = kellyIndex(2.5, 0.5);
  assert(k > 0, `凯利 ${k} 应 >0`);
});

test('expectedValue 计算正确', () => {
  assert.strictEqual(expectedValue(2.0, 0.6), 0.2);
  assert.strictEqual(expectedValue(2.0, 0.4), -0.2);
});

console.log('\n📅 格式化测试');
test('fmtDate 输出 YYYY-MM-DD', () => {
  assert.strictEqual(fmtDate(new Date(2026, 7, 3)), '2026-08-03');
});

test('toPct 百分比格式', () => {
  assert.strictEqual(toPct(0.654), '65.4%');
});

console.log('\n🔗 集合工具测试');
test('uniq 数组去重', () => {
  assert.deepStrictEqual(uniq([1, 2, 2, 3, 3, 3]), [1, 2, 3]);
});

console.log('\n════════════════════════════');
console.log(`📊 结果: ${passed} 通过, ${failed} 失败`);
console.log('════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
