/**
 * components2.test.js — 赔率/分析/工具箱组件测试
 * 运行：node tests/components2.test.js
 */

const { JSDOM } = require('jsdom');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const base = path.join(__dirname, '..');
const utils = require(path.join(base, 'js/core/utils.js'));
const predictor = require(path.join(base, 'js/engine/predictor.js'));
const CONFIG = require(path.join(base, 'config/config.js'));

// 完整 DOM（含所有组件需要的元素，表格用正确结构）
const dom = new JSDOM('<!DOCTYPE html><html><body>' +
  // 赔率监测（tbody 必须在 table 内）
  '<table><tbody id="oddsTableBody"></tbody></table>' +
  '<table><tbody id="asianTableBody"></tbody></table>' +
  '<table><tbody id="ouTableBody"></tbody></table>' +
  '<div id="scoreGrid"></div><div id="goalsGrid"></div><div id="htftGrid"></div><div id="trapList"></div>' +
  // 深度分析
  '<div id="analysisList"></div><div id="analysisDetail"></div>' +
  // 工具箱
  '<table><tbody id="betTableBody"></tbody></table>' +
  '<div id="followList"></div>' +
  '<div id="toolboxTotal"></div><div id="toolboxWin"></div><div id="toolboxLoss"></div><div id="toolboxProfit"></div>' +
  '</body></html>', { url: 'http://localhost/' });
const win = dom.window;
global.document = win.document;
global.window = win;
global.CONFIG = CONFIG;
global.esc = utils.esc;
global.deVigOdds = utils.deVigOdds;
global.eloPredict = predictor.eloPredict;
global.localStorage = win.localStorage;

const { renderOddsMonitor } = require(path.join(base, 'js/components/oddsMonitor.js'));
const { renderAnalysisList, renderAnalysisDetail } = require(path.join(base, 'js/components/analysis.js'));
const { renderToolbox, addBetRecord } = require(path.join(base, 'js/components/toolbox.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + e.message); }
}

const mockMatches = [
  { code: '周日013', league: '巴西杯', homeTeam: '米拉索尔', awayTeam: '格雷米奥', time: '05:00', odds: { h: 1.83, d: 2.90, a: 4.20 }, handicap: '-1' }
];

console.log('\n🎲 renderOddsMonitor 测试');
test('胜平负表 6 行', () => {
  renderOddsMonitor(mockMatches, 0);
  assert.strictEqual(document.querySelectorAll('#oddsTableBody tr').length, 6);
});
test('亚盘表 6 行', () => {
  renderOddsMonitor(mockMatches, 0);
  assert.strictEqual(document.querySelectorAll('#asianTableBody tr').length, 6);
});
test('大小球表 6 行', () => {
  renderOddsMonitor(mockMatches, 0);
  assert.strictEqual(document.querySelectorAll('#ouTableBody tr').length, 6);
});
test('比分格子存在', () => {
  renderOddsMonitor(mockMatches, 0);
  assert(document.querySelectorAll('#scoreGrid .score-cell').length > 10);
});
test('总进球格子 8 个', () => {
  renderOddsMonitor(mockMatches, 0);
  assert.strictEqual(document.querySelectorAll('#goalsGrid .goal-cell').length, 8);
});
test('半全场格子存在', () => {
  renderOddsMonitor(mockMatches, 0);
  assert(document.querySelectorAll('#htftGrid .htft-cell').length > 0);
});

console.log('\n📈 renderAnalysisList/Detail 测试');
test('分析列表 1 项', () => {
  renderAnalysisList(mockMatches, () => {});
  assert.strictEqual(document.querySelectorAll('#analysisList .analysis-item').length, 1);
});
test('分析详情渲染', () => {
  renderAnalysisDetail(mockMatches[0]);
  const html = document.getElementById('analysisDetail').innerHTML;
  assert(html.includes('米拉索尔'), '应包含主队名');
  assert(html.includes('AI 研判'), '应包含研判');
});

console.log('\n🛠️ toolbox 测试');
test('空记录显示空状态', () => {
  localStorage.clear();
  renderToolbox();
  assert(document.getElementById('betTableBody').textContent.includes('暂无'));
});
test('添加投注记录', () => {
  localStorage.clear();
  addBetRecord({ match: '米拉索尔 vs 格雷米奥', type: '胜平负', sel: '主胜', odds: 1.83, amt: 100 });
  const records = JSON.parse(localStorage.getItem('jc_bets') || '[]');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].result, 'pending');
});
test('渲染投注记录', () => {
  localStorage.clear();
  addBetRecord({ match: '测试 vs 比赛', type: '胜平负', sel: '主胜', odds: 2.0, amt: 50 });
  renderToolbox();
  assert(document.getElementById('betTableBody').textContent.includes('测试'));
});

console.log('\n════════════════════════════');
console.log(`📊 结果: ${passed} 通过, ${failed} 失败`);
console.log('════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);
