#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, re
from pathlib import Path
from datetime import date, datetime
from typing import Any, Dict, List, Optional
from sorftime_client import ROOT, WORK_ROOT


def deep_get(obj: Any, keys: List[str], default=None):
    cur = obj
    for key in keys:
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
        else:
            return default
    return cur


def first_value(data: dict, paths: List[List[str]], default=None):
    for p in paths:
        val = deep_get(data, p, None)
        if val not in (None, "", []):
            return val
    return default


def key_name(value: str) -> str:
    return re.sub(r"[\s_-]+", "", str(value or "").lower())


def unwrap_data(raw: Any) -> Any:
    if isinstance(raw, dict):
        return raw.get("data", raw.get("Data", raw))
    return raw


def is_filled(value: Any) -> bool:
    return value not in (None, "", [])


def find_any(obj: Any, names: List[str], scalar_only: bool = True, fuzzy: bool = False):
    wanted = [key_name(x) for x in names]
    for want in wanted:
        stack = [obj]
        seen = set()
        while stack:
            cur = stack.pop(0)
            if not isinstance(cur, (dict, list)) or id(cur) in seen:
                continue
            seen.add(id(cur))
            if isinstance(cur, list):
                stack.extend(cur)
                continue
            for key, val in cur.items():
                nk = key_name(key)
                if (nk == want or (fuzzy and want in nk)) and is_filled(val) and (not scalar_only or not isinstance(val, (dict, list))):
                    return val
            stack.extend(v for v in cur.values() if isinstance(v, (dict, list)))
    return None


def field_value(obj: Any, names: List[str]):
    return find_any(obj, names) or find_any(obj, names, fuzzy=True)


def first_product(raw: dict, asin: str) -> dict:
    data = unwrap_data(raw)
    if isinstance(data, list):
        for item in data:
            if str(field_value(item, ["asin", "Asin"]) or "").upper() == asin.upper():
                return item
        return data[0] if data else {}
    return data if isinstance(data, dict) else {}


def to_number(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    text = str(value).replace(",", "")
    m = re.search(r"-?\d+(\.\d+)?", text)
    return float(m.group(0)) if m else None


def stringify_short(value: Any) -> str:
    if not is_filled(value):
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)[:120]
    return str(value)[:120]


def first_photo(product: dict):
    image = field_value(product, ["image", "mainImage", "imageUrl", "imgUrl"])
    if image:
        return image
    photo = find_any(product, ["photo", "Photo", "images", "Images"], scalar_only=False)
    if isinstance(photo, list):
        return photo[0] if photo else ""
    return photo or ""


def extract_bsr(product: dict):
    direct = to_number(field_value(product, ["rank", "Rank", "salesRank", "SalesRank", "bestSellerRank", "bsr"]))
    if direct is not None:
        return direct
    bsr = find_any(product, ["bsrCategory", "BsrCategory"], scalar_only=False)
    if isinstance(bsr, list) and bsr:
        first = bsr[0] if isinstance(bsr[0], list) else bsr
        if isinstance(first, list) and len(first) > 2:
            return to_number(first[2])
        if isinstance(first, dict):
            return to_number(first.get("rank") or first.get("Rank"))
    return None


def product_rating(product: dict):
    star = to_number(field_value(product, ["star", "Star", "rating", "Rating", "reviewRating"]))
    if star is not None and star <= 5:
        return star
    ratings = to_number(field_value(product, ["ratings", "Ratings"]))
    return ratings if ratings is not None and ratings <= 5 else None


def product_review_count(product: dict):
    count = to_number(field_value(product, ["ratingsCount", "RatingsCount", "reviewCount", "reviewsCount", "commentCount", "ratingsTotal"]))
    if count is not None:
        return count
    ratings = to_number(field_value(product, ["Ratings", "ratings"]))
    return ratings if ratings is not None and ratings > 5 else None


def first_array(obj: Any, names: List[str]) -> list:
    data = unwrap_data(obj)
    if isinstance(data, list):
        return data
    arr = find_any(data, names, scalar_only=False)
    return arr if isinstance(arr, list) else []


def position_from_record(record: dict, is_ad: bool):
    typ = str(field_value(record, ["positionType", "PositionType", "positionName", "PositionName", "ShowType"]) or "").lower()
    pos = to_number(field_value(record, ["position", "Position", "SearchPosition", "searchPosition", "rank", "Rank"]))
    if pos is None:
        return None
    looks_ad = any(x in typ for x in ["ad", "sponsor", "广告"])
    return pos if looks_ad == is_ad else None


