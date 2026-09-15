#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
daily_pipeline.py — 竞彩智选 Pro 每日自动校准管道（持续学习）
============================================================
原则（用户要求，长期贯彻）：
  每日将「赛前赔率 + 赛果」并入历史样本(history_matches.json)，
  并在【完整累计样本】上重新校准，使模型置信度长期自动纠偏。
  同时（方案 B）：把新并入的国内比赛按 (联赛→football-data 赛季CSV)
  回填国际赔率，追加进 eu_odds_history.json，使 P5/P8 价值窗口样本
  随每日增长而越来越稳。

做法：
  1. 拉取最近 N 天已结算比赛（竞彩官方 webapi.sporttery.cn）
  2. 按 matchId 去重后追加进 ml/data/history_matches.json（累计增长）
  3. 欧盘回填（eu_backfill）：新比赛 → 国际赔率 → eu_odds_history.json
     （football-data 不可达/赛季未就绪时优雅跳过，绝不影响步骤 2/4）
  4. 在完整累计样本上重算置信度校准表 -> js/engine/calibration.json
  5. 追加一行校准日志 ml/data/calibration_log.jsonl（用于长期趋势监控）

仅依赖标准库，可在自动化环境稳定执行。
说明：本管道负责「样本增长 + 置信度校准 + 国际回填」。方向/EV 模型
(p8_model_lr.json) 的系数重训见 p8_train.py（需 sklearn，独立手动步骤，
不在每日自动化内）。

用法：
  python3 daily_pipeline.py                 # 默认拉取 最近3天(截至昨天)
  python3 daily_pipeline.py --days 7        # 拉取 最近7天
  python3 daily_pipeline.py --end 2026-09-07
  python3 daily_pipeline.py --no-fetch      # 仅基于现有样本重校准
  python3 daily_pipeline.py --no-eu         # 跳过国际赔率回填
