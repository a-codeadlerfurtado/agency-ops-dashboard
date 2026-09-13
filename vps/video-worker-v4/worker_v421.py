#!/usr/bin/env python3
from __future__ import annotations

from collections import defaultdict

import worker as w
import worker_v42  # installs V4.2 render/director path

w.VERSION = "4.2.1"
_old_build = w.build_timeline


def _diversify_repeated_windows(timeline):
    videos = next((t.get("items", []) for t in timeline.get("tracks", []) if t.get("kind") == "video"), [])
    duration_by_asset = {str(a["id"]): float(a.get("duration") or 0) for a in timeline.get("assets", [])}
    groups = defaultdict(list)
    for item in videos:
        groups[str(item["assetId"])].append(item)

    for asset_id, items in groups.items():
        if len(items) < 2:
            continue
        source_duration = duration_by_asset.get(asset_id, 0.0)
        if source_duration <= 0:
            continue
        starts = [float(x.get("trimIn") or 0) for x in items]
        # Preserve director-selected distinct scenes. Only spread windows when the
        # repeated edits are effectively pulling the same source region.
        if max(starts) - min(starts) > 0.45:
            continue
        spans = [max(0.55, float(x.get("trimOut") or 0) - float(x.get("trimIn") or 0)) for x in items]
        max_span = max(spans)
        usable_end = source_duration - max_span - 0.12
        if usable_end <= 0.8:
            continue
        first = 0.12
        for idx, (item, span) in enumerate(zip(items, spans)):
            ratio = idx / max(1, len(items) - 1)
            start = first + (usable_end - first) * ratio
            # Keep a small margin from absolute scene ends.
            start = max(0.08, min(start, source_duration - span - 0.08))
            item["trimIn"] = round(start, 3)
            item["trimOut"] = round(start + span, 3)
            item.setdefault("metadata", {})["windowDiversified"] = True
            item["metadata"]["sourceWindowIndex"] = idx + 1
            item["metadata"]["sourceWindowCount"] = len(items)
    return timeline


def build_timeline(job, inputs, analyses):
    timeline = _old_build(job, inputs, analyses)
    timeline = _diversify_repeated_windows(timeline)
    timeline["directorVersion"] = "creative-director-v4.2.1"
    timeline.setdefault("metadata", {})["sourceWindowDiversification"] = True
    return timeline


w.build_timeline = build_timeline

if __name__ == "__main__":
    w.daemon()
