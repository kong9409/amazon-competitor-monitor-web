#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, subprocess, sys
from pathlib import Path
from sorftime_client import ROOT, WORK_ROOT


def run(cmd):
    print("$", " ".join(cmd))
    subprocess.check_call(cmd, cwd=str(ROOT))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "config" / "monitoring_config.json"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    outputs = WORK_ROOT / "outputs"
    outputs.mkdir(parents=True, exist_ok=True)
    audit = outputs / "request_audit.jsonl"
    if audit.exists(): audit.unlink()
    collect_cmd = [sys.executable, "scripts/collect_monitoring_data.py", "--config", args.config]
    if args.dry_run: collect_cmd.append("--dry-run")
    run(collect_cmd)
    run([sys.executable, "scripts/build_monitoring_report_data.py", "--config", args.config, "--collection", str(WORK_ROOT / "cache" / "latest_collection.json")])
    run([sys.executable, "scripts/validate_monitoring_report_data.py", str(outputs / "report_data.json")])
    run([sys.executable, "scripts/render_monitoring_report.py", "--data", str(outputs / "report_data.json"), "--out", str(outputs / "amazon_competitor_monitoring_report.html")])
    print("\nDONE")
    print("HTML:", outputs / "amazon_competitor_monitoring_report.html")
    print("DATA:", outputs / "report_data.json")
    print("AUDIT:", outputs / "request_audit.jsonl")

if __name__ == "__main__":
    main()
