import asyncio
import io
import os
import re
import secrets
import threading
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from chatterbox.mtl_tts import ChatterboxMultilingualTTS

TOKEN = os.environ.get("JARVIS_TTS_TOKEN", "")
REFERENCE = Path(os.environ.get("JARVIS_REFERENCE_WAV", "/app/reference/voice.wav"))
DEVICE = os.environ.get("JARVIS_TTS_DEVICE", "cuda")
MAX_CHARS = int(os.environ.get("JARVIS_TTS_MAX_CHARS", "1200"))
CHUNK_CHARS = int(os.environ.get("JARVIS_TTS_CHUNK_CHARS", "280"))
EXAGGERATION = float(os.environ.get("JARVIS_TTS_EXAGGERATION", "0.42"))
CFG_WEIGHT = float(os.environ.get("JARVIS_TTS_CFG_WEIGHT", "0.30"))
TEMPERATURE = float(os.environ.get("JARVIS_TTS_TEMPERATURE", "0.72"))

_model = None
_model_lock = threading.Lock()
_generation_lock = threading.Lock()
app = FastAPI(title="Jarvis TTS", docs_url=None, redoc_url=None)


class TtsRequest(BaseModel):
    text: str
def get_model():
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        if DEVICE == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA indisponivel")
        if not REFERENCE.is_file():
            raise RuntimeError(f"referencia ausente: {REFERENCE}")
        _model = ChatterboxMultilingualTTS.from_pretrained(
            device=DEVICE,
            t3_model="v3",
        )
        _model.prepare_conditionals(str(REFERENCE), exaggeration=EXAGGERATION)
        return _model

def split_text(text: str) -> list[str]:
    text = re.sub(r"\s+", " ", text).strip()[:MAX_CHARS]
    if not text:
        return []
    sentences = re.split(r"(?<=[.!?;:])\s+", text)
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > CHUNK_CHARS:
            words = sentence.split()
            sentence_parts: list[str] = []
            part = ""
            for word in words:
                candidate = f"{part} {word}".strip()
                if part and len(candidate) > CHUNK_CHARS:
                    sentence_parts.append(part)
                    part = word
                else:
                    part = candidate
            if part:
                sentence_parts.append(part)
        else:
            sentence_parts = [sentence]
        for piece in sentence_parts:
            candidate = f"{current} {piece}".strip()
            if current and len(candidate) > CHUNK_CHARS:
                chunks.append(current)
                current = piece
            else:
                current = candidate
    if current:
        chunks.append(current)
    return chunks


def generate_wav(text: str) -> bytes:
    model = get_model()
    chunks = split_text(text)
    if not chunks:
        raise ValueError("texto vazio")
    pieces: list[np.ndarray] = []
    with _generation_lock:
        for index, chunk in enumerate(chunks):
            wav = model.generate(
                chunk,
                language_id="pt",
                exaggeration=EXAGGERATION,
                temperature=TEMPERATURE,
                cfg_weight=CFG_WEIGHT,
            )
            audio = wav.squeeze().detach().cpu().float().numpy()
            pieces.append(audio)
            if index < len(chunks) - 1:
                pieces.append(np.zeros(int(model.sr * 0.12), dtype=np.float32))
    merged = np.concatenate(pieces)
    out = io.BytesIO()
    sf.write(out, merged, model.sr, format="WAV", subtype="PCM_16")
    return out.getvalue()


def require_token(value: str | None) -> None:
    if not TOKEN:
        raise HTTPException(status_code=503, detail="token nao configurado")
    if not value or not secrets.compare_digest(value, TOKEN):
        raise HTTPException(status_code=401, detail="nao autorizado")


@app.get("/health")
def health():
    return {
        "ok": True,
        "model_loaded": _model is not None,
        "device": DEVICE,
        "reference": REFERENCE.is_file(),
    }


@app.post("/tts")
async def tts(payload: TtsRequest, x_jarvis_token: str | None = Header(default=None)):
    require_token(x_jarvis_token)
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="texto vazio")
    try:
        audio = await asyncio.to_thread(generate_wav, text)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"sintese falhou: {type(exc).__name__}") from exc
    return Response(content=audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@app.on_event("startup")
def preload_model() -> None:
    if os.environ.get("JARVIS_TTS_PRELOAD", "1") == "1":
        get_model()
