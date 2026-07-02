# 示例：生成美国站竞品监控报告

1. 修改配置：

```json
{
  "marketplace": "US",
  "domain": 1,
  "own_asins": ["B0CVM8TXHP"],
  "competitor_asins": ["B0EXAMPLE1", "B0EXAMPLE2"],
  "core_keywords": ["dog crate furniture", "large dog crate"]
}
```

2. 运行：

```bash
python scripts/run_monitoring.py --config config/monitoring_config.json
```

3. 打开：

```text
outputs/amazon_competitor_monitoring_report.html
```
