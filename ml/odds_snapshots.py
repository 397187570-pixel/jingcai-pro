#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
odds_snapshots.py — 赔率时间序列快照采集（方向一：开盘→临场）
============================================================
用户要求 2026-11-23：长期攒"每场开盘→临场赔率移动"数据，为 CLV（closing line value）
信号服务。回测已证明该信号是本项目迄今第一个样本外验证为正的信号：
  Δp≥0.04 跟随资金流 ROI 训练 +3.2% / 验证 +16.2%（验证 95%CI 下界>0）。

设计（两条腿走路）：
  A. 【即时可用】从 football-data CSV 提取每场 "开盘赔率(AvgH/D/A)" 与
     "收盘赔率(AvgCH/CD/CA)" —— 这两组数据 CSV 里本来就有（2019/20 起），
     一次 bootstrap 就能把历史 7500+ 场的 open/close 补齐，无需等待。
     产出：ml/data/clv_history.json（按 match_date+teams 去重）。
  B. 【每日累积】管道每次运行时，抓取竞彩在售场次当前 HAD 赔率作为一条
     带时间戳的快照，按 (match_key, hour_bucket) 幂等追加到
     ml/data/odds_snapshots.jsonl；同一天多次运行只在不同小时落新快照。
     赛后由 bootstrap_csv + 快照配对，逐步形成竞彩自身的开盘→临场序列。

原则：与 daily_pipeline 一致——网络失败/CSV 不可达时优雅跳过，绝不让主校准崩溃。

用法：
  python3 odds_snapshots.py                  # 每日：采集在售快照 + 增量 bootstrap CSV
  python3 odds_snapshots.py --bootstrap-only # 只从本地 CSV 重建 clv_history.json
  python3 odds_snapshots.py --no-fetch       # 只做 CSV bootstrap，不抓网络
