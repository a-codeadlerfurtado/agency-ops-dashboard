from __future__ import annotations

from datetime import datetime, timezone
import math
import re

BANNED_GENERIC_COPY = {
    "imobiliário em movimento",
    "imovel em destaque",
    "imóvel em destaque",
    "agende sua visita",
}


def _value(job, *keys):
    pc = job.get("product_context") or {}
    fields = ((job.get("client_context") or {}).get("fields") or {})
    for key in keys:
        value = pc.get(key)
        if value not in (None, ""):
            return str(value).strip()
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


def _valid_copy(value):
    if not value:
        return None
    clean = re.sub(r"\s+", " ", str(value)).strip()
    if not clean or clean.lower() in BANNED_GENERIC_COPY:
        return None
    return clean


def _scene_pool(w, inputs, analyses):
    pool = w.candidates(inputs, analyses)
    # Prefer meaningful scene lengths and source diversity. Long continuous scenes
    # get enough room for a deliberate trim instead of taking the first frame only.
    for c in pool:
        length = max(0.0, float(c["end"]) - float(c["start"]))
        c["v42_score"] = float(c.get("score", 0)) + min(14.0, length * 2.6)
        if 0.85 <= length <= 4.8:
            c["v42_score"] += 8.0
    return sorted(pool, key=lambda x: x["v42_score"], reverse=True)


def _pick(pool, usage, last_input, min_source_span):
    ranked = []
    for c in pool:
        span = float(c["end"]) - float(c["start"])
        if span < min_source_span:
            continue
        penalty = usage.get(c["input"], 0) * 13.0
        if c["input"] == last_input:
            penalty += 28.0
        ranked.append((float(c["v42_score"]) - penalty, c))
    if not ranked:
        ranked = [(float(c["v42_score"]) - usage.get(c["input"], 0) * 10.0, c) for c in pool]
    ranked.sort(key=lambda x: x[0], reverse=True)
    return ranked[0][1]


def _durations(target, style):
    # Clean editorial pacing. No machine-gun montage and no fixed 6 s blocks.
    if style == "LUXURY_CINEMATIC":
        pattern = [1.05, 1.35, 1.75, 2.20, 1.55, 2.35, 1.45, 2.05, 1.60, 2.10]
    else:
        pattern = [0.72, 0.88, 1.08, 1.32, 0.92, 1.42, 1.05, 1.55, 1.18, 1.48, 1.22, 1.36]
    out, total, i = [], 0.0, 0
    while total < target - 0.35:
        d = min(pattern[i % len(pattern)], target - total)
        if target - total - d < 0.45:
            d = target - total
        out.append(round(d, 3))
        total += d
        i += 1
    return out


