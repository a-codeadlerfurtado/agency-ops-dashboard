import json
import hashlib
import os
import re
import urllib.error
import urllib.request
import urllib.parse
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "8080"))
TRANSLATE_URL = os.getenv("TRANSLATE_URL", "http://reader-ia-translate:5000")
TTS_URL = os.getenv("TTS_URL", "http://reader-ia-tts:8880")
TTS_PREFETCH_URL = os.getenv("TTS_PREFETCH_URL", "http://reader-ia-tts-bg:8880")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://reader-ia-gemma:11434")
QWEN_URL = os.getenv("QWEN_URL", "http://reader-ia-llm:11434")
TRANSLATION_MODEL = os.getenv("TRANSLATION_MODEL", "translategemma:4b")
GRAMMAR_URL = os.getenv("GRAMMAR_URL", "http://reader-ia-grammar:8081")
PTBR_REVIEW_MODEL = os.getenv("PTBR_REVIEW_MODEL", "qwen2.5:3b")
INDEX = Path("/app/index.html") if Path("/app/index.html").exists() else Path(__file__).with_name("index.html")
APP = Path("/app/app-v2.mjs") if Path("/app/app-v2.mjs").exists() else Path(__file__).with_name("app-v2.mjs")
MANIFEST = Path("/app/manifest.webmanifest") if Path("/app/manifest.webmanifest").exists() else Path(__file__).with_name("manifest.webmanifest")
SW = Path("/app/sw.js") if Path("/app/sw.js").exists() else Path(__file__).with_name("sw.js")
ASSET_ROOT = Path("/app/assets") if Path("/app/assets").exists() else Path(__file__).with_name("assets")
CACHE_ROOT = Path(os.getenv("CACHE_ROOT", "/cache"))
TRANSLATION_CACHE_DIR = CACHE_ROOT / "translations"
TRANSLATION_CACHE_DIR.mkdir(parents=True, exist_ok=True)
TTS_CACHE_DIR = CACHE_ROOT / "tts"
TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
LIBRARY_ROOT = Path(os.getenv("LIBRARY_ROOT", "/library"))
PROFILE_NAMES = ("kotler15_profile.json", "zikmund4_profile.json", "greene48_profile.json")
KNOWN_DOCUMENTS = {}
for _name in PROFILE_NAMES:
    _candidate = Path("/app") / _name
    if not _candidate.exists(): _candidate = Path(__file__).with_name(_name)
    if not _candidate.exists(): continue
    try:
        _profile = json.loads(_candidate.read_text(encoding="utf-8"))
        if _profile.get("sha256"): KNOWN_DOCUMENTS[_profile["sha256"]] = _profile
    except Exception as exc: print(f"profile_load_failed:{_name}:{exc}")
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
    if not doc_id: return text
    out=[]
    for raw in (text or "").splitlines():
        line=" ".join(raw.split()).strip()
        if not line: continue
        if re.fullmatch(r"\d{1,4}",line): continue
        if doc_id=="kotler-keller-marketing-management-15e-global" and re.search(r"(?:A|M)\d{2}_KOTL\S*\.indd",line,re.I): continue
        low=line.lower()
        if low.startswith(("mymarketinglab","improve your grade","source: ©","source: ")): continue
        if doc_id=="zikmund-marketing-research-4e-asia-pacific" and low.startswith(("coursemate online study tools","courtesy of qualtrics.com","survey this!")): continue
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
    profile=KNOWN_BY_ID.get(doc_id)
    if profile:
        for token,spoken in sorted((profile.get("speechTerms") or {}).items(),key=lambda kv:-len(kv[0])):
            text=re.sub(rf"(?<!\w){re.escape(token)}(?!\w)",spoken,text,flags=re.I)
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
    key=hashlib.sha256(f"v12-source-punct-fidelity|{TRANSLATION_MODEL}|{doc_id}|{source}|{target}|{text}|{context[-2200:]}".encode("utf-8")).hexdigest()
    return TRANSLATION_CACHE_DIR/f"{key}.json"

