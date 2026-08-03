/**
 * mlModel.js — ML 模型推理引擎（Phase 2C）
 * 竞彩智选 Pro · 加载训练好的模型（mlModel.json）做预测
 *
 * 模型：Softmax 回归（三分类：胜/平/负）
 * 训练：ml/train_model.py 生成
 * 推理：完全在浏览器端，< 1ms
 */

/* ============================================
   模型加载
   ============================================ */
let MODEL = null;

/**
 * 加载模型权重（JSON）
 * @param {string} [url='js/engine/mlModel.json'] 模型 URL
 */
async function loadModel(url = 'js/engine/mlModel.json') {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    MODEL = await res.json();
    console.log('[ML] 模型已加载:', MODEL.type, 'v' + MODEL.version, MODEL.n_features + ' 特征');
    return MODEL;
  } catch (e) {
    console.warn('[ML] 模型加载失败（降级为 Elo 预测）:', e.message);
    return null;
  }
}

function isModelLoaded() {
  return MODEL !== null;
}

/* ============================================
   推理
   ============================================ */
function softmax(z) {
  const m = Math.max(...z);
  const e = z.map(x => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / s);
}

/**
 * 特征标准化（与训练端 scaler 对齐）
 */
function standardize(features) {
  if (!MODEL.scaler) return features;
  const [means, stds] = MODEL.scaler;
  return features.map((v, i) => (v - means[i]) / stds[i]);
}

/**
 * 预测胜平负概率
 * @param {Array} features 特征数组（featuresToArray 输出，需前 8 维与训练对齐）
 * @returns {{homeWin:number, draw:number, awayWin:number}} 概率 0-1
 */
function predict(features) {
  if (!MODEL) {
    // 降级：无模型时用赔率反推
    return fallbackPredict(features);
  }

  // 取前 n_features 维（与训练对齐）
  const input = standardize(features.slice(0, MODEL.n_features));
  const x = [1.0, ...input];
  const z = MODEL.weights.map(w =>
    w.reduce((sum, wi, j) => sum + wi * x[j], 0)
  );
  const probs = softmax(z);

  return {
    homeWin: +probs[0].toFixed(4),
    draw: +probs[1].toFixed(4),
    awayWin: +probs[2].toFixed(4)
  };
}

/**
 * 降级预测：无模型时用赔率反推
 */
function fallbackPredict(features) {
  const [,,, oddsH, oddsD, oddsA] = features;
  if (oddsH > 1 && oddsA > 1) {
    const sum = 1 / oddsH + 1 / oddsD + 1 / oddsA;
    return {
      homeWin: (1 / oddsH) / sum,
      draw: (1 / oddsD) / sum,
      awayWin: (1 / oddsA) / sum
    };
  }
  return { homeWin: 0.5, draw: 0.25, awayWin: 0.25 };
}

/**
 * 融合预测：ML + Elo + 市场赔率
 * @param {Object} mlProbs ML 概率
 * @param {Object} eloProbs Elo 概率
 * @param {Object} marketProbs 市场概率
 * @param {Object} [weights] 权重 {ml, elo, market}
 */
function fusePredictions(mlProbs, eloProbs, marketProbs, weights = { ml: 0.4, elo: 0.3, market: 0.3 }) {
  const w = {
    ml: weights.ml ?? 0.4,
    elo: weights.elo ?? 0.3,
    market: weights.market ?? 0.3
  };
  return {
    homeWin: +(mlProbs.homeWin * w.ml + eloProbs.homeWin * w.elo + marketProbs.homeWin * w.market).toFixed(4),
    draw: +(mlProbs.draw * w.ml + eloProbs.draw * w.elo + marketProbs.draw * w.market).toFixed(4),
    awayWin: +(mlProbs.awayWin * w.ml + eloProbs.awayWin * w.elo + marketProbs.awayWin * w.market).toFixed(4)
  };
}

/**
 * 置信度
 */
function mlConfidence(probs) {
  return Math.max(probs.homeWin, probs.draw, probs.awayWin);
}

/* ============================================
   导出
   ============================================ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { loadModel, isModelLoaded, predict, fusePredictions, mlConfidence };
}
if (typeof window !== 'undefined') {
  window.MLModel = { loadModel, isModelLoaded, predict, fusePredictions, mlConfidence };
}