def build_timeline(w, job, inputs, analyses):
    strategy = job.get("edit_strategy") or {}
    target = max(12.0, min(30.0, float(strategy.get("target_duration_seconds") or 18.0)))
    price = _value(job, "price", "preco", "valor")
    style = "LUXURY_CINEMATIC" if _money(price) >= 2_000_000 else "PERFORMANCE_AD"
    pool = _scene_pool(w, inputs, analyses)
    if not pool:
        raise RuntimeError("creative_director_no_usable_scenes")

    assets = []
    for item, a in zip(inputs, analyses):
        assets.append({
            "id": str(item.get("asset_id") or item["id"]),
            "kind": "video",
            "driveFileId": item.get("drive_file_id"),
            "fileName": item.get("file_name"),
            "duration": a["duration_seconds"],
            "width": a["width"],
            "height": a["height"],
            "metadata": {"analysis": a},
        })

    durations = _durations(target, style)
    usage, shots, cursor, last_input = {}, [], 0.0, None
    max_ramps = 1 if style == "LUXURY_CINEMATIC" else 2
    ramps = 0
    for idx, duration in enumerate(durations):
        min_span = max(0.72, duration * 1.05)
        c = _pick(pool, usage, last_input, min_span)
        usage[c["input"]] = usage.get(c["input"], 0) + 1
        last_input = c["input"]

        source_span = min(float(c["end"]) - float(c["start"]), max(duration * 1.04, duration + 0.12))
        trim_in = float(c["start"])
        # Avoid always starting exactly on the detector boundary.
        headroom = max(0.0, (float(c["end"]) - float(c["start"])) - source_span)
        if headroom > 0.20:
            trim_in += min(0.14, headroom * 0.35)
        trim_out = trim_in + source_span

        effects = [
            {"kind": "smart_reframe", "enabled": True, "provider": "ffmpeg"},
            {"kind": "color_match", "enabled": True, "provider": "ffmpeg", "intensity": 0.45},
        ]
        # Speed ramps are accents, not the default. Never pair them with a dissolve.
        allow_ramp = ramps < max_ramps and duration >= 1.35 and source_span >= 1.65 and idx in ({3} if style == "LUXURY_CINEMATIC" else {2, 7})
        if allow_ramp:
            effects.extend([
                {"kind": "speed_ramp", "enabled": True, "provider": "ffmpeg", "intensity": 0.32},
                {"kind": "motion_blur", "enabled": True, "provider": "ffmpeg", "intensity": 0.18},
            ])
            ramps += 1

        stage = "VISUAL_HOOK" if cursor < target * 0.14 else "PROPERTY_TOUR" if cursor < target * 0.72 else "COMMERCIAL_SAFE" if cursor < target * 0.90 else "BRANDED_CLOSE"
        shots.append({
            "id": f"shot-{idx + 1}", "type": "video", "assetId": c["assetId"], "stage": stage,
            "start": round(cursor, 3), "duration": duration, "trimIn": round(trim_in, 3), "trimOut": round(trim_out, 3),
            "speed": round(source_span / max(duration, 0.1), 3), "fit": "cover", "volume": 0.0,
            "effects": effects,
            # Hard cut is the professional default. No automatic dissolve/whip carousel.
            "transitionIn": None if idx == 0 else {"kind": "cut", "duration": 0.0},
            "metadata": {"selectionReason": c.get("reason", []), "directorScore": round(c["v42_score"], 2)},
        })
        cursor += duration

    product = _valid_copy(job.get("product_name"))
    location = _valid_copy(_value(job, "address", "location", "localizacao", "bairro", "city", "cidade"))
    area = _valid_copy(_value(job, "area", "area_m2", "metragem"))
    price_copy = _valid_copy(price)
    client = _valid_copy((((job.get("client_context") or {}).get("client") or {}).get("name")))
    explicit_cta = _valid_copy(_value(job, "cta", "call_to_action", "whatsapp_cta"))

    texts = []
    def add(text, start, duration, y, size, role):
        text = _valid_copy(text)
        if not text:
            return
        texts.append({
            "id": f"text-{len(texts)+1}", "type": "text", "stage": role,
            "start": round(start, 3), "duration": round(duration, 3), "text": text,
            "fontFamily": "DejaVu Sans", "fontSize": size, "fontWeight": 700,
            "color": "#FFFFFF", "align": "left", "x": 92, "y": y, "maxWidth": 880,
            "animationIn": {"preset": "fade", "duration": 0.18, "easing": "ease_out"},
            "animationOut": {"preset": "fade", "duration": 0.14, "easing": "ease_in"},
            "shadow": {"color": "#00000099", "blur": 12, "x": 0, "y": 3},
        })

    # Copy appears only when backed by actual job data. No invented slogan/CTA.
    add(product or location, 0.18, min(2.2, target * 0.15), 300, 66, "VISUAL_HOOK")
    if area:
        add(area, target * 0.46, min(1.8, target * 0.11), 1330, 48, "PROPERTY_TOUR")
    if price_copy:
        add(price_copy, target * 0.74, min(2.1, target * 0.13), 1320, 60, "COMMERCIAL_SAFE")
    if explicit_cta:
        add(explicit_cta, target * 0.89, target * 0.10, 1380, 54, "BRANDED_CLOSE")
    elif client:
        add(client, target * 0.91, target * 0.075, 1400, 46, "BRANDED_CLOSE")

    timeline = {
        "version": "timeline-v1", "jobId": job["id"], "createdAt": datetime.now(timezone.utc).isoformat(),
        "strategyVersion": job.get("strategy_version") or "dynamic-strategy-v3",
        "directorVersion": "creative-director-v4.2.0", "style": style,
        "canvas": {"width": 1080, "height": 1920, "fps": 30, "aspectRatio": "9:16", "background": "#000000"},
        "safeZone": {"top": 240, "right": 80, "bottom": 320, "left": 80}, "duration": target,
        "assets": assets,
        "tracks": [
            {"id": "video-main", "kind": "video", "name": "Main picture", "items": shots},
            {"id": "text-main", "kind": "text", "name": "Editorial copy", "items": texts},
        ],
        "render": {"container": "mp4", "videoCodec": "h264", "audioCodec": "aac", "videoBitrateMbps": 10, "audioBitrateKbps": 192, "pixelFormat": "yuv420p"},
        "metadata": {"clientId": job.get("client_id"), "productId": job.get("product_id"), "contextVersion": job.get("context_version"), "generatedBy": "creative-director-v4.2", "warnings": []},
    }
    validate_creative_timeline(timeline)
    return timeline


def validate_creative_timeline(timeline):
    videos = next((t.get("items", []) for t in timeline.get("tracks", []) if t.get("kind") == "video"), [])
    texts = next((t.get("items", []) for t in timeline.get("tracks", []) if t.get("kind") == "text"), [])
    if len(videos) < 5:
        raise RuntimeError("creative_qa_fail:not_enough_shots")
    visible_transitions = [v for v in videos[1:] if (v.get("transitionIn") or {}).get("kind") not in (None, "cut")]
    if len(visible_transitions) > max(1, math.floor(len(videos) * 0.18)):
        raise RuntimeError("creative_qa_fail:transition_density")
    ramps = sum(1 for v in videos if any(e.get("kind") == "speed_ramp" and e.get("enabled", True) for e in v.get("effects", [])))
    if ramps > 2:
        raise RuntimeError("creative_qa_fail:speed_ramp_density")
    for t in texts:
        if str(t.get("text", "")).strip().lower() in BANNED_GENERIC_COPY:
            raise RuntimeError("creative_qa_fail:generic_copy")
    counts = {}
    for v in videos:
        counts[v["assetId"]] = counts.get(v["assetId"], 0) + 1
    if len(counts) >= 3 and max(counts.values()) / len(videos) > 0.55:
        raise RuntimeError("creative_qa_fail:source_dominance")
    return {"pass": True, "visible_transitions": len(visible_transitions), "speed_ramps": ramps, "text_items": len(texts), "source_usage": counts}
