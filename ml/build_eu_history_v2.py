# -*- coding: utf-8 -*-
"""
build_eu_history_v2.py — 扩充版「国内(竞彩) + 国外(欧盘) + 赛果」三件套构建器

相比 v1 (build_eu_history.py) 的关键改进:
  1. 两遍匹配: 第一遍全量 bootstrapp 中文↔英文队名别名; 第二遍再用别名做
     精确 join。v1 是单遍在线 bootstrapp, 很多比赛在"别名还没被后面比赛学到"
     时就处理, 导致漏配(这是 1157→2500 的主要增量来源)。
  2. 每场标注 match_method: 'exact'(别名+精确) / 'score_unique'(比分唯一引导)
     / 'low_conf'(多候选猜首条)。P5 回测只取非 low_conf, 保证质量。
  3. 自动跳过损坏/缺失的 CSV(如荷乙 N2 25/26 源未发布)。

数据源: football-data.co.uk 免费 CSV (25/26 赛季, 本地 eu_raw/)。
join 键: (联赛代码, 日期, 英文主队, 英文客队) 精确; 退化用 (联赛代码, 日期, 比分) 唯一。
"""
import json, csv, os, glob
from collections import defaultdict, Counter
from datetime import datetime

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
    # 欧罗巴联赛(EL) 该免费源 25/26 未发布
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

    # ---------- 第一遍: 全量 bootstrapp 别名 ----------
    alias = defaultdict(dict)  # leagueName -> {zh: eng}
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
        if zh_h in alias[lg] and zh_a in alias[lg]:
            continue
        cands = by_score.get((code, date, sc), [])
        if len(cands) == 1:
            c = cands[0]
            alias[lg].setdefault(zh_h, c['home'])
            alias[lg].setdefault(zh_a, c['away'])

    bootstrapped = sum(len(v) for v in alias.values())
    print('bootstrapp 别名总数:', bootstrapped)

    # ---------- 第二遍: 精确 join + 退化引导 ----------
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

        eng_h = alias[lg].get(zh_h)
        eng_a = alias[lg].get(zh_a)
        eu = None
        method = None
        low_conf = False

        if eng_h and eng_a:
            eu = by_exact.get((code, date, eng_h, eng_a))
            if eu:
                method = 'exact'
        if not eu:
            # 退化: 比分唯一 → 引导(仍记录别名以便后续精确)
            cands = by_score.get((code, date, sc), [])
            if len(cands) == 1:
                c = cands[0]
                alias[lg].setdefault(zh_h, c['home'])
                alias[lg].setdefault(zh_a, c['away'])
                eu = by_exact.get((code, date, c['home'], c['away'])) or c
                method = 'score_unique'
        if not eu:
            # 最后退化: 多候选取首条(有噪声, 标记 low_conf)
            cands = by_score.get((code, date, sc), [])
            if cands:
                eu = cands[0]
                method = 'low_conf'
                low_conf = True
            else:
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
    alias_out = {lg: v for lg, v in alias.items() if v}
    with open(os.path.join(OUT_DIR, 'team_alias.json'), 'w', encoding='utf-8') as f:
        json.dump(alias_out, f, ensure_ascii=False, indent=1)

    # 重新计算 国内 vs 国外 偏差分布(仅用非 low_conf)
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
    print('\n=== 整合结果(v2) ===')
    print('竞彩总场次:', total)
    print('成功回填欧盘: %d (%.1f%%)' % (matched, 100 * matched / total))
    print('  - exact(精确):', method_count.get('exact', 0))
    print('  - score_unique(比分引导):', method_count.get('score_unique', 0))
    print('  - low_conf(多候选猜):', method_count.get('low_conf', 0))
    print('  → 高置信(非 low_conf):', matched - method_count.get('low_conf', 0))
    print('\n--- 各联赛覆盖 ---')
    for lg in sorted(per_league_total, key=lambda x: -per_league_total[x]):
        if per_league_total[lg] == 0:
            continue
        tot = per_league_total[lg]
        mt = per_league.get(lg, 0)
        code = CROSSWALK.get(lg, '-')
        print('  %-16s %-4s  %4d/%4d  (%.0f%%)' % (lg, code, mt, tot, 100 * mt / tot))
    print('\n产物: eu_odds_history.json / team_alias.json / eu_jc_gap.json')


if __name__ == '__main__':
    main()
