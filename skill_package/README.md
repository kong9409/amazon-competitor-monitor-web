# Amazon ASIN Competitor Monitoring Skill

这是一个基于 Sorftime CLI 的亚马逊竞品监控 Skill，结构按“业务 SOP + 数据接口 + 分析口径 + HTML 模板 + 校验审计”设计。

## 目录结构

```text
amazon-asin-competitor-monitoring/
├── agents/openai.yaml
├── assets/
│   ├── echarts.min.js
│   ├── lucide.min.js
│   ├── report-runtime.js
│   └── tailwind.static.css
├── cache/
├── config/
│   └── monitoring_config.example.json
├── references/
│   ├── monitoring-direction.md
│   ├── report-contract.md
│   └── sorftime-cli-interface-map.md
├── schemas/report_schema.py
├── scripts/
│   ├── build_monitoring_report_data.py
│   ├── bundle_offline_report.py
│   ├── collect_monitoring_data.py
│   ├── render_monitoring_report.py
│   ├── run_monitoring.py
│   ├── sorftime_client.py
│   └── validate_monitoring_report_data.py
├── templates/monitoring_report.html
├── SKILL.md
└── .env.example
```

## 快速开始

```bash
cp .env.example .env
cp config/monitoring_config.example.json config/monitoring_config.json
```

在 `.env` 填入你的 Sorftime CLI Token：

```env
SORFTIME_CLI_TOKEN=你的token
SORFTIME_BIN=sorftime
SORFTIME_DOMAIN=1
```

编辑 `config/monitoring_config.json`，填入自有 ASIN、竞品 ASIN、核心关键词。

运行：

```bash
python scripts/run_monitoring.py --config config/monitoring_config.json
```

Dry-run：

```bash
python scripts/run_monitoring.py --config config/monitoring_config.json --dry-run
```

## Windows 提示

如果 PowerShell 提示 `.ps1` 禁止执行，可以直接设置：

```env
SORFTIME_BIN=sorftime.cmd
```

脚本内部用 `subprocess.run([...], shell=False)` 调用 CLI，可以规避大部分 JSON 引号问题。

## 输出

- `outputs/amazon_competitor_monitoring_report.html`
- `outputs/report_data.json`
- `outputs/request_audit.jsonl`
- `cache/raw/` 原始接口响应
- `cache/snapshots/` 每日快照

## 安全说明

不要把 `.env` 上传到 GitHub。报告和审计里不会记录 token。
