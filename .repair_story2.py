from pathlib import Path
import re
p=Path(r'C:\Users\Adler\agency-ops-dashboard-commercial-release\app\wrapped\story-engine.ts')
s=p.read_text(encoding='utf-8')
def fix_run(m):
 x=m.group(0)
 for enc in ('cp1252','latin1'):
  try: return x.encode(enc).decode('utf-8')
  except UnicodeError: pass
 return x
for _ in range(3):
 ns=re.sub(r'[^\x00-\x7F]+',fix_run,s)
 if ns==s: break
 s=ns
p.write_text(s,encoding='utf-8')
print('left',s.count('Ã'),sum(1 for ch in s if 0x80<=ord(ch)<=0x9f))