"""
import os, sys, json, math, time, datetime, urllib.request, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from collect_and_calibrate import calibrate  # noqa: E402

# 欧盘回填（方案 B）；隔离导入，避免任何异常拖垮国内校准半边
try:
    from eu_backfill import backfill as eu_backfill_run
except Exception:
    eu_backfill_run = None

SPORT_URL = ("https://webapi.sporttery.cn/gateway/uniform/football/"
             "getUniformMatchResultV1.qry")
HISTORY_PATH = os.path.join(HERE, "data", "history_matches.json")
CALIB_PATH = os.path.join(HERE, "..", "js", "engine", "calibration.json")
LOG_PATH = os.path.join(HERE, "data", "calibration_log.jsonl")


def _valid(m):
    wf = m.get('winFlag')
    h, d, a = m.get('h'), m.get('d'), m.get('a')
    return (wf in ('H', 'D', 'A')
            and h not in (None, '') and d not in (None, '') and a not in (None, ''))


def fetch_range(begin, end):
    """拉取某日期区间已结算比赛（分页）。返回 list of 有效 raw match dicts。"""
    out = []
    for page in range(1, 21):
        url = (f"{SPORT_URL}?matchBeginDate={begin}&matchEndDate={end}"
               f"&leagueId=&pageSize=100&pageNo={page}"
               f"&isFix=0&matchPage=1&pcOrWap=1")
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0',
                'Referer': 'https://www.sporttery.cn/'
            })
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode('utf-8'))
        except Exception as e:
            print(f"  ⚠️ 请求失败 {begin}~{end} p{page}: {e}")
            break
        result = (data.get('value') or {}).get('matchResult') or []
        if not result:
            break
        for m in result:
            if _valid(m):
                out.append(m)
        if len(result) < 100:
            break
        time.sleep(0.2)
    return out


def load_history():
    if os.path.exists(HISTORY_PATH):
        with open(HISTORY_PATH, encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
    return []


def _max_history_date():
    """已记录样本里的最大 matchDate（date 对象），用于默认模式下向后补齐缺口。"""
    try:
        ds = [m.get('matchDate') for m in load_history() if m.get('matchDate')]
        if not ds:
            return None
        return max(datetime.date.fromisoformat(d) for d in ds if isinstance(d, str) and '-' in d)
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=3)
    ap.add_argument('--end', type=str, default=None, help='结束日期 YYYY-MM-DD（默认=昨天）')
    ap.add_argument('--no-fetch', action='store_true', help='跳过采集，仅基于现有样本重校准')
    ap.add_argument('--no-eu', action='store_true', help='跳过国际赔率回填（方案 B）')
    args = ap.parse_args()

    today = datetime.date.today()
    end = (datetime.date.fromisoformat(args.end) if args.end else today - datetime.timedelta(days=1))
    # 默认模式（未显式指定 --end / --days）：自动从已记录的最后一场向后补齐，
    # 避免自动化漏跑数天形成永久数据缺口（竞彩复盘页只能选到旧日期的根因之一）。
    if args.end is None and args.days == 3:
        max_d = _max_history_date()
        fallback_begin = end - datetime.timedelta(days=args.days - 1)
        begin = min(fallback_begin, max_d) if max_d else fallback_begin
        if max_d and max_d < fallback_begin:
            print(f"  ℹ️ 检测到数据缺口：已记录到最后 {max_d}，自动向后补齐至 {end}")
    else:
        begin = end - datetime.timedelta(days=args.days - 1)
    bs, es = begin.strftime('%Y-%m-%d'), end.strftime('%Y-%m-%d')

    print("=" * 56)
    print(f"竞彩智选 Pro 每日校准管道 — {datetime.datetime.now():%Y-%m-%d %H:%M}")
    print("=" * 56)

    # 1. 采集 + 累计并入
    old = load_history()
    seen = {m.get('matchId') for m in old if m.get('matchId')}
    added = 0
    new_matches = []
    if not args.no_fetch:
        print(f"\n[1/3] 拉取已结算比赛 {bs} ~ {es} ...")
        raw = fetch_range(bs, es)
        for m in raw:
            mid = m.get('matchId')
            if mid and mid not in seen:
                old.append(m)
                seen.add(mid)
                added += 1
                new_matches.append(m)
        print(f"  ✅ 新并入 {added} 场；累计样本 {len(old)} 场")
        with open(HISTORY_PATH, 'w', encoding='utf-8') as f:
            json.dump(old, f, ensure_ascii=False)
    else:
        print(f"\n[1/3] 跳过采集（--no-fetch）；当前累计样本 {len(old)} 场")

    # 1.5 欧盘回填（方案 B）：新国内比赛 → 国际赔率 → eu_odds_history.json
    if not args.no_eu and new_matches and eu_backfill_run:
        print(f"\n[1.5/3] 欧盘回填（方案 B）：对 {len(new_matches)} 场新比赛回填国际赔率...")
        try:
            eu_backfill_run(new_matches, log=print)
        except Exception as e:
            print(f"  ⚠️ 欧盘回填异常(已隔离，不影响国内校准): {e}")
    elif not args.no_eu and new_matches and not eu_backfill_run:
        print(f"\n[1.5/3] 欧盘回填模块不可用，跳过")

    # 2. 校准（完整累计样本）
    print(f"\n[2/3] 在完整累计样本({len(old)} 场)上重算校准表...")
    valid = [m for m in old if _valid(m)]
    n = len(valid)
    table = calibrate(valid, n_bins=10)
    brier = sum((row['actual'] - row['predicted']) ** 2 * row['count'] for row in table) / n if n else 0
    mean_bias = sum(abs(row['actual'] - row['predicted']) * row['count'] for row in table) / n if n else 0
    max_bias = max((abs(row['actual'] - row['predicted']) for row in table), default=0)
    hw = sum(1 for m in valid if m['winFlag'] == 'H')
    dr = sum(1 for m in valid if m['winFlag'] == 'D')
    aw = sum(1 for m in valid if m['winFlag'] == 'A')
    print(f"  有效样本 {n} 场 | H {hw/n:.1%} D {dr/n:.1%} A {aw/n:.1%}")
    print(f"  Brier={brier:.4f} | 平均|偏差|={mean_bias:.4f} | 最大|偏差|={max_bias:.4f}")

    os.makedirs(os.path.dirname(CALIB_PATH), exist_ok=True)
    out = {
        'type': 'confidence_calibration',
        'version': '2.0.0-daily',
        'n_matches': n,
        'cumulative_total': len(old),
        'brier_score': round(brier, 4),
        'mean_abs_bias': round(mean_bias, 4),
        'generated_at': time.strftime('%Y-%m-%d %H:%M'),
        'table': table,
        'note': 'predicted=赔率隐含概率; actual=实际命中率; 前端用 actual 作为真实置信度。样本每日累计增长并自动重校准。'
    }
    with open(CALIB_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"  ✅ 校准表已写: {CALIB_PATH}")

    # 3. 趋势日志
    log_entry = {
        'date': time.strftime('%Y-%m-%d'),
        'added': added,
        'cumulative_total': len(old),
        'valid_n': n,
        'brier': round(brier, 4),
        'mean_abs_bias': round(mean_bias, 4),
        'max_bias': round(max_bias, 4),
    }
    with open(LOG_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')
    print(f"\n✅ 管道完成。本次新增 {added} 场，累计 {len(old)} 场，Brier={brier:.4f}")


if __name__ == '__main__':
    main()
