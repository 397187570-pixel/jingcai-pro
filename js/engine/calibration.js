/**
 * calibration.js — 置信度校准引擎（真实置信度）
 * 竞彩智选 Pro · 用过去 1 年真实数据校准 AI 预测置信度
 *
 * 原理：
 *   模型预测概率 P → 查校准表 → 该区间实际命中率 = 真实置信度
 *   校准表由 ml/collect_and_calibrate.py 用真实赛果生成
 */

/* ============================================
   校准表缓存
   ============================================ */
let CALIBRATION = null;

/**
 * 加载校准表（JSON）
 * @param {string} [url='js/engine/calibration.json']
 */
async function loadCalibration(url = 'js/engine/calibration.json') {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    CALIBRATION = await res.json();
    console.log('[校准] 校准表已加载:', CALIBRATION.n_matches + ' 场比赛, Brier=' + CALIBRATION.brier_score);
    return CALIBRATION;
  } catch (e) {
    console.warn('[校准] 校准表加载失败（使用未校准置信度）:', e.message);
    return null;
  }
}

function isCalibrated() {
  return CALIBRATION !== null && Array.isArray(CALIBRATION.table) && CALIBRATION.table.length > 0;
}

function __nMatches() {
  return CALIBRATION && CALIBRATION.n_matches ? CALIBRATION.n_matches : 0;
}

/* ============================================
   校准查询
   ============================================ */
/**
 * 将预测概率转换为真实置信度
 * @param {number} prob 模型预测概率 0-1
 * @returns {{calibrated:number, raw:number, range:string}} 真实置信度
 */
function calibrateProbability(prob) {
  const p = Math.max(0, Math.min(1, prob));
  const raw = p;

  if (!isCalibrated()) {
    return { calibrated: raw, raw, range: '未校准' };
  }

  // 二分查找所在区间
  const table = CALIBRATION.table;
  let row = table[table.length - 1];
  for (const r of table) {
    if (p >= parseFloat(r.range.split('-')[0]) && p < parseFloat(r.range.split('-')[1])) {
      row = r;
      break;
    }
  }

  return {
    calibrated: row.actual,
    raw,
    range: row.range,
    count: row.count
  };
}

/**
 * 校准胜平负三路概率（每路分别校准，再归一化）
 * @param {{homeWin,draw,awayWin}} probs 原始概率
 * @returns 校准后概率 + 真实置信度
 */
function calibrateProbs(probs) {
  const home = calibrateProbability(probs.homeWin);
  const draw = calibrateProbability(probs.draw);
  const away = calibrateProbability(probs.awayWin);

  // 归一化
  const sum = home.calibrated + draw.calibrated + away.calibrated;
  if (sum <= 0) return { ...probs, confidence: calibrateProbability(Math.max(probs.homeWin, probs.draw, probs.awayWin)) };

  return {
    homeWin: home.calibrated / sum,
    draw: draw.calibrated / sum,
    awayWin: away.calibrated / sum,
    confidence: calibrateProbability(Math.max(probs.homeWin, probs.draw, probs.awayWin)),
    calibrated: true
  };
}

/**
 * 展示用：返回格式化置信度信息
 * @param {number} prob 预测概率
 */
function formatConfidence(prob) {
  const { calibrated, raw, range, count } = calibrateProbability(prob);
  const delta = calibrated - raw;
  return {
    display: Math.round(calibrated * 100) + '%',
    raw: Math.round(raw * 100) + '%',
    range,
    count: count || 0,
    delta: (delta * 100).toFixed(1) + 'pp',
    note: delta < -0.01 ? '保守修正' : delta > 0.01 ? '上调' : '一致'
  };
}

/* ============================================
   导出
   ============================================ */
function __setCalibration(data) {
  CALIBRATION = data;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { loadCalibration, isCalibrated, calibrateProbability, calibrateProbs, formatConfidence, __setCalibration, __nMatches };
}
if (typeof window !== 'undefined') {
  window.Calibration = { loadCalibration, isCalibrated, calibrateProbability, calibrateProbs, formatConfidence, __setCalibration, __nMatches };
}
