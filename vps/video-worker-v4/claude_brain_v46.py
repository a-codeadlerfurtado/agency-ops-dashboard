from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

import cv2
import numpy as np

import claude_edit_spec_v46 as edit_spec

BRAIN_VERSION = "claude-max-brain-v4.6.0"
SECRET_KEY_PATTERN = re.compile(r"(token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key)", re.I)


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _redact(value):
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if SECRET_KEY_PATTERN.search(str(key)):
                out[str(key)] = "[REDACTED]"
            else:
                out[str(key)] = _redact(item)
        return out
    if isinstance(value, list):
        return [_redact(x) for x in value]
    if isinstance(value, str) and len(value) > 12000:
        return value[:12000] + "...[TRUNCATED]"
    return value


def _run(cmd, *, cwd=None, env=None, timeout=900):
    started = time.monotonic()
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if proc.returncode != 0:
        stderr = (proc.stderr or "")[-2500:]
        stdout = (proc.stdout or "")[-1200:]
        raise RuntimeError(f"claude_command_failed:{proc.returncode}:stdout={stdout}:stderr={stderr}")
    return proc.stdout, elapsed_ms


def _claude_env():
    if os.getenv("ANTHROPIC_API_KEY"):
        raise RuntimeError("claude_subscription_guard:ANTHROPIC_API_KEY_must_be_unset")
    if os.getenv("ANTHROPIC_AUTH_TOKEN"):
        raise RuntimeError("claude_subscription_guard:ANTHROPIC_AUTH_TOKEN_must_be_unset")
    env = os.environ.copy()
    for key in list(env):
        if SECRET_KEY_PATTERN.search(key):
            env.pop(key, None)
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_AUTH_TOKEN", None)
    config_dir = Path(os.getenv("CLAUDE_CONFIG_DIR", "/data/claude-config"))
    config_dir.mkdir(parents=True, exist_ok=True)
    env["CLAUDE_CONFIG_DIR"] = str(config_dir)
    env.setdefault("MAX_STRUCTURED_OUTPUT_RETRIES", "2")
    return env


def auth_status():
    binary = os.getenv("CLAUDE_BIN", "claude")
    if not shutil.which(binary):
        raise RuntimeError("claude_binary_not_found")
    stdout, elapsed_ms = _run([binary, "auth", "status"], env=_claude_env(), timeout=30)
    try:
        status = json.loads(stdout)
    except Exception as exc:
        raise RuntimeError(f"claude_auth_status_invalid_json:{exc}") from exc

    if not status.get("loggedIn"):
        raise RuntimeError("claude_not_logged_in")
    method = str(status.get("authMethod") or "")
    subscription = str(status.get("subscriptionType") or "")
    if _bool_env("VIDEO_CLAUDE_REQUIRE_MAX", True) and subscription.lower() != "max":
        raise RuntimeError(f"claude_subscription_guard:expected_max:got_{subscription or 'unknown'}")
    if method != "claude.ai":
        raise RuntimeError(f"claude_subscription_guard:expected_claude.ai:got_{method or 'unknown'}")
    return {
        "logged_in": True,
        "auth_method": method,
        "subscription_type": subscription,
        "api_provider": status.get("apiProvider"),
        "status_ms": elapsed_ms,
    }


