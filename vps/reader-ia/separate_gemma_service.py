from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8')
s=s.replace('OLLAMA_URL = os.getenv("OLLAMA_URL", "http://reader-ia-llm:11434")', 'OLLAMA_URL = os.getenv("OLLAMA_URL", "http://reader-ia-gemma:11434")\nQWEN_URL = os.getenv("QWEN_URL", "http://reader-ia-llm:11434")')
s=s.replace('for model in (TRANSLATION_MODEL, "qwen2.5:3b"):', 'for base_url, model in ((OLLAMA_URL, TRANSLATION_MODEL), (QWEN_URL, "qwen2.5:3b")):')
s=s.replace('data = request_json(f"{OLLAMA_URL}/api/generate", {', 'data = request_json(f"{base_url}/api/generate", {')
p.write_text(s,encoding='utf-8')
print('server split Gemma/Qwen URLs')