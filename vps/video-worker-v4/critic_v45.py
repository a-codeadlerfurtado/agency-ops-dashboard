from __future__ import annotations

import copy
import math

import learning_v43 as learning

CRITIC_VERSION = "approved-video-critic-v4.5.0"
PASS_SCORE = 82.0


def _texts(timeline):
    return next(
        (t.get("items", []) for t in timeline.get("tracks", []) if t.get("kind") == "text"),
        [],
    )


def _videos(timeline):
    return next(
        (t.get("items", []) for t in timeline.get("tracks", []) if t.get("kind") == "video"),
        [],
    )


def _selected_dna(job):
    return ((job.get("_selected_dna_profile") or {}).get("dna") or {})


def _check(name, passed, weight, detail=None):
    return {
        "name": name,
        "pass": bool(passed),
        "weight": float(weight),
        "detail": detail,
    }


def evaluate(job, timeline, qa_report):
    dna = _selected_dna(job)
    vector = learning.timeline_feature_vector(timeline)
    videos = _videos(timeline)
    texts = _texts(timeline)
    target = float(dna.get("target_duration_seconds") or timeline.get("duration") or 30)
    avg_target = float(dna.get("avg_shot_duration") or vector.get("avg_shot_duration") or 2.5)
    max_transitions = int(dna.get("max_visible_transitions", 2))
    duration = float(vector.get("duration") or 0)
    avg_shot = float(vector.get("avg_shot_duration") or 0)
    refs = (job.get("_reference_pack") or {}).get("references") or []
    price_rows = [x for x in texts if x.get("subtype") == "price_card"]
    cta_rows = [x for x in texts if x.get("subtype") == "brand_outro"]
    price_ratio = float(dna.get("price_start_ratio") or 0.78)
    cta_ratio = float(dna.get("cta_start_ratio") or 0.91)

    checks = [
        _check("technical_qa", qa_report.get("pass") is True, 35, qa_report.get("checks")),
        _check("approved_reference_grounding", bool(refs), 12, len(refs)),
        _check("duration_matches_dna", abs(duration-target) <= max(2.0, target*0.10), 10, {
            "actual": duration, "target": target,
        }),
        _check("shot_pace_matches_dna", abs(avg_shot-avg_target) <= max(0.65, avg_target*0.42), 10, {
            "actual": avg_shot, "target": avg_target,
        }),
        _check("transition_density_matches_dna", int(vector.get("visible_transitions") or 0) <= max_transitions, 8, {
            "actual": vector.get("visible_transitions"), "max": max_transitions,
        }),
    ]

    fields = job.get("product_context") or {}
    has_price = any(fields.get(k) not in (None, "") for k in ("price", "preco", "valor"))
    if has_price:
        ok = bool(price_rows) and all(
            abs((float(x.get("start") or 0) / max(duration, 0.1)) - price_ratio) <= 0.16
            for x in price_rows
        )
        checks.append(_check("price_timing", ok, 7, price_ratio))
    else:
        checks.append(_check("price_timing", True, 7, "not_applicable"))

    if cta_rows:
        ok = all(
            float(x.get("start") or 0) / max(duration, 0.1) >= cta_ratio - 0.08
            for x in cta_rows
        )
        checks.append(_check("cta_is_close", ok, 8, cta_ratio))
    else:
        checks.append(_check("cta_is_close", False, 8, "missing"))

    safe = all(220 <= float(x.get("y") or 0) <= 1540 for x in texts)
    checks.append(_check("text_safe_zone", safe, 5))
    unique = len({(x.get("assetId"), round(float(x.get("trimIn") or 0), 2)) for x in videos})
    checks.append(_check("scene_diversity", unique >= max(3, math.ceil(len(videos)*0.65)), 5, {
        "unique": unique, "shots": len(videos),
    }))

    total = sum(x["weight"] for x in checks)
    won = sum(x["weight"] for x in checks if x["pass"])
    score = round((won / max(total, 1.0)) * 100.0, 2)
    hard_fail = not checks[0]["pass"]
    status = "FAIL" if hard_fail else ("PASS" if score >= PASS_SCORE else "REVISE")
    return {
        "status": status,
        "score": score,
        "critic_version": CRITIC_VERSION,
        "checks": checks,
        "feature_vector": vector,
        "dna_profile_id": (job.get("_selected_dna_profile") or {}).get("id"),
        "reference_ids": [x.get("id") for x in refs if x.get("id")],
    }


def revise_timeline(job, timeline, report):
    revised = copy.deepcopy(timeline)
    dna = _selected_dna(job)
    videos = _videos(revised)
    texts = _texts(revised)
    max_transitions = int(dna.get("max_visible_transitions", 2))
    visible = 0
    for row in videos[1:]:
        transition = row.get("transitionIn") or {}
        if str(transition.get("kind") or "cut") != "cut" and float(transition.get("duration") or 0) > 0:
            visible += 1
            if visible > max_transitions:
                row["transitionIn"] = {"kind": "cut", "duration": 0.0}

    duration = float(revised.get("duration") or 30)
    price_ratio = float(dna.get("price_start_ratio") or 0.78)
    cta_ratio = float(dna.get("cta_start_ratio") or 0.91)
    for row in texts:
        if row.get("subtype") == "price_card":
            row["start"] = round(duration * price_ratio, 3)
        elif row.get("subtype") == "brand_outro":
            row["start"] = round(duration * cta_ratio, 3)
            row["duration"] = round(max(1.0, duration-row["start"]-0.10), 3)
        row["y"] = int(max(220, min(1540, float(row.get("y") or 330))))
    revised.setdefault("metadata", {})["criticRevision"] = {
        "criticVersion": CRITIC_VERSION,
        "previousScore": report.get("score"),
        "reason": [x["name"] for x in report.get("checks", []) if not x.get("pass")],
    }
    return revised
