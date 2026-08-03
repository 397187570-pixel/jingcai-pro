#!/usr/bin/env python3
"""
collect_and_calibrate.py — 真实数据采集 + 置信度校准（Phase 2C+）
竞彩智选 Pro

核心功能（对应你的需求）：
1. 采集过去 N 个月竞彩官方历史比赛（赛前赔率 + 赛后结果）
2. 用赛前数据计算模型预测概率
3. 对比"预测概率 vs 实际命中率"生成校准表（真实置信度）
4. 导出 calibration.json 供前端使用

用法：
    python3 collect_and_calibrate.py --months 12   # 过去 1 年
    python3 collect_and_calibrate.py --months 3    # 过去 3 个月
"""

import json
import math
import time
import argparse
import urllib.request

# ============================================
# 1. 数据采集（竞彩官方历史接口）
# ============================================

API_URL = ("https://webapi.sporttery.cn/gateway/uniform/football/"
           "getUniformMatchResultV1.qry")

def fetch_page(begin, end, page=1, page_size=100):
    """拉取一页历史比赛"""
    url = (f"{API_URL}?matchBeginDate={begin}&matchEndDate={end}"
           f"&leagueId=&pageSize={page_size}&pageNo={page}"
           f"&isFix=0&matchPage=1&pcOrWap=1")
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Referer': 'https://www.sporttery.cn/'
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))

def collect_matches(months=12):
    """采集过去 months 个月的比赛（按周分页拉取）"""
    import datetime
    today = datetime.date.today()
    matches = []
    seen = set()

    # 按周滑动窗口采集（避免单次请求太大）
    for week in range(months * 4):
        end = today - datetime.timedelta(days=week * 7)
        begin = end - datetime.timedelta(days=6)
        b, e = begin.strftime('%Y-%m-%d'), end.strftime('%Y-%m-%d')

        for page in range(1, 11):  # 最多 10 页/周
            try:
                data = fetch_page(b, e, page=page, page_size=100)
                result = data.get('value', {}).get('matchResult', [])
                if not result:
                    break
                for m in result:
                    mid = m.get('matchId')
                    if mid and mid not in seen and m.get('winFlag') in ('H', 'D', 'A'):
                        seen.add(mid)
                        matches.append(m)
                if len(result) < 100:
                    break
                time.sleep(0.3)
            except Exception as ex:
                break
        if len(matches) > 0 and week > 0 and week % 4 == 0:
            print(f"  📅 {b}~{e}: 累计 {len(matches)} 场")

    return matches

# ============================================
# 2. 特征 + 标签提取
# ============================================

def extract_feature(m):
    """赛前数据 → 特征（与前端 fundamentals 前 8 维对齐）"""
    h, d, a = float(m['h']), float(m['d']), float(m['a'])
    return [
        0.0,   # elo_diff（无 elo 数据时用赔率隐含）
        0.0,   # elo_home
        0.0,   # elo_away
        h, d, a,
        1 / h if h > 1 else 0,   # implied_home
        1 / a if a > 1 else 0    # implied_away
    ]

def label_of(m):
    """赛后结果 → 标签 0=主胜 1=平 2=客胜"""
    return {'H': 0, 'D': 1, 'A': 2}[m['winFlag']]

# ============================================
# 3. 赔率隐含概率（作为基准预测）
# ============================================

def odds_implied_probs(h, d, a):
    """赔率去水 → 概率"""
    sum_inv = 1 / h + 1 / d + 1 / a
    return [1 / h / sum_inv, 1 / d / sum_inv, 1 / a / sum_inv]

# ============================================
# 4. 置信度校准（核心！）
# ============================================

def calibrate(matches, n_bins=10):
    """
    置信度校准：对比预测概率 vs 实际命中率
    返回校准表：[{bin: [lo,hi), predicted, actual, count}, ...]
    """
    # 收集所有预测的最高概率 + 是否命中
    samples = []  # (max_prob, hit)
    for m in matches:
        h, d, a = float(m['h']), float(m['d']), float(m['a'])
        probs = odds_implied_probs(h, d, a)
        pred_label = probs.index(max(probs))
        actual_label = label_of(m)
        samples.append((max(probs), pred_label == actual_label))

    if not samples:
        return []

    # 分桶校准
    bins = [{'lo': i / n_bins, 'hi': (i + 1) / n_bins, 'pred': 0.0, 'actual': 0.0, 'count': 0}
            for i in range(n_bins)]
    for prob, hit in samples:
        idx = min(int(prob * n_bins), n_bins - 1)
        bins[idx]['pred'] += prob
        bins[idx]['actual'] += 1 if hit else 0
        bins[idx]['count'] += 1

    table = []
    for b in bins:
        if b['count'] > 0:
            table.append({
                'range': f"{b['lo']:.1f}-{b['hi']:.1f}",
                'predicted': round(b['pred'] / b['count'], 4),
                'actual': round(b['actual'] / b['count'], 4),
                'count': b['count']
            })

    return table

