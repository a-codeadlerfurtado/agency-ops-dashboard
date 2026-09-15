from pathlib import Path
p=Path('server.py')
s=p.read_text(encoding='utf-8')
old='''                if mode in ("editorial", "structured"):
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
new='''                if mode == "editorial":
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
                    translated="\\n".join(translate_chunk(chunk,source,target) for chunk in split_text(text))
                    payload={"translatedText":translated,"segments":align_translation(text,translated),"engine":"literal-fallback"}
                write_translation_cache(cache_path,payload)
                return self.send_json(200,payload)'''
if old not in s: raise SystemExit('mode block not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('translation mode routing patched')