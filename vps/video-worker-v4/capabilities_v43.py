from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, Iterable, List

CAPABILITY_VERSION = "video-capabilities-v4.3.0"


@dataclass(frozen=True)
class Capability:
    name: str
    provider: str
    implemented: bool
    category: str
    notes: str = ""


_REGISTRY: Dict[str, Capability] = {
    # Editorial / picture finishing
    "hard_cut": Capability("hard_cut", "native", True, "edit"),
    "match_motion_cut": Capability("match_motion_cut", "native", True, "edit"),
    "speed_ramp": Capability("speed_ramp", "ffmpeg", True, "edit"),
    "slow_motion": Capability("slow_motion", "ffmpeg", True, "edit"),
    "motion_blur": Capability("motion_blur", "ffmpeg", True, "edit"),
    "stabilization": Capability("stabilization", "ffmpeg", True, "finishing"),
    "lens_correction": Capability("lens_correction", "ffmpeg", True, "finishing"),
    "smart_reframe": Capability("smart_reframe", "vision+ffmpeg", True, "finishing"),
    "color_match": Capability("color_match", "vision+ffmpeg", True, "finishing"),
    "exposure_match": Capability("exposure_match", "vision+ffmpeg", True, "finishing"),
    "white_balance": Capability("white_balance", "vision+ffmpeg", True, "finishing"),
    "highlight_soften": Capability("highlight_soften", "ffmpeg", True, "finishing"),
    "vignette": Capability("vignette", "ffmpeg", True, "finishing"),
    "cinematic_push": Capability("cinematic_push", "ffmpeg", True, "motion"),
    "parallax_push": Capability("parallax_push", "ffmpeg", True, "motion"),
    "directional_transition": Capability("directional_transition", "ffmpeg", True, "transition"),
    "mask_transition": Capability("mask_transition", "ffmpeg", True, "transition", "Geometric mask fallback; object-aware masks require vision provider."),
    # Motion graphics / branding
    "kinetic_text": Capability("kinetic_text", "ffmpeg", True, "graphics"),
    "feature_callout": Capability("feature_callout", "ffmpeg", True, "graphics"),
    "price_card": Capability("price_card", "ffmpeg", True, "graphics"),
    "lower_third": Capability("lower_third", "ffmpeg", True, "graphics"),
    "brand_outro": Capability("brand_outro", "ffmpeg", True, "graphics"),
    "logo_overlay": Capability("logo_overlay", "ffmpeg", True, "graphics"),
    "subtitles": Capability("subtitles", "ffmpeg", True, "graphics"),
    "perspective_text": Capability("perspective_text", "vision-hook", False, "graphics", "Timeline node supported; needs tracked-corner provider for real scene lock."),
    "text_behind_object": Capability("text_behind_object", "segmentation-hook", False, "graphics", "Timeline node supported; needs segmentation provider."),
    # Audio
    "music_bed": Capability("music_bed", "native", True, "audio"),
    "beat_analysis": Capability("beat_analysis", "native", True, "audio"),
    "beat_sync": Capability("beat_sync", "director", True, "audio"),
    "ducking": Capability("ducking", "ffmpeg", True, "audio"),
    "whoosh": Capability("whoosh", "ffmpeg", True, "audio"),
    "riser": Capability("riser", "ffmpeg", True, "audio"),
    "impact": Capability("impact", "ffmpeg", True, "audio"),
    "room_tone": Capability("room_tone", "ffmpeg", True, "audio"),
    "ambient_layer": Capability("ambient_layer", "ffmpeg", True, "audio"),
    # AI / advanced VFX routing. The engine understands these nodes and can invoke a provider.
    "object_tracking": Capability("object_tracking", "vision-provider", False, "vision", "Provider hook implemented in V4.3; external model endpoint required."),
    "segmentation": Capability("segmentation", "vision-provider", False, "vision", "Provider hook implemented in V4.3; external model endpoint required."),
    "sky_replacement": Capability("sky_replacement", "vfx-provider", False, "generative_vfx", "Provider hook implemented; disclosure metadata required."),
    "day_to_dusk": Capability("day_to_dusk", "vfx-provider", False, "generative_vfx", "Provider hook implemented; disclosure metadata required."),
    "object_removal": Capability("object_removal", "vfx-provider", False, "generative_vfx", "Provider hook implemented; review gate required."),
    "screen_replacement": Capability("screen_replacement", "vfx-provider", False, "generative_vfx"),
    "room_staging": Capability("room_staging", "vfx-provider", False, "generative_vfx", "Material property change; disclosure metadata required."),
    "lot_to_project": Capability("lot_to_project", "vfx-provider", False, "generative_vfx", "Material property change; disclosure metadata required."),
    "before_after": Capability("before_after", "native+vfx-provider", True, "generative_vfx"),
    "lights_on": Capability("lights_on", "vfx-provider", False, "generative_vfx", "Provider hook implemented; disclosure metadata may be required."),
}


def get(name: str) -> Capability:
    return _REGISTRY[name]


def all_capabilities() -> List[dict]:
    return [asdict(_REGISTRY[k]) for k in sorted(_REGISTRY)]


def implemented(names: Iterable[str]) -> List[str]:
    return [n for n in names if n in _REGISTRY and _REGISTRY[n].implemented]


def missing(names: Iterable[str]) -> List[str]:
    return [n for n in names if n not in _REGISTRY or not _REGISTRY[n].implemented]


def capability_summary() -> dict:
    rows = all_capabilities()
    return {
        "version": CAPABILITY_VERSION,
        "total": len(rows),
        "implemented": sum(1 for x in rows if x["implemented"]),
        "provider_required": [x["name"] for x in rows if not x["implemented"]],
        "capabilities": rows,
    }