def write_translation_cache(path, payload):
    try:
        tmp=path.with_suffix('.tmp')
        tmp.write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8')
        os.replace(tmp,path)
    except Exception as exc:
        print(f"translation_cache_write_failed:{exc}")

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
    profile=KNOWN_BY_ID.get(doc_id)
    if profile:
        authors=", ".join(profile.get("authors") or [])
        profile_note=f"This is {profile.get('title','a business textbook')} by {authors}. Use natural Brazilian academic/business vocabulary, preserve proper names, statistical notation and brand/software names, and keep terminology consistent across pages."
    prompt = f"""You are a professional English (en) to Brazilian Portuguese (pt-BR) translator. {profile_note} Your goal is to accurately convey the meaning, tone and nuances of the original while using natural Brazilian Portuguese suitable for a professionally edited book.

Editorial rules:
- Translate ideas naturally; avoid awkward word-for-word constructions.
- Do not summarize, explain or add commentary.
- Preserve useful titles, subtitles and paragraph breaks.
- Preserve sentence boundaries and terminal punctuation from the source whenever grammatically possible.
- Never add a period, question mark or exclamation mark to a heading/subheading that has none in the source.
- Do not split one source sentence into multiple target sentences or merge separate source sentences unless absolutely required for correct Brazilian Portuguese.
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
    units=[]
    for raw in (text or '').splitlines():
        line=re.sub(r'[ \t]+',' ',raw).strip()
        if not line: continue
        found=[x.strip() for x in re.findall(r'[^.!?…]+(?:[.!?…]+(?:[\"”’\)\]]+)?(?=\s|$)|$)',line) if x.strip()]
        units.extend(found or [line])
    return units

def preserve_terminal_punctuation(source: str, target: str):
    source=(source or '').strip(); target=(target or '').strip()
    if not target: return target
    sm=re.search(r'([.!?…]+)[\"”’\)\]]*$',source)
    tm=re.search(r'([.!?…]+)([\"”’\)\]]*)$',target)
    if not sm:
        return re.sub(r'[.!?…]+([\"”’\)\]]*)$',r'\1',target).rstrip()
    mark=sm.group(1)
    if tm: return target[:tm.start(1)]+mark+tm.group(2)
    return target+mark


def align_translation(source_text: str, target_text: str):
    src = sentence_units(source_text)
    dst = sentence_units(target_text)
    if not src or not dst:
        return []
    if len(src) == len(dst):
        return [{"id": i, "source": a, "target": preserve_terminal_punctuation(a,b)} for i, (a, b) in enumerate(zip(src, dst))]
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
        src_join=" ".join(src_group); dst_join=" ".join(dst_group); segments.append({"id": len(segments), "source": src_join, "target": preserve_terminal_punctuation(src_join,dst_join)})
        si += 1; di += 1
    if si < len(src) and segments:
        segments[-1]["source"] += " " + " ".join(src[si:])
    if di < len(dst) and segments:
        segments[-1]["target"] += " " + " ".join(dst[di:])
    return segments


def semantic_chunks(text: str, limit: int = 1150):
    units=sentence_units(text)
    if not units:return []
    chunks=[];current=[];size=0
    for unit in units:
        if current and size+len(unit)+1>limit:
            chunks.append("\n".join(current));current=[];size=0
        current.append(unit);size+=len(unit)+1
    if current:chunks.append("\n".join(current))
    return chunks

def polish_fast_translation(text: str, doc_id: str = ""):
    out=" ".join((text or "").split())
    out=re.sub(r"\b(\d+)a edição\b",r"\1ª edição",out,flags=re.I)
    out=re.sub(r"\b(\d+)o capítulo\b",r"\1º capítulo",out,flags=re.I)
    if doc_id=="kotler-keller-marketing-management-15e-global":
        out=re.sub(r"\bMarketing Management\b","Administração de Marketing",out,flags=re.I)
        out=re.sub(r"\bdo Administração de Marketing\b","de Administração de Marketing",out,flags=re.I)
        out=re.sub(r"\bno Administração de Marketing\b","em Administração de Marketing",out,flags=re.I)
        out=re.sub(r"\bpelo Administração de Marketing\b","por Administração de Marketing",out,flags=re.I)
        out=re.sub(r"\bMarketing Insight\b","Insight de Marketing",out,flags=re.I)
        out=re.sub(r"\bMarketing Memo\b","Memorando de Marketing",out,flags=re.I)
    return out.strip()

def request_form_json(url: str, fields: dict, timeout: float = 4):
    data = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type":"application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def fix_concessive_subjunctive(text: str):
    forms={"est\u00e1":"esteja","est\u00e3o":"estejam","\u00e9":"seja","s\u00e3o":"sejam","tem":"tenha","t\u00eam":"tenham","pode":"possa","podem":"possam","faz":"fa\u00e7a","fazem":"fa\u00e7am","continua":"continue","continuam":"continuem","permanece":"permane\u00e7a","permanecem":"permane\u00e7am"}
    pat=re.compile(r"\b(mesmo que|embora|ainda que)\b([^,.!?;]{0,220}?)\b(est\u00e1|est\u00e3o|\u00e9|s\u00e3o|tem|t\u00eam|pode|podem|faz|fazem|continua|continuam|permanece|permanecem)\b",re.I)
    def repl(m):
        old=m.group(3); new=forms.get(old.lower(),old); return m.group(1)+m.group(2)+(new.capitalize() if old[:1].isupper() else new)
    return pat.sub(repl,text)

def ptbr_surface_polish(text: str):
    out=" ".join((text or "").split())
    pairs=((r"\bactualiza\u00e7\u00e3o\b","atualiza\u00e7\u00e3o"),(r"\bactualiza\u00e7\u00f5es\b","atualiza\u00e7\u00f5es"),(r"\bactualizado\b","atualizado"),(r"\bactualizada\b","atualizada"),(r"\bactualizados\b","atualizados"),(r"\bactualizadas\b","atualizadas"),(r"\bobjectivo\b","objetivo"),(r"\bobjectivos\b","objetivos"),(r"\bprojecto\b","projeto"),(r"\bprojectos\b","projetos"),(r"\bcontacto\b","contato"),(r"\bcontactos\b","contatos"),(r"\bequipa\b","equipe"),(r"\bficheiro\b","arquivo"),(r"\becr\u00e3\b","tela"),(r"\bse for caso disso\b","quando apropriado"),(r"\breflectir\b","refletir"),(r"\breflecte\b","reflete"),(r"\breflectem\b","refletem"),(r"\breflectido\b","refletido"),(r"\breflectida\b","refletida"),(r"\breflectindo\b","refletindo"))
    for pat,repl in pairs: out=re.sub(pat,repl,out,flags=re.I)
    out=re.sub(r"[,;:]?\s+\b(e|mas|ou|porque|que)\.\s*$", ".", out, flags=re.I)
    return fix_concessive_subjunctive(out).strip()

def request_form_json(url: str, fields: dict, timeout: float=4):
    data=urllib.parse.urlencode(fields).encode("utf-8"); req=urllib.request.Request(url,data=data,headers={"Content-Type":"application/x-www-form-urlencoded"},method="POST")
    with urllib.request.urlopen(req,timeout=timeout) as response:return json.loads(response.read().decode("utf-8"))

def grammar_findings(text: str):
    try:
        data=request_form_json(f"{GRAMMAR_URL}/v2/check",{"language":"pt-BR","level":"picky","text":text},3.5); return [m for m in data.get("matches",[]) if str(m.get("rule",{}).get("issueType","")).lower()=="grammar"]
    except Exception as exc: print(f"grammar_check_failed:{exc}"); return []
def apply_grammar_suggestions(text: str, issues):
    out=text
    for m in sorted(issues,key=lambda x:int(x.get("offset",0)),reverse=True):
        reps=m.get("replacements") or []
        if not reps: continue
        value=str(reps[0].get("value","")).strip(); off=int(m.get("offset",0)); length=int(m.get("length",0))
        if value and 0<=off<=len(out) and off+length<=len(out): out=out[:off]+value+out[off+length:]
    return out

def apply_fidelity_fixes(source: str, target: str):
    out=target or ""
    m=re.search(r"\b(?:almost|nearly)\s+(\d+(?:[.,]\d+)?)",source or "",re.I)
    if m and not re.search(r"\bquase\b",out,re.I):
        n=re.escape(m.group(1)); out=re.sub(rf"(?<![\d])({n})(?![\d])",r"quase \1",out,count=1)
    if re.search(r"\bthen[.!?]?\s*$",source or "",re.I) and not re.search(r"\b(então|época|momento|naquele tempo|naquele período)\b",out,re.I):
        out=re.sub(r"([.!?]?)$",lambda m:(" na época"+m.group(1)),out.rstrip(),count=1)
    return out

def fidelity_risk(source: str, target: str):
    s=(source or "").lower(); t=(target or "").lower()
    if re.search(r"\b(almost|nearly)\b",s) and "quase" not in t:return True
    if re.search(r"\bthen[.!?]?\s*$",s) and not re.search(r"\b(então|época|momento|naquele tempo|naquele período)\b",t):return True
    return False

def suspicious_ptbr(text: str):
    return bool(re.search(r"\b(mesmo que|embora|ainda que)\b[^,.!?;]{0,220}\b(est\u00e1|est\u00e3o|\u00e9|s\u00e3o|tem|t\u00eam|pode|podem|faz|fazem|continua|continuam|permanece|permanecem)\b|\b(actualiz|objectiv|projecto|contacto|equipa|ficheiro)\w*",text or "",re.I))

def review_ptbr_segments(segments, doc_id: str=""):
    reviewed=[]
    for seg in segments or []:
        item=dict(seg); item["target"]=ptbr_surface_polish(polish_fast_translation(str(item.get("target","")),doc_id)); reviewed.append(item)
    if not reviewed:return reviewed
    with ThreadPoolExecutor(max_workers=min(8,len(reviewed))) as pool: findings=list(pool.map(lambda x: grammar_findings(x.get("target","")),reviewed))
    flagged=[]
    for i,(seg,issues) in enumerate(zip(reviewed,findings)):
        seg["target"]=apply_fidelity_fixes(seg.get("source",""),ptbr_surface_polish(apply_grammar_suggestions(seg["target"],issues)))
        unsafe=any(not (m.get("replacements") or []) for m in issues)
        if suspicious_ptbr(seg["target"]) or fidelity_risk(seg.get("source",""),seg["target"]) or unsafe: flagged.append((i,seg))
    if flagged and model_available(QWEN_URL,PTBR_REVIEW_MODEL):
        blocks="\n\n".join(f"[U{i}]\nEN: {seg.get('source','')}\nPT: {seg.get('target','')}" for i,seg in flagged)
        prompt="Revise gramatica, concordancia, regencia, modo/tempo verbal, naturalidade e fidelidade em portugues brasileiro. Preserve exatamente o sentido do ingles, incluindo quantificadores como almost/nearly, negacoes, marcadores temporais como then, numeros, nomes e pontuacao final. Nao resuma nem acrescente informacao. Retorne somente [U#] texto revisado.\n\n"+blocks
        try:
            data=request_json(f"{QWEN_URL}/api/generate",{"model":PTBR_REVIEW_MODEL,"prompt":prompt,"stream":False,"keep_alive":"30m","options":{"temperature":0,"num_ctx":4096,"num_predict":900}},timeout=8); result=str(data.get("response","")).strip(); found={int(m.group(1)):" ".join(m.group(2).split()).strip() for m in re.finditer(r"(?s)\[U(\d+)\]\s*(.*?)(?=\n\s*\[U\d+\]|\Z)",result)}
            for i,seg in flagged:
                if found.get(i): seg["target"]=ptbr_surface_polish(preserve_terminal_punctuation(seg.get("source",""),found[i]))
        except Exception as exc: print(f"ptbr_llm_review_failed:{exc}")
    for seg in reviewed: seg["target"]=preserve_terminal_punctuation(seg.get("source",""),ptbr_surface_polish(seg.get("target","")))
    return reviewed

def fast_structured_translation(text: str, source: str, target: str, doc_id: str = ""):
    chunks=semantic_chunks(text)
    if not chunks:return "",[]
    workers=min(4,len(chunks))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        translated=list(pool.map(lambda c: translate_chunk(c,source,target),chunks))
    all_segments=[];parts=[]
    for src_chunk,dst_chunk in zip(chunks,translated):
        dst_chunk=polish_fast_translation(dst_chunk,doc_id);parts.append(dst_chunk)
        for seg in align_translation(src_chunk,dst_chunk):
            seg["id"]=len(all_segments);all_segments.append(seg)
    all_segments=review_ptbr_segments(all_segments,doc_id)
    return " ".join(seg.get("target","") for seg in all_segments).strip(),all_segments


def contextual_translate_aligned(text: str, context: str = "", doc_id: str = ""):
    units=sentence_units(text)
    if not units: return "",[]
    profile=KNOWN_BY_ID.get(doc_id) or {}
    title=profile.get("title","the book")
    authors=", ".join(profile.get("authors") or [])
    encoded="\n".join(f"[U{i}] {u}" for i,u in enumerate(units))
    prompt=f"""Translate the numbered units from English to natural Brazilian Portuguese for a professionally edited business/marketing book. The book is {title} by {authors}.

