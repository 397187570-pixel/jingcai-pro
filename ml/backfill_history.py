#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backfill_history.py — 历史赛果回填（扩充 HAD 样本）
====================================================
竞彩赛果接口 getUniformMatchResultV1 可回溯到 2024 年及更早。
本脚本把现有 history_matches.json 未覆盖的历史区间按 matchId 去重并入，
扩充回测样本（仅 HAD 三项赔率 + 让球盘 + 赛果，无全玩法赔率）。

安全设计：
  - 先备份原文件为 history_matches.json.bak-<时间戳>
  - 按 matchId 去重（已存在的不覆盖）
  - 只保留 winFlag∈{H,D,A} 且 h/d/a 有效的场次
  - 逐月拉取，异常隔离；--dry-run 只统计不写入

用法：
  python3 backfill_history.py --dry-run                    # 统计可回填量
  python3 backfill_history.py                              # 回填 2024-09-01 ~ 现有最早日期前一天
  python3 backfill_history.py --begin 2024-01-01 --end 2025-09-02
"""
import os, sys, json, time, datetime, urllib.request, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
HISTORY_PATH = os.path.join(HERE, "data", "history_matches.json")
RESULT_URL = ("https://webapi.sporttery.cn/gateway/uniform/football/"
              "getUniformMatchResultV1.qry")
HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.sporttery.cn/'}


def _valid(m):
    wf = m.get('winFlag')
    h, d, a = m.get('h'), m.get('d'), m.get('a')
    try:
        ok_odds = float(h) > 1 and float(d) > 1 and float(a) > 1
    except (TypeError, ValueError):
        ok_odds = False
    return wf in ('H', 'D', 'A') and ok_odds and m.get('matchDate')


def _get(url, timeout=20):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def fetch_month(ym, log=print):
    """拉取某月的有效赛果（分页）。"""
    y, mo = int(ym[:4]), int(ym[5:7])
    b = f"{y:04d}-{mo:02d}-01"
    if mo == 12:
        e = f"{y+1:04d}-01-01"
    else:
        e = f"{y:04d}-{mo+1:02d}-01"
    out = []
    for page in range(1, 21):
        url = (f"{RESULT_URL}?matchBeginDate={b}&matchEndDate={e}"
               f"&leagueId=&pageSize=100&pageNo={page}"
               f"&isFix=0&matchPage=1&pcOrWap=1")
        try:
            data = _get(url)
        except Exception as ex:
            log(f"    ⚠️ {ym} p{page} 请求失败: {ex}")
            break
        v = data.get('value') or {}
        mr = v.get('matchResult') or []
        for m in mr:
            if _valid(m):
                out.append(m)
        pages = v.get('pages') or 0
        if page >= pages or len(mr) < 100:
            break
        time.sleep(0.15)
    return out


def month_range(begin, end):
    """生成 [begin, end) 的月份列表 YYYY-MM。"""
    out = []
    y, mo = int(begin[:4]), int(begin[5:7])
    ey, emo = int(end[:4]), int(end[5:7])
    while (y, mo) < (ey, emo):
        out.append(f"{y:04d}-{mo:02d}")
        mo += 1
        if mo > 12:
            mo = 1; y += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--begin', default=None, help='起始日期 YYYY-MM-DD')
    ap.add_argument('--end', default=None, help='结束日期 YYYY-MM-DD（不含）')
    ap.add_argument('--dry-run', action='store_true', help='只统计不写入')
    args = ap.parse_args()

    with open(HISTORY_PATH, encoding='utf-8') as f:
        hist = json.load(f)
    existing_ids = set(str(m.get('matchId')) for m in hist)
    dates = [m.get('matchDate') for m in hist if m.get('matchDate')]
    earliest = min(d for d in dates if isinstance(d, str) and '-' in d)
    log = print

    begin = args.begin or '2024-09-01'
    end = args.end or earliest  # 默认填到现有最早日期之前
    log(f"现有库: {len(hist)} 场 | 最早 {earliest} | 回填区间 [{begin}, {end})")

    months = month_range(begin, end)
    log(f"待拉取月份: {len(months)} 个 ({months[0] if months else '-'} ~ {months[-1] if months else '-'})")

    new_rows = []
    for i, ym in enumerate(months):
        rows = fetch_month(ym, log)
        fresh = [m for m in rows if str(m.get('matchId')) not in existing_ids]
        # 同批次内也去重
        seen = set()
        dedup = []
        for m in fresh:
            mid = str(m.get('matchId'))
            if mid in seen:
                continue
            seen.add(mid)
            dedup.append(m)
        new_rows.extend(dedup)
        log(f"  [{i+1}/{len(months)}] {ym}: 拉取 {len(rows)} 有效, 新增 {len(dedup)}")

    log(f"\n合计可新增: {len(new_rows)} 场")

    if args.dry_run:
        if new_rows:
            log("试运行样例:")
            for m in new_rows[:2]:
                log("  " + json.dumps({k: m.get(k) for k in ['matchId','matchNumStr','matchDate','h','d','a','goalLine','winFlag','sectionsNo999']}, ensure_ascii=False))
        log("（dry-run 未写入）")
        return

    if not new_rows:
        log("无新增，跳过写入。")
        return

    # 备份
    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    bak = HISTORY_PATH + '.bak-' + ts
    with open(bak, 'w', encoding='utf-8') as f:
        json.dump(hist, f, ensure_ascii=False)
    log(f"已备份原文件 → {bak}")

    # 合并（整表按 matchId 全局去重 —— 月底边界日会被相邻两月各拉一次）
    seen_ids = set()
    merged = []
    for m in (hist + new_rows):
        mid = str(m.get('matchId') or '')
        if mid in seen_ids:
            continue
        seen_ids.add(mid)
        merged.append(m)
    merged.sort(key=lambda m: (m.get('matchDate') or '', str(m.get('matchId') or '')))
    tmp = HISTORY_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(merged, f, ensure_ascii=False)
    os.replace(tmp, HISTORY_PATH)
    log(f"✅ 已写入: {len(hist)} → {len(merged)} 场 (+{len(new_rows)})")


if __name__ == '__main__':
    main()
