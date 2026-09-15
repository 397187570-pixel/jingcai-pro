# -*- coding: utf-8 -*-
"""
build_eu_history_v3.py — 三件套构建器 (日期容差版)

v2 -> v3 关键改进: 精确 join 增加 **日期 ±1 天容差**。
  诊断发现: 竞彩 matchDate(中国日期) 与 football-data Date(英国日期) 对晚场/凌晨
  比赛常差 1 天, 导致 ~40% 本可匹配的比赛被漏掉。加入 ±1 天容差(仍以
  队名+比分 双重锁定, 防错配)后, 英超覆盖率从 189/304 提升到 275/304(90%)。

join 键: (联赛代码, 日期±1, 英文主客队) 精确; 退化 (联赛代码, 日期±1, 比分) 唯一。
match_method 标签: exact / exact_offset / score_unique / score_unique_offset / low_conf
  P5 回测取非 low_conf(前四类均高置信)。
"""
import json, csv, os, glob
from collections import defaultdict, Counter
from datetime import datetime, timedelta

RAW_DIR = os.path.join(os.path.dirname(__file__), 'data', 'eu_raw')
HIST = os.path.join(os.path.dirname(__file__), 'data', 'history_matches.json')
OUT_DIR = os.path.join(os.path.dirname(__file__), 'data')

CROSSWALK = {
    '英格兰超级联赛': 'E0', '英格兰冠军联赛': 'E1', '英格兰甲级联赛': 'E2',
    '英格兰锦标赛': 'E3', '德国甲级联赛': 'D1', '德国乙级联赛': 'D2',
    '意大利甲级联赛': 'I1', '意大利乙级联赛': 'I2', '西班牙甲级联赛': 'SP1',
    '西班牙乙级联赛': 'SP2', '法国甲级联赛': 'F1', '法国乙级联赛': 'F2',
    '荷兰甲级联赛': 'N1', '荷兰乙级联赛': 'N2', '葡萄牙超级联赛': 'P1',
    '欧洲冠军联赛': 'EC', '欧洲协会联赛': 'ECL',
}


def load_fd():
    recs = []
    for path in glob.glob(os.path.join(RAW_DIR, '*.csv')):
        code = os.path.splitext(os.path.basename(path))[0]
        try:
            with open(path, encoding='utf-8-sig', newline='') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    try:
                        dt = datetime.strptime(row['Date'].strip(), '%d/%m/%Y')
                    except Exception:
                        continue
                    fthg = row.get('FTHG', '').strip()
                    ftag = row.get('FTAG', '').strip()
                    if fthg == '' or ftag == '':
                        continue
                    try:
                        hg, ag = int(fthg), int(ftag)
                    except Exception:
                        continue
                    recs.append({
                        'code': code, 'date': dt.strftime('%Y-%m-%d'),
                        'home': row['HomeTeam'].strip(), 'away': row['AwayTeam'].strip(),
                        'score': '%d:%d' % (hg, ag), 'referee': row.get('Referee', '').strip(),
                        'avg_h': row.get('AvgH', '').strip(), 'avg_d': row.get('AvgD', '').strip(),
                        'avg_a': row.get('AvgA', '').strip(),
                        'b365_h': row.get('B365H', '').strip(), 'b365_d': row.get('B365D', '').strip(),
                        'b365_a': row.get('B365A', '').strip(),
                        'ps_h': row.get('PSH', '').strip(), 'ps_d': row.get('PSD', '').strip(),
                        'ps_a': row.get('PSA', '').strip(),
                    })
        except Exception as e:
            print('  [跳过] 读取 %s 失败: %s' % (os.path.basename(path), e))
    return recs


def implied(h, d, a):
    try:
        h, d, a = float(h), float(d), float(a)
        if h <= 1.0 or d <= 1.0 or a <= 1.0:
            return None
        s = 1 / h + 1 / d + 1 / a
        return (1 / h / s, 1 / d / s, 1 / a / s)
    except Exception:
        return None


