from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8')
old='''            if path == "/api/translate":
                text = str(request_data.get("text", "")).strip()
                source = str(request_data.get("source", "en"))
                target = str(request_data.get("target", "pt"))
                if not text:
                    return self.send_json(400, {"error": "empty_text"})
                translated = [translate_chunk(chunk, source, target) for chunk in split_text(text)]
                return self.send_json(200, {"translatedText": "\\n".join(translated)})
'''
new='''            if path == "/api/translate":
                text = str(request_data.get("text", "")).strip()
                context = str(request_data.get("context", "")).strip()
                source = str(request_data.get("source", "en"))
                target = str(request_data.get("target", "pt"))
                mode = str(request_data.get("mode", "editorial"))
                if not text:
                    return self.send_json(400, {"error": "empty_text"})
                if mode == "editorial":
                    try:
                        translated = contextual_translate(text, context)
                        return self.send_json(200, {"translatedText": translated, "engine": "local-contextual"})
                    except Exception as llm_exc:
                        print(f"contextual_translate_failed: {llm_exc}")
                translated = [translate_chunk(chunk, source, target) for chunk in split_text(text)]
                return self.send_json(200, {"translatedText": "\\n".join(translated), "engine": "literal-fallback"})
'''
if old not in s: raise SystemExit('translate endpoint block not found')
s=s.replace(old,new,1)
s=s.replace('{"ok": True, "service": "reader-ia", "tts": TTS_URL}', '{"ok": True, "service": "reader-ia", "tts": TTS_URL, "translator": OLLAMA_URL, "translation_model": TRANSLATION_MODEL}',1)
p.write_text(s,encoding='utf-8')
print('translate endpoint switched to contextual local primary')