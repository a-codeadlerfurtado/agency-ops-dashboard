from pathlib import Path
s=Path(r'C:\Users\Adler\agency-ops-dashboard-commercial-release\app\wrapped\story-engine.ts').read_text(encoding='utf-8')
for needle in ['dispon','per','Saldo l','Cobertura']:
 i=s.find(needle)
 frag=s[i:i+30]
 print(needle, frag)
 print([(c,hex(ord(c))) for c in frag])
