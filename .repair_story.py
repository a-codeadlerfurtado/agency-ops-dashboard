from pathlib import Path
import re
p=Path(r'C:\Users\Adler\agency-ops-dashboard-commercial-release\app\wrapped\story-engine.ts')
s=p.read_text(encoding='utf-8')
def fix_run(m):
    x=m.group(0)
    try: return x.encode('cp1252').decode('utf-8')
    except UnicodeError: return x
for _ in range(3):
    ns=re.sub(r'[^\x00-\x7F]+',fix_run,s)
    if ns==s: break
    s=ns
s=s.replace('  const sourceRaw = p.sources || {};\n  const sources = Object.fromEntries(Object.entries(sourceRaw).filter(([key]) => !["work_items","work_events"].includes(key)));\n  const rankings = p.rankings || {};','  const sources = p.sources || {}, rankings = p.rankings || {};')
s=s.replace('O Wrapped só usa fontes confiáveis disponíveis naquele período. A Central de Trabalho é desconsiderada por política de qualidade; ausência de dado nunca vira zero.','O Wrapped só usa uma métrica quando a fonte existia naquele período. Ausência de dado nunca vira zero.')
p.write_text(s,encoding='utf-8')
print('mojibake',sum(s.count(x) for x in ('Ã','Â','â€')),'sourceRaw', 'sourceRaw' in s, 'central', 'Central de Trabalho' in s)
