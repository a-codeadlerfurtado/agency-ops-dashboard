from pathlib import Path
p=Path('server.py');s=p.read_text(encoding='utf-8')
s=s.replace('        if path == "/app-v2.mjs":\n','        if path.endswith("app-v2.mjs"):\n',1)
s=s.replace('return self.send_json(200, {"ok": True, "service": "reader-ia", "tts": TTS_URL, "translator": OLLAMA_URL, "translation_model": TRANSLATION_MODEL})','return self.send_json(200, {"ok": True, "service": "reader-ia", "tts": TTS_URL, "translator": OLLAMA_URL, "translation_model": TRANSLATION_MODEL, "app_exists": APP.exists()})',1)
p.write_text(s,encoding='utf-8')
print('app route made tolerant')
