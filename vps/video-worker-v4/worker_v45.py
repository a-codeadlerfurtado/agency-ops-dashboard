#!/usr/bin/env python3
from __future__ import annotations

import copy
import os
from pathlib import Path

import worker as w
import worker_v44  # installs the stable V4.4 renderer stack
import worker_v43 as w43
import director_v43 as d43
import dna_v45 as dna45
import critic_v45 as critic45
import learning_v43 as learning

w.VERSION = "4.5.0"
VERSION = w.VERSION
_BASE_BUILD = w.build_timeline
_BASE_RENDER = w.render_timeline
_BASE_QA = w.qa
_CRITIC_RESULTS = {}

SERIF_FONT = os.getenv(
    "VIDEO_SERIF_FONT_FILE",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
)


def _runtime_job(timeline):
    ctx = (timeline.get("metadata") or {}).get("criticContext") or {}
    refs = [{"id": x} for x in (ctx.get("referenceIds") or [])]
    pc = {"price": "present"} if ctx.get("hasPrice") else {}
    return {
        "_selected_dna_profile": {"id": ctx.get("dnaProfileId"), "dna": ctx.get("dna") or {}},
        "_reference_pack": {"references": refs},
        "product_context": pc,
    }


def _validate_v45(timeline):
    tracks = timeline.get("tracks") or []
    videos = next((t.get("items", []) for t in tracks if t.get("kind") == "video"), [])
    texts = next((t.get("items", []) for t in tracks if t.get("kind") == "text"), [])
    if len(videos) < 6:
        raise RuntimeError("creative_qa_fail:not_enough_shots")
    exact = set()
    for row in videos:
        key = (row.get("assetId"), round(float(row.get("trimIn") or 0), 2), round(float(row.get("trimOut") or 0), 2))
        if key in exact:
            raise RuntimeError("creative_qa_fail:duplicate_source_window")
        exact.add(key)
    for row in texts:
        y = float(row.get("y") or 0)
        if y < 220 or y > 1540:
            raise RuntimeError("creative_qa_fail:text_safe_zone")
    visible = sum(1 for row in videos[1:] if (row.get("transitionIn") or {}).get("kind") not in (None, "cut"))
    return {"pass": True, "shots": len(videos), "visible_transitions": visible}


d43.validate_creative_timeline = _validate_v45


def build_timeline(job, inputs, analyses):
    prepared = dna45.prepare_job(job)
    dna = (prepared.get("_selected_dna_profile") or {}).get("dna") or {}
    style = str((prepared.get("edit_strategy") or {}).get("style") or "")
    original = copy.deepcopy(d43.STYLE_PROFILES.get(style)) if style in d43.STYLE_PROFILES else None
    if original:
        avg = max(0.8, float(dna.get("avg_shot_duration") or 2.5))
        tuned = dict(original)
        tuned["pace"] = [avg * 0.78, avg * 0.92, avg * 1.05, avg * 1.16]
        tuned["visible_transitions"] = int(dna.get("max_visible_transitions", 1))
        tuned["ramps"] = int(dna.get("max_speed_ramps", 0))
        tuned["pushes"] = int(dna.get("cinematic_pushes", original.get("pushes", 1)))
        d43.STYLE_PROFILES[style] = tuned
    try:
        timeline = _BASE_BUILD(prepared, inputs, analyses)
    finally:
        if original:
            d43.STYLE_PROFILES[style] = original
    timeline = dna45.apply_profile(prepared, timeline)
    timeline.setdefault("metadata", {})["rendererVersion"] = VERSION
    timeline["metadata"]["learningVector"] = learning.timeline_feature_vector(timeline)
    return timeline


def _text_filter_v45(current, item, idx, caption=False):
    text = w43._esc(item.get("text", ""))[:220]
    start = float(item.get("start") or 0)
    end = start + float(item.get("duration") or 1)
    size = max(26, min(88, int(item.get("fontSize") or (44 if caption else 56))))
    x = int(item.get("x") or (100 if caption else 92))
    y = int(item.get("y") or (1460 if caption else 330))
    subtype = str(item.get("subtype") or "")
    font = SERIF_FONT if str(item.get("fontRole") or "").lower() == "serif" else w.FONT
    opacity = max(0.0, min(0.75, float(item.get("boxOpacity") or 0)))
    nxt = f"txt{idx}"
    if caption:
        xexpr = "(w-text_w)/2"
        box = "box=1:boxcolor=black@0.42:boxborderw=13:"
        yexpr = str(y)
        alpha = "1"
    else:
        xexpr = str(x)
        yexpr = f"{y}+34*if(lt(t\\,{start+0.18:.3f})\\,1-(t-{start:.3f})/.18\\,0)"
        alpha = f"if(lt(t\\,{start+0.16:.3f})\\,(t-{start:.3f})/.16\\,if(gt(t\\,{end-0.14:.3f})\\,({end:.3f}-t)/.14\\,1))"
        auto_box = subtype in ("price_card", "feature_callout", "brand_outro")
        box = f"box=1:boxcolor=black@{opacity or 0.34:.2f}:boxborderw=16:" if (opacity > 0 or auto_box) else ""

    filt = (
        f"[{current}]drawtext=fontfile='{font}':text='{text}':fontcolor=white:"
        f"fontsize={size}:x='{xexpr}':y='{yexpr}':alpha='{alpha}':{box}"
        f"shadowcolor=black@0.72:shadowx=3:shadowy=4:"
        f"enable='between(t,{start:.3f},{end:.3f})'[{nxt}]"
    )
    return filt, nxt


w43._text_filter = _text_filter_v45


def render_timeline(paths, analyses, timeline, jobdir, out):
    result = _BASE_RENDER(paths, analyses, timeline, jobdir, out)
    job = _runtime_job(timeline)
    qa1 = _BASE_QA(out, float(timeline.get("duration") or 30))
    critic = critic45.evaluate(job, timeline, qa1)
    attempts = 1
    if critic.get("status") == "REVISE":
        revised = critic45.revise_timeline(job, timeline, critic)
        timeline.clear()
        timeline.update(revised)
        result = _BASE_RENDER(paths, analyses, timeline, jobdir, out)
        qa2 = _BASE_QA(out, float(timeline.get("duration") or 30))
        critic = critic45.evaluate(job, timeline, qa2)
        attempts = 2
    critic["attempts"] = attempts
    _CRITIC_RESULTS[str(Path(out))] = critic
    result["renderer_version"] = VERSION
    result["director_version"] = timeline.get("directorVersion")
    result["approved_reference_critic"] = critic
    return result


def qa(path, target):
    base = _BASE_QA(path, target)
    critic = _CRITIC_RESULTS.get(str(Path(path)))
    if critic:
        checks = dict(base.get("checks") or {})
        checks["approved_reference_critic"] = critic.get("status") == "PASS"
        base["checks"] = checks
        base["approved_reference_critic"] = critic
        base["pass"] = bool(base.get("pass")) and critic.get("status") == "PASS"
        base["qa_version"] = "video-qa-v4.5.0"
    return base


w.build_timeline = build_timeline
w.render_timeline = render_timeline
w.qa = qa

if __name__ == "__main__":
    w.daemon()
