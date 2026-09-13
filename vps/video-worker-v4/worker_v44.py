#!/usr/bin/env python3
from __future__ import annotations

import worker as w
import worker_v431  # installs the V4.3.1 director/render/QA stack
import learning_v43 as learning

w.VERSION = "4.4.0"
VERSION = w.VERSION
_BASE_BUILD = w.build_timeline
_BASE_RENDER = w.render_timeline

def build_timeline(job, inputs, analyses):
    timeline = _BASE_BUILD(job, inputs, analyses)
    timeline["directorVersion"] = "creative-director-v4.4.0"
    timeline.setdefault("metadata", {})["rendererVersion"] = VERSION
    timeline["metadata"]["vfxEngine"] = "local-vfx-v4.4.0"
    timeline["metadata"]["learningVector"] = learning.timeline_feature_vector(timeline)
    return timeline

def render_timeline(paths, analyses, timeline, jobdir, out):
    result = _BASE_RENDER(paths, analyses, timeline, jobdir, out)
    result["renderer_version"] = VERSION
    result["director_version"] = timeline.get("directorVersion")
    result["vfx_engine"] = "local-vfx-v4.4.0"
    return result

w.build_timeline = build_timeline
w.render_timeline = render_timeline

if __name__ == "__main__":
    w.daemon()
