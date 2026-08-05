#!/usr/bin/env python3
"""
collect_football_data.py — 用 football-data.org 采集真实历史比赛
竞彩智选 Pro · 为 ML 训练 + 置信度校准提供真实数据

用法：
    python3 collect_football_data.py                    # 默认采集巴西+欧洲5大联赛
    python3 collect_football_data.py --comps BSA SA PL  # 指定联赛
    python3 collect_football_data.py --key xxx          # 直接传 key（不推荐，用环境变量更安全）

环境变量：
    FOOTBALL_DATA_KEY=你的key python3 collect_football_data.py
"""

import json
import os
import sys
import time
import argparse
import urllib.request

API_BASE = 'https://api.football-data.org/v4'
COMPETITIONS = ['BSA', 'SA', 'PD', 'BL1', 'FL1', 'PL']

def get_key(args_key):
    """优先级：命令行 > 环境变量"""
    return args_key or os.environ.get('FOOTBALL_DATA_KEY', '')

def fetch_with_auth(url, key):
    """带 X-Auth-Token 请求 + 限流头解析"""
    req = urllib.request.Request(url, headers={
        'X-Auth-Token': key,
        'Accept': 'application/json'
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        # 解析限流头（邮件特别提醒）
        avail = resp.headers.get('x-requests-available-minute')
        reset = resp.headers.get('x-requestcounter-reset')
        if avail:
            print(f"  ⏱️ 剩余配额: {avail}/分钟 | 重置: {reset}s")
        data = json.loads(resp.read().decode('utf-8'))
        return data, resp.headers

def collect_competition(comp, key, limit=100):
    """采集单个联赛已结束比赛"""
    url = f"{API_BASE}/competitions/{comp}/matches?status=FINISHED&limit={limit}"
    try:
        data, _ = fetch_with_auth(url, key)
        matches = data.get('matches', [])
        # 标准化：赛前 + 赛后
        samples = []
        for m in matches:
            ht = m.get('homeTeam', {}).get('name', '')
            at = m.get('awayTeam', {}).get('name', '')
            ft = m.get('score', {}).get('fullTime', {})
            hg, ag = ft.get('home'), ft.get('away')
            if hg is None or ag is None:
                continue
            label = 0 if hg > ag else (1 if hg == ag else 2)
            samples.append({
                'competition': m.get('competition', {}).get('name', comp),
                'home_team': ht,
                'away_team': at,
                'date': m.get('utcDate', '')[:10],
                'home_goals': hg,
                'away_goals': ag,
                'label': label,
                'match_id': m.get('id')
            })
        return samples
    except urllib.error.HTTPError as e:
        print(f"  ⚠️ {comp} HTTP {e.code}: {e.reason}")
        return []
    except Exception as e:
        print(f"  ⚠️ {comp} 错误: {e}")
        return []

def main():
    parser = argparse.ArgumentParser(description='football-data.org 数据采集')
    parser.add_argument('--key', help='API Key（建议用环境变量 FOOTBALL_DATA_KEY）')
    parser.add_argument('--comps', nargs='+', default=COMPETITIONS, help='联赛代码')
    parser.add_argument('--limit', type=int, default=100, help='每联赛场次')
    parser.add_argument('--out', default='data/football_history.json')
    args = parser.parse_args()

    key = get_key(args.key)
    if not key:
        print("❌ 未提供 API Key（用 --key 或环境变量 FOOTBALL_DATA_KEY）")
        sys.exit(1)

    print("=" * 55)
    print("⚽ football-data.org 真实数据采集")
    print("=" * 55)
    print(f"🔑 Key: {key[:6]}...{key[-4:]}")

    all_matches = []
    for comp in args.comps:
        print(f"\n📊 采集 {comp}:")
        samples = collect_competition(comp, args.key if args.key else key, args.limit)
        print(f"  ✅ {comp}: {len(samples)} 场有效比赛")
        all_matches.extend(samples)
        time.sleep(2)  # 限流保护

    print(f"\n📈 总计: {len(all_matches)} 场比赛（{len(args.comps)} 个联赛）")

    # 标签分布
    labels = {0: 0, 1: 0, 2: 0}
    for m in all_matches:
        labels[m['label']] = labels.get(m['label'], 0) + 1
    total = max(1, len(all_matches))
    print(f"   主胜: {labels[0]} ({labels[0]/total:.1%}) | 平: {labels[1]} ({labels[1]/total:.1%}) | 客胜: {labels[2]} ({labels[2]/total:.1%})")

    # 保存
    os.makedirs('data', exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(all_matches, f, ensure_ascii=False, indent=1)
    print(f"💾 已保存: {args.out} ({os.path.getsize(args.out)} bytes)")

if __name__ == '__main__':
    main()
