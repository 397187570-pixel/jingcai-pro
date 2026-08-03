#!/usr/bin/env python3
"""
train_model.py — 轻量 ML 训练脚本（Phase 2C）
竞彩智选 Pro

功能：
1. 生成/加载历史比赛数据（真实数据接入点）
2. 特征工程（与 fundamentals.js 对齐）
3. 训练逻辑回归模型（多分类：胜/平/负）
4. 导出模型权重为 JSON（浏览器端推理用）

用法：
    python3 train_model.py                # 用模拟数据训练
    python3 train_model.py --data matches.csv  # 用真实数据训练
"""

import json
import math
import random
import argparse
import os

# ============================================
# 1. 数据生成（模拟历史比赛）
# ============================================

def gen_elo_score(home_elo, away_elo, home_adv=50):
    """Elo 预期主胜概率"""
    dr = home_elo + home_adv - away_elo
    return 1 / (1 + 10 ** (-dr / 400))

def simulate_outcome(home_elo, away_elo):
    """基于 Elo + 随机性模拟比赛结果"""
    p_home = gen_elo_score(home_elo, away_elo)
    # 平局概率：实力接近时更高
    p_draw = 0.28 * (1 - abs(p_home - 0.5) * 1.2)
    p_home_win = p_home * (1 - p_draw)
    p_away_win = 1 - p_draw - p_home_win
    r = random.random()
    if r < p_home_win:
        return 0, p_home_win, p_draw, p_away_win  # 0=主胜
    elif r < p_home_win + p_draw:
        return 1, p_home_win, p_draw, p_away_win  # 1=平
    else:
        return 2, p_home_win, p_draw, p_away_win  # 2=客胜

def gen_mock_dataset(n=10000):
    """生成 n 场模拟比赛（供演示训练流程）"""
    data = []
    for _ in range(n):
        home_elo = random.randint(1300, 2200)
        away_elo = random.randint(1300, 2200)
        outcome, p_h, p_d, p_a = simulate_outcome(home_elo, away_elo)
        # 生成赔率（含抽水）
        margin = 1.08
        odds_h = round(margin / p_h, 2) if p_h > 0.05 else 20.0
        odds_d = round(margin / p_d, 2) if p_d > 0.05 else 20.0
        odds_a = round(margin / p_a, 2) if p_a > 0.05 else 20.0
        data.append({
            'home_elo': home_elo, 'away_elo': away_elo,
            'odds_h': odds_h, 'odds_d': odds_d, 'odds_a': odds_a,
            'label': outcome
        })
    return data

# ============================================
# 2. 特征工程（与前端 fundamentals.js 对齐）
# ============================================

FEATURE_NAMES = [
    'elo_diff', 'elo_home', 'elo_away',
    'odds_home', 'odds_draw', 'odds_away',
    'implied_home', 'implied_away'
]

def extract_features(row):
    """从原始数据提取特征（与前端 featuresToArray 前 8 维对齐）"""
    home_elo = row['home_elo']
    away_elo = row['away_elo']
    odds_h = row['odds_h']
    odds_d = row['odds_d']
    odds_a = row['odds_a']
    return [
        home_elo - away_elo,
        home_elo,
        away_elo,
        odds_h, odds_d, odds_a,
        1 / odds_h if odds_h > 1 else 0,
        1 / odds_a if odds_a > 1 else 0
    ]

# ============================================
# 2b. 特征标准化（z-score，ML 工程必备）
# ============================================

def compute_scaler(X):
    """计算各特征均值/标准差"""
    n = len(X)
    n_feat = len(X[0])
    means = [sum(x[i] for x in X) / n for i in range(n_feat)]
    stds = []
    for i in range(n_feat):
        var = sum((x[i] - means[i]) ** 2 for x in X) / n
        stds.append(math.sqrt(var) if var > 1e-9 else 1.0)
    return means, stds

def standardize(X, means, stds):
    """应用标准化"""
    return [[(x[i] - means[i]) / stds[i] for i in range(len(x))] for x in X]

# ============================================
# 3. 逻辑回归训练（多分类 softmax）
# ============================================

def softmax(z):
    m = max(z)
    e = [math.exp(x - m) for x in z]
    s = sum(e)
    return [x / s for x in e]

