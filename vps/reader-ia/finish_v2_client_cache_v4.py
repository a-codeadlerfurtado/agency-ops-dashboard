from pathlib import Path
p=Path('app-v2.mjs')
s=p.read_text(encoding='utf-8')
s=s.replace('const key=`translation:v3:${documentKey()}:${n}`','const key=`translation:v4:${documentKey()}:${n}`',1)
p.write_text(s,encoding='utf-8')
print('client translation cache v4')