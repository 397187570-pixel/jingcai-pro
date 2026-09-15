#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
P8 — ML 建模升级：用监督学习替换 P5 的静态偏差规则统计
=====================================================================
目标：验证"逻辑回归 / 梯度提升"是否在方向准确率与价值下注 ROI 上
     优于 (a) 总是选热门  (b) 市场隐含概率  (c) P5 规则。

严格防泄漏：所有价值下注 ROI 用 out-of-fold(OOF) 预测计算。

输出：
  - 控制台报告（基线对比 / CV 指标 / 价值下注 ROI / 特征重要性）
  - ml/p8_model_lr.json（最优 LR 的系数+截距+特征名，供 JS 移植）
"""

import json, math, sys, os
import numpy as np
from collections import defaultdict

DATA = os.path.join(os.path.dirname(__file__), "data", "eu_odds_history.json")

# ---------- 数据加载与特征 ----------
def implied(odds_triple):
    """decimal odds -> normalized implied prob (去除自身 margin 前，即 1/o 归一)"""
    inv = [1.0 / o for o in odds_triple]
    s = sum(inv)
    if s <= 0:
        return None
    return [x / s for x in inv]

def load():
    raw = json.load(open(DATA, encoding="utf-8"))
    X, y, meta = [], [], []
    for r in raw:
        if r.get("low_conf"):
            continue
        if not r.get("jc_score") or r.get("eu_score") is None:
            continue
        sc = str(r["jc_score"])
        if ":" not in sc:
            continue
        a, b = sc.split(":")
        try:
            a, b = float(a), float(b)
        except ValueError:
            continue
        if a > b: o = 0  # h
        elif a < b: o = 2  # a
        else: o = 1  # d

        jc = [float(r["jc_h"]), float(r["jc_d"]), float(r["jc_a"])]
        if any(v <= 1 for v in jc):
            continue
        eu = r.get("eu_avg")
        if not eu:
            continue
        eu = [float(x) for x in eu]
        if any(v <= 1 for v in eu):
            continue

        jc_imp = implied(jc)
        eu_imp = implied(eu)
        if jc_imp is None or eu_imp is None:
            continue

        b365 = r.get("eu_b365")
        b365_imp = None
        if b365 and all(float(x) > 1 for x in b365):
            b365_imp = implied([float(x) for x in b365])

        ps = r.get("eu_ps")
        ps_imp = None
        if ps and all(float(x) > 1 for x in ps):
            ps_imp = implied([float(x) for x in ps])

        gap = [jc_imp[i] - eu_imp[i] for i in range(3)]
        feat = {
            "jc_imp": jc_imp,
            "eu_imp": eu_imp,
            "gap": gap,
            "b365_imp": b365_imp,
            "ps_imp": ps_imp,
            "jc_odds": jc,
            "margin": sum(1.0 / v for v in jc) - 1.0,
        }
        X.append(feat)
        y.append(o)
        meta.append({"league": r.get("leagueName"), "zh": f'{r.get("zhHome")} vs {r.get("zhAway")}'})
    return X, np.array(y), meta

# ---------- 特征矩阵构造 ----------
def build_matrix(X, scheme):
    rows = []
    for f in X:
        if scheme == "A":
            vec = f["jc_imp"] + f["eu_imp"]
        elif scheme == "B":
            vec = f["jc_imp"] + f["eu_imp"] + f["gap"]
        elif scheme == "C":
            b3 = f["b365_imp"]
            if b3 is None:
                b3 = f["eu_imp"]  # 缺失用欧盘均价兜底
            gap_b = [f["jc_imp"][i] - b3[i] for i in range(3)]
            vec = f["jc_imp"] + f["eu_imp"] + f["gap"] + b3 + gap_b
        else:
            raise ValueError(scheme)
        rows.append(vec)
    return np.array(rows, dtype=float)

FEATURE_NAMES = {
    "A": ["jc_h","jc_d","jc_a","eu_h","eu_d","eu_a"],
    "B": ["jc_h","jc_d","jc_a","eu_h","eu_d","eu_a","gap_h","gap_d","gap_a"],
    "C": ["jc_h","jc_d","jc_a","eu_h","eu_d","eu_a","gap_h","gap_d","gap_a",
          "b365_h","b365_d","b365_a","gapB_h","gapB_d","gapB_a"],
}

# ---------- 指标 ----------
def accuracy(y, p):
    return float(np.mean(np.argmax(p, axis=1) == y))

def logloss(y, p, eps=1e-15):
    p = np.clip(p, eps, 1 - eps)
    n = len(y)
    ll = 0.0
    for i in range(n):
        ll -= math.log(p[i, y[i]])
    return ll / n

def brier(y, p):
    n = len(y)
    s = 0.0
    for i in range(n):
        for c in range(3):
            t = 1.0 if c == y[i] else 0.0
            s += (p[i, c] - t) ** 2
    return s / n

# ---------- 价值下注回测 ----------
def value_bet_roi(y, jc_odds, p_model, pick="best_edge"):
    """
    对每条样本(已是 OOF 预测)：计算各边 edge = p_model - 1/jc_o (breakeven)。
    仅当下注边 edge>0 才下注（每场最多下 1 边=edge 最大边）。
    返回 (roi, n_bets, n_wins)
    """
    profit = 0.0
    n_bets = 0
    n_wins = 0
    for i in range(len(y)):
        odds = jc_odds[i]
        breakeven = [1.0 / o for o in odds]
        edges = [p_model[i][c] - breakeven[c] for c in range(3)]
        bi = int(np.argmax(edges))
        if edges[bi] <= 0:
            continue
        n_bets += 1
        if y[i] == bi:
            n_wins += 1
            profit += (odds[bi] - 1.0)
        else:
            profit -= 1.0
    roi = (profit / n_bets) if n_bets else 0.0
    return roi, n_bets, n_wins

def always_favorite_roi(y, jc_odds):
    """每场无脑下"竞彩最看好(最低赔=最高隐含)"边。"""
    profit = 0.0
    for i in range(len(y)):
        odds = jc_odds[i]
        fav = int(np.argmin(odds))  # 最低赔
        if y[i] == fav:
            profit += (odds[fav] - 1.0)
        else:
            profit -= 1.0
    return profit / len(y), len(y), int(np.sum(y == np.argmin(jc_odds, axis=1)))

# ---------- 主流程 ----------
def main():
    X, y, meta = load()
    n = len(y)
    print(f"[data] 高置信样本 n={n}")
    base = np.bincount(y, minlength=3) / n
    print(f"[base] 赛果分布 h/d/a = {base.round(4).tolist()}")

    jc_odds_all = np.array([f["jc_odds"] for f in X])

    # 双基线
    fav_acc = accuracy(y, np.eye(3)[np.argmin(jc_odds_all, axis=1)])
    market_p = np.array([f["jc_imp"] for f in X])
    market_ll = logloss(y, market_p)
    market_br = brier(y, market_p)
    af_roi, af_n, af_w = always_favorite_roi(y, jc_odds_all)
    print(f"\n=== 基线 ===")
    print(f"总是选热门  acc={fav_acc:.4f}")
    print(f"市场隐含(jc_implied)  logloss={market_ll:.4f}  brier={market_br:.4f}")
    print(f"无脑下热门 ROI={af_roi*100:+.2f}%  (n={af_n}, win={af_w}, wr={af_w/af_n*100:.1f}%)")

    from sklearn.linear_model import LogisticRegression
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.model_selection import StratifiedKFold
    try:
        import xgboost as xgb
        HAVE_XGB = True
    except Exception:
        HAVE_XGB = False
    print(f"[env] xgboost={'yes' if HAVE_XGB else 'no (用 HistGBM 代理)'}")

    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)

    schemes = ["A", "B", "C"]
    results = {}

    for scheme in schemes:
        Xm = build_matrix(X, scheme)
        # OOF 预测矩阵
        oof = np.zeros((n, 3))
        for tr, te in skf.split(Xm, y):
            # LR
            lr = LogisticRegression(max_iter=2000, C=1.0)
            lr.fit(Xm[tr], y[tr])
            oof[te] = lr.predict_proba(Xm[te])
        lr_acc = accuracy(y, oof)
        lr_ll = logloss(y, oof)
        lr_br = brier(y, oof)
        lr_roi, lr_nb, lr_w = value_bet_roi(y, jc_odds_all, oof)
        results[scheme] = {"lr": (lr_acc, lr_ll, lr_br, lr_roi, lr_nb, lr_w)}

        # GBM
        oof2 = np.zeros((n, 3))
        for tr, te in skf.split(Xm, y):
            if HAVE_XGB:
                clf = xgb.XGBClassifier(n_estimators=300, max_depth=3, learning_rate=0.05,
                                        subsample=0.9, colsample_bytree=0.9,
                                        objective="multi:softprob", num_class=3,
                                        eval_metric="mlogloss", verbosity=0)
            else:
                clf = HistGradientBoostingClassifier(max_iter=300, max_depth=3,
                                                    learning_rate=0.05, random_state=42)
            clf.fit(Xm[tr], y[tr])
            oof2[te] = clf.predict_proba(Xm[te])
        gbm_acc = accuracy(y, oof2)
        gbm_ll = logloss(y, oof2)
        gbm_br = brier(y, oof2)
        gbm_roi, gbm_nb, gbm_w = value_bet_roi(y, jc_odds_all, oof2)
        results[scheme]["gbm"] = (gbm_acc, gbm_ll, gbm_br, gbm_roi, gbm_nb, gbm_w)

        print(f"\n=== 方案 {scheme} ({len(FEATURE_NAMES[scheme])} 特征) ===")
        print(f"LR   acc={lr_acc:.4f}  logloss={lr_ll:.4f}  brier={lr_br:.4f}  | 价值下注ROI={lr_roi*100:+.2f}% (n={lr_nb},wr={lr_w/lr_nb*100:.1f}%)")
        print(f"GBM  acc={gbm_acc:.4f}  logloss={gbm_ll:.4f}  brier={gbm_br:.4f}  | 价值下注ROI={gbm_roi*100:+.2f}% (n={gbm_nb},wr={gbm_w/gbm_nb*100:.1f}%)")

    # 选最优方案（按价值下注 ROI 优先，其次 logloss）——仅用于报告/研究对比
    best_scheme = max(results, key=lambda s: (results[s]["lr"][3], -results[s]["lr"][1]))
    print(f"\n[研究选优] 研究最优方案 = {best_scheme}（价值ROI={results[best_scheme]['lr'][3]*100:+.2f}%, logloss={results[best_scheme]['lr'][1]:.4f}）")

    # 【发布约束】前端 predict() 实时仅能供应 jc+eu+gap 共 9 特征；方案 C 的 b365 在
    # 实时/历史回测路径中均无数据源，若导出 C 会导致系数与特征错位（b365 系数成死权重）。
    # 故固定导出方案 B（9 特征），与线上特征构造严格对齐；研究最优方案仅作透明参考。
    export_scheme = 'B'
    print(f"[发布导出] 固定方案 {export_scheme}（9 特征，与前端 predict 对齐）")

    # 在全体上重训发布用 LR 并导出
    Xm = build_matrix(X, export_scheme)
    lr = LogisticRegression(max_iter=2000, C=1.0)
    lr.fit(Xm, y)
    coef = lr.coef_.tolist()      # shape (3, n_feat)
    intercept = lr.intercept_.tolist()
    feat_names = FEATURE_NAMES[export_scheme]
    out = {
        "model": "logistic_regression_multinomial",
        "scheme": export_scheme,
        "classes": ["h", "d", "a"],
        "features": feat_names,
        "coef": coef,
        "intercept": intercept,
        "base_dist": base.round(6).tolist(),
        "trained_on_n": n,
        "note": "p_c = softmax(intercept_c + sum_i coef_c[i]*feature_i)。feature=隐含概率(已归一到和=1)，无标准化。",
    }
    with open(os.path.join(os.path.dirname(__file__), "p8_model_lr.json"), "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False, indent=2)
    print(f"[导出] ml/p8_model_lr.json 已写（{len(feat_names)} 特征，3 类）")

    # 特征重要性（LR 系数 → 可解释；树模型用排列重要性，兼容 HistGBM）
    print("\n[LR 系数（可解释重要性，按 |coef| 取每类最大）]")
    for c in range(3):
        row = sorted(zip(feat_names, coef[c]), key=lambda t: -abs(t[1]))
        top = ", ".join(f"{nm}{v:+.2f}" for nm, v in row[:4])
        print(f"  类 {['h','d','a'][c]}: {top}")

    if HAVE_XGB:
        clf = xgb.XGBClassifier(n_estimators=300, max_depth=3, learning_rate=0.05,
                                objective="multi:softprob", num_class=3, verbosity=0)
        clf.fit(Xm, y)
        imp = clf.feature_importances_
        order = np.argsort(imp)[::-1]
        print("\n[XGBoost 特征重要性 top]")
        for i in order[:8]:
            print(f"  {feat_names[i]:>8}  {imp[i]:.3f}")
    else:
        from sklearn.inspection import permutation_importance
        clf = HistGradientBoostingClassifier(max_iter=300, max_depth=3, learning_rate=0.05, random_state=42)
        clf.fit(Xm, y)
        pi = permutation_importance(clf, Xm, y, n_repeats=5, random_state=42, scoring="accuracy")
        order = np.argsort(pi.importances_mean)[::-1]
        print("\n[HistGBM 排列重要性 top（XGBoost 未装 libomp，以此代理）]")
        for i in order[:8]:
            print(f"  {feat_names[i]:>8}  {pi.importances_mean[i]:.3f}")

    print("\n=== 结论速览 ===")
    print(f"市场隐含 logloss={market_ll:.4f}；发布方案B LR logloss={results['B']['lr'][1]:.4f}")
    print(f"无脑下热门 ROI={af_roi*100:+.2f}%；发布方案B 价值下注 ROI={results['B']['lr'][3]*100:+.2f}%")
    print(f"研究最优方案 {best_scheme} 价值下注 ROI={results[best_scheme]['lr'][3]*100:+.2f}%（含 b365，端上不可部署，仅参考）")
    print(f"若模型ROI 接近/低于 无脑热门 与 0，则印证市场有效、系统性edge不存在。")

if __name__ == "__main__":
    main()
