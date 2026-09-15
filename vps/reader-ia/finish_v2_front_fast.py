from pathlib import Path
p=Path('app-v2.mjs')
s=p.read_text(encoding='utf-8')
s=s.replace("knownBookSha256=await sha256Hex(bytes);const r=await fetch", "knownBookSha256=await sha256Hex(bytes);activeDocHash=knownBookSha256;const r=await fetch",1)
s=s.replace("const key=`translation:${documentKey()}:${n}`", "const key=`translation:v3:${documentKey()}:${n}`",1)
old="function linesToText(lines){let out='';for(const line of lines){const heading=line.length<105&&!/[.!?;:]$/.test(line);const bullet=/^[•▪◦\\-*]\\s+/.test(line);if(!out)out=line;else if(heading||bullet)out+='\\n'+line;else out+=' '+line;}return out.replace(/([A-Za-zÀ-ÿ])-\\s+(?=[A-Za-zÀ-ÿ])/g,'$1').replace(/\\s+/g,' ').replace(/\\s+([,.!?;:])/g,'$1').trim();}"
new="function linesToText(lines){let out='';for(const raw of lines){let line=String(raw||'').trim();if(!line)continue;const heading=line.length<105&&!/[.!?;:]$/.test(line),bullet=/^[•▪◦\\-*]\\s+/.test(line);if(heading)line+='.';if(!out)out=line;else out+=(heading||bullet?'\\n':' ')+line;}return out.replace(/([A-Za-zÀ-ÿ])-\\s+(?=[A-Za-zÀ-ÿ])/g,'$1').replace(/[ \\t]+/g,' ').replace(/ *\\n */g,'\\n').replace(/\\s+([,.!?;:])/g,'$1').trim();}"
if old not in s: raise SystemExit('linesToText block not found')
s=s.replace(old,new,1)
s=s.replace("setBuffer(`prÃ©-aquecendo Jarvis 0/${segs.length}`)","setBuffer(`pré-aquecendo Jarvis 0/${segs.length}`)")
p.write_text(s,encoding='utf-8')
print('front fast translation cache/extraction patched')