# 🚀 GitHub 接入指南 — 触发 CI 自动测试

> 目标：推送代码到 GitHub → 自动跑 45 个测试 + ESLint + Vite 构建

## ✅ 已就绪（无需操作）

```
.github/workflows/ci.yml   # CI 工作流（Node 18/20 + lint + test + build）
package.json               # scripts（test/lint/build）
.eslintrc.json             # ESLint 配置
.gitignore                 # 忽略 node_modules/dist 等
README.md                  # 项目说明
git 仓库                    # 已初始化 + 4 次规范提交
```

## 📋 接入步骤（约 2 分钟）

### 第 1 步：GitHub 新建仓库

1. 打开 https://github.com/new
2. Repository name: `jingcai-pro`
3. 设为 **Private**（私有，含投注数据逻辑）
4. 不要勾选 "Add README"（本地已有）
5. 点 **Create repository**

### 第 2 步：关联本地仓库并推送

复制 GitHub 给的命令（或直接用下面这份，替换 `<你的用户名>`）：

```bash
cd /Users/miaoliu/WorkBuddy/2026-08-02-12-17-13/jingcai-pro

# 关联远端
git remote add origin https://github.com/<你的用户名>/jingcai-pro.git

# 推送到 main 分支
git push -u origin main
```

### 第 3 步：验证 CI 自动运行

1. 打开仓库页面 → **Actions** 标签
2. 应看到 `CI` 工作流在运行
3. 等待约 1 分钟 → 绿色 ✅ = 全部通过

---

## 🔍 CI 检查什么

| 检查项 | 命令 | 失败条件 |
|--------|------|---------|
| **Lint** | `eslint js/ config/` | 代码风格/未使用变量/语法错误 |
| **单元测试** | `npm test` | 45 个测试任一失败 |
| **构建** | `npm run build` | Vite 打包失败 |

Node 18 和 20 两个版本都会跑（矩阵测试）。

---

## 🔄 日常开发流程（Git 规范）

```bash
# 1. 从 main 切功能分支
git checkout -b feature/xxx

# 2. 开发 + 本地测试
npm run check        # lint + 45 测试

# 3. 提交（规范信息）
git add .
git commit -m "feat: 新增 XXX 功能"

# 4. 推送（触发 CI）
git push origin feature/xxx

# 5. 合并到 main（PR 方式或直接）
git checkout main
git merge feature/xxx
git push origin main
```

---

## ⚠️ 注意事项

1. **CI 在 GitHub 云服务器运行** — 需要 `package.json` 里的依赖能装（vite/eslint/prettier 都是公开包，没问题）
2. **测试不依赖网络** — 单元测试全部用 mock，CI 不会因为竞彩 API 不可用而失败
3. **首次 push 可能慢** — GitHub 需要安装依赖，约 1-2 分钟
4. **私有仓库免费** — GitHub 私有仓库不限制 CI 时长

---

## ❓ 常见问题

### Q: git push 提示认证失败？
需要配置 GitHub 认证（二选一）：
- **HTTPS**：`git config --global credential.helper store`，push 时输入用户名 + Personal Access Token
- **SSH**（推荐）：生成 SSH key 后 `git remote set-url origin git@github.com:<用户名>/jingcai-pro.git`

### Q: CI 显示红色 ❌？
打开 Actions 日志看哪步失败：
- Lint 失败 → 本地跑 `npm run lint:fix` 修复
- 测试失败 → 本地跑 `npm test` 定位
- Build 失败 → 本地跑 `npm run build` 复现

### Q: 如何关闭 CI？
删除 `.github/workflows/ci.yml` 或推一个空提交。

---

*GitHub 接入文档 · 竞彩智选 Pro v2.0*
