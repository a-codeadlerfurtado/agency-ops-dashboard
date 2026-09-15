from pathlib import Path
import re
p=Path('index.html')
s=p.read_text(encoding='utf-8')
m=re.search(r'<script type="module">([\s\S]*?)</script>',s)
if not m: raise SystemExit('module script not found')
Path('browser-check.mjs').write_text(m.group(1),encoding='utf-8')
print('js extracted')