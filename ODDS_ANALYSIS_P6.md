# P6 监控预警 · 落地说明

> 竞彩智选 Pro · 数据分析系统
> 对应需求：国内外赔率异动时**第一时间触发提醒**；且提醒必须能**辅助下单**（用户硬约束）。

## 一、交付内容

### 1. 核心引擎 `js/engine/oddsAlert.js`
- **阈值**：默认取 `CONFIG.thresholds.alertMove`（0.05 = 相邻快照隐含概率变化 ≥ 5 个百分点即判定异动）。
- **三个检测入口**：
  - `detectMovements(series, opts)` —— 单场：扫描全部快照的逐边异动，输出 `movements` + `advice`。
  - `detectFromOdds(prev, cur, opts)` —— 轮询点：直接用前后两次赔率判定异动，**零额外 IO**（用于全局 toast 弹窗）。
  - `scanAll(seriesMap, opts)` —— 全市场：扫描所有比赛最近 `windowMs`（默认 10 分钟）内的异动，聚合到提醒中心。
- **交叉验证 + 建议（advice 第一公民）**：
  - 资金流入（赔率被压低）且 P4 机构确认 / P3 有价值 → **顺势关注（follow）**
  - 资金流入但 P3 背离（竞彩推/国际撤） → **反手/回避（fade）**
  - 资金流入仅竞彩端单涨（机构没动） → **警惕诱盘（caution）**
  - 资金流出（赔率上升） → **谨慎/反手（fade）**
- **提醒通道**：
  - `showToast(o)` —— 站内 toast，复用 app.js 的 `#toastContainer`，第一时间弹出（含比赛、方向、流入/流出、幅度、动作徽章，9 秒自动消失）。
  - `notifyEmail(alert)` + `setEmailHook(fn)` —— 邮件接口**预留**：默认仅 `console.info` 不发送；真实接入时挂一个函数即可（如 fetch 到后端/邮件服务）。
  - `logAlert / getLog / clearLog` —— localStorage 本地日志（提醒历史，上限 100 条）。

### 2. 存储层增强 `js/engine/oddsHistory.js`
- 新增 `getAllSeries()`：按 `matchId` 分组返回所有比赛序列（IndexedDB / 内存双后端），供提醒中心扫描。

### 3. 界面集成
- `index.html`：新增 `#oddsAlertCard`（当前场异动卡片，紧跟热度面板）+ `#oddsAlertCenter`（全市场提醒中心，在规律面板后）+ `oddsAlert.js` 脚本（在 `oddsHeat.js` 后）。
- `oddsMonitor.js`：在序列渲染块内调用 `detectMovements` 渲染当前场卡片（复用 P3 趋势 / P4 热度交叉验证）；新增 `renderAlertCenter()` 扫描全市场异动。
- `app.js` `recordOddsTick`：每次轮询记录后，比对本次与上次赔率（`detectFromOdds`），异动则 `showToast` 第一时间提醒；带 `AppState._prevMove` 的 **false→true 跃迁去重**，避免每条轮询刷屏。
- `css/components.css`：新增 `.alert-toast / .alert-item / .alert-tag / .alert-empty` 等样式。

## 二、验证（Node 7 场景全过）
1. 主胜 2.00→1.60（隐含 +5.6pp，资金流入）→ 正确检测为异动。
2. 轮询点 `detectFromOdds` 前后赔率直接判定 → 返回主胜流入 5.6pp。
3. 未达阈值（2.00→1.90）→ 正确**不触发**。
4. `scanAll` 全市场 → 仅异动场（M1）被列出，M2 无变化排除。
5. 与 P3/P4 交叉验证（机构买入主胜）→ 正确升级为 **follow（置信 0.6）**。
6. `renderAlertCard` / `renderAlerts`（含空态）→ DOM 渲染不抛错。
7. `notifyEmail` 默认返回 `false`（预留未启用）。

## 三、现实约束与说明
- 异动判定基于**隐含概率变化 ≥ 5pp**，因记录层有去重（赔率不变不落库），所以相邻快照的差异都是真实变动，误报低。
- 国内竞彩赔率为免费连续记录（每 60s），因此国内异动监控**零成本常开**；国际赔率仍按 P2 设计默认关（The Odds API 免费 500/月，opt-in + 15min 节流）。
- 提醒仅作辅助，竞彩固定抽水约 12.9%；市场有效（P5 已证），异动信号需结合 P3/P4 交叉验证再下单。

## 四、下一步
- **P7 展示层**：走势图 / 偏差热力 / 热度仪表 / 提醒中心的可视化升级（可接 Ardot 设计稿，适配器恢复后做）。
- **P8 ML 建模升级**：逻辑回归 / XGBoost 替换规则统计，验证是否真能提升方向准确率。
