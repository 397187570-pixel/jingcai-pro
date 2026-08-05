# 竞彩智选 Pro — 静态部署指引（脱离 WorkBuddy 部署网关）

> 现状：WorkBuddy 的 Cloud Studio 部署网关（上传 API）出现 `fetch failed` 平台侧故障，
> 导致新代码无法推送到云端沙箱。但项目 `dist/` 目录是**纯静态前端**（index.html + css + config + js + engine json），
> 不依赖任何服务端，可直接托管到任意静态平台。下面给出两条**完全自主、不依赖 WorkBuddy 网关**的公网部署路径。

---

## 方案 A：GitHub Pages（最省事，免费，推荐）

1. 在 GitHub 新建一个仓库（建议私有仓库也支持 Pages）。
2. 把 `jingcai-pro/dist/` 目录下的**全部内容**推到仓库（可直接放根目录，或放在 `/docs`）。
3. 仓库 → Settings → Pages → Source 选择对应分支与目录（如 `main` / `root` 或 `/docs`）。
4. 等待 1~2 分钟，GitHub 会给出 `https://<用户名>.github.io/<仓库名>/` 访问地址。
5. 浏览器打开后**强制刷新**（Cmd+Shift+R / Ctrl+F5）清缓存。

> 注意：若 dist 放在子目录，应用内相对路径（如 `js/...`、`css/...`）仍正常，因为 index.html 用的是相对引用。

---

## 方案 B：Vercel（命令行，最快出公网 URL）

前提：本地已安装 Node（本机已有 22.x / 24.x）。

```bash
cd /Users/miaoliu/WorkBuddy/2026-08-02-12-17-13/jingcai-pro/dist
# 若未安装 vercel CLI
npm i -g vercel
# 部署（按提示登录，选择当前目录，框架选 Other，输出目录填 . ）
vercel --prod
```

部署完成后 Vercel 会直接给出 `https://<随机>.vercel.app` 公网地址。

---

## 方案 C：腾讯云 COS + CDN（你已有腾讯云生态，可走 SCF 代理）

1. 在腾讯云 COS 新建存储桶，开启「静态网站托管」。
2. 把 `dist/` 全部文件上传到桶根目录。
3. 绑定自定义域名 + CDN（可选），或直接用 COS 提供的 `*.cos-website.*.myqcloud.com` 地址。
4. 价值注检测的「代理地址」填你之前打包的 SCF 网关 URL（见 `jingcai-scf.zip`）；
   若不填代理且非 localhost，应用会自动启用直连模式（JC_DIRECT），直接请求竞彩官网。

---

## 验证清单

部署后打开页面，确认以下新功能已生效（区别于旧版）：

- [ ] 「AI 研判」页「今日推荐」卡片显示**校准置信度进度条**（如 主胜 51.6%）
- [ ] 点「扫描价值注」并填入 The Odds API Key 后，卡片出现**价值信号 💎**（欧盘 vs 竞彩偏差突破历史 p90 才标记）
- [ ] 卡片底部有**负 EV 风险横幅**（"竞彩固定抽水约 12.9%，长期数学期望为负"）
- [ ] 浏览器控制台无 404（确认 `js/engine/recommend.js`、`js/engine/eu_jc_gap.json` 加载成功）

若以上任一项缺失，说明仍跑的是旧缓存，强制刷新或换无痕窗口即可。

---

## 回滚 / 管理

- 已发布的 Cloud Studio 应用仍在线（旧代码），可在 WorkBuddy「设置 - 数据管理 - 我发布的应用」中删除。
- 等 WorkBuddy 部署网关恢复后，可直接用 `workbuddy_cloudstudio_deploy` 重新推送 `dist/`，无需走上述手动方案。
