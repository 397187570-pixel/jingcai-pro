# -*- coding: utf-8 -*-
"""
eu_backfill.py — 每日结算后回填欧盘（方案 B：持续学习闭环）

职责（用户选定）：
  每日把「新并入的国内已结算比赛」按 (联赛→football-data 赛季CSV) 回填国际赔率，
  追加进 eu_odds_history.json，并重算 eu_jc_gap.json（国内 vs 国外 偏差先验）。
  这样 P5 权重规律 / P8 价值窗口的样本随每日增长而越来越稳。

设计约束（继承自 build_eu_history_v3.py，保证 schema 一致）：
  - 复用 v3 的匹配方法：别名引导 + 队名精确 join(±1天容差) + 比分唯一退化。
  - 只接受高置信 4 法：exact / exact_offset / score_unique / score_unique_offset；
    显式丢弃 v3 的 low_conf（多候选猜测，有噪声），避免在增长集里掺假。
  - 输出 schema 与 v3 完全一致（eu_avg/eu_b365 为字符串数组，eu_ps 可 None）。
  - 优雅降级：football-data 不可达 / 赛季CSV未就绪 / 联赛未映射 → 跳过该场，绝不让
    国内校准半边（daily_pipeline 的 domestic+calibration）失败。

数据源（优先级）：
  1) 本地镜像 ml/data/eu_raw/{code}.csv（已知为 2526 赛季，首次运行播种进 cache）
  2) 赛季命名缓存 ml/data/eu_raw_cache/{season}_{code}.csv（已下载则直接读）
  3) 按需下载 https://www.football-data.co.uk/mmz4281/{season}/{code}.csv（失败则跳过）

赛季推算：欧战赛季自 7 月始。date>=7月 → 起始年=年；否则=年-1。
  2026-08 → 2627；2026-02 → 2526；2025-09 → 2526。

仅依赖标准库，可在自动化环境执行。
"""
import os, sys, json, csv, math, shutil, datetime, urllib.request
from collections import defaultdict, Counter

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, 'data', 'eu_raw')          # 已知 2526 赛季镜像
CACHE_DIR = os.path.join(HERE, 'data', 'eu_raw_cache')  # 赛季命名缓存（含下载）
EU_PATH = os.path.join(HERE, 'data', 'eu_odds_history.json')
ALIAS_PATH = os.path.join(HERE, 'data', 'team_alias.json')
GAP_PATH = os.path.join(HERE, 'data', 'eu_jc_gap.json')

# 竞彩联赛名 → football-data 联赛代码（对齐 v3 CROSSWALK，并补 巴西/希腊/土耳其）
CROSSWALK = {
    '英格兰超级联赛': 'E0', '英格兰冠军联赛': 'E1', '英格兰甲级联赛': 'E2',
    '英格兰锦标赛': 'E3', '德国甲级联赛': 'D1', '德国乙级联赛': 'D2',
    '意大利甲级联赛': 'I1', '意大利乙级联赛': 'I2', '西班牙甲级联赛': 'SP1',
    '西班牙乙级联赛': 'SP2', '法国甲级联赛': 'F1', '法国乙级联赛': 'F2',
    '荷兰甲级联赛': 'N1', '葡萄牙超级联赛': 'P1',
    '欧洲冠军联赛': 'EC', '欧洲协会联赛': 'ECL',
    '巴西甲级联赛': 'B1', '希腊超级联赛': 'G1', '土耳其超级联赛': 'T1',
}

FD_BASE = 'https://www.football-data.co.uk/mmz4281'


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
    return (datetime.date(y, m, d) + datetime.timedelta(days=off)).strftime('%Y-%m-%d')


def season_of(date_str):
    """欧洲赛季推算：7月为界。"""
    y, m, d = map(int, date_str.split('-'))
    start = y if m >= 7 else y - 1
    return '%02d%02d' % (start % 100, (start + 1) % 100)


def _ensure_csv(season, code):
    """返回本地 CSV 路径；按需下载并缓存。不可达则返回 None。"""
    cached = os.path.join(CACHE_DIR, '%s_%s.csv' % (season, code))
    if os.path.exists(cached):
        return cached
    # 已知本地镜像即 2526 赛季：首次播种进 cache
    if season == '2526':
        bare = os.path.join(RAW_DIR, '%s.csv' % code)
        if os.path.exists(bare):
            try:
                os.makedirs(CACHE_DIR, exist_ok=True)
                shutil.copy(bare, cached)
                return cached
            except Exception:
                pass
    # 按需下载
    url = '%s/%s/%s.csv' % (FD_BASE, season, code)
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = r.read()
        with open(cached, 'wb') as f:
            f.write(data)
        return cached
    except Exception:
        return None