class SoftmaxRegression:
    """多分类逻辑回归（梯度下降）"""
    def __init__(self, n_features, n_classes=3, lr=0.01, epochs=500):
        self.W = [[random.uniform(-0.01, 0.01) for _ in range(n_features + 1)]
                  for _ in range(n_classes)]
        self.lr = lr
        self.epochs = epochs
        self.n_features = n_features

    def predict_proba(self, features):
        """预测概率 [p_home, p_draw, p_away]"""
        x = [1.0] + features  # bias term
        z = [sum(w[i] * x[i] for i in range(len(x))) for w in self.W]
        return softmax(z)

    def train(self, X, y):
        """X: list of feature lists, y: list of labels 0/1/2"""
        n = len(X)
        for epoch in range(self.epochs):
            grad = [[0.0] * (self.n_features + 1) for _ in range(3)]
            loss = 0.0
            for i in range(n):
                x = [1.0] + X[i]
                probs = self.predict_proba(X[i])
                true = y[i]
                for k in range(3):
                    error = probs[k] - (1.0 if k == true else 0.0)
                    for j in range(len(x)):
                        grad[k][j] += error * x[j]
                loss += -math.log(max(probs[true], 1e-9))
            # 梯度下降更新
            for k in range(3):
                for j in range(len(grad[k])):
                    self.W[k][j] -= self.lr * grad[k][j] / n
            if epoch % 50 == 0:
                print(f"  epoch {epoch}: loss = {loss / n:.4f}")
        print(f"  epoch {self.epochs}: loss = {loss / n:.4f}")

    def export_json(self, path, scaler=None):
        """导出权重为 JSON（浏览器端加载）"""
        model = {
            'type': 'softmax_regression',
            'n_features': self.n_features,
            'n_classes': 3,
            'feature_names': FEATURE_NAMES,
            'weights': self.W,
            'scaler': scaler,  # [means, stds] 用于推理端标准化
            'version': '1.1.0'
        }
        with open(path, 'w') as f:
            json.dump(model, f, ensure_ascii=False, indent=2)
        print(f"  ✅ 模型已导出: {path} ({os.path.getsize(path)} bytes)")

# ============================================
# 4. 主流程
# ============================================

def main():
    parser = argparse.ArgumentParser(description='竞彩智选 Pro ML 训练')
    parser.add_argument('--data', help='真实数据 CSV 路径（可选）')
    parser.add_argument('--samples', type=int, default=10000, help='模拟数据量')
    parser.add_argument('--out', default='../js/engine/mlModel.json', help='模型输出路径')
    args = parser.parse_args()

    random.seed(42)
    print("=" * 50)
    print("🤖 竞彩智选 Pro — ML 模型训练")
    print("=" * 50)

    # 数据
    if args.data and os.path.exists(args.data):
        print(f"📊 加载真实数据: {args.data}")
        # TODO: 解析 CSV（home_elo,away_elo,odds_h,odds_d,odds_a,label）
        dataset = []
    else:
        print(f"📊 生成模拟数据: {args.samples} 场")
        dataset = gen_mock_dataset(args.samples)

    # 特征 + 标签
    X = [extract_features(d) for d in dataset]
    y = [d['label'] for d in dataset]

    # 分割训练/测试
    split = int(len(X) * 0.8)
    X_train, y_train = X[:split], y[:split]
    X_test, y_test = X[split:], y[split:]
    print(f"  训练集: {len(X_train)} | 测试集: {len(X_test)}")

    # 标准化（用训练集计算 scaler）
    print("\n📐 特征标准化 (z-score)...")
    means, stds = compute_scaler(X_train)
    X_train_s = standardize(X_train, means, stds)
    X_test_s = standardize(X_test, means, stds)

    # 训练
    print("\n🧠 训练 Softmax 回归...")
    model = SoftmaxRegression(n_features=len(X_train_s[0]))
    model.train(X_train_s, y_train)

    # 评估
    correct = 0
    for i in range(len(X_test_s)):
        pred = model.predict_proba(X_test_s[i])
        pred_label = pred.index(max(pred))
        if pred_label == y_test[i]:
            correct += 1
    acc = correct / len(X_test_s)
    print(f"\n🎯 测试准确率: {acc:.2%} ({correct}/{len(X_test_s)})")

    # 导出（含 scaler）
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), args.out)
    model.export_json(out_path, scaler=[means, stds])
    print("\n✅ 训练完成！")

if __name__ == '__main__':
    main()
