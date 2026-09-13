#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import math
import os
from pathlib import Path

import worker as w
import audio_v43 as audio43
import capabilities_v43 as caps
import director_v43 as d43
import providers_v43 as providers
import vision_v43 as vision43

w.VERSION = "4.3.0"
VERSION = w.VERSION

_BASE_TEMPORAL = w.temporal


def _clamp(v, lo, hi):
    return max(lo, min(hi, float(v)))


def temporal(src, jobdir, index):
    result = _BASE_TEMPORAL(src, jobdir, index)
    result["vision"] = vision43.analyze_video(src)
    result["analysis_version"] = "video-temporal-v4.3"
    return result


def _music_candidates():
    root = Path(os.getenv("VIDEO_MUSIC_LIBRARY_DIR", "/data/music"))
    if not root.exists():
        return []
    exts = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"}
    return sorted([p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in exts])


def _select_music(job):
    pc = job.get("product_context") or {}
    explicit = pc.get("music_path") or (job.get("edit_strategy") or {}).get("music_path")
    if explicit and Path(str(explicit)).exists():
        path = Path(str(explicit))
    else:
        rows = _music_candidates()
        if not rows:
            return None
        style = str((job.get("edit_strategy") or {}).get("style") or "").lower()
        style_tokens = {
            "luxury_cinematic": ("lux", "cinematic", "elegant", "ambient"),
            "high_energy_reel": ("reel", "energy", "upbeat", "house"),
            "lifestyle": ("life", "chill", "warm", "organic"),
            "performance_ad": ("ad", "pulse", "modern", "beat"),
            "architectural": ("architect", "minimal", "ambient", "design"),
        }.get(style, ())
        preferred = [p for p in rows if any(tok in p.name.lower() for tok in style_tokens)]
        choices = preferred or rows
        seed = int(hashlib.sha1(str(job.get("id", "0")).encode()).hexdigest()[:8], 16)
        path = choices[seed % len(choices)]
    info = audio43.analyze_music(w.FFMPEG, str(path))
    return {"path": str(path), "fileName": path.name, **info}


def build_timeline(job, inputs, analyses):
    job2 = dict(job)
    music = _select_music(job2)
    if music:
        job2["_music_analysis"] = music
    timeline = d43.build_timeline(w, job2, inputs, analyses)
    timeline.setdefault("metadata", {})["rendererVersion"] = VERSION
    return timeline


def _effects(item):
    return [e for e in item.get("effects", []) if e.get("enabled", True)]


def _effect(item, name):
    return next((e for e in _effects(item) if e.get("kind") == name), None)


def _prefilter(item):
    parts = []
    stab = _effect(item, "stabilization")
    if stab:
        strength = _clamp((stab.get("params") or {}).get("strength", 0.5), 0.0, 1.0)
        radius = int(4 + strength * 8)
        parts.append(f"deshake=rx={radius}:ry={radius}:edge=mirror:blocksize=8:contrast=125")
    lens = _effect(item, "lens_correction")
    if lens:
        p = lens.get("params") or {}
        k1 = _clamp(p.get("k1", -0.015), -0.15, 0.15)
        k2 = _clamp(p.get("k2", 0.006), -0.15, 0.15)
        parts.append(f"lenscorrection=k1={k1:.5f}:k2={k2:.5f}")
    return ",".join(parts)


