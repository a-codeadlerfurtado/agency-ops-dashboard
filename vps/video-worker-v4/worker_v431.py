#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

import worker as w
import worker_v43  # installs V4.3 renderer/vision/director
import director_v43 as d43
import learning_v43 as learning
import qa_v43
import variants_v43 as variants

w.VERSION = "4.3.1"
VERSION = w.VERSION

_BASE_BUILD = w.build_timeline
_BASE_RENDER = w.render_timeline
_BASE_QA = w.qa


def _nearest_beat(beats, t, radius):
    if not beats:
        return float(t)
    best = min((float(x) for x in beats), key=lambda x: abs(x-float(t)))
    return best if abs(best-float(t)) <= radius else float(t)


def _snap_cuts_to_beats(timeline):
    music = (timeline.get("audioPlan") or {}).get("music") or {}
    beats = music.get("beats") or []
    if not beats:
        return timeline
    videos = next((t.get("items", []) for t in timeline.get("tracks", []) if t.get("kind") == "video"), [])
    if len(videos) < 3:
        return timeline
    style = str(timeline.get("style") or "")
    radius = 0.08 if style in ("LUXURY_CINEMATIC", "ARCHITECTURAL") else 0.16
    target = float(timeline.get("duration") or sum(float(v.get("duration") or 0) for v in videos))
    original = [0.0] + [float(v.get("start") or 0) for v in videos[1:]] + [target]
    boundaries = [0.0]
    for i, t in enumerate(original[1:-1], start=1):
        remaining = len(videos) - i
        candidate = _nearest_beat(beats, t, radius)
        min_allowed = boundaries[-1] + 0.48
        max_allowed = target - remaining * 0.48
        if candidate < min_allowed or candidate > max_allowed:
            candidate = t
        candidate = max(min_allowed, min(max_allowed, candidate))
        boundaries.append(candidate)
    boundaries.append(target)
    snapped = 0
    for i, v in enumerate(videos):
        old_start = float(v.get("start") or 0)
        start = boundaries[i]
        end = boundaries[i+1]
        if abs(start-old_start) > 0.025:
            snapped += 1
        v["start"] = round(start, 3)
        v["duration"] = round(end-start, 3)
        span = max(0.05, float(v.get("trimOut") or 0)-float(v.get("trimIn") or 0))
        v["speed"] = round(span / max(0.1, end-start), 3)
    timeline.setdefault("metadata", {})["beatSync"] = {"enabled": True, "snappedBoundaries": snapped, "bpm": music.get("bpm")}
    return timeline


def _brand_plan(job):
    cc = job.get("client_context") or {}
    pc = job.get("product_context") or {}
    brand = cc.get("brand_profile") or cc.get("brand") or job.get("brand_context") or {}
    if not isinstance(brand, dict):
        brand = {}
    return {
        "logoPath": brand.get("logo_path") or brand.get("logoPath") or pc.get("logo_path"),
        "primaryColor": brand.get("primary_color") or brand.get("primaryColor") or "#FFFFFF",
        "secondaryColor": brand.get("secondary_color") or brand.get("secondaryColor") or "#000000",
        "accentColor": brand.get("accent_color") or brand.get("accentColor"),
        "fontFamily": brand.get("font_family") or brand.get("fontFamily") or "DejaVu Sans",
        "logoSafeMargin": int(brand.get("logo_safe_margin") or 78),
    }


def build_timeline(job, inputs, analyses):
    timeline = _BASE_BUILD(job, inputs, analyses)
    timeline = _snap_cuts_to_beats(timeline)
    timeline["brandPlan"] = _brand_plan(job)
    timeline["variantPlan"] = variants.plan_variants(job)
    timeline["directorVersion"] = "creative-director-v4.3.1"
    timeline.setdefault("metadata", {})["rendererVersion"] = VERSION
    timeline["metadata"]["learningVector"] = learning.timeline_feature_vector(timeline)
    d43.validate_creative_timeline(timeline)
    return timeline


def render_timeline(paths, analyses, timeline, jobdir, out):
    result = _BASE_RENDER(paths, analyses, timeline, jobdir, out)
    result["renderer_version"] = VERSION
    result["director_version"] = timeline.get("directorVersion")
    result["learning_vector"] = learning.timeline_feature_vector(timeline)
    result["variant_plan"] = timeline.get("variantPlan")
    return result


def qa(path, target):
    base = _BASE_QA(path, target)
    return qa_v43.combine(base, path)


w.build_timeline = build_timeline
w.render_timeline = render_timeline
w.qa = qa

if __name__ == "__main__":
    w.daemon()
