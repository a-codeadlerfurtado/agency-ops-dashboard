from pathlib import Path
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
app=root/'app-v2-mobile.mjs'; a=app.read_text(encoding='utf-8-sig')
old='for(let i=cursor;i<=maxStart;i++){\n      let wi=0,j=i,matches=0,gaps=0,last=i;'
new="for(let i=cursor;i<=maxStart;i++){\n      if(flat[i]?.token!==wanted[0])continue;\n      let wi=0,j=i,matches=0,gaps=0,last=i;"
assert old in a, 'matcher loop not found'
a=a.replace(old,new,1).replace('translation:v6:','translation:v7:',1)
app.write_text(a,encoding='utf-8')
print('MATCHER_FIRST_TOKEN_OK')

server=root/'server.py'; s=server.read_text(encoding='utf-8-sig')
old='for m in re.finditer(r"(?m)^\\s*\\[U(\\d+)\\]\\s*(.+?)\\s*$",result): found[int(m.group(1))]=m.group(2).strip()'
new='for m in re.finditer(r"(?s)\\[U(\\d+)\\]\\s*(.*?)(?=\\n\\s*\\[U\\d+\\]|\\Z)",result): found[int(m.group(1))]=re.sub(r"\\s+"," ",m.group(2)).strip()'
assert old in s, 'aligned parser not found'
s=s.replace(old,new,1).replace('f"v9|{TRANSLATION_MODEL}|','f"v10|{TRANSLATION_MODEL}|',1)
server.write_text(s,encoding='utf-8')
print('MULTILINE_PARSER_OK')

sw=root/'sw.js'; w=sw.read_text(encoding='utf-8-sig'); import re
w=re.sub(r'readerpro-shell-v\d+','readerpro-shell-v12',w,count=1); sw.write_text(w,encoding='utf-8')
print('CACHE_V12_OK')