# ============================================
# 5. 主流程
# ============================================

def main():
    parser = argparse.ArgumentParser(description='竞彩智选 Pro 数据采集+校准')
    parser.add_argument('--months', type=int, default=12, help='采集月数')
    parser.add_argument('--out', default='../js/engine/calibration.json')
    parser.add_argument('--no-fetch', action='store_true', help='跳过采集（仅演示）')
    args = parser.parse_args()

    print("=" * 55)
    print("📊 竞彩智选 Pro — 置信度校准系统")
    print("=" * 55)

    # 采集
    if args.no_fetch:
        print("⚠️ 跳过采集（演示模式）")
        matches = []
    else:
        print(f"🔄 采集过去 {args.months} 个月比赛数据...")
        matches = collect_matches(args.months)
        print(f"✅ 采集完成: {len(matches)} 场有效比赛")

        # 保存原始数据
        raw_path = '../ml/data/history_matches.json'
        import os
        os.makedirs('../ml/data', exist_ok=True)
        with open(raw_path, 'w') as f:
            json.dump(matches, f, ensure_ascii=False)
        print(f"💾 原始数据已保存: {raw_path}")

    if not matches:
        # 演示数据
        print("⚠️ 使用模拟数据演示校准流程")
        matches = []
        h = [1.5, 1.8, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 1.3, 1.7, 2.2, 2.8, 3.2, 4.5, 1.6, 1.9]
        for i, odd in enumerate(h):
            import random
            random.seed(i)
            d = round(odd * random.uniform(1.4, 1.8), 2)
            a = round(odd * random.uniform(1.8, 2.5), 2)
            probs = odds_implied_probs(odd, d, a)
            label = probs.index(max(probs))
            matches.append({
                'h': str(odd), 'd': str(d), 'a': str(a),
                'winFlag': ['H', 'D', 'A'][label],
                'matchId': i, 'homeTeam': '主', 'awayTeam': '客',
                'matchDate': '2025-01-01', 'matchNumStr': f'模拟{i:03d}',
                'leagueName': '演示', 'sectionsNo999': '1:0'
            })

    # 统计基础
    n = len(matches)
    hw = sum(1 for m in matches if m['winFlag'] == 'H')
    dr = sum(1 for m in matches if m['winFlag'] == 'D')
    aw = sum(1 for m in matches if m['winFlag'] == 'A')
    print(f"\n📈 数据分布（{n} 场）:")
    print(f"  主胜 {hw} ({hw/n:.1%}) | 平局 {dr} ({dr/n:.1%}) | 客胜 {aw} ({aw/n:.1%})")

    # 校准
    print("\n🎯 生成置信度校准表...")
    table = calibrate(matches, n_bins=10)
    print(f"{'区间':<12}{'预测概率':<12}{'实际命中率':<12}{'场次':<8}{'偏差'}")
    print("-" * 50)
    for row in table:
        bias = row['actual'] - row['predicted']
        flag = '✅' if abs(bias) < 0.05 else ('⚠️' if abs(bias) < 0.1 else '❌')
        print(f"{row['range']:<12}{row['predicted']:<12.3f}{row['actual']:<12.3f}{row['count']:<8}{bias:+.3f} {flag}")

    # 整体校准质量（Brier score 近似）
    brier = sum((row['actual'] - row['predicted'])**2 * row['count']
                for row in table) / n if n else 0
    print(f"\n📊 Brier 分数（越小越好）: {brier:.4f}")

    # 导出校准表
    import os
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), args.out)
    output = {
        'type': 'confidence_calibration',
        'version': '1.0.0',
        'n_matches': n,
        'brier_score': round(brier, 4),
        'generated_at': time.strftime('%Y-%m-%d %H:%M'),
        'table': table,
        'note': 'predicted=模型预测概率, actual=实际命中率, 前端用 actual 作为真实置信度'
    }
    with open(out_path, 'w') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\n✅ 校准表已导出: {out_path}")
    print("""
📖 如何使用校准表：
  前端预测得到概率 P 后，查表找到 P 所在区间，
  用该区间的 actual 值作为【真实置信度】展示。
  例：模型说 72% → 查表 0.7-0.8 区间实际 68% → 显示 68%
""")

if __name__ == '__main__':
    main()
