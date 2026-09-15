from pathlib import Path
p=Path('server.py')
s=p.read_text(encoding='utf-8')
old='''        "input": text[:4096],'''
new='''        "input": text,'''
if old not in s:
    raise SystemExit('tts input truncation not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('tts full-sentence input enabled')