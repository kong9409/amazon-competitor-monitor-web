#!/usr/bin/env python3
from __future__ import annotations
import argparse, zipfile
from pathlib import Path
from sorftime_client import WORK_ROOT


def bundle(out_zip: str) -> str:
    files = [WORK_ROOT / "outputs" / "amazon_competitor_monitoring_report.html", WORK_ROOT / "outputs" / "report_data.json", WORK_ROOT / "outputs" / "request_audit.jsonl"]
    out = Path(out_zip)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            if f.exists():
                z.write(f, f.relative_to(WORK_ROOT))
    return str(out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(WORK_ROOT / "outputs" / "offline_report_bundle.zip"))
    args = ap.parse_args()
    print(bundle(args.out))
