from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
import math
import os
import re
import statistics

import capabilities_v43 as caps
import providers_v43 as providers

DIRECTOR_VERSION = "creative-director-v4.3.0"
BANNED_COPY = {"imobiliário em movimento", "imovel em destaque", "imóvel em destaque", "agende sua visita"}

STYLE_PROFILES = {
    "LUXURY_CINEMATIC": {"pace": [1.10, 1.45, 1.85, 2.25, 1.60, 2.35, 1.55, 2.10], "ramps": 1, "visible_transitions": 1, "pushes": 2, "graphics": 3},
    "HIGH_ENERGY_REEL": {"pace": [0.62, 0.76, 0.92, 1.10, 0.80, 1.18, 0.88, 1.30, 0.95], "ramps": 2, "visible_transitions": 2, "pushes": 1, "graphics": 4},
    "LIFESTYLE": {"pace": [0.95, 1.25, 1.60, 1.85, 1.30, 1.95, 1.45], "ramps": 1, "visible_transitions": 1, "pushes": 1, "graphics": 2},
    "PERFORMANCE_AD": {"pace": [0.72, 0.88, 1.05, 1.28, 0.92, 1.38, 1.05, 1.48], "ramps": 2, "visible_transitions": 1, "pushes": 1, "graphics": 4},
    "ARCHITECTURAL": {"pace": [1.15, 1.55, 2.00, 2.45, 1.70, 2.30, 1.85], "ramps": 0, "visible_transitions": 1, "pushes": 3, "graphics": 2},
    "LAUNCH": {"pace": [0.85, 1.15, 1.45, 1.85, 1.20, 1.65, 1.35], "ramps": 1, "visible_transitions": 1, "pushes": 1, "graphics": 5},
    "SOCIAL_PROOF": {"pace": [0.72, 0.90, 1.12, 1.28, 0.98, 1.35], "ramps": 1, "visible_transitions": 1, "pushes": 0, "graphics": 5},
}


def _num(value, default=0.0):
    try:
        return float(value)
    except Exception:
        return default


def _value(job, *keys):
    pc = job.get("product_context") or {}
    fields = ((job.get("client_context") or {}).get("fields") or {})
    for key in keys:
        v = pc.get(key)
        if v not in (None, ""):
            return str(v).strip()
        row = fields.get(key)
        if isinstance(row, dict) and row.get("value") not in (None, ""):
            return str(row["value"]).strip()
    return None


def _money(value):
    if not value:
        return 0.0
    s = re.sub(r"[^0-9,.-]", "", str(value)).replace(".", "").replace(",", ".")
    try:
        return float(s)
    except Exception:
        return 0.0


def _clean_copy(value):
    if not value:
        return None
    s = re.sub(r"\s+", " ", str(value)).strip()
    return None if not s or s.lower() in BANNED_COPY else s


def _style(job):
    strategy = job.get("edit_strategy") or {}
    requested = str(strategy.get("style") or strategy.get("creative_style") or "").upper().strip()
    aliases = {"LUXURY": "LUXURY_CINEMATIC", "REEL": "HIGH_ENERGY_REEL", "PERFORMANCE": "PERFORMANCE_AD", "ARCHITECTURE": "ARCHITECTURAL"}
    requested = aliases.get(requested, requested)
    if requested in STYLE_PROFILES:
        return requested
    price = _money(_value(job, "price", "preco", "valor"))
    return "LUXURY_CINEMATIC" if price >= 2_000_000 else "PERFORMANCE_AD"


def _durations(target, style):
    pattern = STYLE_PROFILES[style]["pace"]
    out, total, i = [], 0.0, 0
    while total < target - 0.30:
        d = min(pattern[i % len(pattern)], target - total)
        if target - total - d < 0.42:
            d = target - total
        out.append(round(d, 3))
        total += d
        i += 1
    return out


def _vision(a):
    v = a.get("vision") or {}
    return v if v.get("available") else {}


