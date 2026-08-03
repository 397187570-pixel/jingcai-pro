/**
 * api.test.js — API 层单元测试
 * 运行：node tests/api.test.js
 * 注：网络测试用 mock，不真实请求（保证 CI 稳定）
 */

const assert = require('assert');
const { normalizeMatches } = require('../js/api/sporttery.js');
const { normalizeOdds } = require('../js/api/oddsApi.js');

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

console.log('\n⚽ sporttery.normalizeMatches 测试');

const mockRaw = {
  value: {
    matchInfoList: [{
      businessDate: '2026-08-03',
      subMatchList: [{
        matchId: 2040706,
        matchNumStr: '周日013',
        matchNum: 7013,
        matchDate: '2026-08-03',
        matchTime: '05:00:00',
        matchWeek: '周日',
        leagueAbbName: '巴西杯',
        leagueAllName: '巴西杯',
        homeTeamAbbName: '米拉索尔',
        homeTeamAllName: '米拉索尔',
        awayTeamAbbName: '格雷米奥',
        awayTeamAllName: '格雷米奥',
        matchStatus: 'Selling',
        had: { h: '1.83', d: '2.90', a: '4.20' },
        hhad: { h: '2.00', d: '3.20', a: '3.50', goalLine: '-1' },
        crs: {},
        ttg: {},
        hafu: {}
      }]
    }]
  }
};

test('标准化：提取核心字段', () => {
  const matches = normalizeMatches(mockRaw);
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].code, '周日013');
  assert.strictEqual(matches[0].homeTeam, '米拉索尔');
  assert.strictEqual(matches[0].odds.h, 1.83);
});

test('标准化：字符串赔率转数字', () => {
  const matches = normalizeMatches(mockRaw);
  assert.strictEqual(typeof matches[0].odds.h, 'number');
  assert.strictEqual(typeof matches[0].odds.d, 'number');
});

test('标准化：空数据返回空数组', () => {
  assert.deepStrictEqual(normalizeMatches({ value: {} }), []);
  assert.deepStrictEqual(normalizeMatches({}), []);
});

console.log('\n📈 oddsApi.normalizeOdds 测试');

const mockOdds = [{
  home_team: 'Manchester City',
  away_team: 'Arsenal',
  commence_time: '2026-08-03T19:00:00Z',
  bookmakers: [{
    key: 'williamhill',
    markets: [{
      key: 'h2h',
      outcomes: [
        { name: 'Home', price: 1.85 },
        { name: 'Draw', price: 3.60 },
        { name: 'Away', price: 4.20 }
      ]
    }]
  }, {
    key: 'bet365',
    markets: [{
      key: 'h2h',
      outcomes: [
        { name: 'Home', price: 1.87 },
        { name: 'Draw', price: 3.55 },
        { name: 'Away', price: 4.10 }
      ]
    }]
  }]
}];

test('标准化：多公司平均赔率', () => {
  const odds = normalizeOdds(mockOdds);
  assert.strictEqual(odds.length, 1);
  assert.strictEqual(odds[0].odds.h, (1.85 + 1.87) / 2);
  assert.strictEqual(odds[0].bookmakers, 2);
});

test('标准化：过滤无效赔率', () => {
  const odds = normalizeOdds([{ home_team: 'A', away_team: 'B', bookmakers: [] }]);
  assert.strictEqual(odds.length, 0);
});

console.log('\n════════════════════════════');
console.log(`📊 结果: ${passed} 通过, ${failed} 失败`);
console.log('════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
