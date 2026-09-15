# 国内外赔率分析系统 · P1+P2 落地说明

> 承前：用户主诉求 = 结合国内赛前赔率 + 国外机构赔率，以赛果验证，挖掘高权重规律特征；
> 重点分析国内外**偏差 / 背离 / 收敛**；监控**市场热度**；国内外赔率**异动第一时间提醒**。
> 诊断结论：原系统**完全没有市场热度监控**（`oddsMonitor.js` 用硬编码示例、无时序；`config.alertMove` 仅配置无实现；`app.js` 无赔率轮询）。

## 本次交付

### P1 — 时序存储层 `js/engine/oddsHistory.js`（新建）
赔率快照库，是后续所有分析 / 热度 / 提醒 / 展示的地基。

- **双后端**：浏览器用 IndexedDB（持久、可存数万条），Node 用内存 Map 兜底（单测 / 回测）。
- **快照结构**：`{ matchId, ts, jc:{h,d,a}|null, intl:[{book,h,d,a}], meta, implied:{jc,intlAvg,sharp} }`，写入时预计算去水隐含概率（默认 sharp = Pinnacle）。
- **去重**：与最新快照赔率实质相同则不落库，避免轮询刷出海量重复。
- **API**：`init / record / recordMatch / getSeries / getLatest / getLatestMany / summary / prune / clear / count / exportJSON / importJSON` + 纯函数 `impliedFromOdds / avgOdds / diffOdds`。
- **验证**：Node 冒烟测试通过（去重生效、隐含概率正确、`summary()` 正确输出首→最新变化）。

### P2 — 采集轮询接入 `app.js`（已完成）
把"每一时刻的国内外赔率"持续写入存储层。

- 新增 `recordOddsTick()` + `initOddsRecording()`；`index.html` 在 `multiDim.js` 后引入 `oddsHistory.js`。
- **国内（竞彩）**：每次 `loadMatches` + 每 60s 轮询都记录，**零外部请求、免费连续运行**。
- **国际**：需 `THE_ODDS_API_KEY`，免费配额仅 **500/月** → **默认关闭（opt-in `recordIntl`），开启后节流 15min/次** 保命配额；经 `OddsApi.getOdds` + `matchByTime` 归一为「国际均值」单条快照。

## 当前能力边界（重要）
- `OddsApi.getOdds` 返回的是**各家平均**赔率（`normalizeOdds` 已聚合），当前 `intl` 仅「国际均值」一条。
  逐家细分（Pinnacle / Bet365 背离）需后续改 `oddsApi` 暴露逐家原始赔率或直连 Pinnacle feed（P2+ 增强）。
- 历史三件套（国内+国外+赛果）仅 `ml/data/eu_odds_history.json` 的 **1157 场**（25/26 欧洲赛季为主），
  是 P3 偏差/背离/收敛 与 P5 权重规律挖掘做回测的**黄金训练集**（football-data.co.uk 免费 CSV 可继续扩充）。

## 下一步（P3-P8，已建任务 #105-#111）
- P3 偏差·背离·收敛时序分析 → P4 市场热度指标 → P5 权重规律挖掘 → P6 监控预警 → P7 展示层 → P8 ML 建模升级。
- 提醒机制可立即在 P6 复用 `config.alertMove:0.05`：对比连续快照，超阈值触发站内 toast + 预留邮件接口。
