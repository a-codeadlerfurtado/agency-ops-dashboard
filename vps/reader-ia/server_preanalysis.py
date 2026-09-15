import json
import hashlib
import re
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "8080"))
TRANSLATE_URL = os.getenv("TRANSLATE_URL", "http://reader-ia-translate:5000")
TTS_URL = os.getenv("TTS_URL", "http://reader-ia-tts:8880")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://reader-ia-gemma:11434")
QWEN_URL = os.getenv("QWEN_URL", "http://reader-ia-llm:11434")
TRANSLATION_MODEL = os.getenv("TRANSLATION_MODEL", "translategemma:4b")
INDEX = Path("/app/index.html") if Path("/app/index.html").exists() else Path(__file__).with_name("index.html")
CACHE_ROOT = Path(os.getenv("CACHE_ROOT", "/cache"))
TRANSLATION_CACHE_DIR = CACHE_ROOT / "translations"
TRANSLATION_CACHE_DIR.mkdir(parents=True, exist_ok=True)
PROFILE_PATH = Path("/app/kotler15_profile.json") if Path("/app/kotler15_profile.json").exists() else Path(__file__).with_name("kotler15_profile.json")
KNOWN_DOCUMENTS = {}
if PROFILE_PATH.exists():
    try:
        _profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
        KNOWN_DOCUMENTS[_profile.get("sha256", "")] = _profile
    except Exception as exc:
        print(f"profile_load_failed:{exc}")
KNOWN_BY_ID = {p.get("id"): p for p in KNOWN_DOCUMENTS.values() if p.get("id")}


def split_text(text: str, limit: int = 2800):
    text = (text or "").strip()
    if not text:
        return []
    parts, current = [], ""
    for paragraph in text.splitlines():
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        candidate = f"{current}\n{paragraph}".strip()
        if len(candidate) <= limit:
            current = candidate
            continue
        if current:
            parts.append(current)
        if len(paragraph) <= limit:
            current = paragraph
        else:
            for i in range(0, len(paragraph), limit):
                parts.append(paragraph[i:i + limit])
            current = ""
    if current:
        parts.append(current)
    return parts


PT_LETTERS={"A":"á","B":"bê","C":"cê","D":"dê","E":"ê","F":"éfe","G":"gê","H":"agá","I":"i","J":"jóta","K":"cá","L":"éle","M":"ême","N":"êne","O":"ó","P":"pê","Q":"quê","R":"érre","S":"ésse","T":"tê","U":"u","V":"vê","W":"dáblio","X":"xis","Y":"ípsilon","Z":"zê"}
SPEECH_EXCEPTIONS={"B2B":"bê dois bê","B2C":"bê dois cê","ROI":"rói","SWOT":"suót","CEO":"cí i ô","CMO":"cí em ô","SEO":"ésse ê ó","CRM":"cê érre ême","KPI":"cá pê í","NPS":"êne pê ésse","P&G":"pê e gê","R&D":"érre e dê","AT&T":"êi ti end ti","IBM":"ai bi em","BMW":"bê ême dáblio","IKEA":"iquéia","LEGO":"lêgo","GEICO":"gáico"}
WORD_ACRONYMS={"IKEA","LEGO","SABIC","GEICO","IDEO","ALDI","MINI","NASCAR","ARAMARK"}

def sanitize_document_text(text:str,doc_id:str=""):
    if doc_id!="kotler-keller-marketing-management-15e-global": return text
    out=[]
    for raw in (text or "").splitlines():
        line=" ".join(raw.split()).strip()
        if not line: continue
        if re.fullmatch(r"\d{1,4}",line): continue
        if re.search(r"(?:A|M)\d{2}_KOTL\S*\.indd",line,re.I): continue
        if line.lower().startswith(("mymarketinglab","improve your grade","source: ©","source: ")): continue
        if re.fullmatch(r"(?:www\.|https?://)\S+",line,re.I): continue
        out.append(line)
    return "\n".join(out)

def normalize_speech_text(text:str,doc_id:str=""):
    text=" ".join((text or "").split())
    if doc_id=="kotler-keller-marketing-management-15e-global":
        text=re.sub(r"\bPhilip Kotler\b","Fílip Kótler",text,flags=re.I)
        text=re.sub(r"\bKevin Lane Keller\b","Kévin Leine Kéler",text,flags=re.I)
        text=re.sub(r"\bKotler\b","Kótler",text)
        text=re.sub(r"\bKeller\b","Kéler",text)
    for token,spoken in sorted(SPEECH_EXCEPTIONS.items(),key=lambda kv:-len(kv[0])):
        text=re.sub(rf"(?<!\w){re.escape(token)}(?!\w)",spoken,text,flags=re.I)
    text=re.sub(r"(\d+(?:[\.,]\d+)?)\s*%",r"\1 por cento",text)
    def spell(m):
        token=m.group(0)
        if token in WORD_ACRONYMS:return token
        return " ".join(PT_LETTERS.get(ch,ch) for ch in token)
    text=re.sub(r"\b[A-Z]{2,5}\b",spell,text)
    return text

