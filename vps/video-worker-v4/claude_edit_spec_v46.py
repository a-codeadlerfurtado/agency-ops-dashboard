from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone

SPEC_VERSION = "claude-edit-spec-v1"
DIRECTOR_VERSION = "claude-max-director-v4.6.0"

ALLOWED_STAGES = {
    "VISUAL_HOOK",
    "PROPERTY_TOUR",
    "PRIMARY_BENEFIT",
    "COMMERCIAL_SAFE",
    "BRANDED_CLOSE",
}
ALLOWED_TRANSITIONS = {"cut", "crossfade", "whip", "zoom", "match_motion"}
ALLOWED_EFFECTS = {
    "smart_reframe",
    "color_match",
    "white_balance",
    "stabilization",
    "highlight_soften",
    "lens_correction",
    "speed_ramp",
    "motion_blur",
    "cinematic_push",
    "slow_motion",
    "vignette",
}

EDIT_SPEC_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "spec_version",
        "creative_direction",
        "canvas",
        "clips",
        "on_screen_text",
        "captions",
        "narration",
        "music",
        "brand",
        "qa_notes",
    ],
    "properties": {
        "spec_version": {"type": "string", "const": SPEC_VERSION},
        "creative_direction": {
            "type": "object",
            "additionalProperties": False,
            "required": ["summary", "pacing", "reference_rationale"],
            "properties": {
                "summary": {"type": "string", "minLength": 1, "maxLength": 1200},
                "pacing": {
                    "type": "string",
                    "enum": ["cinematic", "balanced", "fast", "performance"],
                },
                "reference_rationale": {
                    "type": "array",
                    "maxItems": 12,
                    "items": {"type": "string", "maxLength": 500},
                },
            },
        },
        "canvas": {
            "type": "object",
            "additionalProperties": False,
            "required": ["width", "height", "fps", "aspect_ratio", "safe_zone"],
            "properties": {
                "width": {"type": "integer", "const": 1080},
                "height": {"type": "integer", "const": 1920},
                "fps": {"type": "integer", "const": 30},
                "aspect_ratio": {"type": "string", "const": "9:16"},
                "safe_zone": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["top", "right", "bottom", "left"],
                    "properties": {
                        "top": {"type": "integer", "minimum": 180, "maximum": 320},
                        "right": {"type": "integer", "minimum": 60, "maximum": 140},
                        "bottom": {"type": "integer", "minimum": 260, "maximum": 420},
                        "left": {"type": "integer", "minimum": 60, "maximum": 140},
                    },
                },
            },
        },
        "clips": {
            "type": "array",
            "minItems": 6,
            "maxItems": 40,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "asset_id",
                    "trim_in",
                    "trim_out",
                    "speed",
                    "volume",
                    "stage",
                    "transition_in",
                    "effects",
                    "reason",
                ],
                "properties": {
                    "asset_id": {"type": "string", "minLength": 1},
                    "trim_in": {"type": "number", "minimum": 0},
                    "trim_out": {"type": "number", "exclusiveMinimum": 0},
                    "speed": {"type": "number", "minimum": 0.65, "maximum": 1.6},
                    "volume": {"type": "number", "minimum": 0, "maximum": 1},
                    "stage": {"type": "string", "enum": sorted(ALLOWED_STAGES)},
                    "transition_in": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["kind", "duration"],
                        "properties": {
                            "kind": {"type": "string", "enum": sorted(ALLOWED_TRANSITIONS)},
                            "duration": {"type": "number", "minimum": 0, "maximum": 0.35},
                        },
                    },
                    "effects": {
                        "type": "array",
                        "maxItems": 8,
                        "items": {"type": "string", "enum": sorted(ALLOWED_EFFECTS)},
                    },
                    "reason": {"type": "string", "minLength": 1, "maxLength": 500},
                },
            },
        },
        "on_screen_text": {
            "type": "array",
            "maxItems": 12,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "text",
                    "start",
                    "duration",
                    "x",
                    "y",
                    "font_size",
                    "role",
                    "subtype",
                ],
                "properties": {
                    "text": {"type": "string", "minLength": 1, "maxLength": 180},
                    "start": {"type": "number", "minimum": 0},
                    "duration": {"type": "number", "minimum": 0.25, "maximum": 8},
                    "x": {"type": "integer", "minimum": 60, "maximum": 900},
                    "y": {"type": "integer", "minimum": 220, "maximum": 1540},
                    "font_size": {"type": "integer", "minimum": 26, "maximum": 88},
                    "role": {"type": "string", "enum": sorted(ALLOWED_STAGES)},
                    "subtype": {
                        "type": "string",
                        "enum": ["kinetic_text", "feature_callout", "price_card", "brand_outro", "lower_third"],
                    },
                },
            },
        },
        "captions": {
            "type": "array",
            "maxItems": 80,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["text", "start", "duration"],
                "properties": {
                    "text": {"type": "string", "minLength": 1, "maxLength": 180},
                    "start": {"type": "number", "minimum": 0},
                    "duration": {"type": "number", "minimum": 0.2, "maximum": 8},
                },
            },
        },
        "narration": {
            "type": "object",
            "additionalProperties": False,
            "required": ["enabled", "script", "voice_notes"],
            "properties": {
                "enabled": {"type": "boolean"},
                "script": {"type": "string", "maxLength": 5000},
                "voice_notes": {"type": "string", "maxLength": 1000},
            },
        },
        "music": {
            "type": "object",
            "additionalProperties": False,
            "required": ["enabled", "mood", "volume", "ducking"],
            "properties": {
                "enabled": {"type": "boolean"},
                "mood": {"type": "string", "maxLength": 300},
                "volume": {"type": "number", "minimum": 0, "maximum": 0.55},
                "ducking": {"type": "boolean"},
            },
        },
        "brand": {
            "type": "object",
            "additionalProperties": False,
            "required": ["cta", "closing_text", "visual_notes"],
            "properties": {
                "cta": {"type": "string", "maxLength": 180},
                "closing_text": {"type": "string", "maxLength": 180},
                "visual_notes": {"type": "string", "maxLength": 1000},
            },
        },
        "qa_notes": {
            "type": "array",
            "maxItems": 20,
            "items": {"type": "string", "maxLength": 500},
        },
    },
}


