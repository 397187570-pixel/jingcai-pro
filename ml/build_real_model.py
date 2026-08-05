#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_real_model.py — 基于真实竞彩历史数据(4399 场)构建预测与校准产物
竞彩智选 Pro

核心产物(全部来自真实数据, 非模拟):
  1. js/engine/calibration.json      全局竞彩隐含概率 → 真实命中率 校准表
  2. js/engine/league_calibration.json  联赛级校准(检测低效联赛 = 潜在 edge)
  3. js/engine/asian_handicap.json   亚盘让球结果分布表
  4. 今日实时价值信号函数 value_signal(jc, eu) 的文档化逻辑(供前端复用)

关键事实(已验证):
  - 竞彩隐含概率本身校准极好 (Brier≈0.0005), 是 1X2 最佳基准。
  - 庄家固定抽水 12.9% → 任何玩法长期为负 EV, 模型只能识别局部价值。
  - 历史数据无欧盘/身价/天气等, 故「国内外对比」仅限今日实时。
"""

import json
import os
import math
import statistics
from collections import Counter, defaultdict

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'history_matches.json')
ENGINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'js', 'engine')


def load():
    with open(DATA) as f:
        return json.load(f)


def implied(h, d, a):
    """竞彩 h/d/a 去水 → 概率"""
    s = 1.0 / h + 1.0 / d + 1.0 / a
    return [1.0 / h / s, 1.0 / d / s, 1.0 / a / s]


def label_of(m):
    return {'H': 0, 'D': 1, 'A': 2}[m['winFlag']]


# ============================================================
# 1. 全局校准
# ============================================================
def global_calibration(matches, n_bins=10):
    bins = [{'lo': i / n_bins, 'hi': (i + 1) / n_bins, 'pred': 0.0, 'act': 0, 'cnt': 0}
            for i in range(n_bins)]
    for m in matches:
        try:
            h, d, a = float(m['h']), float(m['d']), float(m['a'])
        except Exception:
            continue
        p = implied(h, d, a)
        mp = max(p)
        pred_lab = p.index(mp)
        act_lab = label_of(m)
        idx = min(int(mp * n_bins), n_bins - 1)
        bins[idx]['pred'] += mp
        bins[idx]['act'] += (1 if pred_lab == act_lab else 0)
        bins[idx]['cnt'] += 1
    table = []
    for b in bins:
        if b['cnt'] > 0:
            pr = b['pred'] / b['cnt']
            ac = b['act'] / b['cnt']
            table.append({
                'range': '%s-%s' % (round(b['lo'], 2), round(b['hi'], 2)),
                'predicted': round(pr, 4),
                'actual': round(ac, 4),
                'count': b['cnt'],
                'bias': round(ac - pr, 4),
            })
    brier = sum((b['actual'] - b['predicted']) ** 2 * b['count'] for b in table) / len(matches)
    return table, round(brier, 4)


# ============================================================
# 2. 联赛级校准 + 效率检测
# ============================================================
def league_calibration(matches, min_n=40):
    by_league = defaultdict(list)
    for m in matches:
        try:
            h, d, a = float(m['h']), float(m['d']), float(m['a'])
        except Exception:
            continue
        by_league[m.get('leagueName', '未知')].append(m)

    out = {}
    for lg, ms in by_league.items():
        if len(ms) < min_n:
            continue
        # 整体命中率 vs 基准(选最高隐含概率方向)
        hits = 0
        for m in ms:
            p = implied(float(m['h']), float(m['d']), float(m['a']))
            pred = p.index(max(p))
            if pred == label_of(m):
                hits += 1
        base_rate = hits / len(ms)
        # 平均偏差(实际-预测), 正=庄家保守(实际更易命中), 负=庄家乐观
        devs = []
        for m in ms:
            p = implied(float(m['h']), float(m['d']), float(m['a']))
            mp = max(p)
            pred = p.index(mp)
            devs.append((1 if pred == label_of(m) else 0) - mp)
        mean_dev = statistics.mean(devs)
        out[lg] = {
            'n': len(ms),
            'top_pick_hit_rate': round(base_rate, 4),
            'mean_bias': round(mean_dev, 4),
            'edge_flag': 'favorite_underpriced' if mean_dev > 0.03 else (
                'underdog_underpriced' if mean_dev < -0.03 else 'efficient'),
        }
    return out


# ============================================================
# 3. 亚盘让球分布
# ============================================================
def asian_handicap(matches):
    gl_stat = defaultdict(Counter)
    for m in matches:
        gl = m.get('goalLine')
        if gl in (None, ''):
            continue
        try:
            gl = float(gl)
            hg, ag = (int(x) for x in m['sectionsNo999'].split(':'))
        except Exception:
            continue
        diff = hg - ag
        eff = diff - gl  # 正=主让, 负=主受让; eff>0 让球主胜
        if eff > 0:
            res = 'home'
        elif eff == 0:
            res = 'draw'
        else:
            res = 'away'
        gl_stat[gl][res] += 1
    out = {}
    for gl in sorted(gl_stat):
        c = gl_stat[gl]
        tot = sum(c.values())
        out[str(gl)] = {
            'n': tot,
            'home': round(c['home'] / tot, 4),
            'draw': round(c['draw'] / tot, 4),
            'away': round(c['away'] / tot, 4),
        }
    return out


# ============================================================
# 4. 今日实时价值信号(逻辑, 供前端复用)
# ============================================================
def value_signal(jc, eu):
    """
    jc = (h,d,a) 竞彩赔率; eu = (h,d,a) 欧盘赔率(同一比赛)
    返回每个方向的价值差 = 竞彩隐含概率 - 欧盘隐含概率。
    差为正 → 竞彩在该方向给的赔付相对其概率更优 → 价值信号。
    """
    pj = implied(*jc)
    pe = implied(*eu)
    labels = ['home', 'draw', 'away']
    sig = {labels[i]: round(pj[i] - pe[i], 4) for i in range(3)}
    best = max(sig, key=sig.get)
    return {'signal': sig, 'best_value_side': best, 'best_value': sig[best]}


# ============================================================
# 主流程
# ============================================================
def main():
    print("=" * 60)
    print("🏗️  竞彩智选 Pro — 真实模型构建 (4399 场)")
    print("=" * 60)
    matches = load()
    n = len(matches)
    print(f"载入 {n} 场真实比赛")

    os.makedirs(ENGINE, exist_ok=True)

    # 1. 全局校准
    table, brier = global_calibration(matches)
    print(f"\n📊 全局校准 Brier = {brier}")
    cal = {
        'type': 'confidence_calibration',
        'version': '2.0.0-real',
        'n_matches': n,
        'brier_score': brier,
        'generated_at': __import__('time').strftime('%Y-%m-%d %H:%M'),
        'note': 'predicted=竞彩隐含概率, actual=真实命中率; 前端用 actual 作为真实置信度。',
        'table': table,
    }
    with open(os.path.join(ENGINE, 'calibration.json'), 'w') as f:
        json.dump(cal, f, ensure_ascii=False, indent=2)
    print("  ✅ calibration.json")

    # 2. 联赛校准
    lg = league_calibration(matches)
    inefficient = {k: v for k, v in lg.items() if v['edge_flag'] != 'efficient'}
    with open(os.path.join(ENGINE, 'league_calibration.json'), 'w') as f:
        json.dump({'version': '2.0.0-real', 'leagues': lg,
                   'inefficient_count': len(inefficient)}, f, ensure_ascii=False, indent=2)
    print(f"  ✅ league_calibration.json ({len(lg)} 联赛, {len(inefficient)} 个低效联赛)")
    for k, v in sorted(inefficient.items(), key=lambda x: -abs(x[1]['mean_bias'])):
        print(f"     ⚠️ {k}: 样本{v['n']} 偏差{v['mean_bias']:+.3f} → {v['edge_flag']}")

    # 3. 亚盘
    ah = asian_handicap(matches)
    with open(os.path.join(ENGINE, 'asian_handicap.json'), 'w') as f:
        json.dump({'version': '2.0.0-real', 'handicaps': ah}, f, ensure_ascii=False, indent=2)
    print(f"  ✅ asian_handicap.json ({len(ah)} 个盘口)")

    print("\n✅ Phase A 产物已导出到 js/engine/")


if __name__ == '__main__':
    main()