def _picture_filter(item):
    focus = (_effect(item, "smart_reframe") or {}).get("params") or {}
    fx = _clamp(focus.get("focus_x", 0.5), 0.05, 0.95)
    fy = _clamp(focus.get("focus_y", 0.5), 0.05, 0.95)
    chain = [
        "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos",
        f"crop=1080:1920:x='max(0,min(iw-1080,(iw-1080)*{fx:.5f}))':y='max(0,min(ih-1920,(ih-1920)*{fy:.5f}))'",
    ]
    cm = _effect(item, "color_match")
    if cm:
        p = cm.get("params") or {}
        sb = max(0.05, float(p.get("source_brightness", 0.52)))
        sc = max(0.08, float(p.get("source_contrast", 0.55)))
        ss = max(0.05, float(p.get("source_saturation", 0.32)))
        tb = float(p.get("target_brightness", 0.52))
        tc = float(p.get("target_contrast", 0.55))
        ts = float(p.get("target_saturation", 0.32))
        brightness = _clamp((tb - sb) * 0.34, -0.08, 0.08)
        contrast = _clamp(tc / sc, 0.88, 1.14)
        saturation = _clamp(ts / ss, 0.82, 1.20)
        chain.append(f"eq=brightness={brightness:.4f}:contrast={contrast:.4f}:saturation={saturation:.4f}:gamma=1.0")
    wb = _effect(item, "white_balance")
    if wb:
        p = wb.get("params") or {}
        r, g, b = float(p.get("r", 1.0)), float(p.get("g", 1.0)), float(p.get("b", 1.0))
        rs = _clamp((1.0-r)*0.08, -0.08, 0.08)
        gs = _clamp((1.0-g)*0.08, -0.08, 0.08)
        bs = _clamp((1.0-b)*0.08, -0.08, 0.08)
        chain.append(f"colorbalance=rm={rs:.4f}:gm={gs:.4f}:bm={bs:.4f}")
    if _effect(item, "highlight_soften"):
        chain.append("eq=brightness=-0.008:contrast=0.985:gamma=0.985")
    if _effect(item, "vignette"):
        chain.append("vignette=PI/5")
    push = _effect(item, "cinematic_push") or _effect(item, "parallax_push")
    if push:
        amount = _clamp((push.get("params") or {}).get("amount", 0.02), 0.004, 0.05)
        step = amount / 80.0
        chain.append(f"zoompan=z='min(max(zoom,pzoom)+{step:.7f},1+{amount:.5f})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30")
    return ",".join(chain)


