from pathlib import Path
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
p=root/'server.py'; s=p.read_text(encoding='utf-8-sig')
old='''def structured_translation(text: str, context: str = "", doc_id: str = ""):\n    translated = contextual_translate(text, context, doc_id)\n    return translated, align_translation(text, translated)'''
new='''def structured_translation(text: str, context: str = "", doc_id: str = ""):\n    if doc_id in KNOWN_BY_ID:\n        return contextual_translate_aligned(text, context, doc_id)\n    translated = contextual_translate(text, context, doc_id)\n    return translated, align_translation(text, translated)'''
assert old in s
s=s.replace(old,new,1).replace('timeout=40)','timeout=30)',1).replace('f"v8|{TRANSLATION_MODEL}|','f"v9|{TRANSLATION_MODEL}|',1)
p.write_text(s,encoding='utf-8')
app=root/'app-v2-mobile.mjs'; a=app.read_text(encoding='utf-8-sig')
a=a.replace('translation:v5:','translation:v6:',1)
a=a.replace("foreground?14000:26000", "foreground?65000:75000",1).replace("'literal',22000", "'literal',35000",1)
app.write_text(a,encoding='utf-8')
sw=root/'sw.js'; w=sw.read_text(encoding='utf-8-sig').replace('readerpro-shell-v8','readerpro-shell-v9'); sw.write_text(w,encoding='utf-8')
print('ALIGNED_V9_ACTIVE')