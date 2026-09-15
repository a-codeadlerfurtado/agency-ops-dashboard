from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2.mjs')
s=p.read_text(encoding='utf-8')
old="function linesToText(lines){let out='';for(const raw of lines){let line=String(raw||'').trim();if(!line)continue;const heading=line.length<105&&!/[.!?;:]$/.test(line),bullet=/^[•▪◦\\-*]\\s+/.test(line);if(heading)line+='.';if(!out)out=line;else out+=(heading||bullet?'\\n':' ')+line;}return out.replace(/([A-Za-zÀ-ÿ])-\\s+(?=[A-Za-zÀ-ÿ])/g,'$1').replace(/[ \\t]+/g,' ').replace(/ *\\n */g,'\\n').replace(/\\s+([,.!?;:])/g,'$1').trim();}"
new="function linesToText(lines){let out='';for(const raw of lines){const line=String(raw||'').trim();if(!line)continue;const bullet=/^[•▪◦\\-*]\\s+/.test(line);if(!out)out=line;else out+=(bullet?'\\n':' ')+line;}return out.replace(/([A-Za-zÀ-ÿ])-\\s+(?=[A-Za-zÀ-ÿ])/g,'$1').replace(/[ \\t]+/g,' ').replace(/ *\\n */g,'\\n').replace(/\\s+([,.!?;:])/g,'$1').trim();}"
if old not in s: raise SystemExit('linesToText marker not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('removed invented source punctuation')