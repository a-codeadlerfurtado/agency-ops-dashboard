from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

PROVIDER_VERSION = "provider-hooks-v4.3.0"
VISION_URL = os.getenv("VIDEO_VISION_PROVIDER_URL", "").strip()
VFX_URL = os.getenv("VIDEO_VFX_PROVIDER_URL", "").strip()
PROVIDER_TOKEN = os.getenv("VIDEO_PROVIDER_TOKEN", "").strip()

MATERIAL_CHANGE_EFFECTS = {"sky_replacement", "day_to_dusk", "room_staging", "lot_to_project", "object_removal", "lights_on"}


def _post_json(url, payload, timeout=900):
    headers = {"content-type": "application/json"}
    if PROVIDER_TOKEN:
        headers["authorization"] = "Bearer " + PROVIDER_TOKEN
    req = Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except HTTPError as e:
        raise RuntimeError(f"provider_http_{e.code}:{e.read(1200).decode(errors='replace')}")


def provider_status():
    return {
        "version": PROVIDER_VERSION,
        "vision_provider": bool(VISION_URL),
        "vfx_provider": bool(VFX_URL),
    }


def request_tracking(video_path, request):
    if not VISION_URL:
        return {"available": False, "reason": "vision_provider_not_configured"}
    payload = {
        "action": "track",
        "video_path": str(video_path),
        "request": request,
        "contract_version": PROVIDER_VERSION,
    }
    return {"available": True, **_post_json(VISION_URL, payload)}


def request_segmentation(video_path, request):
    if not VISION_URL:
        return {"available": False, "reason": "vision_provider_not_configured"}
    payload = {
        "action": "segment",
        "video_path": str(video_path),
        "request": request,
        "contract_version": PROVIDER_VERSION,
    }
    return {"available": True, **_post_json(VISION_URL, payload)}


def request_vfx(video_path, effect, params, output_path):
    effect = str(effect)
    if not VFX_URL:
        return {"available": False, "reason": "vfx_provider_not_configured", "effect": effect}
    payload = {
        "action": "video_vfx",
        "effect": effect,
        "video_path": str(video_path),
        "output_path": str(output_path),
        "params": params or {},
        "contract_version": PROVIDER_VERSION,
        "requires_disclosure": effect in MATERIAL_CHANGE_EFFECTS,
    }
    result = _post_json(VFX_URL, payload, timeout=1800)
    return {"available": True, "effect": effect, **result}


def disclosure_for(effect):
    return {
        "effect": str(effect),
        "material_change": str(effect) in MATERIAL_CHANGE_EFFECTS,
        "review_required": str(effect) in MATERIAL_CHANGE_EFFECTS,
    }