STRICT FORMAT AND FIDELITY RULES:
- Return exactly one line for every input unit, in the same order and with the same [U#] marker.
- Translate each unit independently but use surrounding units and previous-page context for meaning.
- Do not merge units. Do not split units. Do not omit content. Do not add explanations.
- Preserve meaning, numbers, brands, technical terms and level of formality.
- Use Brazilian Portuguese, never European Portuguese. Prefer 'pesquisa de marketing' over 'investigação de marketing'.
- If a source heading has no terminal punctuation, its translation must also have none.
- Preserve ?, ! and sentence-final punctuation.
- Output only the [U#] lines.

PREVIOUS PAGE CONTEXT (reference only):
{(context or '')[-1800:]}

UNITS:
{encoded}
"""
    last_error=None
    for base_url,model in ((OLLAMA_URL,TRANSLATION_MODEL),(QWEN_URL,"qwen2.5:3b")):
        try:
            if not model_available(base_url,model): continue
            data=request_json(f"{base_url}/api/generate",{"model":model,"prompt":prompt,"stream":False,"keep_alive":"30m","options":{"temperature":0.05,"num_ctx":8192,"num_predict":2600}},timeout=30)
            result=str(data.get("response","")).strip()
            found={}
            for m in re.finditer(r"(?s)\[U(\d+)\]\s*(.*?)(?=\n\s*\[U\d+\]|\Z)",result): found[int(m.group(1))]=re.sub(r"\s+"," ",m.group(2)).strip()
            if len(found)==len(units) and all(i in found for i in range(len(units))):
                segments=[{"id":i,"source":u,"target":preserve_terminal_punctuation(u,found[i])} for i,u in enumerate(units)]
                segments=review_ptbr_segments(segments,doc_id)
                return "\n".join(x["target"] for x in segments),segments
            last_error=RuntimeError(f"aligned_unit_mismatch:{model}:{len(found)}/{len(units)}")
        except Exception as exc:
            last_error=exc; print(f"aligned_translation_failed:{model}:{exc}")
    raise last_error or RuntimeError("aligned_translation_failed")

def structured_translation(text: str, context: str = "", doc_id: str = ""):
    if doc_id in KNOWN_BY_ID:
        return contextual_translate_aligned(text, context, doc_id)
    translated = contextual_translate(text, context, doc_id)
    return translated, align_translation(text, translated)

def synthesize(text: str, voice: str, speed: float, background: bool = False):
    payload = json.dumps({
        "model": "tts-1",
        "input": text,
        "voice": voice,
        "response_format": "mp3",
        "speed": max(0.25, min(4.0, speed)),
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{TTS_PREFETCH_URL if background else TTS_URL}/v1/audio/speech",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as response:
        return response.read(), response.headers.get("Content-Type", "audio/mpeg")

def synthesize_cached(text: str, voice: str, speed: float, background: bool = False):
    key=hashlib.sha256(f"tts-v1|{voice}|{speed:.3f}|{text}".encode("utf-8")).hexdigest()
    fp=TTS_CACHE_DIR/f"{key}.mp3"
    if fp.exists() and fp.stat().st_size>256:
        return fp.read_bytes(), "audio/mpeg", True
    audio,content_type=synthesize(text,voice,speed,background)
    try:
        tmp=fp.with_suffix('.tmp'); tmp.write_bytes(audio); os.replace(tmp,fp)
    except Exception as exc: print(f"tts_cache_write_failed:{exc}")
    return audio,content_type,False

def keep_tts_hot(background=False):
    time.sleep(2 if not background else 4)
    while True:
        try: synthesize("Jarvis.","pm_jarvis",1.0,background); print(f"tts_keepwarm_ok:{'bg' if background else 'fg'}")
        except Exception as exc: print(f"tts_keepwarm_failed:{exc}")
        time.sleep(120)


def normalize_path(raw_path: str):
    path = raw_path.split("?", 1)[0]
    if path == "/reader":
        return "/"
    if path.startswith("/reader/"):
        return path[len("/reader"):]
    return path


def public_library():
    items=[]
    for profile in KNOWN_BY_ID.values():
        filename=Path(str(profile.get("libraryFile", ""))).name
        fp=LIBRARY_ROOT/filename if filename else None
        items.append({
            "id":profile.get("id"),"title":profile.get("title"),"edition":profile.get("edition",""),
            "authors":profile.get("authors",[]),"description":profile.get("description",""),
            "language":profile.get("language","en"),"target":profile.get("target","pt-BR"),"nativeText":bool(profile.get("nativeText",False)),
            "sha256":profile.get("sha256"),"size":profile.get("size",0),"pageCount":profile.get("pageCount",0),
            "available":bool(fp and fp.exists()),"warmSentences":profile.get("warmSentences",4),
            "prefetchPages":profile.get("prefetchPages",10),"chapters":profile.get("chapters",[]),
            "coverUrl": profile.get("coverUrl") or ("/reader/assets/cover-kotler.jpg" if str(profile.get("id","")).startswith("kotler") else "/reader/assets/cover-zikmund.jpg")
        })
    return items

def library_path_for(book_id):
    profile=KNOWN_BY_ID.get(book_id)
    if not profile:return None
    filename=Path(str(profile.get("libraryFile", ""))).name
    if not filename:return None
    fp=(LIBRARY_ROOT/filename).resolve()
    try: fp.relative_to(LIBRARY_ROOT.resolve())
    except ValueError:return None
    return fp if fp.exists() else None

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

    def send_bytes(self, status, body, content_type, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        for k,v in (extra_headers or {}).items(): self.send_header(k,str(v))
        self.end_headers()
        self.wfile.write(body)

    def serve_file(self, fp, content_type, cache_control="public, max-age=86400", allow_range=False):
        fp=Path(fp); size=fp.stat().st_size; start=0; end=size-1; status=200
        m=re.match(r"bytes=(\d*)-(\d*)",self.headers.get("Range","") if allow_range else "")
        if m:
            if m.group(1): start=int(m.group(1))
            if m.group(2): end=min(end,int(m.group(2)))
            if start>end or start>=size: self.send_response(416); self.send_header("Content-Range",f"bytes */{size}"); self.end_headers(); return
            status=206
        length=end-start+1; self.send_response(status); self.send_header("Content-Type",content_type); self.send_header("Content-Length",str(length)); self.send_header("Cache-Control",cache_control)
        if allow_range: self.send_header("Accept-Ranges","bytes"); status==206 and self.send_header("Content-Range",f"bytes {start}-{end}/{size}")
        self.end_headers()
        with fp.open("rb") as src:
            src.seek(start); remaining=length
            while remaining>0:
                chunk=src.read(min(1024*1024,remaining))
                if not chunk: break
                self.wfile.write(chunk); remaining-=len(chunk)

    def do_GET(self):
        path = normalize_path(self.path)
        if path == "/health":
            return self.send_json(200, {"ok": True, "service": "reader-ia", "tts": TTS_URL, "translator": OLLAMA_URL, "translation_model": TRANSLATION_MODEL, "app_exists": APP.exists()})
        if path == "/api/voices":
            try:
                return self.send_json(200, request_json(f"{TTS_URL}/v1/voices", timeout=30))
            except Exception as exc:
                return self.send_json(503, {"error": "tts_not_ready", "detail": str(exc)[:400]})
        if path == "/api/library":
            return self.send_json(200, {"books": public_library()})
        if path.startswith("/api/library/book/"):
            book_id=urllib.parse.unquote(path.split("/api/library/book/",1)[1])
            fp=library_path_for(book_id)
            if not fp:return self.send_json(404,{"error":"book_not_available"})
            return self.serve_file(fp,"application/pdf","public, max-age=86400",allow_range=True)
        if path == "/manifest.webmanifest": return self.serve_file(MANIFEST,"application/manifest+json","no-cache")
        if path == "/sw.js": return self.serve_file(SW,"text/javascript; charset=utf-8","no-cache")
        if path.startswith("/assets/"):
            name=Path(path.split("/assets/",1)[1]).name; fp=ASSET_ROOT/name
            if not fp.exists(): return self.send_error(404)
            ctype={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".mp3":"audio/mpeg"}.get(fp.suffix.lower(),"application/octet-stream")
            return self.serve_file(fp,ctype,"public, max-age=31536000, immutable")
        if path.endswith("app-v2.mjs"):
            body = APP.read_bytes(); self.send_response(200); self.send_header("Content-Type", "text/javascript; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-cache"); self.end_headers(); self.wfile.write(body); return
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
                    try:
                        cached=json.loads(cache_path.read_text(encoding="utf-8"))
                        cached["engine"]="persistent-cache"
                        return self.send_json(200,cached)
                    except Exception as exc:
                        print(f"translation_cache_read_failed:{exc}")
                if mode == "editorial":
                    try:
                        translated, segments = structured_translation(text, context, doc_id)
                        payload={"translatedText": translated, "segments": segments, "engine": "local-contextual-v2"}
                        write_translation_cache(cache_path,payload)
                        return self.send_json(200,payload)
                    except Exception as llm_exc:
                        print(f"contextual_translate_failed: {llm_exc}")
                try:
                    translated,segments=fast_structured_translation(text,source,target,doc_id)
                    engine="local-structured-fast-v2" if mode in ("structured","editorial") else "literal-structured-fallback"
                    payload={"translatedText":translated,"segments":segments,"engine":engine}
                except Exception as fast_exc:
                    print(f"fast_structured_failed:{fast_exc}")
                    translated="\n".join(translate_chunk(chunk,source,target) for chunk in split_text(text))
                    segments=review_ptbr_segments(align_translation(text,translated),doc_id)
                    translated=" ".join(seg.get("target","") for seg in segments).strip()
                    payload={"translatedText":translated,"segments":segments,"engine":"literal-fallback"}
                write_translation_cache(cache_path,payload)
                return self.send_json(200,payload)
            if path == "/api/tts":
                doc_id = str(request_data.get("docId", "")).strip()
                text = str(request_data.get("text", "")).strip()
                voice = str(request_data.get("voice", "pm_jarvis"))
                speed = float(request_data.get("speed", 1.0))
                background = bool(request_data.get("background", False))
                if not text:
                    return self.send_json(400, {"error": "empty_text"})
                spoken_text = normalize_speech_text(text, doc_id)
                audio, content_type, cache_hit = synthesize_cached(spoken_text, voice, speed, background)
                return self.send_bytes(200, audio, content_type, {"X-ReaderPro-TTS-Cache":"HIT" if cache_hit else "MISS"})
            return self.send_error(404)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")[:800]
            self.send_json(502, {"error": "upstream_http_error", "detail": detail})
        except Exception as exc:
            self.send_json(500, {"error": "reader_request_failed", "detail": str(exc)[:800]})

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}")


if __name__ == "__main__":
    threading.Thread(target=keep_tts_hot,daemon=True).start()
    threading.Thread(target=keep_tts_hot,args=(True,),daemon=True).start()
    print(f"Reader IA listening on {HOST}:{PORT}; translator={TRANSLATE_URL}; tts={TTS_URL}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
