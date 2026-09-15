/**
 * oddsHistory.js — 赔率时序存储层（国内外赔率快照库）
 * 竞彩智选 Pro · 数据分析系统 · P1 地基
 *
 * 职责：把"某一时刻的国内外赔率"作为一条快照(snapshot)持久化，
 *       形成可按比赛查询的时间序列，供后续的偏差/背离/收敛分析、
 *       市场热度监测、异动预警、权重规律挖掘使用。
 *
 * 存储后端：
 *   - 浏览器：IndexedDB（异步、持久、可存数万条）
 *   - Node：内存 Map 兜底（供单元测试 / 回测脚本使用）
 *
 * 快照结构（一条记录）：
 *   {
 *     id,                       // 自增主键（IndexedDB）；内存模式下为自赋值
 *     matchId,                  // 比赛唯一标识（竞彩场次号 code）
 *     ts,                       // 快照时间 epoch ms
 *     jc:  { h, d, a } | null,  // 国内竞彩官方 1X2 赔率
 *     intl: [                   // 国外机构 1X2 快照数组
 *       { book: 'Pinnacle', h, d, a, url? }
 *     ],
 *     meta: { league, homeTeam, awayTeam, handicap?, kickoff? },
 *     implied: {               // 写入时算好的去水隐含概率（省去重复计算）
 *       jc:      { h, d, a } | null,  // 竞彩去水隐含
 *       intlAvg: { h, d, a } | null,  // 国外机构均值去水隐含
 *       sharp:   { h, d, a } | null   // 指定 sharp 机构（默认 Pinnacle）
 *     }
 *   }
 *
 * 设计要点：
 *   - record() 内置"去重"：若与最新一条快照赔率完全一致，则不落库，避免轮询刷出海量重复。
 *   - 所有方法返回 Promise，浏览器/Node 同一套 API。
 *   - 纯函数工具（impliedFromOdds / avgOdds / diffOdds）无副作用，便于单测与 P3 复用。
 */

