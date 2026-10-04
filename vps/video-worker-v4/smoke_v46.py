from __future__ import annotations

import claude_edit_spec_v46 as spec


def main():
    baseline = {
        "version": "timeline-v1",
        "jobId": "smoke",
        "style": "ARCHITECTURAL",
        "canvas": {"width": 1080, "height": 1920, "fps": 30, "aspectRatio": "9:16"},
        "safeZone": {"top": 240, "right": 80, "bottom": 320, "left": 80},
        "duration": 18,
        "assets": [{"id": "asset-1", "kind": "video", "duration": 24}],
        "tracks": [
            {"id": "video-main", "kind": "video", "items": []},
            {"id": "graphics-main", "kind": "text", "items": []},
            {"id": "captions", "kind": "caption", "items": []},
            {"id": "audio-events", "kind": "audio_event", "items": []},
            {"id": "vfx", "kind": "vfx", "items": []},
        ],
        "audioPlan": {"music": {}, "ducking": True, "events": []},
        "metadata": {"criticContext": {"referenceIds": ["ref-1"], "dna": {}}},
    }
    inputs = [{"id": "input-1", "asset_id": "asset-1", "duration_seconds": 24}]
    analyses = [{"duration_seconds": 24}]
    edit = {
        "spec_version": spec.SPEC_VERSION,
        "creative_direction": {
            "summary": "architectural vertical cut",
            "pacing": "balanced",
            "reference_rationale": ["match approved pacing"],
        },
        "canvas": {
            "width": 1080,
            "height": 1920,
            "fps": 30,
            "aspect_ratio": "9:16",
            "safe_zone": {"top": 240, "right": 80, "bottom": 320, "left": 80},
        },
        "clips": [
            {
                "asset_id": "asset-1",
                "trim_in": i * 3,
                "trim_out": i * 3 + 2.5,
                "speed": 1.0,
                "volume": 0.10,
                "stage": "VISUAL_HOOK" if i == 0 else ("BRANDED_CLOSE" if i == 5 else "PROPERTY_TOUR"),
                "transition_in": {"kind": "cut", "duration": 0},
                "effects": ["smart_reframe", "color_match"],
                "reason": f"distinct window {i+1}",
            }
            for i in range(6)
        ],
        "on_screen_text": [
            {
                "text": "Produto",
                "start": 0.2,
                "duration": 1.6,
                "x": 92,
                "y": 320,
                "font_size": 60,
                "role": "VISUAL_HOOK",
                "subtype": "kinetic_text",
            }
        ],
        "captions": [],
        "narration": {"enabled": False, "script": "", "voice_notes": ""},
        "music": {"enabled": False, "mood": "", "volume": 0.20, "ducking": True},
        "brand": {"cta": "Fale com a equipe", "closing_text": "Fale com a equipe", "visual_notes": "clean"},
        "qa_notes": ["human review required"],
    }
    report = spec.validate_edit_spec(edit, inputs, analyses, baseline)
    assert report["shots"] == 6
    timeline = spec.spec_to_timeline(
        edit,
        {"id": "smoke", "product_name": "Smoke"},
        inputs,
        analyses,
        baseline,
        {"brainVersion": "smoke", "authMethod": "claude.ai", "subscriptionType": "max"},
    )
    assert timeline["canvas"]["aspectRatio"] == "9:16"
    assert timeline["metadata"]["requiresHumanReview"] is True
    assert len(next(x for x in timeline["tracks"] if x["kind"] == "video")["items"]) == 6
    print("smoke_v46_ok")


if __name__ == "__main__":
    main()
