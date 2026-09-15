from pathlib import Path
s=Path(r'C:\Users\Adler\agency-ops-dashboard-commercial-release\app\wrapped\story-engine.ts').read_text(encoding='utf-8')
for needle in ['id:"coverage"','id:"clients"','id:"retention"']:
    i=s.find(needle)
    print(needle, repr(s[i:i+550]))
print('counts', {'fffd':s.count(chr(0xfffd)),'Atilde':s.count('Ã'),'Acirc':s.count('Â'),'edash':s.count('â')})
