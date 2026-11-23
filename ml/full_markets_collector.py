#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
full_markets_collector.py — 竞彩全玩法赔率采集与落库
=====================================================
背景：history_matches.json 的历史赛果接口(getUniformMatchResultV1)只返回
      HAD 三项赔率 + 让球盘，没有 TTG/CRS/HAFU。这导致"全玩法推荐"无法回测。
      竞彩官方没有单场历史赔率接口，已结算比赛的全玩法赔率无法回溯。

本模块职责：从【当前在售】的 calculator 接口(getMatchCalculatorV1)拉取
      HAD/HHAD/TTG/CRS/HAFU 五玩法赔率，按 matchId 幂等落库到
      ml/data/full_markets.jsonl，从今天起逐日积累全玩法样本。

落库格式（每行一场 JSON）：
  {
    "matchId": "2042942", "code": "周一001", "date": "2026-11-24",
    "time": "02:00:00", "league": "瑞超", "home": "...", "away": "...",
    "had": {h,d,a} | null, "hhad": {h,d,a,goalLine} | null,
    "ttg": {s0..s7} | null, "crs": {...} | null, "hafu": {...} | null,
    "oddsInferred": false,
    "firstSeen": "2026-11-23T18:xx:xx",   # 首次采集时间
    "lastSeen": "2026-11-23T18:xx:xx",    # 最近一次采集（赔率可能变动）
    "settled": null                        # 结算后回填：{winFlag, scoreHT, scoreFT} 或 null
  }

幂等：以 matchId 为键，已存在则更新 lastSeen 与赔率（保留 firstSeen）；
      不存在则追加。settled 一旦回填不再清除。

用法：
  python3 full_markets_collector.py              # 采集当前在售全玩法并落库
  python3 full_markets_collector.py --settle     # 采集后尝试用赛果接口回填已结算场次的 winFlag/比分
  python3 full_markets_collector.py --stats      # 只打印当前落库统计
