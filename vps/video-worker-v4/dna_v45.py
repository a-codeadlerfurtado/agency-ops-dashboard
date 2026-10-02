from __future__ import annotations

import copy
import re

DNA_VERSION = "approved-reference-dna-v4.5.0"

DEFAULTS = {
    "PROPERTY_TOUR": {
        "style": "ARCHITECTURAL",
        "target_duration_seconds": 34.0,
        "avg_shot_duration": 3.2,
        "max_visible_transitions": 1,
        "text_mode": "DUAL_HIERARCHY_LOWER",
        "price_start_ratio": 0.76,
        "cta_start_ratio": 0.91,
    },
    "DEVELOPMENT_LIFESTYLE": {
        "style": "LIFESTYLE",
        "target_duration_seconds": 45.0,
        "avg_shot_duration": 2.1,
        "max_visible_transitions": 1,
        "text_mode": "PREMIUM_TOP_BAND",
        "price_start_ratio": 0.82,
        "cta_start_ratio": 0.92,
    },
}

def _txt(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _fields(job):
    out = {}
    pc = job.get("product_context") or {}
    fields = ((job.get("client_context") or {}).get("fields") or {})
    for key, value in pc.items():
        if value not in (None, "") and not isinstance(value, (dict, list)):
            out[str(key)] = _txt(value)
    for key, row in fields.items():
        if isinstance(row, dict) and row.get("value") not in (None, ""):
            out.setdefault(str(key), _txt(row["value"]))
    return out


def _first(values, *keys):
    for key in keys:
        value = values.get(key)
        if value:
            return value
    return None


def infer_product_type(job):
    values = _fields(job)
    hay = " ".join([
        _txt(job.get("product_name")),
        _txt(_first(values, "type", "tipo", "product_type", "categoria")),
        _txt(_first(values, "description", "descricao")),
    ]).lower()
    development = (
        "empreendimento", "lançamento", "lancamento", "residencial",
        "condomínio", "condominio", "loteamento", "club", "residence",
    )
    return "DEVELOPMENT_LIFESTYLE" if any(x in hay for x in development) else "PROPERTY_TOUR"


def _profile_score(row, job, product_type):
    score = 0
    client_id = str(job.get("client_id") or "")
    if row.get("client_id") and str(row.get("client_id")) == client_id:
        score += 100
    elif row.get("client_id"):
        return -1000
    if str(row.get("product_type") or "") == product_type:
        score += 35
    if str(row.get("status") or "ACTIVE") == "ACTIVE":
        score += 10
    score += float(row.get("confidence") or 0) * 10
    return score


def select_profile(job):
    pack = job.get("_reference_pack") or {}
    profiles = pack.get("profiles") or []
    product_type = infer_product_type(job)
    ranked = sorted(
        ((_profile_score(row, job, product_type), row) for row in profiles),
        key=lambda x: x[0],
        reverse=True,
    )
    if ranked and ranked[0][0] > -500:
        row = copy.deepcopy(ranked[0][1])
        dna = dict(DEFAULTS.get(product_type, {}))
        dna.update(row.get("dna") or {})
        row["dna"] = dna
        row["selection_score"] = ranked[0][0]
        return row
    return {
        "id": None,
        "profile_key": f"fallback:{product_type.lower()}",
        "client_id": None,
        "product_type": product_type,
        "status": "ACTIVE",
        "confidence": 0.5,
        "dna": dict(DEFAULTS[product_type]),
        "selection_score": 0,
    }


def prepare_job(job):
    prepared = copy.deepcopy(job)
    profile = select_profile(prepared)
    dna = profile.get("dna") or {}
    strategy = dict(prepared.get("edit_strategy") or {})
    automatic = (
        str(strategy.get("source") or "").lower() in {"v4_auto_upload", "auto_raw_upload"}
        or bool((prepared.get("metadata") or {}).get("auto_upload_batch"))
    )
    if automatic or not strategy.get("style"):
        strategy["style"] = dna.get("style") or strategy.get("style")
    if automatic or not strategy.get("target_duration_seconds"):
        strategy["target_duration_seconds"] = float(dna.get("target_duration_seconds") or 30)
    strategy["approved_reference_dna"] = True
    prepared["edit_strategy"] = strategy
    prepared["_selected_dna_profile"] = profile
    return prepared


def _text(text, start, duration, y, size, role, subtype, font_role="sans", **extra):
    if not _txt(text):
        return None
    return {
        "id": f"dna-{subtype}-{int(start*100)}",
        "type": "text",
        "subtype": subtype,
        "stage": role,
        "start": round(float(start), 3),
        "duration": round(max(0.5, float(duration)), 3),
        "text": _txt(text),
        "fontRole": font_role,
        "fontFamily": "DejaVu Serif" if font_role == "serif" else "DejaVu Sans",
        "fontSize": int(size),
        "fontWeight": 700,
        "color": "#FFFFFF",
        "align": extra.pop("align", "left"),
        "x": int(extra.pop("x", 92)),
        "y": int(y),
        "maxWidth": int(extra.pop("maxWidth", 880)),
        "shadow": {"color": "#000000AA", "blur": 14, "x": 0, "y": 4},
        **extra,
    }


def _fact_line(job):
    f = _fields(job)
    area = _first(f, "area", "area_m2", "metragem")
    beds = _first(f, "bedrooms", "quartos", "dormitorios", "dormitórios")
    suites = _first(f, "suites", "suites_count", "suite")
    parking = _first(f, "parking", "vagas", "parking_spaces")
    parts = []
    if area:
        parts.append(area if any(x in area.lower() for x in ("m²", "m2")) else f"{area} m²")
    if beds:
        parts.append(f"{beds} dorm.")
    if suites:
        parts.append(f"{suites} suíte")
    if parking:
        parts.append(f"{parking} vagas")
    return " • ".join(parts)


def apply_profile(job, timeline):
    profile = job.get("_selected_dna_profile") or select_profile(job)
    dna = profile.get("dna") or {}
    target = float(timeline.get("duration") or dna.get("target_duration_seconds") or 30)
    values = _fields(job)
    product = _txt(job.get("product_name"))
    location = _first(values, "location", "localizacao", "bairro", "city", "cidade", "address")
    price = _first(values, "price", "preco", "valor")
    facts = _fact_line(job)
    client = _txt((((job.get("client_context") or {}).get("client") or {}).get("name")))
    cta = _first(values, "cta", "call_to_action", "whatsapp_cta") or client
    mode = str(dna.get("text_mode") or "DUAL_HIERARCHY_LOWER")
    price_ratio = float(dna.get("price_start_ratio") or 0.78)
    cta_ratio = float(dna.get("cta_start_ratio") or 0.91)
    texts = []

    if mode == "PERSISTENT_TOP_SPECS":
        texts += [
            _text(product or location, 0.3, target * 0.86, 230, 38, "PROPERTY_TOUR", "persistent_title",
                  "sans", boxOpacity=0.30, x=78, maxWidth=924),
            _text(" • ".join(x for x in (facts, price) if x), 0.3, target * 0.86, 285, 31,
                  "PROPERTY_TOUR", "persistent_specs", "sans", boxOpacity=0.30, x=78, maxWidth=924),
        ]
    elif mode == "PREMIUM_TOP_BAND":
        texts += [
            _text(facts or location, 0.25, min(4.0, target * 0.14), 230, 31, "VISUAL_HOOK",
                  "premium_descriptor", "sans", boxOpacity=0.30, x=76, maxWidth=930),
            _text(product or location, 0.25, min(4.0, target * 0.14), 285, 56, "VISUAL_HOOK",
                  "premium_headline", "serif", boxOpacity=0.30, x=76, maxWidth=930),
        ]
    else:
        texts += [
            _text(location or facts, 0.18, min(3.2, target * 0.14), 1260, 34, "VISUAL_HOOK",
                  "lower_descriptor", "sans"),
            _text(product or facts, 0.18, min(3.2, target * 0.14), 1320, 58, "VISUAL_HOOK",
                  "lower_headline", "serif"),
        ]

    if price:
        texts.append(_text(
            price, target * price_ratio, min(2.8, target * 0.10),
            1320 if mode != "PREMIUM_TOP_BAND" else 260,
            55, "COMMERCIAL_SAFE", "price_card",
            "serif" if mode != "PERSISTENT_TOP_SPECS" else "sans",
            boxOpacity=0.32,
        ))
    if cta:
        texts.append(_text(
            cta, target * cta_ratio, max(1.2, target * (1.0 - cta_ratio) - 0.15),
            1390 if mode != "PREMIUM_TOP_BAND" else 300, 48,
            "BRANDED_CLOSE", "brand_outro",
            "serif" if mode != "PERSISTENT_TOP_SPECS" else "sans",
            boxOpacity=0.30,
        ))
    texts = [x for x in texts if x]
    for track in timeline.get("tracks") or []:
        if track.get("kind") == "text":
            track["items"] = texts
            track["name"] = f"Approved DNA / {mode}"
            break


    references = (job.get("_reference_pack") or {}).get("references") or []
    selected_ids = {str(x) for x in (profile.get("reference_ids") or [])}
    if selected_ids:
        references = [x for x in references if str(x.get("id")) in selected_ids]
    timeline["directorVersion"] = "creative-director-v4.5.0"
    timeline["strategyVersion"] = DNA_VERSION
    timeline.setdefault("metadata", {}).update({
        "approvedReferenceDNA": True,
        "dnaVersion": DNA_VERSION,
        "dnaProfileId": profile.get("id"),
        "dnaProfileKey": profile.get("profile_key"),
        "dnaProductType": profile.get("product_type"),
        "dnaTextMode": mode,
        "dnaConfidence": profile.get("confidence"),
        "approvedReferenceIds": [x.get("id") for x in references if x.get("id")],
        "approvedReferenceDriveFileIds": [
            x.get("drive_file_id") for x in references if x.get("drive_file_id")
        ],
        "criticContext": {
            "dnaProfileId": profile.get("id"),
            "dna": dna,
            "referenceIds": [x.get("id") for x in references if x.get("id")],
            "hasPrice": bool(price),
        },
    })
    return timeline
