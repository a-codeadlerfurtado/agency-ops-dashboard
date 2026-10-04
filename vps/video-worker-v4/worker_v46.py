#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import os

import worker as w
import worker_v45  # installs the stable V4.5 stack first
import claude_brain_v46 as claude_brain
import claude_edit_spec_v46 as edit_spec

VERSION = "4.6.0"
w.VERSION = VERSION

_BASE_BUILD = w.build_timeline
_BASE_RENDER = w.render_timeline
_BASE_DOWNLOAD = w.drive_download
_BASE_HTTP_JSON = w.http_json

_INPUT_PATHS = {}
CLAUDE_ENABLED = str(os.getenv("VIDEO_CLAUDE_ENABLED", "false")).lower() in {"1", "true", "yes", "on"}
CLAUDE_VARIANT_FILTER = os.getenv("VIDEO_CLAUDE_VARIANT_FILTER", "v4_claude_test").strip() or "v4_claude_test"
CLAUDE_FAIL_OPEN = str(os.getenv("VIDEO_CLAUDE_FAIL_OPEN", "false")).lower() in {"1", "true", "yes", "on"}

if CLAUDE_ENABLED and CLAUDE_VARIANT_FILTER == "v4_auto":
    raise RuntimeError("claude_variant_filter_must_not_be_v4_auto")


def drive_download(file_id, dst):
    result = _BASE_DOWNLOAD(file_id, dst)
    _INPUT_PATHS[str(file_id)] = str(dst)
    return result


def http_json(url, method="GET", headers=None, body=None):
    payload = copy.deepcopy(body) if isinstance(body, dict) else body
    if isinstance(payload, dict) and payload.get("action") == "claim":
        if not CLAUDE_ENABLED:
            return {"ok": True, "render_job": None, "reason": "claude_worker_disabled"}
        payload["variant"] = CLAUDE_VARIANT_FILTER
    return _BASE_HTTP_JSON(url, method, headers, payload)


def build_timeline(job, inputs, analyses):
    baseline = _BASE_BUILD(job, inputs, analyses)
    render_context = job.get("_render_context") or {}
    variant = str(render_context.get("variant") or "")
    if not CLAUDE_ENABLED:
        baseline.setdefault("metadata", {})["claudeBrain"] = {
            "enabled": False,
            "brainVersion": claude_brain.BRAIN_VERSION,
            "reason": "disabled",
        }
        return baseline
    if variant != CLAUDE_VARIANT_FILTER:
        raise RuntimeError(
            f"claude_worker_variant_mismatch:expected={CLAUDE_VARIANT_FILTER}:got={variant or 'missing'}"
        )

    try:
        spec, planner_meta = claude_brain.plan(
            job,
            inputs,
            analyses,
            baseline,
            _INPUT_PATHS,
            _BASE_DOWNLOAD,
        )
        timeline = edit_spec.spec_to_timeline(
            spec,
            job,
            inputs,
            analyses,
            baseline,
            planner_meta,
        )
        timeline.setdefault("metadata", {})["renderVariant"] = variant
        timeline["metadata"]["requiresHumanReview"] = True
        return timeline
    except Exception as exc:
        print(json.dumps({
            "event": "claude_edit_plan_failed",
            "brain_version": claude_brain.BRAIN_VERSION,
            "variant": variant,
            "error": str(exc)[:1600],
            "fail_open": CLAUDE_FAIL_OPEN,
        }, ensure_ascii=False), flush=True)
        if not CLAUDE_FAIL_OPEN:
            raise
        baseline.setdefault("metadata", {})["claudeBrain"] = {
            "enabled": False,
            "brainVersion": claude_brain.BRAIN_VERSION,
            "reason": "planner_failed_fallback_v45",
            "error": str(exc)[:700],
            "humanReviewRequired": True,
        }
        baseline["metadata"]["renderVariant"] = variant
        baseline["metadata"]["requiresHumanReview"] = True
        return baseline


def render_timeline(paths, analyses, timeline, jobdir, out):
    result = _BASE_RENDER(paths, analyses, timeline, jobdir, out)
    result["renderer_version"] = VERSION
    brain_meta = (timeline.get("metadata") or {}).get("claudeBrain") or {}
    result["claude_brain"] = {
        "enabled": bool(brain_meta.get("enabled")),
        "brainVersion": brain_meta.get("brainVersion"),
        "model": brain_meta.get("model"),
        "authMethod": brain_meta.get("authMethod"),
        "subscriptionType": brain_meta.get("subscriptionType"),
        "elapsedMs": brain_meta.get("elapsedMs"),
        "referenceCount": brain_meta.get("referenceCount"),
        "promptHash": brain_meta.get("promptHash"),
        "humanReviewRequired": True,
    }
    return result


w.drive_download = drive_download
w.http_json = http_json
w.build_timeline = build_timeline
w.render_timeline = render_timeline

if __name__ == "__main__":
    print(json.dumps({
        "event": "video_worker_start",
        "version": VERSION,
        "claude_enabled": CLAUDE_ENABLED,
        "variant_filter": CLAUDE_VARIANT_FILTER,
        "fail_open": CLAUDE_FAIL_OPEN,
    }), flush=True)
    w.daemon()
