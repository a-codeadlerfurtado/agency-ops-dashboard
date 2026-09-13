from __future__ import annotations

import statistics

LEARNING_VERSION = "edit-learning-vector-v4.3.0"


def _effects(videos, kind):
    return sum(1 for v in videos if any(e.get("kind") == kind and e.get("enabled", True) for e in v.get("effects", [])))


def timeline_feature_vector(timeline):
    tracks = timeline.get("tracks", [])
    videos = next((t.get("items", []) for t in tracks if t.get("kind") == "video"), [])
    texts = next((t.get("items", []) for t in tracks if t.get("kind") == "text"), [])
    vfx = next((t.get("items", []) for t in tracks if t.get("kind") == "vfx"), [])
    events = next((t.get("items", []) for t in tracks if t.get("kind") == "audio_event"), [])
    durations = [float(v.get("duration") or 0) for v in videos]
    transitions = [v for v in videos[1:] if (v.get("transitionIn") or {}).get("kind") not in (None, "cut")]
    quality = [float((v.get("metadata") or {}).get("qualityScore")) for v in videos if (v.get("metadata") or {}).get("qualityScore") is not None]
    sources = {v.get("assetId") for v in videos}
    music = (timeline.get("audioPlan") or {}).get("music") or {}
    subtypes = [str(t.get("subtype") or "") for t in texts]
    return {
        "version": LEARNING_VERSION,
        "job_id": timeline.get("jobId"),
        "director_version": timeline.get("directorVersion"),
        "style": timeline.get("style"),
        "duration": float(timeline.get("duration") or 0),
        "shots": len(videos),
        "source_assets": len(sources),
        "avg_shot_duration": round(statistics.mean(durations), 3) if durations else 0,
        "median_shot_duration": round(statistics.median(durations), 3) if durations else 0,
        "max_shot_duration": round(max(durations), 3) if durations else 0,
        "visible_transitions": len(transitions),
        "speed_ramps": _effects(videos, "speed_ramp"),
        "slow_motion": _effects(videos, "slow_motion"),
        "cinematic_pushes": _effects(videos, "cinematic_push"),
        "stabilized_shots": _effects(videos, "stabilization"),
        "lens_corrected_shots": _effects(videos, "lens_correction"),
        "graphics": len(texts),
        "has_price_card": "price_card" in subtypes,
        "has_feature_callout": "feature_callout" in subtypes,
        "has_brand_outro": "brand_outro" in subtypes,
        "sound_events": len(events),
        "music_bpm": music.get("bpm"),
        "vfx_requests": len(vfx),
        "mean_selected_quality": round(statistics.mean(quality), 2) if quality else None,
        "hook_asset": videos[0].get("assetId") if videos else None,
        "hook_duration": float(videos[0].get("duration") or 0) if videos else None,
    }
