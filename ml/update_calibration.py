#!/usr/bin/env python3
"""
update_calibration.py — 一键更新校准数据
竞彩智选 Pro

作用：拉取最新历史数据 → 重新校准 → 更新 calibration.json
（供本地手动运行或 cron 定时调用）

用法：
    python3 update_calibration.py             # 默认过去 3 个月
    python3 update_calibration.py --months 12 # 过去 1 年
"""

import os
import sys
import subprocess
import datetime

def main():
    months = 3
    if '--months' in sys.argv:
        idx = sys.argv.index('--months')
        months = int(sys.argv[idx + 1])

    base = os.path.dirname(os.path.abspath(__file__))
    print("=" * 55)
    print(f"🔄 校准更新（过去 {months} 个月） — {datetime.datetime.now():%Y-%m-%d %H:%M}")
    print("=" * 55)

    # 1. 采集 + 校准
    print("\n[1/3] 采集历史数据并校准...")
    r1 = subprocess.run([sys.executable, 'collect_and_calibrate.py', '--months', str(months)],
                        cwd=base)
    if r1.returncode != 0:
        print("❌ 采集/校准失败")
        sys.exit(1)

    # 2. 回测
    print("\n[2/3] 运行策略回测...")
    r2 = subprocess.run([sys.executable, 'backtest.py'], cwd=base)
    if r2.returncode != 0:
        print("⚠️ 回测失败（不影响校准）")

    # 3. 验证前端能加载
    print("\n[3/3] 验证校准文件...")
    cal_path = os.path.join(base, '../js/engine/calibration.json')
    if os.path.exists(cal_path):
        import json
        with open(cal_path) as f:
            cal = json.load(f)
        print(f"✅ calibration.json 已更新: {cal['n_matches']} 场比赛, Brier={cal['brier_score']}")
    else:
        print("❌ 校准文件不存在")
        sys.exit(1)

    print("\n🎉 校准更新完成！记得 git commit + push 提交新校准表。")

if __name__ == '__main__':
    main()
