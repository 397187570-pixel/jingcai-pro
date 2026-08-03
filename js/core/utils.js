/**
 * utils.js — 纯函数工具集（无副作用，可单元测试）
 * 竞彩智选 Pro · 由资深开发工程师规范
 */

/* ============================================
   1. 安全工具（XSS 防护）
   ============================================ */
/**
 * HTML 转义，防止 XSS 注入
 * @param {*} v 任意值
 * @returns {string} 转义后的安全字符串
 */
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 安全模板字符串：自动转义所有插值
 * @example safeHtml`<div>${userInput}</div>`
 */
function safeHtml(strings, ...vals) {
  return strings.reduce((acc, s, i) => acc + esc(vals[i - 1]) + s);
}

/* ============================================
   2. 数值工具
   ============================================ */
/**
 * 安全解析数字，无效返回 fallback
 */
function safeNum(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 去水概率：将赔率转为无庄家优势的真实概率
 * @param {number} h 主胜赔率
 * @param {number} d 平局赔率
 * @param {number} a 客胜赔率
 * @returns {{pH:number, pD:number, pA:number}} 概率（和为 1）
 */
function deVigOdds(h, d, a) {
  const H = safeNum(h, 2), D = safeNum(d, 3), A = safeNum(a, 4);
  if (H <= 1 || D <= 1 || A <= 1) return { pH: 0.5, pD: 0.25, pA: 0.25 };
  const sum = 1 / H + 1 / D + 1 / A;
  return { pH: (1 / H) / sum, pD: (1 / D) / sum, pA: (1 / A) / sum };
}

/**
 * 凯利指数
 * @param {number} odd 赔率
 * @param {number} prob 真实概率
 */
function kellyIndex(odd, prob) {
  const o = safeNum(odd, 0), p = safeNum(prob, 0);
  if (o <= 1) return 0;
  return (o * p - 1) / (o - 1);
}

/**
 * 期望值（EV）
 * @returns 正数为正期望（四舍五入到 4 位小数，避免浮点误差）
 */
function expectedValue(odd, prob) {
  return Math.round((safeNum(odd, 0) * safeNum(prob, 0) - 1) * 10000) / 10000;
}

/* ============================================
   3. 格式化工具
   ============================================ */
function fmtDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.getFullYear() + '-' +
    String(dt.getMonth() + 1).padStart(2, '0') + '-' +
    String(dt.getDate()).padStart(2, '0');
}

function fmtTime(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return String(dt.getHours()).padStart(2, '0') + ':' +
    String(dt.getMinutes()).padStart(2, '0');
}

function fmtMoney(n) {
  const num = safeNum(n, 0);
  return (num > 0 ? '+' : '') + '¥' + num.toFixed(num % 1 ? 2 : 0);
}

/* ============================================
   4. 集合工具
   ============================================ */
/**
 * 数组去重
 */
function uniq(arr) {
  return [...new Set(arr)];
}

/**
 * 分组统计
 * @param {Array} arr 数据
 * @param {Function} keyFn 分组键函数
 */
function groupBy(arr, keyFn) {
  const result = {};
  arr.forEach(item => {
    const k = keyFn(item);
    (result[k] = result[k] || []).push(item);
  });
  return result;
}

/* ============================================
   5. 文本工具
   ============================================ */
function truncate(str, maxLen = 20) {
  const s = String(str || '');
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

/**
 * 转百分比：接受小数(0.654)或整数(65.4)，统一输出百分比字符串
 * @param {number} n 小数或百分数
 * @param {number} [digits=1] 小数位
 */
function toPct(n, digits = 1) {
  const num = safeNum(n, 0);
  const pct = num <= 1 && num > -1 ? num * 100 : num; // 0.654 → 65.4；65.4 → 65.4
  return pct.toFixed(digits) + '%';
}

/* ============================================
   导出（浏览器 + Node 双环境）
   ============================================ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { esc, safeHtml, safeNum, deVigOdds, kellyIndex, expectedValue, fmtDate, fmtTime, fmtMoney, uniq, groupBy, truncate, toPct };
}
/* 浏览器全局挂载：确保 function 声明在 window 上可用 */
if (typeof window !== 'undefined') {
  window.esc = esc;
  window.safeHtml = safeHtml;
  window.safeNum = safeNum;
  window.deVigOdds = deVigOdds;
  window.kellyIndex = kellyIndex;
  window.expectedValue = expectedValue;
  window.fmtDate = fmtDate;
  window.fmtMoney = fmtMoney;
  window.uniq = uniq;
  window.toPct = toPct;
}
