from __future__ import annotations

import worker as w
import worker_v45
import critic_v45

CASES = [
    ("Trilar", "40fd76d2-be7e-4199-a91c-53bdbb7c2efc", "PROPERTY_TOUR", 33.0, 3.2, "DUAL_HIERARCHY_LOWER"),
    ("Wall Street", "da855fbb-0952-4774-bafa-1a2a0dd00599", "PROPERTY_TOUR", 60.0, 8.0, "PERSISTENT_TOP_SPECS"),
    ("Nexus", "f1a41a2b-9c86-4372-8528-2d2c0861eb0c", "DEVELOPMENT_LIFESTYLE", 30.0, 3.4, "DUAL_HIERARCHY_LOWER"),
    ("Renata Fiel", "41d70cb8-2160-4abe-9b96-a2cae27e91b6", "DEVELOPMENT_LIFESTYLE", 59.0, 2.0, "PREMIUM_TOP_BAND"),
]

INPUTS = [
    {"id": f"i{x}", "asset_id": f"a{x}", "drive_file_id": f"d{x}", "file_name": f"clip{x}.mp4"}
    for x in range(4)
]

VISION = {
    "available": True, "quality_score": 82, "motion_score": 0.5,
    "edge_density": 0.08, "brightness": 0.52, "contrast": 0.55,
    "saturation": 0.32, "focus": {"x": 0.5, "y": 0.5, "confidence": 0.7},
    "white_balance": {"r": 1, "g": 1, "b": 1}, "jitter_score": 0.05,
    "motion_direction": "right",
}
ANALYSES = [
    {"duration_seconds": 70.0, "width": 1080, "height": 1920, "fps": 30.0,
     "cut_timestamps": [], "black_ranges": [], "vision": dict(VISION)}
    for _ in INPUTS
]


def run_case(index, row):
    name, client_id, product_type, target, avg, mode = row
    ref_id = f"45000000-0000-4000-8000-00000000000{index+1}"
    profile_id = f"45100000-0000-4000-8000-00000000000{index+1}"
    style = "LIFESTYLE" if name == "Renata Fiel" else ("LAUNCH" if name == "Nexus" else "ARCHITECTURAL")
    dna = {
        "style": style, "target_duration_seconds": target, "avg_shot_duration": avg,
        "max_visible_transitions": 0 if name == "Wall Street" else 1,
        "text_mode": mode, "price_start_ratio": 0.80, "cta_start_ratio": 0.92,
    }
    profile = {
        "id": profile_id, "client_id": client_id, "profile_key": name.lower(),
        "product_type": product_type, "status": "ACTIVE", "confidence": 0.96,
        "reference_ids": [ref_id], "dna": dna,
    }
    job = {
        "id": f"job-{index}", "client_id": client_id,
        "product_name": "Residencial Teste" if "DEVELOPMENT" in product_type else "Casa Teste",
        "product_context": {"price": "R$ 1.250.000", "area": "155", "bedrooms": "3", "suites": "1", "parking": "3"},
        "client_context": {"client": {"name": name}, "fields": {}},
        "edit_strategy": {"source": "v4_auto_upload", "target_duration_seconds": 18},
        "metadata": {"auto_upload_batch": True},
        "_reference_pack": {
            "profiles": [profile],
            "references": [{"id": ref_id, "drive_file_id": f"drive-{index}"}],
        },
    }
    timeline = w.build_timeline(job, INPUTS, ANALYSES)
    vector = critic_v45.learning.timeline_feature_vector(timeline)
    report = critic_v45.evaluate(worker_v45._runtime_job(timeline), timeline, {"pass": True, "checks": {}})
    assert abs(float(timeline["duration"]) - target) < 0.05, (name, timeline["duration"], target)
    assert timeline["metadata"]["dnaTextMode"] == mode, (name, timeline["metadata"]["dnaTextMode"], mode)
    assert timeline["metadata"]["approvedReferenceIds"] == [ref_id], (name, timeline["metadata"]["approvedReferenceIds"])
    assert report["status"] == "PASS", (name, report)
    return name, vector["shots"], vector["avg_shot_duration"], report["score"]


if __name__ == "__main__":
    results = [run_case(i, row) for i, row in enumerate(CASES)]
    print("V45_DNA_SMOKE_OK", results)
