from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
old="translatePage(page+1).then(()=>setBuffer('próxima pronta',true)).catch(()=>setBuffer('buffer pendente'));"
new="""translatePage(page+1).then(nextText=>{
        setBuffer('próxima pronta',true);
        if($('voice').value!=='system:browser'){
          splitSentences(nextText).slice(0,2).forEach(t=>getLocalAudio(t).catch(()=>{}));
        }
      }).catch(()=>setBuffer('buffer pendente'));"""
if old not in s: raise SystemExit('next-page preload marker not found')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('next-page audio prebuffer added')