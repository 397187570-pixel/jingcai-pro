# ⚽ 竞彩智选 Pro — 模块化重构版

> 由资深开发工程师主导的工程化改造示范
> 目标：从"上帝文件"到"可测试、可协作、可维护"

## 📁 目录结构

```
jingcai-pro/
├── index.html              # （目标：瘦身到 <100 行骨架）
├── config/
│   └── config.js           # ✅ 全局配置（魔法数字集中管理）
├── js/
│   ├── core/
│   │   └── utils.js        # ✅ 纯函数工具（esc/格式化/概率）
│   ├── engine/
│   │   └── predictor.js    # ✅ 预测引擎（Elo/泊松/价值注）
│   └── api/                # ⏳ 下一步：API 层拆分
├── css/                    # ⏳ 下一步：样式拆分
├── tests/
│   ├── utils.test.js       # ✅ 工具函数测试（10 个用例）
│   ├── predictor.test.js   # ✅ 预测引擎测试（12 个用例）
│   └── run-tests.js        # ✅ 测试运行器
├── .eslintrc.json          # ✅ ESLint 配置
├── .prettierrc.json        # ✅ Prettier 配置
└── package.json            # ✅ npm scripts（test/lint/format）
```

## 🚀 使用

```bash
# 运行全部测试
npm test
# 或
node tests/run-tests.js

# 代码检查
npm run lint
npm run lint:fix

# 格式化
npm run format

# 完整检查（lint + test）
npm run check
```

## ✅ 已完成的工程化改造

### 1. 模块拆分（低风险起步）
- `utils.js`：安全/数值/格式化/集合工具 — 纯函数，可测试
- `config.js`：所有阈值/配置集中管理
- `predictor.js`：Elo/泊松/融合预测/价值注 — 核心算法独立

### 2. XSS 加固
- 新增 `esc()` / `safeHtml()` 安全工具
- toast 消息、错误信息、比分玩法等 7 处高风险点已转义
- 内联 onclick 改为事件委托（goalsGrid）

### 3. 单元测试（22 个用例全部通过）
- 测试真实发现并修复 3 个 bug：
  - `expectedValue` 浮点精度误差
  - `toPct` 小数/百分比混淆
  - `eloPredict` 主场优势 100 过高（势均力敌主胜 64% 不合理）

### 4. 质量工具
- ESLint（未使用变量/严格相等/const 优先等）
- Prettier（统一格式）
- package.json scripts 标准化

## 🔜 下一步路线

- [ ] 主 HTML 引 JS 模块（开始瘦身 3500 行）
- [ ] API 层拆分（sporttery.js / oddsApi.js）
- [ ] 样式拆分（variables/layout/components）
- [ ] CI 集成（GitHub Actions 自动测试）
- [ ] 状态管理（单一数据流）

## 📐 规范依据

- `../CODE_STANDARDS.md` — 团队代码规范 v1.0
- `../TECH_DEBT_AUDIT.md` — 技术债审计报告