"""
import os, sys, json, time, datetime, urllib.request, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "data", "full_markets.jsonl")

CALC_URL = ("https://webapi.sporttery.cn/gateway/uniform/football/"
            "getMatchCalculatorV1.qry?poolCode=HAD,HHAD,TTG,CRS,HAFU&channel=c_web")
RESULT_URL = ("https://webapi.sporttery.cn/gateway/uniform/football/"
              "getUniformMatchResultV1.qry")

HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.sporttery.cn/'}


def _get(url, timeout=20):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _clean_pool(d):
    """去掉 {h,d,a,f,...} 里以 f 结尾的更新标志与 updateDate/updateTime，只留赔率键。"""
    if not isinstance(d, dict):
        return None
    out = {}
    for k, v in d.items():
        if k in ('updateDate', 'updateTime'):
            continue
        if str(k).endswith('f'):
            continue
        if v in (None, ''):
            continue
        out[k] = v
    return out if out else None


def fetch_live():
    """拉取当前在售全玩法赔率，返回规范化场次列表。"""
    data = _get(CALC_URL)
    if data.get('errorCode') not in (0, '0', None):
        raise RuntimeError('calculator 接口错误: ' + str(data.get('errorCode')))
    il = (data.get('value') or {}).get('matchInfoList') or []
    rows = []
    for day in il:
        for m in (day.get('subMatchList') or []):
            mid = str(m.get('matchId') or '')
            if not mid:
                continue
            rows.append({
                'matchId': mid,
                'code': m.get('matchNumStr') or '',
                'date': m.get('matchDate') or '',
                'time': m.get('matchTime') or '',
                'league': m.get('leagueAbbName') or '',
                'home': m.get('homeTeamAbbName') or '',
                'away': m.get('awayTeamAbbName') or '',
                'had': _clean_pool(m.get('had')),
                'hhad': _clean_pool(m.get('hhad')),
                'ttg': _clean_pool(m.get('ttg')),
                'crs': _clean_pool(m.get('crs')),
                'hafu': _clean_pool(m.get('hafu')),
                'oddsInferred': False,
            })
    return rows


def load_existing():
    """读取现有 jsonl，返回 {matchId: row} 与原始行列表。"""
    recs = {}
    order = []
    if not os.path.exists(OUT_PATH):
        return recs, order
    with open(OUT_PATH, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            mid = str(r.get('matchId') or '')
            if mid:
                recs[mid] = r
                order.append(mid)
    return recs, order


def collect():
    """采集当前在售并幂等落库，返回 (新增数, 更新数, 总场次)。"""
    live = fetch_live()
    recs, order = load_existing()
    now = datetime.datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
    added = updated = 0
    for r in live:
        mid = r['matchId']
        if mid in recs:
            old = recs[mid]
            # 保留 firstSeen / settled，更新赔率与 lastSeen
            r['firstSeen'] = old.get('firstSeen', now)
            r['settled'] = old.get('settled')
            r['lastSeen'] = now
            recs[mid] = r
            updated += 1
        else:
            r['firstSeen'] = now
            r['lastSeen'] = now
            r['settled'] = None
            recs[mid] = r
            order.append(mid)
            added += 1
    # 整表重写（保持顺序），保证 jsonl 一致
    tmp = OUT_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        for mid in order:
            f.write(json.dumps(recs[mid], ensure_ascii=False) + '\n')
    os.replace(tmp, OUT_PATH)
    return added, updated, len(order)


def settle():
    """用赛果接口回填已结算场次的 winFlag/比分（最近30天窗口，逐日拉）。"""
    recs, order = load_existing()
    if not recs:
        return 0
    # 收集需要结算的 matchId 与日期
    pending = [r for r in recs.values() if not r.get('settled') and r.get('date')]
    if not pending:
        return 0
    dates = sorted(set(r['date'] for r in pending))
    # 赛果接口按日期区间拉，覆盖这些日期
    settled_map = {}
    for i in range(0, len(dates), 7):
        chunk = dates[i:i+7]
        b, e = chunk[0], chunk[-1]
        for page in range(1, 21):
            url = (f"{RESULT_URL}?matchBeginDate={b}&matchEndDate={e}"
                   f"&leagueId=&pageSize=100&pageNo={page}"
                   f"&isFix=0&matchPage=1&pcOrWap=1")
            try:
                data = _get(url)
            except Exception:
                break
            mr = (data.get('value') or {}).get('matchResult') or []
            for m in mr:
                mid = str(m.get('matchId') or '')
                if mid in recs and not recs[mid].get('settled'):
                    settled_map[mid] = {
                        'winFlag': m.get('winFlag'),
                        'scoreHT': m.get('sectionsNo1'),
                        'scoreFT': m.get('sectionsNo999'),
                    }
            if len(mr) < 100:
                break
            time.sleep(0.15)
    n = 0
    for mid, s in settled_map.items():
        if s.get('winFlag') in ('H', 'D', 'A'):
            recs[mid]['settled'] = s
            n += 1
    if n:
        tmp = OUT_PATH + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            for mid in order:
                f.write(json.dumps(recs[mid], ensure_ascii=False) + '\n')
        os.replace(tmp, OUT_PATH)
    return n


def stats():
    recs, order = load_existing()
    total = len(order)
    with_odds = sum(1 for r in recs.values() if r.get('had'))
    with_ttg = sum(1 for r in recs.values() if r.get('ttg'))
    with_crs = sum(1 for r in recs.values() if r.get('crs'))
    with_hafu = sum(1 for r in recs.values() if r.get('hafu'))
    settled = sum(1 for r in recs.values() if r.get('settled'))
    print(f"full_markets.jsonl: {total} 场 | HAD {with_odds} | TTG {with_ttg} | CRS {with_crs} | HAFU {with_hafu} | 已结算 {settled}")
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--settle', action='store_true', help='采集后用赛果接口回填已结算场次')
    ap.add_argument('--stats', action='store_true', help='只打印统计')
    args = ap.parse_args()
    if args.stats:
        stats()
        return
    try:
        added, updated, total = collect()
        print(f"[full_markets] 采集完成: 新增 {added}, 更新 {updated}, 累计 {total} 场")
        if args.settle:
            n = settle()
            print(f"[full_markets] 赛果回填: {n} 场已结算")
        stats()
    except Exception as e:
        # 隔离异常，绝不拖垮主管道
        print(f"[full_markets] 采集失败（已隔离，不影响主校准）: {e}")


if __name__ == '__main__':
    main()
