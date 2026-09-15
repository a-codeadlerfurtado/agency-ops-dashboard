from pathlib import Path
p=Path('server.py')
s=p.read_text(encoding='utf-8-sig')
if 'import hashlib\n' not in s:
    s=s.replace('import json\n','import json\nimport hashlib\n',1)
s=s.replace('def translation_cache_path(text,context,source,target,doc_id):\n    key=hashlib.sha256(f"v4|{TRANSLATION_MODEL}|{doc_id}|{source}|{target}|{text}|{context[-2200:]}".encode("utf-8")).hexdigest()\n    return TRANSLATION_CACHE_DIR/f"{key}.txt"',
'''def translation_cache_path(text,context,source,target,doc_id):
    key=hashlib.sha256(f"v5|{TRANSLATION_MODEL}|{doc_id}|{source}|{target}|{text}|{context[-2200:]}".encode("utf-8")).hexdigest()
    return TRANSLATION_CACHE_DIR/f"{key}.json"

def write_translation_cache(path, payload):
    try:
        tmp=path.with_suffix('.tmp')
        tmp.write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8')
        os.replace(tmp,path)
    except Exception as exc:
        print(f"translation_cache_write_failed:{exc}")''')
s=s.replace('def structured_translation(text: str, context: str = ""):\n    translated = contextual_translate(text, context)\n    return translated, align_translation(text, translated)',
'''def structured_translation(text: str, context: str = "", doc_id: str = ""):
    translated = contextual_translate(text, context, doc_id)
    return translated, align_translation(text, translated)''')
p.write_text(s,encoding='utf-8')
print('server imports/cache/helpers patched')