def _candidate_pool(w, inputs, analyses, style):
    base = w.candidates(inputs, analyses)
    out = []
    for c in base:
        a = analyses[c["input"]]
        v = _vision(a)
        length = max(0.0, float(c["end"]) - float(c["start"]))
        quality = _num(v.get("quality_score"), 58.0)
        motion = _num(v.get("motion_score"), 0.0)
        edge = _num(v.get("edge_density"), 0.06)
        score = float(c.get("score", 0.0))
        score += (quality - 50.0) * 0.78
        score += min(13.0, length * 2.4)
        if 0.80 <= length <= 5.0:
            score += 7.0
        if style == "ARCHITECTURAL":
            score += min(14.0, edge * 70.0)
        elif style in ("HIGH_ENERGY_REEL", "PERFORMANCE_AD"):
            score += min(11.0, motion * 3.0)
        if _num(v.get("brightness"), 0.5) < 0.16 or _num(v.get("brightness"), 0.5) > 0.90:
            score -= 20.0
        c = dict(c)
        c["v43_score"] = score
        c["vision"] = v
        out.append(c)
    return sorted(out, key=lambda x: x["v43_score"], reverse=True)


def _pick(pool, usage, last_input, last_direction, duration):
    ranked = []
    for c in pool:
        span = float(c["end"]) - float(c["start"])
        if span < max(0.68, duration * 1.02):
            continue
        penalty = usage.get(c["input"], 0) * 11.0
        if c["input"] == last_input:
            penalty += 24.0
        direction = (c.get("vision") or {}).get("motion_direction")
        if last_direction and direction == last_direction and direction not in (None, "static"):
            penalty -= 2.5
        ranked.append((c["v43_score"] - penalty, c))
    if not ranked:
        ranked = [(c["v43_score"] - usage.get(c["input"], 0) * 9.0, c) for c in pool]
    ranked.sort(key=lambda x: x[0], reverse=True)
    return ranked[0][1]


def _stage(cursor, target):
    if cursor < target * 0.13:
        return "VISUAL_HOOK"
    if cursor < target * 0.72:
        return "PROPERTY_TOUR"
    if cursor < target * 0.90:
        return "COMMERCIAL_SAFE"
    return "BRANDED_CLOSE"


def _median(values, default):
    values = [float(v) for v in values if v is not None]
    return statistics.median(values) if values else default


def _color_targets(analyses):
    visions = [_vision(a) for a in analyses]
    return {
        "brightness": _median([v.get("brightness") for v in visions if v], 0.52),
        "contrast": _median([v.get("contrast") for v in visions if v], 0.55),
        "saturation": _median([v.get("saturation") for v in visions if v], 0.32),
    }


def _effect(kind, **params):
    return {"kind": kind, "enabled": True, "params": params, "provider": caps.get(kind).provider if kind in {x["name"] for x in caps.all_capabilities()} else "native"}


def _transition(prev, current, remaining):
    if remaining <= 0 or not prev:
        return {"kind": "cut", "duration": 0.0}, remaining
    pv = prev.get("vision") or {}
    cv = current.get("vision") or {}
    pd, cd = pv.get("motion_direction"), cv.get("motion_direction")
    pm, cm = _num(pv.get("motion_score")), _num(cv.get("motion_score"))
    if pd == cd and pd in ("left", "right", "up", "down") and min(pm, cm) >= 0.55:
        return {"kind": "match_motion", "duration": 0.10, "direction": pd, "reason": "motion_direction_match"}, remaining - 1
    return {"kind": "cut", "duration": 0.0}, remaining


def _make_text(text, start, duration, y, size, role, subtype="kinetic_text"):
    text = _clean_copy(text)
    if not text:
        return None
    return {
        "id": f"text-{role.lower()}-{int(start*100)}", "type": "text", "subtype": subtype, "stage": role,
        "start": round(start, 3), "duration": round(duration, 3), "text": text,
        "fontFamily": "DejaVu Sans", "fontSize": int(size), "fontWeight": 700, "color": "#FFFFFF",
        "align": "left", "x": 92, "y": int(y), "maxWidth": 880,
        "animationIn": {"preset": "slide_up", "duration": 0.18, "easing": "ease_out_cubic"},
        "animationOut": {"preset": "fade", "duration": 0.13, "easing": "ease_in"},
        "shadow": {"color": "#000000AA", "blur": 14, "x": 0, "y": 4},
    }