def _build_idx(path, code):
    """解析 CSV，返回 (recs, by_exact, by_score)。recs 形状对齐 v3。"""
    recs = []
    try:
        with open(path, encoding='utf-8-sig', newline='') as f:
            for row in csv.DictReader(f):
                try:
                    dt = datetime.datetime.strptime(row['Date'].strip(), '%d/%m/%Y')
                except Exception:
                    continue
                fthg, ftag = row.get('FTHG', '').strip(), row.get('FTAG', '').strip()
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
    except Exception:
        return None
    by_exact = {}
    by_score = defaultdict(list)
    for r in recs:
        by_exact[(r['code'], r['date'], r['home'], r['away'])] = r
        by_score[(r['code'], r['date'], r['score'])].append(r)
    return {'recs': recs, 'by_exact': by_exact, 'by_score': by_score}


def match_one(m, idx, alias):
    """对单场国内比赛做 v3 风格 join。命中高置信 4 法返回 enriched dict，否则 None。"""
    lg = m.get('leagueName', '')
    code = CROSSWALK.get(lg)
    if not code:
        return None
    date = m.get('matchDate', '')
    sc = m.get('sectionsNo999', '')
    if not date or ':' not in sc:
        return None
    zh_h, zh_a = m.get('homeTeam', ''), m.get('awayTeam', '')
    jc = implied(m.get('h'), m.get('d'), m.get('a'))
    if not jc:
        return None

    eng_h = alias.get(lg, {}).get(zh_h)
    eng_a = alias.get(lg, {}).get(zh_a)
    eu = None
    method = None

    # 1) 别名引导的精确 join（±1 天）
    if eng_h and eng_a:
        for off in (0, -1, 1):
            eu = idx['by_exact'].get((code, shift(date, off), eng_h, eng_a))
            if eu:
                method = 'exact' if off == 0 else 'exact_offset'
                break

    # 2) 比分唯一退化（同时学习别名）
    if not eu:
        for off in (0, -1, 1):
            cands = idx['by_score'].get((code, shift(date, off), sc), [])
            if len(cands) == 1:
                c = cands[0]
                alias.setdefault(lg, {})[zh_h] = c['home']
                alias.setdefault(lg, {})[zh_a] = c['away']
                eu = c
                method = 'score_unique' if off == 0 else 'score_unique_offset'
                break

    if not eu:
        return None  # 显式丢弃 low_conf 多候选猜测

    eu_avg = implied(eu['avg_h'], eu['avg_d'], eu['avg_a'])
    if not eu_avg:
        return None
    eu_b365 = implied(eu['b365_h'], eu['b365_d'], eu['b365_a'])
    eu_ps = implied(eu['ps_h'], eu['ps_d'], eu['ps_a'])

    return {
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
        'low_conf': False, 'match_method': method,
    }


def _write_gap(enriched, out_path):
    """重算 国内 vs 国外 偏差分布（对齐 v3，跳过 low_conf）。"""
    gaps = defaultdict(lambda: {'jh': [], 'jd': [], 'ja': []})
    allgaps = {'jh': [], 'jd': [], 'ja': []}
    for e in enriched:
        if e.get('low_conf'):
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
        mean = sum(lst) / n
        sd = (sum((x - mean) ** 2 for x in lst) / n) ** 0.5
        srt = sorted(lst)
        return {'n': n, 'mean': round(mean, 4), 'std': round(sd, 4),
                'p10': round(srt[int(n * 0.10)], 4), 'p90': round(srt[int(n * 0.90)], 4)}

    summary = {}
    for lg, d in gaps.items():
        summary[lg] = {k: stats(v) for k, v in d.items() if v}
    summary['ALL'] = {k: stats(v) for k, v in allgaps.items() if v}
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    return summary


