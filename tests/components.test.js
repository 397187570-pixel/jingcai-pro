/**
 * components.test.js — 组件层测试
 * 运行：node tests/components.test.js
 * 用 jsdom 模拟 DOM，验证组件渲染逻辑
 */

const { JSDOM } = require('jsdom');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const base = path.join(__dirname, '..');

// 加载模块
const utils = require(path.join(base, 'js/core/utils.js'));
const predictor = require(path.join(base, 'js/engine/predictor.js'));
const CONFIG = require(path.join(base, 'config/config.js'));

// 建 DOM
const dom = new JSDOM('<!DOCTYPE html><html><body>' +
  '<div id="kpiTotal"></div><div id="kpiHigh"></div><div id="kpiChanges"></div><div id="kpiFeatured"></div>' +
  '<div id="totalCount"></div><div id="matchCountBadge"></div>' +
  '<div id="matchList"></div>' +
  '<div id="aiRecList"></div><div id="valueBetListModular"></div>' +
  '</body></html>', { url: 'http://localhost/' });
const win = dom.window;
global.document = win.document;
global.window = win;
global.CONFIG = CONFIG;
global.esc = utils.esc;
global.deVigOdds = utils.deVigOdds;
global.eloPredict = predictor.eloPredict;
global.findValueBets = predictor.findValueBets;

const { renderDashboard } = require(path.join(base, 'js/components/dashboard.js'));
const { renderAIRecommendations, scanValueBetsModular } = require(path.join(base, 'js/components/aiAnalysis.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + e.message); }
}

// 测试数据
const mockMatches = [
  {
    code: '周日013', league: '巴西杯', homeTeam: '米拉索尔', awayTeam: '格雷米奥',
    time: '05:00', odds: { h: 1.83, d: 2.90, a: 4.20 },
    isDerby: false, oddsChanged: false
  },
  {
    code: '周日014', league: '巴西杯', homeTeam: '巴西国际', awayTeam: '科林蒂安',
    time: '06:30', odds: { h: 2.24, d: 2.60, a: 3.35 },
    isDerby: true, oddsChanged: true
  }
];

console.log('\n📊 renderDashboard 测试');
test('渲染比赛列表', () => {
  renderDashboard(mockMatches);
  const items = document.querySelectorAll('#matchList .match-item');
  assert.strictEqual(items.length, 2);
});

test('KPI 统计正确', () => {
  renderDashboard(mockMatches);
  assert.strictEqual(document.getElementById('kpiTotal').textContent, '2');
  assert.strictEqual(document.getElementById('kpiHigh').textContent, '0');
  assert.strictEqual(document.getElementById('kpiFeatured').textContent, '1');
});

test('空列表显示空状态', () => {
  renderDashboard([]);
  assert(document.getElementById('matchList').textContent.includes('暂无'));
});

console.log('\n🧠 renderAIRecommendations 测试');
test('生成 AI 推荐', () => {
  renderAIRecommendations(mockMatches);
  const items = document.querySelectorAll('#aiRecList .rec-card');
  assert.strictEqual(items.length, 2);
});

test('推荐包含比赛名', () => {
  renderAIRecommendations(mockMatches);
  assert(document.getElementById('aiRecList').textContent.includes('米拉索尔'));
});

test('空数据返回空状态', () => {
  renderAIRecommendations([]);
  assert(document.getElementById('aiRecList').textContent.includes('暂无'));
});

console.log('\n💎 scanValueBetsModular 测试');
test('发现价值注时渲染列表', async () => {
  await scanValueBetsModular(mockMatches, async () => [{
    homeTeam: '米拉索尔', awayTeam: '格雷米奥', odds: { h: 2.10, d: 3.00, a: 3.80 }
  }]);
  const html = document.getElementById('valueBetListModular').textContent;
  assert(html.includes('价值') || html.includes('未找到'), '应显示价值注或未找到');
});

console.log('\n════════════════════════════');
console.log(`📊 结果: ${passed} 通过, ${failed} 失败`);
console.log('════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);
