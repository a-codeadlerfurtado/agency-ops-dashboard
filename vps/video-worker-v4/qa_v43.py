from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np

QA_VERSION = "video-qa-v4.3.0"


def _ahash(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (8, 8), interpolation=cv2.INTER_AREA)
    mean = float(small.mean())
    return (small >= mean).flatten().astype(np.uint8)


def _hamming(a, b):
    return int(np.count_nonzero(a != b))


def visual_checks(path, sample_count=30):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return {"available": False, "pass": False, "reason": "open_failed"}
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    if frames <= 0:
        cap.release()
        return {"available": False, "pass": False, "reason": "no_frames"}
    idxs = np.linspace(0, max(0, frames-1), min(sample_count, frames)).astype(int)
    hashes = []
    brightness = []
    sharpness = []
    for idx in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
        ok, frame = cap.read()
        if not ok:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        brightness.append(float(gray.mean()) / 255.0)
        sharpness.append(float(cv2.Laplacian(gray, cv2.CV_64F).var()))
        hashes.append(_ahash(frame))
    cap.release()
    if len(hashes) < 4:
        return {"available": False, "pass": False, "reason": "insufficient_samples"}
    distances = [_hamming(hashes[i-1], hashes[i]) for i in range(1, len(hashes))]
    frozen_pairs = sum(1 for d in distances if d <= 1)
    very_similar_pairs = sum(1 for d in distances if d <= 4)
    frozen_ratio = frozen_pairs / max(1, len(distances))
    similar_ratio = very_similar_pairs / max(1, len(distances))
    dark_ratio = sum(1 for x in brightness if x < 0.08) / max(1, len(brightness))
    blown_ratio = sum(1 for x in brightness if x > 0.94) / max(1, len(brightness))
    median_sharp = float(np.median(sharpness)) if sharpness else 0.0
    checks = {
        "not_frozen": frozen_ratio <= 0.34,
        "visual_variation": similar_ratio <= 0.72,
        "not_too_dark": dark_ratio <= 0.22,
        "not_blown_out": blown_ratio <= 0.22,
        "minimum_sharpness": median_sharp >= 12.0,
    }
    return {
        "available": True,
        "pass": all(checks.values()),
        "checks": checks,
        "sample_count": len(hashes),
        "frozen_ratio": round(frozen_ratio, 4),
        "similar_ratio": round(similar_ratio, 4),
        "brightness_median": round(float(np.median(brightness)), 4),
        "sharpness_median": round(median_sharp, 2),
        "dark_ratio": round(dark_ratio, 4),
        "blown_ratio": round(blown_ratio, 4),
    }


def combine(base_report, path):
    visual = visual_checks(path)
    checks = dict(base_report.get("checks") or {})
    if visual.get("available"):
        checks.update({f"creative_{k}": v for k, v in (visual.get("checks") or {}).items()})
    passed = bool(base_report.get("pass")) and bool(visual.get("pass"))
    return {
        **base_report,
        "checks": checks,
        "pass": passed,
        "qa_version": QA_VERSION,
        "creative_visual_qa": visual,
    }