def schema_json() -> str:
    return json.dumps(EDIT_SPEC_SCHEMA, separators=(",", ":"), ensure_ascii=False)


def _float(value, default=0.0):
    try:
        return float(value)
    except Exception:
        return float(default)


def _track(timeline, kind):
    return next((x for x in timeline.get("tracks", []) if x.get("kind") == kind), None)


def _asset_durations(inputs, analyses, baseline):
    durations = {}
    for asset in baseline.get("assets", []):
        aid = str(asset.get("id") or "")
        if aid:
            durations[aid] = _float(asset.get("duration"), 0)
    for idx, item in enumerate(inputs):
        aid = str(item.get("asset_id") or item.get("id") or "")
        if not aid:
            continue
        duration = 0.0
        if idx < len(analyses):
            duration = _float((analyses[idx] or {}).get("duration_seconds"), 0)
        duration = duration or _float(item.get("duration_seconds"), 0)
        if duration:
            durations[aid] = duration
    return durations


def validate_edit_spec(spec, inputs, analyses, baseline):
    if not isinstance(spec, dict):
        raise ValueError("claude_edit_spec_not_object")
    if spec.get("spec_version") != SPEC_VERSION:
        raise ValueError("claude_edit_spec_version_mismatch")

    canvas = spec.get("canvas") or {}
    if (canvas.get("width"), canvas.get("height"), canvas.get("fps"), canvas.get("aspect_ratio")) != (1080, 1920, 30, "9:16"):
        raise ValueError("claude_edit_spec_canvas_must_be_1080x1920_30_9x16")

    clips = spec.get("clips") or []
    if len(clips) < 6:
        raise ValueError("claude_edit_spec_requires_six_shots")

    durations = _asset_durations(inputs, analyses, baseline)
    allowed_assets = set(durations)
    exact_windows = set()
    total = 0.0
    for idx, row in enumerate(clips):
        aid = str(row.get("asset_id") or "")
        if aid not in allowed_assets:
            raise ValueError(f"claude_edit_spec_unknown_asset:{aid}")
        trim_in = _float(row.get("trim_in"))
        trim_out = _float(row.get("trim_out"))
        speed = _float(row.get("speed"), 1.0)
        if trim_out <= trim_in + 0.25:
            raise ValueError(f"claude_edit_spec_invalid_trim:{idx}")
        source_duration = durations.get(aid) or 0.0
        if source_duration and trim_out > source_duration + 0.30:
            raise ValueError(f"claude_edit_spec_trim_out_of_range:{idx}")
        if not (0.65 <= speed <= 1.6):
            raise ValueError(f"claude_edit_spec_speed_out_of_range:{idx}")
        key = (aid, round(trim_in, 2), round(trim_out, 2))
        if key in exact_windows:
            raise ValueError("claude_edit_spec_duplicate_source_window")
        exact_windows.add(key)
        stage = str(row.get("stage") or "")
        if stage not in ALLOWED_STAGES:
            raise ValueError(f"claude_edit_spec_bad_stage:{stage}")
        transition = row.get("transition_in") or {}
        kind = str(transition.get("kind") or "cut")
        if kind not in ALLOWED_TRANSITIONS:
            raise ValueError(f"claude_edit_spec_bad_transition:{kind}")
        for effect in row.get("effects") or []:
            if effect not in ALLOWED_EFFECTS:
                raise ValueError(f"claude_edit_spec_bad_effect:{effect}")
        total += (trim_out - trim_in) / speed

    if not 8.0 <= total <= 65.0:
        raise ValueError(f"claude_edit_spec_duration_out_of_range:{total:.3f}")

    for idx, row in enumerate(spec.get("on_screen_text") or []):
        y = int(row.get("y") or 0)
        if not 220 <= y <= 1540:
            raise ValueError(f"claude_edit_spec_text_safe_zone:{idx}")
        if _float(row.get("start")) + _float(row.get("duration")) > total + 2:
            raise ValueError(f"claude_edit_spec_text_after_end:{idx}")

    for idx, row in enumerate(spec.get("captions") or []):
        if _float(row.get("start")) + _float(row.get("duration")) > total + 2:
            raise ValueError(f"claude_edit_spec_caption_after_end:{idx}")

    return {"duration": round(total, 3), "assets": sorted(allowed_assets), "shots": len(clips)}


