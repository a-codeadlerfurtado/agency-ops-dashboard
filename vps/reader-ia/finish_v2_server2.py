from pathlib import Path
p=Path('server.py')
s=p.read_text(encoding='utf-8')
old='''                cache_path = translation_cache_path(text, context, source, target, doc_id)
                if cache_path.exists():
                    return self.send_json(200, {"translatedText": cache_path.read_text(encoding="utf-8"), "engine": "persistent-cache"})
                if mode in ("editorial", "structured"):
                    try:
                        translated, segments = structured_translation(text, context)
                        return self.send_json(200, {"translatedText": translated, "segments": segments, "engine": "local-contextual-v2"})
                    except Exception as llm_exc:
                        print(f"contextual_translate_failed: {llm_exc}")
                translated = "\\n".join(translate_chunk(chunk, source, target) for chunk in split_text(text))
                return self.send_json(200, {"translatedText": translated, "segments": align_translation(text, translated), "engine": "literal-fallback"})'''
new='''                cache_path = translation_cache_path(text, context, source, target, doc_id)
                if cache_path.exists():
                    try:
                        cached=json.loads(cache_path.read_text(encoding="utf-8"))
                        cached["engine"]="persistent-cache"
                        return self.send_json(200,cached)
                    except Exception as exc:
                        print(f"translation_cache_read_failed:{exc}")
                if mode in ("editorial", "structured"):
                    try:
                        translated, segments = structured_translation(text, context, doc_id)
                        payload={"translatedText": translated, "segments": segments, "engine": "local-contextual-v2"}
                        write_translation_cache(cache_path,payload)
                        return self.send_json(200,payload)
                    except Exception as llm_exc:
                        print(f"contextual_translate_failed: {llm_exc}")
                translated = "\\n".join(translate_chunk(chunk, source, target) for chunk in split_text(text))
                payload={"translatedText": translated, "segments": align_translation(text, translated), "engine": "literal-fallback"}
                write_translation_cache(cache_path,payload)
                return self.send_json(200,payload)'''
if old not in s: raise SystemExit('translation block not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('server translation endpoint patched')