(function (global) {
  'use strict';

  const DB_NAME = 'jingcai-odds-history';
  const STORE = 'snapshots';
  const DB_VERSION = 1;
  const DEFAULT_SHARP = 'Pinnacle';

  /* ---------- 运行态 ---------- */
  let _db = null;       // IndexedDB 连接
  let _mem = null;      // Node 兜底: { seq, store: [] }
  let _initPromise = null;

  function hasIDB() {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  }

  /* ============================================
     纯函数工具（被存储层与分析层共用）
     ============================================ */

  /**
   * 去水隐含概率：赔率 -> 公平概率（和为 1）
   * @param {{h:number,d:number,a:number}} o
   * @returns {{h:number,d:number,a:number}}
   */
  function impliedFromOdds(o) {
    if (!o || !o.h || !o.d || !o.a) return null;
    const s = 1 / o.h + 1 / o.d + 1 / o.a;
    if (!s) return null;
    return { h: (1 / o.h) / s, d: (1 / o.d) / s, a: (1 / o.a) / s };
  }

  /**
   * 多家机构赔率取均值（未去水，仅算术平均，用于画"市场中枢"）
   * @param {Array<{h:number,d:number,a:number}>} list
   * @returns {{h:number,d:number,a:number}|null}
   */
  function avgOdds(list) {
    if (!Array.isArray(list) || !list.length) return null;
    let h = 0, d = 0, a = 0, n = 0;
    list.forEach(b => {
      if (b && b.h && b.d && b.a) { h += b.h; d += b.d; a += b.a; n++; }
    });
    if (!n) return null;
    return { h: h / n, d: d / n, a: a / n };
  }

  /**
   * 两组赔率的差值（a - b），用于计算"异动幅度"
   * @returns {{h:number,d:number,a:number}}
   */
  function diffOdds(a, b) {
    if (!a || !b) return null;
    return {
      h: round3((a.h || 0) - (b.h || 0)),
      d: round3((a.d || 0) - (b.d || 0)),
      a: round3((a.a || 0) - (b.a || 0))
    };
  }

  function round3(x) { return Math.round((x + Number.EPSILON) * 1000) / 1000; }

  /**
   * 判定两条快照赔率是否"实质相同"（保留 3 位小数比较，规避浮点抖动）
   */
  function sameOddsGroup(a, b) {
    if (!a || !b) return false;
    const ra = jcKey(a.jc), rb = jcKey(b.jc);
    if (ra !== rb) return false;
    const ia = (a.intl || []).map(bk => bk.book + ':' + round3(bk.h) + '/' + round3(bk.d) + '/' + round3(bk.a)).sort().join('|');
    const ib = (b.intl || []).map(bk => bk.book + ':' + round3(bk.h) + '/' + round3(bk.d) + '/' + round3(bk.a)).sort().join('|');
    return ia === ib;
  }
  function jcKey(jc) {
    if (!jc) return 'null';
    return round3(jc.h) + '/' + round3(jc.d) + '/' + round3(jc.a);
  }

  /* ============================================
     IndexedDB / 内存 适配层
     ============================================ */

  function openDB() {
    if (_initPromise) return _initPromise;
    if (!hasIDB()) {
      _mem = { seq: 1, store: [] };
      _initPromise = Promise.resolve(_mem);
      return _initPromise;
    }
    _initPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = function (e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          os.createIndex('byMatch', 'matchId', { unique: false });
          os.createIndex('byTs', 'ts', { unique: false });
        }
      };
      req.onsuccess = function (e) { _db = e.target.result; resolve(_db); };
      req.onerror = function (e) { reject(e.target.error || new Error('IndexedDB open failed')); };
    });
    return _initPromise;
  }

  function ensureDB() {
    if (_db || _mem) return Promise.resolve(_db || _mem);
    return openDB();
  }

  /* ---------- 写入 ---------- */
  function idbAdd(snap) {
    return ensureDB().then(backend => {
      if (_mem) {
        snap.id = _mem.seq++;
        _mem.store.push(snap);
        return snap;
      }
      return new Promise((resolve, reject) => {
        const tx = _db.transaction(STORE, 'readwrite');
        const os = tx.objectStore(STORE);
        const r = os.add(snap);
        r.onsuccess = function () { snap.id = r.result; resolve(snap); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  /* ---------- 查询某场序列 ---------- */
  function idbGetSeries(matchId, opts) {
    opts = opts || {};
    return ensureDB().then(backend => {
      if (_mem) {
        let arr = _mem.store.filter(s => s.matchId === matchId);
        arr.sort((x, y) => x.ts - y.ts);
        if (opts.since) arr = arr.filter(s => s.ts >= opts.since);
        if (opts.limit && arr.length > opts.limit) arr = arr.slice(arr.length - opts.limit);
        return arr;
      }
      return new Promise((resolve, reject) => {
        const tx = _db.transaction(STORE, 'readonly');
        const idx = tx.objectStore(STORE).index('byMatch');
        const req = idx.getAll(IDBKeyRange.only(matchId));
        req.onsuccess = function () {
          let arr = (req.result || []).sort((x, y) => x.ts - y.ts);
          if (opts.since) arr = arr.filter(s => s.ts >= opts.since);
          if (opts.limit && arr.length > opts.limit) arr = arr.slice(arr.length - opts.limit);
          resolve(arr);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  /* ---------- 单场最新 ---------- */
  function idbGetLatest(matchId) {
    return idbGetSeries(matchId, { limit: 1 }).then(a => (a && a.length ? a[a.length - 1] : null));
  }

  /* ---------- 多场最新 ---------- */
  function idbGetLatestMany(matchIds) {
    return Promise.all(matchIds.map(id => idbGetLatest(id))).then(results => {
      const out = {};
      matchIds.forEach((id, i) => { if (results[i]) out[id] = results[i]; });
      return out;
    });
  }

  /* ---------- 全部比赛序列（按 matchId 分组，供 P6 提醒中心扫描） ---------- */
  function idbGetAllSeries() {
    return ensureDB().then(backend => {
      const regroup = arr => {
        const map = {};
        (arr || []).forEach(s => { (map[s.matchId] = map[s.matchId] || []).push(s); });
        Object.keys(map).forEach(k => map[k].sort((x, y) => x.ts - y.ts));
        return map;
      };
      if (_mem) return regroup(_mem.store);
      return new Promise((resolve, reject) => {
        const tx = _db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(regroup(req.result));
        req.onerror = () => reject(req.error);
      });
    });
  }

  /* ---------- 修剪（保留最近 N 条） ---------- */
  function idbPrune(matchId, maxPoints) {
    return idbGetSeries(matchId, {}).then(arr => {
      if (arr.length <= maxPoints) return 0;
      const toDelete = arr.slice(0, arr.length - maxPoints);
      return Promise.all(toDelete.map(s => idbDelete(s.id))).then(() => toDelete.length);
    });
  }

  function idbDelete(id) {
    return ensureDB().then(backend => {
      if (_mem) { _mem.store = _mem.store.filter(s => s.id !== id); return; }
      return new Promise((resolve, reject) => {
        const tx = _db.transaction(STORE, 'readwrite');
        const r = tx.objectStore(STORE).delete(id);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
    });
  }

  /* ---------- 计数 ---------- */
  function idbCount(matchId) {
    return ensureDB().then(backend => {
      if (_mem) {
        return matchId ? _mem.store.filter(s => s.matchId === matchId).length : _mem.store.length;
      }
      return new Promise((resolve, reject) => {
        const tx = _db.transaction(STORE, 'readonly');
        const os = tx.objectStore(STORE);
        const req = matchId ? os.index('byMatch').count(IDBKeyRange.only(matchId)) : os.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
  }

  /* ---------- 清空 ---------- */
  function idbClear(matchId) {
    return ensureDB().then(backend => {
      if (_mem) {
        if (matchId) _mem.store = _mem.store.filter(s => s.matchId !== matchId);
        else _mem.store = [];
        return;
      }
      if (!matchId) {
        return new Promise((resolve, reject) => {
          const tx = _db.transaction(STORE, 'readwrite');
          const r = tx.objectStore(STORE).clear();
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
        });
      }
      return idbGetSeries(matchId, {}).then(arr => Promise.all(arr.map(s => idbDelete(s.id))).then(() => {}));
    });
  }

  /* ============================================
     公开 API
     ============================================ */

  /**
   * 初始化（打开数据库）。可重复调用，幂等。
   * @returns {Promise}
   */
  function init() { return openDB(); }

  /**
   * 写入一条赔率快照（带去重 + 隐含概率预计算）
   * @param {string} matchId
   * @param {Object} payload { jc?, intl?, meta?, sharpBook?, ts?, skipIfSame? }
   * @returns {Promise<Object|null>} 写入的快照；若因去重跳过则返回最新快照（不新增）
   */
  function record(matchId, payload) {
    payload = payload || {};
    const snap = {
      matchId: matchId,
      ts: typeof payload.ts === 'number' ? payload.ts : Date.now(),
      jc: payload.jc || null,
      intl: Array.isArray(payload.intl) ? payload.intl.map(b => ({
        book: b.book, h: Number(b.h), d: Number(b.d), a: Number(b.a), url: b.url || null
      })) : [],
      meta: payload.meta || {}
    };

    // 预计算去水隐含概率
    const sharpBook = payload.sharpBook || DEFAULT_SHARP;
    const sharp = snap.intl.find(b => b.book === sharpBook) || snap.intl[0] || null;
    snap.implied = {
      jc: snap.jc ? impliedFromOdds(snap.jc) : null,
      intlAvg: snap.intl.length ? impliedFromOdds(avgOdds(snap.intl)) : null,
      sharp: sharp ? impliedFromOdds({ h: sharp.h, d: sharp.d, a: sharp.a }) : null
    };

    // 去重：与最新一条实质相同则不落库
    if (payload.skipIfSame !== false) {
      return idbGetLatest(matchId).then(latest => {
        if (latest && sameOddsGroup(latest, snap)) return latest;
        return idbAdd(snap);
      });
    }
    return idbAdd(snap);
  }

  /**
   * 便捷：直接吃一场比赛对象（竞彩 code + odds + 联赛/队名）+ 可选国际赔率
   * @param {Object} match { code, league, homeTeam, awayTeam, odds:{h,d,a}, handicap?, time? }
   * @param {Array} [intl] [{ book, h, d, a }]
   * @param {Object} [opts] { sharpBook?, skipIfSame? }
   */
  function recordMatch(match, intl, opts) {
    if (!match) return Promise.resolve(null);
    const matchId = match.code || (match.homeTeam + '_vs_' + match.awayTeam);
    return record(matchId, {
      jc: match.odds ? { h: match.odds.h, d: match.odds.d, a: match.odds.a } : null,
      intl: intl || [],
      meta: {
        league: match.league, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
        handicap: match.handicap, kickoff: match.time || match.date
      },
      sharpBook: opts && opts.sharpBook,
      skipIfSame: opts ? opts.skipIfSame : undefined
    });
  }

  function getSeries(matchId, opts) { return idbGetSeries(matchId, opts); }
  function getLatest(matchId) { return idbGetLatest(matchId); }
  function getLatestMany(matchIds) { return idbGetLatestMany(matchIds); }
  function getAllSeries() { return idbGetAllSeries(); }
  function prune(matchId, maxPoints) { return idbPrune(matchId, maxPoints); }
  function clear(matchId) { return idbClear(matchId); }
  function count(matchId) { return idbCount(matchId); }

  /**
   * 导出某场（或全部）序列为 JSON 字符串（回测 / 备份）
   */
  function exportJSON(matchId) {
    if (matchId) return idbGetSeries(matchId, {}).then(a => JSON.stringify(a, null, 2));
    return ensureDB().then(() => {
      if (_mem) return Promise.resolve(JSON.stringify(_mem.store, null, 2));
      return new Promise((resolve, reject) => {
        const tx = _db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(JSON.stringify(req.result, null, 2));
        req.onerror = () => reject(req.error);
      });
    });
  }

  /**
   * 导入快照数组（去重由 record 处理）
   * @param {Array|string} data
   */
  function importJSON(data) {
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    if (!Array.isArray(arr)) return Promise.reject(new Error('importJSON expects array'));
    return Promise.all(arr.map(s => idbAdd({
      matchId: s.matchId, ts: s.ts, jc: s.jc, intl: s.intl || [],
      meta: s.meta || {}, implied: s.implied || null
    }))).then(() => arr.length);
  }

  /**
   * 序列摘要（P3/P5 直接复用）：首条 vs 最新条的关键变化
   * @returns {Promise<{first, latest, durationMs, points, jcMove, intlAvgMove, sharpMove}|null>}
   */
  function summary(matchId) {
    return idbGetSeries(matchId, {}).then(arr => {
      if (!arr.length) return null;
      const first = arr[0], latest = arr[arr.length - 1];
      const out = {
        points: arr.length,
        durationMs: latest.ts - first.ts,
        first: { ts: first.ts, jc: first.jc, implied: first.implied },
        latest: { ts: latest.ts, jc: first.jc, implied: latest.implied }
      };
      if (first.jc && latest.jc) out.jcMove = diffOdds(latest.jc, first.jc);
      if (first.implied && latest.implied) {
        if (first.implied.intlAvg && latest.implied.intlAvg)
          out.intlAvgMove = diffProb(latest.implied.intlAvg, first.implied.intlAvg);
        if (first.implied.sharp && latest.implied.sharp)
          out.sharpMove = diffProb(latest.implied.sharp, first.implied.sharp);
      }
      return out;
    });
  }
  function diffProb(a, b) {
    return { h: round3(a.h - b.h), d: round3(a.d - b.d), a: round3(a.a - b.a) };
  }

  const api = {
    // 生命周期
    init,
    // 写入
    record, recordMatch,
    // 查询
    getSeries, getLatest, getLatestMany, getAllSeries, summary,
    // 维护
    prune, clear, count, exportJSON, importJSON,
    // 纯函数工具
    impliedFromOdds, avgOdds, diffOdds
  };

  /* 浏览器全局挂载 */
  if (typeof window !== 'undefined') window.OddsHistory = api;
  /* Node 导出（供单测 / 回测） */
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  return api;
})(typeof window !== 'undefined' ? window : this);
