/*
 * clvFeed.js — 服务端赔率快照 → 前端 R2 的桥接层
 * 不惑智选 Pro · 引擎层
 *
 * 服务端每日管道把竞彩在售 HAD 赔率写入 ml/data/odds_snapshots.jsonl，
 * odds_snapshots.py 再聚合成 ml/data/clv_feed.json（每场首/末赔率）。
 * 本模块负责：
 *   1. fetch 这个 feed（多候选路径，兼容根目录/子目录部署）；
 *   2. 按 matchId / code / 队名 建索引；
 *   3. 与浏览器本地 OddsHistory 快照合并，把 openOdds/closeOdds 挂到比赛对象；
 *   4. 只有 snapshots>=2 的场次才参与（单快照没有"移动"，R2 自动跳过）。
 *
 * 纯函数部分可在 Node 下单测；浏览器端通过 window.CLVFeed 调用。
 */
(function (global) {
  'use strict';

  function normOdds(o) {
    if (!Array.isArray(o) || o.length < 3) return null;
    var a = [Number(o[0]), Number(o[1]), Number(o[2])];
    for (var i = 0; i < 3; i++) if (!(a[i] > 1)) return null;
    return a;
  }

  function rawKeys(m) {
    var out = [];
    if (m.id !== undefined && m.id !== null && m.id !== '') out.push(String(m.id));
    if (m.matchId !== undefined && m.matchId !== null && m.matchId !== '') out.push(String(m.matchId));
    if (m.code) out.push(String(m.code));
    var h = m.homeTeamFull || m.homeTeam || m.home || '';
    var a = m.awayTeamFull || m.awayTeam || m.away || '';
    if (h && a) out.push(h + '_vs_' + a);
    return out;
  }

  function lookupKeys(m) {
    var out = [];
    rawKeys(m).forEach(function (k) {
      out.push('m:' + k, 'c:' + k, 'n:' + k);
    });
    return out;
  }

  /** 只索引真正有移动的场次（snapshots>=2） */
  function buildLookup(feed) {
    var map = {};
    var list = (feed && Array.isArray(feed.matches)) ? feed.matches : (Array.isArray(feed) ? feed : []);
    list.forEach(function (r) {
      if (!r || !(r.snapshots >= 2)) return;
      var keys = [r.matchId, r.code, (r.home || '') + '_vs_' + (r.away || '')];
      keys.forEach(function (k) {
        if (!k) return;
        k = String(k);
        map['m:' + k] = r;
        map['c:' + k] = r;
        map['n:' + k] = r;
      });
    });
    return map;
  }

  /**
   * 把服务端 feed + 浏览器时序合并到 matches，返回被富化的场次数。
   * browserMap: { matchId: [snapshot, ...] }，可为空。
   */
  function applyTo(matches, feed, browserMap) {
    if (!Array.isArray(matches)) return 0;
    var lookup = buildLookup(feed);
    var n = 0;
    matches.forEach(function (m) {
      var rec = null;
      var lks = lookupKeys(m);
      for (var i = 0; i < lks.length; i++) {
        if (lookup[lks[i]]) { rec = lookup[lks[i]]; break; }
      }
      var open = rec ? normOdds(rec.openOdds) : null;
      var close = rec ? normOdds(rec.closeOdds) : null;

      // 浏览器端补充：服务端尚未攒够 2 条时，用本地时序兜底
      if ((!open || !close) && browserMap && typeof browserMap === 'object') {
        var series = null;
        var rks = rawKeys(m);
        for (var j = 0; j < rks.length; j++) {
          if (Array.isArray(browserMap[rks[j]])) { series = browserMap[rks[j]]; break; }
        }
        if (series && series.length >= 2) {
          var f = series[0].jc || series[0].odds;
          var l = series[series.length - 1].jc || series[series.length - 1].odds;
          if (f && l) {
            if (!open) open = normOdds([f.h, f.d, f.a]);
            if (!close) close = normOdds([l.h, l.d, l.a]);
          }
        }
      }
      if (open && close) {
        m.openOdds = open;
        m.closeOdds = close;
        n++;
      }
    });
    return n;
  }

  /** fetch 服务端 feed；任何失败返回 null，调用方优雅降级 */
  function load(version) {
    if (typeof fetch === 'undefined') return Promise.resolve(null);
    var v = version || (global.APP_VERSION || '');
    var urls = [
      'ml/data/clv_feed.json?v=' + v,
      './ml/data/clv_feed.json?v=' + v,
      'jingcai-pro/ml/data/clv_feed.json?v=' + v,
      '/jingcai-pro/ml/data/clv_feed.json?v=' + v
    ];
    function tryFetch(i) {
      if (i >= urls.length) return Promise.resolve(null);
      return fetch(urls[i]).then(function (r) {
        if (!r.ok) throw 0;
        return r.json();
      }).catch(function () { return tryFetch(i + 1); });
    }
    return tryFetch(0);
  }

  var api = { load: load, applyTo: applyTo, buildLookup: buildLookup, rawKeys: rawKeys, normOdds: normOdds };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.CLVFeed = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
