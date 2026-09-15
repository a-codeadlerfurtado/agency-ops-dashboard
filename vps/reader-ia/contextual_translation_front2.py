from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
old="""  const res=await fetch(BASE+'/api/translate',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:original,source:'en',target:'pt'})
  });"""
new="""  let context='';
  if(n>1){
    try{context=(await extractPageText(n-1)).slice(-2200);}catch{}
  }
  const res=await fetch(BASE+'/api/translate',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:original,context,source:'en',target:'pt',mode:'editorial'})
  });"""
if old not in s: raise SystemExit('translate fetch block not found')
s=s.replace(old,new,1)
s=s.replace("    setStatus(`Página ${page} pronta • tradução EN → PT-BR`);", "    setStatus(`Página ${page} pronta • tradução editorial contextualizada`);",1)
p.write_text(s,encoding='utf-8')
print('context payload added')