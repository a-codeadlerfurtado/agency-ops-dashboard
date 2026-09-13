from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np

VISION_VERSION = "vision-v4.3.0"


def _clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, float(v)))


def _frame_metrics(frame):
    if frame is None or frame.size == 0:
        return None
    small = cv2.resize(frame, (320, 568), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    brightness = float(gray.mean()) / 255.0
    contrast = float(gray.std()) / 96.0
    saturation = float(hsv[:, :, 1].mean()) / 255.0
    edges = cv2.Canny(gray, 70, 160)
    edge_density = float(np.count_nonzero(edges)) / float(edges.size)
    b, g, r = [float(x) / 255.0 for x in small.mean(axis=(0, 1))]
    color_sum = max(1e-6, r + g + b)
    wb = {
        "r": round((r / color_sum) * 3.0, 4),
        "g": round((g / color_sum) * 3.0, 4),
        "b": round((b / color_sum) * 3.0, 4),
    }
    focus_x = focus_y = 0.5
    focus_conf = 0.0
    try:
        sal = cv2.saliency.StaticSaliencySpectralResidual_create()
        ok, saliency = sal.computeSaliency(small)
        if ok:
            saliency = cv2.GaussianBlur(saliency, (0, 0), 3)
            _, mask = cv2.threshold((saliency * 255).astype(np.uint8), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            m = cv2.moments(mask)
            if m["m00"] > 1:
                focus_x = _clamp((m["m10"] / m["m00"]) / small.shape[1], 0.18, 0.82)
                focus_y = _clamp((m["m01"] / m["m00"]) / small.shape[0], 0.18, 0.82)
                focus_conf = _clamp(float(mask.mean()) / 80.0)
    except Exception:
        pass
    return {
        "brightness": brightness,
        "contrast": contrast,
        "saturation": saturation,
        "sharpness": sharp,
        "edge_density": edge_density,
        "focus_x": focus_x,
        "focus_y": focus_y,
        "focus_confidence": focus_conf,
        "white_balance": wb,
        "gray": gray,
    }


def _quality(m):
    if not m:
        return 0.0
    sharp = _clamp(math.log1p(max(0.0, m["sharpness"])) / 7.2)
    exposure = 1.0 - min(1.0, abs(m["brightness"] - 0.52) / 0.52)
    contrast = 1.0 - min(1.0, abs(m["contrast"] - 0.55) / 0.75)
    sat = 1.0 - min(1.0, abs(m["saturation"] - 0.32) / 0.55)
    detail = _clamp(m["edge_density"] / 0.16)
    return round(100.0 * (0.34 * sharp + 0.25 * exposure + 0.14 * contrast + 0.10 * sat + 0.17 * detail), 2)


def _motion(prev_gray, gray):
    if prev_gray is None or gray is None:
        return None
    flow = cv2.calcOpticalFlowFarneback(prev_gray, gray, None, 0.5, 3, 15, 3, 5, 1.2, 0)
    fx = flow[..., 0]
    fy = flow[..., 1]
    mag = np.sqrt(fx * fx + fy * fy)
    median_mag = float(np.median(mag))
    p90 = float(np.percentile(mag, 90))
    dx = float(np.median(fx))
    dy = float(np.median(fy))
    spread = float(np.median(np.abs(mag - median_mag)))
    consistency = 1.0 - _clamp(spread / max(0.15, p90))
    if abs(dx) > abs(dy) * 1.35:
        direction = "right" if dx > 0 else "left"
    elif abs(dy) > abs(dx) * 1.35:
        direction = "down" if dy > 0 else "up"
    elif abs(dx) + abs(dy) < 0.15:
        direction = "static"
    else:
        direction = "diagonal"
    return {
        "median": median_mag,
        "p90": p90,
        "dx": dx,
        "dy": dy,
        "consistency": consistency,
        "direction": direction,
    }


def analyze_video(path, max_samples=42):
    path = str(Path(path))
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return {"vision_version": VISION_VERSION, "available": False}
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frames / fps if fps > 0 and frames > 0 else 0.0
    if frames <= 0:
        cap.release()
        return {"vision_version": VISION_VERSION, "available": False}
    count = min(max_samples, max(8, int(duration * 2.2)))
    indices = np.linspace(0, max(0, frames - 1), count).astype(int)
    metrics = []
    motions = []
    prev_gray = None
    for fi in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(fi))
        ok, frame = cap.read()
        if not ok:
            continue
        m = _frame_metrics(frame)
        if not m:
            continue
        mot = _motion(prev_gray, m["gray"])
        if mot:
            motions.append(mot)
        prev_gray = m["gray"]
        m = {k: v for k, v in m.items() if k != "gray"}
        metrics.append(m)
    cap.release()
    if not metrics:
        return {"vision_version": VISION_VERSION, "available": False}

    def avg(key):
        return float(np.mean([m[key] for m in metrics]))

    focus_weight = np.array([max(0.05, m["focus_confidence"]) for m in metrics], dtype=float)
    focus_x = float(np.average([m["focus_x"] for m in metrics], weights=focus_weight))
    focus_y = float(np.average([m["focus_y"] for m in metrics], weights=focus_weight))
    wb_r = float(np.mean([m["white_balance"]["r"] for m in metrics]))
    wb_g = float(np.mean([m["white_balance"]["g"] for m in metrics]))
    wb_b = float(np.mean([m["white_balance"]["b"] for m in metrics]))
    qualities = [_quality(m) for m in metrics]
    motion_score = float(np.mean([x["p90"] for x in motions])) if motions else 0.0
    motion_consistency = float(np.mean([x["consistency"] for x in motions])) if motions else 1.0
    jitter_score = _clamp((1.0 - motion_consistency) * min(1.0, motion_score / 2.5))
    dirs = [x["direction"] for x in motions if x["direction"] != "static"]
    direction = max(set(dirs), key=dirs.count) if dirs else "static"
    return {
        "vision_version": VISION_VERSION,
        "available": True,
        "sample_count": len(metrics),
        "quality_score": round(float(np.mean(qualities)), 2),
        "quality_p10": round(float(np.percentile(qualities, 10)), 2),
        "brightness": round(avg("brightness"), 4),
        "contrast": round(avg("contrast"), 4),
        "saturation": round(avg("saturation"), 4),
        "sharpness": round(avg("sharpness"), 2),
        "edge_density": round(avg("edge_density"), 4),
        "focus": {"x": round(focus_x, 4), "y": round(focus_y, 4), "confidence": round(avg("focus_confidence"), 4)},
        "white_balance": {"r": round(wb_r, 4), "g": round(wb_g, 4), "b": round(wb_b, 4)},
        "motion_score": round(motion_score, 4),
        "motion_direction": direction,
        "motion_consistency": round(motion_consistency, 4),
        "jitter_score": round(jitter_score, 4),
    }
