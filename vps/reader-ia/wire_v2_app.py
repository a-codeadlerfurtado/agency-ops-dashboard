from pathlib import Path
import re
p=Path('index.html');s=p.read_text(encoding='utf-8')
s2=re.sub(r'<script type="module">[\s\S]*?</script>','<script type="module" src="/reader/app-v2.mjs"></script>',s,count=1)
if s2==s: raise SystemExit('inline module not replaced')
p.write_text(s2,encoding='utf-8')
print('index wired to app-v2')

p=Path('server.py');s=p.read_text(encoding='utf-8')
anchor='INDEX = Path("/app/index.html") if Path("/app/index.html").exists() else Path(__file__).with_name("index.html")\n'
if anchor not in s: raise SystemExit('server INDEX anchor missing')
s=s.replace(anchor,anchor+'APP = Path("/app/app-v2.mjs") if Path("/app/app-v2.mjs").exists() else Path(__file__).with_name("app-v2.mjs")\n',1)
old='''        if path in ("/", "/index.html"):\n            body = INDEX.read_bytes()\n'''
new='''        if path == "/app-v2.mjs":\n            body = APP.read_bytes(); self.send_response(200); self.send_header("Content-Type", "text/javascript; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-cache"); self.end_headers(); self.wfile.write(body); return\n        if path in ("/", "/index.html"):\n            body = INDEX.read_bytes()\n'''
if old not in s: raise SystemExit('server html block missing')
s=s.replace(old,new,1);p.write_text(s,encoding='utf-8')
print('server serves app-v2')