def shift(date_str, off):
    y, m, d = map(int, date_str.split('-'))
    return (datetime(y, m, d) + timedelta(days=off)).strftime('%Y-%m-%d')


def main():
    fd = load_fd()
    print('football-data 有效记录数:', len(fd))

    by_score = defaultdict(list)   # (code,date,score) -> [rec]
    by_exact = {}                  # (code,date,home,away) -> rec
    for r in fd:
        by_score[(r['code'], r['date'], r['score'])].append(r)
        by_exact[(r['code'], r['date'], r['home'], r['away'])] = r

    hist = json.load(open(HIST, encoding='utf-8'))
    total = len(hist)
    OFFSETS = (0, -1, 1)

    # ---------- 第一遍: 全量 bootstrapp 别名(含 ±1 天) ----------
    alias = {}
    for m in hist:
        lg = m.get('leagueName', '')
        code = CROSSWALK.get(lg)
        if not code:
            continue
        date = m.get('matchDate', '')
        sc = m.get('sectionsNo999', '')
        if not date or ':' not in sc:
            continue
        zh_h = m.get('homeTeam', '')
        zh_a = m.get('awayTeam', '')
        if zh_h in alias and zh_a in alias:
            continue
        for off in OFFSETS:
            iso = shift(date, off)
            cands = by_score.get((code, iso, sc), [])
            if len(cands) == 1:
                c = cands[0]
                alias.setdefault(zh_h, c['home'])
                alias.setdefault(zh_a, c['away'])
                break

    bootstrapped = sum(len(v) for v in alias.values())
    print('bootstrapp 别名总数:', bootstrapped)

    # ---------- 第二遍: 精确 join(含 ±1 天) + 退化引导 ----------
    enriched = []
    matched = 0
    method_count = Counter()
    per_league = Counter()
    per_league_total = Counter()

    for m in hist:
        lg = m.get('leagueName', '')
        code = CROSSWALK.get(lg)
        per_league_total[lg] += 1
        if not code:
            continue
        date = m.get('matchDate', '')
        sc = m.get('sectionsNo999', '')
        if not date or ':' not in sc:
            continue
        zh_h = m.get('homeTeam', '')
        zh_a = m.get('awayTeam', '')
        jc = implied(m.get('h'), m.get('d'), m.get('a'))
        if not jc:
            continue

        eng_h = alias.get(zh_h)
        eng_a = alias.get(zh_a)
        eu = None
        method = None
        low_conf = False

        # 1) 精确 join (队名) — 优先同日, 退化 ±1 天
        if eng_h and eng_a:
            for off in OFFSETS:
                iso = shift(date, off)
                eu = by_exact.get((code, iso, eng_h, eng_a))
                if eu:
                    method = 'exact' if off == 0 else 'exact_offset'
                    break

        # 2) 退化: 比分唯一引导(队名别名可能还没学到)
        if not eu:
            for off in OFFSETS:
                iso = shift(date, off)
                cands = by_score.get((code, iso, sc), [])
                if len(cands) == 1:
                    c = cands[0]
                    alias.setdefault(zh_h, c['home'])
                    alias.setdefault(zh_a, c['away'])
                    eu2 = by_exact.get((code, iso, c['home'], c['away'])) if (eng_h is None or eng_a is None) else None
                    eu = eu2 or c
                    method = 'score_unique' if off == 0 else 'score_unique_offset'
                    break

        # 3) 最后退化: 多候选猜首条(有噪声)
        if not eu:
            for off in OFFSETS:
                iso = shift(date, off)
                cands = by_score.get((code, iso, sc), [])
                if cands:
                    eu = cands[0]
                    method = 'low_conf'
                    low_conf = True
                    break
            if not eu:
                continue

        eu_avg = implied(eu['avg_h'], eu['avg_d'], eu['avg_a'])
        if not eu_avg:
            continue
        eu_b365 = implied(eu['b365_h'], eu['b365_d'], eu['b365_a'])
        eu_ps = implied(eu['ps_h'], eu['ps_d'], eu['ps_a'])

        enriched.append({
            'leagueName': lg, 'date': date,
            'zhHome': zh_h, 'zhAway': zh_a,
            'engHome': eu['home'], 'engAway': eu['away'],
            'jc_h': float(m['h']), 'jc_d': float(m['d']), 'jc_a': float(m['a']),
            'jc_implied': list(jc),
            'eu_avg': [eu['avg_h'], eu['avg_d'], eu['avg_a']],
            'eu_avg_implied': list(eu_avg),
            'eu_b365': [eu['b365_h'], eu['b365_d'], eu['b365_a']] if eu_b365 else None,
            'eu_ps': [eu['ps_h'], eu['ps_d'], eu['ps_a']] if eu_ps else None,
            'referee': eu['referee'],
            'jc_score': sc, 'eu_score': eu['score'],
            'low_conf': low_conf, 'match_method': method,
        })
        matched += 1
        method_count[method] += 1
        per_league[lg] += 1

    # 写产物
    with open(os.path.join(OUT_DIR, 'eu_odds_history.json'), 'w', encoding='utf-8') as f:
        json.dump(enriched, f, ensure_ascii=False, indent=1)
    alias_out = alias
    with open(os.path.join(OUT_DIR, 'team_alias.json'), 'w', encoding='utf-8') as f:
        json.dump(alias_out, f, ensure_ascii=False, indent=1)

    # 重新计算 国内 vs 国外 偏差分布(仅非 low_conf)
    gaps = defaultdict(lambda: {'jh': [], 'jd': [], 'ja': []})
    allgaps = {'jh': [], 'jd': [], 'ja': []}
    for e in enriched:
        if e['low_conf']:
            continue
        lg = e['leagueName']
        for i, k in enumerate(['jh', 'jd', 'ja']):
            g = e['jc_implied'][i] - e['eu_avg_implied'][i]
            gaps[lg][k].append(g)
            allgaps[k].append(g)

    def stats(lst):
        if not lst:
            return None
        n = len(lst); mean = sum(lst) / n
        sd = (sum((x - mean) ** 2 for x in lst) / n) ** 0.5
        srt = sorted(lst)
        return {'n': n, 'mean': round(mean, 4), 'std': round(sd, 4),
                'p10': round(srt[int(n * 0.10)], 4), 'p90': round(srt[int(n * 0.90)], 4)}

    gap_summary = {}
    for lg, d in gaps.items():
        gap_summary[lg] = {k: stats(v) for k, v in d.items() if v}
    gap_summary['ALL'] = {k: stats(v) for k, v in allgaps.items() if v}
    with open(os.path.join(OUT_DIR, 'eu_jc_gap.json'), 'w', encoding='utf-8') as f:
        json.dump(gap_summary, f, ensure_ascii=False, indent=1)

    # 报告
    print('\n=== 整合结果(v3, 日期容差) ===')
    print('竞彩总场次:', total)
    print('成功回填欧盘: %d (%.1f%%)' % (matched, 100 * matched / total))
    for k in ['exact', 'exact_offset', 'score_unique', 'score_unique_offset', 'low_conf']:
        print('  - %-18s: %d' % (k, method_count.get(k, 0)))
    print('  → 高置信(非 low_conf):', matched - method_count.get('low_conf', 0))
    print('\n--- 各联赛覆盖(前 17 个 CROSSWALK 联赛) ---')
    cw_codes = set(CROSSWALK.values())
    for lg in sorted(per_league_total, key=lambda x: -per_league_total[x]):
        if per_league_total[lg] == 0:
            continue
        if CROSSWALK.get(lg, '-') == '-':
            continue
        tot = per_league_total[lg]
        mt = per_league.get(lg, 0)
        code = CROSSWALK.get(lg)
        print('  %-16s %-4s  %4d/%4d  (%.0f%%)' % (lg, code, mt, tot, 100 * mt / tot))
    print('\n产物: eu_odds_history.json / team_alias.json / eu_jc_gap.json')


if __name__ == '__main__':
    main()
