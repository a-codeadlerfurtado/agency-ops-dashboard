from pathlib import Path
p=Path('server.py')
s=p.read_text(encoding='utf-8')
old='''        out=re.sub(r"\\bMarketing Management\\b","Administração de Marketing",out,flags=re.I)
        out=re.sub(r"\\bMarketing Insight\\b","Insight de Marketing",out,flags=re.I)'''
new='''        out=re.sub(r"\\bMarketing Management\\b","Administração de Marketing",out,flags=re.I)
        out=re.sub(r"\\bdo Administração de Marketing\\b","de Administração de Marketing",out,flags=re.I)
        out=re.sub(r"\\bno Administração de Marketing\\b","em Administração de Marketing",out,flags=re.I)
        out=re.sub(r"\\bpelo Administração de Marketing\\b","por Administração de Marketing",out,flags=re.I)
        out=re.sub(r"\\bMarketing Insight\\b","Insight de Marketing",out,flags=re.I)'''
if old not in s: raise SystemExit('polish title block not found')
s=s.replace(old,new,1)
s=s.replace('f"v6|{TRANSLATION_MODEL}|','f"v7|{TRANSLATION_MODEL}|',1)
p.write_text(s,encoding='utf-8')
print('Portuguese title agreement polished; cache v7')