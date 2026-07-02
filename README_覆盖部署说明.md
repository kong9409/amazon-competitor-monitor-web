# Amazon 竞品监控报告工具优化版 by kong

本包用于覆盖/参考优化你的项目：

`C:\Users\EDY\Documents\竞品分析\amazon-competitor-monitor-web\amazon-competitor-monitor-web`

本次按你的要求做了 4 个修正：

1. 首页“核心关键词（每行一个）”默认词改成 `power bank` 方向。
2. 删除旧的内置品类词，不再出现旧关键词。
3. 修复 PDF 下载：后端生成真实 `.pdf` 文件，再通过 `/download/:reportId/:fileName` 下载，避免点击 PDF 链接空白、路径错误或浏览器直接显示异常。
4. HTML、PDF、Markdown、JSON、CSV、ZIP 全部写入：
   - 作者：`kong`
   - 框架来源说明：`复刻 Jax 丰哥在跨境写代码的 ASIN 竞品监控报告框架`
   - 参考链接：Jax 丰哥在跨境写代码原文链接

---

## 一、最简单覆盖方式

把本 ZIP 解压后，将文件复制到你的项目根目录：

```text
C:\Users\EDY\Documents\竞品分析\amazon-competitor-monitor-web\amazon-competitor-monitor-web
```

需要覆盖/新增的主要文件：

```text
package.json
server.js
public/index.html
public/style.css
public/app.js
Dockerfile
```

然后在项目根目录执行：

```bash
npm install
npm start
```

浏览器打开：

```text
http://localhost:3000
```

---

## 二、Zeabur 部署

如果你用 GitHub + Zeabur：

1. 把解压后的全部文件上传/覆盖到 GitHub 仓库。
2. Zeabur 选择该仓库。
3. 启动命令填：

```bash
npm start
```

如果 Zeabur 识别 Dockerfile，也可以直接走 Dockerfile。Dockerfile 会安装中文字体，PDF 中文显示更稳定。

---

## 三、PDF 下载修复点

原先常见问题一般是：

- 前端直接跳转到本地路径，例如 `D:\...`，线上打不开；
- PDF 没有真正生成，只是返回 HTML 或空文件；
- 中文字体缺失，PDF 打开乱码；
- 下载链接没有经过静态服务或下载接口。

新版修复逻辑：

```text
POST /api/generate
  → 生成 HTML / MD / JSON / CSV / PDF / ZIP
  → 写入 reports/{reportId}/
  → 返回 /download/{reportId}/{fileName}

GET /download/:reportId/:fileName
  → 后端校验文件存在
  → PDF 设置 application/pdf
  → 其他文件走 res.download
```

---

## 四、保留你原来的 Sorftime 真实采集逻辑

本包的 `server.js` 重点修复“输入默认值、导出文件、作者和来源说明、PDF 下载”。

如果你原项目已经有 Sorftime CLI/API 真实采集函数，不要丢掉。你可以把你原来的采集逻辑接到：

```js
buildReportData(input, reportId)
```

也就是把当前里面的 `待采集` 字段替换成你的真实字段，例如：

- price
- bsr
- estimatedSales
- rating
- reviews
- sellerCount
- coupon
- keywordRank
- asinTrafficWords
- interfaceAudit

---

## 五、关键词默认值

默认核心关键词现在是：

```text
power bank
portable charger
power bank with built in cable
fast charging power bank
travel power bank
usb c power bank
10000mah portable charger
20000mah power bank
```

---

## 六、作者与来源写入位置

| 文件类型 | 写入位置 |
|---|---|
| HTML | 页面顶部、页脚、水印 |
| PDF | 首页元信息、页脚 |
| Markdown | 文件开头 |
| JSON | `meta` 字段 |
| ASIN CSV | 每一行的 `author/framework_attribution/reference_link` 字段 |
| 关键词 CSV | 每一行的 `author/framework_attribution/reference_link` 字段 |
| ZIP | 内置 `README_作者与来源说明.txt` |

---

## 七、推荐环境变量

可选：自定义报告保存目录。

```bash
REPORT_OUTPUT_DIR=/app/reports
```

Windows 本地不设置时，默认保存到：

```text
D:\amazon-competitor-monitor-reports
```

Linux/Zeabur 不设置时，默认保存到项目内：

```text
./reports
```