"""
import os, sys, json, csv, glob, time, datetime, urllib.request, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
RAW_DIR = os.path.join(DATA, 'eu_raw')
CACHE_DIR = os.path.join(DATA, 'eu_raw_cache')
CLV_PATH = os.path.join(DATA, 'clv_history.json')
SNAP_PATH = os.path.join(DATA, 'odds_snapshots.jsonl')
FEED_PATH = os.path.join(DATA, 'clv_feed.json')  # 前端 R2 直接消费的首/末赔率聚合

CALC_URL = ('https://webapi.sporttery.cn/gateway/uniform/football/'
            'getMatchCalculatorV1.qry?poolCode=HAD&channel=c_web')


def _implied(o):
    inv = [1.0 / float(x) for x in o]
    s = sum(inv)
    return [x / s for x in inv]


def _load_clv():
    if os.path.exists(CLV_PATH):
        try:
            with open(CLV_PATH, encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return []


def bootstrap_csv(log=print):
    """从本地 football-data CSV 提取开盘/收盘赔率，增量并入 clv_history.json。
    返回新增条数。"""
    files = glob.glob(os.path.join(RAW_DIR, '*.csv')) + glob.glob(os.path.join(CACHE_DIR, '*.csv'))
    existing = _load_clv()
    seen = set()
    for r in existing:
        seen.add((r.get('date'), r.get('home'), r.get('away')))
    added = 0
    for fp in files:
        try:
            with open(fp, encoding='utf-8-sig') as fh:
                for row in csv.DictReader(fh):
                    try:
                        o = [float(row['AvgH']), float(row['AvgD']), float(row['AvgA'])]
                        c = [float(row['AvgCH']), float(row['AvgCD']), float(row['AvgCA'])]
                        if min(o + c) <= 1:
                            continue
                        ftr = row.get('FTR')
                        if ftr not in ('H', 'D', 'A'):
                            continue
                        key = (row['Date'], row['HomeTeam'], row['AwayTeam'])
                        if key in seen:
                            continue
                        seen.add(key)
                        # B365 也有开/收，作为 sharp 机构对照
                        b = None
                        try:
                            bo = [float(row['B365H']), float(row['B365D']), float(row['B365A'])]
                            bc = [float(row['B365CH']), float(row['B365CD']), float(row['B365CA'])]
                            if min(bo + bc) > 1:
                                b = {'open': bo, 'close': bc}
                        except Exception:
                            pass
                        existing.append({
                            'date': row['Date'], 'home': row['HomeTeam'], 'away': row['AwayTeam'],
                            'league': row.get('Div', ''),
                            'open': o, 'close': c,
                            'open_implied': _implied(o), 'close_implied': _implied(c),
                            'b365': b, 'result': {'H': 0, 'D': 1, 'A': 2}[ftr],
                            'source': os.path.basename(fp)
                        })
                        added += 1
                    except (ValueError, KeyError, TypeError):
                        continue
        except Exception as e:
            log(f"  ⚠️ CSV 读取失败 {os.path.basename(fp)}: {e}")
    if added:
        os.makedirs(DATA, exist_ok=True)
        with open(CLV_PATH, 'w', encoding='utf-8') as f:
            json.dump(existing, f, ensure_ascii=False)
    log(f"  ✅ CLV 历史：新增 {added} 场，累计 {len(existing)} 场（{CLV_PATH}）")
    return added


def fetch_live_snapshots(log=print):
    """抓竞彩在售 HAD 赔率，按 (match_key, hour_bucket) 幂等落快照。返回新增条数。"""
    try:
        req = urllib.request.Request(CALC_URL, headers={
            'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.sporttery.cn/'
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        log(f"  ⚠️ 在售赔率抓取失败（优雅跳过）: {e}")
        return 0

    # 已存在的 (match_key|hour) 索引
    seen = set()
    if os.path.exists(SNAP_PATH):
        try:
            with open(SNAP_PATH, encoding='utf-8') as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        rec = json.loads(line)
                        seen.add(rec.get('key', ''))
                    except Exception:
                        continue
        except Exception:
            pass

    now = datetime.datetime.now()
    hour_bucket = now.strftime('%Y-%m-%dT%H')
    ts = now.isoformat(timespec='seconds')
    matches = ((data.get('value') or {}).get('matchInfoList') or [])
    added = 0
    newlines = []
    for day in matches:
        for m in (day.get('subMatchList') or []):
            had = m.get('had') or {}
            try:
                o = [float(had['h']), float(had['d']), float(had['a'])]
                if min(o) <= 1:
                    continue
            except (KeyError, ValueError, TypeError):
                continue
            mid = str(m.get('matchId', ''))
            key = mid + '|' + hour_bucket
            if key in seen:
                continue
            seen.add(key)
            newlines.append(json.dumps({
                'key': key, 'ts': ts, 'matchId': mid,
                'code': m.get('matchNumStr', ''),
                'date': m.get('matchDate', ''), 'time': m.get('matchTime', ''),
                'league': m.get('leagueAbbName', ''),
                'home': m.get('homeTeamAbbName', ''), 'away': m.get('awayTeamAbbName', ''),
                'jc_odds': o, 'jc_implied': _implied(o)
            }, ensure_ascii=False))
            added += 1
    if newlines:
        os.makedirs(DATA, exist_ok=True)
        with open(SNAP_PATH, 'a', encoding='utf-8') as f:
            for line in newlines:
                f.write(line + '\n')
    log(f"  ✅ 在售赔率快照：新增 {added} 条（{SNAP_PATH}），累计 {len(seen)} 条")
    return added


def export_feed(log=print):
    """把 jsonl 快照按 matchId 聚合成前端可直接 fetch 的首/末赔率 JSON（R2 桥接）。
    仅 snapshots>=2 的场次才有真正的'开盘→临场移动'；单快照场次仍写入但前端会跳过，
    以便观察累积进度。任何异常都隔离，不影响主校准。"""
    groups = {}
    total = 0
    if os.path.exists(SNAP_PATH):
        try:
            with open(SNAP_PATH, encoding='utf-8') as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    mid = str(rec.get('matchId') or rec.get('key', '').split('|')[0] or '')
                    if not mid:
                        continue
                    rec['_ts'] = rec.get('ts') or rec.get('key', '').split('|')[-1] or ''
                    groups.setdefault(mid, []).append(rec)
                    total += 1
        except Exception as e:
            log(f"  ⚠️ 快照读取失败（feed 跳过）: {e}")
            return 0

    matches = []
    for mid, rows in groups.items():
        rows.sort(key=lambda r: r.get('_ts', ''))
        first, last = rows[0], rows[-1]
        o, c = first.get('jc_odds'), last.get('jc_odds')
        try:
            if not o or not c or min([float(x) for x in o + c]) <= 1:
                continue
            o = [float(x) for x in o]
            c = [float(x) for x in c]
        except (TypeError, ValueError):
            continue
        matches.append({
            'matchId': mid,
            'code': first.get('code', ''),
            'date': first.get('date', ''),
            'time': first.get('time', ''),
            'league': first.get('league', ''),
            'home': first.get('home', ''),
            'away': first.get('away', ''),
            'snapshots': len(rows),
            'firstTs': first.get('_ts', ''),
            'lastTs': last.get('_ts', ''),
            'openOdds': o,
            'closeOdds': c
        })
    matches.sort(key=lambda r: (r.get('date', ''), r.get('time', ''), r.get('code', '')))
    feed = {
        'generated_at': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'source': os.path.basename(SNAP_PATH),
        'snapshot_records': total,
        'count': len(matches),
        'usable': sum(1 for m in matches if m['snapshots'] >= 2),
        'matches': matches
    }
    os.makedirs(DATA, exist_ok=True)
    with open(FEED_PATH, 'w', encoding='utf-8') as f:
        json.dump(feed, f, ensure_ascii=False)
    log(f"  ✅ CLV 前端 feed：{len(matches)} 场（可用 {feed['usable']} 场）→ {FEED_PATH}")
    return len(matches)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-fetch', action='store_true', help='跳过网络抓取，仅做 CSV bootstrap')
    ap.add_argument('--bootstrap-only', action='store_true', help='只从本地 CSV 重建 CLV 历史')
    args = ap.parse_args()

    print(f"\n[赔率快照] {datetime.datetime.now():%Y-%m-%d %H:%M}")
    n_boot = bootstrap_csv(print)
    if not args.no_fetch and not args.bootstrap_only:
        n_live = fetch_live_snapshots(print)
    else:
        print("  跳过网络快照采集")
    export_feed(print)
    print(f"  ✅ 赔率时间序列就绪：CLV 历史新增 {n_boot} 场")


if __name__ == '__main__':
    main()
