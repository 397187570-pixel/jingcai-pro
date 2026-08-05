# -*- coding: utf-8 -*-
"""
构建欧盘历史补充数据源, 与 4399 场竞彩历史比赛做 join, 产出:
  - eu_odds_history.json : 每场竞彩比赛回填的欧盘均价/ Bet365 / Pinnacle + 裁判
  - eu_jc_gap.json        : 国内(竞彩) vs 国外(欧盘均价) 历史偏差分布 (模型先验)
  - team_alias.json       : 中文队名 <-> 英文队名 映射 (自动 bootstrapped)

数据源: football-data.co.uk 免费 CSV (25/26 赛季), 字段 AvgH/AvgD/AvgA = 欧洲市场共识赔率
join 策略:
  Phase A: 用 (联赛代码, 日期, 比分) 唯一匹配 -> bootstrapp 队名映射
  Phase B: 用映射把中文队名翻成英文 -> (联赛代码, 日期, 主队, 客队) 精确 join 取赔率
"""
import json, csv, os, glob
from collections import defaultdict, Counter
from datetime import datetime

RAW_DIR = os.path.join(os.path.dirname(__file__), 'data', 'eu_raw')
HIST = os.path.join(os.path.dirname(__file__), 'data', 'history_matches.json')
OUT_DIR = os.path.join(os.path.dirname(__file__), 'data')

# 竞彩联赛中文名 -> football-data 分区代码
CROSSWALK = {
    '英格兰超级联赛': 'E0',
    '英格兰冠军联赛': 'E1',
    '英格兰甲级联赛': 'E2',
    '英格兰锦标赛':   'E3',
    '德国甲级联赛':   'D1',
    '德国乙级联赛':   'D2',
    '意大利甲级联赛': 'I1',
    '意大利乙级联赛': 'I2',
    '西班牙甲级联赛': 'SP1',
    '西班牙乙级联赛': 'SP2',
    '法国甲级联赛':   'F1',
    '法国乙级联赛':   'F2',
    '荷兰甲级联赛':   'N1',
    '荷兰乙级联赛':   'N2',
    '葡萄牙超级联赛': 'P1',
    '欧洲冠军联赛':   'EC',
    '欧洲协会联赛':   'ECL',
    # 注: 欧罗巴联赛(EL) 该免费源 25/26 赛季未发布, 留空 -> 走 live The Odds API
}

def load_fd():
    """加载所有 football-data CSV -> list of dict (标准化)"""
    recs = []
    for path in glob.glob(os.path.join(RAW_DIR, '*.csv')):
        code = os.path.splitext(os.path.basename(path))[0]
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
                    'code': code,
                    'date': dt.strftime('%Y-%m-%d'),
                    'home': row['HomeTeam'].strip(),
                    'away': row['AwayTeam'].strip(),
                    'score': '%d:%d' % (hg, ag),
                    'referee': row.get('Referee', '').strip(),
                    'avg_h': row.get('AvgH', '').strip(),
                    'avg_d': row.get('AvgD', '').strip(),
                    'avg_a': row.get('AvgA', '').strip(),
                    'b365_h': row.get('B365H', '').strip(),
                    'b365_d': row.get('B365D', '').strip(),
                    'b365_a': row.get('B365A', '').strip(),
                    'ps_h': row.get('PSH', '').strip(),
                    'ps_d': row.get('PSD', '').strip(),
                    'ps_a': row.get('PSA', '').strip(),
                })
    return recs

def implied(h, d, a):
    """赔率 -> 隐含概率(归一化). 返回 (p_h, p_d, p_a) 或 None"""
    try:
        h, d, a = float(h), float(d), float(a)
        if h <= 1.0 or d <= 1.0 or a <= 1.0:
            return None
        s = 1/h + 1/d + 1/a
        return (1/h/s, 1/d/s, 1/a/s)
    except Exception:
        return None

