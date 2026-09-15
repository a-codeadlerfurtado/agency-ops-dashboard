from pathlib import Path
# server
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8')
s=s.replace('TRANSLATION_MODEL = os.getenv("TRANSLATION_MODEL", "qwen2.5:3b")','TRANSLATION_MODEL = os.getenv("TRANSLATION_MODEL", "translategemma:4b")')
start=s.index('def contextual_translate(text: str, context: str = ""):')
end=s.index('\ndef synthesize(',start)
new='''def contextual_translate(text: str, context: str = ""):
    prompt = f"""You are a professional English (en) to Brazilian Portuguese (pt-BR) translator. Your goal is to accurately convey the meaning, tone and nuances of the original while using natural Brazilian Portuguese suitable for a professionally edited book.

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
    for model in (TRANSLATION_MODEL, "qwen2.5:3b"):
        try:
            data = request_json(f"{OLLAMA_URL}/api/generate", {
                "model": model, "prompt": prompt, "stream": False, "keep_alive": "30m",
                "options": {"temperature": 0.1, "num_ctx": 8192, "num_predict": 2200},
            }, timeout=240)
            result = str(data.get("response", "")).strip()
            if result:
                return result
            last_error = RuntimeError(f"empty_translation:{model}")
        except Exception as exc:
            last_error = exc
            print(f"translation_model_failed:{model}:{exc}")
    raise last_error or RuntimeError("contextual_translation_failed")
'''
s=s[:start]+new+s[end:]
p.write_text(s,encoding='utf-8')
print('server switched to TranslateGemma primary + Qwen fallback')