def _effect(kind):
    params = {}
    if kind == "speed_ramp":
        params = {"intensity": 0.42}
    elif kind == "motion_blur":
        params = {"intensity": 0.18}
    elif kind == "cinematic_push":
        params = {"amount": 0.018}
    elif kind == "stabilization":
        params = {"strength": 0.55}
    elif kind == "highlight_soften":
        params = {"strength": 0.30}
    elif kind == "slow_motion":
        params = {"speed": 0.78}
    return {"kind": kind, "enabled": True, "provider": "ffmpeg", "params": params}


def _replace_track(timeline, kind, track):
    tracks = list(timeline.get("tracks") or [])
    for idx, existing in enumerate(tracks):
        if existing.get("kind") == kind:
            tracks[idx] = track
            timeline["tracks"] = tracks
            return
    tracks.append(track)
    timeline["tracks"] = tracks


def spec_to_timeline(spec, job, inputs, analyses, baseline, planner_meta=None):
    report = validate_edit_spec(spec, inputs, analyses, baseline)
    timeline = copy.deepcopy(baseline)
    canvas = spec["canvas"]
    timeline["canvas"] = {
        "width": 1080,
        "height": 1920,
        "fps": 30,
        "aspectRatio": "9:16",
        "background": "#000000",
    }
    safe = canvas["safe_zone"]
    timeline["safeZone"] = {
        "top": int(safe["top"]),
        "right": int(safe["right"]),
        "bottom": int(safe["bottom"]),
        "left": int(safe["left"]),
    }

    shots = []
    cursor = 0.0
    for idx, row in enumerate(spec["clips"]):
        trim_in = _float(row["trim_in"])
        trim_out = _float(row["trim_out"])
        speed = _float(row["speed"], 1.0)
        duration = (trim_out - trim_in) / speed
        transition = row.get("transition_in") or {"kind": "cut", "duration": 0}
        if idx == 0 or transition.get("kind") == "cut":
            transition_in = None if idx == 0 else {"kind": "cut", "duration": 0.0}
        else:
            transition_in = {
                "kind": str(transition.get("kind") or "crossfade"),
                "duration": round(min(0.35, max(0.06, _float(transition.get("duration"), 0.10))), 3),
            }
        effects = list(dict.fromkeys(["smart_reframe", "color_match", "white_balance"] + list(row.get("effects") or [])))
        shots.append({
            "id": f"claude-shot-{idx+1}",
            "type": "video",
            "assetId": str(row["asset_id"]),
            "stage": str(row["stage"]),
            "start": round(cursor, 3),
            "duration": round(duration, 3),
            "trimIn": round(trim_in, 3),
            "trimOut": round(trim_out, 3),
            "speed": round(speed, 3),
            "fit": "cover",
            "volume": round(max(0.0, min(1.0, _float(row.get("volume"), 0.10))), 3),
            "effects": [_effect(x) for x in effects],
            "transitionIn": transition_in,
            "metadata": {
                "selectionReason": [str(row.get("reason") or "")],
                "selectedBy": DIRECTOR_VERSION,
            },
        })
        cursor += duration

    text_items = []
    for idx, row in enumerate(spec.get("on_screen_text") or []):
        text_items.append({
            "id": f"claude-text-{idx+1}",
            "type": "text",
            "subtype": str(row["subtype"]),
            "stage": str(row["role"]),
            "start": round(_float(row["start"]), 3),
            "duration": round(_float(row["duration"]), 3),
            "text": str(row["text"])[:180],
            "fontFamily": "DejaVu Sans",
            "fontSize": int(row["font_size"]),
            "fontWeight": 700,
            "color": "#FFFFFF",
            "align": "left",
            "x": int(row["x"]),
            "y": int(row["y"]),
            "maxWidth": 880,
            "animationIn": {"preset": "slide_up", "duration": 0.18, "easing": "ease_out_cubic"},
            "animationOut": {"preset": "fade", "duration": 0.13, "easing": "ease_in"},
            "shadow": {"color": "#000000AA", "blur": 14, "x": 0, "y": 4},
        })

    brand = spec.get("brand") or {}
    close_text = str(brand.get("closing_text") or brand.get("cta") or "").strip()
    if close_text and not any(x.get("subtype") == "brand_outro" for x in text_items):
        text_items.append({
            "id": "claude-brand-close",
            "type": "text",
            "subtype": "brand_outro",
            "stage": "BRANDED_CLOSE",
            "start": round(max(0.0, cursor - min(3.0, cursor * 0.10)), 3),
            "duration": round(min(2.8, max(0.7, cursor * 0.08)), 3),
            "text": close_text[:180],
            "fontFamily": "DejaVu Sans",
            "fontSize": 48,
            "fontWeight": 700,
            "color": "#FFFFFF",
            "align": "left",
            "x": 92,
            "y": 1390,
            "maxWidth": 880,
            "animationIn": {"preset": "slide_up", "duration": 0.18, "easing": "ease_out_cubic"},
            "animationOut": {"preset": "fade", "duration": 0.13, "easing": "ease_in"},
            "shadow": {"color": "#000000AA", "blur": 14, "x": 0, "y": 4},
        })

    captions = []
    for idx, row in enumerate(spec.get("captions") or []):
        captions.append({
            "id": f"claude-caption-{idx+1}",
            "type": "caption",
            "text": str(row["text"])[:180],
            "start": round(_float(row["start"]), 3),
            "duration": round(_float(row["duration"]), 3),
            "x": 100,
            "y": 1460,
            "fontSize": 44,
            "maxWidth": 880,
        })

    audio_events = []
    for shot in shots[1:]:
        transition = shot.get("transitionIn") or {}
        if transition.get("kind") in {"whip", "zoom", "match_motion"}:
            audio_events.append({
                "id": f"claude-sfx-{shot['id']}",
                "type": "whoosh",
                "start": round(float(shot["start"]), 3),
                "gain": 0.10,
            })

    _replace_track(timeline, "video", {"id": "video-main", "kind": "video", "name": "Claude directed picture", "items": shots})
    _replace_track(timeline, "text", {"id": "graphics-main", "kind": "text", "name": "Claude directed graphics", "items": text_items})
    _replace_track(timeline, "caption", {"id": "captions", "kind": "caption", "name": "Claude directed captions", "items": captions})
    _replace_track(timeline, "audio_event", {"id": "audio-events", "kind": "audio_event", "name": "Claude directed sound design", "items": audio_events})

    baseline_music = copy.deepcopy((timeline.get("audioPlan") or {}).get("music") or {})
    music = spec.get("music") or {}
    if music.get("enabled") and baseline_music:
        baseline_music["volume"] = round(_float(music.get("volume"), 0.23), 3)
        baseline_music["mood"] = str(music.get("mood") or "")
    elif not music.get("enabled"):
        baseline_music = {}
    timeline["audioPlan"] = {
        "music": baseline_music,
        "ducking": bool(music.get("ducking", True)),
        "events": audio_events,
    }

    timeline["brandPlan"] = {
        **(timeline.get("brandPlan") or {}),
        "cta": str(brand.get("cta") or ""),
        "closingText": str(brand.get("closing_text") or ""),
        "visualNotes": str(brand.get("visual_notes") or ""),
    }
    timeline["duration"] = round(cursor, 3)
    timeline["directorVersion"] = DIRECTOR_VERSION
    timeline["strategyVersion"] = SPEC_VERSION
    timeline["style"] = str((spec.get("creative_direction") or {}).get("pacing") or "balanced").upper()
    timeline.setdefault("metadata", {}).update({
        "generatedBy": DIRECTOR_VERSION,
        "claudeBrain": {
            "enabled": True,
            "specVersion": SPEC_VERSION,
            "specHash": hashlib.sha256(json.dumps(spec, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
            "direction": spec.get("creative_direction") or {},
            "narration": spec.get("narration") or {},
            "brand": brand,
            "qaNotes": spec.get("qa_notes") or [],
            "validation": report,
            **(planner_meta or {}),
        },
        "requiresHumanReview": True,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    })
    return timeline
