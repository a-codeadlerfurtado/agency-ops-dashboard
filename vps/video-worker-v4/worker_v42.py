#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import worker as w
import director_v42 as d42

w.VERSION = "4.2.0"


def build_timeline(job, inputs, analyses):
    return d42.build_timeline(w, job, inputs, analyses)


def render_shot(src, item, analysis, out, render_duration):
    trim_in = float(item["trimIn"])
    trim_out = float(item["trimOut"])
    span = max(0.3, trim_out - trim_in)
    effects = w.effect_names(item)
    requested_volume = max(0.0, min(1.0, float(item.get("volume") or 0.0)))
    use_silence = (not analysis.get("has_audio")) or requested_volume <= 0.001

    cmd = [w.FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(trim_in), "-t", str(span), "-i", str(src)]
    if use_silence:
        cmd += ["-f", "lavfi", "-t", str(render_duration), "-i", "anullsrc=r=48000:cl=stereo"]

    base = "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,eq=contrast=1.025:saturation=1.035:brightness=0.002:gamma=1.0"
    if "speed_ramp" in effects and span >= 1.65:
        a = span * 0.24
        b = span * 0.76
        graph = (
            f"[0:v]split=3[v0][v1][v2];"
            f"[v0]trim=start=0:end={a:.3f},setpts=(PTS-STARTPTS)/1.18[va];"
            f"[v1]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/0.96[vb];"
            f"[v2]trim=start={b:.3f}:end={span:.3f},setpts=(PTS-STARTPTS)/1.15[vc];"
            f"[va][vb][vc]concat=n=3:v=1:a=0,{base}"
        )
        if "motion_blur" in effects:
            graph += ",tmix=frames=2:weights='1 1'"
    else:
        speed = max(0.90, min(1.15, float(item.get("speed") or 1.0)))
        graph = f"[0:v]setpts=(PTS-STARTPTS)/{speed:.4f},{base}"

    graph += f",fps=30,tpad=stop_mode=clone:stop_duration=0.5,trim=duration={render_duration:.3f},setpts=PTS-STARTPTS[vout];"
    if use_silence:
        graph += f"[1:a]atrim=duration={render_duration:.3f},asetpts=PTS-STARTPTS[aout]"
    else:
        graph += f"[0:a]atrim=duration={render_duration:.3f},asetpts=PTS-STARTPTS,volume={requested_volume:.3f},apad,atrim=duration={render_duration:.3f}[aout]"

    cmd += [
        "-filter_complex", graph,
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out),
    ]
    w.run(cmd, 1200)


def combine_segments(paths, items, durations, out):
    # Professional default: hard cuts. Visible transitions are opt-in, never automatic.
    cmd = [w.FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    for p in paths:
        cmd += ["-i", str(p)]
    filters = []
    concat_inputs = []
    for i in range(len(paths)):
        filters.append(f"[{i}:v]settb=AVTB,setpts=PTS-STARTPTS[v{i}]")
        filters.append(f"[{i}:a]aresample=48000,asetpts=PTS-STARTPTS[a{i}]")
        concat_inputs.append(f"[v{i}][a{i}]")
    filters.append("".join(concat_inputs) + f"concat=n={len(paths)}:v=1:a=1[vcat][acat]")
    filters.append("[vcat]format=yuv420p[vout]")
    filters.append("[acat]alimiter=limit=0.92[aout]")
    cmd += [
        "-filter_complex", ";".join(filters),
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out),
    ]
    w.run(cmd, 1800)
    return sum(durations)


def render_timeline(paths, analyses, timeline, jobdir, out):
    d42.validate_creative_timeline(timeline)
    items = next(t["items"] for t in timeline["tracks"] if t["kind"] == "video")
    asset_to_input = {str(a["id"]): idx for idx, a in enumerate(timeline["assets"])}
    segments, durations = [], []
    for idx, item in enumerate(items):
        rd = float(item["duration"])
        seg = jobdir / f"segment-{idx:02d}.mp4"
        input_idx = asset_to_input[item["assetId"]]
        render_shot(paths[input_idx], item, analyses[input_idx], seg, rd)
        segments.append(seg)
        durations.append(rd)
    base = jobdir / "base-v42.mp4"
    effective = combine_segments(segments, items, durations, base)
    w.decorate(base, timeline, out)
    creative = d42.validate_creative_timeline(timeline)
    return {
        "segments": len(segments),
        "effective_duration": round(effective, 3),
        "transition_count": creative["visible_transitions"],
        "creative_qa": creative,
        "director_version": "creative-director-v4.2.0",
    }


w.build_timeline = build_timeline
w.render_shot = render_shot
w.combine_segments = combine_segments
w.render_timeline = render_timeline

if __name__ == "__main__":
    w.daemon()
