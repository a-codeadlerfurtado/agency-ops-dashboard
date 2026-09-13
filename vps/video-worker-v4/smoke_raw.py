#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import worker as w


def env_json(name: str):
    raw = os.getenv(name, "").strip()
    if not raw:
        raise RuntimeError(f"{name}_missing")
    return json.loads(raw)


def main() -> int:
    raw_inputs = env_json("SMOKE_INPUTS_JSON")
    if not isinstance(raw_inputs, list) or len(raw_inputs) < 2:
        raise RuntimeError("smoke_inputs_need_at_least_two_videos")

    inputs = []
    for idx, item in enumerate(raw_inputs):
        drive_file_id = str(item.get("drive_file_id") or "").strip()
        file_name = str(item.get("file_name") or f"input-{idx}.mp4").strip()
        if not drive_file_id:
            raise RuntimeError(f"drive_file_id_missing:{idx}")
        inputs.append({
            "id": f"raw-{idx+1}",
            "asset_id": f"raw-smoke-{idx+1}",
            "drive_file_id": drive_file_id,
            "file_name": file_name,
        })

    target = max(12.0, min(30.0, float(os.getenv("SMOKE_DURATION_SECONDS", "22"))))
    product_name = os.getenv("SMOKE_PRODUCT_NAME", "Imóvel — teste V4 com brutos reais")
    output_folder = os.getenv("SMOKE_OUTPUT_FOLDER_ID", "").strip()
    if not output_folder:
        raise RuntimeError("SMOKE_OUTPUT_FOLDER_ID_missing")

    job_id = "v4-direct-smoke-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    job = {
        "id": job_id,
        "client_id": "shadow-test",
        "product_id": "raw-property-test",
        "product_name": product_name,
        "strategy_version": "dynamic-strategy-v3",
        "context_version": "direct-smoke-v4",
        "product_context": {
            "price": os.getenv("SMOKE_PRICE", "R$ 3.500.000"),
            "area": os.getenv("SMOKE_AREA", "220 m²"),
            "address": os.getenv("SMOKE_ADDRESS", "Imóvel em destaque"),
            "target_duration_seconds": target,
        },
        "client_context": {"client": {"name": "V4 RAW TEST"}, "fields": {}},
        "edit_strategy": {
            "version": "dynamic-strategy-v3",
            "target_duration_seconds": target,
            "aspect_ratio": "9:16",
            "stages": [
                {"role": "VISUAL_HOOK", "from": 0, "to": target * 0.10},
                {"role": "PRIMARY_BENEFIT", "from": target * 0.10, "to": target * 0.28},
                {"role": "PROPERTY_TOUR", "from": target * 0.28, "to": target * 0.73},
                {"role": "COMMERCIAL_SAFE", "from": target * 0.73, "to": target * 0.88},
                {"role": "BRANDED_CLOSE", "from": target * 0.88, "to": target},
            ],
        },
        "output_drive_folder_id": output_folder,
    }

    jobdir = Path(tempfile.mkdtemp(prefix="v4-direct-smoke-", dir=w.WORK))
    try:
        paths = []
        total = 0
        for idx, item in enumerate(inputs):
            path = jobdir / (str(idx) + "-" + item["file_name"])
            w.drive_download(item["drive_file_id"], path)
            total += path.stat().st_size
            if total > w.MAX_JOB:
                raise RuntimeError("smoke_job_too_large")
            paths.append(path)
            print(json.dumps({"event": "downloaded", "file": item["file_name"], "bytes": path.stat().st_size}), flush=True)

        analyses = []
        for idx, path in enumerate(paths):
            analyses.append(w.temporal(path, jobdir, idx))
            print(json.dumps({"event": "analyzed", "file": inputs[idx]["file_name"], "duration": analyses[-1]["duration_seconds"]}), flush=True)

        timeline = w.build_timeline(job, inputs, analyses)
        output = jobdir / "V4_RAW_REAL_ESTATE_SMOKE_20260913.mp4"
        render_meta = w.render_timeline(paths, analyses, timeline, jobdir, output)
        report = w.qa(output, float(timeline["duration"]))
        print(json.dumps({"event": "qa", "pass": report["pass"], "checks": report["checks"], "render": render_meta}, ensure_ascii=False), flush=True)
        if not report["pass"]:
            raise RuntimeError("qa_failed:" + json.dumps(report["checks"]))

        uploaded = w.drive_upload(output, output.name, output_folder, job_id, "v4_raw_real_smoke")
        result = {
            "ok": True,
            "job_id": job_id,
            "drive_file_id": uploaded["id"],
            "drive_url": uploaded.get("webViewLink"),
            "qa": report,
            "render": render_meta,
            "timeline_style": timeline["style"],
            "timeline": timeline,
        }
        print("RESULT_JSON=" + json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    finally:
        shutil.rmtree(jobdir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
