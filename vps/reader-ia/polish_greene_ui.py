from pathlib import Path
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
p=root/'app-v2.mjs'; s=p.read_text(encoding='utf-8-sig')
s=s.replace("setStatus(`Página ${page}: preparando tradução em português...`);", "setStatus(isNativeBook()?`Página ${page}: preparando texto original em português...`:`Página ${page}: preparando tradução em português...`);")
old="setStatus(`P\\u00e1gina ${page} pronta \\u2022 ${knownBookProfile?'livro pr\\u00e9-analisado \\u2022 ':''}${record.engine?.includes('literal')?'tradu\\u00e7\\u00e3o r\\u00e1pida':'tradu\\u00e7\\u00e3o editorial contextualizada'}`);"
new="setStatus(isNativeBook()?`Página ${page} pronta • livro pré-analisado • texto original PT-BR`:`P\\u00e1gina ${page} pronta \\u2022 ${knownBookProfile?'livro pr\\u00e9-analisado \\u2022 ':''}${record.engine?.includes('literal')?'tradu\\u00e7\\u00e3o r\\u00e1pida':'tradu\\u00e7\\u00e3o editorial contextualizada'}`);"
if old not in s: print('status marker not found')
else: s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8-sig')
h=root/'index.html'; x=h.read_text(encoding='utf-8-sig'); x=x.replace('app-v2.mjs?v=fullscreen-space-20260910','app-v2.mjs?v=greene-native-20260910'); h.write_text(x,encoding='utf-8-sig')
print('ui polished')