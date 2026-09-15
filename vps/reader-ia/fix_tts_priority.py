from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
old="""      translatePage(page+1).then(nextText=>{\n        setBuffer('próxima pronta',true);\n        if($('voice').value!=='system:browser'){\n          splitSentences(nextText).slice(0,2).forEach(t=>getLocalAudio(t).catch(()=>{}));\n        }\n      }).catch(()=>setBuffer('buffer pendente'));"""
new="""      translatePage(page+1).then(()=>{\n        setBuffer('próxima pronta',true);\n      }).catch(()=>setBuffer('buffer pendente'));"""
assert old in s
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('next-page audio prebuffer removed from idle load')