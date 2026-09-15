from pathlib import Path
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
s=(root/'server.py').read_text(encoding='utf-8-sig')
if 'import hashlib' not in s.splitlines()[:10]: s=s.replace('import json\n','import json\nimport hashlib\nimport re\n',1)
out=root/'server_preanalysis.py'
out.write_text(s,encoding='utf-8')
print(out)
