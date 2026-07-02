---
name: amazon-asin-competitor-monitoring
version: 1.0.0
description: 基于 Sorftime CLI 的亚马逊 ASIN 竞品监控 Skill，按固定 SOP 采集自有 ASIN、竞品 ASIN、核心关键词数据，生成可追溯的 HTML 竞品监控报告。
---

# Amazon ASIN Competitor Monitoring Skill

## 1. 触发条件

当用户提出以下需求时，启用本 Skill：

- 生成亚马逊竞品监控报告
- 监控自有 ASIN 和竞品 ASIN 的价格、BSR、评论、关键词、Listing 变化
- 对比自有 ASIN 与竞品 ASIN，输出运营建议
- 用 Sorftime CLI 采集亚马逊产品、关键词、评论、市场数据
- 生成 HTML 竞品监控日报、周报或复盘报告

## 2. 业务边界

第一版只做三件事：

1. 使用 Sorftime CLI 作为唯一数据口径。
2. 监控自有 ASIN 与竞品 ASIN 的变化。
3. 输出单文件 HTML 报告、report_data.json 和接口审计记录。

本 Skill 不做：

- 不直接调价。
- 不直接修改广告后台。
- 不替代 ERP 库存管理。
- 不做真实利润核算。
- 不在数据缺失时编造数值。

## 3. 核心原则

### 3.1 数据只走一个口径

第一版只使用 Sorftime CLI。不要混用 Keepa、H10、卖家精灵、广告后台等不同口径的数据，除非用户明确要求扩展并单独标注来源。

### 3.2 流程固定

每次执行都按以下顺序：

1. 读取监控配置。
2. dry-run 检查需要调用的接口。
3. 调用 Sorftime CLI 采集数据。
4. 保存原始响应和接口审计。
5. 构建快照。
6. 与历史快照做差异对比。
7. 构建 report_data.json。
8. 校验 report_data.json。
9. 渲染 HTML 报告。
10. 做 QA 检查并交付。

### 3.3 结果可追溯

报告里的重要结论必须能回查：

- 调用了哪个 Sorftime CLI 接口。
- 参数是什么。
- 原始响应保存在哪里。
- 是否命中缓存。
- 快照差异来自哪两个日期。

### 3.4 不编数据

任何价格、销量、BSR、评分、评论数、关键词排名、搜索量、Coupon、Buybox、Listing 文案，都必须来自采集结果或历史快照。缺失时写“未获取/暂无数据/接口未返回”，禁止补猜。

## 4. 输入配置

默认读取：`config/monitoring_config.json`

最小配置示例：

```json
{
  "marketplace": "US",
  "domain": 1,
  "own_asins": ["B0OWN001"],
  "competitor_asins": ["B0COMP01", "B0COMP02", "B0COMP03"],
  "core_keywords": ["power bank", "portable charger"],
  "monitor_window_days": [14, 30, 60, 90]
}
```

字段说明：

- `marketplace`：站点名称，例如 US、CA、UK、DE。
- `domain`：Sorftime CLI domain 参数。美国站通常为 1。
- `own_asins`：自有 ASIN。
- `competitor_asins`：竞品 ASIN。
- `core_keywords`：核心关键词。
- `monitor_window_days`：趋势窗口，默认 14/30/60/90 天。

## 5. 执行命令

### 5.1 初始化配置

```bash
cp .env.example .env
cp config/monitoring_config.example.json config/monitoring_config.json
```

把 Sorftime CLI 凭据放入 `.env`，不要写进 SKILL.md 或 Git 仓库。

### 5.2 运行完整报告

```bash
python scripts/run_monitoring.py --config config/monitoring_config.json
```

输出：

- `outputs/report_data.json`
- `outputs/amazon_competitor_monitoring_report.html`
- `outputs/request_audit.jsonl`
- `cache/raw/` 原始响应
- `cache/snapshots/` 每日快照

### 5.3 只做 dry-run 审计

```bash
python scripts/run_monitoring.py --config config/monitoring_config.json --dry-run
```

## 6. 报告结构

HTML 报告固定为四大部分：

1. **总览**
   - 今日总览
   - 变化概览
   - 处理建议

2. **监控对象**
   - ASIN 监控概览
   - ASIN 明细表
   - 自有 ASIN vs 竞品

3. **证据**
   - 趋势证据
   - 关键词表现
   - 评论 VOC
   - Listing 变更

4. **审计**
   - 数据口径
   - Sorftime CLI 接口审计
   - 原始响应索引

报告阅读顺序：先结论，再证据，再行动。

## 7. 分析规则

### 7.1 事件识别

- 价格下降：当前价格低于上一快照价格。
- 价格上升：当前价格高于上一快照价格。
- Coupon 新增：上一快照无 Coupon，当前有 Coupon。
- Coupon 取消：上一快照有 Coupon，当前无 Coupon。
- BSR 改善：当前 BSR 数值低于上一快照。
- BSR 变差：当前 BSR 数值高于上一快照。
- 评论增长：评论数增加。
- 评分下降：评分下降。
- 标题调整：标题文本发生变化。
- 核心词排名流失：自然排名下降超过阈值，默认 10 位。
- 核心词排名改善：自然排名提升超过阈值，默认 10 位。

### 7.2 运营判断

判断必须基于事实组合：

- 价格下降 + Coupon 新增 + BSR 改善：竞品可能主动冲量。
- 关键词覆盖增加 + BSR 改善：竞品流量获取增强。
- 评分下降 + 差评主题集中：存在质量或体验风险。
- 自有价格高于竞品且评论门槛低于竞品：转化压力较高。

### 7.3 建议输出

每条建议必须包含：

- 优先级：高/中/低。
- 对象：ASIN 或关键词。
- 事实依据：来自事件或当前数据。
- 建议动作：调价、上券、补广告词、优化 Listing、加入监控等。
- 复查时间：明日/3 天/7 天。

## 8. QA 检查清单

交付前必须检查：

- report_data.json 是否通过 schema 校验。
- HTML 是否能离线打开。
- 图表和表格是否正常渲染。
- 接口审计是否生成。
- 缺失数据是否明确标注。
- 报告里没有出现未授权的接口或未说明的数据来源。
- 不包含明文密钥。

## 9. 常见口令

用户可以这样调用：

- “帮我生成一份 ASIN 竞品监控报告。”
- “用 Sorftime CLI 跑一下今天的竞品监控。”
- “根据 config 里的 ASIN 生成 HTML 竞品日报。”
- “只 dry-run 看看会调用哪些接口。”