def _contact_sheet(video_path: Path, output_path: Path, cells: int = 9):
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"contact_sheet_open_failed:{video_path.name}")
    frame_count = max(1, int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 1))
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    positions = np.linspace(0, max(0, frame_count - 1), cells).astype(int)
    frames = []
    for pos in positions:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(pos))
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        h, w = frame.shape[:2]
        target_w = 320
        target_h = max(2, int(h * (target_w / max(1, w))))
        frame = cv2.resize(frame, (target_w, target_h), interpolation=cv2.INTER_AREA)
        seconds = float(pos) / max(1.0, fps)
        cv2.rectangle(frame, (6, 6), (114, 32), (0, 0, 0), -1)
        cv2.putText(
            frame,
            f"{seconds:05.1f}s",
            (12, 26),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )
        frames.append(frame)
    cap.release()
    if not frames:
        raise RuntimeError(f"contact_sheet_no_frames:{video_path.name}")

    tile_h = max(x.shape[0] for x in frames)
    tile_w = 320
    rows = []
    for start in range(0, len(frames), 3):
        chunk = frames[start:start + 3]
        while len(chunk) < 3:
            chunk.append(np.zeros((tile_h, tile_w, 3), dtype=np.uint8))
        normalized = []
        for frame in chunk:
            if frame.shape[0] < tile_h:
                pad = np.zeros((tile_h - frame.shape[0], tile_w, 3), dtype=np.uint8)
                frame = np.vstack([frame, pad])
            normalized.append(frame)
        rows.append(np.hstack(normalized))
    sheet = np.vstack(rows)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output_path), sheet, [int(cv2.IMWRITE_JPEG_QUALITY), 88]):
        raise RuntimeError(f"contact_sheet_write_failed:{output_path.name}")
    return {
        "file": output_path.name,
        "frame_count": frame_count,
        "fps": round(fps, 3),
        "sample_count": len(frames),
    }


def _safe_name(value: str, fallback: str):
    value = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "")).strip("._")
    return (value or fallback)[:120]


def _existing_analysis(item):
    row = item.get("existing_analysis")
    if not isinstance(row, dict):
        return None
    return {
        "analysis_text": row.get("analysis_text"),
        "analysis_json": row.get("analysis_json"),
        "model": row.get("model"),
        "analysis_version": row.get("analysis_version"),
    }


def build_context(job, inputs, analyses, baseline, path_by_drive_id, download_fn):
    first_path = None
    for item in inputs:
        path = path_by_drive_id.get(str(item.get("drive_file_id") or ""))
        if path:
            first_path = Path(path)
            break
    if not first_path:
        raise RuntimeError("claude_input_paths_unavailable")

    jobdir = first_path.parent
    claude_dir = jobdir / "claude-v46"
    claude_dir.mkdir(parents=True, exist_ok=True)

    raw_assets = []
    for idx, item in enumerate(inputs):
        drive_id = str(item.get("drive_file_id") or "")
        local_path = Path(path_by_drive_id[drive_id])
        sheet = claude_dir / f"raw-{idx+1:02d}-contact.jpg"
        contact = _contact_sheet(local_path, sheet)
        raw_assets.append({
            "asset_id": str(item.get("asset_id") or item.get("id") or ""),
            "file_name": item.get("file_name"),
            "drive_file_id": drive_id,
            "duration_seconds": (analyses[idx] or {}).get("duration_seconds") if idx < len(analyses) else item.get("duration_seconds"),
            "temporal_analysis": analyses[idx] if idx < len(analyses) else None,
            "existing_analysis": _existing_analysis(item),
            "contact_sheet": contact,
        })

    refs = list(((job.get("_reference_pack") or {}).get("references") or []))
    max_refs = max(0, min(5, int(os.getenv("VIDEO_CLAUDE_MAX_REFERENCES", "3"))))
    approved_references = []
    for idx, ref in enumerate(refs[:max_refs]):
        drive_id = str(ref.get("drive_file_id") or "")
        if not drive_id:
            continue
        suffix = Path(str(ref.get("file_name") or "reference.mp4")).suffix or ".mp4"
        ref_path = claude_dir / _safe_name(f"approved-ref-{idx+1}{suffix}", f"approved-ref-{idx+1}.mp4")
        if not ref_path.exists() or ref_path.stat().st_size == 0:
            download_fn(drive_id, ref_path)
        sheet_path = claude_dir / f"approved-ref-{idx+1:02d}-contact.jpg"
        contact = _contact_sheet(ref_path, sheet_path)
        approved_references.append({
            "id": ref.get("id"),
            "product_name": ref.get("product_name"),
            "product_type": ref.get("product_type"),
            "market_tier": ref.get("market_tier"),
            "aspect_ratio": ref.get("aspect_ratio"),
            "duration_seconds": ref.get("duration_seconds"),
            "dna_features": ref.get("dna_features") or {},
            "contact_sheet": contact,
        })

    context = {
        "contract": {
            "brain_version": BRAIN_VERSION,
            "edit_spec_version": edit_spec.SPEC_VERSION,
            "objective": "Produce a final-ready real-estate social video edit direction for the existing FFmpeg renderer. Human review is mandatory before publication.",
            "constraints": {
                "aspect_ratio": "9:16",
                "resolution": "1080x1920",
                "fps": 30,
                "safe_zone": {"top": 240, "right": 80, "bottom": 320, "left": 80},
                "no_invented_facts": True,
                "no_automatic_publication": True,
            },
        },
        "briefing": {
            "product_name": job.get("product_name"),
            "product_context": job.get("product_context") or {},
            "client_context": job.get("client_context") or {},
            "benchmark_context": job.get("benchmark_context") or {},
            "edit_strategy": job.get("edit_strategy") or {},
            "metadata": job.get("metadata") or {},
        },
        "raw_assets": raw_assets,
        "approved_references": approved_references,
        "approved_reference_dna_profiles": ((job.get("_reference_pack") or {}).get("profiles") or []),
        "baseline_timeline_summary": {
            "style": baseline.get("style"),
            "duration": baseline.get("duration"),
            "safe_zone": baseline.get("safeZone"),
            "audio_plan": baseline.get("audioPlan"),
            "brand_plan": baseline.get("brandPlan"),
            "metadata": baseline.get("metadata"),
        },
    }
    context = _redact(context)
    context_path = claude_dir / "context.json"
    context_path.write_text(json.dumps(context, ensure_ascii=False, indent=2), encoding="utf-8")
    return claude_dir, context_path, context


