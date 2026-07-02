# Amazon 竞品监控在线工具

这是一个可部署到 Zeabur / Render / Railway / 自有服务器的在线网站工具。

## 功能

- 网页输入：Sorftime CLI Token、自有 ASIN、竞品 ASIN、核心关键词
- 服务端调用：`sorftime api ProductRequest / AsinSalesVolume / ASINRequestKeywordv2 / ASINKeywordRanking / KeywordExtends / ProductReviewsQuery`
- 输出：HTML 看板、Markdown、JSON、CSV、全部 ZIP；PDF 可在浏览器里打印保存
- 报告模块按 `asin-monitor-2026-06-14.html` 对齐：今日总览、变化概览、处理建议、ASIN 监控概览、ASIN 明细表、自有 vs 竞品、趋势证据、关键词表现、评论 VOC、数据口径、接口审计
- 页面输入精简为：Sorftime CLI Token、自有 ASIN、竞品 ASIN、核心关键词；站点和接口名使用默认配置
- 接口审计：每次 CLI 调用都会记录开始时间、结束时间、耗时、消耗次数、剩余次数、请求总数、状态和错误摘要
- 字段口径：价格会把 `54999` 这类最小货币单位换算为 `549.99`；评分只接受 0-5 分并保留 1 位小数；评论数优先读取 review/rating count 字段
- Token 安全：Token 不写入报告，不保存到前端文件；会以 Sorftime profile 形式保存在 `AMAZON_MONITOR_DATA_DIR/.sorftime/config.json`

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

Sorftime CLI 的 profile 也会跟随写到数据目录下：

```text
D:\amazon-competitor-monitor-web-data\.sorftime\config.json
```

Zeabur / Linux 默认把临时运行报告写到：

```text
/tmp/amazon-competitor-monitor-web-data/reports
```

如需换位置，可设置环境变量：

```env
AMAZON_MONITOR_DATA_DIR=D:\amazon-competitor-monitor-web-data
```

## GitHub 上传注意

不要上传 `node_modules/`、`reports/`、日志文件、`skill_package/cache/`、`skill_package/outputs/`。这些都是可再生成文件，已写入 `.gitignore`。

上传源码时只需要保留 `package.json`、`package-lock.json`、`server.js`、`public/`、`skill_package/`、`README.md`、`.env.example` 等项目文件。部署到 Zeabur 后平台会自动执行 `npm install` 生成依赖。

如果目录里还看到 `__github_package_tmp...` 这类临时上传目录，不要选它上传；它只是中间文件。

## Zeabur 部署

1. 新建 GitHub 仓库
2. 上传本文件夹全部内容
3. Zeabur 选择该 GitHub 仓库
4. Build Command 使用默认；项目已提供 `nixpacks.toml`
5. Start Command 使用默认，或手动填：

```bash
npm start
```

6. 环境变量建议设置：

```env
SORFTIME_CLI_TOKEN=你的token
AMAZON_MONITOR_DATA_DIR=/tmp/amazon-competitor-monitor-web-data
```

7. 部署完成后打开 Zeabur 提供的域名

## Sorftime CLI 说明

默认依赖里已写入：

```json
"sorftime-cli": "1.0.0"
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

为了提高 Zeabur 部署成功率，线上包默认不安装 Puppeteer / Chromium。请打开 HTML 看板，用浏览器 `Ctrl + P` 另存为 PDF。

### 2. CLI 调用失败

先在 Zeabur 日志里看错误。常见原因：

- Token 错误或过期
- Sorftime CLI 没安装成功
- Sorftime 服务连接异常，例如 `read ECONNRESET`
- 接口名和你当前 Sorftime CLI 版本不一致
- ASIN / 站点参数不符合接口要求

本工具会自动用网页或环境变量里的 Token 创建临时 profile，并在调用时带 `--profile`，不需要手动执行 `sorftime add` / `sorftime use`。

页面已内置默认接口名，正常只需要输入 Token、自有 ASIN、竞品 ASIN 和关键词。

### 3. 消耗次数或剩余次数为空

报告会从 Sorftime 返回体里读取 `requestConsumed`、`requestLeft`、`requestCount` 等字段。若接口本身没有返回这些字段，对应列会显示 `-`，但仍会保留每次调用的开始时间、结束时间和耗时。

### 4. 不想真的调用接口，只想看页面

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
