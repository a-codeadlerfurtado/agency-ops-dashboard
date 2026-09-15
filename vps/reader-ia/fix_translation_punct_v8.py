from pathlib import Path
import re
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
idx=root/'index.html'
h=idx.read_text(encoding='utf-8-sig')
h,n=re.subn(r'\.pdfSourceMark\{[^}]*\}', '.pdfSourceMark{position:absolute;background:rgba(139,92,246,.23);border:0!important;border-radius:3px;box-shadow:none!important;opacity:1;pointer-events:none}', h, count=1)
assert n==1
idx.write_text(h,encoding='utf-8')
print('PURPLE_CSS_OK')

app=root/'app-v2-mobile.mjs'
s=app.read_text(encoding='utf-8-sig')
old="function linesToText(lines){let out='';for(const raw of lines){let line=String(raw||'').trim();if(!line)continue;const heading=line.length<105&&!/[.!?;:]$/.test(line),bullet=/^[•▪◦\\-*]\\s+/.test(line);if(heading)line+='.';if(!out)out=line;else out+=(heading||bullet?'\\n':' ')+line;}return out.replace(/([A-Za-zÀ-ÿ])-\\s+(?=[A-Za-zÀ-ÿ])/g,'$1').replace(/[ \\t]+/g,' ').replace(/ *\\n */g,'\\n').replace(/\\s+([,.!?;:])/g,'$1').trim();}"
new="function linesToText(lines){let out='';for(const raw of lines){const line=String(raw||'').trim();if(!line)continue;const heading=line.length<105&&!/[.!?;:]$/.test(line),bullet=/^[•▪◦\\-*]\\s+/.test(line);if(!out)out=line;else out+=(heading||bullet?'\\n':' ')+line;}return out.replace(/([A-Za-zÀ-ÿ])-\\s+(?=[A-Za-zÀ-ÿ])/g,'$1').replace(/[ \\t]+/g,' ').replace(/ *\\n */g,'\\n').replace(/\\s+([,.!?;:])/g,'$1').trim();}"
assert old in s, 'linesToText not found'
s=s.replace(old,new,1)
s=s.replace('translation:v4:', 'translation:v5:', 1)
app.write_text(s,encoding='utf-8')
print('APP_PUNCT_OK')
server=root/'server.py'
t=server.read_text(encoding='utf-8-sig')
t=t.replace('key=hashlib.sha256(f"v7|{TRANSLATION_MODEL}|{doc_id}|{source}|{target}|{text}|{context[-2200:]}".encode("utf-8")).hexdigest()','key=hashlib.sha256(f"v8|{TRANSLATION_MODEL}|{doc_id}|{source}|{target}|{text}|{context[-2200:]}".encode("utf-8")).hexdigest()',1)
old='- Preserve useful titles, subtitles and paragraph breaks.\n- Omit PDF/printing artifacts:'
new='- Preserve useful titles, subtitles and paragraph breaks.\n- Preserve sentence boundaries and terminal punctuation from the source whenever grammatically possible.\n- Never add a period, question mark or exclamation mark to a heading/subheading that has none in the source.\n- Do not split one source sentence into multiple target sentences or merge separate source sentences unless absolutely required for correct Brazilian Portuguese.\n- Omit PDF/printing artifacts:'
assert old in t, 'prompt insertion point not found'
t=t.replace(old,new,1)
server.write_text(t,encoding='utf-8')
print('SERVER_PROMPT_OK')

sw=root/'sw.js'
w=sw.read_text(encoding='utf-8-sig')
w=re.sub(r"readerpro-shell-v\d+","readerpro-shell-v8",w,count=1)
sw.write_text(w,encoding='utf-8')
print('CACHE_V8_OK')