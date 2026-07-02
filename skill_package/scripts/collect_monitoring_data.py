#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path
from datetime import datetime
from sorftime_client import SorftimeClient, ROOT, WORK_ROOT


def load_config(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def product_params(interface_name: str, asin: str) -> dict:
    if interface_name.lower() == "productrequest":
        return {"asin": asin, "trend": 2}
    return {"asin": asin}


def keyword_params(interface_name: str, asin: str, keyword: str, site: str) -> dict:
    name = interface_name.lower()
    if name == "asinkeywordranking":
        return {"keyword": keyword, "ASIN": asin}
    if name == "keywordrequest":
        return {"keyword": keyword}
    if name.startswith("asinrequestkeyword"):
        return {"asin": asin, "pageIndex": 1, "pageSize": 50}
    return {"asin": asin, "keyword": keyword, "site": site}


def review_params(interface_name: str, asin: str) -> dict:
    name = interface_name.lower()
    if name == "productreviewsquery":
        return {"asin": asin, "pageIndex": 1}
    if name == "productreviewscollectionstatusquery":
        return {"asin": asin, "update": 48}
    return {"asin": asin}


def collect(config: dict, dry_run: bool = False) -> dict:
    domain = config.get("domain", 1)
    client = SorftimeClient(domain=domain, dry_run=dry_run)
    interfaces = config.get("cli_interfaces", {})
    site = config.get("marketplace", "US")
    own = config.get("own_asins", [])
    comps = config.get("competitor_asins", [])
    keywords = config.get("core_keywords", [])

    results = {"asins": {}, "keywords": {}, "reviews": {}, "collected_at": datetime.now().isoformat(timespec="seconds")}

    asin_interface = interfaces.get("asin_detail", "ProductRequest")
    kw_interface = interfaces.get("keyword_rank", "ASINKeywordRanking")
    review_interface = interfaces.get("review", "ProductReviewsQuery")

    for asin in own + comps:
        results["asins"][asin] = client.call(asin_interface, product_params(asin_interface, asin))
        results["reviews"][asin] = client.call(review_interface, review_params(review_interface, asin))
        for kw in keywords:
            key = f"{asin}::{kw}"
            results["keywords"][key] = client.call(kw_interface, keyword_params(kw_interface, asin, kw, site))

    out = WORK_ROOT / "cache" / "latest_collection.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    return results


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "config" / "monitoring_config.json"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    print(json.dumps(collect(load_config(args.config), dry_run=args.dry_run), ensure_ascii=False, indent=2))
