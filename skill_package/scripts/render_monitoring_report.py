#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path
from sorftime_client import ROOT, WORK_ROOT


def render(data_path: str, out_path: str) -> str:
    data = json.loads(Path(data_path).read_text(encoding="utf-8"))
    template = (ROOT / "templates" / "monitoring_report.html").read_text(encoding="utf-8")
    css = (ROOT / "assets" / "tailwind.static.css").read_text(encoding="utf-8")
    js = (ROOT / "assets" / "report-runtime.js").read_text(encoding="utf-8")
    title = f"{data.get('meta',{}).get('marketplace','US')}站 ASIN 竞品监控报告"
    html = template
    replacements = {
        "{{REPORT_TITLE}}": title,
        "{{MARKETPLACE}}": data.get("meta", {}).get("marketplace", "US"),
        "{{REPORT_DATE}}": data.get("meta", {}).get("report_date", ""),
        "{{ASIN_COUNT}}": str(data.get("summary", {}).get("asin_count", 0)),
        "{{COMPETITOR_COUNT}}": str(data.get("summary", {}).get("competitor_count", 0)),
        "{{EVENT_COUNT}}": str(data.get("summary", {}).get("event_count", 0)),
        "{{RISK_COUNT}}": str(data.get("summary", {}).get("risk_count", 0)),
        "{{ACTION_COUNT}}": str(data.get("summary", {}).get("action_count", 0)),
        "{{REPORT_DATA_JSON}}": json.dumps(data, ensure_ascii=False).replace("</script>", "<\\/script>"),
        "{{CSS}}": css,
        "{{JS}}": js,
    }
    for k, v in replacements.items():
        html = html.replace(k, v)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return str(out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(WORK_ROOT / "outputs" / "report_data.json"))
    ap.add_argument("--out", default=str(WORK_ROOT / "outputs" / "amazon_competitor_monitoring_report.html"))
    args = ap.parse_args()
    print(render(args.data, args.out))