def build_timeline(w, job, inputs, analyses):
    strategy = job.get("edit_strategy") or {}
    target = max(12.0, min(45.0, _num(strategy.get("target_duration_seconds"), 18.0)))
    style = _style(job)
    profile = STYLE_PROFILES[style]
    pool = _candidate_pool(w, inputs, analyses, style)
    if not pool:
        raise RuntimeError("creative_director_no_usable_scenes")
    color_target = _color_targets(analyses)

    assets = []
    for item, a in zip(inputs, analyses):
        assets.append({
            "id": str(item.get("asset_id") or item["id"]), "kind": "video", "driveFileId": item.get("drive_file_id"),
            "fileName": item.get("file_name"), "duration": a["duration_seconds"], "width": a["width"], "height": a["height"],
            "metadata": {"analysis": a, "vision": _vision(a)},
        })

    durations = _durations(target, style)
    usage = defaultdict(int)
    shots = []
    cursor = 0.0
    last_input = None
    last_direction = None
    ramps_left = int(profile["ramps"])
    pushes_left = int(profile["pushes"])
    transitions_left = int(profile["visible_transitions"])
    previous_candidate = None

    for idx, duration in enumerate(durations):
        c = _pick(pool, usage, last_input, last_direction, duration)
        usage[c["input"]] += 1
        vision = c.get("vision") or {}
        analysis = analyses[c["input"]]
        available = max(0.55, float(c["end"]) - float(c["start"]))
        span = min(available, max(duration + 0.10, duration * 1.04))
        headroom = max(0.0, available - span)
        trim_in = float(c["start"]) + min(headroom * 0.33, 0.16)
        trim_out = trim_in + span
        focus = vision.get("focus") or {"x": 0.5, "y": 0.5, "confidence": 0.0}

        effects = [
            _effect("smart_reframe", focus_x=_num(focus.get("x"), 0.5), focus_y=_num(focus.get("y"), 0.5), confidence=_num(focus.get("confidence"))),
            _effect("color_match", target_brightness=color_target["brightness"], target_contrast=color_target["contrast"], target_saturation=color_target["saturation"], source_brightness=_num(vision.get("brightness"), color_target["brightness"]), source_contrast=_num(vision.get("contrast"), color_target["contrast"]), source_saturation=_num(vision.get("saturation"), color_target["saturation"])),
            _effect("white_balance", **(vision.get("white_balance") or {"r": 1.0, "g": 1.0, "b": 1.0})),
        ]
        if _num(vision.get("jitter_score")) >= 0.24:
            effects.append(_effect("stabilization", strength=min(1.0, _num(vision.get("jitter_score")))))
        if _num(vision.get("brightness"), 0.5) >= 0.72:
            effects.append(_effect("highlight_soften", strength=0.35))
        if bool(strategy.get("lens_correction")):
            effects.append(_effect("lens_correction", k1=_num(strategy.get("lens_k1"), -0.015), k2=_num(strategy.get("lens_k2"), 0.006)))

        motion = _num(vision.get("motion_score"))
        if ramps_left > 0 and duration >= 1.20 and motion >= 0.65 and idx not in (0, len(durations)-1):
            effects.extend([_effect("speed_ramp", intensity=0.32 if style == "LUXURY_CINEMATIC" else 0.48), _effect("motion_blur", intensity=0.18)])
            ramps_left -= 1
        elif pushes_left > 0 and duration >= 1.45 and motion <= 0.85:
            effects.append(_effect("cinematic_push", amount=0.024 if style in ("LUXURY_CINEMATIC", "ARCHITECTURAL") else 0.016))
            pushes_left -= 1
        elif float(analysis.get("fps") or 0) >= 50 and duration >= 1.55 and style in ("LUXURY_CINEMATIC", "LIFESTYLE") and idx % 5 == 2:
            effects.append(_effect("slow_motion", speed=0.78))

        transition, transitions_left = _transition(previous_candidate, c, transitions_left)
        if idx == 0:
            transition = None
        stage = _stage(cursor, target)
        shot = {
            "id": f"shot-{idx+1}", "type": "video", "assetId": c["assetId"], "stage": stage,
            "start": round(cursor, 3), "duration": round(duration, 3), "trimIn": round(trim_in, 3), "trimOut": round(trim_out, 3),
            "speed": round(span / max(duration, 0.1), 3), "fit": "cover", "volume": 0.0,
            "effects": effects, "transitionIn": transition,
            "metadata": {
                "selectionReason": c.get("reason", []), "directorScore": round(c["v43_score"], 2), "vision": vision,
                "sourceIndex": c["input"], "motionDirection": vision.get("motion_direction"), "qualityScore": vision.get("quality_score"),
            },
        }
        shots.append(shot)
        cursor += duration
        last_input = c["input"]
        last_direction = vision.get("motion_direction")
        previous_candidate = c

    # If a detector produced one long continuous source region repeatedly, spread the windows.
    by_asset = defaultdict(list)
    duration_by_asset = {str(a["id"]): float(a.get("duration") or 0) for a in assets}
    for item in shots:
        by_asset[item["assetId"]].append(item)
    for asset_id, rows in by_asset.items():
        if len(rows) < 2:
            continue
        starts = [float(x["trimIn"]) for x in rows]
        if max(starts) - min(starts) > 0.55:
            continue
        source_duration = duration_by_asset.get(asset_id, 0.0)
        spans = [max(0.55, float(x["trimOut"]) - float(x["trimIn"])) for x in rows]
        usable = source_duration - max(spans) - 0.12
        if usable <= 0.8:
            continue
        for i, (row, span) in enumerate(zip(rows, spans)):
            ratio = i / max(1, len(rows)-1)
            start = 0.12 + max(0.0, usable - 0.12) * ratio
            start = max(0.08, min(start, source_duration - span - 0.08))
            row["trimIn"] = round(start, 3)
            row["trimOut"] = round(start + span, 3)
            row["metadata"]["sourceWindowDiversified"] = True

    # Data-backed graphics only.
    product = _clean_copy(job.get("product_name"))
    location = _clean_copy(_value(job, "location", "localizacao", "bairro", "city", "cidade", "address"))
    area = _clean_copy(_value(job, "area", "area_m2", "metragem"))
    suites = _clean_copy(_value(job, "suites", "suites_count", "quartos", "bedrooms"))
    parking = _clean_copy(_value(job, "parking", "vagas", "parking_spaces"))
    price = _clean_copy(_value(job, "price", "preco", "valor"))
    client = _clean_copy((((job.get("client_context") or {}).get("client") or {}).get("name")))
    cta = _clean_copy(_value(job, "cta", "call_to_action", "whatsapp_cta"))
    texts = []
    for row in [
        _make_text(product or location, 0.16, min(2.15, target*0.14), 300, 66, "VISUAL_HOOK", "kinetic_text"),
        _make_text(" • ".join([x for x in (area, suites, parking) if x]), target*0.45, min(2.0, target*0.12), 1325, 46, "PROPERTY_TOUR", "feature_callout"),
        _make_text(price, target*0.73, min(2.0, target*0.13), 1320, 58, "COMMERCIAL_SAFE", "price_card"),
        _make_text(cta or client, target*0.90, target*0.08, 1390, 48, "BRANDED_CLOSE", "brand_outro"),
    ]:
        if row:
            texts.append(row)

    captions = []
    for idx, row in enumerate((job.get("product_context") or {}).get("captions") or []):
        if not isinstance(row, dict) or not _clean_copy(row.get("text")):
            continue
        captions.append({
            "id": f"caption-{idx+1}", "type": "caption", "text": _clean_copy(row["text"]),
            "start": _num(row.get("start")), "duration": max(0.25, _num(row.get("duration"), 1.0)),
            "x": 100, "y": 1460, "fontSize": 44, "maxWidth": 880,
        })

    audio_events = []
    for s in shots:
        kinds = {e.get("kind") for e in s.get("effects", []) if e.get("enabled", True)}
        if "speed_ramp" in kinds:
            audio_events.append({"id": f"whoosh-{s['id']}", "type": "whoosh", "start": round(float(s["start"])+float(s["duration"])*0.45, 3), "gain": 0.13})
    if style in ("HIGH_ENERGY_REEL", "PERFORMANCE_AD", "LAUNCH"):
        audio_events.append({"id": "impact-close", "type": "impact", "start": round(target*0.90, 3), "gain": 0.10})

    requested_vfx = []
    for i, req in enumerate(strategy.get("vfx_requests") or []):
        if not isinstance(req, dict):
            continue
        effect = str(req.get("effect") or req.get("kind") or "").strip()
        if not effect:
            continue
        requested_vfx.append({
            "id": f"vfx-{i+1}", "effect": effect, "start": _num(req.get("start")), "duration": _num(req.get("duration"), target),
            "params": req.get("params") or {}, "disclosure": providers.disclosure_for(effect),
        })

    warnings = []
    provider_state = providers.provider_status()
    for req in requested_vfx:
        if req["effect"] in caps.missing([req["effect"]]) and not (provider_state.get("vfx_provider") or provider_state.get("local_vfx")):
            warnings.append(f"provider_required:{req['effect']}")

    music = job.get("_music_analysis") or {}
    timeline = {
        "version": "timeline-v1.1", "jobId": job["id"], "createdAt": datetime.now(timezone.utc).isoformat(),
        "strategyVersion": job.get("strategy_version") or "dynamic-strategy-v3", "directorVersion": DIRECTOR_VERSION, "style": style,
        "canvas": {"width": 1080, "height": 1920, "fps": 30, "aspectRatio": "9:16", "background": "#000000"},
        "safeZone": {"top": 240, "right": 80, "bottom": 320, "left": 80}, "duration": target,
        "assets": assets,
        "tracks": [
            {"id": "video-main", "kind": "video", "name": "Main picture", "items": shots},
            {"id": "graphics-main", "kind": "text", "name": "Motion graphics", "items": texts},
            {"id": "captions", "kind": "caption", "name": "Captions", "items": captions},
            {"id": "audio-events", "kind": "audio_event", "name": "Sound design", "items": audio_events},
            {"id": "vfx", "kind": "vfx", "name": "Advanced VFX", "items": requested_vfx},
        ],
        "audioPlan": {"music": music, "ducking": True, "events": audio_events},
        "render": {"container": "mp4", "videoCodec": "h264", "audioCodec": "aac", "videoBitrateMbps": 12, "audioBitrateKbps": 192, "pixelFormat": "yuv420p"},
        "capabilities": caps.capability_summary(),
        "metadata": {
            "clientId": job.get("client_id"), "productId": job.get("product_id"), "contextVersion": job.get("context_version"),
            "generatedBy": DIRECTOR_VERSION, "warnings": warnings, "providerStatus": provider_state,
            "requiresHumanDisclosureReview": any(x["disclosure"]["review_required"] for x in requested_vfx),
        },
    }
    validate_creative_timeline(timeline)
    return timeline


