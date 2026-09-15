from pathlib import Path
p=Path('server.py')
s=p.read_text(encoding='utf-8-sig')
if 'import json\n' not in s[:100]:
    s='import json\n'+s
s=s.replace('timeout=3)\n        names =', 'timeout=1.5)\n        names =')
s=s.replace('}, timeout=120)\n            result =', '}, timeout=8)\n            result =')
p.write_text(s,encoding='utf-8')
print('server timeouts tightened')