def main():
    fd = load_fd()
    print('football-data 记录数:', len(fd))

    # 索引: (code, date, score) -> [rec]  用于 bootstrapp
    by_score = defaultdict(list)
    # 索引: (code, date, home, away) -> rec  用于精确 join
    by_exact = {}
    for r in fd:
        by_score[(r['code'], r['date'], r['score'])].append(r)
        by_exact[(r['code'], r['date'], r['home'], r['away'])] = r

    hist = json.load(open(HIST, encoding='utf-8'))
    total = len(hist)

    alias = defaultdict(dict)   # leagueName -> {zh: eng}
    enriched = []
    matched = 0
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

        eu = None
        # Phase B: 已有别名 -> 精确 join
        eng_h = alias[lg].get(zh_h)
        eng_a = alias[lg].get(zh_a)
        if eng_h and eng_a:
            eu = by_exact.get((code, date, eng_h, eng_a))
        # Phase A: (code,date,score) 唯一 -> bootstrapp 别名
        if not eu:
            cands = by_score.get((code, date, sc), [])
            if len(cands) == 1:
                c = cands[0]
                # 记录别名 (双向, 两种主客顺序都记)
                alias[lg][zh_h] = c['home']
                alias[lg][zh_a] = c['away']
                # 用刚建立的别名再精确 join
                eu = by_exact.get((code, date, c['home'], c['away']))
                if not eu:
                    eu = c  # 直接用该候选
        # 仍失败: 再试 (code,date,score) 即便多候选也取首个(有噪声, 标记 low_conf)
        if not eu:
            cands = by_score.get((code, date, sc), [])
            if cands:
                eu = cands[0]
                low_conf = True
            else:
                low_conf = False
                continue
        else:
            low_conf = False

        eu_avg = implied(eu['avg_h'], eu['avg_d'], eu['avg_a'])
        eu_b365 = implied(eu['b365_h'], eu['b365_d'], eu['b365_a'])
        eu_ps = implied(eu['ps_h'], eu['ps_d'], eu['ps_a'])
        if not eu_avg:
            continue

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
            'low_conf': low_conf,
        })
        matched += 1
        per_league[lg] += 1

    # 写产物
    with open(os.path.join(OUT_DIR, 'eu_odds_history.json'), 'w', encoding='utf-8') as f:
        json.dump(enriched, f, ensure_ascii=False, indent=1)
    # 别名只保留有效联赛
    alias_out = {lg: v for lg, v in alias.items() if v}
    with open(os.path.join(OUT_DIR, 'team_alias.json'), 'w', encoding='utf-8') as f:
        json.dump(alias_out, f, ensure_ascii=False, indent=1)

    # 计算 国内 vs 国外 偏差分布
    gaps = defaultdict(lambda: {'jh': [], 'jd': [], 'ja': []})  # league -> per outcome gap (jc - eu_avg)
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
        n = len(lst)
        mean = sum(lst)/n
        sd = (sum((x-mean)**2 for x in lst)/n)**0.5
        srt = sorted(lst)
        p10 = srt[int(n*0.10)]; p90 = srt[int(n*0.90)]
        return {'n': n, 'mean': round(mean, 4), 'std': round(sd, 4),
                'p10': round(p10, 4), 'p90': round(p90, 4)}

    gap_summary = {}
    for lg, d in gaps.items():
        gap_summary[lg] = {k: stats(v) for k, v in d.items() if v}
    gap_summary['ALL'] = {k: stats(v) for k, v in allgaps.items() if v}  # 兜底先验

    with open(os.path.join(OUT_DIR, 'eu_jc_gap.json'), 'w', encoding='utf-8') as f:
        json.dump(gap_summary, f, ensure_ascii=False, indent=1)

    # 报告
    print('\n=== 整合结果 ===')
    print('竞彩总场次:', total)
    print('成功回填欧盘: %d (%.1f%%)' % (matched, 100*matched/total))
    print('\n--- 各联赛覆盖 ---')
    for lg in sorted(per_league_total, key=lambda x: -per_league_total[x]):
        if per_league_total[lg] == 0:
            continue
        tot = per_league_total[lg]
        mt = per_league.get(lg, 0)
        code = CROSSWALK.get(lg, '-')
        print('  %-16s %-4s  %4d/%4d  (%.0f%%)' % (lg, code, mt, tot, 100*mt/tot))
    print('\n--- 国内 vs 国外 偏差 (jc隐含 - 欧盘均价隐含, 正=竞彩更看好) ---')
    for lg, s in sorted(gap_summary.items()):
        if not s:
            continue
        jh = s.get('jh'); jd = s.get('jd'); ja = s.get('ja')
        print('  %-16s n=%4d 主胜gap=%+.4f 平gap=%+.4f 客胜gap=%+.4f' % (
            lg, (jh or {}).get('n', 0),
            (jh or {}).get('mean', 0), (jd or {}).get('mean', 0), (ja or {}).get('mean', 0)))
    print('\n产物: eu_odds_history.json / team_alias.json / eu_jc_gap.json')

if __name__ == '__main__':
    main()
