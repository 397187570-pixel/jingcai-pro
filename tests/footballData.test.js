/**
 * footballData.test.js — football-data.org API 模块测试
 * 运行：node tests/footballData.test.js
 * 用 mock fetch，不真实请求（保证 CI 稳定）
 */

const assert = require('assert');
const path = require('path');

// mock global fetch
const mockMatches = {
  matches: [
    {
      id: 1, utcDate: '2026-01-28T00:00:00Z',
      competition: { name: 'Campeonato Brasileiro Série A' },
      homeTeam: { name: 'CA Mineiro' },
      awayTeam: { name: 'SE Palmeiras' },
      score: { fullTime: { home: 2, away: 2 }, winner: 'DRAW' },
      status: 'FINISHED'
    },
    {
      id: 2, utcDate: '2026-01-28T00:00:00Z',
      competition: { name: 'Campeonato Brasileiro Série A' },
      homeTeam: { name: 'Coritiba FBC' },
      awayTeam: { name: 'RB Bragantino' },
      score: { fullTime: { home: 0, away: 1 }, winner: 'AWAY_TEAM' },
      status: 'FINISHED'
    }
  ]
};

global.fetch = async (url, options) => {
  const urlStr = String(url);
  if (urlStr.includes('status=FINISHED')) {
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-requests-available-minute', '8'], ['x-requestcounter-reset', '45']]),
      json: async () => mockMatches
    };
  }
  return { ok: false, status: 404, headers: new Map(), json: async () => ({ message: 'Not Found' }) };
};

const { setApiKey, getFinishedMatches, toTrainingSample } = require('../js/api/footballData.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + e.message); }
}

console.log('\n⚽ footballData API 模块测试');

test('未设 Key 时返回错误', async () => {
  setApiKey('');
  const r = await getFinishedMatches('BSA');
  assert(!r.ok);
  assert(r.error.includes('Key'));
});

test('获取已结束比赛（含比分）', async () => {
  setApiKey('test-key');
  const r = await getFinishedMatches('BSA', { limit: 10 });
  assert(r.ok);
  assert.strictEqual(r.data.length, 2);
  assert.strictEqual(r.data[0].homeGoals, 2);
  assert.strictEqual(r.data[0].awayGoals, 2);
});

test('标准化为训练样本（平局 label=1）', () => {
  const sample = toTrainingSample({ homeGoals: 2, awayGoals: 2, homeTeam: 'A', awayTeam: 'B', competition: 'X' });
  assert.strictEqual(sample.label, 1);
});

test('标准化为训练样本（主胜 label=0）', () => {
  const sample = toTrainingSample({ homeGoals: 3, awayGoals: 1, homeTeam: 'A', awayTeam: 'B', competition: 'X' });
  assert.strictEqual(sample.label, 0);
});

test('标准化为训练样本（客胜 label=2）', () => {
  const sample = toTrainingSample({ homeGoals: 0, awayGoals: 2, homeTeam: 'A', awayTeam: 'B', competition: 'X' });
  assert.strictEqual(sample.label, 2);
});

test('无比分返回 null', () => {
  const sample = toTrainingSample({ homeGoals: null, awayGoals: null, homeTeam: 'A', awayTeam: 'B' });
  assert.strictEqual(sample, null);
});

console.log('\n════════════════════════════');
console.log(`📊 结果: ${passed} 通过, ${failed} 失败`);
console.log('════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);
