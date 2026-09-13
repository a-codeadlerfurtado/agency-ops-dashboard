from __future__ import annotations

VARIANT_VERSION = "creative-variants-v4.3.0"

DEFAULT_VARIANTS = [
    {"id": "luxury_18", "style": "LUXURY_CINEMATIC", "duration": 18, "price_mode": "late", "hook_mode": "visual"},
    {"id": "reel_15", "style": "HIGH_ENERGY_REEL", "duration": 15, "price_mode": "none", "hook_mode": "fast_visual"},
    {"id": "performance_20", "style": "PERFORMANCE_AD", "duration": 20, "price_mode": "late", "hook_mode": "benefit"},
    {"id": "architectural_24", "style": "ARCHITECTURAL", "duration": 24, "price_mode": "none", "hook_mode": "space"},
]


def plan_variants(job):
    strategy = job.get("edit_strategy") or {}
    requested = strategy.get("variants")
    if isinstance(requested, list) and requested:
        rows = []
        for i, row in enumerate(requested):
            if not isinstance(row, dict):
                continue
            rows.append({
                "id": str(row.get("id") or f"variant_{i+1}"),
                "style": str(row.get("style") or strategy.get("style") or "PERFORMANCE_AD").upper(),
                "duration": max(12, min(45, float(row.get("duration") or strategy.get("target_duration_seconds") or 18))),
                "price_mode": str(row.get("price_mode") or "late"),
                "hook_mode": str(row.get("hook_mode") or "visual"),
            })
        if rows:
            return {"version": VARIANT_VERSION, "variants": rows}
    base_style = str(strategy.get("style") or "").upper()
    target = max(12, min(45, float(strategy.get("target_duration_seconds") or 18)))
    primary = {
        "id": "primary",
        "style": base_style or "AUTO",
        "duration": target,
        "price_mode": "late",
        "hook_mode": "visual",
    }
    alternates = [dict(x) for x in DEFAULT_VARIANTS if x["style"] != base_style][:3]
    return {"version": VARIANT_VERSION, "variants": [primary, *alternates]}