def translation_cache_path(text,context,source,target,doc_id):
    key=hashlib.sha256(f"v4|{TRANSLATION_MODEL}|{doc_id}|{source}|{target}|{text}|{context[-2200:]}".encode("utf-8")).hexdigest()
    return TRANSLATION_CACHE_DIR/f"{key}.txt"

def request_json(url, payload=None, timeout=120):
    data = None
    headers = {}
    method = "GET"
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def translate_chunk(text: str, source: str, target: str):
    data = request_json(f"{TRANSLATE_URL}/translate", {
        "q": text,
        "source": source,
        "target": target,
        "format": "text",
    })
    return data.get("translatedText", "")

def model_available(base_url: str, model: str):
    try:
        data = request_json(f"{base_url}/api/tags", timeout=1.5)
        names = [str(x.get("name", "")) for x in data.get("models", [])]
        return any(name == model or name.startswith(model + ":") for name in names)
    except Exception:
        return False

def contextual_translate(text: str, context: str = "", doc_id: str = ""):
    profile_note = ""
    if doc_id == "kotler-keller-marketing-management-15e-global":
        profile_note = "This is Philip Kotler and Kevin Lane Keller, Marketing Management, 15th Global Edition. Use natural Brazilian marketing/business vocabulary, preserve proper names and brand names, and keep terminology consistent across pages."
    prompt = f"""You are a professional English (en) to Brazilian Portuguese (pt-BR) translator. {profile_note} Your goal is to accurately convey the meaning, tone and nuances of the original while using natural Brazilian Portuguese suitable for a professionally edited book.

Editorial rules:
- Translate ideas naturally; avoid awkward word-for-word constructions.
- Do not summarize, explain or add commentary.
- Preserve useful titles, subtitles and paragraph breaks.
- Omit PDF/printing artifacts: isolated page numbers, repeated headers/footers, URLs, file paths, print timestamps, browser metadata and 'x of y' counters.
- Keep numbers that are part of the actual content, such as prices, percentages, years, data and numbered lists.
- Use the previous-page context only to resolve continuity; do not reproduce it.
- Produce only the Brazilian Portuguese translation of CURRENT TEXT.

PREVIOUS-PAGE CONTEXT (reference only):
{(context or '')[-2200:]}

CURRENT TEXT TO TRANSLATE:

{text}
"""
    last_error = None
    for base_url, model in ((OLLAMA_URL, TRANSLATION_MODEL), (QWEN_URL, "qwen2.5:3b")):
        try:
            if not model_available(base_url, model):
                print(f"translation_model_not_ready:{model}")
                continue
            data = request_json(f"{base_url}/api/generate", {
                "model": model, "prompt": prompt, "stream": False, "keep_alive": "30m",
                "options": {"temperature": 0.1, "num_ctx": 8192, "num_predict": 2200},
            }, timeout=8)
            result = str(data.get("response", "")).strip()
            if result:
                return result
            last_error = RuntimeError(f"empty_translation:{model}")
        except Exception as exc:
            last_error = exc
            print(f"translation_model_failed:{model}:{exc}")
    raise last_error or RuntimeError("contextual_translation_failed")

def sentence_units(text: str):
    text = re.sub(r'\s+', ' ', (text or '').strip())
    if not text:
        return []
    return [x.strip() for x in re.findall(r'[^.!?…]+(?:[.!?…]+(?:[\"”’\)\]]+)?(?=\s|$)|$)', text) if x.strip()]


def align_translation(source_text: str, target_text: str):
    src = sentence_units(source_text)
    dst = sentence_units(target_text)
    if not src or not dst:
        return []
    if len(src) == len(dst):
        return [{"id": i, "source": a, "target": b} for i, (a, b) in enumerate(zip(src, dst))]
    segments, si, di = [], 0, 0
    src_total = max(1, sum(len(x) for x in src))
    dst_total = max(1, sum(len(x) for x in dst))

    while si < len(src) and di < len(dst):
        src_group, dst_group = [src[si]], [dst[di]]
        sp = sum(len(x) for x in src[:si+1]) / src_total
        dp = sum(len(x) for x in dst[:di+1]) / dst_total
        while sp + 0.10 < dp and si + 1 < len(src):
            si += 1; src_group.append(src[si])
            sp = sum(len(x) for x in src[:si+1]) / src_total
        while dp + 0.10 < sp and di + 1 < len(dst):
            di += 1; dst_group.append(dst[di])
            dp = sum(len(x) for x in dst[:di+1]) / dst_total
        segments.append({"id": len(segments), "source": " ".join(src_group), "target": " ".join(dst_group)})
        si += 1; di += 1
    if si < len(src) and segments:
        segments[-1]["source"] += " " + " ".join(src[si:])
    if di < len(dst) and segments:
        segments[-1]["target"] += " " + " ".join(dst[di:])
    return segments