def _prompt(context_path: Path, context):
    ref_count = len(context.get("approved_references") or [])
    raw_count = len(context.get("raw_assets") or [])
    return f"""You are the editing brain for an automated real-estate video engine.

Work only from the evidence in {context_path.name} and the JPEG contact sheets listed there.
Use the Read tool to inspect context.json and every raw/contact reference image before deciding.
There are {raw_count} raw source asset(s) and {ref_count} approved reference video(s).

Priority order:
1. Understand the client's approved-reference DNA: shot rhythm, visual hierarchy, text density, commercial timing, CTA behavior, and closing style.
2. Understand the raw footage and choose the strongest non-duplicated windows.
3. Preserve factual accuracy. Never invent price, area, rooms, location, offer, brand claim, or CTA not supported by context.
4. Produce a complete {edit_spec.SPEC_VERSION} JSON plan that the deterministic FFmpeg renderer can execute.
5. The output is 1080x1920, 30 fps, vertical 9:16. Keep all text in y=220..1540.
6. Use at least six shots, even when there is only one source video; choose distinct source windows.
7. Prefer hard cuts. Use visible transitions sparingly and only when motivated by motion/rhythm.
8. Captions must only come from supplied transcription/caption evidence. If no transcript exists, return an empty captions array.
9. Narration may be planned only if appropriate. The current test renderer does not synthesize speech, so narration.enabled should normally be false unless supplied context already contains a renderable narration source.
10. Music is optional. If enabled, describe mood and set a conservative volume.
11. Include a clear brand close/CTA only when supported by the briefing or approved reference pattern.
12. This is never auto-published. Optimize for a human-review-ready MP4.

Return only the structured output required by the provided JSON schema."""
    

def _parse_structured(stdout: str):
    try:
        payload = json.loads(stdout)
    except Exception as exc:
        raise RuntimeError(f"claude_output_not_json:{exc}") from exc

    candidates = [
        payload.get("structured_output") if isinstance(payload, dict) else None,
        payload.get("structuredOutput") if isinstance(payload, dict) else None,
        payload.get("result") if isinstance(payload, dict) else None,
        payload,
    ]
    for value in candidates:
        if isinstance(value, dict) and value.get("spec_version"):
            return value
        if isinstance(value, str):
            try:
                decoded = json.loads(value)
            except Exception:
                continue
            if isinstance(decoded, dict) and decoded.get("spec_version"):
                return decoded
    raise RuntimeError("claude_structured_output_missing")


