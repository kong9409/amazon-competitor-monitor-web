# Amazon 竞品监控在线工具

这是一个可部署到 Zeabur / Render / Railway / 自有服务器的在线网站工具。

## 功能

- 网页输入：Sorftime CLI Token、自有 ASIN、竞品 ASIN、核心关键词
- 服务端调用：`sorftime api ProductRequest / ASINKeywordRanking / ProductReviewsQuery`
- 输出：HTML 看板、PDF、Markdown、JSON、CSV、全部 ZIP
- 报告模块：今日总览、变化概览、处理建议、ASIN 明细、趋势图表、关键词表现、评论 VOC、接口审计
- Token 安全：Token 不写入报告，不保存到前端文件；只在本次服务端进程调用 CLI 时使用

## 本地运行

```bash
npm install
npm start
```

打开：

```text
http://localhost:3000
```

Windows 本地默认把运行报告写到：

```text
D:\amazon-competitor-monitor-web-data\reports
```

如需换位置，可设置环境变量：

```env
AMAZON_MONITOR_DATA_DIR=D:\amazon-competitor-monitor-web-data
```

## GitHub 上传注意

不要上传 `node_modules/`、`reports/`、日志文件、`skill_package/cache/`、`skill_package/outputs/`。这些都是可再生成文件，已写入 `.gitignore`。

上传源码时只需要保留 `package.json`、`package-lock.json`、`server.js`、`public/`、`skill_package/`、`README.md`、`.env.example` 等项目文件。部署到 Zeabur 后平台会自动执行 `npm install` 生成依赖。

## Zeabur 部署

1. 新建 GitHub 仓库
2. 上传本文件夹全部内容
3. Zeabur 选择该 GitHub 仓库
4. Build Command 使用默认 `npm install`
5. Start Command 填：

```bash
npm start
```

6. 部署完成后打开 Zeabur 提供的域名

## Sorftime CLI 说明

默认依赖里已写入：

```json
"sorftime-cli": "latest"
```

如果部署时 npm 包名变化，或者你的环境已经手动安装了 Sorftime CLI，可以在环境变量里指定：

```env
SORFTIME_BIN=sorftime
```

网页里可以临时输入 Token；也可以在环境变量里放：

```env
SORFTIME_CLI_TOKEN=你的token
```

## 常见问题

### 1. PDF 生成失败

PDF 使用 Puppeteer 生成。如果云平台禁用 Chromium 沙箱，代码已加：

```js
--no-sandbox
--disable-setuid-sandbox
```

若仍失败，可打开 HTML 看板，用浏览器 `Ctrl + P` 另存为 PDF。

### 2. CLI 调用失败

先在 Zeabur 日志里看错误。常见原因：

- Token 错误或过期
- Sorftime CLI 没安装成功
- 接口名和你当前 Sorftime CLI 版本不一致
- ASIN / 站点参数不符合接口要求

网页里有“高级设置：CLI 接口名”，可改为你实际可用的接口名。

### 3. 不想真的调用接口，只想看页面

勾选“演示模式”，不用 Token 即可生成 Demo 报告。

## 文件结构

```text
amazon-competitor-monitor-web/
├── public/                  # 前端页面
├── server.js                # Express 后端 + Sorftime CLI 调用 + 导出
├── package.json             # Node 依赖和启动命令
├── reports/                 # 运行生成的报告，不建议提交到 GitHub；Windows 默认改写到 D 盘数据目录
├── skill_package/           # 离线 Skill 版本，可单独使用
├── .env.example             # 环境变量示例
└── README.md
```
