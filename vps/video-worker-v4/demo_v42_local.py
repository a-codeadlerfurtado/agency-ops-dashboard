#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

import worker as w
import worker_v421  # patches worker with V4.2.1
import director_v42 as d42


def main():
    if len(sys.argv) < 5:
        raise SystemExit("usage: demo_v42_local.py OUTPUT INPUT1 INPUT2 INPUT3 [INPUTN...]")
    output = Path(sys.argv[1]).resolve()
    paths = [Path(x).resolve() for x in sys.argv[2:]]
    jobdir = output.parent / "v42-demo-work"
    jobdir.mkdir(parents=True, exist_ok=True)

    inputs = []
    analyses = []
    for idx, p in enumerate(paths):
        if not p.exists():
            raise RuntimeError(f"missing_input:{p}")
        inputs.append({
            "id": f"demo-{idx+1}",
            "asset_id": f"demo-asset-{idx+1}",
            "drive_file_id": None,
            "file_name": p.name,
        })
        analyses.append(w.temporal(p, jobdir, idx))

    # Price is used only to select restrained luxury pacing. All stock-demo copy
    # is explicitly removed before rendering, so no property fact is asserted.
    job = {
        "id": "v421-public-demo",
        "client_id": "demo",
        "product_id": "demo",
        "product_name": "",
        "strategy_version": "dynamic-strategy-v3",
        "context_version": "public-demo-v421",
        "product_context": {"target_duration_seconds": 18, "price": "R$ 2.000.000"},
        "client_context": {"client": {}, "fields": {}},
        "edit_strategy": {"target_duration_seconds": 18},
    }
    timeline = w.build_timeline(job, inputs, analyses)
    for track in timeline["tracks"]:
        if track.get("kind") == "text":
            track["items"] = []
    creative = d42.validate_creative_timeline(timeline)
    render = w.render_timeline(paths, analyses, timeline, jobdir, output)
    qa = w.qa(output, float(timeline["duration"]))
    if not qa["pass"]:
        raise RuntimeError("technical_qa_failed:" + json.dumps(qa["checks"]))
    (output.parent / "V42_DEMO_TIMELINE.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding="utf-8")
    (output.parent / "V42_DEMO_QA.json").write_text(json.dumps({"technical": qa, "creative": creative, "render": render}, ensure_ascii=False, indent=2), encoding="utf-8")
    print("DEMO_OK=" + str(output))
    print("DIRECTOR=" + timeline["directorVersion"])
    print("CREATIVE_QA=" + json.dumps(creative, ensure_ascii=False))
    print("TECH_QA=" + json.dumps(qa, ensure_ascii=False))


if __name__ == "__main__":
    main()
