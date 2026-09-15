# 国内外赔率分析系统 · P3 落地说明（偏差 / 背离 / 收敛 + 下单建议）

> 竞彩智选 Pro · 数据分析系统
> 本文件随 `js/engine/oddsTrend.js` 一同交付，说明 P3 的设计与用法。

## 用户硬约束（贯穿 P3→P8）
**所有分析结果必须能辅助「购买意向 / 建议」——只有分析数字、没有可下单建议 = 无意义。**
因此本模块把 `advice` 作为 `analyze()` 返回的第一公民：每个分析维度都直接回答
「买哪边 / 为什么 / 置信度多高」，而不只是吐出偏差数值。

## 新增文件
- `js/engine/oddsTrend.js` —— 偏差/背离/收敛分析 + 下单建议（浏览器/Node 同构，无外部依赖）

## 输入
`OddsHistory.getSeries(matchId)` 返回的快照序列（按时间升序），每条结构见 `oddsHistory.js`：
```
{ ts, jc:{h,d,a}, intl:[{book,h,d,a}], implied:{ jc, intlAvg, sharp } }
```

## 三类规律定义
| 类型 | 含义 | 投注语义 |
|------|------|----------|
| 偏差 Deviation | 竞彩隐含 − 国际隐含 | 负 = 竞彩比国际便宜 → 该方向有「价值边际」 |
| 背离 Divergence | 一段时间内竞彩与国际**反向移动** | 机构买/竞彩撤 → 价值强化；竞彩推/国际撤 → 诱盘预警 |
| 收敛 Convergence | \|偏差\| 随时间缩小 / 翻向 | 市场趋于共识；翻向 = 方向反转（最强信号） |

## 输出（核心：`advice`）
```js
analyze(series, { refKey:'intlAvg'|'sharp', valueThreshold:0.03, minPoints:2 })
→ {
    deviation, latestImplied, trend, signals,
    advice: {
      hasValue, bestSide, bestSideZh, action,   // action: 'buy' | 'watch' | 'avoid'
      confidence,                               // 0~1
      headline,                                 // 一句话结论
      reasons: [...],                           // 依据（偏差/背离/收敛逐项）
      perSide: [ {side, zh, devPts, action, conf, convergence, divergence} ]
    }
  }
```

## 置信度怎么算（诚实、保守）
- 基础分 = `价值分 / 0.09`（价值分 = 偏差幅度 + 趋势加成，封顶 0.15）
- 样本因子 = `clamp((有效快照数−2)/6, 0.5, 1)`（样本越少越保守，封底 0.5）
- 置信度 = 基础分 × 样本因子
- 实测：9pt 价值 + 背离 → 50%；2.6pt 价值 → 31%；样本不足 → 不输出建议

## 前端集成
- `index.html`：赔率监测页标题下新增 `#oddsTrendAdvice` 容器；`oddsTrend.js` 在 `oddsMonitor.js` 之前加载。
- `oddsMonitor.js`：渲染末尾按 `match.code` 拉取时序，有 ≥2 条即渲染分析+建议卡片；
  无数据优雅提示「暂无数时序数据」，绝不破坏现有静态赔率表。

## 验证（Node 冒烟测试，3 场景全过）
1. **主胜价值 + 背离**：竞彩主胜隐含 39%、国际 48% → 偏差 −9pt，国际持续买入、竞彩滞后 → `action=buy, conf=0.50`。
2. **诱盘**：竞彩推升主胜、国际撤出主胜 → 主胜标记「回避」并给出诱盘预警，同时客胜因机构买入被识别为价值。
3. **空序列**：`insufficient=true`，提示样本不足。

## 与既有推荐引擎的关系
- `recommend.js`（`Recommend.recommend`）：**时点**静态方向 + 校准置信度 + 价值信号（点状）。
- `oddsTrend.js`（`OddsTrend.analyze`）：**时序**动态 —— 国内外赔率随时间的偏差/背离/收敛，并产出可下单建议。
- 二者互补：P5 会把本模块的时序特征与方向概率、市场热度一起做权重规律挖掘。

## 下一步
- P4 市场热度指数（国内无成交量 → 语义化热度）
- P5 权重规律挖掘（1157 场回测）
- P6 监控预警（异动 → 站内 toast + 邮件接口）