def structured_translation(text: str, context: str = ""):
    translated = contextual_translate(text, context)
    return translated, align_translation(text, translated)

def synthesize(text: str, voice: str, speed: float):
    payload = json.dumps({
        "model": "tts-1",
        "input": text,
        "voice": voice,
        "response_format": "mp3",
        "speed": max(0.25, min(4.0, speed)),
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{TTS_URL}/v1/audio/speech",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as response:
        return response.read(), response.headers.get("Content-Type", "audio/mpeg")


def normalize_path(raw_path: str):
    path = raw_path.split("?", 1)[0]
    if path == "/reader":
        return "/"
    if path.startswith("/reader/"):
        return path[len("/reader"):]
    return path


class Handler(BaseHTTPRequestHandler):
    server_version = "ReaderPro/2.0"

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = normalize_path(self.path)
        if path == "/health":
            return self.send_json(200, {"ok": True, "service": "reader-ia", "tts": TTS_URL, "translator": OLLAMA_URL, "translation_model": TRANSLATION_MODEL})
        if path == "/api/voices":
            try:
                return self.send_json(200, request_json(f"{TTS_URL}/v1/voices", timeout=30))
            except Exception as exc:
                return self.send_json(503, {"error": "tts_not_ready", "detail": str(exc)[:400]})
        if path in ("/", "/index.html"):
            body = INDEX.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self):
        path = normalize_path(self.path)
        try:
            size = int(self.headers.get("Content-Length", "0"))
            request_data = json.loads(self.rfile.read(size).decode("utf-8"))
            if path == "/api/document-profile":
                sha256 = str(request_data.get("sha256", "")).lower().strip()
                profile = KNOWN_DOCUMENTS.get(sha256)
                return self.send_json(200, {"known": bool(profile), "profile": profile})
            if path == "/api/translate":
                doc_id = str(request_data.get("docId", "")).strip()
                text = sanitize_document_text(str(request_data.get("text", "")).strip(), doc_id)
                context = sanitize_document_text(str(request_data.get("context", "")).strip(), doc_id)
                source = str(request_data.get("source", "en"))
                target = str(request_data.get("target", "pt"))
                mode = str(request_data.get("mode", "editorial"))
                if not text:
                    return self.send_json(400, {"error": "empty_text"})
                cache_path = translation_cache_path(text, context, source, target, doc_id)
                if cache_path.exists():
                    return self.send_json(200, {"translatedText": cache_path.read_text(encoding="utf-8"), "engine": "persistent-cache"})
                if mode in ("editorial", "structured"):
                    try:
                        translated, segments = structured_translation(text, context)
                        return self.send_json(200, {"translatedText": translated, "segments": segments, "engine": "local-contextual-v2"})
                    except Exception as llm_exc:
                        print(f"contextual_translate_failed: {llm_exc}")
                translated = "\n".join(translate_chunk(chunk, source, target) for chunk in split_text(text))
                return self.send_json(200, {"translatedText": translated, "segments": align_translation(text, translated), "engine": "literal-fallback"})
            if path == "/api/tts":
                doc_id = str(request_data.get("docId", "")).strip()
                text = str(request_data.get("text", "")).strip()
                voice = str(request_data.get("voice", "pm_jarvis"))
                speed = float(request_data.get("speed", 1.0))
                if not text:
                    return self.send_json(400, {"error": "empty_text"})
                spoken_text = normalize_speech_text(text, doc_id)
                audio, content_type = synthesize(spoken_text, voice, speed)
                return self.send_bytes(200, audio, content_type)
            return self.send_error(404)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")[:800]
            self.send_json(502, {"error": "upstream_http_error", "detail": detail})
        except Exception as exc:
            self.send_json(500, {"error": "reader_request_failed", "detail": str(exc)[:800]})

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}")


if __name__ == "__main__":
    print(f"Reader IA listening on {HOST}:{PORT}; translator={TRANSLATE_URL}; tts={TTS_URL}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