def render_shot(src, item, analysis, out, render_duration):
    trim_in = float(item["trimIn"])
    trim_out = float(item["trimOut"])
    span = max(0.35, trim_out - trim_in)
    requested_volume = _clamp(item.get("volume") or 0.0, 0.0, 1.0)
    silence = (not analysis.get("has_audio")) or requested_volume <= 0.001
    cmd = [w.FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{trim_in:.3f}", "-t", f"{span:.3f}", "-i", str(src)]
    if silence:
        cmd += ["-f", "lavfi", "-t", f"{render_duration:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]

    pre = _prefilter(item)
    pre = (pre + ",") if pre else ""
    post = _picture_filter(item)
    ramp = _effect(item, "speed_ramp")
    slow = _effect(item, "slow_motion")
    if ramp and span >= 1.35:
        intensity = _clamp((ramp.get("params") or {}).get("intensity", 0.4), 0.1, 0.75)
        a = span * 0.24
        b = span * 0.74
        fast1 = 1.10 + intensity * 0.42
        middle = max(0.82, 1.0 - intensity * 0.10)
        fast2 = 1.08 + intensity * 0.36
        graph = (
            f"[0:v]{pre}split=3[v0][v1][v2];"
            f"[v0]trim=start=0:end={a:.3f},setpts=(PTS-STARTPTS)/{fast1:.4f}[va];"
            f"[v1]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/{middle:.4f}[vb];"
            f"[v2]trim=start={b:.3f}:end={span:.3f},setpts=(PTS-STARTPTS)/{fast2:.4f}[vc];"
            f"[va][vb][vc]concat=n=3:v=1:a=0,{post}"
        )
    else:
        speed = _clamp(item.get("speed") or 1.0, 0.72, 1.30)
        if slow:
            speed = min(speed, _clamp((slow.get("params") or {}).get("speed", 0.78), 0.60, 0.92))
            graph = f"[0:v]{pre}minterpolate=fps=60:mi_mode=mci,setpts=(PTS-STARTPTS)/{speed:.4f},{post}"
        else:
            graph = f"[0:v]{pre}setpts=(PTS-STARTPTS)/{speed:.4f},{post}"
    if _effect(item, "motion_blur"):
        graph += ",tmix=frames=2:weights='1 1'"
    graph += f",fps=30,tpad=stop_mode=clone:stop_duration=0.45,trim=duration={render_duration:.3f},setpts=PTS-STARTPTS[vout];"
    if silence:
        graph += f"[1:a]atrim=duration={render_duration:.3f},asetpts=PTS-STARTPTS[aout]"
    else:
        graph += f"[0:a]atrim=duration={render_duration:.3f},asetpts=PTS-STARTPTS,volume={requested_volume:.3f},apad,atrim=duration={render_duration:.3f}[aout]"
    cmd += [
        "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out),
    ]
    w.run(cmd, 1500)


def _transition_name(kind, direction=None):
    if kind in ("match_motion", "directional_transition"):
        return {"left": "slideleft", "right": "slideright", "up": "slideup", "down": "slidedown"}.get(direction, "smoothleft")
    return {"mask_transition": "circleopen", "crossfade": "fade", "foreground_wipe": "smoothleft"}.get(kind, "fade")


def combine_segments(paths, items, durations, out):
    cmd = [w.FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    for p in paths:
        cmd += ["-i", str(p)]
    filters = []
    for i in range(len(paths)):
        filters.append(f"[{i}:v]settb=AVTB,setpts=PTS-STARTPTS[v{i}]")
        filters.append(f"[{i}:a]aresample=48000,asetpts=PTS-STARTPTS[a{i}]")
    cv, ca = "v0", "a0"
    cumulative = float(durations[0])
    visible = 0
    for i in range(1, len(paths)):
        trans = items[i].get("transitionIn") or {"kind": "cut", "duration": 0.0}
        kind = str(trans.get("kind") or "cut")
        nv, na = f"vx{i}", f"ax{i}"
        if kind == "cut" or float(trans.get("duration") or 0) <= 0.001:
            filters.append(f"[{cv}][{ca}][v{i}][a{i}]concat=n=2:v=1:a=1[{nv}][{na}]")
            cumulative += float(durations[i])
        else:
            d = _clamp(trans.get("duration") or 0.10, 0.06, 0.25)
            offset = max(0.01, cumulative - d)
            name = _transition_name(kind, trans.get("direction"))
            filters.append(f"[{cv}][v{i}]xfade=transition={name}:duration={d:.3f}:offset={offset:.3f}[{nv}]")
            filters.append(f"[{ca}][a{i}]acrossfade=d={d:.3f}:c1=tri:c2=tri[{na}]")
            cumulative += float(durations[i]) - d
            visible += 1
        cv, ca = nv, na
    filters.append(f"[{cv}]format=yuv420p[vout]")
    filters.append(f"[{ca}]alimiter=limit=0.92[aout]")
    cmd += [
        "-filter_complex", ";".join(filters), "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out),
    ]
    w.run(cmd, 2400)
    return cumulative, visible


def _esc(value):
    return str(value).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'").replace("%", "\\%").replace("[", "\\[").replace("]", "\\]")


def _text_filter(current, item, idx, caption=False):
    text = _esc(item.get("text", ""))[:220]
    start = float(item.get("start") or 0)
    end = start + float(item.get("duration") or 1)
    size = max(26, min(88, int(item.get("fontSize") or (44 if caption else 56))))
    x = int(item.get("x") or (100 if caption else 92))
    y = int(item.get("y") or (1460 if caption else 330))
    subtype = str(item.get("subtype") or "")
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
        box = "box=1:boxcolor=black@0.34:boxborderw=16:" if subtype in ("price_card", "feature_callout", "brand_outro") else ""
    filt = f"[{current}]drawtext=fontfile='{w.FONT}':text='{text}':fontcolor=white:fontsize={size}:x='{xexpr}':y='{yexpr}':alpha='{alpha}':{box}shadowcolor=black@0.72:shadowx=3:shadowy=4:enable='between(t,{start:.3f},{end:.3f})'[{nxt}]"
    return filt, nxt


def _brand_plan(timeline):
    return timeline.get("brandPlan") or {}


def _merge_vfx_window(original, effected, out, start, duration, target):
    start = max(0.0, float(start or 0.0))
    duration = max(0.0, float(duration or target))
    end = min(float(target), start + duration)
    full = start <= 0.001 and end >= float(target) - 0.001
    cmd = [w.FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(original), "-i", str(effected)]
    if full:
        cmd += ["-map", "1:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    else:
        expr = f"if(between(T,{start:.3f},{end:.3f}),B,A)"
        cmd += ["-filter_complex", f"[0:v][1:v]blend=all_expr='{expr}'[v]", "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    w.run(cmd, 1800)
    return out


def _apply_vfx(base, timeline, jobdir):
    rows = next((t.get("items", []) for t in timeline.get("tracks", []) if t.get("kind") == "vfx"), [])
    current = Path(base)
    applied = []
    skipped = []
    target = float(timeline.get("duration") or 18.0)
    for idx, req in enumerate(rows):
        effect = str(req.get("effect") or "")
        if not effect:
            continue
        raw = jobdir / f"vfx-{idx:02d}-{effect}-raw.mp4"
        merged = jobdir / f"vfx-{idx:02d}-{effect}.mp4"
        result = providers.request_vfx(current, effect, req.get("params") or {}, raw)
        candidate = Path(str(result.get("output_path") or raw))
        if result.get("available") and candidate.exists() and candidate.stat().st_size > 0:
            try:
                _merge_vfx_window(current, candidate, merged, req.get("start"), req.get("duration"), target)
                current = merged
                applied.append({"effect": effect, "provider": result.get("provider"), "start": req.get("start"), "duration": req.get("duration")})
            except Exception as exc:
                skipped.append({"effect": effect, "reason": f"vfx_merge_failed:{exc}"})
        else:
            skipped.append({"effect": effect, "reason": result.get("reason") or "provider_no_output"})
    return current, applied, skipped

def decorate(base, timeline, out):
    text_items = next((t.get("items", []) for t in timeline.get("tracks", []) if t.get("kind") == "text"), [])
    captions = next((t.get("items", []) for t in timeline.get("tracks", []) if t.get("kind") == "caption"), [])
    events = next((t.get("items", []) for t in timeline.get("tracks", []) if t.get("kind") == "audio_event"), [])
    music = (timeline.get("audioPlan") or {}).get("music") or {}
    music_path = Path(str(music.get("path"))) if music.get("path") else None
    cmd = [w.FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(base)]
    music_idx = None
    if music_path and music_path.exists():
        music_idx = 1
        cmd += ["-stream_loop", "-1", "-i", str(music_path)]
    brand = _brand_plan(timeline)
    logo_path = Path(str(brand.get("logoPath"))) if brand.get("logoPath") else None
    logo_idx = None
    if logo_path and logo_path.exists():
        logo_idx = 2 if music_idx is not None else 1
        cmd += ["-i", str(logo_path)]

    filters = ["[0:v]format=yuv420p[v0]"]
    current = "v0"
    for idx, item in enumerate(text_items):
        f, current = _text_filter(current, item, idx, False)
        filters.append(f)
    offset = len(text_items)
    for j, item in enumerate(captions):
        f, current = _text_filter(current, item, offset+j, True)
        filters.append(f)
    if logo_idx is not None:
        filters.append(f"[{logo_idx}:v]scale=190:-1[logo]")
        filters.append(f"[{current}][logo]overlay=W-w-78:78:format=auto[{current}logo]")
        current = current + "logo"
    filters.append(f"[{current}]format=yuv420p[vout]")

    audio_labels = []
    filters.append("[0:a]volume=0.10[abase]")
    audio_labels.append("abase")
    target = float(timeline.get("duration") or 18.0)
    if music_idx is not None:
        filters.append(f"[{music_idx}:a]atrim=duration={target:.3f},asetpts=PTS-STARTPTS,volume=0.23,afade=t=in:st=0:d=0.45,afade=t=out:st={max(0,target-1.8):.3f}:d=1.8[music]")
        audio_labels.append("music")
    for idx, e in enumerate(events):
        typ = str(e.get("type") or "whoosh")
        start = max(0.0, float(e.get("start") or 0))
        gain = _clamp(e.get("gain") or 0.10, 0.02, 0.30)
        delay = int(start * 1000)
        label = f"evt{idx}"
        if typ == "impact":
            filters.append(f"sine=frequency=72:duration=0.32,volume={gain:.3f},afade=t=out:st=0.05:d=0.27,aformat=channel_layouts=stereo,adelay={delay}|{delay}[{label}]")
        elif typ == "riser":
            filters.append(f"anoisesrc=color=pink:amplitude={gain:.3f}:d=0.62,highpass=f=500,lowpass=f=6500,afade=t=in:st=0:d=0.48,afade=t=out:st=0.52:d=0.10,aformat=channel_layouts=stereo,adelay={delay}|{delay}[{label}]")
        else:
            filters.append(f"anoisesrc=color=pink:amplitude={gain:.3f}:d=0.34,highpass=f=700,lowpass=f=5200,afade=t=in:st=0:d=0.04,afade=t=out:st=0.09:d=0.25,aformat=channel_layouts=stereo,adelay={delay}|{delay}[{label}]")
        audio_labels.append(label)
    mix_inputs = "".join(f"[{x}]" for x in audio_labels)
    filters.append(f"{mix_inputs}amix=inputs={len(audio_labels)}:duration=first:normalize=0,alimiter=limit=0.90[aout]")
    cmd += [
        "-filter_complex", ";".join(filters), "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-maxrate", "12M", "-bufsize", "24M", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", str(out),
    ]
    w.run(cmd, 2400)


def render_timeline(paths, analyses, timeline, jobdir, out):
    creative = d43.validate_creative_timeline(timeline)
    items = next(t["items"] for t in timeline["tracks"] if t["kind"] == "video")
    asset_to_input = {str(a["id"]): idx for idx, a in enumerate(timeline["assets"])}
    segments, durations = [], []
    for idx, item in enumerate(items):
        rd = float(item["duration"])
        trans = item.get("transitionIn") or {}
        if idx and str(trans.get("kind") or "cut") != "cut":
            rd += _clamp(trans.get("duration") or 0.10, 0.06, 0.25)
        seg = jobdir / f"segment-v43-{idx:02d}.mp4"
        input_idx = asset_to_input[item["assetId"]]
        render_shot(paths[input_idx], item, analyses[input_idx], seg, rd)
        segments.append(seg)
        durations.append(rd)
    base = jobdir / "base-v43.mp4"
    effective, visible = combine_segments(segments, items, durations, base)
    vfx_base, vfx_applied, vfx_skipped = _apply_vfx(base, timeline, jobdir)
    decorate(vfx_base, timeline, out)
    return {
        "segments": len(segments), "effective_duration": round(effective, 3), "transition_count": visible,
        "creative_qa": creative, "director_version": d43.DIRECTOR_VERSION, "renderer_version": VERSION,
        "vision_version": vision43.VISION_VERSION, "audio_version": audio43.AUDIO_VERSION,
        "vfx_applied": vfx_applied, "vfx_skipped": vfx_skipped, "provider_status": providers.provider_status(),
        "capability_summary": caps.capability_summary(),
    }


w.temporal = temporal
w.build_timeline = build_timeline
w.render_shot = render_shot
w.combine_segments = combine_segments
w.decorate = decorate
w.render_timeline = render_timeline

if __name__ == "__main__":
    w.daemon()