def normalize_product(raw: dict, asin: str, role: str) -> dict:
    product = first_product(raw, asin)
    price = field_value(product, ["salesPrice", "SalesPrice", "price", "Price", "currentPrice", "buyboxPrice", "salePrice"])
    coupon = find_any(product, ["coupon", "Coupon", "couponText", "couponValue", "DealType", "ExtraSavings"], scalar_only=False)
    return {
        "asin": asin,
        "role": role,
        "title": field_value(product, ["title", "Title", "productTitle", "name", "productName"]) or "未获取",
        "brand": field_value(product, ["brand", "Brand", "brandName"]) or "未获取",
        "price": to_number(price),
        "price_text": str(price) if price is not None else "未获取",
        "coupon": stringify_short(coupon) or "无/未获取",
        "bsr": extract_bsr(product),
        "rating": product_rating(product),
        "review_count": product_review_count(product),
        "monthly_sales_estimate": to_number(field_value(product, ["listingSalesVolumeOfMonth", "ListingSalesVolumeOfMonth", "AsinSalesCount", "monthlySales", "estimatedSales", "monthSales"])),
        "buybox_seller": field_value(product, ["buyboxSeller", "BuyboxSeller"]) or "未获取",
        "seller_count": to_number(field_value(product, ["sellerCount", "SellerCount"])),
        "image_url": first_photo(product),
        "raw_file": "见 outputs/request_audit.jsonl"
    }


def normalize_keyword(raw: dict, asin: str, keyword: str, role: str) -> dict:
    data = unwrap_data(raw)
    records = first_array(data, ["records", "Records"])
    record = records[0] if records else (data if isinstance(data, dict) else {})
    keyword_obj = find_any(record, ["keyword", "Keyword"], scalar_only=False) or data
    return {
        "asin": asin,
        "role": role,
        "keyword": keyword,
        "organic_rank": to_number(field_value(record, ["organicRank", "naturalRank", "organic_rank"])) or position_from_record(record, False),
        "ad_rank": to_number(field_value(record, ["adRank", "sponsoredRank", "advertisingRank", "ad_rank"])) or position_from_record(record, True),
        "search_volume": to_number(field_value(keyword_obj, ["searchVolume", "SearchVolume", "volume", "keywordSearches"])),
        "purchase_rate": to_number(field_value(keyword_obj, ["purchaseRate", "conversionRate", "cvr", "searchConversionRate", "ClickConversionRateD90"])),
        "raw_file": "见 outputs/request_audit.jsonl"
    }


def load_previous_snapshot(today_name: str) -> Optional[dict]:
    snap_dir = WORK_ROOT / "cache" / "snapshots"
    if not snap_dir.exists():
        return None
    files = sorted([p for p in snap_dir.glob("*.json") if p.name != today_name])
    if not files:
        return None
    return json.loads(files[-1].read_text(encoding="utf-8"))


def make_events(current: dict, previous: Optional[dict], thresholds: dict) -> List[dict]:
    if not previous:
        return [{"date": current["meta"]["report_date"], "type": "首次基线", "severity": "low", "asin": "ALL", "keyword": "", "before": "无历史快照", "after": "已生成今日基线", "evidence": "首次运行，后续可开始识别变化", "raw_files": ["cache/snapshots"]}]
    events = []
    prev_by_asin = {x["asin"]: x for x in previous.get("asin_snapshots", [])}
    for now in current.get("asin_snapshots", []):
        old = prev_by_asin.get(now["asin"])
        if not old:
            events.append(event(current, "新增监控 ASIN", "medium", now["asin"], "", "无", "新增", "监控配置新增 ASIN")); continue
        for field, typ, lower_better in [("price", "价格变化", False), ("bsr", "BSR变化", True), ("rating", "评分变化", False), ("review_count", "评论数变化", False)]:
            a, b = old.get(field), now.get(field)
            if a is None or b is None or a == b: continue
            severity = "medium"
            if field == "price":
                change_pct = abs(b - a) / a if a else 0
                if change_pct < thresholds.get("price_change_pct", 0.03): continue
                typ2 = "降价" if b < a else "涨价"
                severity = "high" if b < a else "medium"
            elif field == "bsr":
                typ2 = "BSR改善" if b < a else "BSR变差"
            elif field == "rating":
                if abs(b - a) < thresholds.get("rating_drop", 0.1): continue
                typ2 = "评分下降" if b < a else "评分提升"
            else:
                if abs(b - a) < thresholds.get("review_growth_count", 5): continue
                typ2 = "评论增长" if b > a else "评论减少"
            events.append(event(current, typ2, severity, now["asin"], "", a, b, f"{field}: {a} -> {b}"))
        if (old.get("coupon") in (None, "", "无/未获取")) and now.get("coupon") not in (None, "", "无/未获取"):
            events.append(event(current, "新增Coupon", "high", now["asin"], "", old.get("coupon"), now.get("coupon"), "上一快照无 Coupon，当前有 Coupon"))
        if old.get("title") and now.get("title") and old.get("title") != now.get("title"):
            events.append(event(current, "Listing标题调整", "medium", now["asin"], "", old.get("title"), now.get("title"), "标题文本发生变化"))
    prev_kw = {(x["asin"], x["keyword"]): x for x in previous.get("keyword_gap", [])}
    for now in current.get("keyword_gap", []):
        old = prev_kw.get((now["asin"], now["keyword"]))
        if not old: continue
        a, b = old.get("organic_rank"), now.get("organic_rank")
        if a is None or b is None: continue
        delta = b - a
        if abs(delta) >= thresholds.get("keyword_rank_change", 10):
            events.append(event(current, "核心词排名流失" if delta > 0 else "核心词排名改善", "high" if delta > 0 else "medium", now["asin"], now["keyword"], a, b, f"自然位 {a} -> {b}"))
    return events