def plan(job, inputs, analyses, baseline, path_by_drive_id, download_fn):
    if not _bool_env("VIDEO_CLAUDE_ENABLED", False):
        raise RuntimeError("claude_brain_disabled")

    started = time.monotonic()
    auth = auth_status()
    claude_dir, context_path, context = build_context(
        job,
        inputs,
        analyses,
        baseline,
        path_by_drive_id,
        download_fn,
    )
    prompt = _prompt(context_path, context)
    prompt_hash = hashlib.sha256(prompt.encode()).hexdigest()
    prompt_path = claude_dir / "prompt.txt"
    prompt_path.write_text(prompt, encoding="utf-8")

    allowed_reads = ["Read(./context.json)"]
    for row in (context.get("raw_assets") or []) + (context.get("approved_references") or []):
        contact = row.get("contact_sheet") or {}
        file_name = Path(str(contact.get("file") or "")).name
        if file_name:
            allowed_reads.append(f"Read(./{file_name})")
    permission_settings = {
        "permissions": {
            "allow": sorted(set(allowed_reads)),
            "deny": [
                "Read(./prompt.txt)",
                "Read(./claude-permissions.json)",
                "Read(../**)",
                "Read(/data/claude-config/**)",
                "Read(/run/secrets/**)",
                "Read(/proc/**)",
                "Read(/sys/**)",
                "Read(/etc/**)",
                "Read(/root/**)",
                "Read(/home/**/.ssh/**)",
                "Read(**/.env)",
                "Read(**/.env.*)",
            ],
        }
    }
    settings_path = claude_dir / "claude-permissions.json"
    settings_path.write_text(json.dumps(permission_settings, ensure_ascii=False, indent=2), encoding="utf-8")

    model = os.getenv("VIDEO_CLAUDE_MODEL", "opus").strip() or "opus"
    max_turns = max(4, min(30, int(os.getenv("VIDEO_CLAUDE_MAX_TURNS", "12"))))
    timeout = max(60, min(1800, int(os.getenv("VIDEO_CLAUDE_TIMEOUT_SECONDS", "900"))))
    binary = os.getenv("CLAUDE_BIN", "claude")
    cmd = [
        binary,
        "-p",
        prompt,
        "--output-format",
        "json",
        "--json-schema",
        edit_spec.schema_json(),
        "--tools",
        "Read",
        "--settings",
        str(settings_path),
        "--permission-mode",
        "dontAsk",
        "--max-turns",
        str(max_turns),
        "--model",
        model,
        "--effort",
        os.getenv("VIDEO_CLAUDE_EFFORT", "high"),
    ]
    stdout, cli_ms = _run(cmd, cwd=claude_dir, env=_claude_env(), timeout=timeout)
    spec = _parse_structured(stdout)
    validation = edit_spec.validate_edit_spec(spec, inputs, analyses, baseline)
    elapsed_ms = int((time.monotonic() - started) * 1000)

    raw_result_path = claude_dir / "claude-result.json"
    raw_result_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")

    metadata = {
        "brainVersion": BRAIN_VERSION,
        "model": model,
        "authMethod": auth["auth_method"],
        "subscriptionType": auth["subscription_type"],
        "apiProvider": auth.get("api_provider"),
        "elapsedMs": elapsed_ms,
        "cliMs": cli_ms,
        "promptHash": prompt_hash,
        "referenceCount": len(context.get("approved_references") or []),
        "rawAssetCount": len(context.get("raw_assets") or []),
        "validation": validation,
        "humanReviewRequired": True,
    }
    print(json.dumps({
        "event": "claude_edit_plan_ready",
        "brain_version": BRAIN_VERSION,
        "model": model,
        "auth_method": auth["auth_method"],
        "subscription_type": auth["subscription_type"],
        "elapsed_ms": elapsed_ms,
        "reference_count": metadata["referenceCount"],
        "raw_asset_count": metadata["rawAssetCount"],
        "prompt_hash": prompt_hash,
    }, ensure_ascii=False), flush=True)
    return spec, metadata