def backfill(new_matches, log=print):
    """
    对 new_matches（已标准化的国内已结算比赛）回填欧盘。
    返回统计 dict: {added, skipped, by_method, note}。
    任何异常都在内部消化，保证调用方（daily_pipeline）不被拖垮。
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    try:
        existing = json.load(open(EU_PATH, encoding='utf-8')) if os.path.exists(EU_PATH) else []
        if not isinstance(existing, list):
            existing = []
    except Exception:
        existing = []
    seen = {(e.get('leagueName'), e.get('date'), e.get('zhHome'), e.get('zhAway')) for e in existing}

    alias = {}
    try:
        if os.path.exists(ALIAS_PATH):
            alias = json.load(open(ALIAS_PATH, encoding='utf-8'))
    except Exception:
        alias = {}

    idx_cache = {}

    def get_idx(season, code):
        key = (season, code)
        if key in idx_cache:
            return idx_cache[key]
        path = _ensure_csv(season, code)
        idx = _build_idx(path, code) if path else None
        idx_cache[key] = idx
        return idx

    added = 0
    skipped = 0
    skipped_no_intl = 0
    by_method = Counter()
    for m in new_matches:
        lg = m.get('leagueName', '')
        if lg not in CROSSWALK:
            skipped += 1
            continue
        date = m.get('matchDate', '')
        if not date:
            skipped += 1
            continue
        dedup = (lg, date, m.get('homeTeam', ''), m.get('awayTeam', ''))
        if dedup in seen:
            skipped += 1
            continue
        season = season_of(date)
        code = CROSSWALK[lg]
        idx = get_idx(season, code)
        if not idx:
            skipped += 1
            skipped_no_intl += 1
            continue
        enr = match_one(m, idx, alias)
        if not enr:
            skipped += 1
            continue
        existing.append(enr)
        seen.add(dedup)
        added += 1
        by_method[enr['match_method']] += 1

    note = ''
    if added:
        json.dump(existing, open(EU_PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        try:
            json.dump(alias, open(ALIAS_PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        except Exception:
            pass
        _write_gap(existing, GAP_PATH)
        note = '已写入 eu_odds_history.json(+%d) 并重算 eu_jc_gap.json' % added
    else:
        if skipped_no_intl:
            note = ('本批 %d 场无国际赔率可回填（联赛未映射/赛季CSV未就绪或数据源不可达，已优雅跳过）；'
                    '待 football-data 当前赛季CSV可用后自动补齐。' % skipped_no_intl)

    if log:
        log('  [欧盘回填] 新增 %d 场 | 跳过 %d 场（其中无国际源 %d） | %s'
            % (added, skipped, skipped_no_intl, by_method.most_common()))
    return {'added': added, 'skipped': skipped, 'skipped_no_intl': skipped_no_intl,
            'by_method': dict(by_method), 'note': note}


if __name__ == '__main__':
    # 自检：对历史 2526 赛季已匹配场次抽样，验证匹配器+CSV加载+赛季推算正确
    hist = json.load(open(os.path.join(HERE, 'data', 'history_matches.json'), encoding='utf-8'))
    eu = json.load(open(EU_PATH, encoding='utf-8'))
    eu_keys = {(e['leagueName'], e['date'], e['zhHome'], e['zhAway']) for e in eu}
    # 取 5 场已在 eu 中、属于 CROSSWALK 且 2526 的场次做"重匹配"验证
    sample = [m for m in hist
              if (m.get('leagueName') in CROSSWALK)
              and m.get('matchDate', '').startswith('2025')
              and (m.get('leagueName'), m.get('matchDate'), m.get('homeTeam'), m.get('awayTeam')) in eu_keys][:5]
    alias = json.load(open(ALIAS_PATH, encoding='utf-8')) if os.path.exists(ALIAS_PATH) else {}
    ok = 0
    for m in sample:
        season = season_of(m['matchDate'])
        code = CROSSWALK[m['leagueName']]
        idx = _build_idx(_ensure_csv(season, code), code)
        enr = match_one(m, idx, alias) if idx else None
        status = 'OK' if enr else 'MISS'
        if enr:
            ok += 1
        print('  %-14s %s %s -> %s  method=%s eu_avg=%s'
              % (m['leagueName'], m['matchDate'], m['homeTeam'] + ' vs ' + m['awayTeam'],
                 status, enr['match_method'] if enr else '-', enr['eu_avg'] if enr else '-'))
    print('自检: %d/%d 重匹配成功（验证匹配器+CSV+赛季推算）' % (ok, len(sample)))