def event(current, typ, severity, asin, keyword, before, after, evidence):
    return {"date": current["meta"]["report_date"], "type": typ, "severity": severity, "asin": asin, "keyword": keyword, "before": before, "after": after, "evidence": evidence, "raw_files": ["outputs/request_audit.jsonl"]}


def make_actions(events: List[dict]) -> List[dict]:
    actions = []
    for e in events:
        if e["type"] in ["降价", "新增Coupon", "BSR改善"]:
            actions.append({"priority": "高", "target": e["asin"], "basis": e["evidence"], "action": "评估是否跟券/调整价格差，并检查核心词广告位是否需要补量。", "owner": "运营", "recheck_after": "明日"})
        elif "关键词" in e["type"]:
            actions.append({"priority": "中", "target": f"{e['asin']} / {e.get('keyword','')}", "basis": e["evidence"], "action": "复查该词广告曝光、自然位和转化，必要时补充精准/词组投放。", "owner": "运营", "recheck_after": "3天"})
        elif "评分下降" == e["type"]:
            actions.append({"priority": "高", "target": e["asin"], "basis": e["evidence"], "action": "查看新增差评主题，判断是否为质量、物流、安装或预期偏差问题。", "owner": "运营/售后", "recheck_after": "明日"})
    return actions[:20]


def build(config_path: str, collection_path: str) -> dict:
    config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    collection = json.loads(Path(collection_path).read_text(encoding="utf-8"))
    today = date.today().isoformat()
    own, comps = config.get("own_asins", []), config.get("competitor_asins", [])
    thresholds = config.get("thresholds", {})
    snapshots = []
    for asin in own + comps:
        raw = collection.get("asins", {}).get(asin, {})
        snapshots.append(normalize_product(raw, asin, "own" if asin in own else "competitor"))
    keyword_gap = []
    for key, raw in collection.get("keywords", {}).items():
        asin, kw = key.split("::", 1)
        keyword_gap.append(normalize_keyword(raw, asin, kw, "own" if asin in own else "competitor"))
    report = {
        "meta": {"report_date": today, "generated_at": datetime.now().isoformat(timespec="seconds"), "marketplace": config.get("marketplace", "US"), "domain": config.get("domain", 1), "own_asins": own, "competitor_asins": comps, "core_keywords": config.get("core_keywords", []), "data_source": "Sorftime CLI"},
        "summary": {},
        "asin_snapshots": snapshots,
        "price_trends": [],
        "bsr_trends": [],
        "keyword_gap": keyword_gap,
        "review_voc": [],
        "listing_changes": [],
        "events": [],
        "action_items": [],
        "request_audit": read_audit(),
    }
    previous = load_previous_snapshot(f"{today}.json")
    report["events"] = make_events(report, previous, thresholds)
    report["action_items"] = make_actions(report["events"])
    report["summary"] = {
        "asin_count": len(snapshots),
        "competitor_count": len(comps),
        "event_count": len(report["events"]),
        "risk_count": sum(1 for x in report["events"] if x.get("severity") == "high"),
        "opportunity_count": sum(1 for x in report["events"] if x.get("type") in ["核心词排名改善", "评分提升", "BSR改善"]),
        "action_count": len(report["action_items"]),
        "baseline": previous is None
    }
    out = WORK_ROOT / "outputs" / "report_data.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    snap_dir = WORK_ROOT / "cache" / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)
    (snap_dir / f"{today}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def read_audit():
    p = WORK_ROOT / "outputs" / "request_audit.jsonl"
    if not p.exists(): return []
    return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "config" / "monitoring_config.json"))
    ap.add_argument("--collection", default=str(WORK_ROOT / "cache" / "latest_collection.json"))
    args = ap.parse_args()
    print(json.dumps(build(args.config, args.collection), ensure_ascii=False, indent=2))
