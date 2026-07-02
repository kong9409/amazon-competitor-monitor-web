#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from schemas.report_schema import REQUIRED_TOP_LEVEL_KEYS, REQUIRED_META_KEYS, REQUIRED_SNAPSHOT_KEYS


def validate(path: str) -> list[str]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    errors = []
    for key in REQUIRED_TOP_LEVEL_KEYS:
        if key not in data:
            errors.append(f"missing top-level key: {key}")
    for key in REQUIRED_META_KEYS:
        if key not in data.get("meta", {}):
            errors.append(f"missing meta key: {key}")
    for i, item in enumerate(data.get("asin_snapshots", [])):
        for key in REQUIRED_SNAPSHOT_KEYS:
            if key not in item:
                errors.append(f"asin_snapshots[{i}] missing key: {key}")
    return errors


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    args = ap.parse_args()
    errors = validate(args.path)
    if errors:
        print("VALIDATION_FAILED")
        print("\n".join(errors))
        sys.exit(1)
    print("VALIDATION_OK")