def validate_creative_timeline(timeline):
    tracks = timeline.get("tracks", [])
    videos = next((t.get("items", []) for t in tracks if t.get("kind") == "video"), [])
    texts = next((t.get("items", []) for t in tracks if t.get("kind") == "text"), [])
    vfx = next((t.get("items", []) for t in tracks if t.get("kind") == "vfx"), [])
    if len(videos) < 6:
        raise RuntimeError("creative_qa_fail:not_enough_shots")
    visible = [v for v in videos[1:] if (v.get("transitionIn") or {}).get("kind") not in (None, "cut")]
    if len(visible) > max(2, math.floor(len(videos)*0.16)):
        raise RuntimeError("creative_qa_fail:transition_density")
    ramps = sum(1 for v in videos if any(e.get("kind") == "speed_ramp" and e.get("enabled", True) for e in v.get("effects", [])))
    if ramps > 2:
        raise RuntimeError("creative_qa_fail:speed_ramp_density")
    long_shots = [v for v in videos if float(v.get("duration") or 0) > 3.2]
    if len(long_shots) > 2:
        raise RuntimeError("creative_qa_fail:too_many_long_shots")
    exact_windows = set()
    duplicates = 0
    for v in videos:
        key = (v.get("assetId"), round(float(v.get("trimIn") or 0), 2), round(float(v.get("trimOut") or 0), 2))
        if key in exact_windows:
            duplicates += 1
        exact_windows.add(key)
    if duplicates:
        raise RuntimeError("creative_qa_fail:duplicate_source_window")
    for t in texts:
        if str(t.get("text", "")).strip().lower() in BANNED_COPY:
            raise RuntimeError("creative_qa_fail:generic_copy")
        y = float(t.get("y") or 0)
        if y < 220 or y > 1540:
            raise RuntimeError("creative_qa_fail:text_safe_zone")
    source_counts = defaultdict(int)
    for v in videos:
        source_counts[v["assetId"]] += 1
    if len(source_counts) >= 3 and max(source_counts.values()) / len(videos) > 0.50:
        raise RuntimeError("creative_qa_fail:source_dominance")
    review_vfx = [x for x in vfx if (x.get("disclosure") or {}).get("review_required")]
    return {
        "pass": True, "director": DIRECTOR_VERSION, "shots": len(videos), "visible_transitions": len(visible),
        "speed_ramps": ramps, "text_items": len(texts), "vfx_requests": len(vfx), "vfx_review_required": len(review_vfx),
        "source_usage": dict(source_counts),
    }
