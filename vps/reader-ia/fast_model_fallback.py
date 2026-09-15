from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8')
needle='def contextual_translate(text: str, context: str = ""):\n'
insert='''def model_available(base_url: str, model: str):
    try:
        data = request_json(f"{base_url}/api/tags", timeout=3)
        names = [str(x.get("name", "")) for x in data.get("models", [])]
        return any(name == model or name.startswith(model + ":") for name in names)
    except Exception:
        return False

'''
if insert not in s:
    s=s.replace(needle,insert+needle,1)
old='''    for base_url, model in ((OLLAMA_URL, TRANSLATION_MODEL), (QWEN_URL, "qwen2.5:3b")):
        try:
            data = request_json(f"{base_url}/api/generate", {
                "model": model, "prompt": prompt, "stream": False, "keep_alive": "30m",
                "options": {"temperature": 0.1, "num_ctx": 8192, "num_predict": 2200},
            }, timeout=240)
'''
new='''    for base_url, model in ((OLLAMA_URL, TRANSLATION_MODEL), (QWEN_URL, "qwen2.5:3b")):
        try:
            if not model_available(base_url, model):
                print(f"translation_model_not_ready:{model}")
                continue
            data = request_json(f"{base_url}/api/generate", {
                "model": model, "prompt": prompt, "stream": False, "keep_alive": "30m",
                "options": {"temperature": 0.1, "num_ctx": 8192, "num_predict": 2200},
            }, timeout=120)
'''
if old not in s: raise SystemExit('model loop block missing')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('fast model readiness fallback added')